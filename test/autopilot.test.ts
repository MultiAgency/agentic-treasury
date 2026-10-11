import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { saveSettings, settings, tick } from "../src/autopilot.js";
import { dismiss, readInbox } from "../src/inbox.js";
import { opsLog } from "../src/ops.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";

// Offline: an in-memory book behind the API, so each tick runs the real sweep, rebalance, plan
// checks, lock and ops log. Every asset has 0 decimals and a $1 price, and quotes cost nothing.
const home = process.cwd();
let book: Record<string, { public: bigint; confidential: bigint }>;
let frozen: boolean;
let sends: string[];
let statusOf: (id: string) => string;

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "autopilot-")));
  process.env.AGENT_ID = "a".repeat(64);
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  // 100 USDC and nothing else: 50 below target in wNEAR and ETH together.
  book = Object.fromEntries(Object.values(ASSETS).map((asset) => [asset, { public: 0n, confidential: 0n }]));
  book[ASSETS.USDC]!.confidential = 100n;
  frozen = false;
  sends = [];
  statusOf = () => "SUCCESS";
  mock.method(globalThis, "fetch", async () => {
    throw new Error("offline only");
  });
  mock.method(api, "getPolicy", async () => ({ policy: { ...treasuryPolicy, frozen }, revision: 1, usage: null }));
  mock.method(api, "getTokens", async () => Object.entries(ASSETS).map(([symbol, asset_id]) => ({ symbol, asset_id, decimals: 0, price: 1 })));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: "public" | "confidential" }) => ({
    balances: Object.entries(book).map(([asset_id, balances]) => ({ asset_id, balance_raw: String(balances[source]) })),
  }));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: statusOf(correlation_id) }));
  mock.method(api, "forGrant", () => ({
    shield: async (_id: string, request: { asset: string; amount: string }) => {
      sends.push(`shield ${request.asset}`);
      book[request.asset]!.public -= BigInt(request.amount);
      book[request.asset]!.confidential += BigInt(request.amount);
      return { correlation_id: `op_${sends.length}` };
    },
    swap: async (_id: string, request: { dry?: boolean; origin_asset: string; destination_asset: string; amount: string }) => {
      if (request.dry) return { quote: { amount_out: request.amount, min_amount_out: request.amount } };
      sends.push(`swap ${request.origin_asset} → ${request.destination_asset}`);
      book[request.origin_asset]!.confidential -= BigInt(request.amount);
      book[request.destination_asset]!.confidential += BigInt(request.amount);
      return { correlation_id: `op_${sends.length}` };
    },
  }));
});
afterEach(() => {
  mock.restoreAll();
  process.chdir(home);
});

const limit = (maxUsd: number) => saveSettings({ ...settings(), maxUsd });
const open = () => readInbox().filter((e) => e.level !== "run" && !e.dismissed);

test("a rebalance within the limit executes, and the tick says what it did", async () => {
  limit(100);
  const report = await tick();
  // Which deficit the planner fills first is its business; both must be filled.
  assert.deepEqual(sends.toSorted(), [`swap ${ASSETS.USDC} → ${ASSETS.ETH}`, `swap ${ASSETS.USDC} → ${ASSETS.wNEAR}`]);
  assert.equal(book[ASSETS.USDC]!.confidential, 50n);
  assert.match(report, /step 1: SUCCESS, step 2: SUCCESS/);
  assert.equal(readInbox()[0]?.level, "run");
  assert.deepEqual(open(), []);
});

test("a rebalance above the limit sends nothing and asks the owner", async () => {
  limit(10);
  const report = await tick();
  assert.deepEqual(sends, []);
  assert.match(report, /rebalance of \$50\.00 left for the owner/);
  const [ask] = open();
  assert.equal(ask?.level, "action");
  assert.match(ask!.text, /\$50\.00 is above the \$10\.00 auto-execute limit/);
});

test("public balances are shielded even at a $0 limit, before the rebalance is weighed", async () => {
  book[ASSETS.wNEAR]!.public = 5n;
  limit(0);
  await tick();
  assert.deepEqual(sends, [`shield ${ASSETS.wNEAR}`]);
  assert.equal(book[ASSETS.wNEAR]!.public, 0n);
});

test("an action without a proven outcome stops the tick before anything is sent or resent", async () => {
  writeFileSync(
    opsLog(),
    `${JSON.stringify({ at: new Date().toISOString(), idempotencyKey: "swap:lost", kind: "rebalance", method: "swap", request: { origin_asset: "a", destination_asset: "b", amount: "1" } })}\n`,
  );
  limit(100);
  assert.equal(await tick(), "Skipped: unresolved money actions.");
  assert.deepEqual(sends, []);
  // Never sent, so its acceptance is unknown: recover() reports it and resends nothing.
  assert.match(open()[0]!.text, /swap:lost \(unknown, 0 min old\)/);
});

test("a payout held for the owner's approval doesn't stop the tick", async () => {
  writeFileSync(
    opsLog(),
    [
      { at: new Date().toISOString(), idempotencyKey: "payout:held", kind: "payout", method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "p.near", confidential: true } },
      { idempotencyKey: "payout:held", correlation_id: "op_held", status: "PENDING_APPROVAL" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  statusOf = (id) => (id === "op_held" ? "PENDING_APPROVAL" : "SUCCESS");
  limit(100);
  assert.match(await tick(), /step 1: SUCCESS/);
  assert.equal(sends.length, 2);
});

test("a frozen agent is left alone", async () => {
  frozen = true;
  limit(100);
  assert.equal(await tick(), "Skipped: the agent is frozen.");
  assert.deepEqual(sends, []);
});

test("two ticks never run at once", async () => {
  limit(100);
  const [first, second] = await Promise.all([tick(), tick()]);
  assert.match(first, /step 1: SUCCESS/);
  assert.equal(second, "Skipped: a tick is already running.");
  assert.equal(sends.length, 2);
});

test("the limit lives in the strategy file and on/off in the settings file", () => {
  saveSettings({ on: true, everyMin: 15, maxUsd: 7 });
  assert.deepEqual(settings(), { on: true, everyMin: 15, maxUsd: 7 });
  assert.equal(process.env.AUTOPILOT, "on");
  saveSettings({ on: false, everyMin: 15, maxUsd: 7 });
  assert.equal(settings().on, false);
});

test("a dismissed entry stays in the inbox but no longer asks", async () => {
  limit(10);
  await tick();
  const [ask] = open();
  dismiss(ask!.id);
  assert.deepEqual(open(), []);
  assert.equal(readInbox().find((e) => e.id === ask!.id)?.dismissed, true);
});
