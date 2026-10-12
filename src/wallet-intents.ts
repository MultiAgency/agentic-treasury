import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type OwnerWallet, type SubmitIntentRequest } from "@near-intents-agent-api/sdk";
import { api, checkedStatus } from "./api.js";
import { completeSigning, type DaoSigning, daoOwner, findSignature, latestBlock, proposalAndVote, proposalTransaction, signingRequest, signTransaction } from "./dao-owner.js";
import { ENV_FILE, saveEnv } from "./env.js";
import { agentId, executes } from "./agent.js";
import {
  type GrantPurpose,
  grantRequest,
  ownerRequests,
  type PolicyChanges,
  policyRequest,
  promoteGrantToken,
  stageGrantToken,
} from "./intents.js";
import type { AgentKind } from "./policy.js";
import { daoPolicy, nextProposalId } from "./chain.js";
import { mandateDigest } from "./mandate.js";
import { settle } from "./ops.js";
import { checkPaymentApproval, type PaymentApproval } from "./payment-approval.js";
import { acquireMoneyLock, assertMoneyLock } from "./lock.js";

/**
 * Owner actions, signed by the owner's browser wallet or by a DAO. The server prepares each with
 * the API key; a wallet signs the payload exactly as generated, while a DAO files one proposal
 * asking its MPC key to sign the payload's hash, and the server submits that signature once the
 * vote passes. The API key and the grant token never reach the browser.
 */

export type OwnerAction =
  | { type: "agent_create"; owner?: OwnerWallet; kind?: AgentKind; payees?: string[] }
  | { type: "grant_issue"; purpose?: GrantPurpose; suffix?: string }
  /** Stops one grant at once; operations it already committed still finish. */
  | { type: "grant_revoke"; grantId: string }
  | { type: "agent_freeze" }
  | { type: "agent_unfreeze" }
  | { type: "policy_update"; changes: PolicyChanges }
  /** Releases (or rejects) one held money action: `correlationId` is that execution's. */
  | { type: "approval_vote"; approvalId: string; verdict: "approve" | "reject"; correlationId: string };

export type Signer = "wallet" | "dao";

type Prepared = { stage?: "prepared" | "submitted" | "settled"; result?: { status: string; failureCode?: string | null }; ownerSucceeded?: boolean; type: string; expiresAt: string; grantToken?: string; releases?: string; dao?: DaoSigning; paymentApproval?: PaymentApproval;
  /** The owner's signature as submitted, kept to send again if the API never received it. */
  signedData?: Record<string, unknown> };

/**
 * Durable prepared, submitted and settled intents. They are kept in a file per
 * instance, so a restart forgets neither a DAO vote in progress nor the grant token it would issue.
 * The file holds grant tokens: it is as private as the settings file.
 */
const PENDING_FILE = join(".owner-intents", `${basename(ENV_FILE)}.json`);
const pending = new Map<string, Prepared>(
  existsSync(PENDING_FILE) ? Object.entries(JSON.parse(readFileSync(PENDING_FILE, "utf8")) as Record<string, Prepared>) : [],
);

/** How each DAO-signed intent ended, for the page to follow. */
const outcomes = new Map<
  string,
  { stage: "submitting" | "submitted" | "expired" | "failed"; status?: string; failureCode?: string | null; error?: string }
>();

function savePending() {
  // A grant token is kept only until it is in the settings file (promoted) or can no longer be (settled):
  // after that, a copy here would only be one more place a live credential could leak from.
  for (const prepared of pending.values()) if (prepared.ownerSucceeded || prepared.stage === "settled") delete prepared.grantToken;
  mkdirSync(dirname(PENDING_FILE), { recursive: true });
  // Written whole, then renamed over the old file: a crash mid-write leaves the previous version.
  writeFileSync(`${PENDING_FILE}.tmp`, JSON.stringify(Object.fromEntries(pending)), { mode: 0o600 });
  renameSync(`${PENDING_FILE}.tmp`, PENDING_FILE);
}

/** Drops intents past the API's signing window, a DAO's recorded as expired for the page; true if any. */
function expire() {
  let dropped = false;
  for (const [correlationId, { dao, expiresAt, stage, type }] of pending) {
    if (stage === "submitted" || stage === "settled") continue;
    if (Date.now() <= new Date(expiresAt).getTime()) continue;
    pending.delete(correlationId);
    if (dao) {
      outcomes.set(correlationId, { stage: "expired" });
      // Kept so a proposal filed for it can still be recognised once its signing window has closed.
      mkdirSync(dirname(EXPIRED_FILE), { recursive: true });
      appendFileSync(EXPIRED_FILE, `${JSON.stringify({ correlationId, type, expiresAt, hash: dao.hash, intent: dao.intent, delegate: dao.delegate ?? null })}\n`);
    }
    dropped = true;
  }
  return dropped;
}

