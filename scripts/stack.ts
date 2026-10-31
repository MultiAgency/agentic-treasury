// The platform's simulated stack (`pnpm test:e2e:stack --no-browser --treasury` at 5cd4d4d), through its state file and
// control files: never through its internals, except `targets` below (a test-only workaround).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Role } from "../src/config.ts";
import type { Scope } from "../src/machine.ts";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const WNEAR = "nep141:wrap.near";

/** The scopes the owner issues each role's credential with. */
export const ISSUED: Record<Role, Scope[]> = { propose: ["read", "prepare"], execute: ["execute-plan"], sweep: ["sweep"] };

export type Stack = { directory: string; origin: string; agent: string; ca: string };

export function stack(directory: string): Stack {
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as { treasury?: { agent: string; machineBase: string } };
  if (!state.treasury) throw new Error("Start the stack with --treasury");
  return { directory, origin: new URL(state.treasury.machineBase).origin, agent: state.treasury.agent, ca: join(directory, "environment", "localhost.crt") };
}

let sequence = 0;
/** One control file, written whole, and its answer. The answer is reduced to `{ ok }` on disk once read. */
async function control<T>({ directory }: Stack, command: Record<string, unknown>): Promise<T> {
  const name = `treasury-${process.pid}-${Date.now()}-${++sequence}`, request = join(directory, "controls", `${name}.json`), answer = join(directory, "controls", `${name}.result.json`);
  writeFileSync(`${request}.tmp`, JSON.stringify(command));
  renameSync(`${request}.tmp`, request);
  for (let waited = 0; !existsSync(answer); waited += 250) {
    if (waited > 15_000) throw new Error(`The stack did not answer ${command.command}`);
    await delay(250);
  }
  const result = JSON.parse(readFileSync(answer, "utf8")) as { ok: true; value: T } | { ok: false; error: string };
  writeFileSync(answer, JSON.stringify({ ok: result.ok }));
  if (!result.ok) throw new Error(`${command.command} failed: ${result.error}`);
  return result.value;
}

/** The owner issues a `portfolio` machine credential for the role, as on its access page. Returns the token. */
export async function issue(target: Stack, role: Role, ttlSeconds: number): Promise<string> {
  return (await control<{ token: string }>(target, { command: "machineCredential", label: `treasury ${role}`, scopes: ISSUED[role], ttlSeconds })).token;
}

/**
 * Test-only workaround: writes the owner's allocation targets into the agent's strategy file, as the platform's treasury
 * conformance spec does, because the stack has no control for them at 5cd4d4d. The simulator quotes only USDC to wNEAR,
 * so the stack's default targets (which hold ETH) can't be rebalanced toward. Replace with a control once one exists.
 */
export function targets({ directory }: Stack, targetBps: Record<string, number>) {
  const strategy = join(directory, "environment", "portfolio", ".strategy");
  mkdirSync(strategy, { recursive: true });
  writeFileSync(join(strategy, ".env.json"), JSON.stringify({ targetBps, minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 0 } }));
}
