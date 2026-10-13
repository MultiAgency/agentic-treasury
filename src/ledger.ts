import type { StatusResponse } from "@near-intents-agent-api/sdk";
import { agentId } from "./env.js";
import { api } from "./api.js";
import { fastnearPost, transactionsApi } from "./chain.js";
import { readOps } from "./ops.js";

/**
 * The agent's books, from three sources that each hold part of the story:
 * - the API's history: every execution, its status, amounts and settlement evidence, but no asset ids;
 * - the wallet provider's audit trail: the assets of each request, keyed by provider request id;
 * - this server's ops log: why each action was sent (kind, plan) and under which mandate.
 *
 * Reconciliation compares each balance with recorded flows. The public balance lives on
 * `intents.near`, where FastNear's Transfers API indexes every movement, so it must match to the unit.
 * The confidential balance lives on `intents.far`, which nothing public indexes: it is checked against
 * the API's own executions. Any residual is unexplained: outside credits, missing records or
 * observations taken at different times can all cause it. This is not independent custody proof.
 */

const MONEY = new Set(["deposit", "swap", "transfer", "shield", "unshield", "withdraw"]);

export type Row = {
  at: string;
  settledAt: string;
  type: string;
  status: string;
  failureCode: string | null;
  confidential: boolean;
  assetIn: string | null;
  amountIn: string | null;
  assetOut: string | null;
  amountOut: string | null;
  recipient: string | null;
  correlationId: string;
  intentHash: string | null;
  approvalId: string | null;
  /** Why this server sent it; null for actions it did not send (deposits, other clients). */
  kind: string | null;
  planId: string | null;
  policyRevision: number | null;
  policyDigest: string | null;
  usdIn: number | null;
};

type Details = Record<string, unknown> & { evidence?: Record<string, unknown> };
/** A provider request event. Confidential requests name `origin_asset`/`destination_asset`, public swaps `token_in`/`token_out`. */
type AuditEvent = {
  type: string;
  request_id?: string;
  origin_asset?: string;
  destination_asset?: string;
  token_in?: string;
  token_out?: string;
  amount_in?: string;
  recipient?: string;
};

const text = (value: unknown) => (typeof value === "string" ? value : null);
const field = (details: Details, key: string) => text(details[key]) ?? text(details.evidence?.[key]);

async function history(id: string) {
  const all: StatusResponse[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.getHistory(id, { cursor, limit: 100 });
    all.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return all.filter((e) => MONEY.has(e.type));
}

/** The provider's request events, by request id: what each request spent and bought. */
async function audit(id: string) {
  const byRequest = new Map<string, AuditEvent>();
  for (let offset = 0; ; offset += 100) {
    const { data } = await api.listProviderRecords(id, "audit", { limit: 100, offset });
    const events = (data as { events?: AuditEvent[] }).events ?? [];
    for (const e of events) {
      const origin = e.origin_asset ?? e.token_in;
      if (!e.request_id || !origin || byRequest.has(e.request_id)) continue;
      byRequest.set(e.request_id, { ...e, origin_asset: origin, destination_asset: e.destination_asset ?? e.token_out });
    }
    if (events.length < 100) return byRequest;
  }
}

type Receipts = {
  transactions?: { receipts?: { receipt?: { receiver_id?: string }; execution_outcome?: { outcome?: { logs?: string[] } } }[] }[];
};

/**
 * A deposit's asset, which the API does not report: the token contract whose `ft_transfer` paid the
 * deposit address in the funding transaction.
 */
async function depositAsset(txHash: string, address: string) {
  const { transactions = [] } = await transactionsApi<Receipts>("/transactions", { tx_hashes: [txHash] });
  for (const receipt of transactions.flatMap((t) => t.receipts ?? [])) {
    for (const log of receipt.execution_outcome?.outcome?.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const event = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: { new_owner_id?: string }[] };
      if (event.standard === "nep141" && event.event === "ft_transfer" && event.data?.some((d) => d.new_owner_id === address))
        return `nep141:${receipt.receipt?.receiver_id}`;
    }
  }
  return null;
}

