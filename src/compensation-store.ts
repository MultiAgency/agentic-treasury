import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { approvedCompensation, agreementCommand, agreementRecord, reportCommand, requestRecord, reviewCommand,
  type CompensationAgreement, type CompensationRequest, type CompensationView } from "./compensation-contract.js";
import type { z } from "zod";

export class CompensationError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
function refuse(code: string, message: string): never { throw new CompensationError(code, message); }

function database<T>(run: (db: DatabaseSync) => T): T {
  const agent = process.env.AGENT_ID;
  if (!agent || !/^[a-zA-Z0-9_-]+$/.test(agent)) throw new Error("Agent identity unavailable");
  const file = join(".invoices", `${agent}.compensation.sqlite`);
  const marker = `${file}.initialized`;
  if (!existsSync(file) && existsSync(marker)) throw new Error("Compensation database missing; restore its original state");
  mkdirSync(".invoices", { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    // Install the wait before even inspecting schema: another review may be committing now.
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    chmodSync(file, 0o600);
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version > 1) throw new Error("Compensation schema requires a newer build");
    if (existsSync(marker) && version !== 1) throw new Error("Initialized compensation schema is missing; restore its original database");
    if (existsSync(marker)) {
      for (const table of ["agreements", "requests", "history", "commands"]) {
        if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error("Compensation records are incomplete; restore the original database");
      }
    }
    if (version === 0) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS agreements(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(sequence INTEGER PRIMARY KEY, actor TEXT NOT NULL, command TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, actor TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
    if (!existsSync(marker)) writeFileSync(marker, "Preserve and restore the compensation database.\n", { mode: 0o600, flush: true });
    return run(db);
  } finally { db.close(); }
}
const rows = (db: DatabaseSync, table: "agreements" | "requests") => db.prepare(`SELECT record FROM ${table}`).all().map(r => JSON.parse(String(r.record)) as unknown);
function agreements(db: DatabaseSync) { return rows(db, "agreements").map(r => agreementRecord.parse(r)); }
function requests(db: DatabaseSync) { return rows(db, "requests").map(r => requestRecord.parse(r)); }
function approved(db: DatabaseSync, agreement: CompensationAgreement) {
  return requests(db).filter(r => r.report.agreementId === agreement.id && r.state === "approved")
    .reduce((total, r) => total + BigInt(approvedCompensation(r)), BigInt(agreement.terms.openingApproved));
}
export function compensationList(payee?: string): CompensationView {
  return database(db => {
    const terms = agreements(db), submissions = requests(db);
    for (const r of submissions) {
      const a = terms.find(a => a.id === r.report.agreementId);
      if (!a || a.terms.payee !== r.payee || a.version < r.agreementVersion) throw new Error("Compensation agreement evidence is incomplete; restore and review records");
    }
    return {
    agreements: agreements(db).filter(a => !payee || a.terms.payee === payee).map(a => {
      const total = approved(db, a), remaining = BigInt(a.terms.ceiling) - total;
      if (remaining < 0n) throw new Error("Compensation accounting conflicts; restore and review records");
      return { ...a, approved: total.toString(), remaining: remaining.toString() };
    }), requests: requests(db).filter(r => !payee || r.payee === payee).sort((a, b) => b.at.localeCompare(a.at)),
    };
  });
}

function mutate<T>(actor: string, input: { commandId: string }, run: (db: DatabaseSync) => T): T {
  if (!actor) throw new Error("Authenticated actor required");
  return database(db => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const serialized = JSON.stringify(input);
      const prior = db.prepare("SELECT * FROM commands WHERE id=?").get(input.commandId);
      if (prior) {
        if (prior.actor !== actor || prior.input !== serialized) refuse("command_conflict", "This command identity has different content. Read the current record.");
        db.exec("COMMIT"); return JSON.parse(String(prior.output)) as T;
      }
      const output = run(db);
      db.prepare("INSERT INTO commands VALUES(?,?,?,?)").run(input.commandId, actor, serialized, JSON.stringify(output));
      db.prepare("INSERT INTO history(actor,command,record) VALUES(?,?,?)").run(actor, serialized, JSON.stringify(output));
      db.exec("COMMIT"); return output;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}
function save(db: DatabaseSync, table: "agreements" | "requests", record: { id: string }) {
  db.prepare(`INSERT INTO ${table} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record`).run(record.id, JSON.stringify(record));
}

export function recordCompensationAgreement(actor: string, raw: z.infer<typeof agreementCommand>) {
  const c = agreementCommand.parse(raw);
  return mutate(actor, c, db => {
    const previous = agreements(db).find(a => a.id === c.id);
    if (requests(db).some(r => r.id === c.id)) refuse("identity_conflict", "This identity already belongs to a payment request.");
    if ((previous?.version ?? 0) !== c.expectedVersion) refuse("stale_agreement", "The agreement changed. Refresh and review its current terms.");
    if (previous && (previous.terms.payee !== c.terms.payee || previous.terms.start !== c.terms.start || previous.terms.end !== c.terms.end || previous.terms.openingApproved !== c.terms.openingApproved))
      refuse("immutable_agreement", "Recipient, period and opening approved compensation cannot change. Record a separate agreement for different work.");
    const next: CompensationAgreement = { id: c.id, version: c.expectedVersion + 1, terms: c.terms, recordedBy: actor, at: new Date().toISOString() };
    if (approved(db, next) > BigInt(next.terms.ceiling)) refuse("ceiling_exceeded", "The ceiling cannot be below already approved compensation.");
    save(db, "agreements", next); return next;
  });
}

export function saveCompensationRequest(payee: string, raw: z.infer<typeof reportCommand>) {
  const c = reportCommand.parse(raw);
  return mutate(payee, c, db => {
    const old = requests(db).find(r => r.id === c.id);
    if (agreements(db).some(a => a.id === c.id)) refuse("identity_conflict", "Use a request identity separate from the agreement.");
    if (old && old.payee !== payee) refuse("not_found", "Request not found.");
    if ((old?.version ?? 0) !== c.expectedVersion) refuse("stale_request", "The request changed. Refresh its current version before editing.");
    if (old && !["draft", "changes_requested"].includes(old.state)) refuse("request_locked", "Only a draft or returned request can be revised.");
    if (!old && (requests(db).filter(r => r.payee === payee && !["approved", "declined"].includes(r.state)).length >= 20 || requests(db).length >= 2000))
      refuse("intake_full", "The request queue is full. Review existing requests or contact the owner.");
    const agreement = agreements(db).find(a => a.id === c.report.agreementId && a.terms.payee === payee);
    if (!agreement) refuse("not_found", "Agreement not found.");
    if (old && old.report.agreementId !== agreement.id) refuse("agreement_changed", "A request must retain its original agreement.");
    if (c.report.start < agreement.terms.start || c.report.end > agreement.terms.end) refuse("outside_period", "The report period must fit the agreement period.");
    const next: CompensationRequest = { id: c.id, version: c.expectedVersion + 1, payee, agreementVersion: agreement.version,
      ...(old ? old.payoutMode && { payoutMode: old.payoutMode } : { payoutMode: "isolated" as const }),
      report: c.report, state: c.submit ? "submitted" : "draft", feedback: old?.feedback ?? "", reviewedBy: null, payment: null, at: new Date().toISOString() };
    save(db, "requests", next); return next;
  });
}

export function reviewCompensationRequest(actor: string, raw: z.infer<typeof reviewCommand>) {
  const c = reviewCommand.parse(raw);
  return mutate(actor, c, db => {
    const request = requests(db).find(r => r.id === c.id);
    if (!request) refuse("not_found", "Request not found.");
    if (request.version !== c.expectedVersion) refuse("stale_request", "The request changed. Review its current version.");
    if (request.state !== "submitted") refuse("request_locked", "Only a submitted request can be reviewed.");
    const agreement = agreements(db).find(a => a.id === request.report.agreementId);
    if (!agreement || agreement.terms.payee !== request.payee) refuse("agreement_unavailable", "Agreement evidence is unavailable.");
    let amount: string | undefined;
    if (c.decision !== "approved" && c.approvedAmount) refuse("invalid_review", "Compensation is recorded only with approval.");
    if (c.decision === "approved") {
      amount = c.approvedAmount ?? request.report.amount;
      if (!amount) refuse("amount_required", "Set the compensation amount before approving this report.");
      if ((!request.report.amount || amount !== request.report.amount) && !c.feedback)
        refuse("explanation_required", "Provide an explanation for the approved compensation.");
      if (agreement.version !== request.agreementVersion) refuse("stale_agreement", "Terms changed since submission. Return the request for resubmission under the current agreement.");
      if (approved(db, agreement) + BigInt(amount) > BigInt(agreement.terms.ceiling)) refuse("ceiling_exceeded", "This request exceeds the remaining agreement ceiling.");
    }
    const next: CompensationRequest = { ...request, version: request.version + 1, state: c.decision, ...(amount && { approvedAmount: amount }), feedback: c.feedback, reviewedBy: actor, at: new Date().toISOString() };
    save(db, "requests", next); return next;
  });
}

export function compensationHistory(payee?: string) {
  return database(db => db.prepare("SELECT sequence,actor,record FROM history ORDER BY sequence").all().flatMap(r => {
    const record = JSON.parse(String(r.record)) as CompensationRequest | CompensationAgreement;
    const recipient = "payee" in record ? record.payee : record.terms.payee;
    return !payee || recipient === payee ? [{ sequence: Number(r.sequence), actor: String(r.actor), record }] : [];
  }));
}

/** Bind before crossing into invoice/order storage. Retrying always reopens this same identity. */
export function bindCompensationPayment(actor: string, c: { commandId: string; id: string; expectedVersion: number; mode: "shared" | "isolated"; until?: string }) {
  return mutate(actor, c, db => {
    const r = requests(db).find(r => r.id === c.id);
    if (!r) refuse("not_found", "Request not found.");
    if (r.payment) {
      if (r.payment.mode !== c.mode) refuse("payment_bound", "This request already uses another payment path.");
      if (r.payment.until !== c.until) refuse("payment_bound", "The retained order deadline cannot change. Reopen its original preparation.");
      return r;
    }
    if (r.version !== c.expectedVersion || r.state !== "approved") refuse("stale_request", "Refresh the approved request before preparing payment.");
    approvedCompensation(r);
    if ((r.payoutMode === "isolated" || !r.report.amount) && c.mode !== "isolated") refuse("isolated_required", "This submission requires its isolated payout.");
    if (c.mode === "isolated" && (!c.until || !Number.isFinite(Date.parse(c.until)) || Date.parse(c.until) <= Date.now() || Date.parse(c.until) > Date.now() + 365 * 86400000)) refuse("invalid_deadline", "Choose a future payment deadline within 365 days.");
    const next: CompensationRequest = { ...r, version: r.version + 1, payment: { mode: c.mode, id: r.id, ...(c.until && { until: c.until }) }, at: new Date().toISOString() };
    save(db, "requests", next); return next;
  });
}
