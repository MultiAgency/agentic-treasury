import assert from "node:assert/strict";
import { test } from "node:test";
import { EventSchemas } from "@ag-ui/core/schemas";
import { guidanceEvent, GuidanceEventSchema } from "../src/demo-guidance.js";

test("guidance uses valid AG-UI observations without pretending to complete an agent run", () => {
  for (const workflow of ["treasury", "payables", "invoices"] as const) {
    const event = guidanceEvent({ agentId: "fixture", workflow, blocker: "Read unavailable" });
    assert.ok(EventSchemas.safeParse(event).success);
    assert.equal(event.type, "CUSTOM");
    assert.equal(event.value.stage, "check");
    assert.equal(event.value.source, "ui-observation");
    assert.equal(event.value.record, null);
  }
});
test("selected identity remains exact despite blockers and cannot imply settlement", () => {
  const event = guidanceEvent({ agentId: "fixture", workflow: "payables", blocker: "Outcome unresolved", record: { kind: "payment", id: "exact-payment" } });
  assert.equal(event.value.stage, "follow");
  assert.equal(event.value.blocker, "Outcome unresolved");
  assert.deepEqual(event.value.record, { kind: "payment", id: "exact-payment" });
  assert.equal(GuidanceEventSchema.safeParse({ ...event, value: { ...event.value, settled: true } }).success, false);
  assert.equal(GuidanceEventSchema.safeParse({ ...event, type: "RUN_FINISHED" }).success, false);
  assert.equal(GuidanceEventSchema.safeParse({ ...event, value: { ...event.value, record: null } }).success, false);
  assert.throws(() => guidanceEvent({ agentId: "fixture", workflow: "treasury", record: { kind: "payment", id: "wrong-kind" } }));
  assert.equal(guidanceEvent({ agentId: "fixture", workflow: "payables" }).value.stage, "review", "reload without a selection never guesses the last payment");
});
