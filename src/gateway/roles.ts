import { type DaoPolicy, daoPolicy } from "../chain.js";

/**
 * What a signed-in account may do, read from the DAO itself: a member is in one of its groups, an
 * operator is named in the dashboard's configuration. Anyone else is refused. Read again at most
 * every minute, so a member the DAO removes loses access within a minute.
 */

export type Role = "operator" | "member";
export type Access = { role: Role; canPropose: boolean; canVote: boolean };

/** Whether `permissions` grant `action` on FunctionCall proposals, wildcards included. */
const grants = (permissions: string[], action: string) =>
  permissions.some((p) => p === `call:${action}` || p === `*:${action}` || p === "call:*" || p === "*:*");

export function accessOf(account: string, policy: DaoPolicy, operators: string[]): Access | null {
  const roles = policy.roles.filter((r) => typeof r.kind === "object" && r.kind.Group.includes(account));
  const permissions = roles.flatMap((r) => r.permissions);
  const isOperator = operators.includes(account);
  if (!isOperator && roles.length === 0) return null;
  return {
    role: isOperator ? "operator" : "member",
    canPropose: grants(permissions, "AddProposal"),
    canVote: grants(permissions, "VoteApprove"),
  };
}

const CACHE_MS = 60_000;
let cached: { dao: string; policy: DaoPolicy; at: number } | undefined;

export async function resolveAccess(account: string, dao: string, operators: string[], now = Date.now()) {
  if (!cached || cached.dao !== dao || now - cached.at > CACHE_MS) {
    const policy = await daoPolicy(dao);
    if (!policy) throw new Error(`${dao} is not a Sputnik DAO`);
    cached = { dao, policy, at: now };
  }
  return accessOf(account, cached.policy, operators);
}
