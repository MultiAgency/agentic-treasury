import { ArrowSquareOut, ChartPieSlice, HandCoins, LockSimple, Receipt } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { PublicProposal, PublicView } from "../../src/gateway/public.js";
import { PROTOTYPES } from "./beats";
import { ago, gw } from "./lib";
import { SignIn } from "./session";
import { Badge, Card, Section, Spinner, type Tone } from "./ui";

/**
 * The page for anyone not signed in: only what the DAO's contract shows on chain. The treasury is
 * confidential, so its balances, payments and agents are for members, after signing in.
 */

const STATUS: Record<string, Tone> = { Approved: "success", InProgress: "info", Rejected: "destructive", Removed: "neutral", Expired: "neutral" };

/** Proposal descriptions are Trezu's markup: line breaks as `<br>`. Shown as text, never as HTML. */
const plain = (description: string) => description.replace(/\s*<br\s*\/?>\s*/g, "\n");

function Proposal({ p }: { p: PublicProposal }) {
  return (
    <li className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">#{p.id}</span>
        <span className="flex-1">{p.action}</span>
        <Badge tone={STATUS[p.status] ?? "neutral"}>{p.status}</Badge>
      </div>
      <p className="text-sm break-words whitespace-pre-line">{plain(p.description)}</p>
      <div className="text-sm text-muted-foreground">
        Filed by {p.proposer} {ago(p.submittedAt)}
        {Object.keys(p.votes).length > 0 &&
          ` · ${Object.entries(p.votes)
            .map(([account, vote]) => `${account}: ${vote}`)
            .join(", ")}`}
      </div>
      {p.hash && <p className="font-mono text-xs break-all text-muted-foreground">signs {p.hash}</p>}
    </li>
  );
}

export function PublicHome({ dao, invoices }: { dao: string; invoices: string | null }) {
  const view = useQuery({
    queryKey: ["gw", "public"],
    queryFn: () => gw<PublicView>("/gw/public"),
    refetchInterval: 60_000,
  });
  const d = view.data;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 p-4 sm:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold">{dao}</h1>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <LockSimple size={16} className="mt-0.5 shrink-0" />
          <span>
            A confidential treasury run by two agents this DAO owns, each a prototype below. Every owner action, from creating an agent to
            changing its rules, is a proposal the council votes on. Balances, payments, swaps and the agents' rules are visible to members
            only. Further down is everything the DAO's contract shows to anyone, read from chain.
          </span>
        </p>
        <a
          className="inline-flex w-fit items-center gap-1 text-sm underline hover:text-foreground"
          href={`https://nearblocks.io/address/${dao}`}
          target="_blank"
          rel="noreferrer"
        >
          Check it on a block explorer <ArrowSquareOut size={14} />
        </a>
      </header>

      {/* Names and what each does, never data: this page shows nothing the chain doesn't. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {([["facilitator", HandCoins], ["treasury", ChartPieSlice]] as const).map(([kind, Icon]) => (
          <Card key={kind}>
            <div className="flex items-center gap-3">
              <Icon size={20} />
              <h2 className="text-xl font-semibold">{PROTOTYPES[kind].name}</h2>
            </div>
            <p className="text-sm text-muted-foreground">{PROTOTYPES[kind].tagline}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SignIn dao={dao} />
        {invoices && (
          <Card>
            <div className="flex flex-col gap-2">
              <h2 className="text-xl font-semibold">Get paid</h2>
              <p className="text-sm text-muted-foreground">
                Anyone can ask the DAO to pay them, signed in with their NEAR account. An agreed payee files an invoice; anyone else
                files a request the DAO answers.
              </p>
            </div>
            <a
              className="inline-flex h-11 w-fit items-center gap-2 rounded-full border px-5 font-medium hover:bg-muted"
              href={invoices}
            >
              <Receipt size={16} /> Request a payment
            </a>
          </Card>
        )}
      </div>

      {view.error ? (
        <p className="text-sm text-destructive-muted-foreground">{view.error.message}</p>
      ) : !d ? (
        <Spinner />
      ) : (
        <>
          <Section title="Council" description="The DAO's roles and who holds them.">
            <Card>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {d.roles.map((r) => (
                  <div key={r.name} className="contents">
                    <dt className="text-muted-foreground">{r.name}</dt>
                    <dd className="break-all">{r.members.join(", ") || "nobody"}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </Section>
          <Section
            title="Proposals"
            description="The DAO's latest proposals as its contract records them. A confidential payment shows only that it happened; a signature shows only its hash."
          >
            <Card>
              <ul className="flex flex-col divide-y">
                {d.proposals.map((p) => (
                  <Proposal key={p.id} p={p} />
                ))}
              </ul>
            </Card>
          </Section>
        </>
      )}
    </div>
  );
}
