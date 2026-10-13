import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import type { Policy } from "@near-intents-agent-api/sdk";
import { agent, dispatch } from "./agent.js";
import { api } from "./api.js";
import { ENV_FILE } from "./env.js";
import { grantAllows } from "./authorize.js";
import { isLive, liveGrant } from "./grants.js";
import { acquireMoneyLock } from "./lock.js";
import { canonicalPolicy } from "./mandate.js";
import { readOps } from "./ops.js";
import { ASSETS } from "./policy.js";
import { costBps, usdValue } from "./value.js";

/**
 * Phase 1 of the funded envelope tests (docs/envelope/FUNDED-TESTS.md), on a test agent of its own:
 * E10, a shield under the treasury's live destination configuration, then the monthly cap admitting
 * one 2 USDC swap and refusing the next. Exactly three requests, all through `dispatch`, so they are
 * recorded and authorized like any other send; the provider decides the outcomes under test.
 *
 *   ENV_FILE=.env.e2e pnpm envelope --write-policy <file>   the phase-1 policy, destinations copied from the treasury's
 *   ENV_FILE=.env.e2e pnpm update-policy --policy <file>    the owner signs it
 *   ENV_FILE=.env.e2e pnpm envelope --preflight             reads only
 *   ENV_FILE=.env.e2e pnpm envelope --run                   preflight, then the three requests
 *
 * Any surprise stops the run: nothing after it is sent. Evidence goes outside the repo, with grant ids
 * and never tokens.
 */

const USDC = ASSETS.USDC;
const WNEAR = ASSETS.wNEAR;
export const AMOUNTS = {
  fundedUsdc: 8_880_000n, // 8.88 USDC
  fundedWnear: 500_000_000_000_000_000_000_000n, // 0.5 wNEAR
  swapUsdc: 2_000_000n,
  maxCostBps: 250,
  requests: 3,
} as const;

/** The phase-1 policy, with the treasury's applied destination list copied in unchanged. */
export function phase1Policy(destinations: Policy["destinations"]): Policy {
  return {
    frozen: false,
    actions: ["swap", "transfer"],
    confidential: true,
    owner_approval: false,
    assets: [WNEAR, USDC, ASSETS.ETH],
    limits: {
      per_transaction: { [USDC]: "5000000" },
      hourly: { [USDC]: "5000000" },
      daily: { [USDC]: "5000000" },
      monthly: { [USDC]: "3000000" },
    },
    max_actions_per_hour: null,
    destinations,
    budget: { daily_usd: "10", weekly_usd: "10", monthly_usd: "10" },
    timelock_ms: 0,
  } as Policy;
}

class Stop extends Error {
  constructor(message: string, readonly evidence?: unknown) {
    super(`Stopped: ${message}`);
  }
}

/** Only a dedicated test agent: never the treasury, payout or CLI agent, whatever its settings say. */
export function testAgentId() {
  if (!ENV_FILE.endsWith(".env.e2e")) throw new Stop(`run with ENV_FILE=.env.e2e, not ${ENV_FILE}`);
  const id = process.env.AGENT_ID;
  if (!id) throw new Stop("AGENT_ID is not set in .env.e2e: create the test agent first");
  for (const other of [".env", ".env.dao", ".env.payout", ".env.invoices"]) {
    if (!existsSync(other)) continue;
    if (parseEnv(readFileSync(other, "utf8")).AGENT_ID === id) throw new Stop(`AGENT_ID is the agent of ${other}, not a test agent`);
  }
  return id;
}

/** The treasury's applied destinations and revision, read now. */
async function treasuryDestinations() {
  if (!existsSync(".env.dao")) throw new Stop(".env.dao is missing: the treasury's destinations can't be read");
  const treasury = parseEnv(readFileSync(".env.dao", "utf8")).AGENT_ID;
  if (!treasury) throw new Stop(".env.dao has no AGENT_ID");
  const view = await api.getPolicy(treasury);
  if (!view.policy || view.status !== "APPLIED") throw new Stop(`the treasury's policy is ${view.status}, not applied`);
  return { treasury, revision: view.revision, destinations: view.policy.destinations };
}

async function writePolicy(file: string) {
  testAgentId();
  const copied = await treasuryDestinations();
  writeFileSync(file, `${JSON.stringify(phase1Policy(copied.destinations), null, 2)}\n`);
  return copied;
}

const sum = (raw: string | undefined) => BigInt(raw ?? "0");

