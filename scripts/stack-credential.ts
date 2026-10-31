// Issues a `portfolio` machine credential on the platform's simulated stack, acting as its owner through the stack's
// `machineCredential` control, and writes it with the stack's origin and agent into `.env`. The token is never printed,
// and never readable under any mode but 0600. Node reads NODE_EXTRA_CA_CERTS before it loads `.env`, so the stack's CA
// is exported instead.
//
//   node scripts/stack-credential.ts <stack directory> <propose|execute|sweep> [ttlSeconds]
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isRole, ROLES } from "../src/config.ts";
import { issue, stack, TTL } from "./stack.ts";

/** `.env` with `values` set: each key replaced where it is, or appended. Comments and blank lines are kept. */
function withValues(env: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values)), lines = env ? env.replace(/\n$/, "").split("\n") : [];
  const updated = lines.map(line => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  return [...updated, ...[...pending].map(([key, value]) => `${key}=${value}`)].join("\n") + "\n";
}

const USAGE = `Usage: stack-credential <stack directory> <${Object.keys(ROLES).join("|")}> [ttlSeconds, ${TTL.min}–${TTL.max}]`;
try {
  const [directory, role, ttl = "3600"] = process.argv.slice(2);
  if (!directory || !role || !isRole(role) || !/^\d+$/.test(ttl)) throw new Error(USAGE);
  const target = stack(directory), name = ROLES[role].token;
  const token = await issue(target, role, Number(ttl));

  // A fresh file created 0600, renamed over `.env`: the token is never written under another mode.
  const temporary = `.env.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, withValues(existsSync(".env") ? readFileSync(".env", "utf8") : "",
      { TREASURY_ORIGIN: target.origin, TREASURY_AGENT: target.agent, [name]: token }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, ".env");
  } finally { rmSync(temporary, { force: true }); }
  console.log(`${name} written to .env (${ROLES[role].scopes.join(", ")}, ${ttl}s)`);
  console.log(`export NODE_EXTRA_CA_CERTS=${target.ca}`);
} catch (error) {
  // Includes the platform's own refusal when issuing fails.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
