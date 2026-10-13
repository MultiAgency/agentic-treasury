import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { type DaoPolicy, daoPolicy, groupOf, permits } from "../chain.js";
import { daoOwner } from "../dao-owner.js";
import type { Router } from "../router.js";

/**
 * What a signed-in account may do with each agent, read from the agent's owner itself. A Sputnik DAO's
 * members are in one of its groups; any other owner account is its own only member, and signs as
 * owner directly, so it operates its agents. Each agent's operators, named beside it in the
 * dashboard's configuration, operate that agent. Anyone else is refused. Read again at most every
 * minute, so a member the DAO removes loses access within a minute.
 *
 * The configured owner is checked against the agent itself: an agent its own server reports owned by
 * anyone else is closed to everyone, so a wrong `owner` in the configuration can't hand an agent to
 * the wrong people.
 */

export type Role = "operator" | "member";
export type Access = { role: Role; canPropose: boolean; canVote: boolean };
/**
 * An agent's configured owner: a DAO with its policy, or an account (`policy: null`) that holds its own
 * keys. `signer` is the account that signs as the agent's owner: the account itself, or for a DAO the
 * account its MPC key controls (src/dao-owner.ts).
 */
export type Owner = { account: string; policy: DaoPolicy | null; signer: string };
/** The agent's owner as its server reports it (the Agent API's), or null before the agent exists. */
export type AgentOwner = { type: string; account_id?: string } | null;

export function accessOf(account: string, owner: Owner, operators: string[]): Access | null {
  const isOperator = operators.includes(account);
  if (!owner.policy) {
    if (!isOperator && account !== owner.account) return null;
    // No proposals: the owner's own wallet signs.
    return { role: "operator", canPropose: false, canVote: false };
  }
  const roles = owner.policy.roles.filter((r) => groupOf(r).includes(account));
  const permissions = roles.flatMap((r) => r.permissions);
  if (!isOperator && roles.length === 0) return null;
  return {
    role: isOperator ? "operator" : "member",
    // Owner actions are filed as FunctionCall proposals.
    canPropose: permits(permissions, "call", "AddProposal"),
    canVote: permits(permissions, "call", "VoteApprove"),
  };
}

/** Whether the agent answers to the configured owner: not created yet (the owner sets it up), or owned by its signer. */
export const ownedBy = (agent: AgentOwner, owner: Owner) => agent === null || (agent.type === "near" && agent.account_id === owner.signer);

const CACHE_MS = 60_000;
const owners = new Map<string, { owner: Owner; at: number }>();

/** An owner account and, when it is a Sputnik DAO, its policy and signing account; at most a minute old. */
export async function ownerOf(account: string, now = Date.now()): Promise<Owner> {
  const hit = owners.get(account);
  if (hit && now - hit.at <= CACHE_MS) return hit.owner;
  const policy = await daoPolicy(account);
  const owner = { account, policy, signer: policy ? (await daoOwner(account)).account_id : account };
  owners.set(account, { owner, at: now });
  return owner;
}

type Agent = { name: string; owner: string; operators: string[]; port: number };
const reported = new Map<string, { owner: AgentOwner; at: number }>();
/** One read per agent at a time: requests arriving while it's in flight share it. */
const reading = new Map<string, Promise<AgentOwner | undefined>>();

/**
 * The agent's owner as its server on loopback reports it, at most a minute old. While the server
 * doesn't answer (restarting), the last report stands; with none yet, `undefined`: unchecked, so the
 * agent stays closed until its server answers, a few seconds after a deploy.
 */
function agentOwner(agent: Agent, now: number): Promise<AgentOwner | undefined> {
  const hit = reported.get(agent.name);
  if (hit && now - hit.at <= CACHE_MS) return Promise.resolve(hit.owner);
  const inFlight = reading.get(agent.name);
  if (inFlight) return inFlight;
  // Marked as the gateway's own read, apart from the calls it forwards.
  const link = new RPCLink({ origin: `http://127.0.0.1:${agent.port}`, url: "/rpc", headers: { "x-gateway": "owner-check" } });
  const client: RouterClient<Router> = createORPCClient(link);
  const read = client.setup(undefined, { signal: AbortSignal.timeout(3_000) })
    .then(({ owner }) => { reported.set(agent.name, { owner, at: now }); return owner; }, () => hit?.owner)
    .finally(() => reading.delete(agent.name));
  reading.set(agent.name, read);
  return read;
}

/** `account`'s access to each agent it may see, by agent name; empty when it may see none. */
export async function resolveAccess(account: string, agents: Agent[], now = Date.now()) {
  // Every agent at once, so one slow server delays sign-in by its timeout, not the sum of them.
  const granted = await Promise.all(agents.map(async (agent) => {
    const owner = await ownerOf(agent.owner, now);
    const access = accessOf(account, owner, agent.operators);
    if (!access) return null;
    const reportedOwner = await agentOwner(agent, now);
    return reportedOwner !== undefined && ownedBy(reportedOwner, owner) ? ([agent.name, access] as const) : null;
  }));
  return Object.fromEntries(granted.filter((g) => g !== null)) as Record<string, Access>;
}
