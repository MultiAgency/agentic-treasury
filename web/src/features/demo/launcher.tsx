import { areaOf, type Gateway } from "../../app/session";
import { appOrigin } from "./app-origin";

/** Each agent's full app, its Proto walkthroughs and, for Treasury, agent access. Reads nothing beyond the gateway session. */
export function AgentList({ gateway }: { gateway: Gateway }) {
  const appOf = (area: string) => area === "treasury" ? "Treasury" : "Payables";
  return <ul className="flex flex-col gap-4">{gateway.agents.map(agent => {
    const area = areaOf(agent);
    return <li key={agent.name} className="flex flex-col gap-2 border-t pt-4">
      <h2 className="font-medium">{appOf(area)} · <span className="break-all text-muted-foreground">{agent.owner}{agent.dao ? " · Sputnik DAO" : ""}</span></h2>
      <div className="flex flex-wrap gap-5 text-sm">
        <a className="underline" href={`${appOrigin(area, gateway)}/a/${agent.name}/`}>Open in {appOf(area)}<span className="sr-only"> for {agent.name}</span></a>
        <a className="underline" href={`/a/${agent.name}/`}>Walkthroughs<span className="sr-only"> for {agent.name}</span></a>
        {area === "treasury" && <a className="underline" href={`/a/${agent.name}/access`}>Agent access<span className="sr-only"> for {agent.name}</span></a>}
      </div>
    </li>;
  })}</ul>;
}

/** The signed-in home when this host offers no self-service setup. */
export function Launcher({ gateway }: { gateway: Gateway }) {
  return <main id="workspace-main" tabIndex={-1} className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-8">
    <header className="space-y-3">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Your agents</h1>
      <p className="text-muted-foreground">Each agent’s balances, policy, actions and records are in its app. Proto hosts sign-in, consent, walkthroughs and evidence.</p>
    </header>
    {gateway.agents.length ? <AgentList gateway={gateway} /> : <p>No agents are available to this account here.</p>}
    <p><a className="underline" href="/demos">Demos and validation</a></p>
  </main>;
}
