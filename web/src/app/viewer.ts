import { createContext, useContext } from "react";

/**
 * Who is looking, when the dashboard is hosted behind the gateway (src/gateway). Locally there is
 * no gateway and no viewer: the operator on loopback can do everything.
 */
export type Access = { role: "operator" | "member"; canPropose: boolean; canVote: boolean };
/** The gateway's answer: the signed-in account and its access to each agent it may see. */
export type GatewayViewer = { account: string; access: Record<string, Access> };
/** The viewer of one page: on an agent's pages, its access to that agent; on the home page, the most it has on any. */
export type Viewer = { account: string } & Access;

export function viewerOf({ account, access }: GatewayViewer, agent: string | null): Viewer {
  if (agent !== null) return { account, ...(access[agent] ?? { role: "member", canPropose: false, canVote: false }) };
  const all = Object.values(access);
  return {
    account,
    role: all.some((a) => a.role === "operator") ? "operator" : "member",
    canPropose: all.some((a) => a.canPropose),
    canVote: all.some((a) => a.canVote),
  };
}

/** The hosted viewer; null locally. */
export const ViewerContext = createContext<Viewer | null>(null);
export const useViewer = () => useContext(ViewerContext);

/** Whether this visitor may run actions that move money or change settings. */
export const useIsOperator = () => {
  const viewer = useViewer();
  return viewer === null || viewer.role === "operator";
};
