import { parseArgs } from "node:util";
import { execute, sweep } from "./approve.ts";
import type { Role } from "./config.ts";
import type { Machine, Scope } from "./machine.ts";
import { EXIT, exitCode, type Outcome } from "./outcome.ts";
import { rebalance, swap } from "./plan.ts";
import { records, status } from "./status.ts";

export const USAGE = `Usage:
  treasury status                          holdings, unresolved operations and activity
  treasury plan                            propose a rebalance toward the saved targets (saves a plan, moves nothing)
  treasury plan swap <from> <to> <amount>  propose one swap, amount in atomic units of <from>
  treasury execute <planId> [--yes]        approve and execute a saved plan
  treasury sweep [--execute [--yes]]       preview, or shield, managed public balances`;

/** The agent's machine route under a role's credential, issued with `scopes`. */
export type Connect = <S extends Scope>(role: Role, scopes: readonly S[]) => Machine<S>;
/** Where results go, and the owner's explicit approval of an action that moves funds. */
export type Io = { print(value: unknown): void; warn(text: string): void; confirm(question: string): Promise<boolean> };

export async function run(argv: string[], connect: Connect, io: Io): Promise<number> {
  const { positionals: [command, ...rest], values } = parseArgs({ args: argv, allowPositionals: true,
    options: { yes: { type: "boolean", default: false }, execute: { type: "boolean", default: false } } });
  const confirmed = (question: string) => values.yes ? Promise.resolve(true) : io.confirm(question);
  const notConfirmed: Outcome = { ok: false, kind: "refused", error: "Not confirmed" };

  /** Prints the outcome. After an unknown or partial one, reads what was recorded with the read credential, and never resends. */
  async function finish(outcome: Outcome): Promise<number> {
    io.print({ outcome });
    if (!outcome.ok && (outcome.kind === "unknown" || outcome.kind === "partial")) {
      try { io.print({ recorded: (await records(connect("propose", ["read"]))).report }); }
      catch (error) { io.warn(`Read activity and unresolved before acting again: ${error instanceof Error ? error.message : error}`); }
    }
    return exitCode(outcome);
  }

  switch (command) {
    case "status": {
      const { report, code } = await status(connect("propose", ["read"]));
      io.print(report);
      return code;
    }
    case "plan": {
      const propose = connect("propose", ["prepare"]);
      if (rest[0] === "swap") {
        const [, from, to, amount] = rest;
        if (!from || !to || !amount || !/^[1-9]\d*$/.test(amount)) break;
        const { outcome, plan } = await swap(propose, from, to, amount);
        if (plan) io.print(plan);
        return finish(outcome);
      }
      if (rest.length) break;
      const { outcome, planId } = await rebalance(propose, io.print);
      if (outcome.ok && !planId) io.warn("Nothing to rebalance: no plan was saved.");
      return finish(outcome);
    }
    case "execute": {
      const [planId] = rest;
      if (!planId || rest.length > 1) break;
      const approve = connect("execute", ["execute-plan"]);
      if (!await confirmed(`Execute plan ${planId}?`)) return finish(notConfirmed);
      return finish(await execute(approve, planId, io.print));
    }
    case "sweep": {
      if (rest.length) break;
      const sweeper = connect("sweep", ["sweep"]);
      if (values.execute && !await confirmed("Shield the managed public balances?")) return finish(notConfirmed);
      return finish(await sweep(sweeper, values.execute, io.print));
    }
  }
  io.warn(USAGE);
  return EXIT.notSent;
}
