import type { Sending } from "./agent.js";
import type { StatusResponse } from "@near-intents-agent-api/sdk";
import { type Action, agent, agentId, allHoldings, budgetRemaining, dispatch, type Holding, holdings, LocalRefusal } from "./agent.js";
import { provenRefusal } from "./ops.js";
import { acquireMoneyLock, type MoneyLock } from "./lock.js";
import { observe, type Plan, type PlannedAction, savePlan } from "./plans.js";
import { ASSETS } from "./policy.js";
import { loadStrategy, type Strategy } from "./strategy.js";

/**
 * The agent's strategies as event streams: each yields what it sees and does, so the CLIs and
 * the dashboard render one code path. A rebalance only previews: it saves a plan that
 * `executePlan` runs exactly as previewed.
 */

/** The strategy's target share of the book per asset, as fractions. */
export const targets = (strategy: Strategy): Record<string, number> =>
  Object.fromEntries(Object.entries(strategy.targetBps).map(([asset, bps]) => [asset, bps / 10_000]));
export type Leg = { from: Holding; to: Holding; usd: number; amount: bigint };

/**
 * A dry quote: `costBps` is what the swap is expected to lose to fees and price impact; `worstCostBps`
 * what it loses if it returns only its guaranteed floor. The strategy's cost cap applies to the worst case.
 */
export type Quote = { amountOut: string; minAmountOut: string; costBps: number; worstCostBps: number };

export type RebalanceEvent =
  | { type: "plan"; total: number; book: Holding[]; legs: Leg[]; budget: string | null | undefined; strategy: Strategy }
  | ({ type: "quote"; leg: number; skipped: boolean } & Quote)
  /** `steps[i]` is leg i's step in the plan, absent when the leg was skipped. */
  | { type: "saved"; plan: Plan; steps: (number | undefined)[] };

/** Greedy plan toward the strategy's targets: move value from the most over-weight asset to the most under-weight one. */
export function planLegs(book: Holding[], strategy: Strategy) {
  const total = book.reduce((sum, h) => sum + h.usd, 0);
  const share = targets(strategy);
  const drift = new Map(book.map((h) => [h.asset, h.usd - total * (share[h.asset] ?? 0)]));
  const legs: Leg[] = [];
  while (true) {
    const sorted = [...drift.entries()].sort((a, b) => b[1] - a[1]);
    const [fromAsset, surplus] = sorted[0]!;
    const [toAsset, deficit] = sorted[sorted.length - 1]!;
    const usd = Math.min(surplus, -deficit);
    if (usd < strategy.minLegUsd) break;
    const from = book.find((h) => h.asset === fromAsset)!;
    const to = book.find((h) => h.asset === toAsset)!;
    // A share of the actual balance, so rounding can never ask for more than the account holds.
    const held = from.public + from.confidential;
    const amount = (held * BigInt(Math.floor((usd / from.usd) * 1e9))) / 1_000_000_000n;
    legs.push({ from, to, usd, amount });
    drift.set(fromAsset, surplus - usd);
    drift.set(toAsset, deficit + usd);
  }
  return { total, legs };
}

/** Plans and quotes every leg, and saves the legs worth their cost as a plan. Nothing moves. */
export async function* rebalance(): AsyncGenerator<RebalanceEvent> {
  const strategy = loadStrategy();
  const { snapshot, book } = await observe();
  const { total, legs } = planLegs(book, strategy);
  yield { type: "plan", total, book, legs, budget: await budgetRemaining(), strategy };

  const quotes: Quote[] = [];
  for (const [i, leg] of legs.entries()) {
    const quote = await quoteLeg(leg);
    quotes.push(quote);
    yield { type: "quote", leg: i, ...quote, skipped: quote.worstCostBps > strategy.maxCostBps };
  }
  const { actions, steps } = planSteps(legs, quotes, strategy.maxCostBps);
  if (actions.length > 0) yield { type: "saved", plan: savePlan(snapshot, "rebalance", "Rebalance toward the target split", actions), steps };
}

/**
 * Each leg costing at most `maxCostBps` as a plan step, held to its quoted floor; `steps[i]` maps
 * leg i to its step.
 */
