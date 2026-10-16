import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { Supervisor } from "../src/gateway/supervisor.js";

test("Supervisor bounds exponential restart delay and cancels sleeps using virtual time", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const clock = yield* TestClock.make();
    let attempts = 0;
    const supervisor = new Supervisor(() => { attempts++; throw new Error("synthetic spawn failure"); },
      { initialDelay: 20, maxDelay: 80, stableAfter: 1000, grace: 500, killGrace: 500 }, clock);
    try {
      supervisor.start({ name: "one" }); supervisor.start({ name: "one" });
      assert.equal(attempts, 1);
      yield* clock.adjust(39); assert.equal(attempts, 1);
      yield* clock.adjust(1); assert.equal(attempts, 2);
      yield* clock.adjust(79); assert.equal(attempts, 2);
      yield* clock.adjust(1); assert.equal(attempts, 3);
      yield* clock.adjust(80); assert.equal(attempts, 4, "backoff stays capped");
    } finally { yield* Effect.promise(() => supervisor.stop()); }
    yield* clock.adjust(10_000);
    supervisor.start({ name: "two" });
    assert.equal(attempts, 4, "closed scope owns every restart sleep");
  })));
});
