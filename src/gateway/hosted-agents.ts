import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { mkdirSynced, writeAtomic } from "../synced.js";
import { accessOf, type Owner } from "./roles.js";
import type { AgentEntry } from "./config.js";

export const setupRequest = z.strictObject({
  owner: z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  kind: z.enum(["wallet", "dao"]),
  area: z.enum(["treasury", "payables"]),
});
type SetupRequest = z.infer<typeof setupRequest>;
const entry = setupRequest.extend({ name: z.string(), port: z.number().int().min(9000).max(9999) });
const registry = z.strictObject({ version: z.literal(1), entries: z.array(entry).max(1000) });
const nameOf = (input: SetupRequest) => `own-${createHash("sha256").update(`${input.owner}:${input.area}`).digest("hex").slice(0,24)}`;
export type HostedAgent = AgentEntry & SetupRequest & { envFile: string };

/** Share infrastructure only, never an existing owner's notifications, intake, signing key or grant. */
export function hostedEnvironment(agent: HostedAgent, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shared: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "NODE_OPTIONS", "NODE_ENV", "PROTO_TEST_MODE", "NEAR_INTENTS_AGENT_API_KEY", "NEAR_INTENTS_AGENT_API_URL", "NEAR_RPC_URL", "FASTNEAR_API_KEY"])
    if (parent[key] !== undefined) shared[key] = parent[key];
  return { ...shared, ENV_FILE: agent.envFile, PORT: String(agent.port), DASHBOARD_AREA: agent.area,
    HOSTED_OWNER: agent.owner, HOSTED_OWNER_KIND: agent.kind, EXECUTOR: "on" };
}

/** Authentication proves the member; DAO membership and proposal rights establish setup access. */
export function authorizeSetup(account: string, kind: SetupRequest["kind"], owner: Owner) {
  const access = accessOf(account, owner);
  if ((kind === "dao") !== Boolean(owner.policy) || !access || !(kind === "dao" ? access.canPropose : access.canSign))
    throw new Error("Sign in as this wallet's owner or a DAO member who can propose owner actions.");
}

/** Additive state. Reservations precede process startup and never replace an existing settings file. */
export class HostedAgents {
  constructor(private directory: string, private configured: AgentEntry[], private capacity = 32) { this.list(); }
  list(): HostedAgent[] {
    const file = join(this.directory, "registry.json");
    if (!existsSync(file)) return [];
    try {
      const parsed = registry.parse(JSON.parse(readFileSync(file, "utf8")));
      const names = new Set(this.configured.map(a => a.name));
      const ports = new Set(this.configured.map(a => a.port));
      return parsed.entries.map(value => {
        const envFile = join(this.directory, `${value.name}.env`);
        if (value.name !== nameOf(value) || names.has(value.name) || ports.has(value.port) || !existsSync(envFile))
          throw new Error("Conflicting or incomplete reservation");
        names.add(value.name); ports.add(value.port);
        return { ...value, envFile, executor: true };
      });
    } catch { throw new Error("Hosted agent registry is unavailable. Preserve registry and settings before recovery."); }
  }
  reserve(raw: SetupRequest): HostedAgent {
    const input = setupRequest.parse(raw);
    mkdirSynced(this.directory);
    const file = join(this.directory, "registry.json");
    const release = lockfile.lockSync(file, { realpath: false, retries: 0, stale: 60_000 });
    try {
      const entries = this.list();
      const previous = entries.find(a => a.owner === input.owner && a.area === input.area);
      if (previous) {
        if (previous.kind !== input.kind) throw new Error("The reserved owner type differs. Review the existing agent.");
        return previous;
      }
      if (this.configured.some(a => a.owner === input.owner && a.area === input.area))
        throw new Error("Open the existing agent for this owner and area.");
      if (entries.length >= this.capacity) throw new Error("Hosted agent capacity reached. Existing agents remain available.");
      const ports = new Set([...this.configured, ...entries].map(a => a.port));
      const port = Array.from({ length: 1000 }, (_, i) => 9000 + i).find(p => !ports.has(p));
      if (!port) throw new Error("Hosted agent capacity reached.");
      const name = nameOf(input);
      const envFile = join(this.directory, `${name}.env`);
      if (existsSync(envFile)) throw new Error("An unregistered settings file exists. Preserve it and recover the registry before retrying.");
      writeAtomic(envFile, `AUTOPILOT=off\n${input.kind === "dao" ? `TREASURY_ACCOUNT=${input.owner}\n` : ""}`, 0o600);
      const value = { ...input, name, port };
      writeAtomic(file, JSON.stringify({ version: 1, entries: [...entries.map(({ name, port, owner, kind, area }) => ({ name, port, owner, kind, area })), value] }), 0o600);
      return { ...value, envFile, executor: true };
    } finally { release(); }
  }
}
