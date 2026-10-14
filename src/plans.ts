import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "@near-intents-agent-api/sdk";
import { agentId } from "./env.js";
import { dispatch, LocalRefusal, type Sending } from "./agent.js";
import { type Holding, holdings } from "./holdings.js";
import { api } from "./api.js";
import { acquireMoneyLock } from "./lock.js";
import { mandateDigest } from "./mandate.js";
import { mayBuy } from "./policy.js";
import { loadStrategy } from "./strategy.js";
import { strategyDigest } from "./strategy-digest.js";
import { usdValue } from "./value.js";
import { executeLeg, quoteLeg } from "./treasury.js";

/**
 * A reviewed plan: the exact actions a dry run proposed, with the state they were proposed against.
 * Executing replays these actions as they are, with no model involved. If anything material moved
 * since the preview (the policy, the owner's strategy, a balance it spends, the price past the quoted floor, or the clock past
 * the plan's validity), execution refuses and a new preview is needed. A plan executes at most once.
 *
 * The API's quotes carry no id or expiry, so a plan binds to exact parameters and the quoted floor,
 * which every swap is held to, plus its own validity window.
 */

export type PlannedAction =
  | { type: "swap"; from: string; to: string; amount: string; amountOut: string; minAmountOut: string; costBps: number }
  | { type: "shield"; asset: string; amount: string };

export type Snapshot = {
  agentId: string;
  policyRevision: number | null;
  /** `mandateDigest` of the policy in force: the mandate the plan was proposed under. */
  policyDigest: string | null;
  /** `strategyDigest` of the owner's strategy: the targets and limits the plan was proposed under. */
  strategyDigest: string;
  /** Public and confidential balance per asset, raw. */
  balances: Record<string, { public: string; confidential: string }>;
};

/** What proposed the plan; its actions are logged under this kind. */
type PlanSource = "steward" | "rebalance";

export type Plan = Snapshot & {
  id: string;
  source: PlanSource;
  createdAt: string;
  expiresAt: string;
  instruction: string;
  actions: PlannedAction[];
};

const PLAN_TTL_MS = 5 * 60_000;
const DIR = ".plans";

