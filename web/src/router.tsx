import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Activity, Books, InvoiceReview, Unresolved } from "./activity";
import { BASE } from "./lib";
import { Overview } from "./overview";
import { Policy } from "./policy";
import { Shell } from "./shell";
import { Steward } from "./steward";
import { Automations } from "./automations";
import { PayeesSection, TreasuryPayees } from "./payees";
import { TreasurySection } from "./treasury";

const root = createRootRoute({ component: Shell });
const page = <P extends string>(path: P, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => root, path, component });

export const router = createRouter({
  basepath: BASE || "/",
  routeTree: root.addChildren([
    page("/", Overview),
    page("/steward", Steward),
    page("/automations", Automations),
    // A treasury agent's few destinations (the DAO, the payout agent) belong with its funding.
    page("/treasury", () => (
      <>
        <TreasurySection />
        <TreasuryPayees />
      </>
    )),
    page("/payees", PayeesSection),
    page("/policy", Policy),
    page("/activity", () => (
      <>
        <Unresolved />
        <InvoiceReview />
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
