import { createIdempotencyKey, type StatusResponse } from "@near-intents-agent-api/sdk";
import { api, waitForStatus } from "./api.js";
import { agentId, executes } from "./env.js";
import { assertCanDispatch, assertMoneyLock, type MoneyLock, withMoneyLock } from "./lock.js";
import { mandateDigest } from "./mandate.js";
import { AuthorizationHeld, claimSubmission, isHeld, provenRefusal, readOps, record } from "./ops.js";
import { authorize, type Facts, type Purpose } from "./authorize.js";
import type { Plan, PlannedAction } from "./plans.js";
import { loadStrategy } from "./strategy.js";
import { invoiceOperations, markInvoiceUnknown } from "./invoice-store.js";
import { liveGrant } from "./grants.js";
import { usdValue } from "./value.js";

/** Every money action runs under the agent's grant, never the owner's key. */
export function agent() {
  const grantToken = process.env.AGENT_GRANT_TOKEN;
  if (!grantToken) throw new Error("AGENT_GRANT_TOKEN is not set: issue a grant first");
  return api.forGrant(grantToken);
}

type Grant = ReturnType<typeof agent>;
/** Immutable first-submission terms; ambiguous outcomes never authorize replay. */
export type Action =
  | { method: "swap"; request: Parameters<Grant["swap"]>[1] }
  | { method: "transfer"; request: Parameters<Grant["transfer"]>[1] }
  | { method: "shield"; request: Parameters<Grant["shield"]>[1] }
  | { method: "unshield"; request: Parameters<Grant["unshield"]>[1] };

/** First submissions only. Remote deduplication semantics are not assumed. */
const FIRST_SUBMISSION = Symbol("first submission in this dispatch");
export async function send(action: Action, idempotencyKey: string, lock: MoneyLock, permit?: symbol): Promise<{ correlation_id: string }> {
  assertMoneyLock(lock);
  if (permit !== FIRST_SUBMISSION) throw new AuthorizationHeld("submission must pass through dispatch; direct replay is blocked");
  const op = readOps().find((op) => op.idempotencyKey === idempotencyKey);
  if (!op || op.refused || op.correlationId || (op.submissionState && op.submissionState !== "PREPARED"))
    throw new AuthorizationHeld("only a recorded, never-submitted operation can initiate a send");
  if (JSON.stringify(op.request) !== JSON.stringify(action.request) || op.method !== action.method)
    throw new AuthorizationHeld("operation terms do not match the recorded request");
  assertCanDispatch(lock, idempotencyKey);
  // Every check that can refuse runs before the claim: once claimed, nothing may throw before the
  // network call, or a payment that never left would read "outcome unknown" and block every send.
  const [grant, id, options] = [agent(), agentId(), { idempotencyKey }];
  // Commit submission-attempted before network I/O, in SQLite for invoices and JSONL otherwise.
  // A crash after this point is ambiguous even if the request never leaves this host.
  claimSubmission(idempotencyKey, action.request);
  switch (action.method) {
    case "swap":
      return (await grant.swap(id, action.request, options)) as { correlation_id: string };
    case "transfer":
      return grant.transfer(id, action.request, options);
    case "shield":
      return grant.shield(id, action.request, options);
    case "unshield":
      return grant.unshield(id, action.request, options);
  }
}

/** A saved plan's send: the leg being sent, whether the autopilot sends it, and the plan's clock. */
export type Sending = { plan: Plan; leg: PlannedAction; autopilot: boolean; now: () => Date };

/**
 * Sends one money action under the money lock and follows it to a stable status. The request is
 * logged with its key, the mandate digest it runs under and its USD value before sending; the
 * correlation id as soon as the API answers; then the outcome. Every action passes `authorize` after
 * it is logged and before anything is sent, so a refusal is logged too and the log shows every
 * attempt. Anything else unanswered stays unresolved, and blocks new money actions until
 * status-only reconciliation proves its outcome.
 */
