// Issues a `portfolio` machine credential on the platform's simulated stack, acting as its owner through the stack's
// `machineCredential` control, and writes it with the stack's origin and agent into `.env` (mode 0600).
// The token is never printed. Node reads NODE_EXTRA_CA_CERTS before it loads `.env`, so the stack's CA is exported instead.
//
//   node scripts/stack-credential.ts <stack directory> <propose|execute|sweep> [ttlSeconds]
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TOKENS, type Role } from "../src/config.ts";
import type { Scope } from "../src/machine.ts";

const ISSUED: Record<Role, Scope[]> = { propose: ["read", "prepare"], execute: ["execute-plan"], sweep: ["sweep"] };

const [directory, role, ttl = "3600"] = process.argv.slice(2);
if (!directory || !(role && role in ISSUED)) throw new Error("Usage: stack-credential <stack directory> <propose|execute|sweep> [ttlSeconds]");

const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as { treasury?: { agent: string; machineBase: string } };
if (!state.treasury) throw new Error("Start the stack with --treasury");

const name = `treasury-${role}-${Date.now()}`, request = join(directory, "controls", `${name}.json`), answer = join(directory, "controls", `${name}.result.json`);
writeFileSync(`${request}.tmp`, JSON.stringify({ command: "machineCredential", label: `treasury ${role}`, scopes: ISSUED[role as Role], ttlSeconds: Number(ttl) }));
renameSync(`${request}.tmp`, request);
for (let waited = 0; !existsSync(answer); waited += 250) {
  if (waited > 15_000) throw new Error("The stack did not answer the control");
  await delay(250);
}
const result = JSON.parse(readFileSync(answer, "utf8")) as { ok: true; value: { token: string } } | { ok: false; error: string };
// The answer holds the token; keep it only in .env.
writeFileSync(answer, JSON.stringify({ ok: result.ok }));
if (!result.ok) throw new Error(`Issuing failed: ${result.error}`);

const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const values: Record<string, string> = {
  TREASURY_ORIGIN: new URL(state.treasury.machineBase).origin,
  TREASURY_AGENT: state.treasury.agent,
  [TOKENS[role as Role]]: result.value.token,
};
const kept = env.split("\n").filter(line => line && !(line.split("=")[0]! in values));
writeFileSync(".env", [...kept, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join("\n") + "\n", { mode: 0o600 });
chmodSync(".env", 0o600);
console.log(`${TOKENS[role as Role]} written to .env (${ISSUED[role as Role].join(", ")}, ${ttl}s)`);
console.log(`export NODE_EXTRA_CA_CERTS=${join(directory, "environment", "localhost.crt")}`);
