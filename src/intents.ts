import { createGrantCredential, grantCommitment, type OwnerWallet, type Policy } from "@near-intents-agent-api/sdk";
import { agentId } from "./agent.js";
import { api } from "./api.js";
import { saveEnv } from "./env.js";
import { type AgentKind, payoutPolicy, treasuryPolicy } from "./policy.js";
import { loadStrategy, strategyLabelSuffix } from "./strategy.js";

/**
 * The owner actions this treasury uses, built once for both signers: the CLI's owner key and
 * the dashboard's connected wallet.
 */
export const ownerRequests = {
  agent_create: (owner: OwnerWallet, kind: AgentKind = "treasury", payees: string[] = []) =>
    ({
      type: "agent_create",
      name: kind === "payout" ? "Payouts" : "Agentic Treasury",
      owner,
      policy: kind === "payout" ? payoutPolicy(payees) : treasuryPolicy,
    }) as const,
  agent_freeze: () => ({ type: "agent_freeze", agent_id: agentId() }) as const,
  agent_unfreeze: () => ({ type: "agent_unfreeze", agent_id: agentId() }) as const,
};

/** What a grant is for: the agent's own strategies, its payouts, or invoices (the public invoice page). */
export type GrantPurpose = "treasury" | "payout" | "invoices";

/**
 * A grant's label, which the owner sees when signing and the API shows on every operation the grant
 * sends: its purpose, then optionally a suffix the owner's signature binds too, such as a strategy
 * digest. The API takes at most 64 characters.
 */
export function grantLabel(purpose: GrantPurpose, suffix?: string) {
  const label = suffix ? `${purpose}:${suffix}` : purpose;
  if (label.length > 64) throw new Error(`Grant label "${label}" is longer than the API's 64 characters`);
  return label;
}

const PURPOSES: GrantPurpose[] = ["treasury", "payout", "invoices"];

/**
 * The purpose of this agent's grants when none is named: `GRANT_PURPOSE` when this instance is set
 * up to issue one kind (an instance that only issues the invoice page's grant), otherwise what the
 * policy allows: an agent that swaps manages a treasury.
 */
async function agentPurpose(): Promise<GrantPurpose> {
  const configured = process.env.GRANT_PURPOSE;
  if (configured) {
    if (!PURPOSES.includes(configured as GrantPurpose)) throw new Error(`GRANT_PURPOSE must be one of ${PURPOSES.join(", ")}`);
    return configured as GrantPurpose;
  }
  const { policy } = await api.getPolicy(agentId());
  return policy?.actions.includes("swap") ? "treasury" : "payout";
}

/**
 * A fresh grant credential: the token is the agent's secret, the commitment is what the owner signs.
 * A treasury grant's label carries the strategy in force (`strategyLabelSuffix`), so signing it is
 * the owner's approval of that strategy, which the autopilot requires before acting alone.
 */
export async function grantRequest({ purpose, suffix }: { purpose?: GrantPurpose; suffix?: string } = {}) {
  const chosen = purpose ?? (await agentPurpose());
  const label = grantLabel(chosen, suffix ?? (chosen === "treasury" ? strategyLabelSuffix(loadStrategy()) : undefined));
  const { token, commitment } = createGrantCredential();
  return {
    token,
    request: {
      type: "grant_issue",
      agent_id: agentId(),
      label,
      credential: commitment,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    } as const,
  };
}

/**
 * Saves a new grant's token before the owner signs, since a grant whose token is lost is useless,
 * but beside the token in use: that one keeps working until the new grant is in force.
 */
export function stageGrantToken(token: string) {
  saveEnv({ AGENT_GRANT_TOKEN_PENDING: token });
}

/** Makes a staged token the agent's credential, once its grant is in force. */
export function promoteGrantToken(token: string) {
  const staged = process.env.AGENT_GRANT_TOKEN_PENDING === token;
  saveEnv({ AGENT_GRANT_TOKEN: token, ...(staged && { AGENT_GRANT_TOKEN_PENDING: "" }) });
}

type Grant = Awaited<ReturnType<typeof api.listGrants>>[number];

/** The unrevoked, unexpired grant whose credential is `token`, if any. */
export const liveGrant = (grants: Grant[], token: string | undefined) =>
  token
    ? grants.find((g) => !g.revoked_at && new Date(g.expires_at) > new Date() && g.owner_message.credential === grantCommitment(token))
    : undefined;

/**
 * Promotes the staged token once its grant is in force, also when the run that staged it stopped
 * before promoting it (a crash, a status wait that timed out). The owner signed that grant, so it
 * may replace the token in use even while that one still works.
 */
export function adoptStagedGrant(grants: Grant[]) {
  const staged = process.env.AGENT_GRANT_TOKEN_PENDING;
  if (staged && liveGrant(grants, staged)) promoteGrantToken(staged);
}

export type TransferDestination = { address: string; confidential: boolean };

/** What the owner may change in one update; anything left out keeps its current value. */
export type PolicyChanges = Partial<Pick<Policy, "assets" | "owner_approval" | "limits" | "max_actions_per_hour" | "budget">> & {
  /** Whether the agent may swap between its assets. */
  swap?: boolean;
  /** The treasury it may return funds to and the payees in its agreement. */
  destinations?: TransferDestination[];
};

/**
 * The agent's current policy with `changes` applied. Transfers are on exactly while the
 * destination list has an entry, so funds cannot leave without a destination the owner signed.
 */
export async function policyRequest({ swap, destinations, ...fields }: PolicyChanges) {
  const id = agentId();
  const { policy, revision } = await api.getPolicy(id);
  if (!policy || revision === null) throw new Error("The agent's policy is not applied yet");
  const transfers = destinations ?? policy.destinations.list.flatMap((d) => (d.action === "transfer" ? [d] : []));
  const swaps = swap ?? policy.actions.includes("swap");
  const next: Policy = {
    ...policy,
    ...fields,
    actions: [
      ...policy.actions.filter((a) => a !== "swap" && a !== "transfer"),
      ...(swaps ? (["swap"] as const) : []),
      ...(transfers.length ? (["transfer"] as const) : []),
    ],
    destinations: {
      mode: "only",
      list: [
        ...policy.destinations.list.filter((d) => d.action !== "transfer"),
        ...transfers.map(({ address, confidential }) => ({ action: "transfer" as const, address, confidential })),
      ],
    },
  };
  return { type: "policy_update", agent_id: id, expected_revision: revision, policy: next } as const;
}
