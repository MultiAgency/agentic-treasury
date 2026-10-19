import { ArrowClockwise } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { BASE, kindOf } from "../shared/lib";
import { queries } from "../shared/queries";
import { ownerName, WalletButton } from "../features/owner/owner";
import { Button, QueryError, Spinner } from "../shared/ui";
import { appOrigin } from "../features/demo/app-origin";
import { AgentContext } from "./agent-context";
import { useGateway } from "./gateway-context";
import { Onboarding } from "./onboarding";
import { SetupNextStep } from "./setup-progress";
import { ViewerBadge } from "./session";

/**
 * An agent's pages on Proto: its walkthroughs, rehearsal and home. The agent's full screens live in its app; until an
 * agent is set up, onboarding stays here (each app's own setup flow is not yet shown working against this gateway).
 */
export function AgentFrame() {
  const gateway = useGateway();
  const setup = useQuery({ ...queries.setup, retry: false });
  const ready = Boolean(setup.data?.agentId) && !setup.error;
  const overview = useQuery({ ...queries.overview, enabled: ready });
  const kind = overview.data ? kindOf(overview.data) : undefined;
  const app = appOrigin(kind === "treasury" ? "treasury" : "payables", gateway);
  const header = <header className="flex min-w-0 flex-wrap items-center justify-between gap-4">
    <div className="flex min-w-0 flex-col gap-1">
      <a href="/" className="text-sm text-muted-foreground hover:text-foreground">← All agents</a>
      {setup.data && <p className="break-all text-sm text-muted-foreground">{ownerName(setup.data)}</p>}
    </div>
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {kind && <a className="underline" href={`${app}${BASE}/`}>Open {kind === "treasury" ? "Treasury" : "Payables"}</a>}
      <ViewerBadge /><WalletButton />
    </div>
  </header>;
  return <main id="agent-main" tabIndex={-1} className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8 lg:py-10">
    {header}
    {setup.error ? <div className="flex flex-col items-start gap-3 rounded-2xl bg-destructive-muted p-6 text-sm text-destructive-muted-foreground">
      <p role="alert">Setup unavailable</p>
      <p>{setup.error.message}</p>
      <Button variant="outline" size="sm" disabled={setup.isFetching} onClick={() => setup.refetch()}>{setup.isFetching ? <Spinner /> : <ArrowClockwise size={16} />}Retry setup</Button>
    </div>
      : !setup.data ? <p role="status"><Spinner /> Loading…</p>
      : !ready ? <Onboarding setup={setup.data} />
      // A failed refresh keeps the retained observations on screen; each page reports and acts on the failure itself.
      : !overview.data ? overview.error ? <QueryError error={overview.error} retry={() => { void overview.refetch(); }} /> : <p role="status"><Spinner /> Loading…</p>
      : <><SetupNextStep setup={setup.data} overview={overview.error ? undefined : overview.data} />
        <AgentContext.Provider value={{ setup: setup.data, data: overview.data }}><Outlet /></AgentContext.Provider></>}
  </main>;
}
