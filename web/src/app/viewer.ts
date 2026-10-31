import { createContext, useContext } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { gatewayRead, mayCall, type Access, type Gateway } from "../platform";

/** Identity is shared across the host. Authority always belongs to the selected agent. */
export type Viewer = { account: string; access: Access | null };

export function viewerOf({ account, access }: NonNullable<Gateway["viewer"]>, agent: string | null): Viewer {
  return { account, access: agent !== null ? access[agent] ?? null : null };
}

export const ViewerContext = createContext<Viewer | null>(null);
export const useViewer = () => useContext(ViewerContext);

/**
 * Authority for one procedure on the selected agent; the gateway enforces the same rule. While the session is being
 * reread (the tab returned, or another tab signed in or out), no control is offered: the previous account's
 * permissions are not confirmed for whoever is now signed in.
 */
export const useCanCall = (path: string) => {
  const viewer = useViewer();
  const confirming = useIsFetching({ queryKey: gatewayRead.queryKey, exact: true }) > 0;
  return viewer !== null && !confirming && viewer.access !== null && mayCall(viewer.access, path);
};
