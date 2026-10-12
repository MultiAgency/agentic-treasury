import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { invoiceOperations, recordInvoiceOperation, type PaymentState } from "./invoice-store.js";

/**
 * The append-only log of one agent's money actions, `.ops/<agent id>.jsonl`. A request line is
 * written before anything is sent; later lines for the same key record what came back. An
 * operation is unresolved until a line proves its outcome, and unresolved operations block that
 * agent's new money actions (see lock.ts). Agents share no balances, so they share no log.
 */
export function opsLog() {
  const id = process.env.AGENT_ID;
  if (!id) throw new Error("AGENT_ID is not set: create an agent first");
  mkdirSync(".ops", { recursive: true });
  return join(".ops", `${id}.jsonl`);
}

export type Method = "swap" | "transfer" | "shield" | "unshield";

/** What a request line records beside the request: the mandate it ran under and what it was worth. */
export type Context = {
  policyRevision?: number | null;
  /** `mandateDigest` of the policy in force when the request was sent. */
  policyDigest?: string | null;
  /** The plan this action executes, when it executes one. */
  planId?: string;
  /** The input's value at the API's token price when sent; null when it has none. */
  usdIn?: number | null;
};

export type Line =
  | ({ at: string; idempotencyKey: string; kind: string; method?: Method; request: Record<string, unknown> } & Context)
  /** Outcome lines are stamped when written (`at`), so the log shows how long each took to resolve. */
  | { at?: string; idempotencyKey: string; correlation_id: string; status: string }
  | { at?: string; idempotencyKey: string; refused: string };

export type Op = Context & {
  invoiceId?: string;
  submissionState?: PaymentState;
  at: string;
  idempotencyKey: string;
  kind: string;
  /** Absent on lines written before the method was recorded; inferred from the request instead. */
  method?: Method;
  request: Record<string, unknown>;
  correlationId?: string;
  status?: string;
  refused?: string;
};

const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

/** Outcome proven: settled terminally, or refused before anything was sent. */
export const isResolved = (op: Op) => op.refused !== undefined || (op.status !== undefined && TERMINAL.has(op.status));

/**
 * Sent, and waiting for the owner's approval. Its outcome is unknown but cannot be lost: the
 * correlation id is logged and the approval releases that one execution, so it never blocks new
 * money actions. The approval, or `pnpm reconcile`, records how it ends.
 */
export const isHeld = (op: Op) => op.status === "PENDING_APPROVAL";

export function record(line: Line) {
  if ("correlation_id" in line) {
    const existing = readOps().find((op) => op.idempotencyKey === line.idempotencyKey);
    if (existing?.correlationId && existing.correlationId !== line.correlation_id) {
      throw new Error("Provider operation identity changed");
    }
    if (existing && isResolved(existing) && line.status !== existing.status) {
      return; // never reopen a proven terminal outcome with contradictory evidence
    }
  }
  if (recordInvoiceOperation(line)) return;
  appendFileSync(opsLog(), `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, { flush: true });
}

/** Records a logged operation's latest status, found by its correlation id. */
export function settle(correlationId: string, status: string) {
  const op = readOps().find((o) => o.correlationId === correlationId);
  if (op) record({ idempotencyKey: op.idempotencyKey, correlation_id: correlationId, status });
}

/** Every operation in the log, oldest first, folded with the outcomes recorded for it. */
export function readOps(): Op[] {
  const log = opsLog();
  const ops = new Map<string, Op>();
  for (const text of (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n")) {
    if (!text.trim()) continue;
    const line = JSON.parse(text) as Line;
    if ("request" in line) ops.set(line.idempotencyKey, { ...line });
    const op = ops.get(line.idempotencyKey);
    if (!op) continue;
    if ("refused" in line) op.refused = line.refused;
    if ("correlation_id" in line) Object.assign(op, { correlationId: line.correlation_id, status: line.status });
  }
  for (const op of invoiceOperations()) {
    if (ops.has(op.idempotencyKey)) throw new Error("Operation exists in both stores; reconcile before executing");
    ops.set(op.idempotencyKey, op);
  }
  return [...ops.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The code of a refusal the API documents as proven: nothing was sent, and the same key replays
 * the refusal. Anything else (a server failure, `retryable`, a lost response) may have taken effect.
 */
/** A send or approval this server holds before anything reaches the provider. */
export class AuthorizationHeld extends Error {
  constructor(message: string) { super(`Execution held: ${message}`); }
}

export function provenRefusal(error: unknown): string | undefined {
  if (!(error instanceof AgentApiError) || error.retryable) return undefined;
  if (error.status >= 500 && !PROVEN_5XX.has(error.code ?? "")) return undefined;
  return error.code ?? `http_${error.status}`;
}
const PROVEN_5XX = new Set(["route_unavailable", "quote_unavailable", "spend_price_unavailable"]);
