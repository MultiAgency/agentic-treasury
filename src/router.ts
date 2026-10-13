import { AgentApiError } from "@near-intents-agent-api/sdk";
import { ORPCError, os as base } from "@orpc/server";
import { z } from "zod";
import { depositAddress, pay } from "./agent.js";
import { allHoldings } from "./holdings.js";
import { held } from "./payouts.js";
import { api } from "./api.js";
import { accountExists, daoPayees, describeTreasury, fundingTransaction, isDao } from "./chain.js";
import { daoOwner, ownerFunded } from "./dao-owner.js";
import { saveSettings, status as autopilotStatus, tick } from "./autopilot.js";
import { ticks } from "./evidence.js";
import { agentId, executes, saveEnv } from "./env.js";
import { dismiss, readInbox } from "./inbox.js";
import { ledger, ledgerCsv, reconcileBooks } from "./ledger.js";
import { agreedPayees, notInForce } from "./authorize.js";
import { mandateDigest } from "./mandate.js";
import { adoptStagedGrant, GRANT_LABELS, isLive, liveGrant } from "./grants.js";
import { blocksDispatch, readOps } from "./ops.js";
import { recover } from "./recover.js";
import { steward } from "./llm.js";
import { executePlan } from "./plans.js";
import { ASSETS } from "./policy.js";
import { loadStrategy } from "./strategy.js";
import { MIN_EVERY_MIN } from "./strategy-digest.js";
import { rebalance, sweep, targets } from "./treasury.js";
import { daoRequests, prepare, status, submit } from "./owner-intents.js";
import { cancelPreparedInvoice, listInvoices } from "./invoice-store.js";
import { type AgreementStore, localStore, remoteStore } from "./agreements.js";
import { agreed } from "./invoices.js";

const agreementId = z.string().regex(/^[0-9a-f]{32}$/);

/** This host's agreements when it serves the invoice page; otherwise the invoice host's, if configured. */
function agreementStore(): AgreementStore {
  const { INVOICES_PORT, AGREEMENTS_URL, AGREEMENTS_SECRET } = process.env;
  return !INVOICES_PORT && AGREEMENTS_URL && AGREEMENTS_SECRET ? remoteStore(AGREEMENTS_URL, AGREEMENTS_SECRET) : localStore(agreed);
}

/** The agent's ops log, one row per action, newest first: the request as sent, the mandate (policy revision and digest) and plan it ran under, and how it settled or was refused. */
const activity = () =>
  readOps()
    .map(({ at, kind, request, correlationId, status, refused, policyRevision, policyDigest, planId }) =>
      ({ at, kind, request, correlationId, status, refused, policyRevision, policyDigest, planId }))
    .reverse();

/**
 * Errors reach the page with their message: this server answers only its own page on loopback, and
 * behind the hosted gateway only signed-in members (operators, for anything beyond reads). An Agent
 * API refusal keeps its code (`policy_change_throttled`, ...) for the page to branch on.
 */
function toClientError(error: unknown) {
  if (error instanceof ORPCError) return error;
  if (error instanceof AgentApiError)
    return new ORPCError("BAD_REQUEST", { message: error.detail ?? error.title, data: { code: error.code } });
  return new ORPCError("BAD_REQUEST", { message: error instanceof Error ? error.message : String(error) });
}

const os = base.use(async ({ next }) => {
  try {
    const result = await next();
    const output: unknown = result.output;
    if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return result;
    // A stream's errors are thrown after next() resolves, so they are converted where they occur.
    const stream = output as AsyncIterable<unknown>;
    async function* converted() {
      try {
        yield* stream;
      } catch (error) {
        throw toClientError(error);
      }
    }
    return { ...result, output: converted() as typeof result.output };
  } catch (error) {
    throw toClientError(error);
  }
});

/**
 * The linked treasury when it is a DAO: the owner account its votes sign for, whether that
 * account exists yet, so the page can fund it, and whether it owns the agent.
 */
async function linkedDao() {
  const id = process.env.TREASURY_ACCOUNT;
  if (!id || !(await isDao(id))) return null;
  const owner = await daoOwner(id);
  return { id, owner, funded: await ownerFunded(owner) };
}

const run = z.object({ execute: z.boolean() });
const account = z.string().trim().min(2).max(64);
const units = z.string().regex(/^[0-9]{1,40}$/, "an atomic integer amount");
/** A USD amount in the policy's budget; null leaves that window uncapped. */
const usdAmount = z.string().regex(/^\d+(\.\d+)?$/).nullable();
/** Per-asset caps in raw units. */
const caps = z.record(z.string(), units);

const ownerAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent_create"),
    owner: z.object({ type: z.literal("near"), account_id: z.string(), public_key: z.string() }).optional(),
    role: z.enum(["treasury", "payout"]).optional(),
    payees: z.array(account).max(256).optional(),
  }),
  z.object({
    type: z.literal("grant_issue"),
    label: z.enum(GRANT_LABELS).optional(),
    suffix: z.string().min(1).max(64).optional(),
  }),
  z.object({ type: z.literal("grant_revoke"), grantId: z.string().min(1) }),
  z.object({ type: z.literal("agent_freeze") }),
  z.object({ type: z.literal("agent_unfreeze") }),
  z.object({
    type: z.literal("policy_update"),
    changes: z.object({
      swap: z.boolean().optional(),
      destinations: z.array(z.object({ address: account, confidential: z.boolean() })).max(64).optional(),
      assets: z.array(z.string()).optional(),
      owner_approval: z.boolean().optional(),
      max_actions_per_hour: z.number().int().positive().nullable().optional(),
      budget: z.object({ daily_usd: usdAmount, weekly_usd: usdAmount, monthly_usd: usdAmount }).optional(),
      limits: z
        .object({ per_transaction: caps, hourly: caps, daily: caps, monthly: caps })
        .partial()
        .optional(),
    }),
  }),
  z.object({
    type: z.literal("approval_vote"),
    approvalId: z.uuid(),
    verdict: z.enum(["approve", "reject"]),
    correlationId: z.string(),
  }),
]);

