// Issues a `portfolio` machine credential on the platform's simulated stack, acting as its owner through the stack's
// `machineCredential` control, and writes it with the stack's origin and agent into `.env` (mode 0600).
// The token is never printed. Node reads NODE_EXTRA_CA_CERTS before it loads `.env`, so the stack's CA is exported instead.
//
//   node scripts/stack-credential.ts <stack directory> <propose|execute|sweep> [ttlSeconds]
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { TOKENS, type Role } from "../src/config.ts";
import { ISSUED, issue, stack } from "./stack.ts";

const [directory, role, ttl = "3600"] = process.argv.slice(2);
if (!directory || !(role && role in ISSUED)) throw new Error("Usage: stack-credential <stack directory> <propose|execute|sweep> [ttlSeconds]");

const target = stack(directory), name = TOKENS[role as Role];
const values: Record<string, string> = { TREASURY_ORIGIN: target.origin, TREASURY_AGENT: target.agent, [name]: await issue(target, role as Role, Number(ttl)) };
const kept = (existsSync(".env") ? readFileSync(".env", "utf8") : "").split("\n").filter(line => line && !(line.split("=")[0]! in values));
writeFileSync(".env", [...kept, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join("\n") + "\n", { mode: 0o600 });
chmodSync(".env", 0o600);
console.log(`${name} written to .env (${ISSUED[role as Role].join(", ")}, ${ttl}s)`);
console.log(`export NODE_EXTRA_CA_CERTS=${target.ca}`);
