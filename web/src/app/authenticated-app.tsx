import { AgentAccess } from "../features/owner/agent-access";
import { GatewayContext } from "./gateway-context";
import { RouterProvider } from "@tanstack/react-router";
import { Workspace } from "./workspace";
import { BASE } from "../shared/client";
import { router } from "./router";
import type { Gateway } from "./session";
import { ViewerContext, viewerOf } from "./viewer";
import { walkthroughAt } from "../features/demo/catalog";
import { Demos } from "./demos";
import { Launcher } from "../features/demo/launcher";
import { WalkthroughHome } from "./walkthrough-home";

export function AuthenticatedApp({ gateway }: { gateway: Gateway | null }) {
  const entryPath = location.pathname.replace(/\/$/, "");
  const home = !gateway ? null : entryPath === "/demos" || walkthroughAt(entryPath) ? <Demos gateway={gateway} workflow={walkthroughAt(entryPath)?.id} />
    // Self-service setup stays on Proto until each app's own setup flow is shown working against this gateway.
    : gateway.selfService ? <WalkthroughHome gateway={gateway} /> : <Launcher gateway={gateway} />;
  return <ViewerContext.Provider value={gateway?.viewer ? viewerOf(gateway.viewer, BASE ? BASE.slice("/a/".length) : null) : null}>
    <GatewayContext.Provider value={gateway}>{gateway && !BASE ? <Workspace gateway={gateway}>{home}</Workspace>
      : entryPath.endsWith("/access") ? (gateway ? <Workspace gateway={gateway}><AgentAccess /></Workspace> : <AgentAccess />)
      : gateway ? <Workspace gateway={gateway}><RouterProvider router={router} /></Workspace> : <RouterProvider router={router} />}</GatewayContext.Provider>
  </ViewerContext.Provider>;
}
