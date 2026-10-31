import { test } from "node:test";
import assert from "node:assert/strict";
import type { OwnerFailure } from "@multiagency/sdk";
import { run, type Connect } from "../src/commands.ts";

const unknown = (procedure: string, identity = {}): OwnerFailure => ({ ok: false, kind: "unknown", procedure: procedure as never, identity });
const provider: OwnerFailure = { ok: false, kind: "provider", error: "Declared provider outage", details: {} };
const unavailable: OwnerFailure = { ok: false, kind: "unavailable" };

/**
 * A fake machine route: each procedure answers from `answers` (a call's result, or a stream's events and end),
 * and every request is recorded with the role whose credential sent it.
 */
function fake(answers: Record<string, unknown>) {
  const sent: string[] = [], printed: unknown[] = [];
  const answer = (path: string) => {
    if (!(path in answers)) throw new Error(`Unexpected ${path}`);
    return answers[path];
  };
  const connect: Connect = role => ({
    call: async (path: string) => { sent.push(`${role}:${path}`); return answer(path); },
    async *stream(path: string) {
      sent.push(`${role}:${path}`);
      const { events = [], end, throws } = answer(path) as { events?: unknown[]; end?: OwnerFailure; throws?: Error };
      if (throws) throw throws;
      yield* events;
      return end;
    },
  }) as never;
  const io = { print: (value: unknown) => printed.push(value), warn: () => {}, confirm: async () => false };
  return { sent, printed, connect, io };
}

const recorded = { unresolved: { ok: true, value: [{ key: "op", kind: "swap" }] }, activity: { ok: true, value: [] } };

test("unknown after execution started: exit 3, reads what was recorded, never resends", async () => {
  const route = fake({ executePlan: { events: [{ type: "action", index: 0, status: "SUBMITTED" }], end: unknown("executePlan", { planId: "p" }) }, ...recorded });
  assert.equal(await run(["execute", "p", "--yes"], route.connect, route.io), 3);
  assert.deepEqual(route.sent.sort(), ["execute:executePlan", "propose:activity", "propose:unresolved"]);
  assert.deepEqual(route.printed.at(-1), { recorded: { unresolved: recorded.unresolved, activity: recorded.activity } });
});

test("unknown sweep: exit 3, reads what was recorded, never resends", async () => {
  const route = fake({ sweep: { end: unknown("sweep", { execute: true }) }, ...recorded });
  assert.equal(await run(["sweep", "--execute", "--yes"], route.connect, route.io), 3);
  assert.deepEqual(route.sent.sort(), ["propose:activity", "propose:unresolved", "sweep:sweep"]);
});

test("a lost sweep preview is a lost read: unavailable, exit 2, no records read", async () => {
  const route = fake({ sweep: { events: [{ type: "plan", exposed: [] }], end: unknown("sweep", { execute: false }) }, ...recorded });
  assert.equal(await run(["sweep"], route.connect, route.io), 2);
  assert.deepEqual(route.sent, ["sweep:sweep"]);
  assert.deepEqual(route.printed.at(-1), { outcome: { ok: false, kind: "unavailable" } });
});

test("a throw after the first event is unknown: exit 3, records read, never resent", async () => {
  const route = fake({ executePlan: { events: [{ type: "action", index: 0, status: "SUCCESS", correlationId: "c0" }, { type: "action", index: 1, status: "SUCCESS", correlationId: "c1" }] }, ...recorded });
  const io = { ...route.io, print: (value: unknown) => {
    if ((value as { type?: string }).type === "action") throw new Error("stdout closed");
    route.printed.push(value);
  } };
  assert.equal(await run(["execute", "p", "--yes"], route.connect, io), 3);
  assert.deepEqual(route.sent.sort(), ["execute:executePlan", "propose:activity", "propose:unresolved"]);
  assert.deepEqual(route.printed[0], { outcome: { ok: false, kind: "unknown", procedure: "executePlan", identity: { planId: "p" } } });
});

test("a throw before the first event stays a throw", async () => {
  const route = fake({ executePlan: { throws: new Error("before anything") } });
  await assert.rejects(run(["execute", "p", "--yes"], route.connect, route.io), /before anything/);
  assert.deepEqual(route.sent, ["execute:executePlan"]);
});

test("usage errors are reported before anything is configured or sent", async () => {
  const route = fake({});
  const connect = (() => { throw new Error("Set TREASURY_ORIGIN in .env"); }) as Connect;
  const warned: string[] = [], io = { ...route.io, warn: (text: string) => warned.push(text) };
  for (const argv of [[], ["bogus"], ["plan", "swap", "a", "b"], ["plan", "swap", "a", "b", "0"], ["plan", "swap", "a", "b", "1", "000000"],
    ["plan", "extra"], ["execute"], ["execute", "p", "q"], ["status", "x"], ["sweep", "x"], ["sweep", "--unknown"]])
    assert.equal(await run(argv, connect, io), 2, argv.join(" "));
  assert.equal(warned.length, 11);
  assert.ok(warned.every(text => text.startsWith("Usage:")));
});

test("plan swap with a stray space in the amount: usage, exit 2, no plan proposed", async () => {
  const route = fake({ externalPlan: { ok: true, value: { id: "p" } } });
  assert.equal(await run(["plan", "swap", "a", "b", "1", "000000"], route.connect, route.io), 2);
  assert.deepEqual(route.sent, []);
});

test("unknown proposal: exit 3, reads what was recorded", async () => {
  const route = fake({ externalPlan: unknown("externalPlan"), ...recorded });
  assert.equal(await run(["plan", "swap", "a", "b", "1"], route.connect, route.io), 3);
  assert.deepEqual(route.sent.sort(), ["propose:activity", "propose:externalPlan", "propose:unresolved"]);
});

