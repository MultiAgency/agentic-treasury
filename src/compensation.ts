import { z } from "zod";
import { approvedCompensation, compensationCommand, compensationSend, ownerCompensationView } from "./compensation-contract.js";
import { bindCompensationPayment, compensationList, compensationHistory, CompensationError, recordCompensationAgreement, reviewCompensationRequest } from "./compensation-store.js";
import { agentId, executes } from "./env.js";
import { prepareInvoice, getInvoice, invoiceId } from "./invoice-store.js";
import { file } from "./invoices.js";
import { ASSETS } from "./policy.js";
import { localWorkOrders } from "./work-orders.js";
import type { ReviewedPolicy } from "./mandate.js";

export const compensationOwnerCommand = z.discriminatedUnion("type", [
  ...compensationCommand.options,
  compensationSend,
]);
type Command = z.infer<typeof compensationOwnerCommand>;
const invoiceOf = (r: ReturnType<typeof compensationList>["requests"][number]) => ({ payee: r.payee, submission: r.id, amount: approvedCompensation(r), note: `Compensation request ${r.id}` });

export async function localCompensation(parent: string, actor: string, raw: Command) {
  if (parent !== agentId() || !executes()) throw new Error("Use the configured payout executor for compensation review.");
  const c = compensationOwnerCommand.parse(raw);
  if (c.type === "agreement") recordCompensationAgreement(actor, c.command);
  if (c.type === "review") reviewCompensationRequest(actor, c.command);
  if (c.type === "prepare") {
    const previous = compensationList().requests.find(r => r.id === c.command.id);
    if (previous && !previous.payment && c.command.mode === "shared" && getInvoice(invoiceId(invoiceOf(previous))))
      throw new Error("This invoice identity already exists outside this request's preparation. Review its existing payment; do not link or replace it automatically.");
    const r = bindCompensationPayment(actor, c.command);
    if (c.command.mode === "shared") prepareInvoice(invoiceOf(r), ASSETS.USDC);
    else {
      await localWorkOrders(parent, { type: "create", input: { id: r.id, payee: r.payee, amount: approvedCompensation(r), note: invoiceOf(r).note, until: r.payment!.until! } });
    }
  }
  if (c.type === "send") {
    const r = compensationList().requests.find(r => r.id === c.id);
    if (!r || r.state !== "approved" || r.payment?.mode !== "shared") throw new Error("Prepare this approved request's shared payment first.");
    const invoice = getInvoice(invoiceId(invoiceOf(r)));
    if (!invoice) throw new Error("Payment preparation is incomplete. Reopen its retained preparation before sending.");
    const result = await file(invoiceOf(r), r.payee, c.expectedPolicy as ReviewedPolicy);
    if (result.status === "needs_agreement") throw new CompensationError("payee_not_agreed", "The contributor is not yet an agreed payee in the signed policy. Complete the existing owner policy-inclusion flow, then reopen this payment.");
    if (result.status === "refused") throw new CompensationError(result.code ?? "refused", "Payment was not submitted: Proto's checks refused it before sending. Resolve the cause, then send this retained payment again.");
    if (result.status === "busy") throw new CompensationError("executor_busy", "Payment was not submitted by this call. Review the executor's existing operations before retrying this retained payment.");
  }
  const view = compensationList();
  return { ...view, history: compensationHistory(), payments: view.requests.flatMap(r => {
    if (r.payment?.mode !== "shared") return [];
    const invoice = getInvoice(invoiceId(invoiceOf(r)));
    return [{ requestId: r.id, invoiceId: invoiceId(invoiceOf(r)), status: invoice?.operation.status ?? "PREPARATION_INCOMPLETE", correlationId: invoice?.operation.correlationId ?? null, refused: invoice?.operation.refused ?? null }];
  }) };
}
export type CompensationOwnerView = Awaited<ReturnType<typeof localCompensation>>;

/** Same configured bridge as agreements; the browser never receives this credential. */
export async function ownerCompensation(actor: string, command: Command): Promise<CompensationOwnerView> {
  const { AGREEMENTS_URL, AGREEMENTS_SECRET, INVOICES_PORT } = process.env;
  if (!INVOICES_PORT && AGREEMENTS_URL && AGREEMENTS_SECRET) {
    const response = await fetch(new URL("/internal/compensation", AGREEMENTS_URL), { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${AGREEMENTS_SECRET}` },
      body: JSON.stringify({ parentAgentId: agentId(), actor, command }), signal: AbortSignal.timeout(210_000) });
    const body = await response.json().catch(() => ({})) as { result?: unknown; error?: string; code?: string };
    // Only the executor's coded refusal is rebuilt; any other failure may follow a send and stays uncertain.
    if (response.status === 400 && typeof body.code === "string" && body.error) throw new CompensationError(body.code, body.error);
    if (!response.ok) throw new Error(body.error ?? "Review unavailable. Read the existing request before retrying.");
    return ownerCompensationView.parse(body.result);
  }
  return localCompensation(agentId(), actor, command);
}
