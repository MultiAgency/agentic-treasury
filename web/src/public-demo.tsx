import { useEffect, useId, useMemo, useRef, useState } from "react";
import { demoEvents, demoState, demoSteps, type DemoKind, type DemoScenario, type DemoState } from "./demo-events";

const control = "inline-flex min-h-11 items-center justify-center rounded-full border border-border-strong px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed";
const select = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-card px-3 text-foreground";
const stages = {
  facilitator: ["Invoice", "Held payout", "Owner approval", "Outcome"],
  treasury: ["Strategy", "Plan", "Authorization", "Outcome"],
};

export function ExampleContext({ state }: { state: DemoState }) {
  if (state.invoice) return <div className="rounded-lg border bg-card p-4">
    <h5 className="mb-3 font-semibold">Fictional invoice</h5>
    <dl className="grid gap-3 text-sm">
      <div><dt className="text-muted-foreground">Agreed payee</dt><dd>{state.invoice.payee}</dd></div>
      <div><dt className="text-muted-foreground">Work to review</dt><dd>{state.invoice.work}</dd></div>
      <div><dt className="text-muted-foreground">Terms</dt><dd>{state.invoice.terms}</dd></div>
      <div><dt className="text-muted-foreground">Payout status</dt><dd className="font-medium capitalize">{state.invoice.status}</dd></div>
    </dl>
  </div>;
  const allocation = state.allocation;
  if (!allocation) return null;
  return <div className="rounded-lg border bg-card p-4">
    <h5 className="mb-3 font-semibold">Illustrative allocation</h5>
    <table className="w-full table-fixed text-left text-xs sm:text-sm">
      <caption className="sr-only">Example asset allocation in percent</caption>
      <thead><tr><th scope="col" className="w-2/5 pb-2">Asset</th><th scope="col" className="pb-2">{allocation.result ? "Result" : "Current"}</th><th scope="col" className="pb-2">Target</th></tr></thead>
      <tbody>{allocation.assets.map((asset, i) => <tr key={asset}>
        <th scope="row" className="py-2 pr-2 font-normal">{asset}</th>
        <td className="py-2 pr-2 tabular-nums">{(allocation.result ?? allocation.before)[i]}%<div aria-hidden="true" className="mt-1 h-1.5 rounded bg-muted"><div className="h-full rounded bg-brand-strong" style={{ width: `${(allocation.result ?? allocation.before)[i]}%` }} /></div></td>
        <td className="py-2 tabular-nums">{allocation.target[i]}%<div aria-hidden="true" className="mt-1 h-1.5 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${allocation.target[i]}%` }} /></div></td>
      </tr>)}</tbody>
    </table>
    {state.stage >= 1 && state.tone !== "refusal" && <p className="mt-3 border-t pt-3 text-sm">{allocation.plan}</p>}
  </div>;
}

