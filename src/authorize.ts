import type { Policy } from "@near-intents-agent-api/sdk";
import type { Action } from "./agent.js";
import type { api } from "./api.js";
import { mandateDigest } from "./mandate.js";
import type { Plan, PlannedAction } from "./plans.js";
import { ASSETS, assetGuard } from "./policy.js";
import { grantApproves, type Strategy, strategyDigest } from "./strategy.js";

/**
 * The one authorization rule every money action passes before it is sent. The provider enforces the
 * policy itself (identity, actions, payees, limits, budgets) when the action reaches it; this refuses
 * only what it can't see: a policy not in force, a grant for another purpose, what a swap buys, a
 * public, duplicate or unfunded payout, a changed plan, and, before the owner signs, a release the
 * policy no longer allows. Pure: the caller reads the facts, this decides. Facts are typed per purpose, so
 * missing evidence is a type error, never a skipped rule.
 */

export type Purpose = "treasury" | "autopilot" | "payout" | "invoice" | "approval";
export type Refusal = { code: string; message: string };

type PolicyView = Awaited<ReturnType<typeof api.getPolicy>>;
type Grant = Awaited<ReturnType<typeof api.listGrants>>[number];
type Token = Awaited<ReturnType<typeof api.getTokens>>[number];
type Transfer = { recipient: string; asset: string; amount: string };

type Common = {
  now: number;
  /** The agent this instance is configured for. */
  agentId: string;
  view: PolicyView;
  /** The live grant whose token this instance holds, if any. */
  grant: Grant | undefined;
};
/** A plan's send, with the leg being sent; `null` for a sweep, which has no plan. */
type PlanFacts = { plan: Plan; leg: PlannedAction } | null;
type TreasuryFacts = Common & { plan: PlanFacts; strategy: Strategy; tokens: Token[] };
/** The confidential balance of the asset a payout spends, in its smallest unit. */
type Funds = { balance: string };

export type Facts = {
  treasury: TreasuryFacts;
  autopilot: TreasuryFacts;
  payout: Common & Funds & { heldPayouts: Transfer[] };
  invoice: Common & Funds;
  approval: Common;
};

const refuse = (code: string, message: string): Refusal => ({ code, message });

/** Payees the owner agreed to: confidential transfer destinations of an `only` policy. Any other mode agrees to no one. */
export function agreedPayees(policy: Policy) {
  if (policy.destinations.mode !== "only") return new Set<string>();
  return new Set(policy.destinations.list.flatMap((d) => d.action === "transfer" && d.confidential ? [d.address] : []));
}

/** Which grant labels may send for each purpose. Approval votes need no grant. */
function grantAllows(purpose: Purpose, label: string, strategy?: Strategy) {
  switch (purpose) {
    case "treasury": return label === "treasury" || label.startsWith("treasury:");
    case "autopilot": return label.startsWith("treasury:") && grantApproves(label, strategy!);
    case "payout": case "invoice": return label === "payout" || label === "invoices";
    case "approval": return true;
  }
}

export function authorize<P extends Purpose>(purpose: P, action: Action, facts: Facts[P]): Refusal | null {
  const { view, grant, now } = facts;

  const policy = view.policy;
  if (!policy || view.status !== "APPLIED" || !view.provider_policy_synced || policy.frozen)
    return refuse("policy_not_in_force", "The policy is missing, frozen, unapplied or unsynchronized");

  if (purpose !== "approval") {
    // Without one this instance holds no token, and the send would fail locally after it was recorded.
    if (!grant || grant.revoked_at || Date.parse(grant.expires_at) <= now)
      return refuse("grant_missing", "No live grant is held for this agent");
    const strategy = "strategy" in facts ? (facts as TreasuryFacts).strategy : undefined;
    if (!grantAllows(purpose, grant.label, strategy))
      return refuse("grant_purpose_denied", `A "${grant.label}" grant does not allow ${purpose} sends`);
  }

  // The provider checks only what a swap spends, so what it buys is checked here, for every purpose.
  const buys = assetGuard(action, policy);
  if (buys) return refuse("asset_out_not_allowed", buys);

  if (purpose === "payout" || purpose === "invoice" || purpose === "approval") {
    if (action.method !== "transfer" || action.request.asset !== ASSETS.USDC || !action.request.confidential)
      return refuse("transfer_not_allowed", "Payouts are confidential USDC transfers");
    // The provider checked payee and cap when the payment was requested, under the policy then; the
    // owner signs now, so what the policy no longer allows is refused here.
    if (purpose === "approval") {
      const { recipient, asset, amount } = action.request;
      if (!agreedPayees(policy).has(recipient)) return refuse("payee_not_agreed", `${recipient} is not an agreed payee`);
      const cap = policy.limits.per_transaction?.[asset];
      if (cap !== undefined && BigInt(amount) > BigInt(cap))
        return refuse("per_transaction_exceeded", `${amount} of ${asset} is over the per-transaction limit of ${cap}`);
    }
    if (purpose !== "payout" && (!policy.owner_approval || !policy.confidential))
      return refuse("owner_approval_required", "Invoices and approvals need a confidential policy holding every payment for the owner");
    // The provider holds a payment for the owner's vote without checking the balance, and fails it
    // only after the vote: an unfunded payout is refused before anyone is asked to approve it.
    if ((purpose === "payout" || purpose === "invoice") && BigInt(action.request.amount) > BigInt((facts as Funds).balance))
      return refuse("insufficient_balance", `The wallet holds ${(facts as Funds).balance} of ${action.request.asset}, less than ${action.request.amount}: fund it first`);
    if (purpose === "payout") {
      const { recipient, asset: token, amount: units } = action.request;
      if ((facts as Facts["payout"]).heldPayouts.some((h) => h.recipient === recipient && h.asset === token && h.amount === units))
        return refuse("duplicate_held_payout", "A payout with the same recipient, asset and amount is already waiting for approval");
    }
  }

  if (purpose === "treasury" || purpose === "autopilot") {
    const { plan: sending, strategy, tokens } = facts as TreasuryFacts;
    if (sending) {
      const { plan, leg } = sending;
      if (!Number.isFinite(Date.parse(plan.expiresAt)) || now >= Date.parse(plan.expiresAt)) return refuse("plan_expired", "The plan expired");
      if (plan.agentId !== facts.agentId) return refuse("plan_agent_changed", "The plan was made for another agent");
      if (strategyDigest(strategy) !== plan.strategyDigest) return refuse("strategy_changed", "The owner's strategy changed since the plan");
      if (view.revision !== plan.policyRevision || mandateDigest(policy) !== plan.policyDigest)
        return refuse("plan_policy_changed", "The policy changed since the plan");
      if (leg.type === "swap") {
        const input = tokens.find((t) => t.asset_id === leg.from);
        const output = tokens.find((t) => t.asset_id === leg.to);
        const usdIn = input?.price ? Number(leg.amount) / 10 ** input.decimals * input.price : NaN;
        const floorUsd = output?.price ? Number(leg.minAmountOut) / 10 ** output.decimals * output.price : NaN;
        const cost = (1 - floorUsd / usdIn) * 10_000;
        if (!Number.isFinite(cost) || cost > strategy.maxCostBps)
          return refuse("swap_cost_exceeded", "The swap's output floor exceeds the strategy's cost limit");
      }
    }
  }
  return null;
}
