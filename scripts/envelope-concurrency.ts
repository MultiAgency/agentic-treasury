import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { api } from "../src/api.js";
import { testAgentId } from "../src/envelope-phase1.js";
import { ASSETS } from "../src/policy.js";

/**
 * Envelope phase 2, USD-budget atomicity: N swaps sent at the same instant straight to the API with the
 * test agent's grant, as a compromised agent could, skipping this server's money lock and `dispatch`
 * (deliberately outside src/, where test/send-path.test.ts forbids it). Each fits the remaining daily
 * budget alone; together they exceed it. The budget holds if its spend never passes its limit.
 *
 *   ENV_FILE=.env.e2e pnpm envelope:concurrency     [ENVELOPE_N=5] [ENVELOPE_USD_EACH=0.4]
 *
 * Test agent only (the phase-1 guard). Swaps wNEAR, which the phase-1 policy doesn't cap per asset, so
 * the USD budget is the only limit in play: set the policy's daily_usd so a few swaps exceed what's left.
 * First run 2026-10-13: 5 x $0.40 with $1.0005 left → 1 executed, 1 wallet_busy, 3 spend_budget_exceeded.
 */

const id = testAgentId();
const N = Number(process.env.ENVELOPE_N ?? 5);
const USD_EACH = Number(process.env.ENVELOPE_USD_EACH ?? 0.4);
const grant = api.forGrant(process.env.AGENT_GRANT_TOKEN!);
const MOVING = new Set(["PROCESSING", "QUEUED", "PENDING_DEPOSIT"]);

const daily = async () => (await api.getPolicy(id)).usage.budget.daily;
const before = await daily();
const wnear = (await api.getTokens()).find((t) => t.asset_id === ASSETS.wNEAR);
if (!wnear?.price) throw new Error("no wNEAR price");
const amount = BigInt(Math.floor((USD_EACH / wnear.price) * 10 ** wnear.decimals));
const held = BigInt((await api.getBalances(id, { source: "confidential" })).balances.find((b) => b.asset_id === ASSETS.wNEAR)?.balance_raw ?? "0");
if (held < amount * BigInt(N)) throw new Error(`only ${held} wNEAR confidential; ${N} swaps need ${amount * BigInt(N)}`);
const remaining = Number(before.limit_usd) - Number(before.spent_usd);
const fits = Math.floor(remaining / USD_EACH + 1e-9);
if (fits >= N) throw new Error(`$${remaining.toFixed(4)} left fits all ${N} swaps: lower the policy's daily_usd first`);
const request = { origin_asset: ASSETS.wNEAR, destination_asset: ASSETS.USDC, amount: amount.toString(), confidential: true };
const { quote } = await grant.swap(id, { ...request, dry: true });
console.log(`$${before.spent_usd} of $${before.limit_usd} spent; ${N} x $${USD_EACH}; at most ${fits} may execute`);

// All at once, each under its own key.
const sentAt = new Date().toISOString();
const results = await Promise.allSettled(Array.from({ length: N }, (_, i) =>
  grant.swap(id, { ...request, min_amount_out: String(quote.min_amount_out) }, { idempotencyKey: `e2e-concurrent-${Date.parse(sentAt)}-${i}` })));
const answers = results.map((r, i) => r.status === "fulfilled"
  ? { i, correlationId: (r.value as { correlation_id: string }).correlation_id }
  : { i, refused: (r.reason as { code?: string }).code ?? String(r.reason).slice(0, 200), status: (r.reason as { status?: number }).status ?? null });

// Every accepted one to a final status, then the budget once it stops moving.
const finals: Record<string, string> = {};
for (const correlationId of answers.flatMap((a) => a.correlationId ?? [])) {
  for (let t = 0; t < 36 && !finals[correlationId]; t++) {
    const s = await api.getStatus(correlationId);
    if (!MOVING.has(s.status)) finals[correlationId] = s.status;
    else await new Promise((r) => setTimeout(r, 5_000));
  }
  finals[correlationId] ??= "STILL_MOVING";
}
let after = await daily();
for (let t = 0; t < 12; t++) {
  await new Promise((r) => setTimeout(r, 5_000));
  const next = await daily();
  if (next.spent_usd === after.spent_usd && t >= 2) break;
  after = next;
}

const exceeded = Number(after.spent_usd) - Number(after.limit_usd);
const verdict = exceeded > 1e-9 ? `EXCEEDED by $${exceeded.toFixed(4)}` : "HELD: the budget was not exceeded";
const evidence = { agent: id, sentAt, n: N, usdEach: USD_EACH, amount: amount.toString(), wnearPrice: wnear.price, fits, before, after,
  answers, finals, executed: Object.values(finals).filter((s) => s === "SUCCESS").length, verdict };
const dir = join(homedir(), "agencies", "proto-releases", `${sentAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-envelope-concurrency`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ...evidence, dir }, null, 2));
