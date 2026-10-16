import { z } from "zod";
import type { WorkOrder } from "./work-order-store.js";
import type { mine } from "./invoices.js";
import type { prepare, submit, status, ownerActions } from "./owner-intents.js";

export const workOrderCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }).strict(),
  z.object({ type: z.literal("deposit") }).strict(),
  z.object({ type: z.literal("prepare"), action: z.enum(["create", "grant", "approve", "reject", "revoke"]), signer: z.enum(["wallet", "dao"]) }).strict(),
  z.object({ type: z.literal("submit"), correlationId: z.string().min(1).max(200), signedData: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal("status"), correlationId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("file"), payee: z.string().min(2).max(64) }).strict(),
]);
export type WorkOrderCommand = z.infer<typeof workOrderCommand>;
export type WorkOrderOwnerAction = Extract<WorkOrderCommand, { type: "prepare" }>["action"];
export type WorkOrderSnapshot = {
  order: WorkOrder;
  agentId: string | null;
  wallet: string | null;
  balance: string | null;
  policyReady: boolean;
  grant: { id: string; expiresAt: string } | null;
  invoice: Awaited<ReturnType<typeof mine>>[number] | null;
  ownerActions: ReturnType<typeof ownerActions>;
  approval: { correlationId: string; approvalId: string } | null;
  error: string | null;
};
export type WorkOrderReply = {
  snapshot: WorkOrderSnapshot;
  deposit: Awaited<ReturnType<typeof import("./agent.js").depositAddress>>;
  prepare: Awaited<ReturnType<typeof prepare>>;
  submit: Awaited<ReturnType<typeof submit>>;
  status: ReturnType<typeof status>;
  file: Awaited<ReturnType<typeof import("./invoices.js").file>>;
};

/** The payee projection never includes balances, owner actions, signatures, grants or provider IDs. */
export function publicWorkOrder(snapshot: WorkOrderSnapshot) {
  const { order, invoice } = snapshot;
  return { id: order.id, amount: order.amount, note: order.note, until: order.until, createdAt: order.createdAt,
    invoice, ready: (!invoice || invoice.status === "prepared" && !invoice.revisionConflict) &&
      !snapshot.error && snapshot.policyReady && Boolean(snapshot.grant) &&
      snapshot.balance !== null && BigInt(snapshot.balance) === BigInt(order.amount) && Date.parse(order.until) > Date.now(),
    unavailable: Boolean(snapshot.error) };
}
export type PublicWorkOrder = ReturnType<typeof publicWorkOrder>;


/** Read-only progress: expiry never overwrites an accepted or unresolved payment. */
export function workOrderProgress(snapshot: WorkOrderSnapshot, now = Date.now()) {
  const expired = now >= Date.parse(snapshot.order.until);
  const residual = snapshot.balance !== null && BigInt(snapshot.balance) > 0n ? snapshot.balance : null;
  const stage = snapshot.error ? "unavailable" : snapshot.invoice && snapshot.invoice.status !== "prepared" ? snapshot.invoice.status
    : expired ? "expired" : !snapshot.agentId ? "authorize" : !snapshot.policyReady ? "policy"
    : !snapshot.grant ? "grant" : snapshot.balance === null ? "unavailable"
    : BigInt(snapshot.balance) < BigInt(snapshot.order.amount) ? "fund" : BigInt(snapshot.balance) > BigInt(snapshot.order.amount) ? "funding_review" : "submit";
  return { stage, expired, residual, excess: snapshot.balance !== null && BigInt(snapshot.balance) > BigInt(snapshot.order.amount)
    ? (BigInt(snapshot.balance) - BigInt(snapshot.order.amount)).toString() : null };
}