/** DAO signing requests whose window closed before the vote passed: what they were, nothing secret. */
const EXPIRED_FILE = join(".owner-intents", `${basename(ENV_FILE)}.expired.jsonl`);

function hold(correlationId: string, prepared: Prepared) {
  expire();
  pending.set(correlationId, { ...prepared, stage: "prepared" });
  savePending();
}

async function build(
  action: OwnerAction,
): Promise<{ request: Parameters<typeof api.generateIntent>[0]; grantToken?: string; releases?: string }> {
  switch (action.type) {
    case "agent_create":
      // Onboarding creates the server's one agent; it never replaces a configured one.
      if (process.env.AGENT_ID) throw new Error("An agent is already configured");
      if (!action.owner) throw new Error("agent_create needs an owner");
      return { request: ownerRequests.agent_create(action.owner, action.kind, action.payees) };
    case "grant_issue": {
      // The new grant's token is saved where it is prepared: only the agent's executor may hold it.
      if (!executes()) throw new Error("This copy only reads and approves: issue the grant from the agent's executor, which must hold its token");
      const { token, request } = await grantRequest({ purpose: action.purpose, suffix: action.suffix });
      return { request, grantToken: token };
    }
    case "grant_revoke":
      return { request: { type: "grant_revoke", agent_id: agentId(), grant_id: action.grantId } as const };
    case "policy_update":
      return { request: await policyRequest(action.changes) };
    case "approval_vote": {
      const { approvalId, verdict, correlationId } = action;
      const request = { type: "approval_vote", agent_id: agentId(), approval_id: approvalId, verdict } as const;
      return { request, releases: correlationId };
    }
    default:
      return { request: ownerRequests[action.type]() };
  }
}

/** The linked treasury's owner account, when the treasury is a DAO signing as owner. */
async function treasuryOwner() {
  const dao = process.env.TREASURY_ACCOUNT;
  if (!dao) throw new Error("Link the DAO as the treasury first");
  return daoOwner(dao);
}

export async function prepare(action: OwnerAction, signer: Signer = "wallet") {
  const paymentApproval = action.type === "approval_vote" ? (await checkPaymentApproval(action)).binding : undefined;
  const owner = signer === "dao" ? await treasuryOwner() : undefined;
  const { request, grantToken, releases } = await build(action.type === "agent_create" && owner ? { ...action, owner } : action);
  const generated = await api.generateIntent(request, { idempotencyKey: crypto.randomUUID() });
  if (generated.type !== request.type) throw new Error("Provider generated a different owner intent type");
  if (paymentApproval && (generated.preview.approval?.approval_id !== paymentApproval.approvalId ||
      generated.preview.approval.request_hash !== paymentApproval.requestHash || generated.preview.approval.verdict !== paymentApproval.verdict))
    throw new Error("Generated approval does not bind the verified payment");
  // The mandate this signature asks for, as the server requested it. Whether the signed payload
  // commits to it is the API's to prove: a NEP-366 edit carries the policy encrypted.
  const digest = request.type === "policy_update" ? mandateDigest(request.policy) : null;
  const base = { correlationId: generated.correlation_id, preview: generated.preview, expiresAt: generated.expires_at, digest };

  if (!owner) {
    hold(generated.correlation_id, { type: generated.type, expiresAt: generated.expires_at, grantToken, releases, paymentApproval });
    return { ...base, intent: generated.intent, signer: generated.signer };
  }
  if (generated.signer.type !== "near" || generated.signer.account_id !== owner.account_id)
    throw new Error("This agent's owner is not the DAO's owner account");
  // Read before the proposal is filed, so its signature can only come later.
  const dao = { ...(await signingRequest(generated.intent, owner)), since: await latestBlock() };
  hold(generated.correlation_id, { type: generated.type, expiresAt: generated.expires_at, grantToken, releases, dao, paymentApproval });
  watch();
  const daoId = process.env.TREASURY_ACCOUNT!;
  const [policy, nextId] = await Promise.all([daoPolicy(daoId), nextProposalId(daoId)]);
  const description = [
    `* Proposal Action: ${generated.preview.summary}`,
    `* Agent: ${process.env.AGENT_ID ?? "a new agent"}`,
    `* Signing window closes: ${generated.expires_at} (approve before then, or the signature can't be used)`,
    `* Signs: hash ${dao.hash} as the agents' owner (v1.signer, path agent-owner)`,
    "* Notes: Filed from the DAO dashboard, where the hash can be checked against this action before voting.",
  ].join(" <br>");
  return {
    ...base,
    dao: {
      owner: owner.account_id,
      transaction: signTransaction(dao.hash),
      // For a member filing it from their own wallet: the same request, described.
      proposal: policy ? proposalTransaction(daoId, dao.hash, description, policy.proposal_bond) : null,
      // For a member who may also vote: filed and approved in one confirmation.
      proposalAndVote: policy && nextId !== null ? proposalAndVote(daoId, dao.hash, description, policy.proposal_bond, nextId) : null,
    },
  };
}

