import type { ReactNode } from "react";
import { BASE } from "../shared/client";
import { type Gateway, ViewerBadge } from "./session";

/** The signed-in frame for Proto's own pages: home, demos and agent access. Agents' full screens live in their apps. */
export function Workspace({ gateway, children }: { gateway: Gateway; children: ReactNode }) {
  const current = gateway.agents.find(agent => BASE === `/a/${agent.name}`);
  return <div className="min-h-dvh">
    <a href={BASE ? "#agent-main" : "#workspace-main"} className="sr-only focus:not-sr-only">Skip to main content</a>
    <header className="border-b px-4 py-4 sm:px-8"><div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
      <a href="/" className="font-heading text-lg font-semibold">Agentic Treasury</a><ViewerBadge />
    </div></header>
    <nav aria-label="Workspace" className="mx-auto flex max-w-5xl flex-wrap gap-x-6 gap-y-2 px-4 pt-4 text-sm sm:px-8">
      <a href="/" className="inline-flex min-h-11 items-center underline">Your agents</a>
      <a href="/demos" className="inline-flex min-h-11 items-center underline">Demos</a>
      {current?.area === "treasury" && <a href={`${BASE}/access`} className="inline-flex min-h-11 items-center underline">Agent access</a>}
    </nav>
    {children}
  </div>;
}
