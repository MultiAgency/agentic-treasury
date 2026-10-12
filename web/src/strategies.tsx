import { ArrowRight, ArrowsLeftRight, CheckCircle, LockKey, Robot, ShieldCheck, ShieldWarning, Timer } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ASSET_COLOR, ago, amount, client, swaps, useRun, usd } from "./lib";
import { useAgent } from "./shell";
import { Badge, Button, Card, ConfirmButton, input, Section, Spinner, statusTone } from "./ui";

function Header({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="flex gap-4">
      <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-muted text-brand-strong">{icon}</div>
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** Fills a card's body when there is nothing to list yet. */
function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

function Failure({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p className="rounded-xl bg-destructive-muted px-4 py-3 font-mono text-sm text-destructive-muted-foreground">
      {error}
    </p>
  );
}

const Dot = ({ symbol }: { symbol: string }) => (
  <span className={`size-2 rounded-full ${ASSET_COLOR[symbol] ?? "bg-muted-foreground"}`} />
);

export function Rebalance() {
  const preview = useRun(client.rebalance);
  const execution = useRun(client.executePlan);
  const busy = preview.state === "running" || execution.state === "running";
  const plan = preview.events.find((e) => e.type === "plan");
  const saved = preview.events.find((e) => e.type === "saved");
  const executed = !!saved && execution.input?.planId === saved.plan.id && execution.state !== "idle";
  const rejected = execution.events.find((e) => e.type === "rejected");

  return (
    <Card className="lg:col-span-2 lg:row-span-2">
      <Header
        icon={<ArrowsLeftRight size={20} weight="bold" />}
        title="Rebalance"
        description="Swap toward a 50 / 25 / 25 split. Legs under $2 are left alone; legs costing over 150 bps are skipped."
      />

      <div className="flex min-h-40 flex-1 flex-col gap-3">
        {!plan && preview.state === "idle" && (
          <Empty icon={<ArrowsLeftRight size={24} />}>
            Preview plans the legs, quotes each one and saves the plan. Executing runs exactly that plan.
          </Empty>
        )}
        {!plan && preview.state === "running" && <Empty icon={<Spinner />}>Reading the book…</Empty>}
        {plan && plan.legs.length === 0 && (
          <Empty icon={<CheckCircle size={24} className="text-success" />}>
            The book is within tolerance. Nothing to do.
          </Empty>
        )}
        {plan?.legs.map((leg, i) => {
          const quote = preview.events.find((e) => e.type === "quote" && e.leg === i);
          const step = saved?.steps[i];
          const done = execution.events.find((e) => e.type === "action" && e.index === step);
          return (
            <div key={`${leg.from.asset}-${leg.to.asset}`} className="flex flex-col gap-3 rounded-xl bg-muted/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-medium">
                  <Dot symbol={leg.from.symbol} />
                  {amount(leg.amount, leg.from)}
                  <ArrowRight size={14} className="text-muted-foreground" />
                  <Dot symbol={leg.to.symbol} />
                  {leg.to.symbol}
                </div>
                <span className="text-sm text-muted-foreground tabular-nums">≈ {usd(leg.usd)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {!quote && preview.state === "running" && (
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <Spinner /> Quoting…
                  </span>
                )}
                {quote?.type === "quote" && (
                  <>
                    <span className="text-muted-foreground">
                      Quote {amount(quote.amountOut, leg.to)} · floor {amount(quote.minAmountOut, leg.to)}
                    </span>
                    <Badge tone={quote.skipped ? "warning" : "neutral"}>
                      {quote.costBps} bps · at worst {quote.worstCostBps}{quote.skipped ? " · skipped" : ""}
                    </Badge>
                  </>
                )}
                {done?.type === "action" && done.shield && (
                  <Badge tone={statusTone(done.shield.status)}>Shield {amount(done.shield.amount, leg.from)}</Badge>
                )}
                {done?.type === "action" && (
                  <Badge tone={statusTone(done.status)}>
                    Swap {done.status.toLowerCase()}
                    {done.failureCode ? ` · ${done.failureCode}` : ""}
                  </Badge>
                )}
                {step !== undefined && !done && execution.state === "running" && <Spinner />}
              </div>
            </div>
          );
        })}
        {rejected?.type === "rejected" && (
          <div className="flex flex-col gap-1 rounded-xl bg-warning-muted px-4 py-3 text-sm text-warning-muted-foreground">
            <span className="font-medium">Not executed. Preview again.</span>
            {rejected.problems.map((p) => (
              <span key={p}>– {p}</span>
            ))}
          </div>
        )}
        <Failure error={preview.error ?? execution.error} />
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {saved
            ? `Plan ${saved.plan.id.slice(0, 8)} · valid until ${new Date(saved.plan.expiresAt).toLocaleTimeString()} · budget remaining ${usd(plan?.budget)}`
            : plan && plan.legs.length > 0 && preview.state === "done"
              ? "Every leg costs more than it is worth: nothing to execute."
              : plan && `Budget remaining ${usd(plan.budget)}`}
        </span>
        <div className="flex gap-3">
          <Button variant="outline" disabled={busy} onClick={() => preview.run(undefined)}>
            {preview.state === "running" ? <Spinner /> : null}
            Preview
          </Button>
          <ConfirmButton
            label={execution.state === "running" ? <><Spinner /> Executing</> : "Execute"}
            disabled={busy || !saved || executed}
            title="Execute the previewed rebalance on mainnet?"
            description="Runs the previewed swaps exactly as shown, under the agent's grant, each held to its previewed floor. If the policy, a balance or the price moved past the floor, or the plan expired, nothing runs."
            confirm="Execute swaps"
            onConfirm={() => saved && execution.run({ planId: saved.plan.id })}
          />
        </div>
      </div>
    </Card>
  );
}

export function Sweep() {
  const { events, state, input, error, run } = useRun(client.sweep);
  const running = state === "running";
  const plan = events.find((e) => e.type === "plan");
  const shields = events.filter((e) => e.type === "shield");
  const exposed = plan?.exposed ?? [];

  return (
    <Card>
      <Header
        icon={<LockKey size={20} weight="bold" />}
        title="Sweep"
        description="Shield every public balance. Deposits and swaps stay confidential, so this only catches funds that arrived in public."
      />
      <div className="flex flex-col gap-3 text-sm">
        {!plan && <Note>{running ? "Reading the balances…" : "Preview shows what is public."}</Note>}
        {plan && exposed.length === 0 && <Note>Nothing public. Every balance is confidential.</Note>}
        {exposed.map((h) => {
          const shield = shields.find((e) => e.asset === h.asset);
          return (
            <div key={h.asset} className="flex flex-wrap items-center gap-2 tabular-nums">
              <Dot symbol={h.symbol} />
              {amount(h.public, h)} public
              {shield && (
                <Badge tone={statusTone(shield.status)}>
                  Shield {shield.status.toLowerCase()}
                  {shield.failureCode ? ` · ${shield.failureCode}` : ""}
                </Badge>
              )}
            </div>
          );
        })}
        <Failure error={error} />
      </div>
      <div className="mt-auto flex justify-end gap-3">
        <Button variant="outline" size="sm" disabled={running} onClick={() => run({ execute: false })}>
          Preview
        </Button>
        <ConfirmButton
          label={running && input?.execute ? <><Spinner /> Shielding</> : "Shield"}
          disabled={exposed.length === 0 || running || input?.execute}
          title="Shield every public balance?"
          description="Moves each public balance into the agent's confidential balance on mainnet. It stays in the account, out of public view."
          confirm="Shield"
          onConfirm={() => run({ execute: true })}
        />
      </div>
    </Card>
  );
}

export function Probes() {
  const { events, state, error, run } = useRun(client.refusals);
  const running = state === "running";

  return (
    <Card>
      <Header
        icon={<ShieldCheck size={20} weight="bold" />}
        title="Policy probes"
        description="Live probes are disabled here. They are real financial requests; use offline adversarial tests and recorded mainnet evidence to demonstrate policy boundaries."
      />
      <div className="flex flex-col gap-3 text-sm">
        {events.length === 0 && !running && <Note>Live probes require an explicit CLI opt-in and must not be scheduled.</Note>}
        {events.map((e) => {
          const [, what, layer] = /^(.*?)(?: \((.*)\))?$/.exec(e.name) ?? [];
          return (
            <div key={e.name} className="flex items-start justify-between gap-3">
              <div className="flex flex-col">
                <span>{what}</span>
                <span className="text-xs text-muted-foreground">{layer}</span>
              </div>
              {e.outcome === "refused" ? (
                <Badge tone="success">
                  <ShieldCheck size={12} weight="bold" /> <span className="font-mono">{e.code}</span>
                </Badge>
              ) : e.outcome === "inconclusive" ? (
                // Refused for want of funds, before the policy was consulted: proves nothing either way.
                <Badge tone="neutral">
                  Inconclusive · <span className="font-mono">{e.code}</span>
                </Badge>
              ) : e.outcome === "unknown" ? (
                <Badge tone="warning">Unknown · stopped · {e.status ?? e.detail}</Badge>
              ) : (
                <Badge tone="destructive">
                  <ShieldWarning size={12} weight="bold" /> Passed · {e.status.toLowerCase()}
                </Badge>
              )}
            </div>
          );
        })}
        {running && (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Spinner /> Probing…
          </span>
        )}
        {state === "done" && events[0] && <Note>Budget after probes {usd(events.at(-1)?.budget)}</Note>}
        <Failure error={error} />
      </div>
      <div className="mt-auto flex justify-end">
        <ConfirmButton
          label="Live probes disabled"
          disabled
          title="Send five out-of-policy requests?"
          description="These requests can move real funds. Unknown outcomes stop the run and require reconciliation."
          confirm="Run probes"
          onConfirm={() => run(undefined)}
        />
      </div>
    </Card>
  );
}

/** A tool result that starts like this was stopped by the policy or the cost cap, or not proposed. */
const resultTone = (result: string) =>
  /^(REFUSED|ERROR)/.test(result) ? "destructive" : /^(NOT PROPOSED|ALREADY)/.test(result) ? "warning" : /^PROPOSED/.test(result) ? "info" : "neutral";

export function Steward() {
  const proposal = useRun(client.steward.propose);
  const execution = useRun(client.executePlan);
  const [instruction, setInstruction] = useState("");
  const busy = proposal.state === "running" || execution.state === "running";
  const plan = proposal.events.find((e) => e.type === "plan")?.plan;
  const executed = execution.input?.planId === plan?.id && execution.state !== "idle";

  return (
    <Card>
      <Header
        icon={<Robot size={20} weight="bold" />}
        title="Steward"
        description="GLM 5.3 Flash on NEAR AI Cloud proposes a plan inside the policy. Each response is signed in a TEE and verified before its tool calls run. Executing runs the plan exactly as proposed."
      />

      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        disabled={busy}
        rows={2}
        placeholder="Leave empty for a routine review: rebalance if it is worth a fee, shield anything public."
        className="w-full resize-y rounded-xl border bg-transparent px-4 py-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2"
      />

      <div className="flex min-h-40 flex-col gap-3">
        {proposal.events.length === 0 && proposal.state === "idle" && (
          <Empty icon={<Robot size={24} />}>Propose reads, quotes and plans. Nothing moves until you execute the plan.</Empty>
        )}
        {proposal.events.map((event, i) => {
          if (event.type === "plan") return null;
          if (event.type === "verified")
            return (
              <div key={i} className="flex justify-end">
                <Badge tone="success">
                  <ShieldCheck size={12} weight="bold" /> Verified {event.signatureKind} ·{" "}
                  <span className="font-mono">{event.completionId.slice(0, 8)}</span>
                </Badge>
              </div>
            );
          if (event.type === "say")
            return (
              <p key={i} className="text-sm whitespace-pre-wrap">
                {event.text}
              </p>
            );
          if (event.type === "call")
            return (
              <div key={i} className="font-mono text-sm">
                → {event.name} <span className="text-muted-foreground">{JSON.stringify(event.input)}</span>
              </div>
            );
          // Book reads are long JSON: keep them folded.
          return event.result.startsWith("{") ? (
            <details key={i} className="rounded-xl bg-muted/60 px-4 py-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">{event.name} result</summary>
              <pre className="mt-2 overflow-x-auto font-mono">{JSON.stringify(JSON.parse(event.result), null, 2)}</pre>
            </details>
          ) : (
            <div key={i}>
              <Badge tone={resultTone(event.result)}>
                <span className="font-mono">{event.result}</span>
              </Badge>
            </div>
          );
        })}
        {proposal.state === "running" && (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Thinking…
          </span>
        )}
        {plan && (
          <div className="flex flex-col gap-2 rounded-xl bg-muted/60 p-4 text-sm">
            <span className="font-medium">
              Plan <span className="font-mono">{plan.id.slice(0, 8)}</span> · valid until {new Date(plan.expiresAt).toLocaleTimeString()}
            </span>
            {plan.actions.map((action, i) => {
              const done = execution.events.find((e) => e.type === "action" && e.index === i);
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 font-mono">
                  {i + 1}.{" "}
                  {action.type === "swap"
                    ? `swap ${action.amount} ${action.from.slice(0, 16)} → ${action.to.slice(0, 16)} · floor ${action.minAmountOut} · ${action.costBps} bps`
                    : `shield ${action.amount} ${action.asset.slice(0, 16)}`}
                  {done?.type === "action" && done.shield && (
                    <Badge tone={statusTone(done.shield.status)}>shield {done.shield.status.toLowerCase()}</Badge>
                  )}
                  {done?.type === "action" && (
                    <Badge tone={statusTone(done.status)}>
                      {done.status.toLowerCase()}
                      {done.failureCode ? ` · ${done.failureCode}` : ""}
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {execution.events.map((event, i) =>
          event.type === "rejected" ? (
            <div key={i} className="flex flex-col gap-1 rounded-xl bg-warning-muted px-4 py-3 text-sm text-warning-muted-foreground">
              <span className="font-medium">Not executed. Propose again.</span>
              {event.problems.map((p) => (
                <span key={p}>– {p}</span>
              ))}
            </div>
          ) : null,
        )}
        <Failure error={proposal.error ?? execution.error} />
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {proposal.state === "done" && !plan && "Nothing proposed: nothing to execute."}
        </span>
        <div className="flex gap-3">
          <Button variant="outline" disabled={busy} onClick={() => proposal.run({ instruction })}>
            {proposal.state === "running" ? <Spinner /> : null}
            Propose
          </Button>
          <ConfirmButton
            label={execution.state === "running" ? <><Spinner /> Executing</> : "Execute plan"}
            disabled={busy || !plan || executed}
            title="Execute this plan on mainnet?"
            description="Runs the proposed steps exactly as shown, under the agent's grant, each swap held to its previewed floor. If the policy, a balance or the price moved past the floor, or the plan expired, nothing runs."
            confirm="Execute plan"
            onConfirm={() => plan && execution.run({ planId: plan.id })}
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * The agent working on its own (src/autopilot.ts). Each tick sweeps, then previews a rebalance and
 * executes it only when its swaps are worth no more than the limit; anything larger waits for the owner.
 */
function Autopilot() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["autopilot"], queryFn: () => client.autopilot.get(), refetchInterval: 30_000 });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => client.inbox.list(), refetchInterval: 30_000 });
  const [draft, setDraft] = useState<{ everyMin: string; maxUsd: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!status.data) return null;
  const s = status.data;
  const form = draft ?? { everyMin: String(s.everyMin), maxUsd: String(s.maxUsd) };
  const everyMin = Number(form.everyMin);
  const maxUsd = Number(form.maxUsd);
  const valid = Number.isInteger(everyMin) && everyMin >= 5 && Number.isInteger(maxUsd) && maxUsd >= 0;
  const runs = (inbox.data ?? []).filter((e) => e.level === "run").slice(0, 5);

  const act = async (work: () => Promise<unknown>) => {
    setError(undefined);
    setBusy(true);
    try {
      await work();
      setDraft(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries();
    }
  };
  const save = (on: boolean) => act(() => client.autopilot.set({ on, everyMin, maxUsd }));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Header
          icon={<Timer size={20} weight="bold" />}
          title="Autopilot"
          description="Sweeps public balances, then rebalances on its own when the swaps are within the limit. Larger rebalances wait for you. The policy's caps and budget still bound everything."
        />
        <Badge tone={s.on ? "success" : "neutral"}>{s.on ? `On · next ${s.nextRun ? ago(s.nextRun) : "soon"}` : "Off"}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Every (minutes)</span>
          <input className={input} inputMode="numeric" value={form.everyMin} onChange={(e) => setDraft({ ...form, everyMin: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Execute rebalances up to (USD)</span>
          <input className={input} inputMode="numeric" value={form.maxUsd} onChange={(e) => setDraft({ ...form, maxUsd: e.target.value })} />
        </label>
      </div>
      {!valid && <p className="text-sm text-warning-muted-foreground">At least every 5 minutes, and a limit in whole dollars, $0 or more.</p>}
      {runs.length > 0 && (
        <ul className="flex flex-col divide-y text-sm">
          {runs.map((r) => (
            <li key={r.id} className="flex gap-3 py-2">
              <span className="w-28 shrink-0 text-muted-foreground">{ago(r.at)}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <Failure error={error} />
      <div className="mt-auto flex flex-wrap justify-end gap-3">
        {draft && s.on && (
          <Button variant="outline" size="sm" disabled={busy || !valid} onClick={() => save(true)}>
            Save
          </Button>
        )}
        <ConfirmButton
          label={busy ? <Spinner /> : "Run now"}
          disabled={busy}
          title="Run one autopilot tick on mainnet?"
          description="Shields any public balance and executes a rebalance if its swaps are within the limit. Anything larger is left for you."
          confirm="Run now"
          onConfirm={() => act(() => client.autopilot.tick())}
        />
        {s.on ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save(false)}>
            Turn off
          </Button>
        ) : (
          <ConfirmButton
            label="Turn on"
            disabled={busy || !valid}
            title="Let the agent act on its own?"
            description={`Every ${everyMin} minutes this server shields public balances and executes rebalances of up to $${maxUsd} without asking. It runs while this server runs.`}
            confirm="Turn on"
            onConfirm={() => save(true)}
          />
        )}
      </div>
    </Card>
  );
}

/** The fixed strategies, each run on demand, and the autopilot that runs them unattended. */
export function Automations() {
  const { data } = useAgent();
  return (
    <Section title="Automations" description="Each strategy previews first. Executing asks once, then runs under the agent's grant.">
      <Autopilot />
      <div className="grid gap-6 lg:grid-cols-3">
        {swaps(data) && <Rebalance />}
        <Sweep />
        <Probes />
      </div>
    </Section>
  );
}