export const router = {
  /**
   * How far onboarding has got: an agent, its owner, and a live grant whose token this server holds.
   * Adopts a staged grant token whose grant is in force, so it writes the settings file at times.
   */
  setup: os.handler(async () => {
    const id = process.env.AGENT_ID;
    const dao = await linkedDao();
    if (!id) return { agentId: null, wallet: null, owner: null, grant: null, dao };
    const [agent, grants] = await Promise.all([api.getAgent(id), api.listGrants(id)]);
    adoptStagedGrant(grants);
    // An approve-only copy holds no grant token: it shows the executor's grant, read from the API.
    const grant = executes()
      ? liveGrant(grants, process.env.AGENT_GRANT_TOKEN)
      : grants.filter((g) => isLive(g)).sort((a, b) => b.expires_at.localeCompare(a.expires_at))[0];
    return {
      agentId: id,
      // The NEAR account that holds the agent's balances: where a treasury pays it.
      wallet: agent.wallet?.near_account_id ?? null,
      owner: agent.owner,
      grant: grant ? { id: grant.grant_id, label: grant.label, expiresAt: grant.expires_at } : null,
      dao,
    };
  }),
  overview: os.handler(async () => {
    const id = agentId();
    const [{ managed: book, unmanaged }, policy, grants] = await Promise.all([allHoldings(), api.getPolicy(id), api.listGrants(id)]);
    const digest = policy.policy ? mandateDigest(policy.policy) : null;
    const strategy = loadStrategy();
    return {
      agentId: id,
      book,
      unmanaged,
      target: targets(strategy),
      rebalance: { minLegUsd: strategy.minLegUsd, maxCostBps: strategy.maxCostBps },
      policy,
      digest,
      /** Why the policy isn't in force, by the rule `authorize` refuses with; null when it is. */
      notInForce: notInForce(policy),
      agreed: policy.policy ? [...agreedPayees(policy.policy)] : [],
      grants: grants.filter((g) => !g.revoked_at),
    };
  }),
  /** Every revision of the owner's mandate, newest first, each with the digest anyone can recompute. */
  policyHistory: os.handler(async () => {
    const revisions = [];
    let cursor: number | undefined;
    do {
      const page = await api.getPolicyHistory(agentId(), { cursor, limit: 50 });
      revisions.push(...page.data);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return revisions.map((r) => ({
      revision: r.revision,
      status: r.status,
      appliedAt: r.applied_at,
      transactionHash: r.transaction_hash,
      digest: r.policy ? mandateDigest(r.policy) : null,
    }));
  }),
  deposit: os.handler(() => depositAddress(ASSETS.USDC)),
  owner: {
    prepare: os
      .input(z.object({ action: ownerAction, signer: z.enum(["wallet", "dao"]) }))
      .handler(({ input }) => prepare(input.action, input.signer)),
    status: os.input(z.object({ correlationId: z.string() })).handler(({ input }) => status(input.correlationId)),
    /** What this server waits for the DAO to sign, for members to check each proposal before voting. */
    pending: os.handler(() => daoRequests()),
    submit: os
      .input(z.object({ correlationId: z.string(), signedData: z.record(z.string(), z.unknown()) }))
      .handler(({ input }) => submit(input.correlationId, input.signedData)),
  },
  /**
   * The account the agent works for, set by the owner: any NEAR account, or a DAO voting through
   * Trezu. A confidential treasury pays on its private side, so its public proposals show no real
   * payees; it gets no payee candidates from the chain.
   */
  treasury: {
    get: os.handler(async () => {
      const id = process.env.TREASURY_ACCOUNT;
      if (!id) return null;
      const confidential = process.env.TREASURY_CONFIDENTIAL === "true";
      const treasury = await describeTreasury(id);
      return { ...treasury, confidential, payees: treasury.dao && !confidential ? await daoPayees(id) : [] };
    }),
    link: os.input(z.object({ accountId: account })).handler(async ({ input }) => {
      if (!(await accountExists(input.accountId))) throw new Error(`${input.accountId} is not a NEAR account`);
      saveEnv({ TREASURY_ACCOUNT: input.accountId, TREASURY_CONFIDENTIAL: "" });
    }),
    unlink: os.handler(() => saveEnv({ TREASURY_ACCOUNT: "", TREASURY_CONFIDENTIAL: "" })),
    setConfidential: os
      .input(z.object({ confidential: z.boolean() }))
      .handler(({ input }) => saveEnv({ TREASURY_CONFIDENTIAL: input.confidential ? "true" : "" })),
    /** A fresh deposit address and the one transaction that pays into it, for the treasury to sign. */
    fund: os.input(z.object({ asset: z.enum(["USDC", "NEAR"]), amount: units })).handler(async ({ input }) => {
      const deposit = await depositAddress(input.asset === "USDC" ? ASSETS.USDC : ASSETS.wNEAR);
      return { deposit, transaction: fundingTransaction(input.asset, deposit.address, input.amount) };
    }),
  },
  pay: os
    .input(z.object({ recipient: account, asset: z.string(), amount: units, confidential: z.boolean() }))
    .handler(({ input }) => pay(input)),
  activity: os.handler(() => activity()),
  /**
   * Agreements with terms (agreements.ts): requested by payees on the invoice page, or offered by the
   * owner. Proposing terms or offering only records them; agreeing is the owner's policy update.
   */
  agreements: {
    list: os.handler(() => agreementStore().list()),
    propose: os.input(z.object({ id: agreementId, until: z.iso.datetime() }))
      .handler(({ input }) => agreementStore().propose(input.id, new Date(input.until))),
    offer: os.input(z.object({ payee: account, amount: z.string(), note: z.string().max(200), until: z.iso.datetime() }))
      .handler(async ({ input }) => ({ id: await agreementStore().offer({ ...input, until: new Date(input.until) }) })),
    decline: os.input(z.object({ id: agreementId })).handler(({ input }) => agreementStore().decline(input.id)),
  },
  /** Operator review reads the same durable invoice records; it never initiates a second payout. */
  invoices: os.handler(() => listInvoices()),
  cancelPreparedInvoice: os.input(z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }))
    .handler(({ input }) => cancelPreparedInvoice(input.id)),
  /**
   * Money actions without a proven outcome: each blocks every new one until resolved. Those held for
   * the owner's approval are listed by `held`, and invoices prepared but never sent by `invoices`.
   */
  unresolved: os.handler(() =>
    readOps()
      .filter(blocksDispatch)
      .map((op) => ({ key: op.idempotencyKey, at: op.at, kind: op.kind, request: op.request, status: op.status ?? null, sent: Boolean(op.correlationId) })),
  ),
  /** Reads existing operation statuses; sends nothing. */
  recover: os.handler(async () =>
    (await recover()).map(({ op, outcome, status, detail }) => ({ key: op.idempotencyKey, outcome, status: status ?? null, detail: detail ?? null })),
  ),
  /** The agent working on its own (src/autopilot.ts): off until the owner turns it on. */
  autopilot: {
    get: os.handler(() => autopilotStatus()),
    set: os
      .input(z.object({ on: z.boolean(), everyMin: z.number().int().min(MIN_EVERY_MIN).max(24 * 60), maxUsd: z.number().int().min(0).max(1_000_000) }))
      .handler(({ input }) => {
        saveSettings(input);
        return autopilotStatus();
      }),
    tick: os.handler(() => tick("operator")),
    /** Every tick's evidence line since `since`: what the scheduler saw and did (src/evidence.ts). */
    evidence: os.input(z.object({ since: z.iso.datetime().optional() })).handler(({ input }) => ticks(input.since)),
  },
  inbox: {
    // Every open message, however old, so dismissing a repeated one clears every copy; and the latest runs.
    list: os.handler(() => {
      const entries = readInbox();
      const runs = new Set(entries.filter((e) => e.level === "run").slice(0, 20));
      return entries.filter((e) => (e.level === "run" ? runs.has(e) : !e.dismissed));
    }),
    dismiss: os.input(z.object({ id: z.uuid() })).handler(({ input }) => dismiss(input.id)),
  },
  /** The books: every money execution with its assets, evidence and the mandate it ran under. */
  ledger: os.handler(() => ledger()),
  ledgerCsv: os.handler(async () => ledgerCsv(await ledger())),
  /** Each balance against its independent record: the chain for public, the API's executions for confidential. */
  reconcileBooks: os.handler(() => reconcileBooks()),
  /** Money actions waiting for the owner's approval. */
  held: os.handler(() => held()),
  /** Previews a rebalance and saves it as a plan; `executePlan` runs it. */
  rebalance: os.handler(() => rebalance()),
  sweep: os.input(run).handler(({ input }) => sweep(input)),
  steward: {
    /** The model proposes; the result is a saved plan, and nothing moves. */
    propose: os
      .input(z.object({ instruction: z.string().trim().max(2000).optional() }))
      .handler(({ input }) => steward({ instruction: input.instruction || undefined })),
  },
  /** Executes a saved plan (the steward's or a rebalance's) exactly as previewed, or refuses if anything material changed. */
  executePlan: os.input(z.object({ planId: z.uuid() })).handler(({ input }) => executePlan(input.planId)),
};

export type Router = typeof router;
