import { tick } from "./autopilot.js";

// `pnpm autopilot` runs one tick now, whether or not the autopilot is on: for cron, or to try it.
console.log(await tick());
