import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { ArrowRight, CheckCircle, Robot, WarningOctagon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Decoded } from "../../src/gateway/proposals.js";
import type { Router } from "../../src/router.js";
import { ago, usd } from "./lib";
import { type Gateway, ViewerBadge } from "./session";
import { Badge, Card, Section, Spinner, type Tone } from "./ui";

/**
 * The hosted dashboard's home: what the council is being asked to sign, and the agents the DAO owns.
 * Agent data comes through the gateway, by the same calls each agent's own dashboard makes.
 */

const agentClient = (name: string): RouterClient<Router> => createORPCClient(new RPCLink({ url: `/a/${name}/rpc` }));

/** Seconds until `iso`, ticking. */
function useSecondsLeft(iso: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
}

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
  const left = useSecondsLeft(expiresAt);
  return left === 0 ? (
    <Badge tone="destructive">signing window closed</Badge>
  ) : (
    <Badge tone={left < 120 ? "warning" : "info"}>
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left to vote
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
    queryFn: async () => {
      const response = await fetch("/gw/proposals");
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      return (await response.json()) as Decoded[];
    },
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

function AgentCard({ name }: { name: string }) {
  const client = agentClient(name);
  const data = useQuery({
    queryKey: ["fleet", name],
    queryFn: async () => {
      const [setup, overview, held, unresolved, autopilot] = await Promise.all([
        client.setup(),
        client.overview(),
        client.held(),
        client.unresolved(),
        client.autopilot.get(),
      ]);
      return { setup, overview, held, unresolved, autopilot };
    },
    refetchInterval: 30_000,
  });
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
