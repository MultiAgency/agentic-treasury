import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AgentApiError, grantCommitment, type Policy } from "@near-intents-agent-api/sdk";

/**
 * The phase-1 envelope runner (src/envelope-phase1.ts) against a simulated provider that enforces a
 * monthly USDC cap and charges the USD budget for swaps, not shields. Offline: no network.
 */

process.env.ENV_FILE = ".env.e2e"; // before the modules read it
const { AMOUNTS, phase1Policy, preflight, runPhase1, testAgentId } = await import("../src/envelope-phase1.js");
const { api } = await import("../src/api.js");
const { ASSETS } = await import("../src/policy.js");
const { readOps } = await import("../src/ops.js");

const home = process.cwd();
const TREASURY = "t".repeat(64);
const TEST_AGENT = "e".repeat(64);
const destinations = { mode: "only", list: [{ action: "transfer", address: "agentic.sputnik-dao.near", confidential: true }] } as Policy["destinations"];
type Book = Record<string, { public: bigint; confidential: bigint }>;
let book: Book, spentUsd: number, monthlyUsdc: bigint, requests: string[], applied: Policy, capHolds: boolean;

const usage = () => {
  const window = { limit_usd: "10", spent_usd: spentUsd.toFixed(2), remaining_usd: (10 - spentUsd).toFixed(2), resets_at: null };
  return { budget: { daily: window, weekly: window, monthly: window }, timelock: { delay_ms: 0, scheduled_count: 0 } };
};
const view = (policy: Policy) => ({ wallet_id: "w", revision: 7, policy_hash: null, status: "APPLIED", applied_at: null, transaction_hash: null,
  provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, policy, usage: usage() });

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "envelope-")));
  writeFileSync(".env.dao", `AGENT_ID=${TREASURY}\n`);
  writeFileSync(".env", "AGENT_ID=c".padEnd(73, "c") + "\n");
  Object.assign(process.env, { AGENT_ID: TEST_AGENT, AGENT_GRANT_TOKEN: "ngt_e2e" });
  book = { [ASSETS.USDC]: { public: 0n, confidential: AMOUNTS.fundedUsdc }, [ASSETS.wNEAR]: { public: AMOUNTS.fundedWnear, confidential: 0n } };
  spentUsd = 0;
  monthlyUsdc = 0n;
  requests = [];
  applied = phase1Policy(destinations);
  capHolds = true;
  mock.method(globalThis, "fetch", async () => { throw new Error("offline only"); });
  mock.method(api, "getPolicy", async (id: string) => (id === TREASURY ? view({ ...applied, destinations }) : view(applied)));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: "public" | "confidential" }) => ({
    balances: Object.entries(book).map(([asset_id, b]) => ({ asset_id, balance_raw: b[source].toString() })),
  }));
  mock.method(api, "listGrants", async () => [{ grant_id: "g-1", label: "treasury", revoked_at: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(), owner_message: { credential: grantCommitment("ngt_e2e") } }]);
  mock.method(api, "getTokens", async () => [
    { asset_id: ASSETS.USDC, decimals: 6, price: 1 }, { asset_id: ASSETS.wNEAR, decimals: 24, price: 2 },
  ]);
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: TEST_AGENT, status: "SUCCESS" }));
  mock.method(api, "forGrant", () => ({
    // 2 USDC at $1 buys 1 wNEAR at $2; a floor of 0.99 wNEAR is a worst cost of 100 bps.
    swap: async (_id: string, request: { amount: string; dry?: boolean }) => {
      if (request.dry) return { quote: { amount_out: "1000000000000000000000000", min_amount_out: "990000000000000000000000" } };
      requests.push("swap");
      if (capHolds && monthlyUsdc + BigInt(request.amount) > 3_000_000n)
        throw new AgentApiError(409, { errors: [{ status: "409", code: "policy_denied", title: "Policy denied" }], meta: {} });
      monthlyUsdc += BigInt(request.amount);
      book[ASSETS.USDC]!.confidential -= BigInt(request.amount);
      book[ASSETS.wNEAR]!.confidential += 10n ** 24n;
      spentUsd += Number(request.amount) / 1e6;
      return { correlation_id: `op_swap_${requests.length}` };
    },
    shield: async (_id: string, request: { asset: string; amount: string }) => {
      requests.push("shield");
      book[request.asset]!.public -= BigInt(request.amount);
      book[request.asset]!.confidential += BigInt(request.amount);
      return { correlation_id: "op_shield" };
    },
  }));
});
afterEach(() => { mock.restoreAll(); process.chdir(home); });

const evidenceDir = () => mkdtempSync(join(tmpdir(), "evidence-"));

test("the three requests run as planned: shield uncharged, 2 USDC admitted, 2 more refused by the monthly cap", async () => {
  const dir = evidenceDir();
  const summary = await runPhase1({ evidenceDir: dir, settleWaitMs: 0 });
  assert.deepEqual(requests, ["shield", "swap", "swap"]);
  assert.equal(summary.refused, "policy_denied");
  assert.deepEqual(readdirSync(dir).sort(), ["1-preflight.json", "2-shield.json", "3-swap-admitted.json", "4-swap-refused.json", "summary.json"]);
  assert.equal(readOps().at(-1)?.refused, "policy_denied", "recorded as a refusal, so nothing is left unresolved");
});

test("a cap that doesn't hold stops the run and says so", async () => {
  capHolds = false;
  await assert.rejects(runPhase1({ evidenceDir: evidenceDir(), settleWaitMs: 0 }), /the monthly cap didn't hold/);
});

test("preflight refuses an applied policy whose destinations aren't the treasury's", async () => {
  applied = phase1Policy({ ...destinations, list: [...destinations.list, { action: "transfer", address: "else.near", confidential: true }] });
  await assert.rejects(preflight(TEST_AGENT), /destinations differ/);
  assert.deepEqual(requests, []);
});

test("preflight refuses a wallet funded with anything but exactly 6 USDC and 0.5 wNEAR", async () => {
  book[ASSETS.USDC]!.confidential = 7_000_000n;
  await assert.rejects(preflight(TEST_AGENT), /USDC is 7000000 confidential/);
});

test("it never runs as the treasury, payout or CLI agent", () => {
  process.env.AGENT_ID = TREASURY;
  assert.throws(() => testAgentId(), /agent of \.env\.dao/);
});

test("a quote costing more than 250 bps at its floor stops before anything is sent", async () => {
  mock.method(api, "getTokens", async () => [{ asset_id: ASSETS.USDC, decimals: 6, price: 1 }, { asset_id: ASSETS.wNEAR, decimals: 24, price: 1.9 }]);
  await assert.rejects(runPhase1({ evidenceDir: evidenceDir(), settleWaitMs: 0 }), /worst cost is \d+ bps/);
  assert.deepEqual(requests, []);
});
