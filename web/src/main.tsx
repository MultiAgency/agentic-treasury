import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DaoHome } from "./dao";
import { BASE } from "./lib";
import { router } from "./router";
import { PublicHome } from "./public";
import { loadGateway } from "./session";
import { ViewerContext } from "./viewer";
import "./styles.css";

// Follow the system theme.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

/**
 * Served by a local agent server, this is that agent's dashboard. Behind the hosted gateway, a
 * visitor sees only what the DAO shows on chain; a member who signs in gets the DAO's home at `/`
 * and `/a/<agent>/` each agent's dashboard.
 */
async function start() {
  const gateway = await loadGateway();
  const page =
    gateway && !gateway.viewer ? (
      <PublicHome dao={gateway.dao} invoices={gateway.invoices} />
    ) : (
      <ViewerContext.Provider value={gateway?.viewer ?? null}>
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
