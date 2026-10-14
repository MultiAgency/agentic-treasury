import { TaskEvidence } from "../evidence/task-evidence";
import { ConfirmButton } from "../owner/confirm-button";
import { SCHEDULE_STOPPED, SCHEDULE_STOP_SCOPE } from "../../shared/schedule-copy";
import { queries } from "../../shared/queries";
import { ArrowRight, ArrowsLeftRight, CheckCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { StrategyWorkflow } from "./strategy-workflow";
import { amount, client, kindOf, swaps, useAttempt, useRun, usd } from "../../shared/lib";
import { useIsOperator } from "../../app/viewer";
import { useAgent } from "../../app/agent-context";
import { Badge, Button, Card, CardHeader, Dot, Empty, ErrorBox, Loading, QueryError, Note, NotExecuted, Section, Spinner, StatusBadge, statusTone } from "../../shared/ui";

function Rebalance() {
  const operator = useIsOperator();
  const executor = useAgent().setup.executor !== false;
  const hasGrant = Boolean(useAgent().setup.grant);
  const { data } = useAgent();
  const split = data.book.map((h) => `${Math.round((data.target[h.asset] ?? 0) * 100)}% ${h.symbol}`).join(" / ");
  const preview = useRun(client.rebalance, []);
  const execution = useRun(client.executePlan);
  const busy = preview.state === "running" || execution.state === "running";
  const plan = preview.events.find((e) => e.type === "plan");
  const saved = preview.events.find((e) => e.type === "saved");
  const executed = !!saved && execution.input?.planId === saved.plan.id && execution.state !== "idle";
  const rejected = execution.events.find((e) => e.type === "rejected");

  return (
    <Card className="lg:col-span-2 lg:row-span-2">
      <CardHeader
        icon={<ArrowsLeftRight size={20} weight="bold" />}
        title="Rebalance"
        description={`Swap toward ${split}. Legs under ${usd(data.rebalance.minLegUsd)} are left alone; legs that could cost over ${data.rebalance.maxCostBps} bps are skipped.`}
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
                  <StatusBadge status={done.status} failureCode={done.failureCode}>
                    Swap{" "}
                  </StatusBadge>
                )}
                {step !== undefined && !done && execution.state === "running" && <Spinner />}
              </div>
            </div>
          );
        })}
        {rejected?.type === "rejected" && <NotExecuted problems={rejected.problems} again="Preview" />}
        <ErrorBox error={preview.error ?? execution.error} />
        {(executed || execution.error) && <Link to="/activity" className="text-sm underline">Review operation outcomes before another preview</Link>}
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {saved
            ? `Valid until ${new Date(saved.plan.expiresAt).toLocaleTimeString()} · budget remaining ${usd(plan?.budget)}`
            : plan && plan.legs.length > 0 && preview.state === "done"
              ? "Every leg costs more than it is worth: nothing to execute."
              : plan && `Budget remaining ${usd(plan.budget)}`}
        </span>
        <div className="flex gap-3">
          <Button variant="outline" disabled={busy || !operator || !executor || !hasGrant} onClick={() => preview.run(undefined)}>
            {preview.state === "running" ? <Spinner /> : null}
            Preview
          </Button>
          <ConfirmButton
            label={execution.state === "running" ? <><Spinner /> Executing</> : "Execute"}
            disabled={busy || !saved || executed || !executor || !hasGrant}
            title="Execute the previewed rebalance on mainnet?"
            description="Runs the previewed swaps exactly as shown, under the agent's grant, each held to its previewed floor. Actions run in sequence. Checks run before execution and before later actions; if execution stops, earlier completed actions remain."
            confirm="Execute swaps"
            onConfirm={() => saved && execution.run({ planId: saved.plan.id })}
          />
        </div>
      </div>
    </Card>
  );
}

/** Existing Payables schedules can be stopped without offering Treasury configuration. */
export function PayablesSchedule() {
  const operator = useIsOperator();
  const executor = useAgent().setup.executor !== false;
  const status = useQuery({ ...queries.autopilot, retry: false });
  const { busy, error, message, attempt } = useAttempt();
  if (status.error) return <QueryError error={status.error} retry={() => status.refetch()} />;
  if (status.isPending) return <Loading label="Checking for an existing schedule…" />;
  if (!status.data.on && !message) return null;
  return <Card>
    {status.data.on && <><p>An existing schedule is on. Portfolio strategy configuration is not available for Payables.</p><p>{SCHEDULE_STOP_SCOPE}</p>
      <Button variant="outline" disabled={busy || !operator || !executor} onClick={() => attempt(async () => {
        await client.autopilot.stop();
        return SCHEDULE_STOPPED;
      })}>Turn off</Button></>}
    {message && <p role="status">{message}</p>}
    <ErrorBox error={error} />
  </Card>;
}

/** The fixed strategies, each run on demand, and the autopilot that runs them unattended. */
export function Automations() {
  const operator = useIsOperator();
  const executor = useAgent().setup.executor !== false;
  const hasGrant = Boolean(useAgent().setup.grant);
  const { data } = useAgent();
  const treasury = kindOf(data) === "treasury";
  return (
    <Section title={treasury ? "Strategy" : "Shield public funds"} description={treasury ? "Configure, authorize and schedule the strategy, or preview a manual rebalance." : "Preview a sweep to shield public balances."}>
      {treasury && <TaskEvidence task="strategy" />}
      <nav className="flex flex-wrap gap-4 text-sm" aria-label="Automation actions">
        {swaps(data) && <a href="#rebalance" className="underline">Preview a rebalance</a>}
        <Link to="/funding" hash="sweep" className="underline">Preview a sweep</Link>
        {!treasury && <Link to="/policy" hash="grants" className="underline">Review or renew the grant</Link>}
      </nav>
      {(!operator || !executor) && <Note>Operators on the executor can preview, execute, and change automation settings. Members can review recorded runs.</Note>}
      {!hasGrant && <Note>A grant is required for new automation actions. <Link to="/policy" hash="grants" className="underline">Review grants and permissions</Link>.</Note>}
      {treasury ? <StrategyWorkflow /> : <PayablesSchedule />}
      {treasury && !swaps(data) && <Note>The current policy does not allow swaps. Rebalance previews are unavailable; recorded runs and strategy settings remain accessible.</Note>}
      {treasury && <Link to="/follow/run" className="self-start text-sm font-medium underline">Run autopilot once or review recorded runs →</Link>}
      <Section title="Manual actions" description="Preview a saved rebalance before choosing whether to execute it.">
        {swaps(data) && <div id="rebalance" className="scroll-mt-48 lg:col-span-2"><Rebalance /></div>}
        <div id="sweep" className="scroll-mt-48 text-sm"><Link to="/funding" hash="sweep" className="underline">Shield public funds in Balances &amp; funding</Link></div>
      </Section>
    </Section>
  );
}
