import { accessDenied } from "../../shared/read-failure";
import { useAgent } from "../../app/agent-context";
import { ConfirmButton } from "../owner/confirm-button";

import { useQuery } from "@tanstack/react-query";

import { ago, client, fromUnits, queries, useAttempt } from "../../shared/lib";

import { useIsOperator } from "../../app/viewer";
import { refusalText } from "../../shared/words";

import { Badge, Card, Details, Section } from "../../shared/ui";

/**
 * Money actions without a proven outcome. Each blocks every new one, so the agent waits until they
 * are resolved. Recovery only reads statuses; ambiguous replay is blocked.
 */
export function InvoiceReview() {
  const operator = useIsOperator();
  const { setup } = useAgent();
  const invoices = useQuery({ ...queries.invoices, enabled: operator, refetchInterval: 15_000 });
  const { error, attempt } = useAttempt();
  if (!operator) return <Section title="Invoices" description="Invoice administration is available to operators on the instance retaining the records."><p className="text-sm">Members can review held payouts and their payment outcomes above.</p></Section>;
  return <Section title="Invoices" description="Each invoice keeps one payment identity. Changed details require review and never replace a payment already submitted.">
    {invoices.isPending && <p role="status">Loading invoice records…</p>}
    {invoices.isSuccess && !invoices.data.length && <p className="text-sm text-muted-foreground">No invoices are recorded on this instance. Held payouts may originate on another executor.</p>}
    {(error || invoices.error) && <p className="text-sm text-warning-muted-foreground">{error ?? invoices.error?.message}</p>}
    {!accessDenied(invoices.error) && invoices.data?.map((invoice) => <Card key={invoice.id}>
      <div className="flex flex-wrap justify-between gap-2">
        <span>{invoice.payee} · {fromUnits(invoice.amount, 6)} USDC</span>
        <Badge tone={invoice.operation.status === "SUCCESS" ? "success" : "warning"}>
          {invoice.operation.refused ? <span title={invoice.operation.refused}>refused · {refusalText(invoice.operation.refused)}</span> : invoice.operation.status ?? "unknown"}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">Reserved: {fromUnits(invoice.reservation, 6)} USDC · Filed {ago(invoice.at)}</p>
      {invoice.revisions.map((r) => <p key={r.revision} className="text-sm">
        Revision {r.revision}: {fromUnits(r.amount, 6)} USDC{r.note ? ` · ${r.note}` : ""}{r.review ? " · Needs review; original payment unchanged" : ""}
      </p>)}
      <Details summary="Identifiers and cancellation">
        <p className="break-all font-mono text-xs text-muted-foreground">Invoice {invoice.id}<br />Payment {invoice.operation.idempotencyKey}</p>
        {invoice.operation.submissionState === "PREPARED" && <div><ConfirmButton
          disabled={setup.executor === false || Boolean(invoices.error)} label="Cancel unsubmitted invoice" title="Cancel this unsubmitted invoice?"
          description="This payment has never been submitted. Its reservation will be released. Its identity and revisions will remain in the records."
          confirm="Cancel invoice" onConfirm={() => attempt(() => client.cancelPreparedInvoice({ id: invoice.id }))} /></div>}
      </Details>
    </Card>)}
  </Section>;
}
