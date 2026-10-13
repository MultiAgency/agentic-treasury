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
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, Outlet, useMatchRoute } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useId } from "react";
import { BASE, client, kindOf, type Overview } from "./lib";
import { type Kind, PROTOTYPES } from "./beats";
import { ViewerBadge } from "./session";
import { useViewer } from "./viewer";
import { Onboarding } from "./onboarding";
import { ownerName, type Setup, WalletButton } from "./owner";
import type { Treasury } from "./treasury";
import { Badge, Button, Details, Spinner } from "./ui";

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
const NAV: Record<Kind, { to: LinkProps["to"]; label: string; icon: Icon; tag?: string }[]> = {
  facilitator: [
    { to: "/", label: "Overview", icon: SquaresFour },
    { to: "/payees", label: "Agreements", icon: UsersThree },
    { to: "/funding", label: "Funding", icon: Bank },
    { to: "/policy", label: "Policy", icon: ShieldCheck },
    { to: "/activity", label: "Activity", icon: ClockCounterClockwise },
  ],
  treasury: [
    { to: "/", label: "Overview", icon: SquaresFour },
    { to: "/steward", label: "Steward", icon: Robot, tag: "experimental" },
    { to: "/automations", label: "Automations", icon: Lightning },
    { to: "/funding", label: "Funding", icon: Bank },
    { to: "/policy", label: "Policy", icon: ShieldCheck },
    { to: "/activity", label: "Activity", icon: ClockCounterClockwise },
  ],
};

/**
 * Pages an agent shows that aren't in its menu, opened from its Overview instead. A payout agent's
 * Automations holds only Sweep and the autopilot, reached from the attention items that need them.
 * The timelines follow one held payment (from Held payouts) or the latest autopilot run.
 */
const OFF_NAV: Record<Kind, LinkProps["to"][]> = { facilitator: ["/automations", "/follow/payment"], treasury: ["/follow/run"] };

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
      <span className="hidden font-heading text-lg leading-tight font-semibold sm:inline">{data ? PROTOTYPES[kindOf(data)].name : "Agentic Treasury"}</span>
    </div>
  );
}

function Nav({ className, data }: { className: string; data?: Overview }) {
  return (
    <nav className={className}>
      {(data ? NAV[kindOf(data)] : NAV.treasury.slice(0, 1)).map(({ to, label, icon: Icon, tag }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: true }}
          className="flex shrink-0 items-center gap-3 rounded-full px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          activeProps={{ className: "bg-muted font-medium text-foreground" }}
        >
          <Icon size={18} /> {label}
          {tag && <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground">{tag}</span>}
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
        <Badge tone={data.notInForce ? "destructive" : "success"}>{frozen ? "Frozen" : data.notInForce ? "Not in force" : "Active"}</Badge>
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
 * agent exists and this server holds a grant for it, onboarding is the only screen.
 */
export function Shell() {
  const viewer = useViewer();
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
  const name = overview.data && PROTOTYPES[kindOf(overview.data)].name;
  useEffect(() => {
    if (name) document.title = name;
  }, [name]);

  if (error)
    return (
      <div className="m-8 flex flex-col items-start gap-4 rounded-2xl bg-destructive-muted p-6 text-sm text-destructive-muted-foreground">
        <p>
          Couldn't reach this agent: {error.message}.
          {/* Served by a local agent server, the likely cause is that it isn't running. */}
          {!BASE && (
            <>
              {" "}
              Is <code>pnpm server</code> running?
            </>
          )}
        </p>
        <Button variant="outline" size="sm" onClick={() => location.reload()}>
          <ArrowClockwise size={16} /> Retry
        </Button>
      </div>
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
        <div className="flex items-center justify-between gap-3">
          <Brand data={overview.data} />
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
            <Page data={overview.data} />
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
