import { ArrowRight, CheckCircle, WarningOctagon } from "@phosphor-icons/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Decoded } from "../../src/gateway/proposals.js";
import { type Attention, attentionOf } from "./attention";
import type { Kind } from "./beats";
import { PrototypeCard } from "./showcase";
import { ago, clientFor, gw, kindOf, minutesSeconds, useCountdown } from "./lib";
import { AGENT_NAME, namer } from "./names";
import { type Gateway, type GatewayAgent, ownersOf, ViewerBadge } from "./session";
import { Badge, Card, Details, Loading, QueryError, Section, Spinner, type Tone } from "./ui";

/**
 * The hosted dashboard's home: the agents this viewer may see and, for each DAO among their owners,
 * what its council is being asked to sign. Agent data comes through the gateway, by the same calls
 * each agent's own dashboard makes.
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
  unchecked: ["warning", "Can't be checked yet"],
  past: ["neutral", "Done"],
  trezu: ["neutral", "Trezu confidential payment"],
  other: ["warning", "Signs for another key"],
};

/**
 * A proposal description in a few words. Sputnik descriptions are "* Key: value" fields joined by <br>;
 * the action field says what it asks (ours and Trezu's both set it). Anything else shows its first line.
 */
function titleOf(p: Decoded): string {
  if (p.what === "trezu") return "A payment from the DAO's confidential treasury; Trezu keeps its details private";
  const fields = p.description.split(/<br\s*\/?>/i).map((f) => f.replace(/^\s*\*\s*/, "").trim());
  const action = fields.find((f) => /^Proposal Action:/i.test(f))?.replace(/^Proposal Action:\s*/i, "").replace(/\.$/, "");
  return action || fields[0] || `Proposal #${p.id}`;
}

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
        <span className="flex-1">{p.what === "agent" ? `${TYPE_WORDS[p.type] ?? p.type} · ${p.agent}` : titleOf(p)}</span>
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
      {p.what === "unchecked" && (
        <p className="text-sm text-warning-muted-foreground">
          No agent that answered prepared it, and {p.unanswered.join(" and ")} didn't answer, so it can't be checked yet. Wait for this page to
          refresh before voting.
        </p>
      )}
      {p.what === "agent" && p.check.kind === "mismatch" && <p className="text-sm text-destructive-muted-foreground">Don't approve: {p.check.reason}.</p>}
      {p.what === "agent" && p.state === "expired" && p.status === "InProgress" && (
        <p className="text-sm text-muted-foreground">
          The API's signing window closed {ago(p.expiresAt)}, so approving it now does nothing. Reject it, or let it lapse, and file the
          action again if it is still wanted.
        </p>
      )}
      {p.what !== "agent" && p.what !== "trezu" && p.description !== titleOf(p) && (
        <Details summary="Full description">
          <p className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{p.description.replace(/<br\s*\/?>\s*/gi, "\n")}</p>
        </Details>
      )}
      {p.what === "agent" && p.check.kind === "verified" && (
        <Details summary="What the signature authorizes">
          {p.check.standard === "nep413" ? (
            <pre className="overflow-x-auto rounded-xl bg-muted p-3 font-mono text-xs">{JSON.stringify(p.check.message, null, 2)}</pre>
          ) : (
            <p>
              A transaction to <span className="font-mono">{p.check.receiver}</span> calling{" "}
              <span className="font-mono">{p.check.methods.join(", ")}</span>. Its policy data is encrypted for the wallet provider, so only
              its target and methods can be checked.
            </p>
          )}
          <p className="break-all font-mono text-xs text-muted-foreground">hash {p.hash}</p>
        </Details>
      )}
    </li>
  );
}

