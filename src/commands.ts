import { parseArgs } from "node:util";
import { execute, sweep } from "./approve.ts";
import type { Granted, Role } from "./config.ts";
import type { Machine } from "./machine.ts";
import { EXIT, exitCode, type Outcome } from "./outcome.ts";
import { rebalance, swap } from "./plan.ts";
import { records, status } from "./status.ts";

export const USAGE = `Usage:
  treasury status                          holdings, unresolved operations and activity
  treasury plan                            propose a rebalance toward the saved targets (saves a plan, moves nothing)
  treasury plan swap <from> <to> <amount>  propose one swap, amount in atomic units of <from>
  treasury execute <planId> [--yes]        approve and execute a saved plan
  treasury sweep [--execute [--yes]]       preview, or shield, managed public balances`;

/** The agent's machine route under a role's credential, reaching only the scopes that role is issued with. */
export type Connect = <R extends Role>(role: R) => Machine<Granted<R>>;
/** Where results go, and the owner's explicit approval of an action that moves funds. */
export type Io = { print(value: unknown): void; warn(text: string): void; confirm(question: string): Promise<boolean> };

/** A command, parsed and checked before any configuration is read or anything is sent. */
type Command =
  | { name: "status" }
  | { name: "rebalance" }
  | { name: "swap"; from: string; to: string; amount: string }
  | { name: "execute"; planId: string; yes: boolean }
  | { name: "sweep"; execute: boolean; yes: boolean };

export function parse(argv: string[]): Command | null {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true,
      options: { yes: { type: "boolean", default: false }, execute: { type: "boolean", default: false } } });
  } catch { return null; }
  const { positionals: [command, ...rest], values: { yes, execute } } = parsed;
  switch (command) {
    case "status": return rest.length ? null : { name: "status" };
    case "plan": {
      if (!rest.length) return { name: "rebalance" };
      const [sub, from, to, amount] = rest;
      return sub === "swap" && rest.length === 4 && from && to && amount && /^[1-9]\d*$/.test(amount) ? { name: "swap", from, to, amount } : null;
    }
    case "execute": return rest.length === 1 ? { name: "execute", planId: rest[0]!, yes } : null;
    case "sweep": return rest.length ? null : { name: "sweep", execute, yes };
    default: return null;
  }
}

export async function run(argv: string[], connect: Connect, io: Io): Promise<number> {
  const command = parse(argv);
  if (!command) {
    io.warn(USAGE);
    return EXIT.notSent;
  }
  const notConfirmed: Outcome = { ok: false, kind: "refused", error: "Not confirmed" };

  /** Prints the outcome. After an unknown or partial one, reads what was recorded with the read credential, and never resends. */
  async function finish(outcome: Outcome): Promise<number> {
    io.print({ outcome });
    if (!outcome.ok && (outcome.kind === "unknown" || outcome.kind === "partial")) {
      try { io.print({ recorded: (await records(connect("propose"))).report }); }
      catch (error) { io.warn(`Read activity and unresolved before acting again: ${error instanceof Error ? error.message : error}`); }
    }
    return exitCode(outcome);
  }

  switch (command.name) {
    case "status": {
      const { report, code } = await status(connect("propose"));
      io.print(report);
      return code;
    }
    case "rebalance": {
      const { outcome, planId } = await rebalance(connect("propose"), io.print);
      if (outcome.ok && !planId) io.warn("Nothing to rebalance: no plan was saved.");
      return finish(outcome);
    }
    case "swap": {
      const { outcome, plan } = await swap(connect("propose"), command.from, command.to, command.amount);
      if (plan) io.print(plan);
      return finish(outcome);
    }
    case "execute": {
      const approve = connect("execute");
      if (!command.yes && !await io.confirm(`Execute plan ${command.planId}?`)) return finish(notConfirmed);
      return finish(await execute(approve, command.planId, io.print));
    }
    case "sweep": {
      const sweeper = connect("sweep");
      if (command.execute && !command.yes && !await io.confirm("Shield the managed public balances?")) return finish(notConfirmed);
      return finish(await sweep(sweeper, command.execute, io.print));
    }
  }
}
