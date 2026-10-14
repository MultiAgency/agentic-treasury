import { Link, useSearch, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { bindingWindow } from "../../src/budget-window.js";
import { PERIOD } from "./budget";
import { ago, amountOf, client, usd, useAttempt } from "./lib";
import { useAgent } from "./shell";
import { Badge, Card, ConfirmButton, Details, ErrorBox, Loading, QueryError, Section, Spinner, StatusBadge, statusTone } from "./ui";
import { refusalText } from "./words";
import { RunDownload } from "./run-download";
import { RunUpdates } from "./live-run";

/**
 * An autopilot run as a timeline that doubles as its receipt, read from the evidence the scheduler itself
 * records (src/evidence.ts): the book before, the quoted plan, each send's outcome, the budget before and
 * after, and the book after. Overview previews the latest run; "Follow this run" holds the full
 * history, receipts, exports and Run now. Members only.
 */

type Ticks = Awaited<ReturnType<typeof client.autopilot.evidence>>;
type Tick = Ticks["ticks"][number];
type Seen = NonNullable<Tick["end"]>["before"];
type Window = { limit_usd: string | null; remaining_usd: string | null };

/** A run without a recorded end after this long was interrupted, or its outcome is unknown (src/evidence.ts). */
const STALE_MS = 10 * 60_000;
const running = (t: Tick | undefined) => Boolean(t && t.end === null && Date.now() - Date.parse(t.at) < STALE_MS);
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const seen = (s: Seen) => ("error" in s ? null : s);
const budgetOf = (s: Seen) => (seen(s)?.budget ?? null) as Record<keyof typeof PERIOD, Window> | null;

/** What the window that refuses first had left before and after the run; unknown says so, never $0. */
const budgetChange = (before: Seen, after: Seen) => {
  const windows = budgetOf(after);
  const w = windows ? bindingWindow(windows) : undefined;
  if (!w) return "no USD budget limit read";
  const left = (v: string | null | undefined) => (v == null ? "unknown" : usd(Number(v)));
  return `${PERIOD[w.period].toLowerCase()} budget left ${left(budgetOf(before)?.[w.period]?.remaining_usd)} → ${left(w.remaining_usd)}`;
};

/** Retained runs, newest last, and Run now, which records a run the view then follows. */
function useRuns(onRunNow?: () => void) {
  const { setup } = useAgent();
  const unavailable = setup.executor === false ? "This instance is approve-only. Start new runs on the executor."
    : !setup.grant ? "This instance has no grant. Review grants and permissions before starting a new run." : undefined;
  const evidence = useQuery({
    queryKey: ["autopilot", "evidence", "timeline", "history"],
    queryFn: () => client.autopilot.evidence({}),
    // A run in progress is followed closely; a finished one rarely changes.
    refetchInterval: (q) => (running(q.state.data?.ticks.at(-1)) ? 3_000 : 15_000),
  });
  const run = useAttempt();
  const ticks = evidence.data?.ticks ?? [];
  const runNow = (
    <ConfirmButton
      label={run.busy ? <Spinner /> : "Run now"}
      disabled={run.busy || running(ticks.at(-1)) || Boolean(unavailable)}
      title="Run one autopilot tick on mainnet?"
      description="It shields any public balance, plans from the book as it is, quotes each leg, and executes only within the strategy's ceiling and the policy's limits."
      confirm="Run now"
      // Refresh as soon as it starts, so its first steps show while it runs.
      onConfirm={() => run.attempt(async () => { onRunNow?.(); const done = client.autopilot.tick(); setTimeout(() => evidence.refetch(), 1_000); await done; await evidence.refetch(); })}
    />
  );
  return { evidence, ticks, run, runNow, unavailable };
}

/** How a run is named in a list: when, who started it, and how it ended. */
const runLabel = (tick: Tick) =>
  `${ago(tick.at)}, ${tick.trigger === "operator" ? "Run now" : "scheduled"}: ${tick.end ? tick.end.outcome : running(tick) ? "running" : "no recorded end"}`;

/** One run: its four moments, then the receipt once it has ended. */
function RunView({ tick, preview = false }: { tick: Tick; preview?: boolean }) {
  const { data, setup } = useAgent();
  const book = data.book;
  const end = tick.end;
  const interrupted = end === null && !running(tick);
  const before = end ? seen(end.before) : null;
  const after = end ? seen(end.after) : null;
  const sent = end?.steps ?? [];

  return (
    <div className="flex flex-col gap-4">
      {!preview && setup.executor !== false && <RunUpdates key={tick.id} agentId={tick.agentId} tickId={tick.id} startedAt={tick.at} ended={Boolean(end)} />}
      {interrupted && (
        <p className="text-sm text-warning-muted-foreground">
          This run started {ago(tick.at)} and recorded no end: it was interrupted, or its outcome is unknown. Check Activity before running again.
        </p>
      )}
      <Card>
        {!end ? <p role="status">{interrupted ? "Current stage and outcome are unknown." : "Run started. Detailed observations are available when its end is recorded."}</p> : <>
          <h3 className="font-medium">Recorded observations</h3>
          <p>Run outcome: {end.outcome}{end.refusal ? ` · refused: ${refusalText(end.refusal)}` : ""}</p>
          <dl className="grid gap-2 text-sm">
            <dt>The book before</dt><dd>{before ? `${pct(before.driftBps)} from target` : "Observation unavailable"}</dd>
            <dt>The plan</dt><dd>{end.plan ? `${end.plan.legs.length} legs · ${usd(end.plan.usd)}` : "No plan recorded"}</dd>
            <dt>Operation results</dt><dd>{sent.length ? `${sent.filter((s) => s.status === "SUCCESS").length} of ${sent.length} recorded swaps succeeded` : "No swap results recorded"}. {end.shields.length} shield results recorded.</dd>
            <dt>Budget and book after</dt><dd>{after ? `${pct(after.driftBps)} from target; ${budgetChange(end.before, end.after)}` : "Observation unavailable"}</dd>
          </dl>
          <p className="text-sm text-muted-foreground">A recorded end does not prove every operation settled. Activity shows subsequent recorded outcomes.</p>
        </>}
      </Card>

      {end && !preview && (
        <Card>
          <h3 className="font-medium">Receipt</h3>
          {end.plan ? (
            <ul className="flex flex-col divide-y text-sm">
              {end.plan.legs.map((leg, i) => {
                const step = sent.find((s) => s.index === i);
                return (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {amountOf(leg.amount, leg.from, book)} → {amountOf(leg.amountOut, leg.to, book)}{" "}
                      <span className="text-muted-foreground">· quoted cost {leg.costBps} bps</span>
                    </span>
                    {step ? (
                      <span className="flex items-center gap-2">
                        <StatusBadge status={step.status} failureCode={step.failureCode} />
                        <Link to="/activity" hash={`operation-${step.correlationId}`} className="font-mono text-xs underline" title={step.correlationId}>Inspect {step.correlationId.slice(0, 12)}…</Link>
                      </span>
                    ) : (
                      <Badge>No result recorded</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{end.outcome}</p>
          )}
          {end.shields.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Shielded first: {end.shields.map((s) => <Link key={s.correlationId} to="/activity" hash={`operation-${s.correlationId}`}><Badge tone={statusTone(s.status)}>{s.asset.replace(/^nep141:/, "")} · {s.status.toLowerCase()} · inspect</Badge></Link>)}
            </p>
          )}
          {end.rejected.length > 0 && <p className="text-sm text-warning-muted-foreground">Execution stopped: {end.rejected.join("; ")}</p>}
          <p className="text-xs text-muted-foreground">
            Recorded {new Date(tick.at).toLocaleString()} → {new Date(end.endedAt).toLocaleString()} · policy revision {tick.policy.revision ?? "–"} ·
            build {tick.build.deployment ?? "local"}
          </p>
        </Card>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/activity" className={end || interrupted ? "inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 font-medium hover:bg-accent" : "underline"}>Check operation outcomes in Activity</Link>
        {end?.plan && <Link to="/automations" hash="rebalance" className="underline">Create a fresh rebalance preview</Link>}
      </div>
      {!preview && <RunDownload key={tick.id} tickId={tick.id} agentId={tick.agentId} />}
    </div>
  );
}

/** The latest recorded run on Overview; the full history and controls have one destination. */
export function RunPreview() {
  const { evidence, ticks } = useRuns();
  const latest = ticks.at(-1);
  const autopilot = useQuery({ queryKey: ["autopilot"], queryFn: () => client.autopilot.get() });
  return (
    <Section
      title="Latest treasury run"
      description={latest ? undefined : evidence.isPending ? "Loading recorded runs…" : evidence.error ? "Recorded runs could not be read." : "No autopilot run found in this executor’s retained records."}
      action={<Link to="/follow/run" className="text-sm font-medium underline">View treasury runs →</Link>}
    >
      {evidence.error && <QueryError error={evidence.error} retry={() => evidence.refetch()} />}
      {autopilot.error && <QueryError error={autopilot.error} retry={() => autopilot.refetch()} />}
      {autopilot.data && <p className="text-sm text-muted-foreground">
        {autopilot.data.on ? `Schedule on: every ${autopilot.data.everyMin} minutes; configured rebalance limit ${usd(autopilot.data.maxUsd)} per run.` : "Autopilot is off."}{" "}
        <Link to="/automations" className="underline">Automation settings</Link>
      </p>}
      {evidence.isPending ? <Loading label="Loading recorded runs…" /> : latest && <Card>
        <p className="font-medium">{runLabel(latest)}</p>
        {latest.end ? <>
          <p className="text-sm">{budgetChange(latest.end.before, latest.end.after)}</p>
          {latest.end.refusal && <p>Refused: {refusalText(latest.end.refusal)}</p>}
          {latest.end.rejected.length > 0 && <p>Execution stopped: {latest.end.rejected.join("; ")}</p>}
          {[...latest.end.steps, ...latest.end.shields].some((s) => s.status !== "SUCCESS") && <p>Some recorded operations did not report success. Review their outcomes.</p>}
        </> : <p>{running(latest) ? "Detailed observations are available when the end is recorded." : "No end recorded: it was interrupted, or its outcome is unknown. Check Activity before running again."}</p>}
        <Link to="/follow/run" search={{ run: latest.id }} className="text-sm underline">Inspect run</Link>
      </Card>}
    </Section>
  );
}

/** "Follow this run": latest by default, with any retained run selectable for review/export. */
export function RunTimeline() {
  const { run: picked } = useSearch({ from: "/follow/run" });
  const navigate = useNavigate();
  const setPicked = (run?: string) => { void navigate({ to: "/follow/run", search: { run }, replace: true }); };
  const { evidence, ticks, run, runNow, unavailable } = useRuns(() => setPicked(undefined));
  const tick = picked ? ticks.find((t) => t.id === picked) : ticks.at(-1);
  if (evidence.error && !evidence.data) return <QueryError error={evidence.error} retry={() => evidence.refetch()} />;
  if (!evidence.data) return <Loading label="Loading recorded runs…" />;
  return (
    <Section
      title="Follow this run"
      description={tick ? `An autopilot run, ${tick.trigger === "operator" ? "started by Run now" : "on its schedule"}, ${ago(tick.at)}. Each step is what the scheduler recorded.` : picked ? "The selected run was not found in this executor’s retained records." : "No autopilot run found in this executor’s retained records."}
    >
      <ErrorBox error={run.error} />
      {evidence.error && <QueryError error={evidence.error} retry={() => evidence.refetch()} />}
      {ticks.length > 0 && <label className="flex flex-col gap-2 text-sm">
        Run to view
        <select className="rounded-lg border bg-background p-2" value={picked ?? ""} onChange={(e) => setPicked(e.target.value || undefined)}>
          <option value="">Latest run</option>
          {picked && !tick && <option value={picked}>Selected run no longer listed</option>}
          {[...ticks].reverse().map((t) => <option key={t.id} value={t.id}>{runLabel(t)}</option>)}
        </select>
      </label>}
      {tick && <RunView key={tick.id} tick={tick} />}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <div className="max-w-prose text-sm">
          <h3 className="font-medium">Start a new run</h3>
          <p className="text-muted-foreground">{unavailable ?? "Run now starts an autopilot tick using the current book and policy."}</p>
        </div>
        {runNow}
      </div>
    </Section>
  );
}
