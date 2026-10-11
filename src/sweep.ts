import { format } from "./agent.js";
import { sweep } from "./treasury.js";

const execute = process.argv.includes("--execute");

for await (const event of sweep({ execute })) {
  if (event.type === "plan") {
    if (event.exposed.length === 0) {
      console.log("Nothing public to shield.");
      process.exit(0);
    }
    for (const h of event.exposed) console.log(`Shield ${format(h.public, h)} into the confidential balance`);
    if (!execute) console.log("\nDry run. Pass --execute to shield.");
  } else {
    console.log(`${event.status} ${event.correlationId}${event.failureCode ? ` ${event.failureCode}` : ""}`);
  }
}
