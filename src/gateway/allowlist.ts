import type { Role } from "./roles.js";

/**
 * Which agent-server procedures each role may call through the gateway, by oRPC path. Default deny:
 * a procedure added to the agent server is operator-only until it is listed here.
 *
 * Members read everything and may prepare owner actions: for a DAO-owned agent, preparing one only
 * files a proposal, and nothing happens without the DAO's vote. Money and configuration stay with
 * operators.
 */
const MEMBER = new Set([
  "setup",
  "overview",
  "policyHistory",
  "treasury/get",
  "activity",
  "unresolved",
  "held",
  "autopilot/get",
  "autopilot/evidence",
  "inbox/list",
  "ledger",
  "ledgerCsv",
  "reconcileBooks",
  "owner/status",
  "owner/pending",
  "paymentStatus",
  "owner/prepare",
  "agreements/list",
  // Recording terms beside an agreement a member files as a proposal; nothing is agreed without the vote.
  "agreements/propose",
  "agreements/offer",
]);

/** Whether `role` may call the procedure at `path` (`owner/prepare`, without the `/rpc/` prefix). */
export function mayCall(role: Role, path: string) {
  return role === "operator" || MEMBER.has(path);
}
