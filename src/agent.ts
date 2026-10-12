import { createIdempotencyKey, type StatusResponse } from "@near-intents-agent-api/sdk";
import { api, checkedStatus, isMoving, waitForStatus } from "./api.js";
import { assertCanDispatch, assertMoneyLock, type MoneyLock, withMoneyLock } from "./lock.js";
import { mandateDigest } from "./mandate.js";
import { AuthorizationHeld, isHeld, isResolved, provenRefusal, readOps, record, settle } from "./ops.js";
import { authorize, type Facts, type Purpose } from "./authorize.js";
import type { Plan, PlannedAction } from "./plans.js";
import { ASSETS } from "./policy.js";
import { loadStrategy } from "./strategy.js";
import { claimInvoiceSubmission, invoiceOperations, markInvoiceUnknown } from "./invoice-store.js";
import { liveGrant } from "./intents.js";

/**
 * The agent this process runs, read on use: the server starts before onboarding creates one,
 * and onboarding or `pnpm create-agent` / `pnpm issue-grant` save it to the instance's settings file.
 */
export function agentId() {
  const id = process.env.AGENT_ID;
  if (!id) throw new Error("AGENT_ID is not set: create an agent first");
  return id;
}

/**
 * Whether this instance sends money actions for its agent. One host is an agent's executor; another
 * instance of the same agent (the owner's local dashboard, while the executor runs elsewhere) sets
 * `EXECUTOR=off`: it still reads, and approves as the owner, but never sends or reconciles.
 */
export const executes = () => process.env.EXECUTOR !== "off";

/** Every money action runs under the agent's grant, never the owner's key. */
export function agent() {
  const grantToken = process.env.AGENT_GRANT_TOKEN;
  if (!grantToken) throw new Error("AGENT_GRANT_TOKEN is not set: issue a grant first");
  return api.forGrant(grantToken);
}

export type Holding = {
  asset: string;
  symbol: string;
  decimals: number;
  price: number;
  public: bigint;
  confidential: bigint;
  usd: number;
};

/** Something the agent holds outside the treasury's assets; null fields where the API has no token data. */
export type Unmanaged = { asset: string; symbol: string; decimals: number | null; amount: bigint; usd: number | null };

/**
 * Everything the agent holds, across public and confidential balances, valued at the API's token
 * prices: the treasury's assets, which the strategies manage, and anything else, such as an asset a
 * swap bought outside the policy, which they leave alone but the owner must see.
 */
export async function allHoldings(): Promise<{ managed: Holding[]; unmanaged: Unmanaged[] }> {
  const [tokens, open, shielded] = await Promise.all([
    api.getTokens(),
    api.getBalances(agentId(), { source: "public" }),
    api.getBalances(agentId(), { source: "confidential" }),
  ]);
  const raw = (view: typeof open, asset: string) =>
    BigInt(view.balances.find((b) => b.asset_id === asset)?.balance_raw ?? "0");
  const managed = Object.values(ASSETS).map((asset) => {
    const token = tokens.find((t) => t.asset_id === asset);
    if (!token?.price) throw new Error(`No price for ${asset}`);
    const balance = { public: raw(open, asset), confidential: raw(shielded, asset) };
    const units = Number(balance.public + balance.confidential) / 10 ** token.decimals;
    return { asset, symbol: token.symbol, decimals: token.decimals, price: token.price, ...balance, usd: units * token.price };
  });
  const treasury = new Set<string>(Object.values(ASSETS));
  const others = new Set([...open.balances, ...shielded.balances].map((b) => b.asset_id).filter((asset) => !treasury.has(asset)));
  const unmanaged = [...others].flatMap((asset) => {
    const amount = raw(open, asset) + raw(shielded, asset);
    if (amount === 0n) return [];
    const token = tokens.find((t) => t.asset_id === asset);
    const usd = token?.price ? (Number(amount) / 10 ** token.decimals) * token.price : null;
    return [{ asset, symbol: token?.symbol ?? asset, decimals: token?.decimals ?? null, amount, usd }];
  });
  return { managed, unmanaged };
}

