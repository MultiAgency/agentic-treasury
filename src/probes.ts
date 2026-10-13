import { type Action, dispatch, LocalRefusal } from "./agent.js";
import { allHoldings, budgetRemaining } from "./holdings.js";
import { acquireMoneyLock, type MoneyLock } from "./lock.js";
import { isTerminal, provenRefusal } from "./ops.js";
import { ASSETS } from "./policy.js";

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
    // the buying side is refused here, by `outputAssetRefusal`, before anything is sent.
    [
      `swap ${intoUsdt.usdc} into USDT (output asset, this server)`,
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
      if (!isTerminal(settled.status)) {
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
