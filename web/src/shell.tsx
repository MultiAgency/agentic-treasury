import {
  ArrowClockwise,
  Bank,
  ClockCounterClockwise,
  Lightning,
  type Icon,
  ShieldCheck,
  SquaresFour,
  UsersThree,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, Outlet, useLocation, useMatchRoute } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useId, useRef, useState } from "react";
import { client, kindOf, type Overview } from "./lib";
import { type Kind, PROTOTYPES } from "./beats";
import { ViewerBadge } from "./session";
import { useViewer } from "./viewer";
import { Onboarding } from "./onboarding";
import { ownerName, type Setup, WalletButton } from "./owner";
import type { Treasury } from "./treasury";
import { Badge, Button, Details, QueryError, Spinner } from "./ui";
import { RecoveryActivity } from "./activity";

/** What every screen works from once onboarding is done. */
type Agent = { setup: Setup; data: Overview; treasury: Treasury | null };

const AgentContext = createContext<Agent | null>(null);

export function useAgent() {
  const agent = useContext(AgentContext);
  if (!agent) throw new Error("useAgent outside the shell");
  return agent;
}

/**
 * Each area's pages, in the order its story runs, named for what they are in it. A page not listed
 * for an agent's kind isn't part of that area, and the shell says so instead of showing it.
 */
const NAV: Record<Kind, { to: LinkProps["to"]; label: string; icon: Icon }[]> = {
  facilitator: [
    { to: "/", label: "Overview", icon: SquaresFour },
    { to: "/payees", label: "Agreements", icon: UsersThree },
    { to: "/funding", label: "Funding", icon: Bank },
    { to: "/policy", label: "Policy", icon: ShieldCheck },
    { to: "/activity", label: "Activity", icon: ClockCounterClockwise },
  ],
  treasury: [
    { to: "/", label: "Overview", icon: SquaresFour },
    { to: "/automations", label: "Automations", icon: Lightning },
    { to: "/funding", label: "Funding", icon: Bank },
    { to: "/policy", label: "Policy", icon: ShieldCheck },
    { to: "/activity", label: "Activity", icon: ClockCounterClockwise },
  ],
};

/**
 * Pages an agent shows that aren't in its menu, opened from its Overview instead. A payout agent's
 * Automations holds only Sweep and the autopilot, reached from the attention items that need them.
 * The timelines show the payout agent's payments (also under Payments on its Overview) or the latest autopilot run. The treasury's
 * Steward is an experiment, reached only by its address.
 */
const OFF_NAV: Record<Kind, LinkProps["to"][]> = { facilitator: ["/automations", "/follow/payment"], treasury: ["/follow/run", "/follow/payment", "/steward"] };

/** The mark, drawn as the favicon is (web/rsbuild.config.ts): a safe in the logo blue, a tick cut from its dial. */
function Logo() {
  const tick = useId();
  return (
    <svg viewBox="0 0 32 32" className="size-9 shrink-0 text-logo" fill="currentColor" aria-hidden="true">
      <mask id={tick}>
        <rect width="32" height="32" fill="white" />
        <path d="M13.7 14.6l1.6 1.6 3-3.2" fill="none" stroke="black" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <rect x="6" y="5.5" width="20" height="18.5" style={{ opacity: "var(--logo-tint)" }} />
      <path fillRule="evenodd" d="M7.5 3h17a4 4 0 0 1 4 4v15.5a4 4 0 0 1-4 4h-17a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM6.5 6v17.5h19V6z" />
      <rect x="20" y="13.5" width="6" height="3" />
      <rect x="6.5" y="25.5" width="4" height="3.5" rx="1.5" />
      <rect x="21.5" y="25.5" width="4" height="3.5" rx="1.5" />
      <circle cx="16" cy="14.8" r="5.2" mask={`url(#${tick})`} />
    </svg>
  );
}

function Brand({ data }: { data?: Overview }) {
  return (
    <div className="flex items-center gap-3">
      <Logo />
      <span className="font-heading text-lg leading-tight font-semibold">{data ? PROTOTYPES[kindOf(data)].name : "Agentic Treasury"}</span>
    </div>
  );
}

