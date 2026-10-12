import { createContext, useContext } from "react";

/**
 * Who is looking, when the dashboard is hosted behind the gateway (src/gateway). Locally there is
 * no gateway and no viewer: the operator on loopback can do everything.
 */
export type Viewer = { account: string; role: "operator" | "member"; canPropose: boolean; canVote: boolean };

/** The hosted viewer; null locally. */
export const ViewerContext = createContext<Viewer | null>(null);
export const useViewer = () => useContext(ViewerContext);

/** Whether this visitor may run actions that move money or change settings. */
export const useIsOperator = () => {
  const viewer = useViewer();
  return viewer === null || viewer.role === "operator";
};
