import type { Scope } from "./machine.ts";

/** The Treasury agent's machine route and the credentials for it, from the environment (`.env`). */
export type Config = { origin: string; agent: string };

/**
 * Each role holds its own owner-issued credential, issued with exactly these scopes: the agent proposes, and the owner
 * approves execution separately. A role's client reaches only its scopes (see `machine`).
 */
export const ROLES = {
  propose: { token: "TREASURY_PROPOSE_TOKEN", scopes: ["read", "prepare"] },
  execute: { token: "TREASURY_EXECUTE_TOKEN", scopes: ["execute-plan"] },
  sweep: { token: "TREASURY_SWEEP_TOKEN", scopes: ["sweep"] },
} as const satisfies Record<string, { token: string; scopes: readonly Scope[] }>;
export type Role = keyof typeof ROLES;
/** The scopes a role's credential is issued with. */
export type Granted<R extends Role> = (typeof ROLES)[R]["scopes"][number];

export const isRole = (value: string): value is Role => Object.hasOwn(ROLES, value);

export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = new URL(required(env, "TREASURY_ORIGIN")), agent = required(env, "TREASURY_AGENT");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("TREASURY_ORIGIN must be an HTTPS origin, without credentials, path, query or fragment");
  if (!/^[a-z0-9-]{1,32}$/.test(agent)) throw new Error("TREASURY_AGENT must be an agent name");
  return { origin: origin.origin, agent };
}

/** The role's bearer credential. It is never printed or logged. */
export function token(role: Role, env: NodeJS.ProcessEnv = process.env): string {
  const name = ROLES[role].token, value = required(env, name);
  if (!value.startsWith("tmc_")) throw new Error(`${name} must be a Treasury machine credential (tmc_…)`);
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env`);
  return value;
}
