import { api, checkedStatus, isMoving } from "./api.js";
import { acquireMoneyLock } from "./lock.js";
import { isResolved, type Method, type Op, readOps, record } from "./ops.js";
import { markInvoiceUnknown } from "./invoice-store.js";

/**
 * Resolves money actions left without a proven outcome (a crash, a lost response, an UNCERTAIN
 * status), always under their original idempotency key:
 * - with a correlation id, it reads the status once and records it. Reading is always safe, so
 *   anything may do it unattended, the autopilot included;
 * - without one, submission-attempted remains unknown. Even explicit replay is blocked until
 *   the provider's lookup and idempotency semantics are verified. Prepared invoice operations
 *   can be continued only by resubmitting the original invoice; they have never attempted I/O.
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

/** Polls only. `resend` is retained for older clients but cannot authorize an ambiguous replay. */
export async function recover({ resend = false } = {}): Promise<Recovery[]> {
  const lock = await acquireMoneyLock({ reconcile: true });
  try {
    const recoveries: Recovery[] = [];
    for (const op of unresolved()) {
      try { recoveries.push(await recoverOne(op, resend)); }
      catch (error) {
        if (op.invoiceId) markInvoiceUnknown(op.idempotencyKey);
        recoveries.push({ op, outcome: "unknown", detail: String(error) });
      }
    }
    return recoveries;
  } finally {
    await lock.release();
  }
}

async function recoverOne(op: Op, resend: boolean): Promise<Recovery> {
  const correlationId = op.correlationId;
  if (!correlationId) {
    if (op.submissionState === "PREPARED") return { op, outcome: "pending", status: "PREPARED", detail: "Never submitted. Resubmit the original invoice to continue with its existing key." };
    return { op, outcome: "unknown", detail: `${resend ? "Replay refused. " : ""}No operation id; acceptance is unknown. Provider deduplication is unverified; review required.` };
  }
  const { status } = checkedStatus(correlationId, await api.getStatus(correlationId, { signal: AbortSignal.timeout(30_000) }));
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