const FINAL = new Set(["SUCCESS", "FAILED", "REFUNDED"]);

/**
 * Apply local effects before marking settled; each effect is safe to repeat after a crash. An intent
 * the API still holds as `PENDING_SIGNATURE` never received the signature: it is sent again while the
 * window is open (the API documents resubmitting the same signature as safe), so a lost request
 * doesn't waste a DAO's vote, and ends as `EXPIRED` once the window has closed.
 */
async function reconcileOne(correlationId: string, prepared: Prepared) {
  if (prepared.stage === "settled") return prepared.result!;
  let owner = prepared.ownerSucceeded && prepared.releases ? undefined : checkedStatus(correlationId, await api.getStatus(correlationId, { signal: AbortSignal.timeout(30_000) }));
  if (owner?.status === "PENDING_SIGNATURE") {
    if (Date.now() >= Date.parse(prepared.expiresAt)) {
      prepared.stage = "settled";
      prepared.result = { status: "EXPIRED", failureCode: "signing_window_closed" };
      savePending();
      return prepared.result;
    }
    // Submitted before signatures were kept: nothing to send again, so it is polled until the window closes.
    if (prepared.signedData && prepared.type !== "approval_vote") {
      await sendSignature(correlationId, prepared, prepared.signedData);
      owner = checkedStatus(correlationId, await api.getStatus(correlationId, { signal: AbortSignal.timeout(30_000) }));
    }
  }
  if (owner?.status === "SUCCESS" && !prepared.ownerSucceeded) {
    if (prepared.type === "agent_create") {
      if (!owner.agent_id) throw new Error("Successful creation has no agent id; recovery remains blocked");
      saveEnv({ AGENT_ID: owner.agent_id });
    }
    if (prepared.grantToken) promoteGrantToken(prepared.grantToken);
    prepared.ownerSucceeded = true;
    savePending();
  }
  const result = prepared.ownerSucceeded && prepared.releases
    ? checkedStatus(prepared.releases, await api.getStatus(prepared.releases, { signal: AbortSignal.timeout(30_000) }))
    : owner;
  if (!result) throw new Error("Missing owner outcome");
  if (prepared.ownerSucceeded && prepared.releases) settle(prepared.releases, result.status);
  const answer = { status: result.status, failureCode: result.failure_code };
  if (FINAL.has(result.status)) {
    prepared.stage = "settled";
    prepared.result = answer;
    savePending();
  }
  return answer;
}

const sendSignature = async (correlationId: string, prepared: Prepared, signedData: Record<string, unknown>) => {
  if (prepared.type !== "approval_vote") return api.submitIntent({ type: prepared.type, correlation_id: correlationId, signed_data: signedData } as SubmitIntentRequest);
  if (!prepared.paymentApproval) throw new Error("Legacy approval has no exact payment binding; prepare a new vote");
  const lock = await acquireMoneyLock({ reconcile: true });
  try {
    if (prepared.stage === "submitted" || prepared.stage === "settled") throw new Error("Approval submission already attempted; poll its existing intent");
    const checked = await checkPaymentApproval(prepared.paymentApproval, prepared.paymentApproval);
    assertMoneyLock(lock);
    prepared.stage = "submitted";
    prepared.signedData = signedData;
    savePending();
    watch();
    checked.assertCurrent();
    return await api.submitIntent({ type: prepared.type, correlation_id: correlationId, signed_data: signedData } as SubmitIntentRequest);
  } finally { await lock.release(); }
};

