import { gatewayQueries } from "../../app/queries";
import { useQuery } from "@tanstack/react-query";

import { CopyButton, QueryError } from "../../shared/ui";
import { BASE } from "../../shared/client";

/** The configured intake, never an assumed host or an invitation claiming permission. */
export function InvoicePageLink({ next = false, demo = false }: { next?: boolean; demo?: boolean }) {
  const gateway = useQuery(gatewayQueries.session);
  const agent = gateway.data?.agents.find(agent => BASE === `/a/${agent.name}`);
  const invoices = agent?.invoices !== undefined ? agent.invoices : gateway.data?.invoices;
  if (gateway.error) return <QueryError error={gateway.error} retry={() => gateway.refetch()} />;
  if (!invoices) return <p className="text-sm text-muted-foreground">This agent's invoice page address is not configured here.</p>;
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    {next && <p className="w-full">Next: share the invoice page with the agreed payee.</p>}
    <a className={next ? "inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 font-medium hover:bg-accent" : "underline"} href={invoices} target="_blank" rel="noopener noreferrer">{demo ? "Open separate invoice demo" : "Open invoice page"}</a>
    <CopyButton text={invoices} /> <span>Copy and share with the payee, who signs in with their own account.</span>
  </div>;
}