function Nav({ className, data }: { className: string; data?: Overview }) {
  return (
    <nav className={className}>
      {(data ? NAV[kindOf(data)] : NAV.treasury.filter(item => item.to === "/" || item.to === "/activity")).map(({ to, label, icon: Icon }) => (
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

/** Who owns the agent and whether it may act; its identifiers fold away. */
function Identity({ setup, data }: { setup: Setup; data: Overview }) {
  const frozen = data.policy.policy?.frozen;
  const ids: [string, string][] = [
    ["Agent", data.agentId],
    ...(setup.wallet ? [["Wallet account", setup.wallet] as [string, string]] : []),
    ...(data.digest ? [["Mandate", data.digest] as [string, string]] : []),
    ...(setup.grant ? [["Grant", setup.grant.label] as [string, string]] : []),
  ];
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Owner</span>
        <span className="truncate" title={ownerName(setup)}>
          {ownerName(setup)}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge tone={data.notInForce ? "destructive" : "success"}>{frozen ? "Frozen" : data.notInForce ? "Not in force" : "Policy in force"}</Badge>
      </div>
      <Details summary="Identifiers">
        {ids.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate font-mono text-xs" title={value}>
              {value}
            </span>
          </div>
        ))}
      </Details>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-3 p-8 text-muted-foreground">{children}</div>;
}

/** The page asked for, when it belongs to this agent's area; otherwise where to go instead. */
function Page({ data }: { data: Overview }) {
  const matchRoute = useMatchRoute();
  if ([...NAV[kindOf(data)].map(({ to }) => to), ...OFF_NAV[kindOf(data)]].some((to) => matchRoute({ to }))) return <Outlet />;
  return (
    <div className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
      <p>This page isn't part of {PROTOTYPES[kindOf(data)].name}.</p>
      <Link to="/" className="underline hover:text-foreground">
        Go to its Overview
      </Link>
    </div>
  );
}

/**
 * The command center's frame: navigation, the agent's identity and the shared queries. Until the
 * agent exists, onboarding is the only screen. Missing grants must not hide existing records.
 */
export function Shell() {
  const viewer = useViewer();
  const pathname = useLocation({ select: (location) => location.pathname });
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      document.getElementById("agent-main")?.focus();
    }
  }, [pathname]);
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => client.setup(), retry: false });
  // Keep records mounted while an explicit retry has no setup result yet.
  const [setupRecovery, setSetupRecovery] = useState(false);
  useEffect(() => {
    if (setup.isError) setSetupRecovery(true);
    else if (setup.isSuccess) setSetupRecovery(false);
  }, [setup.isError, setup.isSuccess]);
  const ready = Boolean(setup.data?.agentId) && !setup.error && !setupRecovery;
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => client.overview(),
    refetchInterval: 30_000,
    enabled: ready,
  });
  const treasury = useQuery({ queryKey: ["treasury"], queryFn: () => client.treasury.get(), enabled: ready });
  const error = setup.error ?? overview.error ?? treasury.error;
  const name = overview.data && PROTOTYPES[kindOf(overview.data)].name;
  useEffect(() => {
    if (name) document.title = name;
  }, [name]);

  if (setup.error || setupRecovery)
    return (
      <main id="agent-main" tabIndex={-1} className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10 sm:px-8">
        <Brand />
        <Nav className="flex flex-wrap gap-2" />
        <h1 className="text-2xl font-semibold">Agent recovery</h1>
        <div className="flex flex-col items-start gap-3 rounded-2xl bg-destructive-muted p-6 text-sm text-destructive-muted-foreground">
          <p role="alert">Setup unavailable</p>
          <p>Retained records can still be reviewed when access is authorized. Setup, balances, policy and grant status are not confirmed here.</p>
          {setup.error && <p>{setup.error.message}</p>}
          <Button variant="outline" size="sm" disabled={setup.isFetching} onClick={() => setup.refetch()}>
            {setup.isFetching ? <Spinner /> : <ArrowClockwise size={16} />}
            {setup.isFetching ? "Retrying setup…" : "Retry setup"}
          </Button>
        </div>
        {pathname.replace(/\/$/, "").endsWith("/activity") ? <RecoveryActivity /> : (
          <Link to="/activity" className="underline">Review existing records in Activity</Link>
        )}
      </main>
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
      <a href="#agent-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-background focus:p-3">Skip to main content</a>
      <aside className="hidden flex-col gap-8 border-r px-4 py-8 lg:sticky lg:top-0 lg:flex lg:h-screen">
        <div className="px-4">
          <Brand data={overview.data} />
        </div>
        <Nav className="flex flex-col gap-1" data={overview.data} />
        <div className="mt-auto flex flex-col gap-6 px-4">
          {viewer && (
            <a href="/" className="text-sm text-muted-foreground hover:text-foreground">
              ← All agents
            </a>
          )}
          {overview.data && <Identity setup={setup.data} data={overview.data} />}
          <ViewerBadge />
          <div className="flex items-center gap-2">
            <WalletButton />
            {refresh}
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-10 flex flex-col gap-3 border-b bg-background/90 px-4 pt-4 backdrop-blur lg:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Brand data={overview.data} />
          <div className="flex items-center gap-2">
            {refresh}
            <WalletButton />
          </div>
        </div>
        <Details summary="Account and agents">
          {viewer && <a href="/" className="text-sm underline">← All agents</a>}
          {overview.data && <Identity setup={setup.data} data={overview.data} />}
          <ViewerBadge />
        </Details>
        <Nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-3" data={overview.data} />
      </header>

      <main id="agent-main" tabIndex={-1} className="scroll-mt-48 mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8 lg:py-10">
        <h1 className="text-2xl font-semibold">{name ?? "Agentic Treasury"} · {pathname.endsWith("/follow/payment") ? "Payment" : pathname.endsWith("/follow/run") ? "Treasury runs" : NAV[overview.data ? kindOf(overview.data) : "treasury"].find((item) => item.to !== "/" && pathname.endsWith(item.to!))?.label ?? "Overview"}</h1>
        {!setup.data.grant && <p role="status" className="text-sm">This instance has no grant. Existing records remain available. <Link to="/policy" hash="grants" className="underline">Review grants and permissions</Link>.</p>}
        {error && <><p className="text-sm">{overview.data && treasury.data !== undefined ? "Refresh failed. Showing previously loaded records; check again before acting." : "Some agent details could not be loaded. Activity remains available for read-only recovery."}</p><QueryError error={error} retry={() => { void setup.refetch(); void overview.refetch(); void treasury.refetch(); }} /></>}
        {overview.data && treasury.data !== undefined ? (
          <AgentContext.Provider value={{ setup: setup.data, data: overview.data, treasury: treasury.data }}>
            <Page data={overview.data} />
          </AgentContext.Provider>
        ) : pathname.replace(/\/$/, "").endsWith("/activity") ? <RecoveryActivity /> : (
          <Notice>
            {error ? <Link to="/activity" className="underline">Review existing records in Activity</Link> : <><Spinner /> Loading the book…</>}
          </Notice>
        )}
      </main>
    </div>
  );
}