/**
 * Persist before the request, signature included: after a crash or lost response, polling decides.
 * The signature is sent again only if the API says it never arrived (see `reconcileOne`).
 */
export async function submit(correlationId: string, signedData: Record<string, unknown>) {
  const prepared = pending.get(correlationId);
  if (!prepared) throw new Error("Unknown intent");
  if (prepared.stage === "settled") return prepared.result!;
  if (prepared.stage === "submitted") return reconcileOne(correlationId, prepared);
  if (Date.now() >= Date.parse(prepared.expiresAt)) throw new Error("Intent expired");
  if (prepared.grantToken) stageGrantToken(prepared.grantToken);
  if (prepared.type !== "approval_vote") {
    prepared.stage = "submitted";
    prepared.signedData = signedData;
    savePending();
    watch();
  }
  await sendSignature(correlationId, prepared, signedData);
  return reconcileOne(correlationId, prepared);
}

/** One bounded polling pass. A failed read cannot prevent recovery of another intent. */
export async function reconcileOwnerIntents() {
  const results = [];
  for (const [correlationId, prepared] of pending) {
    if (prepared.stage !== "submitted") continue;
    try {
      results.push({ correlationId, ...(await reconcileOne(correlationId, prepared)) });
    } catch (error) {
      results.push({ correlationId, status: "UNKNOWN", error: String(error) });
    }
  }
  return results;
}

/** Where a DAO-signed intent stands: waiting for the vote, or how it ended. */
export function status(correlationId: string) {
  const saved = pending.get(correlationId);
  if (saved?.stage === "settled") return { stage: "submitted" as const, ...saved.result };
  if (saved?.stage === "submitted") return { stage: "submitting" as const };
  const outcome = outcomes.get(correlationId);
  if (outcome) return outcome;
  const waiting = pending.get(correlationId);
  if (waiting?.dao) return { stage: "voting" as const, expiresAt: waiting.expiresAt };
  return { stage: "unknown" as const };
}

/**
 * Everything this server asked the DAO to sign, with where each stands: still waiting for the vote,
 * done (the signature arrived and was submitted), or expired (the API's window closed first). A
 * member checks a v1.signer proposal against it before voting. Nothing secret: no grant token, no
 * signature.
 */
export function daoRequests(now = Date.now()) {
  const kept = [...pending].flatMap(([correlationId, { type, expiresAt, dao, stage }]) => {
    if (!dao) return [];
    const state = stage === "submitted" || stage === "settled" ? "done" : now <= new Date(expiresAt).getTime() ? "waiting" : "expired";
    return [{ correlationId, type, expiresAt, hash: dao.hash, intent: dao.intent, delegate: dao.delegate ?? null, state }];
  });
  const expired = existsSync(EXPIRED_FILE)
    ? readFileSync(EXPIRED_FILE, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-100)
        .map((line) => ({ ...(JSON.parse(line) as Omit<(typeof kept)[number], "state">), state: "expired" as const }))
    : [];
  return [...kept, ...expired];
}

let watching: NodeJS.Timeout | undefined;
let busy = false;
/** Looks for each pending DAO signature every 10 seconds and submits it once the vote passes. */
function watch() {
  watching ??= setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (expire()) savePending();
      await reconcileOwnerIntents();
      for (const [correlationId, prepared] of pending) {
        const { dao, stage } = prepared;
        if (!dao || stage === "submitted" || stage === "settled") continue;
        const daoId = process.env.TREASURY_ACCOUNT;
        const signature = daoId ? await findSignature(daoId, dao).catch(() => null) : null;
        if (!signature) continue;
        outcomes.set(correlationId, { stage: "submitting" });
        try {
          outcomes.set(correlationId, { stage: "submitted", ...(await submit(correlationId, completeSigning(dao, signature))) });
        } catch (error) {
          // The durable submitted state prevents the next tick from sending again.
          if (pending.has(correlationId)) outcomes.delete(correlationId);
          else outcomes.set(correlationId, { stage: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      busy = false;
    }
  }, 10_000);
  watching.unref();
}

// A DAO vote that was in progress when the server stopped is followed again.
// At start: drop expired intents, and grant tokens kept by records written before they were dropped on save.
if (expire() || [...pending.values()].some((p) => p.grantToken && (p.ownerSucceeded || p.stage === "settled"))) savePending();
if ([...pending.values()].some((p) => p.dao || p.stage === "submitted")) watch();
