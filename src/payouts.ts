import { api, isMoving, readStatus } from "./api.js";
import { agentId } from "./env.js";
import { isHeld, readOps, settle } from "./ops.js";

/** How long a held payout stays approvable: the API keeps an approval open for 24 hours. */
const APPROVAL_TTL_MS = 24 * 60 * 60_000;

/**
 * Money actions waiting for the owner's approval, each with the approval that releases it. Any
 * that moved on since are recorded instead, except one released but still on its way: recording
 * `PROCESSING` would leave it unresolved and block every money action until it settles, while it
 * can't be lost. The API's approvals list can come back empty while one is pending (seen on
 * mainnet), so each held execution's own status is the source.
 *
 * Historical payouts absent from the local store come from the API's history, as kind "remote",
 * and are never written here. Current invoice and dashboard submissions share this executor and
 * local activity. If the history can't be read, the local ones still are.
 */
export async function held() {
  const local = readOps().filter(isHeld);
  const waiting = [];
  for (const op of local) {
    const status = await readStatus(op.correlationId!);
    const approvalId = (status.details as { approval_id?: string } | null)?.approval_id;
    if (status.status === "PENDING_APPROVAL" && approvalId)
      waiting.push({ at: op.at, kind: op.kind, request: op.request, correlationId: status.correlation_id, approvalId });
    else if (status.status !== "PENDING_APPROVAL" && !isMoving(status.status)) settle(status.correlation_id, status.status);
  }
  const mine = new Set(local.map((op) => op.correlationId));
  try {
    for (const remote of await heldElsewhere()) if (!mine.has(remote.correlationId)) waiting.push(remote);
  } catch (error) {
    console.warn("held: the API's history is unavailable; showing this instance's held actions only", error);
  }
  return waiting;
}

/** Transfers waiting for approval in the API's history, newest first, from the approval window. */
async function heldElsewhere() {
  const since = Date.now() - APPROVAL_TTL_MS;
  const found = [];
  let cursor: string | undefined;
  do {
    const page = await api.getHistory(agentId(), { limit: 50, ...(cursor && { cursor }) });
    for (const entry of page.data) {
      const approvalId = (entry.details as { approval_id?: string } | null)?.approval_id;
      if (entry.type !== "transfer" || entry.status !== "PENDING_APPROVAL" || !approvalId) continue;
      const { request_data: data } = await api.getApproval(agentId(), approvalId);
      const request = { asset: data.token, amount: data.amount, recipient: data.to, confidential: true };
      found.push({ at: entry.created_at, kind: "remote", request, correlationId: entry.correlation_id, approvalId });
    }
    const oldest = page.data.at(-1)?.created_at;
    cursor = page.next_cursor && oldest && Date.parse(oldest) > since ? page.next_cursor : undefined;
  } while (cursor);
  return found;
}
