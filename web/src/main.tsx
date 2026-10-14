import { gatewayQueries } from "./app/queries";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { PublicHome } from "./public";
import { ErrorBox, Button, Loading } from "./shared/ui";
import { ownersOf } from "./app/session";
import "./styles.css";

const AuthenticatedApp = lazy(() => import("./app/authenticated-app").then(module => ({ default: module.AuthenticatedApp })));
const PrototypeExplorer = lazy(() => import("./public/prototype-explorer").then(module => ({ default: module.PrototypeExplorer })));

// Follow the system theme.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

/**
 * Served by a local agent server, this is that agent's dashboard. Behind the hosted gateway, a
 * visitor sees the public examples and sign-in. Signed-in pages share a workspace frame;
 * `/a/<agent>/` retains that agent's client, cache and permissions.
 */
function GatewayPage({ activity }: { activity: boolean }) {
  const query = useQuery({ ...gatewayQueries.entry });
  if (query.isPending) return <main className="mx-auto max-w-xl p-8"><Loading label="Loading dashboard…" /></main>;
  if (query.isError) return <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
    <h1 className="text-xl font-semibold">Dashboard unavailable</h1>
    <ErrorBox error={`The dashboard can't load right now: ${query.error.message}`} />
    <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>{query.isFetching ? "Retrying…" : "Retry"}</Button>
  </main>;
  const gateway = query.data;
  return gateway && !gateway.viewer ? (
    <PublicHome daos={ownersOf(gateway.agents)} invoices={gateway.invoices} />
  ) : (
    <AuthenticatedApp gateway={gateway} activity={activity} />
  );
}

const subscribeHash = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};
function App() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const example = hash.match(/^#\/explore\/(payables|treasury)(?:\/([^/?#]+))?\/?$/);
  if (example) return <PrototypeExplorer key={example[1]} area={example[1] as "payables" | "treasury"} page={example[2] || "overview"} />;
  return <GatewayPage activity={hash === "#activity"} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><Suspense fallback={<main className="p-8"><Loading label="Loading page…" /></main>}><App /></Suspense></QueryClientProvider></StrictMode>,
);
