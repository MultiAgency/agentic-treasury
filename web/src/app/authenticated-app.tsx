import { GatewayContext } from "./gateway-context";
import { RouterProvider } from "@tanstack/react-router";
import { DaoHome } from "../features/workspace/dao";
import { Workspace } from "./workspace";
import { BASE } from "../shared/client";
import { router } from "./router";
import type { Gateway } from "./session";
import { ViewerContext, viewerOf } from "./viewer";
import { WalkthroughHome } from "./walkthrough-home";

export function AuthenticatedApp({ gateway, activity }: { gateway: Gateway | null; activity: boolean }) {
  return <ViewerContext.Provider value={gateway?.viewer ? viewerOf(gateway.viewer, BASE ? BASE.slice("/a/".length) : null) : null}>
    <GatewayContext.Provider value={gateway}>{gateway && !BASE ? <Workspace gateway={gateway} activity={activity}>{gateway.walkthroughs && !activity ? <WalkthroughHome gateway={gateway} /> : <DaoHome gateway={gateway} activity={activity} />}</Workspace> : <RouterProvider router={router} />}</GatewayContext.Provider>
  </ViewerContext.Provider>;
}