/** Browser-only AG-UI playback. Never imports the private recording viewer or action clients. */
export function PublicDemo({ kind, overview }: { kind: DemoKind; overview: string[][] }) {
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<DemoScenario>("standard");
  const [permission, setPermission] = useState(true);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const events = useMemo(() => demoEvents(kind, scenario, permission), [kind, scenario, permission]);
  const positions = useMemo(() => demoSteps(events), [events]);
  const eventIndex = positions[step]!;
  const state = demoState(events, eventIndex);
  const finished = step === positions.length - 1;
  const name = kind === "facilitator" ? "Payables" : "Treasury";

  useEffect(() => {
    if (!open || !playing || finished || state.approval) return;
    const timer = window.setTimeout(() => setStep(i => Math.min(i + 1, positions.length - 1)), 6000);
    return () => window.clearTimeout(timer);
  }, [open, playing, step, finished, state.approval, positions.length]);

  useEffect(() => {
    if (!finished && !state.approval) return;
    setPlaying(false);
    // Only move focus when the playback control holding it becomes unavailable.
    if (actions.current?.contains(document.activeElement)) {
      if (finished) status.current?.focus({ preventScroll: true });
      else next.current?.focus({ preventScroll: true });
    }
  }, [finished, state.approval]);

  useEffect(() => {
    const pause = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);

  useEffect(() => {
    if (!open || !panel.current) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry && !entry.isIntersecting) setPlaying(false); });
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [open]);

  function reset() { setPlaying(false); setStep(0); }
  const labels = !permission ? [stages[kind][0], "Refusal"] : stages[kind];
  return <div className="flex flex-col gap-4">
    {!open && <ol className="flex flex-col gap-4">{overview.map(([title, detail], i) => <li key={title} className="grid grid-cols-[2rem_1fr] gap-3">
      <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-brand-muted text-sm font-semibold text-brand-strong">{i + 1}</span>
      <div><p className="font-medium">{title}</p><p className="mt-1 text-sm text-muted-foreground">{detail}</p></div>
    </li>)}</ol>}
    <button type="button" aria-expanded={open} aria-controls={id} className={`${control} self-start`} onClick={() => { setOpen(!open); setPlaying(false); }}>
      {open ? "Close demo" : "Try a quick demo"}
    </button>
    {open && <section ref={panel} id={id} aria-label={`${name} simulation`} className="flex min-w-0 flex-col gap-4 rounded-xl border bg-muted p-4 sm:p-5">
      <div>
        <h4 className="font-semibold">Interactive simulation · No real funds</h4>
        <p className="mt-1 text-sm text-muted-foreground">Fictional examples. Step through at your own pace, or play at six seconds per step. This is not mainnet evidence.</p>
      </div>
      {kind === "treasury" && <label className="flex flex-col gap-2 text-sm font-medium">Example strategy
        <select value={scenario} onChange={e => { reset(); setScenario(e.target.value as DemoScenario); }} className={select}>
          <option value="standard">Balanced allocation</option><option value="reserve">Larger stablecoin reserve</option>
        </select>
      </label>}
      <label className="flex flex-col gap-2 text-sm font-medium">Owner permission to act
        <select value={permission ? "active" : "absent"} onChange={e => { reset(); setPermission(e.target.value === "active"); }} className={select}>
          <option value="active">Active grant</option><option value="absent">No live grant</option>
        </select>
        <span className="font-normal text-muted-foreground">A grant permits the server to act for the agent. Change this to see where execution stops.</span>
      </label>
      <ol aria-label="Workflow progress" className="grid grid-cols-2 gap-2 text-xs">
        {labels.map((label, i) => <li key={label} aria-current={step === i ? "step" : undefined} className={`rounded-lg border px-3 py-2 ${step === i ? "border-brand-strong bg-card font-semibold" : "text-muted-foreground"}`}>
          {i < step ? "✓ " : `${i + 1}. `}{label}{step === i ? " · Current" : ""}
        </li>)}
      </ol>
      <ExampleContext state={state} />
      <div ref={status} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" className={`rounded-lg border-l-4 p-4 ${state.tone === "refusal" ? "border-warning-muted-foreground bg-warning-muted" : state.tone === "success" ? "border-success-muted-foreground bg-success-muted" : "border-brand-strong bg-card"}`}>
        <p className="mb-2 text-xs text-muted-foreground">{finished ? "Simulation ended" : state.approval ? "Waiting for owner review" : playing ? "Playing" : "Guided walkthrough"}</p>
        <p className="font-semibold">{state.title}</p><p className="mt-2 text-sm leading-relaxed">{state.detail}</p>
      </div>
      <div ref={actions} className="flex flex-wrap gap-2">
        <button ref={next} type="button" className={`${control} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={finished} onClick={() => { setPlaying(false); setStep(i => i + 1); }}>{state.approval ? "Simulate owner approval" : "Next step"}</button>
        <button type="button" className={control} disabled={step === 0} onClick={() => { setPlaying(false); setStep(i => i - 1); }}>Previous step</button>
        <button type="button" className={control} disabled={finished || state.approval} onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
        <button type="button" className={control} onClick={reset}>Restart</button>
      </div>
      {step > 0 && <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3 font-medium hover:text-brand-strong">Review earlier steps</summary>
        <ol className="space-y-3">{positions.slice(0, step).map(position => { const past = demoState(events, position); return <li key={position}><p className="font-medium">{past.title}</p><p className="text-muted-foreground">{past.detail}</p></li>; })}</ol>
      </details>}
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer py-3 font-medium hover:text-brand-strong">Inspect simulated AG-UI events</summary>
        <pre className="max-h-64 overflow-auto rounded-lg bg-card p-3 text-xs whitespace-pre-wrap break-all">{JSON.stringify(events.slice(0, finished ? events.length : eventIndex + 1), null, 2)}</pre>
      </details>
      <a href={`#${kind}-requirements`} className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 hover:text-brand-strong">See demonstrated behavior and limitations</a>
    </section>}
  </div>;
}
