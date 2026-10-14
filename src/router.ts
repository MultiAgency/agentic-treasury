import { ownerRoutes } from "./rpc/owner.js";
import { payablesRoutes } from "./rpc/payables.js";
import { treasuryRoutes } from "./rpc/treasury.js";
import { observationsRoutes } from "./rpc/observations.js";

/** Public procedure names stay stable; each module owns one responsibility. */
export const router = {
  ...ownerRoutes,
  ...payablesRoutes,
  ...treasuryRoutes,
  ...observationsRoutes,
};

export type Router = typeof router;