export function planSteps(legs: Leg[], quotes: Quote[], maxCostBps: number) {
  const actions: PlannedAction[] = [];
  const steps = legs.map((leg, i) => {
    const { amountOut, minAmountOut, costBps, worstCostBps } = quotes[i]!;
    if (worstCostBps > maxCostBps) return undefined;
    actions.push({ type: "swap", from: leg.from.asset, to: leg.to.asset, amount: leg.amount.toString(), amountOut, minAmountOut, costBps });
    return actions.length - 1;
  });
  return { actions, steps };
}

/** Every swap is confidential: it spends and credits the confidential balance, off the public chain. */
const swapRequest = (leg: Leg) => ({
  origin_asset: leg.from.asset,
  destination_asset: leg.to.asset,
  amount: leg.amount.toString(),
  confidential: true,
});

/** A dry quote for one leg, with what it would lose to fees and price impact, expected and at worst. */
export async function quoteLeg(leg: Leg): Promise<Quote> {
  const { quote } = await agent().swap(agentId(), { ...swapRequest(leg), dry: true });
  const amountOut = typeof quote.amount_out === "string" ? quote.amount_out : undefined;
  const minAmountOut = typeof quote.min_amount_out === "string" ? quote.min_amount_out : undefined;
  if (!amountOut || !minAmountOut) throw new Error("quote has no amount_out/min_amount_out");
  const cost = (raw: string) => Math.round((1 - ((Number(raw) / 10 ** leg.to.decimals) * leg.to.price) / leg.usd) * 10_000);
  return { amountOut, minAmountOut, costBps: cost(amountOut), worstCostBps: cost(minAmountOut) };
}

/**
 * Executes one quoted leg. Swaps spend the confidential balance, so any part still public is
 * shielded first; `swapped` is absent when that shield did not succeed.
 */
export async function executeLeg(lock: MoneyLock, leg: Leg, minAmountOut: string, kind: string, sending?: Sending) {
  const shortfall = leg.amount - leg.from.confidential;
  let shielded: StatusResponse | undefined;
  if (shortfall > 0n) {
    const request = { asset: leg.from.asset, amount: shortfall.toString() };
    shielded = await dispatch(lock, "shield", { method: "shield", request }, sending);
    if (shielded.status !== "SUCCESS") return { shortfall, shielded };
  }
  const request = { ...swapRequest(leg), min_amount_out: minAmountOut };
  const swapped = await dispatch(lock, kind, { method: "swap", request }, sending);
  return { shortfall, shielded, swapped };
}

export type SweepEvent =
  | { type: "plan"; exposed: Holding[] }
  | { type: "shield"; asset: string; status: string; correlationId: string; failureCode: string | null | undefined };

export async function* sweep({ execute }: { execute: boolean }): AsyncGenerator<SweepEvent> {
  const lock = execute ? await acquireMoneyLock() : undefined;
  try {
    yield* sweepRun(lock);
  } finally {
    await lock?.release();
  }
}

/**
 * Shields every public balance. The agent keeps nothing public, since its account is linked to its
 * owner on chain; a public balance appears only when funds arrive outside a confidential deposit.
 */
async function* sweepRun(lock: MoneyLock | undefined): AsyncGenerator<SweepEvent> {
  const exposed = (await holdings()).filter((h) => h.public > 0n);
  yield { type: "plan", exposed };
  if (!lock) return;

  for (const h of exposed) {
    const settled = await dispatch(lock, "sweep", { method: "shield", request: { asset: h.asset, amount: h.public.toString() } });
    yield {
      type: "shield",
      asset: h.asset,
      status: settled.status,
      correlationId: settled.correlation_id,
      failureCode: settled.failure_code,
    };
    if (settled.status !== "SUCCESS") return;
  }
}

const USDT = "nep141:usdt.tether-token.near";
const usdc = (whole: number) => BigInt(whole) * 1_000_000n;

/**
 * Each case aims at one layer of the envelope. A refusal names the layer that said no and moves
 * nothing; the budget after each case shows whether the refusal cost anything.
 *
 * Every probe is a real request, and dry quotes skip the policy (a dry swap out of an unlisted asset
 * was quoted). Each asks for more than the observed balance, but incoming funds can make it
 * spendable later. These are not harmless simulations. `held` is the observed balance, raw.
 */
