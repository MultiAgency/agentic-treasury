import { useQuery } from "@tanstack/react-query";
import { bindingWindow } from "../../src/budget-window.js";
import { PERIOD } from "./budget";
import { ago, amountOf, client, usd, useAttempt } from "./lib";
import { useAgent } from "./shell";
import { Badge, Card, ConfirmButton, Details, ErrorBox, Section, Spinner, Step, StatusBadge, statusTone } from "./ui";
import { refusalText } from "./words";

/**
 * An autopilot run as a timeline that doubles as its receipt, read from the evidence the scheduler itself
 * records (src/evidence.ts): the book before, the quoted plan, each send's outcome, the budget before and
 * after, and the book after. One view in two places: under the Autopilot on Automations, where Run now is
 * pressed and the run plays out, with earlier runs to open; and full page at "Follow this run", to link
 * to. Members only.
 */

type Ticks = Awaited<ReturnType<typeof client.autopilot.evidence>>;
type Tick = Ticks["ticks"][number];
type Seen = NonNullable<Tick["end"]>["before"];
type Window = { limit_usd: string | null; remaining_usd: string | null };

const DAY = 86_400_000;
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

/** The last day's runs, newest last, and Run now, which records a run the view then follows. */
function useRuns() {
  const evidence = useQuery({
    queryKey: ["autopilot", "evidence", "timeline"],
    queryFn: () => client.autopilot.evidence({ since: new Date(Date.now() - DAY).toISOString() }),
    // A run in progress is followed closely; a finished one rarely changes.
    refetchInterval: (q) => (running(q.state.data?.ticks.at(-1)) ? 3_000 : 15_000),
  });
  const run = useAttempt();
  const ticks = evidence.data?.ticks ?? [];
  const runNow = (
    <ConfirmButton
      label={run.busy ? <Spinner /> : "Run now"}
      disabled={run.busy || running(ticks.at(-1))}
      title="Run one autopilot tick on mainnet?"
      description="It shields any public balance, plans from the book as it is, quotes each leg, and executes only within the strategy's ceiling and the policy's limits."
      confirm="Run now"
      // Refresh as soon as it starts, so its first steps show while it runs.
      onConfirm={() => run.attempt(async () => { const done = client.autopilot.tick(); setTimeout(() => evidence.refetch(), 1_000); await done; await evidence.refetch(); })}
    />
  );
  return { evidence, ticks, run, runNow };
}

/** A quiet run found the book on target and nothing to shield, the autopilot's two "nothing done" outcomes (src/autopilot.ts); every other run is worth opening. */
const QUIET = new Set(["book on target", "Nothing to do."]);
const eventful = (tick: Tick) => !tick.end || !QUIET.has(tick.end.outcome);

/** How a run is named in a list: when, who started it, and how it ended. */
const runLabel = (tick: Tick) =>
  `${ago(tick.at)}, ${tick.trigger === "operator" ? "Run now" : "scheduled"}: ${tick.end ? tick.end.outcome : running(tick) ? "running" : "no recorded end"}`;

