import { Robot, ShieldCheck } from "@phosphor-icons/react";
import { useState } from "react";
import { amountOf, client, useRun } from "./lib";
import { useAgent } from "./shell";
import { Badge, Button, Card, CardHeader, ConfirmButton, Empty, ErrorBox, NotExecuted, Spinner, StatusBadge, statusTone } from "./ui";

/** A tool result that starts like this was stopped by the policy or the cost cap, or not proposed. */
const resultTone = (result: string) =>
  /^(REFUSED|ERROR)/.test(result) ? "destructive" : /^(NOT PROPOSED|ALREADY)/.test(result) ? "warning" : /^PROPOSED/.test(result) ? "info" : "neutral";

export function Steward() {
  const { data } = useAgent();
  const symbol = (asset: string) => data.book.find((h) => h.asset === asset)?.symbol ?? asset;
  const proposal = useRun(client.steward.propose, []);
  const execution = useRun(client.executePlan);
  const [instruction, setInstruction] = useState("");
  const busy = proposal.state === "running" || execution.state === "running";
  const plan = proposal.events.find((e) => e.type === "plan")?.plan;
  const executed = execution.input?.planId === plan?.id && execution.state !== "idle";

  return (
    <Card>
      <CardHeader
        icon={<Robot size={20} weight="bold" />}
        title="Steward (experimental)"
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
                    ? `swap ${amountOf(action.amount, action.from, data.book)} → ${symbol(action.to)} · floor ${amountOf(action.minAmountOut, action.to, data.book)} · ${action.costBps} bps`
                    : `shield ${amountOf(action.amount, action.asset, data.book)}`}
                  {done?.type === "action" && done.shield && (
                    <Badge tone={statusTone(done.shield.status)}>shield {done.shield.status.toLowerCase()}</Badge>
                  )}
                  {done?.type === "action" && <StatusBadge status={done.status} failureCode={done.failureCode} />}
                </div>
              );
            })}
          </div>
        )}
        {execution.events.map((event, i) =>
          event.type === "rejected" ? <NotExecuted key={i} problems={event.problems} again="Propose" /> : null,
        )}
        <ErrorBox error={proposal.error ?? execution.error} />
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
            description="Runs the proposed steps exactly as shown, under the agent's grant, each swap held to its previewed floor. Actions run in sequence. Checks run before execution and before later actions; if execution stops, earlier completed actions remain."
            confirm="Execute plan"
            onConfirm={() => plan && execution.run({ planId: plan.id })}
          />
        </div>
      </div>
    </Card>
  );
}