export async function dispatch(lock: MoneyLock, kind: string, action: Action, sending?: Sending, preparedKey?: string): Promise<StatusResponse> {
  action = structuredClone(action);
  // An approve-only instance never sends: refused before anything is recorded, so nothing is left open.
  if (!executes()) throw new Error("This instance only approves: payouts are sent by the agent's executor on its own host");
  if (preparedKey && !invoiceOperations().some((op) => op.idempotencyKey === preparedKey && op.submissionState === "PREPARED"))
    throw new Error("Invoice operation is not prepared; replay is blocked");
  assertCanDispatch(lock);
  const [view, tokens, grants, shielded] = await Promise.all([
    api.getPolicy(agentId()), api.getTokens(), api.listGrants(agentId()),
    // A payout's funds, so `authorize` can refuse one the wallet can't cover before it goes to a vote.
    action.method === "transfer" ? api.getBalances(agentId(), { source: "confidential" }) : undefined,
  ]);
  const { policy, revision } = view;
  const asset = action.method === "swap" ? action.request.origin_asset : action.request.asset;
  const token = tokens.find((t) => t.asset_id === asset);
  const usdIn = token?.price ? usdValue(action.request.amount, token.decimals, token.price) : null;
  // No await between this check, the write-ahead record, authorization and submission. A previous
  // send in this run may have become unresolved, or ownership may have been lost during the reads above.
  assertCanDispatch(lock);
  const idempotencyKey = preparedKey ?? `${kind}:${createIdempotencyKey()}`;
  record({
    at: new Date().toISOString(),
    idempotencyKey,
    kind,
    ...(!preparedKey && { journalVersion: 2 as const }),
    method: action.method,
    request: action.request,
    policyRevision: revision,
    policyDigest: policy ? mandateDigest(policy) : null,
    usdIn,
    ...(sending && { planId: sending.plan.id }),
  });
  // The provider enforces most of the policy itself; `authorize` refuses what it can't tell apart or
  // doesn't check (what a swap buys, a grant's purpose, a public or duplicate payout, a changed plan).
  const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
  // A payout or invoices grant only transfers: anything else it sends is judged, and refused, as treasury work.
  const payoutGrant = grant?.label === "payout" || grant?.label === "invoices";
  const purpose: Purpose = preparedKey ? "invoice"
    : payoutGrant && action.method === "transfer" ? "payout"
    : sending?.autopilot ? "autopilot"
    : "treasury";
  const common = { now: (sending?.now() ?? new Date()).getTime(), agentId: agentId(), view, grant };
  const held = readOps().filter(isHeld);
  const reserved = held.filter((op) => op.request.asset === asset).reduce((sum, op) => sum + BigInt(String(op.request.amount)), 0n);
  const available = (BigInt(shielded?.balances.find((b) => b.asset_id === asset)?.balance_raw ?? "0") - reserved).toString();
  const facts: Facts[Purpose] = purpose === "treasury" || purpose === "autopilot"
    ? { ...common, plan: sending ? { plan: sending.plan, leg: sending.leg } : null, strategy: loadStrategy(), tokens }
    : purpose === "payout"
      ? { ...common, available, heldPayouts: held.map(({ request: r }) => ({ recipient: String(r.recipient), asset: String(r.asset), amount: String(r.amount) })) }
      : { ...common, available };
  const refusal = authorize(purpose, action, facts as never);
  if (refusal) {
    record({ idempotencyKey, refused: refusal.code });
    throw new LocalRefusal(refusal.code, refusal.message);
  }
  let sent: { correlation_id: string };
  try {
    sent = await send(action, idempotencyKey, lock, FIRST_SUBMISSION);
  } catch (error) {
    // Thrown only before any network call, so nothing was sent.
    if (error instanceof AuthorizationHeld) {
      // Proven local failure before submission; invoice preparation stays available for revalidation.
      if (!preparedKey) record({ idempotencyKey, refused: "local_authorization_held" });
      throw error;
    }
    const code = provenRefusal(error);
    if (code) record({ idempotencyKey, refused: code });
    else if (preparedKey) markInvoiceUnknown(preparedKey);
    throw error;
  }
  record({ idempotencyKey, correlation_id: sent.correlation_id, status: "SENT" });
  // Once accepted, even a non-retryable status-read error cannot prove the action was refused.
  const settled = await waitForStatus(sent.correlation_id).catch((cause: unknown) => {
    if (preparedKey) markInvoiceUnknown(preparedKey);
    throw new Error(`Outcome unknown for ${sent.correlation_id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  });
  record({ idempotencyKey, correlation_id: settled.correlation_id, status: settled.status });
  return settled;
}

/**
 * A one-time address to fund the account from `originAsset`; incoming funds need no grant. Funds
 * land in the confidential balance, so nothing the agent holds sits in public view.
 */
export async function depositAddress(originAsset: string) {
  const { correlation_id, details } = await api.deposit(
    agentId(),
    { origin_asset: originAsset, confidential: true },
    { idempotencyKey: createIdempotencyKey() },
  );
  // Send funds only here (with the memo, if any); the correlation id is not an address.
  if (!details.deposit_address) throw new Error(`Deposit ${correlation_id} came back without an address`);
  return {
    correlationId: correlation_id,
    address: details.deposit_address,
    memo: details.memo ?? null,
    minAmount: details.min_amount ?? null,
    expiresAt: details.expires_at ?? null,
  };
}

/** A refusal this server makes before sending, shaped like the API's so callers read both alike. */
export class LocalRefusal extends Error {
  readonly errors: { code: string }[];
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.errors = [{ code }];
  }
}

/** One transfer to a NEAR Intents account. The policy decides whether it may go: a refusal moves nothing. */
export async function pay(request: { asset: string; amount: string; recipient: string; confidential: boolean }) {
  try {
    const settled = await withMoneyLock((lock) => dispatch(lock, "payout", { method: "transfer", request }));
    return {
      outcome: "settled" as const,
      status: settled.status,
      correlationId: settled.correlation_id,
      failureCode: settled.failure_code,
    };
  } catch (error) {
    const code = error instanceof LocalRefusal ? error.code : provenRefusal(error);
    if (!code) throw error;
    return { outcome: "refused" as const, code };
  }
}
