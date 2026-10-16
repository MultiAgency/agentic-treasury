import { z } from "zod";

export const requestId = z.uuid();
const account = z.string().regex(/^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/);
export const atomicUsdc = z.string().regex(/^[1-9][0-9]{0,17}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const date = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
}, "Enter a real calendar date");
const https = z.url().max(1000).refine(s => { const u = new URL(s); return u.protocol === "https:" && !u.username && !u.password; }, "Use an HTTPS link without credentials");
export const compensationTerms = z.object({
  payee: account, title: z.string().trim().min(1).max(160), document: https,
  signedOn: day, start: day, end: day, ceiling: atomicUsdc,
  openingApproved: z.string().regex(/^(0|[1-9][0-9]{0,17})$/), scope: z.string().trim().max(2000),
}).strict().refine(t => t.start <= t.end, "The period end must follow its start")
  .refine(t => BigInt(t.openingApproved) <= BigInt(t.ceiling), "Previously approved compensation exceeds the ceiling");
export const compensationReport = z.object({
  agreementId: requestId, amount: atomicUsdc.optional(), start: day, end: day,
  contributions: z.string().trim().min(1).max(4000), assessment: z.string().trim().min(1).max(2000),
  evidence: z.array(https).max(12),
}).strict().refine(t => t.start <= t.end, "The period end must follow its start")
  .refine(t => new TextEncoder().encode(JSON.stringify(t)).length <= 12_000, "Keep the report and links within 12 KB");
const mutation = { commandId: requestId, id: requestId, expectedVersion: z.number().int().nonnegative() };
export const paymentPreparation = z.object({ type: z.literal("prepare"), command: z.object({ ...mutation, mode: z.enum(["shared", "isolated"]), until: z.iso.datetime().optional() }).strict().refine(c => c.mode !== "isolated" || !!c.until, "Choose the isolated order's payment deadline") }).strict();
export const agreementCommand = z.object({ ...mutation, terms: compensationTerms }).strict();
export const reportCommand = z.object({ ...mutation, report: compensationReport, submit: z.boolean() }).strict();
export const reviewCommand = z.object({ ...mutation, decision: z.enum(["approved", "changes_requested", "declined"]), feedback: z.string().trim().max(2000), approvedAmount: atomicUsdc.optional() }).strict()
  .refine(c => c.decision === "approved" || c.feedback.length > 0, "Explain the feedback or decline");
export type CompensationTerms = z.infer<typeof compensationTerms>;
export type CompensationReport = z.infer<typeof compensationReport>;
export const agreementRecord = z.object({ id: requestId, version: z.number().int().positive(), terms: compensationTerms, recordedBy: z.string(), at: z.string() });
export const requestRecord = z.object({
  id: requestId, version: z.number().int().positive(), payee: account, agreementVersion: z.number().int().positive(),
  report: compensationReport, state: z.enum(["draft", "submitted", "changes_requested", "approved", "declined"]),
  payoutMode: z.literal("isolated").optional(), approvedAmount: atomicUsdc.optional(),
  feedback: z.string(), reviewedBy: z.string().nullable(), at: z.string(),
  payment: z.object({ mode: z.enum(["shared", "isolated"]), id: requestId, until: z.iso.datetime().optional() }).nullable().default(null),
});
/** Legacy approved invoices retain their original amount; new reports record owner compensation. */
export function compensationAmount(request: CompensationRequest): string | undefined {
  return request.approvedAmount ?? request.report.amount;
}
export function approvedCompensation(request: CompensationRequest): string {
  const amount = compensationAmount(request);
  if (request.state !== "approved" || !amount || (request.payoutMode === "isolated" && !request.approvedAmount)) throw new Error("Approved compensation evidence is missing; restore and review the original record.");
  return amount;
}
export type CompensationAgreement = z.infer<typeof agreementRecord>;
export type CompensationRequest = z.infer<typeof requestRecord>;
export type CompensationView = { agreements: (CompensationAgreement & { approved: string; remaining: string })[]; requests: CompensationRequest[] };
export const compensationView = z.object({ agreements: z.array(agreementRecord.extend({ approved: z.string().regex(/^\d+$/), remaining: z.string().regex(/^\d+$/) })), requests: z.array(requestRecord) });
export const ownerCompensationView = compensationView.extend({ history: z.array(z.object({ sequence: z.number(), actor: z.string(), record: z.union([requestRecord, agreementRecord]) })), payments: z.array(z.object({ requestId: z.uuid(), invoiceId: z.string(), status: z.string(), correlationId: z.string().nullable(), refused: z.string().nullable() })) });
export const compensationCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("agreement"), command: agreementCommand }).strict(),
  z.object({ type: z.literal("review"), command: reviewCommand }).strict(),
  paymentPreparation,
]);
