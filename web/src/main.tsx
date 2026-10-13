import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DaoHome } from "./dao";
import { BASE } from "./lib";
import { router } from "./router";
import { PublicHome } from "./public";
import { ErrorBox } from "./ui";
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
async function start() {
  const gateway = await loadGateway().catch((error: Error) => error);
  const page =
    gateway instanceof Error ? (
      <div className="mx-auto max-w-xl p-8">
        <ErrorBox error={`The dashboard can't load right now: ${gateway.message} Try again in a minute.`} />
      </div>
    ) : gateway && !gateway.viewer ? (
      <PublicHome daos={ownersOf(gateway.agents)} invoices={gateway.invoices} />
    ) : (
      <ViewerContext.Provider value={gateway?.viewer ? viewerOf(gateway.viewer, BASE ? BASE.slice("/a/".length) : null) : null}>
        {gateway && !BASE ? <DaoHome gateway={gateway} /> : <RouterProvider router={router} />}
      </ViewerContext.Provider>
    );
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>{page}</QueryClientProvider>
    </StrictMode>,
  );
}
start();
