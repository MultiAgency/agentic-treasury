import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Activity, Books, Unresolved } from "./activity";
import { Overview } from "./overview";
import { Policy } from "./policy";
import { Shell } from "./shell";
import { Automations, Steward } from "./strategies";
import { PayeesSection, TreasurySection } from "./treasury";

const root = createRootRoute({ component: Shell });
const page = <P extends string>(path: P, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => root, path, component });

export const router = createRouter({
  routeTree: root.addChildren([
    page("/", Overview),
    page("/steward", Steward),
    page("/automations", Automations),
    page("/treasury", TreasurySection),
    page("/payees", PayeesSection),
    page("/policy", Policy),
    page("/activity", () => (
      <>
        <Unresolved />
        <Books />
        <Activity />
      </>
    )),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
