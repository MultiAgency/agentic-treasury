import { DownloadSimple } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ago, amount, client, describeRequest, fromUnits, queries, useAttempt } from "./lib";
import { useIsOperator } from "./viewer";
import { useAgent } from "./shell";
import { Badge, Button, Card, ConfirmButton, ErrorBox, Section, Spinner, statusTone } from "./ui";

/**
 * Money actions without a proven outcome. Each blocks every new one, so the agent waits until they
 * are resolved. Recovery only reads statuses; ambiguous replay is blocked.
 */
export function Unresolved() {
  const { data = [] } = useQuery(queries.unresolved);
  const { busy, message, error, attempt } = useAttempt();
  if (data.length === 0 && !message && !error) return null;

  const run = () =>
    attempt(async () => {
      const counts = new Map<string, number>();
      for (const { outcome } of await client.recover()) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
      return [...counts].map(([outcome, n]) => `${n} ${outcome}`).join(" · ") || "Nothing left to resolve.";
    });

  return (
    <Section
      title="Unresolved"
      description="Money actions whose outcome isn't known yet. The agent sends nothing new until each is resolved."
    >
      <Card>
        <ul className="flex flex-col divide-y">
          {data.map((op) => (
            <li key={op.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm first:pt-0 last:pb-0">
              <span className="whitespace-nowrap text-muted-foreground sm:w-32">{ago(op.at)}</span>
              <span className="w-20 font-medium capitalize">{op.kind}</span>
              <span className="flex-1 font-mono text-xs text-muted-foreground">{op.key}</span>
              <Badge tone="warning">{op.sent ? (op.status?.toLowerCase() ?? "sent") : op.status === "PREPARED" ? "prepared, never submitted" : "submission outcome unknown"}</Badge>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-end gap-3 pt-4">
          {message && <span className="mr-auto text-sm text-muted-foreground">{message}</span>}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run()}>
            {busy && <Spinner />} Check status
          </Button>
          <span className="text-xs text-muted-foreground">Replay is blocked. Missing operation IDs require review; they do not prove a payment was unsent.</span>
        </div>
        <ErrorBox error={error} />
      </Card>
    </Section>
  );
}

/** Payment identity, reserved amount and revisions, read from the executor's authoritative store. */
export function InvoiceReview() {
  const operator = useIsOperator();
  const invoices = useQuery({ queryKey: ["invoices"], queryFn: () => client.invoices(), enabled: operator, refetchInterval: 15_000 });
  const { error, attempt } = useAttempt();
  if (!operator || (!invoices.error && !invoices.data?.length)) return null;
  return <Section title="Invoices" description="Each invoice keeps one payment identity. Changed details require review and never replace a payment already submitted.">
    {(error || invoices.error) && <p className="text-sm text-warning-muted-foreground">{error ?? invoices.error?.message}</p>}
    {invoices.data?.map((invoice) => <Card key={invoice.id}>
      <div className="flex flex-wrap justify-between gap-2">
        <span>{invoice.payee} · {fromUnits(invoice.amount, 6)} USDC</span>
        <Badge tone={invoice.operation.status === "SUCCESS" ? "success" : "warning"}>
          {invoice.operation.refused ?? invoice.operation.status ?? "unknown"}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">Reserved: {fromUnits(invoice.reservation, 6)} USDC · Filed {ago(invoice.at)}</p>
      <p className="break-all font-mono text-xs text-muted-foreground">Invoice {invoice.id}<br />Payment {invoice.operation.idempotencyKey}</p>
      {invoice.revisions.map((r) => <p key={r.revision} className="text-sm">
        Revision {r.revision}: {fromUnits(r.amount, 6)} USDC{r.note ? ` · ${r.note}` : ""}{r.review ? " · Needs review; original payment unchanged" : ""}
      </p>)}
      {invoice.operation.submissionState === "PREPARED" && <ConfirmButton
        label="Cancel unsubmitted invoice" title="Cancel this unsubmitted invoice?"
        description="This payment has never been submitted. Its reservation will be released. Its identity and revisions will remain in the records."
        confirm="Cancel invoice" onConfirm={() => attempt(() => client.cancelPreparedInvoice({ id: invoice.id }))} />}
    </Card>)}
  </Section>;
}

/** Every action the agent sent, newest first; `limit` shows only the latest few, with a link to the rest. */
export function Activity({ limit }: { limit?: number }) {
  const { data: book } = useAgent();
  const { data = [] } = useQuery({ queryKey: ["activity"], queryFn: () => client.activity() });

  return (
    <Section
      title={limit ? "Recent activity" : "Activity"}
      description="Every action the agent sent, from the local ops log, newest first."
      action={
        limit &&
        data.length > limit && (
          <Link to="/activity" className="text-sm text-muted-foreground hover:text-foreground">
            View all {data.length}
          </Link>
        )
      }
    >
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No actions yet. Preview a rebalance to get started.</p>
      ) : (
        <ol className="flex flex-col">
          {data.slice(0, limit).map((op) => (
            <li key={`${op.at}-${op.kind}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b py-3 text-sm last:border-0">
              <span className="whitespace-nowrap text-muted-foreground sm:w-32">{ago(op.at)}</span>
              <span className="w-20 font-medium capitalize">{op.kind}</span>
              <span className="order-last basis-full tabular-nums sm:order-none sm:basis-0 sm:flex-1">{describeRequest(op.request, book.book)}</span>
              <span className="ml-auto">
                {op.refused ? (
                  // A probe exists to be refused; any other refusal means the policy stopped the agent.
                  // A probe refused for want of funds never reached the policy: it proves nothing.
                  <Badge tone={op.kind !== "refusal" ? "warning" : op.refused === "insufficient_balance" ? "neutral" : "success"}>
                    refused · <span className="font-mono">{op.refused}</span>
                  </Badge>
                ) : op.kind === "refusal" ? (
                  <Badge tone="destructive">passed · {op.status?.toLowerCase() ?? "unsettled"}</Badge>
                ) : (
                  <Badge tone={statusTone(op.status)}>{op.status?.toLowerCase() ?? "unsettled"}</Badge>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/** Saves the ledger the server builds (src/ledger.ts) as a CSV file. */
async function downloadLedger() {
  const csv = await client.ledgerCsv();
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: `ledger-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Public balances against indexed chain transfers, confidential balances against API executions.
 * A difference is unexplained: it can reflect outside credits or incomplete records.
 */
export function Books() {
  const { data: book } = useAgent();
  const books = useQuery({ queryKey: ["books"], queryFn: () => client.reconcileBooks() });
  const bySymbol = new Map(book.book.map((h) => [h.asset, h]));
  const value = (raw: string, asset: string) => {
    const h = bySymbol.get(asset);
    return h ? amount(raw, h) : raw;
  };

  return (
    <Section
      title="Books"
      description="Public balances checked against the chain, confidential ones against the API's recorded executions."
      action={
        <Button variant="outline" size="sm" onClick={downloadLedger}>
          <DownloadSimple size={16} /> Ledger CSV
        </Button>
      }
    >
      {books.error ? (
        <p className="text-sm text-warning-muted-foreground">{books.error.message}</p>
      ) : !books.data ? (
        <Spinner />
      ) : (
        <Card>
          <ul className="flex flex-col divide-y text-sm">
            {books.data.map((r) => (
              <li key={r.asset} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <span className="font-medium">{r.symbol}</span>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">Public {value(r.public.api, r.asset)}</span>
                  <Badge tone={r.public.drift === "0" ? "success" : "destructive"}>
                    {r.public.drift === "0" ? "matches the chain" : `differs from the chain by ${value(r.public.drift, r.asset)}`}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">Confidential {value(r.confidential.api, r.asset)}</span>
                  <Badge tone={r.confidential.unattributed === "0" ? "success" : "warning"}>
                    {r.confidential.unattributed === "0"
                      ? "matches recorded executions"
                      : `${value(r.confidential.unattributed, r.asset)} unexplained difference`}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Section>
  );
}
