import type { Gateway } from "./session";
import { walkthroughs, type WalkthroughId } from "../features/demo/catalog";
import { SourceLabel } from "../features/demo/source-label";
import { appOrigin } from "../features/demo/app-origin";
import { RecordedSimulations } from "../features/demo/receipts";

/** Only navigation: selecting a guide never starts an action or aggregates private balances. */
export function Demos({ gateway, workflow }: { gateway: Gateway; workflow?: WalkthroughId }) {
  const selected = walkthroughs.find(item => item.id === workflow);
  return <main id="workspace-main" tabIndex={-1} className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-8">
    <header className="space-y-3">
      {selected && <a className="underline" href="/demos">Back to demos</a>}
      <h1 className="font-heading text-3xl font-semibold tracking-tight">{selected ? `${selected.title} walkthrough` : "Demos and validation"}</h1>
      <p className="text-muted-foreground">{selected ? "The complete walkthrough uses the same controls and records as the short guide." : "Try a short guided workflow, or open its complete walkthrough for more context."} Live guides use mainnet funds. The interactive Payables rehearsal uses fictional records. Opening a guide submits nothing.</p>
    </header>
    {(selected ? [selected] : walkthroughs).map(item => {
      const agents = gateway.agents.filter(agent => agent.area === item.area || (!agent.area && (item.area === "treasury" ? agent.name === "treasury" : ["payout", "payables"].includes(agent.name))));
      return <section key={item.id} aria-labelledby={`guide-${item.id}`} className="flex flex-col gap-4 border-t pt-6">
        <div className="flex flex-wrap items-center gap-2"><h2 id={`guide-${item.id}`} className="text-xl font-semibold">{item.title}</h2><SourceLabel source="Live" /></div>
        <p className="text-muted-foreground">{item.summary}</p>
        <ol className="list-decimal space-y-2 pl-5 text-sm">{item.steps.map(step => <li key={step}>{step}</li>)}</ol>
        {"variation" in item && <div className="space-y-2 text-sm"><h3 className="font-medium">Variation: {item.variation.title}</h3><p className="text-muted-foreground">{item.variation.summary}</p>
          <ol className="list-decimal space-y-1 pl-5">{item.variation.steps.map(step => <li key={step}>{step}</li>)}</ol></div>}
        <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Limitation: </span>{item.limitation}</p>
        <RecordedSimulations workflows={item.id === "invoices" ? ["invoices", "builder"] : [item.id]} />
        <div className="flex flex-wrap gap-5 text-sm">
          {!selected && <a className="underline" href={`/${item.id}`}>Full {item.title.toLowerCase()} walkthrough</a>}
          <a className="underline" href={appOrigin(item.id, gateway)}>Open full app<span className="sr-only"> for {item.title}</span></a>
        </div>
        {agents.length ? <ul className="space-y-4">{agents.map(agent => <li key={agent.name} className="flex flex-col gap-2">
          <p className="break-all text-sm">Owner: {agent.owner}</p>
          {item.id === "payables" && <span className="flex flex-wrap items-center gap-2"><a className="underline" href={`/a/${agent.name}/demos/payables/play`}>Play the Payables demo<span className="sr-only"> with {agent.name}</span></a><SourceLabel source="Fictional rehearsal" /></span>}
          <a className="underline" href={`/a/${agent.name}/${selected ? "walkthrough" : "demos"}/${item.id}`}>
            {selected ? "Open complete walkthrough" : "Start short guide"}<span className="sr-only"> for {item.id} with {agent.name}</span>
          </a>
        </li>)}</ul> : <p className="text-sm">No matching agent is available on this host. <a className="underline" href="/workspace">Create or resume setup</a>.</p>}
      </section>;
    })}
  </main>;
}
