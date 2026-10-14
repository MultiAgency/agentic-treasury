import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EventSchemas } from "@ag-ui/core/schemas";
import { demoEvents, demoState, demoSteps } from "../web/src/demo-events.js";

test("public simulation streams conform to AG-UI and preserve refusal at run completion", () => {
  for (const kind of ["facilitator", "treasury"] as const) {
    for (const scenario of ["standard", "reserve", "refusal"] as const) {
      const events = demoEvents(kind, scenario);
      for (const event of events) assert.equal(EventSchemas.safeParse(event).success, true, JSON.stringify(event));
      assert.equal(events[0]!.type, "RUN_STARTED");
      assert.equal(events.at(-1)!.type, "RUN_FINISHED");
      const states = events.map((_, i) => demoState(events, i));
      assert.equal(states.at(-1)!.tone, scenario === "refusal" ? "refusal" : "success");
      if (scenario === "refusal") assert.ok(states.every(s => s.tone !== "success" && !s.approval));
      if (kind === "facilitator" && scenario !== "refusal") {
        const approval = states.findIndex(s => s.approval);
        assert.ok(approval > 0 && approval < states.findIndex(s => s.tone === "success"));
      }
    }
  }
  assert.notDeepEqual(demoEvents("treasury", "standard"), demoEvents("treasury", "reserve"));
});

test("example allocations conserve totals, reflect strategy and never show a result on refusal", () => {
  for (const scenario of ["standard", "reserve"] as const) {
    for (const permission of [true, false]) {
      const events = demoEvents("treasury", scenario, permission);
      const steps = demoSteps(events);
      assert.equal(steps.length, permission ? 4 : 2);
      for (const position of steps) {
        const state = demoState(events, position);
        const allocation = state.allocation!;
        assert.equal(allocation.before.reduce((a, b) => a + b), 100);
        assert.equal(allocation.target.reduce((a, b) => a + b), 100);
        assert.equal(allocation.target[0], scenario === "reserve" ? 70 : 40);
        if (state.tone === "success") assert.deepEqual(allocation.result, allocation.target);
        else assert.equal(allocation.result, undefined);
      }
    }
  }
});

test("public simulation modules have only local playback and AG-UI dependencies", () => {
  for (const file of ["public-demo.tsx", "demo-events.ts", "prototype-explorer.tsx"]) {
    const source = readFileSync(new URL(`../web/src/${file}`, import.meta.url), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map(m => m[1]);
    assert.ok(imports.every(name => ["react", "./demo-events", "./public-demo", "@ag-ui/core"].includes(name!)));
    assert.doesNotMatch(source, /fetch\(|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|useQuery|client\./);
  }
});
