import type { Op } from "./ops.js";
import { ageMinutes, methodOf, recover, unresolved } from "./recover.js";

// `pnpm reconcile` lists money actions without a proven outcome; `--replay` resolves them under their
// original keys. Replay of an ambiguous request requires a deliberate operator decision (see recover.ts).
const replay = process.argv.includes("--replay");

const label = (op: Op) =>
  `${op.idempotencyKey} (${methodOf(op)}, ${ageMinutes(op)} min old, ${op.status ? `last ${op.status}` : "no response"})`;

if (!replay && !process.argv.includes("--poll")) {
  const open = unresolved();
  if (open.length === 0) console.log("Every money action has a proven outcome.");
  for (const op of open) console.log(`unresolved ${label(op)}`);
  if (open.length > 0) console.log("\nPass --poll for status-only recovery. --replay may duplicate an ambiguous request; provider deduplication is unconfirmed.");
} else {
  const recoveries = await recover({ resend: replay });
  if (recoveries.length === 0) console.log("Every money action has a proven outcome.");
  for (const { op, outcome, status, detail } of recoveries)
    console.log(`${outcome}${status ? ` ${status}` : ""}${detail ? ` (${detail})` : ""}: ${label(op)}`);
  if (recoveries.some((r) => r.outcome === "pending")) console.log("\nSome are still moving: run again to follow them.");
}
