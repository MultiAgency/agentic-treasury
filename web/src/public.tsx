import { SignIn } from "./app/session";

export type Demo = "showcase" | "payables" | "treasury" | "invoices";
export const publicDemo = (host: string): Demo | undefined => ({
  "proto.multiagency.ai": "showcase", "payables.multiagency.ai": "payables",
  "treasury.multiagency.ai": "treasury", "invoices.multiagency.ai": "invoices",
} as Record<string, Demo>)[host];
const briefs = [
  { demo: "payables", title: "SputnikDAO Confidential Treasury Facilitator", description: "An outside requester files an invoice. A confidential payout to an agreed payee waits for approval from a regular NEAR wallet owner or a DAO through its voting process. A new payee needs a separately signed agreement.", status: "Existing payout flow; requirement coverage and limits remain documented separately.", link: "https://payables.multiagency.ai", action: "Open Payables" },
  { demo: "treasury", title: "Agentic Treasury Management", description: "Delegate quoted rebalancing and confidential sweeps within an owner-signed policy and strategy-bound grant. Review each operation’s recorded outcome.", status: "Existing Treasury flow; spending caps do not guarantee investment performance.", link: "https://treasury.multiagency.ai", action: "Open Treasury" },
  { demo: "invoices", title: "Invoicing & Purchase-Order Management", description: "Give each work order its own agent, one supplier, a fixed invoice and an expiring grant. Follow that exact payment through owner approval and its recorded outcome.", status: "Buyer flow implemented and tested offline, not observed on mainnet. Supplier conversion and forwarding are not implemented.", link: "https://payables.multiagency.ai/workspace", action: "Open work orders in Payables" },
] as const;

/** Static catalog: no private records, requests, evidence records or inferred completion. */
export function PublicHome({ daos, selfService = false, demo, entry = false }: { daos: string[]; invoices?: string | null; selfService?: boolean; demo?: Demo; entry?: boolean }) {
  const selected = briefs.find(brief => brief.demo === demo);
  return <main id="public-main" tabIndex={-1} className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-4 py-12 sm:px-8">
    <header className="flex flex-col gap-4">
      <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{demo === "treasury" ? "Your agency Treasury" : demo === "payables" ? "Your confidential payments and work orders" : selected?.title ?? (demo === "showcase" ? "Three ideas. Owner-signed authority." : "Agentic Treasury")}</h1>
      <p className="max-w-prose text-lg text-muted-foreground">{demo === "treasury" ? "Rebalance your portfolio, review confidential payables and manage isolated work orders in one owner workspace. Each agent keeps its own policy, grant, balance and executor." : demo === "payables" ? "Manage confidential invoice intake, agreements and owner-approved payouts, plus purchase orders with isolated agents, supplier invoices and payment tracking." : selected?.description ?? "Explore three prototypes built using the NEAR Intents Agent API: confidential payables, delegated Treasury management and isolated work orders."}</p>
      <p className="text-sm text-muted-foreground">All three workflows support a regular NEAR account or a Sputnik DAO as owner. These demos use real funds on mainnet. The owner signs the policy and grants; money actions retain their explicit confirmations and approvals.</p>
      {selected && <p className="text-sm text-muted-foreground">{selected.status}</p>}
      {demo === "payables" && <p className="text-sm text-muted-foreground">Work orders are tested offline, not observed on mainnet. Supplier conversion and forwarding remain unimplemented.</p>}
    </header>
    {demo === "showcase" && <nav aria-label="Prototype demos"><ol className="divide-y">{briefs.map((brief, i) => <li key={brief.demo} className="flex flex-col gap-3 py-6">
      <h2 className="text-xl font-semibold">{String(i + 1).padStart(2, "0")} · {brief.title}</h2>
      <p className="max-w-prose text-muted-foreground">{brief.description}</p>
      <p className="text-sm text-muted-foreground">{brief.status}</p>
      <a className="inline-flex min-h-11 w-fit items-center underline underline-offset-4" href={`/${brief.demo}`}>Full walkthrough</a>
      <a className="inline-flex min-h-11 w-fit items-center underline underline-offset-4" href={brief.link}>{brief.action}</a>
    </li>)}</ol></nav>}
    {demo === "showcase" && <a className="inline-flex min-h-11 w-fit items-center underline underline-offset-4" href="/demos">Short demos</a>}
    {entry ? <a className="inline-flex min-h-11 w-fit items-center underline underline-offset-4" href="/workspace">{demo === "showcase" ? "Open the owner workspace" : "Sign in to the owner demo"}</a> : <SignIn daos={daos} selfService={selfService} />}
    {(demo === "invoices" || demo === "payables" || demo === "showcase") && <a className="inline-flex min-h-11 w-fit items-center underline underline-offset-4" href="https://invoices.multiagency.ai">Supplier: submit or review your invoice</a>}
    {selected && <a className="inline-flex min-h-11 w-fit items-center text-sm underline underline-offset-4" href="https://proto.multiagency.ai">Explore all three ideas</a>}
  </main>;
}
