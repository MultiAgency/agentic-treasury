// The CLI end to end against a running simulated stack: `TREASURY_STACK=<run>/stack pnpm test:stack`.
// Each role's credential is issued by the owner through the stack's control and kept in this process only.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { TOKENS, type Role } from "../src/config.ts";
import { issue, stack, targets, USDC, WNEAR, type Stack } from "../scripts/stack.ts";

const directory = process.env.TREASURY_STACK;
if (!directory) throw new Error("Set TREASURY_STACK to the running stack's directory (<run>/stack)");
const target: Stack = stack(directory);
const tokens = {} as Record<Role, string>;

before(async () => {
  for (const role of ["propose", "execute", "sweep"] as const) tokens[role] = await issue(target, role, 600);
  // Test-only workaround (no stack control sets targets at 5cd4d4d): writes the strategy file directly. Ten points more
  // wNEAR than held, so a rebalance always needs a USDC → wNEAR leg, the one pair the simulator quotes.
  const book = treasury(["status"]).values[0].overview.value.book as { asset: string; usd: number }[];
  const total = book.reduce((sum, holding) => sum + holding.usd, 0), held = book.find(holding => holding.asset === WNEAR)?.usd ?? 0;
  const wnear = Math.min(Math.round(held / total * 10_000) + 1_000, 9_000);
  targets(target, { [USDC]: 10_000 - wnear, [WNEAR]: wnear, "nep141:eth.omft.near": 0 });
});

/** Runs the CLI with stdin that isn't a terminal; its output is a sequence of JSON values. */
function treasury(args: string[], credentials: Partial<Record<Role, string>> = tokens) {
  const env = { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: target.ca, TREASURY_ORIGIN: target.origin, TREASURY_AGENT: target.agent,
    ...Object.fromEntries(Object.entries(credentials).map(([role, token]) => [TOKENS[role as Role], token])) };
  const run = spawnSync(process.execPath, ["src/cli.ts", ...args], { env, encoding: "utf8", input: "" });
  for (const token of Object.values(tokens)) assert.ok(!run.stdout.includes(token) && !run.stderr.includes(token), "no token is printed");
  const values = run.stdout.trim() ? run.stdout.trim().split(/\n(?=[{[])/).map(text => JSON.parse(text)) : [];
  return { code: run.status, values, outcome: values.at(-1)?.outcome, stderr: run.stderr };
}

const activity = () => treasury(["status"]).values[0].activity.value as { planId?: string; status?: string }[];

test("status reads holdings, unresolved operations and activity", () => {
  const { code, values: [report] } = treasury(["status"]);
  assert.equal(code, 0);
  assert.equal(report.overview.value.area, "treasury");
  assert.deepEqual(report.unresolved.value, []);
});

test("the agent proposes a rebalance; the owner's approval executes it once", () => {
  const plan = treasury(["plan"]);
  assert.equal(plan.code, 0, plan.stderr);
  const saved = plan.values.find(value => value.type === "saved");
  assert.ok(saved, "a plan was saved");
  const planId: string = saved.plan.id;

  const unconfirmed = treasury(["execute", planId]);
  assert.deepEqual([unconfirmed.code, unconfirmed.outcome.kind], [2, "refused"]);
  assert.ok(!activity().some(row => row.planId === planId), "nothing was sent without the owner's confirmation");

  const executed = treasury(["execute", planId, "--yes"]);
  assert.equal(executed.code, 0, JSON.stringify(executed.values));
  assert.deepEqual(executed.values.filter(value => value.type === "action").map(value => value.status), ["SUCCESS"]);
  assert.deepEqual(activity().filter(row => row.planId === planId).map(row => row.status), ["SUCCESS"]);

  const again = treasury(["execute", planId, "--yes"]);
  assert.equal(again.code, 2, "a saved plan executes at most once");
  assert.equal(activity().filter(row => row.planId === planId).length, 1);
});

test("the agent proposes a chosen swap; the owner executes it", () => {
  const plan = treasury(["plan", "swap", USDC, WNEAR, "1000000"]);
  assert.equal(plan.code, 0, plan.stderr);
  const planId: string = plan.values[0].id;
  const executed = treasury(["execute", planId, "--yes"]);
  assert.equal(executed.code, 0, JSON.stringify(executed.values));
  assert.deepEqual(activity().filter(row => row.planId === planId).map(row => row.status), ["SUCCESS"]);
});

test("each credential reaches only its scopes", () => {
  const plan = treasury(["plan", "swap", USDC, WNEAR, "1000000"]);
  const planId: string = plan.values[0].id;
  const forbidden = treasury(["execute", planId, "--yes"], { propose: tokens.propose, execute: tokens.propose });
  assert.deepEqual([forbidden.code, forbidden.outcome.kind], [2, "forbidden"], "preparing doesn't permit executing");
  const unread = treasury(["sweep"], { propose: tokens.propose, sweep: tokens.execute });
  assert.deepEqual([unread.code, unread.outcome.kind], [2, "forbidden"], "executing a plan doesn't permit sweeping");
  assert.ok(!activity().some(row => row.planId === planId));
});

test("sweep previews, then shields with the owner's confirmation", () => {
  const preview = treasury(["sweep"]);
  assert.equal(preview.code, 0);
  assert.equal(preview.values[0].type, "plan");
  assert.deepEqual(treasury(["sweep", "--execute"]).code, 2, "nothing is shielded without confirmation");
  const swept = treasury(["sweep", "--execute", "--yes"]);
  assert.equal(swept.code, 0, JSON.stringify(swept.values));
  // At 5cd4d4d the simulator reports no public Treasury balance, so there is nothing exposed to shield.
  assert.deepEqual(swept.values[0], { type: "plan", exposed: [] });
});
