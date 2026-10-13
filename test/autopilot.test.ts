import { completeExecutionEvidence } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { grantCommitment } from "@near-intents-agent-api/sdk";
import { api } from "../src/api.js";
import { saveSettings, settings, tick } from "../src/autopilot.js";
import { sourceDigest, ticks } from "../src/evidence.js";
import { dismiss, readInbox } from "../src/inbox.js";
import { prepareInvoice } from "../src/invoice-store.js";
import { opsLog } from "../src/ops.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { loadStrategy } from "../src/strategy.js";
import { strategyLabelSuffix } from "../src/strategy-digest.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

// Offline: an in-memory book behind the API, so each tick runs the real sweep, rebalance, plan
// checks, lock and ops log. Every asset has 0 decimals and a $1 price, and quotes cost nothing.
let book: Record<string, { public: bigint; confidential: bigint }>;
let frozen: boolean;
let sends: string[];
let statusOf: (id: string) => string;
/** The label of this server's live grant; by default one that approves the strategy in force. */
let grantLabel: () => string;

freshDirectory("autopilot");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  // 100 USDC and nothing else: 50 below target in wNEAR and ETH together.
  book = Object.fromEntries(Object.values(ASSETS).map((asset) => [asset, { public: 0n, confidential: 0n }]));
  book[ASSETS.USDC]!.confidential = 100n;
  frozen = false;
  sends = [];
  statusOf = () => "SUCCESS";
  grantLabel = () => `treasury:${strategyLabelSuffix(loadStrategy())}`;
  offline();
  mock.method(api, "getPolicy", async () => ({ policy: { ...treasuryPolicy, frozen, budget: { daily_usd: "1000", weekly_usd: "1000", monthly_usd: "1000" } }, revision: 1, usage: null }));
  mock.method(api, "getTokens", async () => Object.entries(ASSETS).map(([symbol, asset_id]) => ({ symbol, asset_id, decimals: 0, price: 1 })));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: "public" | "confidential" }) => ({
    balances: Object.entries(book).map(([asset_id, balances]) => ({ asset_id, balance_raw: String(balances[source]) })),
  }));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: statusOf(correlation_id) }));
  mock.method(api, "listGrants", async () => [
    {
      grant_id: "g",
      label: grantLabel(),
      revoked_at: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      owner_message: { credential: grantCommitment("ngt_test") },
    },
  ]);
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
  completeExecutionEvidence({ grants: true });
});
afterEach(() => mock.restoreAll());

const limit = (maxUsd: number) => saveSettings({ ...settings(), maxUsd });
const open = () => readInbox().filter((e) => e.level !== "run" && !e.dismissed);

test("a rebalance within the limit executes, and the tick says what it did", async () => {
  limit(100);
  const report = await tick("schedule");
  // Which deficit the planner fills first is its business; both must be filled.
  assert.deepEqual(sends.toSorted(), [`swap ${ASSETS.USDC} → ${ASSETS.ETH}`, `swap ${ASSETS.USDC} → ${ASSETS.wNEAR}`]);
  assert.equal(book[ASSETS.USDC]!.confidential, 50n);
  assert.match(report, /step 1: SUCCESS, step 2: SUCCESS/);
  assert.equal(readInbox()[0]?.level, "run");
  assert.deepEqual(open(), []);
});

test("a rebalance above the limit sends nothing and asks the owner", async () => {
  limit(10);
  const report = await tick("schedule");
  assert.deepEqual(sends, []);
  assert.match(report, /rebalance of \$50\.00 left for the owner/);
  const [ask] = open();
  assert.equal(ask?.level, "action");
  assert.match(ask!.text, /\$50\.00 is above the \$10\.00 auto-execute limit/);
});

test("public balances are shielded even at a $0 limit, before the rebalance is weighed", async () => {
  book[ASSETS.wNEAR]!.public = 5n;
  limit(0);
  await tick("schedule");
  assert.deepEqual(sends, [`shield ${ASSETS.wNEAR}`]);
  assert.equal(book[ASSETS.wNEAR]!.public, 0n);
});

test("an action without a proven outcome stops the tick before anything is sent or resent", async () => {
  writeFileSync(
    opsLog(),
    `${JSON.stringify({ at: new Date().toISOString(), idempotencyKey: "swap:lost", kind: "rebalance", method: "swap", request: { origin_asset: "a", destination_asset: "b", amount: "1" } })}\n`,
  );
  limit(100);
  assert.equal(await tick("schedule"), "Skipped: unresolved money actions.");
  assert.deepEqual(sends, []);
  // Never sent, so its acceptance is unknown: recover() reports it and resends nothing.
  assert.match(open()[0]!.text, /swap:lost \(unknown, 0 min old\)/);
});

test("an invoice prepared but never submitted doesn't stop the tick, as it doesn't stop the money lock", async () => {
  prepareInvoice({ payee: "p.near", submission: "s", amount: "1", note: "" }, ASSETS.USDC);
  limit(100);
  assert.notEqual(await tick("schedule"), "Skipped: unresolved money actions.");
  assert.ok(sends.length > 0);
});

test("a legacy held payout without valuation evidence no longer holds new execution", async () => {
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
  // It's reported, not reserved locally; the provider's own budget usage still counts it.
  assert.doesNotMatch(await tick("schedule"), /valuation evidence/);
});

test("a frozen agent is left alone", async () => {
  frozen = true;
  limit(100);
  assert.equal(await tick("schedule"), "Skipped: the agent is frozen.");
  assert.deepEqual(sends, []);
});

