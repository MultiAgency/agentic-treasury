import { refusals } from "./probes.js";

for await (const event of refusals({ live: process.argv.includes("--live") })) {
  if (event.outcome === "passed")
    console.log(`PASSED   ${event.name}: ${event.status} ${event.correlationId} ${event.failureCode ?? ""}`);
  else if (event.outcome === "unknown") {
    console.log(`UNKNOWN  ${event.name}: ${event.status ?? ""} ${event.detail}. Stopped; reconcile before continuing.`);
    process.exitCode = 1;
  }
  else if (event.outcome === "inconclusive") console.log(`UNREACHED ${event.name}: ${event.code} (policy enforcement not established)`);
  else console.log(`REFUSED  ${event.name}: ${event.code}`);
  console.log(`         budget remaining $${event.budget}`);
}