/** One run: its four moments, then the receipt once it has ended. */
function RunView({ tick }: { tick: Tick }) {
  const { data } = useAgent();
  const book = data.book;
  const end = tick.end;
  const interrupted = end === null && !running(tick);
  const before = end ? seen(end.before) : null;
  const after = end ? seen(end.after) : null;
  const sent = end?.steps ?? [];
  const status = (done: boolean, started = true): "complete" | "current" | "upcoming" => (done ? "complete" : started ? "current" : "upcoming");

  return (
    <div className="flex flex-col gap-4">
      {interrupted && (
        <p className="text-sm text-warning-muted-foreground">
          This run started {ago(tick.at)} and recorded no end: it was interrupted, or its outcome is unknown. Check Activity before running again.
        </p>
      )}
      <Card>
        <ol>
          <Step number={1} title="The book before" status={status(Boolean(before), true)}
            summary={before ? `${pct(before.driftBps)} from target at ${new Date(before.at).toLocaleTimeString()}` : undefined}>
            <span className="text-sm text-muted-foreground">Reading balances and the policy…</span>
          </Step>
          <Step number={2} title="The plan, quoted" status={status(Boolean(end), Boolean(before))}
            summary={end ? (end.plan ? `${end.plan.legs.length} leg${end.plan.legs.length === 1 ? "" : "s"}, ${usd(end.plan.usd)}` : end.outcome) : undefined}>
            <span className="text-sm text-muted-foreground">Planning and quoting each leg…</span>
          </Step>
          <Step number={3} title="The sends" status={status(Boolean(end), Boolean(end?.plan))}
            summary={end ? (sent.length ? `${sent.filter((s) => s.status === "SUCCESS").length} of ${sent.length} settled` : end.refusal ? `refused · ${refusalText(end.refusal)}` : "nothing sent") : undefined}>
            <span className="text-sm text-muted-foreground">Each leg settles in about a minute…</span>
          </Step>
          <Step number={4} title="Budget and book after" status={status(Boolean(after))} last
            summary={after ? `${pct(after.driftBps)} from target; ${budgetChange(end!.before, end!.after)}` : undefined} />
        </ol>
      </Card>

      {end && (
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
                        <span className="font-mono text-xs text-muted-foreground" title={step.correlationId}>{step.correlationId.slice(0, 12)}…</span>
                      </span>
                    ) : (
                      <Badge>not sent</Badge>
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
              Shielded first: {end.shields.map((s) => <Badge key={s.correlationId} tone={statusTone(s.status)}>{s.asset.replace(/^nep141:/, "")} · {s.status.toLowerCase()}</Badge>)}
            </p>
          )}
          {end.rejected.length > 0 && <p className="text-sm text-warning-muted-foreground">Not executed: {end.rejected.join("; ")}</p>}
          <p className="text-xs text-muted-foreground">
            Recorded {new Date(tick.at).toLocaleString()} → {new Date(end.endedAt).toLocaleString()} · policy revision {tick.policy.revision ?? "–"} ·
            build {tick.build.deployment ?? "local"}
          </p>
        </Card>
      )}
    </div>
  );
}

/** Under the Autopilot on Automations: the latest run, played out where Run now is pressed, and the day's earlier runs to open. */
export function Runs() {
  const { evidence, ticks, run, runNow } = useRuns();
  const latest = ticks.at(-1);
  const earlier = ticks.slice(0, -1).reverse();
  const shown = earlier.filter(eventful);
  const quiet = earlier.length - shown.length;
  return (
    <Section
      title="Latest run"
      description={latest ? `${latest.trigger === "operator" ? "Started by Run now" : "On its schedule"}, ${ago(latest.at)}. Each step is what the scheduler recorded.` : "No run in the last day. Run now plays one out here."}
      action={runNow}
    >
      <ErrorBox error={run.error ?? evidence.error?.message} />
      {!evidence.data ? <Spinner /> : latest && <RunView tick={latest} />}
      {earlier.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Earlier, in the last day</h3>
          {shown.map((tick) => (
            <Details key={tick.id} summary={runLabel(tick)}>
              <RunView tick={tick} />
            </Details>
          ))}
          {quiet > 0 && (
            <p className="text-sm text-muted-foreground">
              {quiet} other run{quiet === 1 ? "" : "s"} had nothing to do: the book was on target.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/** "Follow this run": the latest run, full page, to link to. */
export function RunTimeline() {
  const { evidence, ticks, run, runNow } = useRuns();
  const tick = ticks.at(-1);
  if (evidence.error) return <ErrorBox error={evidence.error.message} />;
  if (!evidence.data) return <Spinner />;
  return (
    <Section
      title="Follow this run"
      description={tick ? `The autopilot's latest run, ${tick.trigger === "operator" ? "started by Run now" : "on its schedule"}, ${ago(tick.at)}. Each step is what the scheduler recorded.` : "No autopilot run in the last day."}
      action={runNow}
    >
      <ErrorBox error={run.error} />
      {tick && <RunView tick={tick} />}
    </Section>
  );
}
