import { type Action, send } from "./agent.js";
import { api, isMoving } from "./api.js";
import { acquireMoneyLock, type MoneyLock } from "./lock.js";
import { isResolved, type Method, type Op, provenRefusal, readOps, record } from "./ops.js";

/**
 * Resolves money actions left without a proven outcome (a crash, a lost response, an UNCERTAIN
 * status), always under their original idempotency key:
 * - with a correlation id, it reads the status once and records it. Reading is always safe, so
 *   anything may do it unattended, the autopilot included;
 * - without one, nothing proves the request was sent. Only with `resend` does it send the stored
 *   body again under the same key, without assuming the provider will deduplicate it. That is a person's call (the owner chose "alert and skip" for the
 *   autopilot): the API keeps a key for a window it doesn't document, and a request that never left
 *   would run late, against a book that has moved since. Each unsent action comes back with its age.
 */

export type Recovery = {
  op: Op;
  /** settled: a final status; refused: a proven refusal; pending: still moving or held for approval;
   * unknown: acceptance or settlement is unproven; it remains blocked. */
  outcome: "settled" | "refused" | "pending" | "unknown";
  status?: string;
  detail?: string;
};

const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

/** For lines written before the method was recorded. */
export const methodOf = (op: Op): Method => {
  if (op.method) return op.method;
  if ("recipient" in op.request) return "transfer";
  if ("origin_asset" in op.request) return "swap";
  if (op.kind === "unshield") return "unshield";
  if (op.kind === "sweep") return "shield";
  throw new Error(`Can't tell how ${op.idempotencyKey} was sent`);
};

/** Every money action without a proven outcome, oldest first. */
export const unresolved = () => readOps().filter((op) => !isResolved(op));

/** Minutes since an action's request was logged. */
export const ageMinutes = (op: Op, now = Date.now()) => Math.round((now - Date.parse(op.at)) / 60_000);

/** Resolves what it can under the money lock; resends only with `resend` (see the module comment). */
export async function recover({ resend = false } = {}): Promise<Recovery[]> {
  const lock = await acquireMoneyLock({ reconcile: true });
  try {
    const recoveries: Recovery[] = [];
    for (const op of unresolved()) {
      try { recoveries.push(await recoverOne(op, resend, lock)); }
      catch (error) { recoveries.push({ op, outcome: "unknown", detail: String(error) }); }
    }
    return recoveries;
  } finally {
    await lock.release();
  }
}

async function recoverOne(op: Op, resend: boolean, lock: MoneyLock): Promise<Recovery> {
  let correlationId = op.correlationId;
  if (!correlationId) {
    if (!resend) return { op, outcome: "unknown", detail: "No operation id; acceptance is unknown. Automatic replay is disabled." };
    try {
      correlationId = (await send({ method: methodOf(op), request: op.request } as Action, op.idempotencyKey, lock)).correlation_id;
      record({ idempotencyKey: op.idempotencyKey, correlation_id: correlationId, status: "SENT" });
    } catch (error) {
      const code = provenRefusal(error);
      if (!code) return { op, outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
      record({ idempotencyKey: op.idempotencyKey, refused: code });
      return { op, outcome: "refused", detail: code };
    }
  }
  const { status } = await api.getStatus(correlationId, { signal: AbortSignal.timeout(30_000) });
  if (status !== op.status) record({ idempotencyKey: op.idempotencyKey, correlation_id: correlationId, status });
  return { op, outcome: FINAL.has(status) ? "settled" : status === "UNCERTAIN" || status === "NEEDS_REVIEW" ? "unknown" : "pending", status, ...(isMoving(status) && { detail: "still moving" }) };
}

/** Status-only maintenance, independent of strategy execution. */
export function startReconciliation(everyMs = 10_000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await recover(); }
    catch (error) { console.error("Reconciliation deferred:", String(error)); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
