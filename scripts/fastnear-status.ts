import { fastnearStatus } from "../src/fastnear-status.js";
// Explicit operator invocation only. Never print upstream bodies, keys, accounts or URLs.
for (const service of ["transactions", "transfers"] as const)
  console.log(JSON.stringify(await fastnearStatus(service)));