/** The treasury's assets: what the strategies plan with. */
export const holdings = async () => (await allHoldings()).managed;

export const format = (raw: bigint | string, h: Pick<Holding, "decimals" | "symbol">) =>
  `${(Number(raw) / 10 ** h.decimals).toFixed(6)} ${h.symbol}`;

export async function budgetRemaining() {
  return (await api.getPolicy(agentId())).usage?.budget.monthly.remaining_usd;
}

type Grant = ReturnType<typeof agent>;
/** Immutable first-submission terms; ambiguous outcomes never authorize replay. */
export type Action =
  | { method: "swap"; request: Parameters<Grant["swap"]>[1] }
  | { method: "transfer"; request: Parameters<Grant["transfer"]>[1] }
  | { method: "shield"; request: Parameters<Grant["shield"]>[1] }
  | { method: "unshield"; request: Parameters<Grant["unshield"]>[1] };

/** First submissions only. Remote deduplication semantics are not assumed. */
const FIRST_SUBMISSION = Symbol("first submission in this dispatch");
export async function send(action: Action, idempotencyKey: string, lock: MoneyLock, permit?: symbol): Promise<{ correlation_id: string }> {
  assertMoneyLock(lock);
  if (permit !== FIRST_SUBMISSION) throw new AuthorizationHeld("submission must pass through dispatch; direct replay is blocked");
  const op = readOps().find((op) => op.idempotencyKey === idempotencyKey);
  if (!op || op.refused || op.correlationId || (op.submissionState && op.submissionState !== "PREPARED"))
    throw new AuthorizationHeld("only a recorded, never-submitted operation can initiate a send");
  if (JSON.stringify(op.request) !== JSON.stringify(action.request) || op.method !== action.method)
    throw new AuthorizationHeld("operation terms do not match the recorded request");
  assertCanDispatch(lock, idempotencyKey);
  // Every check that can refuse runs before the claim: once claimed, nothing may throw before the
  // network call, or a payment that never left would read "outcome unknown" and block every send.
  const [grant, id, options] = [agent(), agentId(), { idempotencyKey }];
  // SQLite commits submission-attempted before network I/O. A crash on either side of the
  // following call never authorizes another send for this invoice's stable operation.
  claimInvoiceSubmission(idempotencyKey, action.request);
  switch (action.method) {
    case "swap":
      return (await grant.swap(id, action.request, options)) as { correlation_id: string };
    case "transfer":
      return grant.transfer(id, action.request, options);
    case "shield":
      return grant.shield(id, action.request, options);
    case "unshield":
      return grant.unshield(id, action.request, options);
  }
}

/**
 * Sends one money action under the money lock and follows it to a stable status. The request is
 * logged with its key, the mandate digest it runs under and its USD value before sending; the
 * correlation id as soon as the API answers; then the outcome. Every action passes `authorize` after
 * it is logged and before anything is sent, so a refusal is logged too and the log shows every
 * attempt. Anything else unanswered stays unresolved, and blocks new money actions until
 * status-only reconciliation proves its outcome.
 */
/** A saved plan's send: the leg being sent, whether the autopilot sends it, and the plan's clock. */
export type Sending = { plan: Plan; leg: PlannedAction; autopilot: boolean; now: () => Date };

