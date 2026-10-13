import { ArrowRight, CheckCircle, Robot, WarningOctagon } from "@phosphor-icons/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Decoded } from "../../src/gateway/proposals.js";
import { ago, clientFor, fromUnits, gw, minutesSeconds, useCountdown, usd } from "./lib";
import { type Gateway, ViewerBadge } from "./session";
import { Badge, Card, Section, Spinner, type Tone } from "./ui";

/**
 * The hosted dashboard's home: what the council is being asked to sign, and the agents the DAO owns.
 * Agent data comes through the gateway, by the same calls each agent's own dashboard makes.
 */


const TYPE_WORDS: Record<string, string> = {
  agent_create: "Create the agent",
  grant_issue: "Issue a grant to the agent's server",
  grant_revoke: "Revoke a grant",
  agent_freeze: "Freeze the agent",
  agent_unfreeze: "Unfreeze the agent",
  policy_update: "Change the agent's policy",
  approval_vote: "Release or reject a held payment",
};

function Window({ expiresAt }: { expiresAt: string }) {
  const left = useCountdown(expiresAt) ?? 0;
  return left === 0 ? (
    <Badge tone="destructive">signing window closed</Badge>
  ) : (
    <Badge tone={left < 120 ? "warning" : "info"}>
      {minutesSeconds(left)} left to vote
    </Badge>
  );
}

const VERDICT: Record<Decoded["what"], [Tone, string]> = {
  agent: ["success", "Verified"],
  unknown: ["destructive", "Not prepared by this dashboard"],
  past: ["neutral", "Done"],
  trezu: ["neutral", "Trezu confidential payment"],
  other: ["warning", "Signs for another key"],
};

function Proposal({ p, dao }: { p: Decoded; dao: string }) {
  const [tone, label] =
    p.what !== "agent"
      ? VERDICT[p.what]
      : p.check.kind === "mismatch"
        ? (["destructive", "Hash doesn't match"] as const)
        : p.state === "expired"
          ? (["neutral", "Window closed"] as const)
          : p.state === "done"
            ? (["neutral", "Signed and submitted"] as const)
            : VERDICT.agent;
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">#{p.id}</span>
        <span className="flex-1">{p.what === "agent" ? `${TYPE_WORDS[p.type] ?? p.type} · ${p.agent}` : p.description}</span>
        <Badge tone={tone}>
          {tone === "success" ? <CheckCircle size={14} /> : tone === "destructive" ? <WarningOctagon size={14} /> : null}
          {label}
        </Badge>
        {p.what === "agent" && p.status === "InProgress" && p.state === "waiting" && <Window expiresAt={p.expiresAt} />}
      </div>
      <div className="text-sm text-muted-foreground">
        {p.status} · filed by {p.proposer} {ago(p.submittedAt)}
        {p.status === "InProgress" && (
          <>
            {" · "}
            <a className="underline hover:text-foreground" href={`https://trezu.app/${dao}/requests/${p.id}`} target="_blank" rel="noreferrer">
              vote in Trezu
            </a>
          </>
        )}
      </div>
      {p.what === "unknown" && (
        <p className="text-sm text-destructive-muted-foreground">
          It asks the DAO to sign as the agents' owner, but no agent here prepared it. Don't approve it unless you know where it comes from.
        </p>
      )}
      {p.what === "agent" && p.check.kind === "mismatch" && <p className="text-sm text-destructive-muted-foreground">Don't approve: {p.check.reason}.</p>}
      {p.what === "agent" && p.state === "expired" && p.status === "InProgress" && (
        <p className="text-sm text-muted-foreground">
          The API's signing window closed {ago(p.expiresAt)}, so approving it now does nothing. Reject it, or let it lapse, and file the
          action again if it is still wanted.
        </p>
      )}
      {p.what === "agent" && p.check.kind === "verified" && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">What the signature authorizes</summary>
          {p.check.standard === "nep413" ? (
            <pre className="mt-2 overflow-x-auto rounded-xl bg-muted p-3 font-mono text-xs">{JSON.stringify(p.check.message, null, 2)}</pre>
          ) : (
            <p className="mt-2">
              A transaction to <span className="font-mono">{p.check.receiver}</span> calling{" "}
              <span className="font-mono">{p.check.methods.join(", ")}</span>. Its policy data is encrypted for the wallet provider, so only
              its target and methods can be checked.
            </p>
          )}
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">hash {p.hash}</p>
        </details>
      )}
    </li>
  );
}

