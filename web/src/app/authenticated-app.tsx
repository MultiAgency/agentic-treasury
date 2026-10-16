import { AgentAccess } from "../features/owner/agent-access";
import { GatewayContext } from "./gateway-context";
import { RouterProvider } from "@tanstack/react-router";
import { DaoHome } from "../features/workspace/dao";
import { Workspace } from "./workspace";
import { BASE } from "../shared/client";
import { router } from "./router";
import type { Gateway } from "./session";
import { ViewerContext, viewerOf } from "./viewer";
import { walkthroughAt } from "../features/demo/catalog";
import { Demos } from "./demos";
import { WalkthroughHome } from "./walkthrough-home";

export function AuthenticatedApp({ gateway, activity }: { gateway: Gateway | null; activity: boolean }) {
  const entryPath = location.pathname.replace(/\/$/, "");
  return <ViewerContext.Provider value={gateway?.viewer ? viewerOf(gateway.viewer, BASE ? BASE.slice("/a/".length) : null) : null}>
    <GatewayContext.Provider value={gateway}>{gateway && !BASE ? <Workspace gateway={gateway} activity={activity}>{entryPath === "/demos" || walkthroughAt(entryPath) ? <Demos gateway={gateway} workflow={walkthroughAt(entryPath)?.id} /> : (gateway.walkthroughs || gateway.selfService) && !activity ? <WalkthroughHome gateway={gateway} /> : <DaoHome gateway={gateway} activity={activity} />}</Workspace> : entryPath.endsWith("/access") ? (gateway ? <Workspace gateway={gateway}><AgentAccess /></Workspace> : <AgentAccess />) : <RouterProvider router={router} />}</GatewayContext.Provider>
  </ViewerContext.Provider>;
}
