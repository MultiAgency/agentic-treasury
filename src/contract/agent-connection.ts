import { z } from "zod";

/**
 * Agent connections: a user connects an external agent to their MultiAgency workspace with an explicit, fixed set of
 * permitted actions, and can list or revoke it. One mechanism for every role; each role has its own principal and
 * permission sets. The first set is a contractor's own compensation reports and their payment-status reads.
 * A connection never carries every permission its user has.
 */
/** The payee role, as sent on the wire. Released 1.5.0 clients expect "supplier" and do not read it (no compatibility, by decision). */
export const PAYEE_ROLE = "payee" as const;
export const AGENT_CONNECTION_ROLES = [PAYEE_ROLE] as const;
/** The contractor-report set: read the account's own compensation records, submit its own reports. */
export const PAYEE_REPORT_PERMISSIONS = ["compensation.read", "compensation.submit"] as const;
export const agentConnectionPermission = z.enum(PAYEE_REPORT_PERMISSIONS);
export type AgentConnectionPermission = z.infer<typeof agentConnectionPermission>;

/** A connection as its user sees it. Never the secret or its hash. */
export const agentConnection = z.object({
  id: z.uuid(),
  label: z.string().min(1).max(80),
  role: z.enum(AGENT_CONNECTION_ROLES),
  permissions: z.array(agentConnectionPermission).min(1),
  /** What the connection is bound to: it is refused anywhere else. */
  host: z.string().min(1),
  instance: z.string().min(1),
  account: z.string().min(2),
  agentId: z.string().min(1),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revoked: z.boolean(),
});
export type AgentConnection = z.infer<typeof agentConnection>;
export const agentConnectionIssue = z.strictObject({
  label: z.string().trim().min(1).max(80),
  ttlSeconds: z.number().int().min(60).max(86_400).default(3_600),
});
/** The token is shown once, at issue; only its hash is stored. */
export const agentConnectionStarted = z.object({ connection: agentConnection, token: z.string().regex(/^tac_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/) });
export const agentConnectionList = z.object({ connections: z.array(agentConnection) });
export const agentConnectionRevoked = z.object({ revoked: z.literal(true) });