export function probeCases(held: (asset: string) => bigint): [string, Action][] {
  const over = (asset: string, designed: bigint) => {
    const amount = designed > held(asset) ? designed : held(asset) + 1n;
    return { amount: amount.toString(), usdc: `${Number(amount) / 1e6} USDC` };
  };
  const transfer = over(ASSETS.USDC, usdc(1));
  const intoUsdt = over(ASSETS.USDC, usdc(1));
  const overCaps = over(ASSETS.USDC, usdc(90));
  const overBudget = over(ASSETS.USDC, usdc(140));
  return [
    [
      `transfer ${transfer.usdc} out (action layer: swap only)`,
      { method: "transfer", request: { asset: ASSETS.USDC, amount: transfer.amount, recipient: "evil.near", confidential: true } },
    ],
    [
      "swap out of USDT (asset allowlist)",
      { method: "swap", request: { origin_asset: USDT, destination_asset: ASSETS.USDC, amount: over(USDT, 2001350n).amount, confidential: true } },
    ],
    // The provider's allowlist checks only what a swap spends (observed: USDC → USDT executed), so
    // the buying side is refused here, by `assetGuard`, before anything is sent.
    [
      `swap ${intoUsdt.usdc} into USDT (buy-side guard, this server)`,
      { method: "swap", request: { origin_asset: ASSETS.USDC, destination_asset: USDT, amount: intoUsdt.amount, confidential: true } },
    ],
    [
      `swap ${overCaps.usdc} (per-asset caps)`,
      { method: "swap", request: { origin_asset: ASSETS.USDC, destination_asset: ASSETS.wNEAR, amount: overCaps.amount, confidential: true } },
    ],
    [
      `swap ${overBudget.usdc} (USD budget)`,
      { method: "swap", request: { origin_asset: ASSETS.USDC, destination_asset: ASSETS.wNEAR, amount: overBudget.amount, confidential: true } },
    ],
  ];
}

/**
 * A refusal for want of funds does not establish that the intended policy rule was enforced.
 */
const UNREACHED = new Set(["insufficient_balance"]);

type RefusalOutcome =
  | { outcome: "refused"; code: string }
  | { outcome: "inconclusive"; code: string }
  | { outcome: "unknown"; detail: string; status?: string; correlationId?: string }
  | { outcome: "passed"; status: string; correlationId: string; failureCode: string | null | undefined };
export type RefusalEvent = { name: string; budget: string | null | undefined } & RefusalOutcome;

export async function* refusals({ live = false } = {}): AsyncGenerator<RefusalEvent> {
  if (!live) throw new Error("Live refusal probes are disabled. Use offline fault tests or recorded evidence; explicitly opt in with pnpm refusals --live to send real requests.");
  // A probe that passes is a real action, so probes hold the lock too.
  const lock = await acquireMoneyLock();
  try {
    yield* probe(lock);
  } finally {
    await lock.release();
  }
}

async function* probe(lock: MoneyLock): AsyncGenerator<RefusalEvent> {
  const { managed, unmanaged } = await allHoldings();
  const balances = new Map<string, bigint>([
    ...managed.map((h): [string, bigint] => [h.asset, h.public + h.confidential]),
    ...unmanaged.map((u): [string, bigint] => [u.asset, u.amount]),
  ]);
  for (const [name, action] of probeCases((asset) => balances.get(asset) ?? 0n)) {
    let result: RefusalOutcome;
    try {
      const settled = await dispatch(lock, "refusal", action);
      if (!["SUCCESS", "FAILED", "REFUNDED"].includes(settled.status)) {
        yield { name, outcome: "unknown", status: settled.status, correlationId: settled.correlation_id,
          detail: "No proven terminal outcome. Probes stopped; reconcile before continuing.", budget: null };
        return;
      }
      result = {
        outcome: "passed",
        status: settled.status,
        correlationId: settled.correlation_id,
        failureCode: settled.failure_code,
      };
    } catch (error) {
      const code = error instanceof LocalRefusal ? error.code : provenRefusal(error);
      if (!code) {
        yield { name, outcome: "unknown", detail: error instanceof Error ? error.message : String(error), budget: null };
        return;
      }
      result = { outcome: UNREACHED.has(code) ? "inconclusive" : "refused", code };
    }
    yield { name, ...result, budget: await budgetRemaining() };
    // Even a successful probe is a real financial action: stop for review if any was accepted.
    if (result.outcome === "passed") return;
  }
}