const digest = (plan: Plan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

/** The state a preview is taken against, and that execution must still find. */
export async function snapshot(): Promise<Snapshot> {
  return (await observe()).snapshot;
}

/** The snapshot, the book it was read from, and the assets the live policy lets a swap buy. */
export async function observe() {
  const [book, view] = await Promise.all([holdings(), api.getPolicy(agentId())]);
  const snapshot: Snapshot = {
    agentId: agentId(),
    policyRevision: view.revision,
    policyDigest: view.policy ? mandateDigest(view.policy) : null,
    strategyDigest: strategyDigest(loadStrategy()),
    balances: Object.fromEntries(
      book.map((h) => [h.asset, { public: h.public.toString(), confidential: h.confidential.toString() }]),
    ),
  };
  return { snapshot, book, assets: view.policy?.assets ?? [] };
}

export function savePlan(
  base: Snapshot,
  source: PlanSource,
  instruction: string,
  actions: PlannedAction[],
  now = new Date(),
): Plan {
  const plan: Plan = {
    ...base,
    id: randomUUID(),
    source,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    instruction,
    actions,
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${plan.id}.json`), JSON.stringify({ plan, sha256: digest(plan) }, null, 2));
  return plan;
}

export function loadPlan(id: string): Plan {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Not a plan id");
  const file = join(DIR, `${id}.json`);
  if (!existsSync(file)) throw new Error(`No plan ${id}`);
  const { plan, sha256 } = JSON.parse(readFileSync(file, "utf8")) as { plan: Plan; sha256: string };
  if (digest(plan) !== sha256) throw new Error(`Plan ${id} was modified after it was saved`);
  return plan;
}

/**
 * Why a plan can no longer execute as previewed; empty when it still can. `quotes` holds a fresh
 * `amount_out` for each swap action, in order; `assets` is the live policy's.
 */
export function checkPlan(plan: Plan, live: Snapshot & { now: Date; quotes: string[]; assets: Policy["assets"] }): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || live.now >= new Date(plan.expiresAt)) problems.push(`the plan expired at ${plan.expiresAt}`);
  if (live.agentId !== plan.agentId) problems.push("the plan is for another agent");
  if (live.policyRevision !== plan.policyRevision || live.policyDigest !== plan.policyDigest)
    problems.push(
      `the policy changed (revision ${plan.policyRevision} → ${live.policyRevision}, ${plan.policyDigest} → ${live.policyDigest})`,
    );
  if (live.strategyDigest !== plan.strategyDigest)
    problems.push(`the owner's strategy changed (${plan.strategyDigest} → ${live.strategyDigest})`);
  // Funds arriving change nothing the plan relies on; less of what it spends means something else
  // spent it, and the plan's amounts no longer describe the book.
  const spent = new Set(plan.actions.map((a) => (a.type === "swap" ? a.from : a.asset)));
  for (const asset of spent) {
    const was = plan.balances[asset];
    const now = live.balances[asset];
    if (!was) continue;
    if (BigInt(now?.public ?? 0) < BigInt(was.public) || BigInt(now?.confidential ?? 0) < BigInt(was.confidential))
      problems.push(`the ${asset} balance fell since the preview`);
  }
  const swaps = plan.actions.filter((a) => a.type === "swap");
  swaps.forEach((swap, i) => {
    if (!mayBuy(live.assets, swap.to)) problems.push(`swap ${i + 1} buys ${swap.to}, outside the policy's assets`);
    const quoted = live.quotes[i];
    if (quoted === undefined) problems.push(`no fresh quote for swap ${i + 1}`);
    else if (BigInt(quoted) < BigInt(swap.minAmountOut))
      problems.push(`swap ${i + 1} now quotes ${quoted}, below its previewed floor ${swap.minAmountOut}`);
  });
  return problems;
}

/** Simulate each spend once; future swaps contribute only their guaranteed output floor. */
export function feasibility(actions: PlannedAction[], balances: Snapshot["balances"]): string[] {
  const book = new Map(Object.entries(balances).map(([asset, b]) =>
    [asset, { public: BigInt(b.public), confidential: BigInt(b.confidential) }]));
  try {
    for (const [i, action] of actions.entries()) {
      if (!/^[0-9]+$/.test(action.amount) || BigInt(action.amount) <= 0n) throw new Error("invalid amount");
      const amount = BigInt(action.amount);
      const from = book.get(action.type === "shield" ? action.asset : action.from);
      if (!from) throw new Error("unknown input asset");
      if (action.type === "shield") {
        if (from.public < amount) throw new Error(`action ${i + 1} exceeds remaining public balance`);
        from.public -= amount; from.confidential += amount;
      } else {
        const to = book.get(action.to);
        if (!to || action.from === action.to) throw new Error("invalid output asset");
        if (!/^[0-9]+$/.test(action.minAmountOut) || BigInt(action.minAmountOut) <= 0n)
          throw new Error("invalid output floor");
        if (from.public + from.confidential < amount)
          throw new Error(`action ${i + 1} exceeds remaining balance`);
        const shield = amount > from.confidential ? amount - from.confidential : 0n;
        from.public -= shield; from.confidential += shield - amount;
        to.confidential += BigInt(action.minAmountOut);
      }
    }
    return [];
  } catch (error) { return [`plan infeasible: ${(error as Error).message}`]; }
}

/** Marks a plan executed; false if it already was. Atomic across processes. */
export function claimPlan(id: string): boolean {
  try {
    closeSync(openSync(join(DIR, `${id}.executed`), "wx"));
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw error;
  }
}

export type PlanEvent =
  | { type: "rejected"; problems: string[] }
  | {
      type: "action";
      index: number;
      action: PlannedAction;
      /** The shield a swap needed first, when part of its input was public. */
      shield?: { amount: string; status: string };
      /** `NOT_SENT` when the shield before it did not succeed. */
      status: string;
      correlationId: string;
      failureCode: string | null | undefined;
    };

const PLAN_REFUSALS = new Set(["plan_expired", "plan_agent_changed", "strategy_changed", "plan_policy_changed", "swap_cost_exceeded"]);

const legFor = (book: Holding[], action: Extract<PlannedAction, { type: "swap" }>) => {
  const from = book.find((h) => h.asset === action.from)!;
  const to = book.find((h) => h.asset === action.to)!;
  const amount = BigInt(action.amount);
  return { from, to, amount, usd: usdValue(amount, from.decimals, from.price) };
};

/** Executes a saved plan exactly as previewed, under the money lock, or says why it can't. */
export async function* executePlan(id: string, now = () => new Date(), { autopilot = false, onSubmitted }: { autopilot?: boolean; onSubmitted?: Sending["onSubmitted"] } = {}): AsyncGenerator<PlanEvent> {
  const plan = loadPlan(id);
  const lock = await acquireMoneyLock();
  try {
    // Fresh state, read under the lock so nothing else can move it before we act.
    const { snapshot: live, book, assets } = await observe();
    const invalid = feasibility(plan.actions, live.balances);
    if (invalid.length) { yield { type: "rejected", problems: invalid }; return; }
    const quotes: string[] = [];
    for (const action of plan.actions)
      if (action.type === "swap") quotes.push((await quoteLeg(legFor(book, action))).amountOut);
    const problems = checkPlan(plan, { ...live, now: now(), quotes, assets });
    if (problems.length > 0) {
      yield { type: "rejected", problems };
      return;
    }

    // Claimed before the first action: a plan runs at most once, even if it stops partway.
    if (!claimPlan(id)) {
      yield { type: "rejected", problems: ["the plan was already executed"] };
      return;
    }

    const sending = (leg: PlannedAction): Sending => ({ planned: { plan, leg }, autopilot, now, onSubmitted });
    for (const [index, action] of plan.actions.entries()) {
      const current = await observe();
      const problems = feasibility(plan.actions.slice(index), current.snapshot.balances);
      // The initial preview-balance check is replaced with remaining-plan feasibility after each leg.
      problems.push(...checkPlan({ ...plan, balances: current.snapshot.balances, actions: [] },
        { ...current.snapshot, now: now(), quotes: [], assets: current.assets }));
      if (problems.length) { yield { type: "rejected", problems }; return; }
      if (action.type === "shield") {
        const request = { asset: action.asset, amount: action.amount };
        const settled = await dispatch(lock, plan.source, { method: "shield", request }, sending(action));
        yield { type: "action", index, action, status: settled.status, correlationId: settled.correlation_id, failureCode: settled.failure_code };
        if (settled.status !== "SUCCESS") return;
        continue;
      }
      const { shortfall, shielded, swapped } = await executeLeg(lock, legFor(current.book, action), action.minAmountOut, plan.source, sending(action));
      const shield = shielded && { amount: shortfall.toString(), status: shielded.status };
      if (!swapped) {
        yield { type: "action", index, action, shield, status: "NOT_SENT", correlationId: "", failureCode: null };
        return;
      }
      yield { type: "action", index, action, shield, status: swapped.status, correlationId: swapped.correlation_id, failureCode: swapped.failure_code };
      // Anything short of SUCCESS changes the book the rest of the plan assumed: stop.
      if (swapped.status !== "SUCCESS") return;
    }
  } catch (error) {
    // `authorize` refuses a send whose plan no longer holds; the refusal is logged and the plan stops.
    if (!(error instanceof LocalRefusal && PLAN_REFUSALS.has(error.code))) throw error;
    yield { type: "rejected", problems: [error.message] };
  } finally {
    await lock.release();
  }
}
