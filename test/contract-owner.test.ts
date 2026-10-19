import assert from "node:assert/strict";
import { test } from "node:test";
import type { InferRouterInputs, InferRouterOutputs } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { z } from "zod";
import type { Router } from "../src/router.js";
import { os } from "../src/rpc/base.js";
import { MoneyLockBusy, UnresolvedOperations } from "../src/lock.js";
import { PublicError } from "../src/public-error.js";
import { ownerClient, type OwnerProcedure } from "../src/contract/owner-client.js";
import type { OwnerInputs } from "../src/contract/owner-inputs.js";
import type { ownerOutputs } from "../src/contract/owner-outputs.js";

// Compile time: the published contract equals what the router accepts and accepts everything it returns.
type At<T, P extends string> = P extends `${infer H}/${infer R}` ? H extends keyof T ? At<T[H], R> : never : P extends keyof T ? T[P] : never;
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
// A procedure without input infers as `void`; the client spells it `undefined`.
type Input<P extends OwnerProcedure> = [At<InferRouterInputs<Router>, P>] extends [void] ? undefined : At<InferRouterInputs<Router>, P>;
type Event<T> = T extends AsyncIterable<infer E> ? E : T;
type Output<P extends OwnerProcedure> = Event<Awaited<At<InferRouterOutputs<Router>, P>>>;
type InputMismatch = { [P in OwnerProcedure]: Same<OwnerInputs[P], Input<P>> extends true ? never : P }[OwnerProcedure];
type OutputRejected = { [P in OwnerProcedure]: Output<P> extends z.input<(typeof ownerOutputs)[P]> ? never : P }[OwnerProcedure];
const inputsMatch: [InputMismatch] extends [never] ? true : InputMismatch = true;
const outputsAccepted: [OutputRejected] extends [never] ? true : OutputRejected = true;
// The policy schedule is the SDK's own shape, both ways: what the provider sends is accepted, and what a consumer
// reads can be handed to SDK-typed code.
type Schedule = NonNullable<NonNullable<z.output<(typeof ownerOutputs)["overview"]>["policy"]>["policy"]>["schedule"];
const scheduleIsSdk: [NonNullable<Schedule>] extends [import("@near-intents-agent-api/sdk").Schedule] ? [import("@near-intents-agent-api/sdk").Schedule] extends [NonNullable<Schedule>] ? true : false : false = true;
void [inputsMatch, outputsAccepted, scheduleIsSdk];

/** The real wire: an oRPC handler with Proto's error middleware, behind the client's fetch. */
function serve(routes: Record<string, unknown>, gateway?: (request: Request) => Response | undefined) {
  const handler = new RPCHandler(routes as never);
  const requests: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(new URL(request.url).pathname);
    const denied = gateway?.(request); if (denied) return denied;
    // Like fetch: an abort rejects the request even while the handler is still working.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (init?.signal?.aborted) fail(); else init?.signal?.addEventListener("abort", fail, { once: true });
    });
    const { response } = await Promise.race([handler.handle(request, { prefix: "/a/payout/rpc" }), aborted]);
    return response ?? new Response("", { status: 404 });
  };
  return { client: ownerClient({ base: "/a/payout", fetch }), requests };
}
const throwing = (error: unknown) => os.handler(() => { throw error; });

test("a malformed read is unavailable; a malformed mutation answer keeps its identity as unknown and is not resent", async () => {
  const { client, requests } = serve({ instance: os.handler(() => ({ agentId: 7 })), cancelPreparedInvoice: os.input(undefined as never).handler(() => ({ unexpected: true })) });
  assert.deepEqual(await client.call("instance"), { ok: false, kind: "unavailable" });
  const identity = { id: "a".repeat(32) };
  assert.deepEqual(await client.call("cancelPreparedInvoice", identity), { ok: false, kind: "unknown", procedure: "cancelPreparedInvoice", identity });
  assert.equal(requests.filter(p => p.endsWith("/cancelPreparedInvoice")).length, 1);
});

