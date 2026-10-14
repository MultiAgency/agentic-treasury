import { STAGE_LABEL } from "../../src/run-progress-schema.js";
import { MAX_RECORDING_BYTES, RecordingSchema, type Recording, type RunLogEvent } from "../../src/run-log-schema.js";

/** Read-only validation: a recording is evidence, never an instruction or a live status response. */
export function inspectRecording(value: unknown, agentId: string, tickId: string): Recording {
  const source = JSON.stringify(value);
  if (!source || source.length > MAX_RECORDING_BYTES || new TextEncoder().encode(source).length > MAX_RECORDING_BYTES)
    throw new Error("Recording is too large or missing.");
  const recording = RecordingSchema.parse(value);
  if (recording.agentId !== agentId || recording.tickId !== tickId) throw new Error("The recording does not match this agent and run.");
  return recording;
}

export const recordingSummary = (recording: Recording) => recording.completion === "recorded-end"
  ? "Run end recorded. Operation outcomes are shown separately."
  : "No run end recorded. The outcome is unknown.";

export function observationLabel(event: RunLogEvent): string {
  if (event.type === "RUN_STARTED") return "Run started";
  if (event.type === "RUN_FINISHED") return "Run end recorded";
  if (event.type === "STEP_STARTED") return `${STAGE_LABEL[event.stepName]} · started`;
  if (event.type === "STEP_FINISHED") return `${STAGE_LABEL[event.stepName]} · returned`;
  const value = event.value;
  switch (value.stage) {
    case "submission": return `${value.method[0]!.toUpperCase()}${value.method.slice(1)} submitted · outcome not yet established`;
    case "before": return "Balances before";
    case "after": return "Balances after";
    case "plan": return "Plan recorded";
    case "shield": return `Shield ${value.index + 1} · ${value.status}`;
    case "send": return `Swap ${value.index + 1} · ${value.status}`;
  }
}