function Proposals({ dao }: { dao: string }) {
  const proposals = useQuery({
    queryKey: ["gw", "proposals"],
    queryFn: () => gw<Decoded[]>("/gw/proposals"),
    refetchInterval: 15_000,
  });
  const open = proposals.data?.filter((p) => p.status === "InProgress") ?? [];
  const recent = proposals.data?.filter((p) => p.status !== "InProgress").slice(0, 5) ?? [];
  return (
    <Section
      title="What am I voting on?"
      description="Each request to sign as the agents' owner, matched to what an agent prepared, with its hash recomputed from that payload."
    >
      <Card>
        {proposals.error ? (
          <p className="text-sm text-destructive-muted-foreground">{proposals.error.message}</p>
        ) : !proposals.data ? (
          <Spinner />
        ) : (
          <ul className="flex flex-col divide-y">
            {open.length === 0 && <li className="pb-4 text-sm text-muted-foreground">Nothing waits for a vote.</li>}
            {[...open, ...recent].map((p) => (
              <Proposal key={p.id} p={p} dao={dao} />
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}

/** One agent's state, as members may read it: shared by its card and the action queue. */
const agentQuery = (name: string) => ({
  queryKey: ["fleet", name],
  queryFn: async () => {
    const client = clientFor(`/a/${name}`);
    const [setup, overview, held, unresolved, autopilot, inbox] = await Promise.all([
      client.setup(),
      client.overview(),
      client.held(),
      client.unresolved(),
      client.autopilot.get(),
      client.inbox.list(),
    ]);
    return { setup, overview, held, unresolved, autopilot, inbox };
  },
  refetchInterval: 30_000,
});
type AgentState = Awaited<ReturnType<ReturnType<typeof agentQuery>["queryFn"]>>;

/** Payouts are confidential USDC (src/authorize.ts), which an empty wallet's book doesn't list. */
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
function amountOf(raw: string, asset: string, d: AgentState) {
  const holding = d.overview.book.find((h) => h.asset === asset);
  if (holding) return `${fromUnits(raw, holding.decimals)} ${holding.symbol}`;
  return asset === USDC ? `${fromUnits(raw, 6)} USDC` : `${raw} ${asset}`;
}

const GRANT_WARNING_DAYS = 7;
type Item = { agent: string; tone: Tone; text: string; href: string; action: string };

/** Everything across the DAO's agents that is waiting on a person, most urgent first. */
function itemsOf(name: string, d: AgentState): Item[] {
  const base = `/a/${name}`;
  const items: Item[] = [];
  if (d.unresolved.length)
    items.push({ agent: name, tone: "destructive", href: `${base}/activity`, action: "Reconcile",
      text: `${d.unresolved.length} money action${d.unresolved.length === 1 ? " has" : "s have"} no proven outcome: the agent sends nothing until reconciled` });
  if (d.overview.policy.policy?.frozen)
    items.push({ agent: name, tone: "destructive", href: `${base}/policy`, action: "Review", text: "The policy is frozen: the agent can't send" });
  const grant = d.setup.grant;
  if (!grant) items.push({ agent: name, tone: "destructive", href: `${base}/policy`, action: "Issue", text: "No live grant: the agent can't send" });
  else if (Date.parse(grant.expiresAt) - Date.now() < GRANT_WARNING_DAYS * 86_400_000)
    items.push({ agent: name, tone: "warning", href: `${base}/policy`, action: "Renew", text: `Its grant expires ${ago(grant.expiresAt)}` });
  for (const h of d.held) {
    const r = h.request as { amount?: string; asset?: string; recipient?: string };
    items.push({ agent: name, tone: "warning", href: `${base}/policy`, action: "Approve",
      text: `${r.amount && r.asset ? amountOf(r.amount, r.asset, d) : "A payment"} to ${r.recipient ?? "a payee"} waits for approval (requested ${ago(h.at)})` });
  }
  for (const e of d.inbox.filter((e) => !e.dismissed && e.level !== "run"))
    items.push({ agent: name, tone: e.level === "warn" ? "warning" : "info", href: `${base}/automations`, action: "Open", text: e.text });
  return items;
}

function NeedsAttention({ agents }: { agents: string[] }) {
  const results = useQueries({ queries: agents.map(agentQuery) });
  const loading = results.some((r) => r.isPending);
  const failed = agents.filter((_, i) => results[i]?.error);
  const items = agents.flatMap((name, i) => (results[i]?.data ? itemsOf(name, results[i].data) : []));
  const rank: Record<Tone, number> = { destructive: 0, warning: 1, info: 2, success: 3, neutral: 4 };
  items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  return (
    <Section title="Needs attention" description="What's waiting on a person across the DAO's agents: payouts to approve, the autopilot's questions, and anything stopping an agent from sending.">
      <Card>
        {loading ? (
          <Spinner />
        ) : items.length === 0 && failed.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle size={18} /> Nothing is waiting. The agents are working inside their limits.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {failed.map((name) => (
              <li key={`failed-${name}`} className="py-3 text-sm text-destructive-muted-foreground first:pt-0 last:pb-0">
                Couldn't read the {name} agent: it may be down.
              </li>
            ))}
            {items.map((item, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <Badge tone={item.tone}>{item.agent}</Badge>
                  <span className="min-w-0">{item.text}</span>
                </span>
                <a href={item.href} className="flex items-center gap-1 text-sm font-medium hover:underline">
                  {item.action} <ArrowRight size={14} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}

function AgentCard({ name }: { name: string }) {
  const data = useQuery(agentQuery(name));
  const d = data.data;
  const value = d?.overview.book.reduce((sum, h) => sum + h.usd, 0) ?? 0;
  return (
    <a href={`/a/${name}/`} className="group">
      <Card className="h-full">
        <div className="flex items-center gap-3">
          <Robot size={20} />
          <span className="flex-1 font-medium">{name}</span>
          <ArrowRight size={16} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
        {data.error ? (
          <p className="text-sm text-destructive-muted-foreground">{data.error.message}</p>
        ) : !d ? (
          <Spinner />
        ) : (
          <>
            <span className="font-heading text-2xl font-semibold tabular-nums">{usd(value)}</span>
            <div className="flex flex-wrap gap-2">
              <Badge tone={d.overview.policy.policy?.frozen ? "destructive" : "success"}>{d.overview.policy.policy?.frozen ? "Frozen" : "Active"}</Badge>
              {d.held.length > 0 && <Badge tone="warning">{d.held.length} awaiting approval</Badge>}
              {d.unresolved.length > 0 && <Badge tone="destructive">{d.unresolved.length} unresolved</Badge>}
              <Badge tone={d.autopilot.on ? "info" : "neutral"}>{d.autopilot.on ? `Autopilot to $${d.autopilot.maxUsd}` : "Autopilot off"}</Badge>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Grant</dt>
              <dd className="truncate font-mono text-xs" title={d.setup.grant?.label}>
                {d.setup.grant ? `${d.setup.grant.label}, expires ${ago(d.setup.grant.expiresAt)}` : "none"}
              </dd>
              <dt className="text-muted-foreground">Mandate</dt>
              <dd className="truncate font-mono text-xs" title={d.overview.digest ?? undefined}>
                {d.overview.digest ?? "no policy"}
              </dd>
            </dl>
          </>
        )}
      </Card>
    </a>
  );
}

export function DaoHome({ gateway }: { gateway: Gateway }) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 p-4 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold">{gateway.dao}</h1>
          <p className="text-sm text-muted-foreground">
            The agents this DAO owns. Every owner action is a proposal the council votes on in Trezu; check it here first.
          </p>
        </div>
        <div className="w-64">
          <ViewerBadge />
        </div>
      </header>
      <NeedsAttention agents={gateway.agents} />
      <Proposals dao={gateway.dao} />
      <Section title="Agents">
        <div className="grid gap-4 sm:grid-cols-2">
          {gateway.agents.map((name) => (
            <AgentCard key={name} name={name} />
          ))}
        </div>
      </Section>
    </div>
  );
}
