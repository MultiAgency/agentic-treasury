import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AGENT_CONNECTION_ROLES, agentConnectionIssue, agentConnectionPermission, type AgentConnection, type AgentConnectionPermission } from "./contract/agent-connection.js";
import { BadRequest } from "./http.js";
import { writeAtomic } from "./synced.js";

/**
 * The common store for agent connections (see contract/agent-connection.ts): hashed secret, expiry, revocation,
 * reloaded on every request so revocation survives restart. Roles differ only in their principal and permission
 * sets. Treasury's execution delegation (gateway machine credentials) is a separate mechanism and stays so.
 */
const Stored = z.strictObject({
  version: z.literal(1), id: z.uuid(), secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().min(1).max(80), role: z.enum(AGENT_CONNECTION_ROLES), permissions: z.array(agentConnectionPermission).min(1),
  host: z.string().min(1), instance: z.string().min(1), account: z.string().min(2), agentId: z.string().min(1),
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), revoked: z.boolean(),
});
type Stored = z.infer<typeof Stored>;
/** Where a connection may be used: all four must match the record. */
export type ConnectionBinding = { host: string; instance: string; agentId: string };
type Principal = ConnectionBinding & { role: Stored["role"]; account: string };
const hash = (value: string) => createHash("sha256").update(value).digest();
const visible = ({ secretHash: _hash, createdAt, expiresAt, ...record }: Stored): AgentConnection =>
  ({ ...record, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() });
const same = (record: Stored, principal: Principal) => record.role === principal.role && record.account === principal.account &&
  record.host === principal.host.toLowerCase() && record.instance === principal.instance && record.agentId === principal.agentId;

export class AgentConnections {
  constructor(private readonly root: string) {}
  private read(id: string): Stored | null {
    if (!z.uuid().safeParse(id).success) return null;
    let text: string;
    try { text = readFileSync(join(this.root, `${id}.json`), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const record = Stored.parse(JSON.parse(text));
    if (record.id !== id || record.expiresAt <= record.createdAt) throw new Error("Invalid agent connection record");
    return record;
  }
  private all() {
    let files: string[];
    try { files = readdirSync(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.filter(file => file.endsWith(".json")).map(file => this.read(file.slice(0, -5))).filter((r): r is Stored => r !== null);
  }
  /** A new connection for exactly `permissions`; the token is returned once. */
  issue(input: Principal & { permissions: readonly AgentConnectionPermission[]; label: string; ttlSeconds?: number }, now = Date.now()) {
    const parsed = agentConnectionIssue.parse({ label: input.label, ttlSeconds: input.ttlSeconds });
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const parent = openSync(dirname(this.root), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    if ((statSync(this.root).mode & 0o077) !== 0) throw new Error("Agent connection directory must be private");
    if (this.all().length >= 1_024) throw new BadRequest("Agent connection storage is full. Archive expired or revoked connections before adding more.");
    const id = randomUUID(), secret = randomBytes(32).toString("base64url");
    const record = Stored.parse({ version: 1, id, secretHash: hash(secret).toString("hex"), label: parsed.label, role: input.role,
      permissions: [...input.permissions], host: input.host.toLowerCase(), instance: input.instance, account: input.account, agentId: input.agentId,
      createdAt: now, expiresAt: now + parsed.ttlSeconds * 1_000, revoked: false });
    writeAtomic(join(this.root, `${id}.json`), JSON.stringify(record) + "\n", 0o600);
    return { connection: visible(record), token: `tac_${id}.${secret}` };
  }
  /** The live connection a bearer token names, if it is bound to exactly this host, instance and agent; else null. */
  authenticate(authorization: string | undefined, binding: ConnectionBinding, now = Date.now()) {
    const match = authorization?.match(/^Bearer tac_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return null;
    const record = this.read(match[1]!);
    if (!record || record.revoked || now >= record.expiresAt || record.host !== binding.host.toLowerCase() ||
      record.instance !== binding.instance || record.agentId !== binding.agentId) return null;
    return timingSafeEqual(hash(match[2]!), Buffer.from(record.secretHash, "hex")) ? visible(record) : null;
  }
  list(principal: Principal) { return this.all().filter(record => same(record, principal)).map(visible); }
  revoke(id: string, principal: Principal) {
    const record = this.read(id);
    if (!record || !same(record, principal)) return false;
    writeAtomic(join(this.root, `${id}.json`), JSON.stringify({ ...record, revoked: true }) + "\n", 0o600);
    return true;
  }
}

/** Whether a connection permits one action. Nothing is implied by role or account. */
export const connectionMay = (connection: AgentConnection, permission: AgentConnectionPermission) => connection.permissions.includes(permission);