export async function dispatch(lock: MoneyLock, kind: string, action: Action, sending?: Sending, preparedKey?: string): Promise<StatusResponse> {
  action = structuredClone(action);
  // An approve-only instance never sends: refused before anything is recorded, so nothing is left open.
  if (!executes()) throw new Error("This instance only approves: payouts are sent by the agent's executor on its own host");
  if (preparedKey && !invoiceOperations().some((op) => op.idempotencyKey === preparedKey && op.submissionState === "PREPARED"))
    throw new Error("Invoice operation is not prepared; replay is blocked");
  assertCanDispatch(lock);
  const [view, tokens, grants, shielded] = await Promise.all([
    api.getPolicy(agentId()), api.getTokens(), api.listGrants(agentId()),
    // A payout's funds, so `authorize` can refuse one the wallet can't cover before it goes to a vote.
    action.method === "transfer" ? api.getBalances(agentId(), { source: "confidential" }) : undefined,
  ]);
  const { policy, revision } = view;
  const asset = action.method === "swap" ? action.request.origin_asset : action.request.asset;
  const token = tokens.find((t) => t.asset_id === asset);
  const usdIn = token?.price ? (Number(action.request.amount) / 10 ** token.decimals) * token.price : null;
  // No await between this check, the write-ahead record, authorization and submission. A previous
  // send in this run may have become unresolved, or ownership may have been lost during the reads above.
  assertCanDispatch(lock);
  const idempotencyKey = preparedKey ?? `${kind}:${createIdempotencyKey()}`;
  record({
    at: new Date().toISOString(),
    idempotencyKey,
    kind,
    method: action.method,
    request: action.request,
    policyRevision: revision,
    policyDigest: policy ? mandateDigest(policy) : null,
    usdIn,
    ...(sending && { planId: sending.plan.id }),
  });
  // The provider enforces most of the policy itself; `authorize` refuses what it can't tell apart or
  // doesn't check (what a swap buys, a grant's purpose, a public or duplicate payout, a changed plan).
  const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
  // A payout or invoices grant only transfers: anything else it sends is judged, and refused, as treasury work.
  const payoutGrant = grant?.label === "payout" || grant?.label === "invoices";
  const purpose: Purpose = preparedKey ? "invoice"
    : payoutGrant && action.method === "transfer" ? "payout"
    : sending?.autopilot ? "autopilot"
    : "treasury";
  const common = { now: (sending?.now() ?? new Date()).getTime(), agentId: agentId(), view, grant };
  const balance = shielded?.balances.find((b) => b.asset_id === asset)?.balance_raw ?? "0";
  const facts: Facts[Purpose] = purpose === "treasury" || purpose === "autopilot"
    ? { ...common, plan: sending ? { plan: sending.plan, leg: sending.leg } : null, strategy: loadStrategy(), tokens }
    : purpose === "payout"
      ? { ...common, balance, heldPayouts: readOps().filter(isHeld).map(({ request: r }) => ({ recipient: String(r.recipient), asset: String(r.asset), amount: String(r.amount) })) }
      : { ...common, balance };
  const refusal = authorize(purpose, action, facts as never);
  if (refusal) {
    record({ idempotencyKey, refused: refusal.code });
    throw new LocalRefusal(refusal.code, refusal.message);
  }
  let sent: { correlation_id: string };
  try {
    sent = await send(action, idempotencyKey, lock, FIRST_SUBMISSION);
  } catch (error) {
    // Thrown only before any network call, so nothing was sent.
    if (error instanceof AuthorizationHeld) {
      // Proven local failure before submission; invoice preparation stays available for revalidation.
      if (!preparedKey) record({ idempotencyKey, refused: "local_authorization_held" });
      throw error;
    }
    const code = provenRefusal(error);
    if (code) record({ idempotencyKey, refused: code });
    else if (preparedKey) markInvoiceUnknown(preparedKey);
    throw error;
  }
  record({ idempotencyKey, correlation_id: sent.correlation_id, status: "SENT" });
  // Once accepted, even a non-retryable status-read error cannot prove the action was refused.
  const settled = await waitForStatus(sent.correlation_id).catch((cause: unknown) => {
    if (preparedKey) markInvoiceUnknown(preparedKey);
    throw new Error(`Outcome unknown for ${sent.correlation_id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  });
  record({ idempotencyKey, correlation_id: settled.correlation_id, status: settled.status });
  return settled;
}

/**
 * A one-time address to fund the account from `originAsset`; incoming funds need no grant. Funds
 * land in the confidential balance, so nothing the agent holds sits in public view.
 */
export async function depositAddress(originAsset: string) {
  const { correlation_id, details } = await api.deposit(
    agentId(),
    { origin_asset: originAsset, confidential: true },
    { idempotencyKey: createIdempotencyKey() },
  );
  // Send funds only here (with the memo, if any); the correlation id is not an address.
  if (!details.deposit_address) throw new Error(`Deposit ${correlation_id} came back without an address`);
  return {
    correlationId: correlation_id,
    address: details.deposit_address,
    memo: details.memo ?? null,
    minAmount: details.min_amount ?? null,
    expiresAt: details.expires_at ?? null,
  };
}

/** A refusal this server makes before sending, shaped like the API's so callers read both alike. */
export class LocalRefusal extends Error {
  readonly errors: { code: string }[];
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.errors = [{ code }];
  }
}

/** One transfer to a NEAR Intents account. The policy decides whether it may go: a refusal moves nothing. */
export async function pay(request: { asset: string; amount: string; recipient: string; confidential: boolean }) {
  try {
    const settled = await withMoneyLock((lock) => dispatch(lock, "payout", { method: "transfer", request }));
    return {
      outcome: "settled" as const,
      status: settled.status,
      correlationId: settled.correlation_id,
      failureCode: settled.failure_code,
    };
  } catch (error) {
    const code = error instanceof LocalRefusal ? error.code : provenRefusal(error);
    if (!code) throw error;
    return { outcome: "refused" as const, code };
  }
}

/** How long a held payout stays approvable: the API keeps an approval open for 24 hours. */
const APPROVAL_TTL_MS = 24 * 60 * 60_000;

/**
 * Money actions waiting for the owner's approval, each with the approval that releases it. Any
 * that moved on since are recorded instead, except one released but still on its way: recording
 * `PROCESSING` would leave it unresolved and block every money action until it settles, while it
 * can't be lost. The API's approvals list can come back empty while one is pending (seen on
 * mainnet), so each held execution's own status is the source.
 *
 * Historical payouts absent from the local store come from the API's history, as kind "remote",
 * and are never written here. Current invoice and dashboard submissions share this executor and
 * local activity. If the history can't be read, the local ones still are.
 */
export async function held() {
  const local = readOps().filter(isHeld);
  const waiting = [];
  for (const op of local) {
    const status = checkedStatus(op.correlationId!, await api.getStatus(op.correlationId!));
    const approvalId = (status.details as { approval_id?: string } | null)?.approval_id;
    if (status.status === "PENDING_APPROVAL" && approvalId)
      waiting.push({ at: op.at, kind: op.kind, request: op.request, correlationId: status.correlation_id, approvalId });
    else if (status.status !== "PENDING_APPROVAL" && !isMoving(status.status)) settle(status.correlation_id, status.status);
  }
  const mine = new Set(local.map((op) => op.correlationId));
  try {
    for (const remote of await heldElsewhere()) if (!mine.has(remote.correlationId)) waiting.push(remote);
  } catch (error) {
    console.warn("held: the API's history is unavailable; showing this instance's held actions only", error);
  }
  return waiting;
}

/** Transfers waiting for approval in the API's history, newest first, from the approval window. */
async function heldElsewhere() {
  const since = Date.now() - APPROVAL_TTL_MS;
  const found = [];
  let cursor: string | undefined;
  do {
    const page = await api.getHistory(agentId(), { limit: 50, ...(cursor && { cursor }) });
    for (const entry of page.data) {
      const approvalId = (entry.details as { approval_id?: string } | null)?.approval_id;
      if (entry.type !== "transfer" || entry.status !== "PENDING_APPROVAL" || !approvalId) continue;
      const { request_data: data } = await api.getApproval(agentId(), approvalId);
      const request = { asset: data.token, amount: data.amount, recipient: data.to, confidential: true };
      found.push({ at: entry.created_at, kind: "remote", request, correlationId: entry.correlation_id, approvalId });
    }
    const oldest = page.data.at(-1)?.created_at;
    cursor = page.next_cursor && oldest && Date.parse(oldest) > since ? page.next_cursor : undefined;
  } while (cursor);
  return found;
}
