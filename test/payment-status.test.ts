import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.js";
import { paymentStatus } from "../src/payouts.js";

// Offline: the provider's status answer is replaced per case. Shapes as read on mainnet, 2026-10-13:
// every status there named its agent, including owner intents.
const answer = (status: Record<string, unknown>) =>
  Object.assign(api, { getStatus: async (correlation_id: string) => ({ correlation_id, status: "SUCCESS", ...status }) });
const self = process.env.AGENT_ID!;

test("a transfer of this agent's is followed: status, failure code and times", async () => {
  answer({ type: "transfer", agent_id: self, failure_code: null, created_at: "2026-10-13T12:00:00Z", updated_at: "2026-10-13T12:01:00Z" });
  assert.deepEqual(await paymentStatus("op_mine"), { status: "SUCCESS", failureCode: null, createdAt: "2026-10-13T12:00:00Z", updatedAt: "2026-10-13T12:01:00Z" });
});

test("another agent's transfer is refused", async () => {
  answer({ type: "transfer", agent_id: "b".repeat(64) });
  await assert.rejects(paymentStatus("op_theirs"));
});

test("a status that names no agent is refused: nothing proves it is this agent's", async () => {
  answer({ type: "transfer", agent_id: null });
  await assert.rejects(paymentStatus("op_unnamed"), /Not a payment of this agent/);
});

test("this agent's other operations and owner intents are no payment", async () => {
  answer({ type: "swap", agent_id: self });
  await assert.rejects(paymentStatus("op_swap"), /Not a payment of this agent/);
  answer({ type: "agent_create", agent_id: null });
  await assert.rejects(paymentStatus("intent_create"), /Not a payment of this agent/);
});

test("asked to wait, the read long-polls at the provider; otherwise it answers at once", async () => {
  let asked: { waitMs?: number } | undefined;
  Object.assign(api, { getStatus: async (correlation_id: string, options: { waitMs?: number }) => {
    asked = options;
    return { correlation_id, status: "SUCCESS", type: "transfer", agent_id: self };
  } });
  await paymentStatus("op_mine", 25_000);
  assert.equal(asked?.waitMs, 25_000);
  await paymentStatus("op_mine");
  assert.equal(asked?.waitMs, undefined, "a first read answers at once");
});