test("unknown stays exit 3 when what was recorded can't be read", async () => {
  const route = fake({ executePlan: { end: unknown("executePlan", { planId: "p" }) } });
  const connect = (role => { if (role === "propose") throw new Error("Set TREASURY_PROPOSE_TOKEN in .env"); return route.connect(role); }) as Connect;
  assert.equal(await run(["execute", "p", "--yes"], connect, route.io), 3);
  assert.deepEqual(route.sent, ["execute:executePlan"]);
});

test("provider outage before execution: exit 2, nothing more is read or sent", async () => {
  const route = fake({ executePlan: { end: provider }, sweep: { end: provider } });
  assert.equal(await run(["execute", "p", "--yes"], route.connect, route.io), 2);
  assert.equal(await run(["sweep", "--execute", "--yes"], route.connect, route.io), 2);
  assert.deepEqual(route.sent, ["execute:executePlan", "sweep:sweep"]);
  assert.deepEqual(route.printed, [{ outcome: provider }, { outcome: provider }]);
});

const leg = (index: number, status: string, extra = {}) =>
  ({ type: "action", index, action: { type: "swap" }, status, correlationId: status === "NOT_SENT" ? "" : `c${index}`, failureCode: null, ...extra });
const rejected = (problem: string) => ({ type: "rejected", problems: [problem] });
/** Runs `execute p --yes` against the events `executePlan` streams, ending normally. */
async function executed(events: unknown[]) {
  const route = fake({ executePlan: { events }, ...recorded });
  const code = await run(["execute", "p", "--yes"], route.connect, route.io);
  const read = route.sent.filter(path => path.startsWith("propose:")).sort();
  assert.deepEqual(route.sent.filter(path => path === "execute:executePlan"), ["execute:executePlan"], "executePlan is sent once");
  return { code, read, outcome: (route.printed.find(value => (value as { outcome?: unknown }).outcome) as { outcome: { kind?: string; legs?: unknown[] } }).outcome };
}
const RECORDS = ["propose:activity", "propose:unresolved"];

test("every leg SUCCESS: exit 0, nothing more is read", async () => {
  assert.deepEqual(await executed([leg(0, "SUCCESS"), leg(1, "SUCCESS")]), { code: 0, read: [], outcome: { ok: true } });
});

test("rejected before any leg: refused, exit 2, nothing more is read", async () => {
  const { code, read, outcome } = await executed([rejected("the plan was already executed")]);
  assert.deepEqual([code, read, outcome.kind], [2, [], "refused"]);
});

test("a swap not sent, with no shield before it: refused, exit 2", async () => {
  const { code, outcome } = await executed([leg(0, "NOT_SENT")]);
  assert.deepEqual([code, outcome.kind], [2, "refused"]);
});

test("leg 1 SUCCESS then rejected: partial, exit 4, legs printed, records read", async () => {
  const { code, read, outcome } = await executed([leg(0, "SUCCESS"), rejected("the remaining plan is no longer feasible")]);
  assert.deepEqual([code, read, outcome.kind], [4, RECORDS, "partial"]);
  assert.deepEqual(outcome.legs, [{ index: 0, status: "SUCCESS", correlationId: "c0", failureCode: null }]);
});

test("a FAILED or REFUNDED leg: partial, exit 4, never 0", async () => {
  for (const events of [[leg(0, "FAILED")], [leg(0, "REFUNDED")], [leg(0, "SUCCESS"), leg(1, "FAILED")]]) {
    const { code, read, outcome } = await executed(events);
    assert.deepEqual([code, read, outcome.kind], [4, RECORDS, "partial"], JSON.stringify(events));
  }
});

test("a swap not sent after its shield was: partial, exit 4", async () => {
  const { code, outcome } = await executed([leg(0, "NOT_SENT", { shield: { amount: "5", status: "SUCCESS" } })]);
  assert.deepEqual([code, outcome.kind], [4, "partial"]);
});

test("a leg or shield the provider hasn't settled: unknown, exit 3, records read", async () => {
  for (const events of [[leg(0, "PENDING")], [leg(0, "SUCCESS"), leg(1, "PROCESSING")], [leg(0, "NOT_SENT", { shield: { amount: "5", status: "PENDING" } })]]) {
    const { code, read, outcome } = await executed(events);
    assert.deepEqual([code, read, outcome.kind], [3, RECORDS, "unknown"], JSON.stringify(events));
  }
});

test("sweep is decided by its shields, not its stream's end", async () => {
  const swept = async (statuses: string[]) => {
    const route = fake({ sweep: { events: [{ type: "plan", exposed: [] }, ...statuses.map((status, i) => ({ type: "shield", asset: `a${i}`, status, correlationId: `s${i}` }))] }, ...recorded });
    const code = await run(["sweep", "--execute", "--yes"], route.connect, route.io);
    assert.deepEqual(route.sent.filter(path => path === "sweep:sweep"), ["sweep:sweep"]);
    return code;
  };
  assert.equal(await swept([]), 0);
  assert.equal(await swept(["SUCCESS", "SUCCESS"]), 0);
  assert.equal(await swept(["SUCCESS", "FAILED"]), 4);
  assert.equal(await swept(["PENDING"]), 3);
});

test("unavailable reads: exit 2", async () => {
  const route = fake({ overview: unavailable, unresolved: unavailable, activity: { ok: true, value: [] } });
  assert.equal(await run(["status"], route.connect, route.io), 2);
});

test("without the owner's confirmation nothing is sent", async () => {
  const route = fake({});
  assert.equal(await run(["execute", "p"], route.connect, route.io), 2);
  assert.equal(await run(["sweep", "--execute"], route.connect, route.io), 2);
  assert.deepEqual(route.sent, []);
});