test("two ticks never run at once", async () => {
  limit(100);
  const [first, second] = await Promise.all([tick("schedule"), tick("schedule")]);
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
  await tick("schedule");
  const [ask] = open();
  dismiss(ask!.id);
  assert.deepEqual(open(), []);
  assert.equal(readInbox().find((e) => e.id === ask!.id)?.dismissed, true);
});

test("a rebalance within the limit waits when the owner's grant doesn't approve the strategy in force", async () => {
  limit(100);
  // Signed for another strategy (the owner approved a different limit), or for none at all.
  for (const label of ["treasury:00000000000000000000000000000000", "treasury"]) {
    grantLabel = () => label;
    const report = await tick("schedule");
    assert.deepEqual(sends, []);
    assert.match(report, /left for the owner: the owner's grant doesn't approve this strategy/);
    const ask = open().at(-1);
    assert.equal(ask?.level, "action");
    assert.ok(ask!.text.includes(`treasury:${strategyLabelSuffix(loadStrategy())}`), "names the label a new grant must carry");
  }
});

test("without an approving strategy grant, public balances cannot bypass authority by shielding", async () => {
  book[ASSETS.wNEAR]!.public = 5n;
  limit(100);
  grantLabel = () => "treasury";
  await tick("schedule");
  assert.deepEqual(sends, []);
});

test("changing the limit stops auto-execution until the owner signs a grant for the new strategy", async () => {
  limit(100);
  const approved = `treasury:${strategyLabelSuffix(loadStrategy())}`;
  grantLabel = () => approved;
  limit(90); // any edit is another mandate, even a lower limit
  await tick("schedule");
  assert.deepEqual(sends, []);
  grantLabel = () => `treasury:${strategyLabelSuffix(loadStrategy())}`;
  assert.match(await tick("schedule"), /step 1: SUCCESS/);
});

test("every tick records its start and its end: trigger, settings, mandate, book before and after, plan and steps, no credentials", async () => {
  limit(100);
  await tick("schedule");
  await tick("operator");
  const { ticks: [first, second], corrupt } = ticks();
  assert.deepEqual(corrupt, []);
  assert.equal(first!.trigger, "schedule");
  assert.equal(second!.trigger, "operator");
  assert.deepEqual({ on: first!.schedule.on, everyMin: first!.schedule.everyMin, maxUsd: first!.schedule.maxUsd }, settings());
  assert.equal(first!.grant?.label, grantLabel());
  assert.match(first!.build.source, /^sha256:[0-9a-f]{64}$/);
  assert.match(first!.build.lockfile ?? "", /^sha256:[0-9a-f]{64}$/);
  const done = first!.end!;
  assert.equal(done.plan?.legs.length, 2);
  assert.deepEqual(done.steps.map((s) => s.status), ["SUCCESS", "SUCCESS"]);
  assert.ok("driftBps" in done.before && "driftBps" in done.after && done.before.driftBps > done.after.driftBps);
  // The second tick found the book on target: a correct no-op is still a completed tick.
  assert.equal(second!.end!.plan, null);
  assert.equal(second!.schedule.lastRun, readInbox().filter((e) => e.level === "run").at(-1)!.at, "it records the run its schedule counts from");
  assert.doesNotMatch(readFileSync(join(".evidence", `${process.env.AGENT_ID}.jsonl`), "utf8"), /ngt_/, "no grant token");
});

test("a tick skipped because another is running records its start and end too", async () => {
  limit(100);
  await Promise.all([tick("schedule"), tick("schedule")]);
  assert.deepEqual(ticks().ticks.map((t) => t.end?.outcome.startsWith("Skipped: a tick is already running")).toSorted(), [false, true]);
});

test("a tick whose start can't be recorded doesn't run", async () => {
  limit(100);
  mkdirSync(join(".evidence", `${process.env.AGENT_ID}.jsonl`), { recursive: true }); // a directory where the file should be
  assert.match(await tick("schedule"), /^Not run: the tick's evidence could not be recorded/);
  assert.deepEqual(sends, []);
  assert.equal(readInbox()[0]?.level, "warn");
});

test("a start with no end reads as incomplete, and a torn last line is counted, not trusted", async () => {
  limit(100);
  await tick("schedule");
  const path = join(".evidence", `${process.env.AGENT_ID}.jsonl`);
  const [start] = readFileSync(path, "utf8").split("\n");
  writeFileSync(path, `${start}\n{"kind":"end","id":"`);
  const { ticks: read, corrupt } = ticks();
  assert.equal(read.length, 1);
  assert.equal(read[0]!.end, null);
  assert.deepEqual(corrupt, [2]);
});

test("the source digest identifies a tree: same files, same digest; one changed byte, another", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  const digest = sourceDigest(dir);
  assert.equal(sourceDigest(dir), digest);
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  assert.notEqual(sourceDigest(dir), digest);
});

test("a damaged inbox line is skipped, so the scheduler's once-a-minute read never throws", () => {
  const entry = { id: "e1", at: new Date().toISOString(), level: "run", text: "book on target" };
  mkdirSync(".inbox", { recursive: true });
  // A crash mid-append leaves a partial last line.
  writeFileSync(join(".inbox", `${process.env.AGENT_ID}.jsonl`), `${JSON.stringify(entry)}\n{"id":"e2","at":"2026-`);
  assert.deepEqual(readInbox().map((e) => e.id), ["e1"]);
});
