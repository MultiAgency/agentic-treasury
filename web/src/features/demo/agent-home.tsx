import { useEffect } from "react";
import { useLocation } from "@tanstack/react-router";
import { useAgent } from "../../app/agent-context";
import { useGateway } from "../../app/gateway-context";
import { areaOf } from "../../app/session";
import { BASE, kindOf } from "../../shared/lib";
import { WhatThisShows } from "../evidence/showcase";
import { appOrigin } from "./app-origin";
import { SourceLabel } from "./source-label";

/** Proto's page for one agent: where its full app is, and Proto's walkthroughs and rehearsal for it. */
export function AgentHome() {
  const { data, setup } = useAgent();
  const kind = kindOf(data);
  const treasury = kind === "treasury";
  const app = appOrigin(treasury ? "treasury" : "payables", useGateway());
  const guides = treasury ? [["treasury", "Treasury"]] : [["payables", "Confidential payables"], ["invoices", "Purchase orders and invoices"]];
  return <section className="flex flex-col gap-6">
    <h1 className="text-2xl font-semibold">{treasury ? "Treasury" : "Payables"} agent</h1>
    <p className="max-w-prose">This agent’s balances, policy, actions and records are in {treasury ? "Treasury" : "Payables"}. <a className="underline" href={`${app}${BASE}/`}>Open {treasury ? "Treasury" : "Payables"}</a>.</p>
    <ul className="flex flex-col gap-3">{guides.map(([id, title]) => <li key={id} className="flex flex-wrap items-center gap-3">
      <SourceLabel source="Live" /><a className="underline" href={`${BASE}/demos/${id}`}>{title}: short guide</a><a className="underline" href={`${BASE}/walkthrough/${id}`}>complete walkthrough</a>
    </li>)}
      {!treasury && <li className="flex flex-wrap items-center gap-3"><SourceLabel source="Fictional rehearsal" /><a className="underline" href={`${BASE}/demos/payables/play`}>Play the Payables rehearsal</a></li>}
    </ul>
    <WhatThisShows kind={kind} dao={setup.dao?.id} />
  </section>;
}

/**
 * A Proto page that moved to the agent's app: the same path, query and hash there, so saved links keep working. The area
 * comes from the gateway, so the redirect needs no agent reads; a page served without a gateway names the move only.
 */
export function AppRedirect() {
  const gateway = useGateway();
  const location = useLocation();
  const agent = gateway?.agents.find(entry => `/a/${entry.name}` === BASE);
  const path = location.pathname.replace(/\/$/, "").endsWith("/workspace") ? "/" : location.pathname;
  const target = agent && `${appOrigin(areaOf(agent), gateway)}${BASE}${path}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`;
  useEffect(() => { if (target) window.location.replace(target); }, [target]);
  return <main className="mx-auto max-w-3xl px-4 py-8 sm:px-8"><p>This page moved to the agent’s app.{target && <> <a className="underline" href={target}>Continue</a>.</>}</p></main>;
}
