import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { BASE } from "../shared/lib";
import { AgentFrame } from "./agent-frame";
import { Walkthrough } from "../features/demo/walkthrough";
import { PayablesPlayer } from "../features/demo/payables-player";
import { AgentHome, AppRedirect } from "../features/demo/agent-home";

const root = createRootRoute({ component: Outlet });
// The agent's own pages load its setup and observations; a moved page redirects without them.
const frame = createRoute({ getParentRoute: () => root, id: "agent", component: AgentFrame });
const page = <P extends string>(path: P, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => frame, path, component });

/** The agent's operational screens live in its app; these Proto paths redirect there with their query and hash. */
export const MOVED = ["/workspace", "/steward", "/automations", "/demo", "/funding", "/treasury", "/payees", "/policy", "/follow/payment", "/follow/run", "/activity"] as const;

export const router = createRouter({
  basepath: BASE || "/",
  routeTree: root.addChildren([
    frame.addChildren([
      page("/", AgentHome),
      page("/demos/treasury", () => <Walkthrough workflow="treasury" short />),
      page("/demos/payables", () => <Walkthrough workflow="payables" short />),
      page("/demos/payables/play", PayablesPlayer),
      page("/demos/invoices", () => <Walkthrough workflow="invoices" short />),
      page("/walkthrough/treasury", () => <Walkthrough workflow="treasury" />),
      page("/walkthrough/payables", () => <Walkthrough workflow="payables" />),
      page("/walkthrough/invoices", () => <Walkthrough workflow="invoices" />),
    ]),
    ...MOVED.map(path => createRoute({ getParentRoute: () => root, path, component: AppRedirect })),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
