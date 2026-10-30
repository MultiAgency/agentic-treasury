import type { Machine } from "./machine.ts";
import { exitCode } from "./outcome.ts";

/** The agent's holdings and policy, operations without a proven outcome, and what settled or was refused. Reads only. */
export async function status(read: Machine<"read">) {
  const [overview, unresolved, activity] = await Promise.all([read.call("overview"), read.call("unresolved"), read.call("activity")]);
  return { report: { overview, unresolved, activity }, code: Math.max(exitCode(overview), exitCode(unresolved), exitCode(activity)) };
}