test("recovery cases are distinguishable by kind, without parsing messages", async () => {
  const { client } = serve({ pay: throwing(new UnresolvedOperations([])), deposit: throwing(new MoneyLockBusy()), recover: throwing(new PublicError("Reviewed.")),
    autopilot: { tick: throwing(new Error("disk full at /private/path")) }, setup: throwing(new Error("provider down")) });
  const pay = { recipient: "a.near", asset: "nep141:usdc", amount: "1", confidential: true, expectedPolicy: { revision: 1, digest: "sha256:" + "0".repeat(64) } };
  assert.equal((await client.call("pay", pay) as { kind: string }).kind, "unresolved");
  assert.equal((await client.call("deposit") as { kind: string }).kind, "busy");
  assert.equal((await client.call("recover") as { kind: string }).kind, "refused");
  assert.deepEqual(await client.call("autopilot/tick"), { ok: false, kind: "unknown", procedure: "autopilot/tick", identity: {} }, "a server failure after a tick may have moved funds");
  assert.deepEqual(await client.call("setup"), { ok: false, kind: "unavailable" });
});

test("gateway denials are session or forbidden by status, even as plain JSON or HTML", async () => {
  let status = 401;
  const { client } = serve({}, () => new Response(status === 401 ? '{"error":"Sign in first","access":"session"}' : "<html>no</html>", { status }));
  assert.deepEqual(await client.call("overview"), { ok: false, kind: "session", status: 401, error: "Sign in first" });
  status = 403;
  assert.deepEqual(await client.call("deposit"), { ok: false, kind: "forbidden", status: 403, error: "This account may not do that." });
});

test("a transport failure after a mutation is unknown with its identity; after a read it is unavailable", async () => {
  const client = ownerClient({ base: "/a/payout", fetch: async () => { throw new TypeError("network"); } });
  assert.deepEqual(await client.call("workOrders/file", { id: "w" }), { ok: false, kind: "unknown", procedure: "workOrders/file", identity: { id: "w" } });
  assert.deepEqual(await client.call("held"), { ok: false, kind: "unavailable" });
});

