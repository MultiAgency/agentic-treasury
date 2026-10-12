import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * This instance's settings file. The default instance keeps everything in `.env`. Another
 * instance (a second agent beside the CLI's) names its own with `ENV_FILE`: shared keys such as
 * the API keys still come from `.env`, but the agent-specific ones start empty and come only from
 * its file, so it never runs, or overwrites, the default instance's agent.
 */
export const ENV_FILE = process.env.ENV_FILE || ".env";
const INSTANCE_KEYS = ["AGENT_ID", "AGENT_GRANT_TOKEN", "AGENT_GRANT_TOKEN_PENDING", "TREASURY_ACCOUNT", "TREASURY_CONFIDENTIAL"];
if (ENV_FILE !== ".env") {
  for (const key of INSTANCE_KEYS) delete process.env[key];
  if (existsSync(ENV_FILE)) Object.assign(process.env, parseEnv(readFileSync(ENV_FILE, "utf8")));
}

/**
 * Saves values to this instance's settings file, replacing earlier ones, and applies them to this
 * process. The dashboard and the CLIs share the agent through it, beside the API key. It holds the
 * grant token, so it is readable only by its owner, and is replaced whole: a crash mid-write leaves
 * the previous file, never a truncated one. A symlinked file is updated at its target.
 */
export function saveEnv(values: Record<string, string>) {
  const kept = (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "")
    .split("\n")
    .filter((line) => !Object.keys(values).some((key) => line.startsWith(`${key}=`)))
    .join("\n")
    .trimEnd();
  const added = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  const file = existsSync(ENV_FILE) ? realpathSync(ENV_FILE) : ENV_FILE;
  rmSync(`${file}.tmp`, { force: true }); // a leftover from a crash would keep its own mode
  writeFileSync(`${file}.tmp`, `${[kept, ...added].filter(Boolean).join("\n")}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  Object.assign(process.env, values);
}
