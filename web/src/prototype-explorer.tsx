import { useEffect, useMemo, useRef, useState } from "react";
import { demoEvents, demoState, demoSteps, type DemoKind } from "./demo-events";
import { ExampleContext } from "./public-demo";

const action = "inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-5 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
const link = "inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4 hover:text-brand-strong";
const field = "min-h-11 w-full rounded-lg border border-border-strong bg-card px-3 py-2";

/** Separate public example routes. Never mount an authenticated dashboard or import its clients. */
export function PrototypeExplorer({ area, page }: { area: "payables" | "treasury"; page: string }) {
  const kind: DemoKind = area === "payables" ? "facilitator" : "treasury";
  const name = area === "payables" ? "Payables" : "Treasury";
  const [strategy, setStrategy] = useState<"standard" | "reserve">("standard");
  const [permission, setPermission] = useState(true);
  const [step, setStep] = useState(0);
  const [work, setWork] = useState("One completed design milestone");
  const main = useRef<HTMLElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const focusOutcome = useRef(false);
  const events = useMemo(() => demoEvents(kind, strategy, permission), [kind, strategy, permission]);
  const positions = demoSteps(events);
  const state = demoState(events, positions[step]!);
  const display = state.invoice ? { ...state, invoice: { ...state.invoice, work } } : state;
  const complete = step === positions.length - 1;
  const tabs = area === "payables"
    ? [["overview", "Overview"], ["agreements", "Agreements"], ["invoices", "Invoices"], ["activity", "Activity"], ["policy", "Policy"]]
    : [["overview", "Overview"], ["automations", "Automations"], ["activity", "Activity"], ["policy", "Policy"]];
  const current = tabs.find(([slug]) => slug === page);
  const href = (slug: string) => `#/explore/${area}/${slug}`;
  useEffect(() => { main.current?.focus({ preventScroll: true }); }, [page]);
  useEffect(() => {
    if (focusOutcome.current) {
      result.current?.focus({ preventScroll: true });
      focusOutcome.current = false;
    }
  }, [step]);
  function reset() { setStep(0); }
  function advance() {
    focusOutcome.current = step + 1 === positions.length - 1 && Boolean(main.current?.contains(document.activeElement));
    setStep(s => Math.min(s + 1, positions.length - 1));
  }

  const outcome = <div ref={result} tabIndex={-1} role="status" aria-live="polite" className={`rounded-xl border p-5 ${state.tone === "refusal" ? "bg-warning-muted" : state.tone === "success" ? "bg-success-muted" : "bg-muted"}`}>
    <h2 className="text-xl font-semibold">{state.title}</h2><p className="mt-2 leading-relaxed">{state.detail}</p>
  </div>;
  return <div className="mx-auto max-w-6xl px-4 py-6 sm:p-8">
    <a href="#example-main" className="sr-only focus:not-sr-only" onClick={e => { e.preventDefault(); main.current?.focus(); }}>Skip to main content</a>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-5">
      <a className={link} href="/">Back to landing page</a>
      <span className="rounded-full bg-brand-muted px-4 py-2 text-sm font-medium text-brand-strong">Example workspace · No real funds</span>
    </header>
    <div className="grid gap-8 py-8 lg:grid-cols-[12rem_1fr]">
      <aside>
        <p className="mb-5 text-2xl font-semibold">{name}</p>
        <nav aria-label={`${name} prototype`} className="flex flex-wrap gap-2 lg:flex-col">{tabs.map(([slug, label]) =>
          <a key={slug} href={href(slug!)} aria-current={slug === page ? "page" : undefined} className={`flex min-h-11 items-center rounded-lg px-4 text-sm font-medium ${slug === page ? "bg-brand-muted text-brand-strong" : "hover:bg-muted"}`}>{label}</a>
        )}</nav>
        <div className="mt-6 flex flex-col gap-2 border-t pt-4">
          <a className={link} href={`#/explore/${area === "payables" ? "treasury" : "payables"}/overview`}>Explore {area === "payables" ? "Treasury" : "Payables"}</a>
          <button type="button" onClick={reset} className={`${link} self-start`}>Reset example</button>
        </div>
      </aside>
      <main ref={main} id="example-main" tabIndex={-1} className="min-w-0">
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">{current?.[1] ?? "Page not found"}</h1>
        <p className="mb-6 text-sm text-muted-foreground">Explore with fictional data. Changes stay in this tab and reset on reload.</p>
        {!current && <a href={href("overview")} className={link}>Return to overview</a>}
        {page === "overview" && <div className="grid gap-6 xl:grid-cols-2">
          <ExampleContext state={display} />
          <div className="flex flex-col items-start gap-4">
            {outcome}
            <a className={action} href={href(area === "payables" ? "invoices" : "automations")}>{area === "payables" ? "Open example invoice" : "Preview a rebalance"}</a>
          </div>
        </div>}
        {page === "agreements" && area === "payables" && <div className="flex max-w-2xl flex-col items-start gap-5 rounded-xl border bg-card p-6">
          <h2 className="text-xl font-semibold">Example design studio</h2>
          <span className="rounded-full bg-brand-muted px-3 py-1 text-sm text-brand-strong">Agreed payee</span>
          <p>The example owner has agreed to pay for a completed design milestone. Each invoice still becomes a held payout for owner review.</p>
          <a className={action} href={href("invoices")}>Create example invoice</a>
        </div>}
        {page === "invoices" && area === "payables" && <div className="grid gap-6 xl:grid-cols-2">
          <div className="flex flex-col gap-4">
            {step === 0 ? <form className="flex flex-col gap-4 rounded-xl border bg-card p-6" onSubmit={e => { e.preventDefault(); if (work.trim()) advance(); }}>
              <h2 className="text-xl font-semibold">Invoice from Example design studio</h2>
              <label className="flex flex-col gap-2 text-sm font-medium">Completed work<input className={field} name="example-work" value={work} maxLength={160} required pattern={".*\\S.*"} onChange={e => setWork(e.target.value)} /></label>
              <p className="text-sm text-muted-foreground">The owner reviews this milestone before approving the held payout.</p>
              <button className={`${action} self-start`} type="submit">Submit example invoice</button>
            </form> : <ExampleContext state={display} />}
            <a className={link} href={href("agreements")}>Review the agreement</a>
          </div>
          <div className="flex flex-col items-start gap-4">
            {outcome}
            {state.approval && <button type="button" className={action} onClick={() => { advance(); location.hash = href("activity"); }}>Simulate owner approval</button>}
            {step > 0 && !state.approval && <a className={action} href={href("activity")}>Follow this payout</a>}
          </div>
        </div>}
        {page === "automations" && area === "treasury" && <div className="grid gap-6 xl:grid-cols-2">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 text-sm font-medium"><label htmlFor="example-strategy">Example strategy</label><select id="example-strategy" className={field} value={strategy} onChange={e => { setStrategy(e.target.value as typeof strategy); reset(); }}>
              <option value="standard">Balanced allocation</option><option value="reserve">Larger stablecoin reserve</option>
            </select></div>
            <ExampleContext state={display} />
          </div>
          <div className="flex flex-col items-start gap-4">
            {outcome}
            {!complete && <button type="button" className={action} onClick={() => { advance(); if (step >= 2) location.hash = href("activity"); }}>{step === 0 ? "Preview plan" : step === 1 ? "Check authorization" : "Run example rebalance"}</button>}
            {complete && <a className={action} href={href("activity")}>Inspect the outcome</a>}
          </div>
        </div>}
        {page === "policy" && <div className="flex max-w-2xl flex-col gap-6 rounded-xl border bg-card p-6">
          <h2 className="text-xl font-semibold">Owner permission</h2>
          <p>A grant permits this server to act for the agent. Without one, it refuses before sending.</p>
          <div className="flex flex-col gap-2 text-sm font-medium"><label htmlFor="example-grant">Example grant</label><select id="example-grant" className={field} value={permission ? "active" : "absent"} onChange={e => { setPermission(e.target.value === "active"); reset(); }}><option value="active">Active grant</option><option value="absent">No live grant</option></select></div>
          <p className="text-sm text-muted-foreground">Changing permission resets this example. This control does not change a signed policy or a real grant.</p>
          <a className={`${action} self-start`} href={href(area === "payables" ? "invoices" : "automations")}>Try with this permission</a>
        </div>}
        {page === "activity" && <div className="flex flex-col gap-6">
          {outcome}
          {area === "payables" && step === 2 && !complete && <button className={`${action} self-start`} type="button" onClick={advance}>See example payout outcome</button>}
          <ol aria-label="Example activity" className="divide-y rounded-xl border bg-card px-5">{positions.slice(0, step + 1).map(position => {
            const observation = demoState(events, position);
            return <li key={position} className="py-4"><h2 className="font-semibold">{observation.title}</h2><p className="mt-1 text-sm text-muted-foreground">{observation.detail}</p></li>;
          })}</ol>
          <details className="rounded-xl border p-4"><summary className="cursor-pointer py-2 font-medium">Inspect example AG-UI events</summary><pre className="mt-3 max-h-80 overflow-auto text-xs whitespace-pre-wrap break-all">{JSON.stringify(events.slice(0, complete ? events.length : positions[step]! + 1), null, 2)}</pre></details>
        </div>}
      </main>
    </div>
  </div>;
}
