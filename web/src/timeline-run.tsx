import { useQuery } from "@tanstack/react-query";
import { bindingWindow } from "../../src/budget-window.js";
import { PERIOD } from "./budget";
import { ago, amountOf, client, usd, useAttempt } from "./lib";
import { useAgent } from "./shell";
import { Badge, Card, ConfirmButton, ErrorBox, Section, Spinner, Step, StatusBadge, statusTone } from "./ui";
import { refusalText } from "./words";

/**
 * "Follow this run": the treasury autopilot's latest tick as a timeline that doubles as its receipt,
 * read from the evidence the scheduler itself records (src/evidence.ts): the book before, the quoted
 * plan, each send's outcome, the budget before and after, and the book after. Members only.
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

export function RunTimeline() {
  const { data } = useAgent();
  const evidence = useQuery({
    queryKey: ["autopilot", "evidence", "timeline"],
    queryFn: () => client.autopilot.evidence({ since: new Date(Date.now() - DAY).toISOString() }),
    // A tick in progress is followed closely; a finished one rarely changes.
    refetchInterval: (q) => (running(q.state.data?.ticks.at(-1)) ? 3_000 : 15_000),
  });
  const run = useAttempt();
  const tick = evidence.data?.ticks.at(-1);
  const book = data.book;

  const runNow = (
    <ConfirmButton
      label={run.busy ? <Spinner /> : "Run now"}
      disabled={run.busy || running(tick)}
      title="Run one autopilot tick on mainnet?"
      description="It plans from the book as it is, quotes each leg, and executes only within the strategy's ceiling and the policy's limits."
      confirm="Run"
      onConfirm={() => run.attempt(async () => { await client.autopilot.tick(); await evidence.refetch(); })}
    />
  );

  if (evidence.error) return <ErrorBox error={evidence.error.message} />;
  if (!evidence.data) return <Spinner />;
  if (!tick)
    return (
      <Section title="Follow this run" description="No autopilot run in the last day." action={runNow}>
        <ErrorBox error={run.error} />
      </Section>
    );

  const end = tick.end;
  const interrupted = end === null && !running(tick);
  const before = end ? seen(end.before) : null;
  const after = end ? seen(end.after) : null;
  const sent = end?.steps ?? [];
  const status = (done: boolean, started = true): "complete" | "current" | "upcoming" => (done ? "complete" : started ? "current" : "upcoming");

  return (
    <Section
      title="Follow this run"
      description={`The autopilot's latest run, ${tick.trigger === "operator" ? "started by Run now" : "on its schedule"}, ${ago(tick.at)}. Each step is what the scheduler recorded.`}
      action={runNow}
    >
      <ErrorBox error={run.error} />
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
    </Section>
  );
}