/** Budget usage and balances: recorded before and after every request. */
export async function snapshot(id: string) {
  const [view, open, shielded] = await Promise.all([
    api.getPolicy(id), api.getBalances(id, { source: "public" }), api.getBalances(id, { source: "confidential" }),
  ]);
  const raw = (b: typeof open, asset: string) => b.balances.find((x) => x.asset_id === asset)?.balance_raw ?? "0";
  return {
    at: new Date().toISOString(),
    revision: view.revision,
    budget: view.usage.budget,
    balances: {
      usdc: { public: raw(open, USDC), confidential: raw(shielded, USDC) },
      wnear: { public: raw(open, WNEAR), confidential: raw(shielded, WNEAR) },
    },
    // The price the USD budget is charged at, and until when the provider holds it fresh.
    usdcPrice: (({ price, price_updated_at, price_expires_at }) => ({ price, price_updated_at, price_expires_at }))(
      shielded.balances.find((x) => x.asset_id === USDC) ?? { price: null, price_updated_at: null, price_expires_at: null }),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const spent = (s: Snapshot) => ({ daily: s.budget.daily.spent_usd, weekly: s.budget.weekly.spent_usd, monthly: s.budget.monthly.spent_usd });

/** A dry quote for the 2 USDC swap, with its worst cost at the floor, from the provider's own prices. */
export async function quote(id: string) {
  const request = { origin_asset: USDC, destination_asset: WNEAR, amount: AMOUNTS.swapUsdc.toString(), confidential: true };
  const { quote: q } = await agent().swap(id, { ...request, dry: true });
  const minAmountOut = typeof q.min_amount_out === "string" ? q.min_amount_out : undefined;
  if (!minAmountOut) throw new Stop("the quote has no min_amount_out", q);
  const tokens = await api.getTokens();
  const [usdc, wnear] = [tokens.find((t) => t.asset_id === USDC), tokens.find((t) => t.asset_id === WNEAR)];
  if (!usdc?.price || !wnear?.price) throw new Stop("no USDC or wNEAR price to judge the quote's cost", q);
  const worstCostBps = Math.round(costBps(usdValue(AMOUNTS.swapUsdc, usdc.decimals, usdc.price), usdValue(minAmountOut, wnear.decimals, wnear.price)));
  if (!(worstCostBps <= AMOUNTS.maxCostBps)) throw new Stop(`the quote's worst cost is ${worstCostBps} bps, over ${AMOUNTS.maxCostBps}`, q);
  return { request: { ...request, min_amount_out: minAmountOut }, quote: q, worstCostBps };
}

/** Everything FUNDED-TESTS.md's preflight records and confirms. Reads only. */
export async function preflight(id: string) {
  const [view, grants, copied, before] = await Promise.all([api.getPolicy(id), api.listGrants(id), treasuryDestinations(), snapshot(id)]);
  const problems: string[] = [];
  if (!view.policy) problems.push("no policy");
  else {
    if (JSON.stringify(view.policy.destinations) !== JSON.stringify(copied.destinations))
      problems.push(`the applied destinations differ from the treasury's (revision ${copied.revision})`);
    if (canonicalPolicy(view.policy) !== canonicalPolicy(phase1Policy(copied.destinations))) problems.push("the applied policy isn't the phase-1 policy");
  }
  if (view.status !== "APPLIED" || !view.provider_policy_synced) problems.push(`the policy is ${view.status}, synced ${view.provider_policy_synced}`);
  for (const [window, value] of Object.entries(spent(before))) if (Number(value) !== 0) problems.push(`${window} budget already spent: $${value}`);
  if (readOps().length) problems.push(`${readOps().length} operations already recorded for this agent`);
  const { usdc, wnear } = before.balances;
  if (sum(usdc.confidential) !== AMOUNTS.fundedUsdc || sum(usdc.public) !== 0n) problems.push(`USDC is ${usdc.confidential} confidential / ${usdc.public} public, not ${AMOUNTS.fundedUsdc} / 0`);
  if (sum(wnear.public) !== AMOUNTS.fundedWnear || sum(wnear.confidential) !== 0n) problems.push(`wNEAR is ${wnear.public} public / ${wnear.confidential} confidential, not ${AMOUNTS.fundedWnear} / 0`);
  const live = grants.filter((g) => isLive(g));
  const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
  if (live.length !== 1 || !grant) problems.push(`${live.length} live grants; this agent's token ${grant ? "matches one" : "matches none"}`);
  else if (!grantAllows("treasury", grant.label)) problems.push(`the grant is "${grant.label}", not a treasury grant`);
  if (problems.length) throw new Stop(`preflight: ${problems.join("; ")}`, { before, copied });
  const priced = await quote(id);
  return { treasury: { revision: copied.revision }, grant: { id: grant!.grant_id, label: grant!.label, expires_at: grant!.expires_at }, before, quote: priced };
}

/** Settled usage can trail the status: wait a little for the budget to move, never longer than `waitMs`. */
async function usageAfter(id: string, from: Snapshot, waitMs: number) {
  const until = Date.now() + waitMs;
  let after = await snapshot(id);
  while (after.budget.daily.spent_usd === from.budget.daily.spent_usd && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    after = await snapshot(id);
  }
  return after;
}

export async function runPhase1({ evidenceDir, settleWaitMs = 60_000 }: { evidenceDir: string; settleWaitMs?: number }) {
  const id = testAgentId();
  mkdirSync(evidenceDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(evidenceDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  let requests = 0;
  const send = async (kind: string, action: Parameters<typeof dispatch>[2]) => {
    if (++requests > AMOUNTS.requests) throw new Stop(`a ${requests}th request: the plan allows exactly ${AMOUNTS.requests}`);
    const lock = await acquireMoneyLock();
    try { return await dispatch(lock, kind, action); } finally { await lock.release(); }
  };

  const pre = await preflight(id).catch((error) => { write("preflight-stopped", { error: String(error), evidence: (error as Stop).evidence }); throw error; });
  write("1-preflight", pre);

  // E10: shield 0.5 wNEAR. An internal movement: expected to succeed and to charge no USD budget.
  const before2 = await snapshot(id);
  const shield = await send("e2e-shield", { method: "shield", request: { asset: WNEAR, amount: AMOUNTS.fundedWnear.toString() } });
  const after2 = await snapshot(id);
  write("2-shield", { before: before2, operation: shield, after: after2 });
  if (shield.status !== "SUCCESS") throw new Stop(`the shield ended ${shield.status} (${shield.failure_code ?? "no code"})`);
  if (sum(after2.balances.wnear.public) !== 0n || sum(after2.balances.wnear.confidential) !== AMOUNTS.fundedWnear)
    throw new Stop("the shield didn't move exactly 0.5 wNEAR from public to confidential");
  if (JSON.stringify(spent(after2)) !== JSON.stringify(spent(before2))) throw new Stop("the shield changed the USD budget");

  // Monthly cap, first spend: 2 USDC of 3, every other limit fits. Expected to execute.
  const q3 = await quote(id);
  const before3 = await snapshot(id);
  const swap3 = await send("e2e-swap-1", { method: "swap", request: q3.request });
  const after3 = await usageAfter(id, before3, settleWaitMs);
  write("3-swap-admitted", { quote: q3, before: before3, operation: swap3, after: after3 });
  if (swap3.status !== "SUCCESS") throw new Stop(`the first swap ended ${swap3.status} (${swap3.failure_code ?? "no code"})`);
  if (sum(before3.balances.usdc.confidential) - sum(after3.balances.usdc.confidential) !== AMOUNTS.swapUsdc)
    throw new Stop("the first swap didn't spend exactly 2 USDC");
  if (after3.budget.daily.spent_usd === before3.budget.daily.spent_usd) throw new Stop("the first swap charged no USD budget within the wait");

  // Monthly cap, refusal: 2 more USDC would make 4 of 3; only the monthly cap is exceeded.
  const q4 = await quote(id);
  const before4 = await snapshot(id);
  let refused: string | undefined;
  let admitted: unknown;
  try { admitted = await send("e2e-swap-2", { method: "swap", request: q4.request }); }
  catch (error) { refused = readOps().at(-1)?.refused ?? String(error); }
  const after4 = await snapshot(id);
  const last = readOps().at(-1);
  write("4-swap-refused", { quote: q4, before: before4, refused, operation: admitted ?? { idempotencyKey: last?.idempotencyKey, correlationId: last?.correlationId ?? null }, after: after4 });
  if (admitted || last?.correlationId) throw new Stop("the second swap was admitted: the monthly cap didn't hold");
  if (refused !== "policy_denied") throw new Stop(`the second swap was refused with ${refused}, not policy_denied`);
  if (JSON.stringify(after4.balances) !== JSON.stringify(before4.balances) || JSON.stringify(spent(after4)) !== JSON.stringify(spent(before4)))
    throw new Stop("the refusal changed balances or budget");

  const summary = { agent: id, requests, shield: shield.correlation_id, admitted: swap3.correlation_id, refused, evidenceDir };
  write("summary", summary);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [mode, arg] = process.argv.slice(2);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const evidenceDir = process.env.E2E_EVIDENCE_DIR ?? join(homedir(), "agencies", "proto-releases", `${stamp}-envelope-phase1`);
  if (mode === "--write-policy" && arg) console.log(JSON.stringify(await writePolicy(arg), null, 2));
  else if (mode === "--preflight") console.log(JSON.stringify(await preflight(testAgentId()), null, 2));
  else if (mode === "--run") console.log(JSON.stringify(await runPhase1({ evidenceDir }), null, 2));
  else throw new Error("Usage: --write-policy <file> | --preflight | --run");
}
