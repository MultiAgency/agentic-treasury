import { ArrowRight, ArrowsLeftRight, CheckCircle, LockKey, Timer } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ago, amount, client, queries, swaps, useAttempt, useRun, usd } from "./lib";
import { useAgent } from "./shell";
import { Badge, Button, Card, CardHeader, ConfirmButton, Dot, Empty, ErrorBox, input, Note, NotExecuted, Section, Spinner, StatusBadge, statusTone } from "./ui";

function Rebalance() {
  const { data } = useAgent();
  const split = data.book.map((h) => `${Math.round((data.target[h.asset] ?? 0) * 100)}% ${h.symbol}`).join(" / ");
  const preview = useRun(client.rebalance);
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

function Sweep() {
  const { events, state, input, error, run } = useRun(client.sweep);
  const running = state === "running";
  const plan = events.find((e) => e.type === "plan");
  const shields = events.filter((e) => e.type === "shield");
  const exposed = plan?.exposed ?? [];

  return (
    <Card>
      <CardHeader
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
                <StatusBadge status={shield.status} failureCode={shield.failureCode}>
                  Shield{" "}
                </StatusBadge>
              )}
            </div>
          );
        })}
        <ErrorBox error={error} />
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

/**
 * The agent working on its own (src/autopilot.ts). Each tick sweeps, then previews a rebalance and
 * executes it only when its swaps are worth no more than the limit; anything larger waits for the owner.
 */
function Autopilot() {
  const status = useQuery({ queryKey: ["autopilot"], queryFn: () => client.autopilot.get(), refetchInterval: 30_000 });
  const inbox = useQuery(queries.inbox);
  const [draft, setDraft] = useState<{ everyMin: string; maxUsd: string }>();
  const { error, busy, attempt } = useAttempt();
  if (!status.data) return null;
  const s = status.data;
  const form = draft ?? { everyMin: String(s.everyMin), maxUsd: String(s.maxUsd) };
  const everyMin = Number(form.everyMin);
  const maxUsd = Number(form.maxUsd);
  const valid = Number.isInteger(everyMin) && everyMin >= 5 && Number.isInteger(maxUsd) && maxUsd >= 0;
  const runs = (inbox.data ?? []).filter((e) => e.level === "run").slice(0, 5);

  const act = (work: () => Promise<unknown>) =>
    attempt(async () => {
      await work();
      setDraft(undefined);
    });
  const save = (on: boolean) => act(() => client.autopilot.set({ on, everyMin, maxUsd }));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <CardHeader
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
      <ErrorBox error={error} />
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
      <div className="grid gap-6 lg:grid-cols-2">
        {swaps(data) && <Rebalance />}
        <Sweep />
      </div>
    </Section>
  );
}
