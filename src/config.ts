/** The Treasury agent's machine route and the credentials for it, from the environment (`.env`). */
export type Config = { origin: string; agent: string };

/** Each role holds its own owner-issued credential: the agent proposes, the owner approves execution separately. */
export const TOKENS = {
  propose: "TREASURY_PROPOSE_TOKEN",
  execute: "TREASURY_EXECUTE_TOKEN",
  sweep: "TREASURY_SWEEP_TOKEN",
} as const;
export type Role = keyof typeof TOKENS;

export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = new URL(required(env, "TREASURY_ORIGIN")), agent = required(env, "TREASURY_AGENT");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("TREASURY_ORIGIN must be an HTTPS origin, without credentials, path, query or fragment");
  if (!/^[a-z0-9-]{1,32}$/.test(agent)) throw new Error("TREASURY_AGENT must be an agent name");
  return { origin: origin.origin, agent };
}

/** The role's bearer credential. It is never printed or logged. */
export function token(role: Role, env: NodeJS.ProcessEnv = process.env): string {
  const value = required(env, TOKENS[role]);
  if (!value.startsWith("tmc_")) throw new Error(`${TOKENS[role]} must be a Treasury machine credential (tmc_…)`);
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env`);
  return value;
}
