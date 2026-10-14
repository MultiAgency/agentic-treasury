import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DaoHome } from "./dao";
import { BASE } from "./lib";
import { router } from "./router";
import { PublicHome } from "./public";
import { PrototypeExplorer } from "./prototype-explorer";
import { ErrorBox, Button, Loading } from "./ui";
import { loadGateway, ownersOf } from "./session";
import { ViewerContext, viewerOf } from "./viewer";
import "./styles.css";

// Follow the system theme.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

/**
 * Served by a local agent server, this is that agent's dashboard. Behind the hosted gateway, a
 * visitor sees only the prototypes and sign-in; an owner or a DAO member who signs in gets the home
 * at `/` and `/a/<agent>/` each agent's dashboard it may see.
 */
function GatewayPage() {
  const query = useQuery({ queryKey: ["gateway"], queryFn: loadGateway, retry: false, staleTime: "static", refetchOnReconnect: false });
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
    <ViewerContext.Provider value={gateway?.viewer ? viewerOf(gateway.viewer, BASE ? BASE.slice("/a/".length) : null) : null}>
      {gateway && !BASE ? <DaoHome gateway={gateway} /> : <RouterProvider router={router} />}
    </ViewerContext.Provider>
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
  return <GatewayPage />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
);
