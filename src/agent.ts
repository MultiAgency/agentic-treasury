import { createIdempotencyKey, type StatusResponse } from "@near-intents-agent-api/sdk";
import { api, isMoving, waitForStatus } from "./api.js";
import { assertCanDispatch, assertMoneyLock, type MoneyLock, withMoneyLock } from "./lock.js";
import { mandateDigest } from "./mandate.js";
import { isHeld, isResolved, provenRefusal, readOps, record, settle } from "./ops.js";
import { ASSETS, assetGuard } from "./policy.js";

/**
 * The agent this process runs, read on use: the server starts before onboarding creates one,
 * and onboarding or `pnpm create-agent` / `pnpm issue-grant` save it to the instance's settings file.
 */
export function agentId() {
  const id = process.env.AGENT_ID;
  if (!id) throw new Error("AGENT_ID is not set: create an agent first");
  return id;
}

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
/** A money action as data, so a lost one can be replayed under its original key. */
export type Action =
  | { method: "swap"; request: Parameters<Grant["swap"]>[1] }
  | { method: "transfer"; request: Parameters<Grant["transfer"]>[1] }
  | { method: "shield"; request: Parameters<Grant["shield"]>[1] }
  | { method: "unshield"; request: Parameters<Grant["unshield"]>[1] };

/** Sends one action. Under a key already used, the API replays the original instead of acting again. */
export async function send(action: Action, idempotencyKey: string, lock: MoneyLock): Promise<{ correlation_id: string }> {
  assertMoneyLock(lock);
  const [grant, id, options] = [agent(), agentId(), { idempotencyKey }];
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
 * correlation id as soon as the API answers; then the outcome. A proven refusal is logged as one,
 * `assetGuard`'s included: it refuses before anything is sent, so the log shows every attempt. Anything else unanswered stays unresolved, and
 * blocks new money actions until status-only reconciliation proves its outcome.
 */
export type SendGate = (view: Pick<Awaited<ReturnType<typeof api.getPolicy>>, "policy" | "revision">, tokens: Awaited<ReturnType<typeof api.getTokens>>) => void;

export async function dispatch(lock: MoneyLock, kind: string, action: Action, planId?: string, gate?: SendGate): Promise<StatusResponse> {
  assertCanDispatch(lock);
  const [{ policy, revision }, tokens] = await Promise.all([api.getPolicy(agentId()), api.getTokens()]);
  const asset = action.method === "swap" ? action.request.origin_asset : action.request.asset;
  const token = tokens.find((t) => t.asset_id === asset);
  const usdIn = token?.price ? (Number(action.request.amount) / 10 ** token.decimals) * token.price : null;
  // No await between this gate, the write-ahead record and submission. A previous send in this
  // run may have become unresolved, or ownership may have been lost during the reads above.
  assertCanDispatch(lock);
  gate?.({ policy, revision }, tokens);
  const idempotencyKey = `${kind}:${createIdempotencyKey()}`;
  record({
    at: new Date().toISOString(),
    idempotencyKey,
    kind,
    method: action.method,
    request: action.request,
    policyRevision: revision,
    policyDigest: policy ? mandateDigest(policy) : null,
    usdIn,
    ...(planId && { planId }),
  });
  const denied = policy && assetGuard(action, policy);
  if (denied) {
    record({ idempotencyKey, refused: "asset_out_not_allowed" });
    throw new LocalRefusal("asset_out_not_allowed", denied);
  }
  let sent: { correlation_id: string };
  try {
    sent = await send(action, idempotencyKey, lock);
  } catch (error) {
    const code = provenRefusal(error);
    if (code) record({ idempotencyKey, refused: code });
    throw error;
  }
  record({ idempotencyKey, correlation_id: sent.correlation_id, status: "SENT" });
  // Once accepted, even a non-retryable status-read error cannot prove the action was refused.
  const settled = await waitForStatus(sent.correlation_id).catch((cause: unknown) => {
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

/** The API's code for a request it refused before anything moved, if this error is one. */
export function refusalCode(error: unknown) {
  return (error as { errors?: { code: string }[] }).errors?.[0]?.code;
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

/**
 * Money actions waiting for the owner's approval, each with the approval that releases it. Any
 * that moved on since are recorded instead, except one released but still on its way: recording
 * `PROCESSING` would leave it unresolved and block every money action until it settles, while it
 * can't be lost. The API's approvals list can come back empty while one is pending (seen on
 * mainnet), so each held execution's own status is the source.
 */
export async function held() {
  const waiting = [];
  for (const op of readOps().filter(isHeld)) {
    const status = await api.getStatus(op.correlationId!);
    const approvalId = (status.details as { approval_id?: string } | null)?.approval_id;
    if (status.status === "PENDING_APPROVAL" && approvalId)
      waiting.push({ at: op.at, kind: op.kind, request: op.request, correlationId: status.correlation_id, approvalId });
    else if (status.status !== "PENDING_APPROVAL" && !isMoving(status.status)) settle(status.correlation_id, status.status);
  }
  return waiting;
}
