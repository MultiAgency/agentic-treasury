import type { Op } from "./ops.js";
import { ageMinutes, methodOf, recover, unresolved } from "./recover.js";

// `pnpm reconcile` lists money actions without a proven outcome; `--replay` resolves them under their
// original identities. Ambiguous replay is blocked, including when an old client supplies --replay.
const replay = process.argv.includes("--replay");

const label = (op: Op) =>
  `${op.idempotencyKey} (${methodOf(op)}, ${ageMinutes(op)} min old, ${op.status ? `last ${op.status}` : "no response"})`;

if (!replay && !process.argv.includes("--poll")) {
  const open = unresolved();
  if (open.length === 0) console.log("Every money action has a proven outcome.");
  for (const op of open) console.log(`unresolved ${label(op)}`);
  if (open.length > 0) console.log("\nPass --poll for status-only recovery. Ambiguous replay is blocked; provider deduplication is unverified.");
} else {
  const recoveries = await recover({ resend: replay });
  if (recoveries.length === 0) console.log("Every money action has a proven outcome.");
  for (const { op, outcome, status, detail } of recoveries)
    console.log(`${outcome}${status ? ` ${status}` : ""}${detail ? ` (${detail})` : ""}: ${label(op)}`);
  if (recoveries.some((r) => r.outcome === "pending")) console.log("\nSome are still moving: run again to follow them.");
}