function Proposals({ dao }: { dao: string }) {
  const proposals = useQuery({
    queryKey: ["gw", "proposals", dao],
    queryFn: () => gw<Decoded[]>(`/gw/proposals?dao=${encodeURIComponent(dao)}`),
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

/** Independent reads retain useful results when another check fails or is slow. */
function useFleet(agents: string[]) {
  const query = <T,>(name: string, read: string, queryFn: () => Promise<T>) => ({
    queryKey: ["fleet", name, read], queryFn, refetchInterval: 30_000, retry: false,
  });
  const setup = useQueries({ queries: agents.map(name => query(name, "setup", () => clientFor(`/a/${name}`).setup())) });
  const overview = useQueries({ queries: agents.map(name => query(name, "overview", () => clientFor(`/a/${name}`).overview())) });
  const held = useQueries({ queries: agents.map(name => query(name, "held", () => clientFor(`/a/${name}`).held())) });
  const unresolved = useQueries({ queries: agents.map(name => query(name, "unresolved", () => clientFor(`/a/${name}`).unresolved())) });
  const autopilot = useQueries({ queries: agents.map(name => query(name, "autopilot", () => clientFor(`/a/${name}`).autopilot.get())) });
  const inbox = useQueries({ queries: agents.map(name => query(name, "inbox", () => clientFor(`/a/${name}`).inbox.list())) });
  return agents.map((name, i) => {
    const reads = [setup[i]!, overview[i]!, held[i]!, unresolved[i]!, autopilot[i]!, inbox[i]!];
    const labels = ["agent setup", "policy and balances", "held payouts", "unresolved operations", "autopilot settings", "inbox"];
    const data = { setup: setup[i]!.data, overview: overview[i]!.data, held: held[i]!.data,
      unresolved: unresolved[i]!.data, autopilot: autopilot[i]!.data, inbox: inbox[i]!.data };
    return { name, data, error: reads.find(r => r.error)?.error,
      incomplete: reads.flatMap((r, index) => r.isPending || r.error ? [labels[index]!] : []),
      isPending: reads.some(r => r.isPending),
      dataUpdatedAt: Math.min(...reads.map(r => r.dataUpdatedAt)),
      complete: reads.every(r => r.data !== undefined),
      refetch: () => Promise.all(reads.map(r => r.refetch())),
    };
  });
}
type AgentState = ReturnType<typeof useFleet>[number]["data"];

type Item = Attention & { agent: string };

const itemsOf = (name: string, d: AgentState, nameOf: (account: string) => string): Item[] =>
  attentionOf({ ...d, nameOf }).map((item) => ({ ...item, agent: name }));

/** Each agent's wallet by its role, so a payment to the payout agent reads as such, not as 64 hex digits. */
const namesOf = (states: (AgentState | undefined)[]) =>
  namer(new Map(states.flatMap((d) => (d?.setup?.wallet && d.overview ? [[d.setup.wallet, AGENT_NAME[kindOf(d.overview) as Kind]] as const] : []))));

function NeedsAttention({ agents }: { agents: string[] }) {
  const results = useFleet(agents);
  const incomplete = results.filter(r => r.incomplete.length > 0);
  const nameOf = namesOf(results.map((r) => r.data));
  const items = agents.flatMap((name, i) => (results[i]?.data ? itemsOf(name, results[i].data, nameOf) : []));
  if (items.length === 0 && incomplete.length === 0) return null;
  const rank: Record<Tone, number> = { destructive: 0, warning: 1, info: 2, success: 3, neutral: 4 };
  items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  return (
    <Section title="Needs attention" description="What's waiting on a person across the DAO's agents: payouts to approve, the autopilot's questions, and anything stopping an agent from sending.">
      <Card>
        <ul className="flex flex-col divide-y">
            {incomplete.map((result) => (
              <li key={`incomplete-${result.name}`} className="flex flex-col gap-2 py-3 text-sm first:pt-0 last:pb-0">
                <p className="text-warning-muted-foreground">{result.name}: checks are incomplete ({result.incomplete.join(", ")}). Known items remain below; cached items may be out of date.</p>
                {result.isPending && <Loading label={`Checking ${result.name}…`} />}
                {result.error && <QueryError error={result.error} retry={() => void result.refetch()} />}
              </li>
            ))}
            {items.map((item, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <Badge tone={item.tone}>{item.agent}</Badge>
                  <span className="min-w-0">{item.text}</span>
                </span>
                <a href={`/a/${item.agent}${item.to}`} className="flex items-center gap-1 text-sm font-medium hover:underline">
                  {item.action} <ArrowRight size={14} />
                </a>
              </li>
            ))}
          </ul>
      </Card>
    </Section>
  );
}

/** An agent's state in one line: whether it may act, and what waits on a person. */
function AgentStatus({ d }: { d: { [K in keyof AgentState]: NonNullable<AgentState[K]> } }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge tone={d.overview.notInForce ? "destructive" : "success"}>
        {d.overview.policy.policy?.frozen ? "Frozen" : d.overview.notInForce ? "Not in force" : "Policy in force"}
      </Badge>
      {d.held.length > 0 && <Badge tone="warning">{d.held.length} held for approval</Badge>}
      {d.unresolved.length > 0 && <Badge tone="destructive">{d.unresolved.length} unresolved</Badge>}
      {kindOf(d.overview) === "treasury" && (
        <Badge tone={d.autopilot.on ? "info" : "neutral"}>{d.autopilot.on ? `Autopilot to $${d.autopilot.maxUsd}` : "Autopilot off"}</Badge>
      )}
    </div>
  );
}

/** Each accessible agent has a stable place, including while its reads are unavailable. */
function Prototypes({ agents, invoices }: { agents: GatewayAgent[]; invoices: string | null }) {
  const results = useFleet(agents.map(a => a.name));
  if (!agents.length) return <p className="text-sm text-muted-foreground">No agents are available to this account.</p>;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {agents.map((agent, index) => {
        const result = results[index]!;
        const d = result.data;
        const state = result.error ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-warning-muted-foreground">
              {result.complete ? `Status could not be refreshed. Last read ${new Date(result.dataUpdatedAt).toLocaleString()}.` : `${agent.name} is unavailable: its status could not be read.`}
            </p>
            <QueryError error={result.error} retry={() => void result.refetch()} />
          </div>
        ) : <Loading label={`Loading ${agent.name}…`} />;
        if (!d.overview) return (
          <Card key={agent.name}>
            <h2 className="font-heading text-2xl font-semibold">{agent.name}</h2>
            {state}
            <a href={`/a/${agent.name}/`} className="self-start py-2 text-sm font-medium underline">Open {agent.name} →</a>
          </Card>
        );
        return (
          <PrototypeCard compact key={agent.name} kind={kindOf(d.overview)} open={`/a/${agent.name}/`} invoices={invoices}
            status={result.error || !result.complete ? state : <AgentStatus d={d as { [K in keyof AgentState]: NonNullable<AgentState[K]> }} />} />
        );
      })}
    </div>
  );
}

export function DaoHome({ gateway }: { gateway: Gateway }) {
  // The gateway lists only the agents this viewer may see.
  const { agents } = gateway;
  const daos = ownersOf(agents.filter((a) => a.dao));
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 p-4 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold">{ownersOf(agents).join(" · ")}</h1>
          <p className="text-sm text-muted-foreground">
            {agents.every((a) => a.dao)
              ? "Two areas, each an agent this DAO owns. Every owner action is a proposal the council votes on in Trezu; check it here first."
              : "The agents you may see, each answering to its owner: a DAO votes on every owner action as a proposal, checked here first; any other owner signs with its own wallet."}
          </p>
        </div>
        <div className="w-64">
          <ViewerBadge />
        </div>
      </header>
      <NeedsAttention agents={agents.map((a) => a.name)} />
      <Prototypes agents={agents} invoices={gateway.invoices} />
      {daos.map((dao) => (
        <Proposals key={dao} dao={dao} />
      ))}
    </div>
  );
}
