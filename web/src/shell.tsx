import {
  ArrowClockwise,
  Bank,
  ClockCounterClockwise,
  Lightning,
  type Icon,
  Robot,
  ShieldCheck,
  SquaresFour,
  UsersThree,
  Wallet,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, Outlet } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";
import { client, type Overview, swaps } from "./lib";
import { Onboarding, ownerName, type Setup, WalletButton } from "./owner";
import type { Treasury } from "./treasury";
import { Badge, Button, Spinner } from "./ui";

/** What every screen works from once onboarding is done. */
type Agent = { setup: Setup; data: Overview; treasury: Treasury | null };

const AgentContext = createContext<Agent | null>(null);

export function useAgent() {
  const agent = useContext(AgentContext);
  if (!agent) throw new Error("useAgent outside the shell");
  return agent;
}

/** The pages; `swaps` ones only for an agent whose policy lets it swap. */
const NAV: { to: LinkProps["to"]; label: string; icon: Icon; swaps?: true }[] = [
  { to: "/", label: "Overview", icon: SquaresFour },
  { to: "/steward", label: "Steward", icon: Robot, swaps: true },
  { to: "/automations", label: "Automations", icon: Lightning },
  { to: "/treasury", label: "Treasury", icon: Bank },
  { to: "/payees", label: "Payees", icon: UsersThree },
  { to: "/policy", label: "Policy", icon: ShieldCheck },
  { to: "/activity", label: "Activity", icon: ClockCounterClockwise },
];

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
        <Wallet size={18} weight="bold" />
      </div>
      <span className="hidden font-heading text-lg font-semibold whitespace-nowrap sm:inline">Agentic Treasury</span>
    </div>
  );
}

function Nav({ className, data }: { className: string; data?: Overview }) {
  return (
    <nav className={className}>
      {NAV.filter((page) => !page.swaps || !data || swaps(data)).map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: true }}
          className="flex shrink-0 items-center gap-3 rounded-full px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          activeProps={{ className: "bg-muted font-medium text-foreground" }}
        >
          <Icon size={18} /> {label}
        </Link>
      ))}
    </nav>
  );
}

/** Which agent this is, who owns it, and whether it may act. */
function Identity({ setup, data }: { setup: Setup; data: Overview }) {
  const frozen = data.policy.policy?.frozen;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Agent</span>
        <span className="font-mono" title={data.agentId}>
          {data.agentId.slice(0, 6)}…{data.agentId.slice(-4)}
        </span>
      </div>
      {setup.wallet && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Wallet account</span>
          <span className="font-mono" title={setup.wallet}>
            {setup.wallet.slice(0, 6)}…{setup.wallet.slice(-4)}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Owner</span>
        <span className="truncate" title={ownerName(setup)}>
          {ownerName(setup)}
        </span>
      </div>
      {data.digest && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Mandate</span>
          <span className="font-mono" title={data.digest}>
            {data.digest.slice(7, 13)}…{data.digest.slice(-4)}
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Badge tone={frozen ? "destructive" : "success"}>{frozen ? "Frozen" : "Active"}</Badge>
        {setup.grant && <Badge tone="info">{setup.grant.label}</Badge>}
      </div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-3 p-8 text-muted-foreground">{children}</div>;
}

/**
 * The command center's frame: navigation, the agent's identity and the shared queries. Until the
 * agent exists and this server holds a grant for it, onboarding is the only screen.
 */
export function Shell() {
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => client.setup() });
  const ready = Boolean(setup.data?.agentId && setup.data.grant);
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => client.overview(),
    refetchInterval: 30_000,
    enabled: ready,
  });
  const treasury = useQuery({ queryKey: ["treasury"], queryFn: () => client.treasury.get(), enabled: ready });
  const error = setup.error ?? overview.error ?? treasury.error;

  if (error)
    return (
      <p className="m-8 rounded-2xl bg-destructive-muted p-6 text-sm text-destructive-muted-foreground">
        Could not reach the treasury server: {error.message}. Is <code>pnpm server</code> running?
      </p>
    );
  if (!setup.data)
    return (
      <Notice>
        <Spinner /> Loading…
      </Notice>
    );
  if (!ready)
    return (
      <main className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-10 sm:px-8">
        <header className="flex items-center justify-between gap-4">
          <Brand />
          <WalletButton />
        </header>
        <Onboarding setup={setup.data} />
      </main>
    );

  const refresh = (
    <Button variant="ghost" size="sm" onClick={() => overview.refetch()} disabled={overview.isFetching} aria-label="Refresh">
      {overview.isFetching ? <Spinner /> : <ArrowClockwise size={16} />}
    </Button>
  );

  return (
    <div className="lg:grid lg:min-h-screen lg:grid-cols-[16rem_1fr]">
      <aside className="hidden flex-col gap-8 border-r px-4 py-8 lg:sticky lg:top-0 lg:flex lg:h-screen">
        <div className="px-4">
          <Brand />
        </div>
        <Nav className="flex flex-col gap-1" data={overview.data} />
        <div className="mt-auto flex flex-col gap-6 px-4">
          {overview.data && <Identity setup={setup.data} data={overview.data} />}
          <div className="flex items-center gap-2">
            <WalletButton />
            {refresh}
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-10 flex flex-col gap-3 border-b bg-background/90 px-4 pt-4 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <Brand />
          <div className="flex items-center gap-2">
            {refresh}
            <WalletButton />
          </div>
        </div>
        <Nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-3" data={overview.data} />
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-14 px-4 py-10 sm:px-8 lg:py-12">
        {overview.data && treasury.isSuccess ? (
          <AgentContext.Provider value={{ setup: setup.data, data: overview.data, treasury: treasury.data }}>
            <Outlet />
          </AgentContext.Provider>
        ) : (
          <Notice>
            <Spinner /> Loading the book…
          </Notice>
        )}
      </main>
    </div>
  );
}
