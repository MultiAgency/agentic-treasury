import assert from "node:assert/strict";
import { test } from "node:test";
import { tickLog } from "../src/agui.js";
import type { Tick } from "../src/evidence.js";
import { inspectRecording, observationLabel, recordingSummary } from "../web/src/recording-model.js";

const at = "2026-01-01T00:00:00.000Z";
const tick: Tick = {
  id: "tick-1", agentId: "agent-a", at, trigger: "schedule",
  schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null },
  build: { deployment: null, source: "fixture", lockfile: null, packageJson: null },
  policy: { revision: 1, digest: "fixture", status: "APPLIED" }, strategy: "fixture", grant: null,
  end: { endedAt: at, before: { error: "unavailable" }, after: { error: "unavailable" },
    plan: null, steps: [{ index: 0, correlationId: "op-1", status: "SENT", failureCode: null }],
    shields: [], rejected: [], refusal: null, outcome: "awaiting outcome" },
};
const recording = () => tickLog(tick, { agentId: tick.agentId, records: [], gaps: [] }, {
  exportedAt: at, display: { asOf: at, assets: [] },
});

test("recording inspection validates version, identity and size before display", () => {
  const value = recording();
  assert.deepEqual(inspectRecording(value, "agent-a", "tick-1"), value);
  assert.throws(() => inspectRecording(value, "other-agent", "tick-1"), /match/);
  assert.throws(() => inspectRecording(value, "agent-a", "other-tick"), /match/);
  assert.throws(() => inspectRecording({ ...value, schemaVersion: 3 }, "agent-a", "tick-1"));
  assert.throws(() => inspectRecording({ ...value, oversized: "x".repeat(2_000_001) }, "agent-a", "tick-1"), /large/);
});

test("recorded end never implies settlement, including later successful observations", () => {
  const value = recording();
  value.laterObservations.push({ correlationId: "op-1", source: "journal", record: {
    line: 1, recordedAt: at, idempotencyKey: "key-1", type: "status", status: "SUCCESS",
  } });
  assert.equal(recordingSummary(value), "Run end recorded. Operation outcomes are shown separately.");
  const send = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "send")!;
  assert.equal(observationLabel(send), "Swap 1 · SENT");
  assert.equal(send.metadata.timing, "unknown");
  assert.equal(send.timestamp, undefined);
});

test("a missing run end stays unknown, not failed or completed", () => {
  const value = tickLog({ ...tick, end: null }, { agentId: tick.agentId, records: [], gaps: [] }, {
    exportedAt: at, display: { asOf: at, assets: [] },
  });
  assert.equal(recordingSummary(value), "No run end recorded. The outcome is unknown.");
  assert.deepEqual(value.events.map(observationLabel), ["Run started"]);
});
