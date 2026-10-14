import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { queriesFor } from "../../shared/queries";
import { useFleet, type AgentState } from "./workspace-observations";
import { Proposals } from "./proposals";
import { ArrowRight } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type Attention, attentionOf, attentionHref } from "./attention";
import type { Kind } from "../evidence/beats";
import { useEffect, useState } from "react";
import { Row, isProbe } from "../activity/activity";
import { areaName } from "../../app/workspace";
import { ago, clientFor, kindOf } from "../../shared/lib";
import { AGENT_NAME, namer } from "../../shared/names";
import { type Gateway, type GatewayAgent, ownersOf } from "../../app/session";
import { Badge, Card, Loading, QueryError, Section, type Tone } from "../../shared/ui";

/**
 * The hosted dashboard's home: the agents this viewer may see and, for each DAO among their owners,
 * what its council is being asked to sign. Agent data comes through the gateway, by the same calls
 * each agent's own dashboard makes.
 */

type Item = Attention & { agent: string };

const itemsOf = (name: string, d: AgentState, nameOf: (account: string) => string): Item[] =>
  attentionOf({ ...d, nameOf }).map((item) => ({ ...item, agent: name }));

/** Each agent's wallet by its role, so a payment to the payout agent reads as such, not as 64 hex digits. */
const namesOf = (states: (AgentState | undefined)[]) =>
  namer(new Map(states.flatMap((d) => (d?.setup?.wallet && d.overview ? [[d.setup.wallet, AGENT_NAME[kindOf(d.overview) as Kind]] as const] : []))));

