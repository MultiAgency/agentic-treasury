import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { FastnearFailure, FastnearHttp, fastnearPostEffect, indexedPages, readDeadline, runFastnear } from "../src/fastnear.js";
import { FastnearHttpLive } from "../src/infrastructure/fastnear-http.js";

const url = "https://tx.main.fastnear.com/v0/account";
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const failure = (kind: string) => (error: unknown) => error instanceof FastnearFailure && error.kind === kind;

test("live layer captures configuration per workflow and refreshes it for the next workflow", async () => {
  const original = process.env.FASTNEAR_API_KEY;
  try {
    process.env.FASTNEAR_API_KEY = "synthetic-first";
    const read = Effect.gen(function* () {
      const first = yield* FastnearHttp;
      process.env.FASTNEAR_API_KEY = "synthetic-next";
      const second = yield* FastnearHttp;
      assert.equal(first, second);
      return second.apiKey();
    });
    assert.equal(await Effect.runPromise(read.pipe(Effect.provide(FastnearHttpLive))), "synthetic-first");
    assert.equal(await Effect.runPromise(Effect.map(FastnearHttp, http => http.apiKey()).pipe(
      Effect.provide(FastnearHttpLive))), "synthetic-next");
  } finally {
    if (original === undefined) delete process.env.FASTNEAR_API_KEY;
    else process.env.FASTNEAR_API_KEY = original;
  }
});

test("injected transport classifies failures without retrying or disclosing response details", async () => {
  for (const [status, body, kind] of [[403, "private", "Authentication"], [429, "private", "RateLimit"],
    [503, "private", "Unavailable"], [200, "private-malformed", "InvalidResponse"],
    [200, '{"error":"private"}', "ReportedError"]] as const) {
    let calls = 0;
    const client = { apiKey: () => "synthetic-key", fetch: async (_url: string, init: RequestInit) => {
      calls++; assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-key");
      return new Response(body, { status });
    } };
    await assert.rejects(runFastnear(fastnearPostEffect(url, {}), undefined, client), error => {
      assert.ok(failure(kind)(error)); assert.doesNotMatch(String(error), /private|synthetic-key/); return true;
    });
    assert.equal(calls, 1);
  }
});

test("cancellation aborts four active reads and never starts queued reads", { timeout: 2000 }, async () => {
  const started = gate();
  let calls = 0, active = 0, aborted = 0;
  const client = { apiKey: () => undefined, fetch: (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    calls++; active++;
    init.signal!.addEventListener("abort", () => { active--; aborted++; reject(new Error("private abort reason")); }, { once: true });
    if (calls === 4) started.resolve();
  }) };
  const controller = new AbortController();
  const read = runFastnear(Effect.forEach(Array.from({ length: 12 }), () => fastnearPostEffect(url, {}), { concurrency: 4 }), controller.signal, client);
  const rejected = assert.rejects(read, failure("Cancelled"));
  await started.promise;
  controller.abort(); await rejected;
  assert.deepEqual({ calls, active, aborted }, { calls: 4, active: 0, aborted: 4 });
  await assert.rejects(runFastnear(fastnearPostEffect(url, {}), controller.signal, client), failure("Cancelled"));
  assert.equal(calls, 4, "already-cancelled reads perform no fetch");
});

test("request timeout includes body consumption and aborts its transport using TestClock", { timeout: 2000 }, async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const started = gate();
    let signal!: AbortSignal;
    const client = { apiKey: () => undefined, fetch: async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      return { ok: true, json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("private body")), { once: true }); started.resolve();
      }) } as Response;
    } };
    const read = Effect.result(fastnearPostEffect(url, {})).pipe(Effect.provideService(FastnearHttp, client));
    const fiber = yield* Effect.forkChild(read);
    yield* Effect.promise(() => started.promise);
    yield* TestClock.adjust(29_999); assert.equal(signal.aborted, false);
    yield* TestClock.adjust(1);
    const result = yield* Fiber.join(fiber);
    assert.ok(Result.isFailure(result)); assert.equal(result.failure.kind, "Incomplete");
    assert.equal(signal.aborted, true);
  }).pipe(Effect.provide(TestClock.layer())));
});

test("pagination shares one deadline across pages and returns no partial success", { timeout: 2000 }, async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const first = gate(), second = gate();
    let calls = 0, firstResponse!: (response: Response) => void, secondSignal!: AbortSignal;
    const client = { apiKey: () => undefined, fetch: (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      calls++;
      if (calls === 1) { firstResponse = resolve; first.resolve(); }
      else { secondSignal = init.signal!; secondSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); second.resolve(); }
    }) };
    const pages = indexedPages(() => Effect.map(fastnearPostEffect(url, {}), () => ({ items: ["partial"], next: "next" })));
    const fiber = yield* Effect.forkChild(Effect.result(readDeadline(pages, 120)).pipe(Effect.provideService(FastnearHttp, client)));
    yield* Effect.promise(() => first.promise);
    yield* TestClock.adjust(60);
    firstResponse(Response.json({}));
    yield* Effect.promise(() => second.promise);
    yield* TestClock.adjust(59); assert.equal(secondSignal.aborted, false);
    yield* TestClock.adjust(1);
    const result = yield* Fiber.join(fiber);
    assert.ok(Result.isFailure(result)); assert.equal(result.failure.kind, "Incomplete");
    assert.equal(secondSignal.aborted, true); assert.equal(calls, 2);
  }).pipe(Effect.provide(TestClock.layer())));
});