export async function ledger(id = agentId()): Promise<Row[]> {
  const [executions, events] = await Promise.all([history(id), audit(id)]);
  const ops = new Map(readOps().flatMap((op) => (op.correlationId ? [[op.correlationId, op] as const] : [])));
  const rows: Row[] = [];
  for (const e of executions) {
    const details = (e.details ?? {}) as Details;
    const op = ops.get(e.correlation_id);
    const request = (op?.request ?? {}) as Record<string, unknown>;
    const event = events.get(field(details, "provider_request_id") ?? "");
    let assetIn = event?.origin_asset ?? text(request.origin_asset) ?? text(request.asset);
    let assetOut = event?.destination_asset ?? text(request.destination_asset) ?? assetIn;
    const depositTx = field(details, "deposit_tx_hash");
    const address = field(details, "deposit_address");
    if (e.type === "deposit" && e.status === "SUCCESS" && depositTx && address) assetIn = assetOut = await depositAsset(depositTx, address);
    rows.push({
      at: e.created_at,
      settledAt: e.updated_at,
      type: e.type,
      status: e.status,
      failureCode: e.failure_code ?? null,
      confidential: event ? event.type.startsWith("confidential_") : details.confidential === true || request.confidential === true,
      assetIn,
      amountIn: field(details, "amount") ?? event?.amount_in ?? field(details, "deposited_amount"),
      assetOut,
      amountOut: field(details, "amount_out"),
      recipient: event?.recipient ?? text(request.recipient),
      correlationId: e.correlation_id,
      intentHash: field(details, "intent_hash"),
      approvalId: field(details, "approval_id"),
      kind: op?.kind ?? null,
      planId: op?.planId ?? null,
      policyRevision: op?.policyRevision ?? null,
      policyDigest: op?.policyDigest ?? null,
      usdIn: op?.usdIn ?? null,
    });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

type Transfer = { asset_id: string; amount: string };

/** Every movement of the account's public `intents.near` balance, from FastNear's Transfers API. */
async function publicTransfers(account: string) {
  const all: Transfer[] = [];
  let resume_token: string | undefined;
  do {
    const page = await fastnearPost<{ transfers: Transfer[]; resume_token?: string | null }>(
      "https://transfers.main.fastnear.com/v0/transfers",
      { account_id: account, limit: 100, ...(resume_token && { resume_token }) },
    );
    all.push(...page.transfers);
    resume_token = page.resume_token ?? undefined;
  } while (resume_token);
  return all;
}

const add = (book: Map<string, bigint>, asset: string | null, amount: string | null, sign: 1n | -1n) => {
  if (asset && amount) book.set(asset, (book.get(asset) ?? 0n) + sign * BigInt(amount));
};

/** What the agent's confidential balance should hold from the API's own executions alone. */
function confidentialFlows(rows: Row[]) {
  const book = new Map<string, bigint>();
  for (const r of rows.filter((r) => r.status === "SUCCESS")) {
    if (r.type === "shield") add(book, r.assetOut, r.amountOut, 1n);
    else if (r.type === "unshield") add(book, r.assetIn, r.amountIn, -1n);
    else if (!r.confidential) continue;
    else if (r.type === "swap") {
      add(book, r.assetIn, r.amountIn, -1n);
      add(book, r.assetOut, r.amountOut, 1n);
    } else if (r.type === "transfer" || r.type === "withdraw") add(book, r.assetIn, r.amountIn, -1n);
    else if (r.type === "deposit") add(book, r.assetOut, r.amountOut, 1n);
  }
  return book;
}

export type Reconciliation = {
  asset: string;
  symbol: string;
  /** Public balance: the API's figure against the chain's transfers. Any drift is an error. */
  public: { api: string; chain: string; drift: string };
  /** Confidential balance: the API's figure against its recorded executions. */
  confidential: { api: string; recorded: string; unattributed: string };
};

/** Every asset the agent holds or any source saw it move, compared with recorded flows. */
export async function reconcileBooks(id = agentId()): Promise<Reconciliation[]> {
  const [rows, tokens, open, shielded, agent] = await Promise.all([
    ledger(id),
    api.getTokens(),
    api.getBalances(id, { source: "public" }),
    api.getBalances(id, { source: "confidential" }),
    api.getAgent(id),
  ]);
  const account = agent.wallet?.near_account_id;
  if (!account) throw new Error("The agent has no wallet account yet");
  const chain = new Map<string, bigint>();
  for (const t of await publicTransfers(account))
    if (t.asset_id.startsWith("nep245:intents.near:")) add(chain, t.asset_id.slice("nep245:intents.near:".length), t.amount, 1n);
  const recorded = confidentialFlows(rows);
  const balance = (view: typeof open, asset: string) => BigInt(view.balances.find((b) => b.asset_id === asset)?.balance_raw ?? "0");
  const assets = new Set([...open.balances, ...shielded.balances].map((b) => b.asset_id).concat([...chain.keys(), ...recorded.keys()]));
  return [...assets].sort().map((asset) => {
    const [pub, conf] = [balance(open, asset), balance(shielded, asset)];
    const [onChain, expected] = [chain.get(asset) ?? 0n, recorded.get(asset) ?? 0n];
    return {
      asset,
      symbol: tokens.find((t) => t.asset_id === asset)?.symbol ?? asset,
      public: { api: pub.toString(), chain: onChain.toString(), drift: (pub - onChain).toString() },
      confidential: { api: conf.toString(), recorded: expected.toString(), unattributed: (conf - expected).toString() },
    };
  });
}

const COLUMNS: (keyof Row)[] = [
  "at",
  "settledAt",
  "type",
  "status",
  "failureCode",
  "confidential",
  "assetIn",
  "amountIn",
  "assetOut",
  "amountOut",
  "recipient",
  "correlationId",
  "intentHash",
  "approvalId",
  "kind",
  "planId",
  "policyRevision",
  "policyDigest",
  "usdIn",
];

/** The books as CSV, raw amounts in the asset's smallest unit. `usdIn` is recorded from the mandate digest's introduction on; earlier rows leave it blank. */
export function ledgerCsv(rows: Row[]) {
  const cell = (value: unknown) => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((c) => cell(row[c])).join(","))].join("\n") + "\n";
}