function NeedsAttention({ results }: { results: ReturnType<typeof useFleet> }) {
  const incomplete = results.filter(r => r.incomplete.length > 0);
  const nameOf = namesOf(results.map((r) => r.data));
  const items = results.flatMap(result => itemsOf(result.name, result.data, nameOf));
  const rank: Record<Tone, number> = { destructive: 0, warning: 1, info: 2, success: 3, neutral: 4 };
  items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  return (
    <Section title="Needs attention" description="Decisions and exceptions across the agents you can access.">
      <Card>
        <ul className="flex flex-col divide-y">
            {!items.length && !incomplete.length && <li className="text-sm text-muted-foreground">No items need attention in the records checked.</li>}
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
                <a href={attentionHref(item, `/a/${item.agent}`)} className="flex items-center gap-1 text-sm font-medium hover:underline">
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
function AgentStatus({ result }: { result: ReturnType<typeof useFleet>[number] }) {
  const d = result.data;
  return (
    <div className="flex flex-wrap gap-2">
      {d.overview && !result.reads.overview.error && <Badge tone={d.overview.notInForce ? "destructive" : "success"}>
        {d.overview.policy.policy?.frozen ? "Frozen" : d.overview.notInForce ? "Not in force" : "Policy in force"}
      </Badge>}
      {d.overview && d.autopilot && !result.reads.autopilot.error && kindOf(d.overview) === "treasury" && (
        <Badge tone={d.autopilot.on ? "info" : "neutral"}>{d.autopilot.on ? `Autopilot to $${d.autopilot.maxUsd}` : "Autopilot off"}</Badge>
      )}
    </div>
  );
}

function LatestRun({ name }: { name: string }) {
  const evidence = useQuery({ ...queriesFor(clientFor(`/a/${name}`), ["fleet", name]).runs, retry: false, refetchInterval: 30_000 });
  const latest = evidence.data?.ticks.at(-1);
  return <div className="text-sm">
    {evidence.isPending && <Loading label="Loading latest run…" />}
    {evidence.error && <QueryError error={evidence.error} retry={() => evidence.refetch()} />}
    {!evidence.error && latest && <><p>Latest run · {ago(latest.at)}</p><p>{latest.end?.outcome ?? "No end recorded: the run may still be active, interrupted, or its outcome unknown."}</p>
      <a className="underline" href={`/a/${name}/follow/run?run=${encodeURIComponent(latest.id)}`}>Inspect latest run</a></>}
    {evidence.isSuccess && !latest && <p>No run found in the retained records.</p>}
  </div>;
}

/** Compact operating status, with direct links to the work rather than entry cards. */
function AreaStatus({ agents, results }: { agents: GatewayAgent[]; results: ReturnType<typeof useFleet> }) {
  return <Section title="Current status" description="Each agent has its own policy, grant and balance.">
    {!agents.length && <p>No agents are available to this account.</p>}
    {agents.map((agent, i) => {
      const result = results[i]!;
      const d = result.data;
      const treasury = d.overview ? kindOf(d.overview) === "treasury" : null;
      return <div key={agent.name} className="flex flex-col gap-3 border-b pb-5 last:border-0">
        <h3 className="text-lg font-semibold">{treasury === null ? areaName(agent) : treasury ? "Portfolio" : "Payables"}</h3>
        <p className="break-all text-sm text-muted-foreground">{agent.owner} · {agent.name}</p>
        <AgentStatus result={result} />
        {treasury && <LatestRun name={agent.name} />}
        <div className="flex flex-wrap gap-4 text-sm">
          <a className="underline" href={`/a/${agent.name}/`}>{treasury === null ? "Review agent" : treasury ? "Review allocation" : "Review payments"}</a>
          {treasury !== null && <a className="underline" href={`/a/${agent.name}/${treasury ? "follow/run" : "payees"}`}>{treasury ? "Review runs" : "Review agreements"}</a>}
          <a className="underline" href={`/a/${agent.name}/policy`}>Policy and permissions</a>
        </div>
      </div>;
    })}
  </Section>;
}

function AgentHistory({ agent }: { agent: GatewayAgent }) {
  const client = clientFor(`/a/${agent.name}`);
  const reads = queriesFor(client, ["fleet", agent.name]);
  const activity = useQuery({ ...reads.activity, retry: false, refetchInterval: 30_000 });
  const owners = useQuery({ ...reads.ownerActions, retry: false, refetchInterval: 30_000 });
  const overview = useQuery({ ...reads.overview, refetchInterval: false, retry: false, staleTime: 30_000 });
  const denied = [activity.error, owners.error, overview.error].some(accessDenied);
  const rows = denied ? [] : activity.data?.filter(op => !isProbe(op)) ?? [];
  return <Section title={areaName(agent)} description={`${agent.owner} · ${agent.name}`}>
    <a href={`/a/${agent.name}/activity`} className="self-start text-sm underline">Review full history and unresolved operations</a>
    {overview.error && <p className="text-sm text-warning-muted-foreground">Asset display data unavailable; amounts may appear in raw units.</p>}
    {activity.error && <ReadFailure label="Activity" error={activity.error} retry={() => activity.refetch()} retained={activity.data !== undefined} updatedAt={activity.dataUpdatedAt} />}
    {activity.isPending && <Loading label="Loading activity…" />}
    {!denied && activity.isSuccess && !rows.length && <p className="text-sm text-muted-foreground">No money actions recorded on this instance.</p>}
    <ol>{rows.slice(0, 10).map((op, i) => <Row key={`${op.at}-${i}`} op={op} idPrefix={`${agent.name}-`} book={overview.data?.book ?? []} nameOf={a => a} />)}</ol>
    <h3 className="font-medium">Owner actions</h3>
    {owners.error && <ReadFailure label="Owner actions" error={owners.error} retry={() => owners.refetch()} retained={owners.data !== undefined} updatedAt={owners.dataUpdatedAt} />}
    {owners.isPending && <Loading label="Loading owner actions…" />}
    {!denied && owners.isSuccess && !owners.data.length && <p className="text-sm text-muted-foreground">No owner actions recorded on this instance.</p>}
    {!denied && owners.data?.slice(0, 5).map(action => <p key={action.correlationId} className="text-sm">
      <a href={`/a/${agent.name}/activity#owner-${encodeURIComponent(action.correlationId)}`} className="underline">{action.type.replaceAll("_", " ")}</a> · {action.stage}. Owner approval and payment settlement are separate outcomes.
    </p>)}
  </Section>;
}

function WorkspaceOverview({ agents, daos }: { agents: GatewayAgent[]; daos: string[] }) {
  const results = useFleet(agents);
  return <>
    <NeedsAttention results={results} />
    {daos.map(dao => <Proposals key={dao} dao={dao} />)}
    <AreaStatus agents={agents} results={results} />
  </>;
}

export function DaoHome({ gateway, activity = false }: { gateway: Gateway; activity?: boolean }) {
  const { agents } = gateway;
  const daos = ownersOf(agents.filter(a => a.dao));
  const [filter, setFilter] = useState("");
  useEffect(() => {
    document.title = `${activity ? "Activity" : "Home"} · Agentic Treasury`;
    document.getElementById("workspace-main")?.focus();
  }, [activity]);
  return <main id="workspace-main" tabIndex={-1} className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
    <div><h1 className="text-2xl font-semibold">{activity ? "Activity" : "Home"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{activity ? "Recent records, grouped by agent. Each instance retains its own history." : "Payments to review and treasury operations to follow."}</p></div>
    {activity ? <>
      <div className="flex flex-col items-start gap-2 text-sm"><label htmlFor="activity-area">Area</label>
        <select id="activity-area" value={filter} onChange={e => setFilter(e.target.value)} className="max-w-full rounded-lg border bg-background p-3">
          <option value="">All areas</option>{agents.map(a => <option key={a.name} value={a.name}>{areaName(a)} · {a.owner}</option>)}
        </select>
      </div>
      {agents.filter(a => !filter || a.name === filter).map(agent => <AgentHistory key={agent.name} agent={agent} />)}
      {!agents.length && <p>No agents are available to this account.</p>}
    </> : <WorkspaceOverview agents={agents} daos={daos} />}
  </main>;
}