test("streams: invalid events and failures after the first event are unknown with the input identity", async () => {
  // Each fault follows a valid event, which the client must have delivered first: the fault, not the event, decides.
  const rejected = { type: "rejected", problems: [] }, plan = { type: "plan", exposed: [] };
  const { client } = serve({
    executePlan: os.handler(async function* () { yield rejected; throw new UnresolvedOperations([]); }),
    sweep: os.handler(async function* () { yield plan; yield { type: "shield", malformed: true }; }),
    rebalance: throwing(new MoneyLockBusy()),
  });
  const drain = async (events: AsyncGenerator<unknown, unknown>) => { const seen = []; for (;;) { const next = await events.next(); if (next.done) return { seen, result: next.value }; seen.push(next.value); } };
  const executed = await drain(client.stream("executePlan", { planId: "p-1" }));
  assert.deepEqual(executed.seen, [rejected], "the valid event was consumed before the failure");
  assert.deepEqual(executed.result, { ok: false, kind: "unknown", procedure: "executePlan", identity: { planId: "p-1" } });
  const swept = await drain(client.stream("sweep", { execute: true }));
  assert.deepEqual(swept.seen, [plan], "the valid event was consumed before the invalid one");
  assert.deepEqual(swept.result, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  assert.equal(((await drain(client.stream("rebalance", undefined))).result as { kind: string }).kind, "busy", "a refusal before any event keeps its kind");
});

test("a provider failure carries its refusal details", async () => {
  const { AgentApiError } = await import("@near-intents-agent-api/sdk");
  const refusal = new AgentApiError(403, { errors: [{ status: "403", code: "spend_budget_exceeded", title: "Budget", meta: { budget_remaining_usd: "1.5", available_at: "2030-01-01T00:00:00Z" } }] } as never);
  const { client } = serve({ deposit: throwing(refusal) });
  const result = await client.call("deposit") as { kind: string; code?: string; details?: unknown };
  assert.equal(result.kind, "provider"); assert.equal(result.code, "spend_budget_exceeded");
  assert.deepEqual(result.details, { availableAt: "2030-01-01T00:00:00Z", budgetRemainingUsd: "1.5" });
});

test("an aborted read is unavailable; an aborted mutation or stream is unknown with its identity", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const { client } = serve({
    held: os.handler(async () => { await hold; return []; }),
    workOrders: { file: os.handler(async () => { await hold; return { id: "x", status: "waiting" }; }) },
    sweep: os.handler(async function* () { yield { type: "plan", exposed: [] }; await hold; }),
  });
  const abort = () => { const controller = new AbortController(); setTimeout(() => controller.abort(), 20); return controller.signal; };
  assert.deepEqual(await client.call("held", undefined, { signal: abort() }), { ok: false, kind: "unavailable" });
  assert.deepEqual(await client.call("workOrders/file", { id: "w" }, { signal: abort() }), { ok: false, kind: "unknown", procedure: "workOrders/file", identity: { id: "w" } });
  const events = client.stream("sweep", { execute: true }, { signal: abort() });
  const seen = []; let next = await events.next(); while (!next.done) { seen.push(next.value); next = await events.next(); }
  assert.deepEqual(seen, [{ type: "plan", exposed: [] }], "the valid event was consumed before the abort");
  assert.deepEqual(next.value, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  release();
});


test("non-oRPC answers (proxy HTML, foreign JSON, error responses, cut streams) are lost, never refused, and never retried", async () => {
  // oRPC beta.44 rejects these with MalformedResponseError (not an ORPCError): the outcome of a mutation is unknown.
  const answers: Record<string, () => Response> = {
    html: () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }),
    foreign: () => Response.json({ error: "upstream" }, { status: 500 }),
    errored: () => Response.error(),
    redirected: () => new Response(null, { status: 302, headers: { location: "/elsewhere" } }),
  };
  for (const [name, answer] of Object.entries(answers)) {
    let requests = 0;
    const client = ownerClient({ base: "/a/payout", fetch: async () => { requests++; return answer(); } });
    assert.deepEqual(await client.call("workOrders/file", { id: "w" }), { ok: false, kind: "unknown", procedure: "workOrders/file", identity: { id: "w" } }, name);
    assert.deepEqual(await client.call("held"), { ok: false, kind: "unavailable" }, name);
    assert.equal(requests, 2, `${name}: one request per call, no retry`);
  }
  // A stream cut after a valid event, without its closing event: unknown, one request, no reconnect.
  let requests = 0;
  const cut = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ json: { type: "plan", exposed: [] } })}\n\n`));
    setTimeout(() => controller.error(new TypeError("connection reset")), 20);
  } }), { headers: { "content-type": "text/event-stream" } });
  const events = ownerClient({ base: "/a/payout", fetch: async () => { requests++; return cut(); } }).stream("sweep", { execute: true });
  const seen = []; let next = await events.next(); while (!next.done) { seen.push(next.value); next = await events.next(); }
  assert.deepEqual(seen, [{ type: "plan", exposed: [] }]);
  assert.deepEqual(next.value, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  assert.equal(requests, 1, "a cut stream is not retried");
});

test("a provider failure that does not prove non-execution leaves a mutation unknown with its identity; a read stays provider", async () => {
  const { AgentApiError } = await import("@near-intents-agent-api/sdk");
  // A 503 (or proxy HTML wrapped by the SDK) after a submission was attempted: the operation may exist.
  const unproven = () => new AgentApiError(503, { errors: [{ status: "503", code: "service_unavailable", title: "Unavailable" }] } as never);
  const { client } = serve({ deposit: throwing(unproven()), held: throwing(unproven()), sweep: os.handler(async function* () { throw unproven(); }) });
  assert.deepEqual(await client.call("deposit"), { ok: false, kind: "unknown", procedure: "deposit", identity: {} });
  const events = client.stream("sweep", { execute: true });
  let next = await events.next(); while (!next.done) next = await events.next();
  assert.deepEqual(next.value, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  assert.equal((await client.call("held") as { kind: string }).kind, "provider", "a read has no effect to hide");
});
