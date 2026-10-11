import { AgentApi, type StatusResponse } from "@near-intents-agent-api/sdk";
// Applies this instance's settings file before anything reads them: every entry point reaches the API.
import "./env.js";

const apiKey = process.env.NEAR_INTENTS_AGENT_API_KEY;
if (!apiKey) throw new Error("NEAR_INTENTS_AGENT_API_KEY is not set (see .env.example)");

export const api = new AgentApi({
  apiKey,
  baseUrl: process.env.NEAR_INTENTS_AGENT_API_URL ?? "https://api.demo.agentsonintents.com",
});

const MOVING = new Set<StatusResponse["status"]>(["PROCESSING", "QUEUED"]);

/** Still on its way: a status that says nothing yet about how the operation ends. */
export const isMoving = (status: StatusResponse["status"]) => MOVING.has(status);

/** Polls until the operation stops moving; UNCERTAIN/NEEDS_REVIEW are returned, never retried. */
export async function waitForStatus(correlationId: string, signal = AbortSignal.timeout(180_000)) {
  while (true) {
    signal.throwIfAborted();
    const status = await api.getStatus(correlationId, { waitMs: 30_000, signal });
    if (!isMoving(status.status)) return status;
  }
}
