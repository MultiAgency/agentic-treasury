import type { Machine } from "./machine.ts";
import { exitCode } from "./outcome.ts";

/** The agent's holdings and policy, operations without a proven outcome, and what settled or was refused. Reads only. */
export async function status(read: Machine<"read">) {
  const [overview, recorded] = await Promise.all([read.call("overview"), records(read)]);
  return { report: { overview, ...recorded.report }, code: Math.max(exitCode(overview), recorded.code) };
}

/** What an action with an unknown outcome is followed by: operations without a proven outcome, and recorded activity. */
export async function records(read: Machine<"read">) {
  const [unresolved, activity] = await Promise.all([read.call("unresolved"), read.call("activity")]);
  return { report: { unresolved, activity }, code: Math.max(exitCode(unresolved), exitCode(activity)) };
}
