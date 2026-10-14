export { exactPayment, fromUnits } from "./payment-copy";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { queryOptions, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ASSETS } from "../../src/policy.js";
import type { Router } from "../../src/router.js";
import type { Kind } from "./beats";
import { refreshQueries } from "./query-refresh";
import { errorMessage } from "./provider-message";
import { totalUsd } from "../../src/valuation.js";
export { errorMessage } from "./provider-message";

/**
 * Where this agent's pages live: "" when a local agent server serves them, "/a/<agent>" behind the
 * hosted gateway, which forwards that prefix's calls to the agent's own server.
 */
export const BASE = (location.pathname.match(/^\/a\/[a-z0-9-]+/)?.[0] ?? "") as "" | `/${string}`;

/** A client for the agent server whose pages live at `base` (see BASE). */
export const clientFor = (base: "" | `/${string}`): RouterClient<Router> => createORPCClient(new RPCLink({ url: `${base}/rpc` }));

export const client = clientFor(BASE);

/** One call to the hosted gateway's own API (`/gw/...`); its `{ error }` answer is thrown. */
export async function gw<T>(path: `/gw/${string}`, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${path}: ${response.status}`);
  return body;
}

/** The reads several pages share, each with one key and one refresh rate. */
/** How long the API keeps a held payment approvable (the server's APPROVAL_TTL_MS). */
export const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

export const queries = {
  held: queryOptions({ queryKey: ["held"], queryFn: () => client.held(), refetchInterval: 15_000 }),
  inbox: queryOptions({ queryKey: ["inbox"], queryFn: () => client.inbox.list(), refetchInterval: 30_000 }),
  unresolved: queryOptions({ queryKey: ["unresolved"], queryFn: () => client.unresolved(), refetchInterval: 30_000 }),
  agreements: queryOptions({ queryKey: ["agreements"], queryFn: () => client.agreements.list(), refetchInterval: 30_000 }),
};

export type Overview = Awaited<ReturnType<typeof client.overview>>;
export type Holding = Overview["book"][number];

/** Whether the policy lets the agent swap. The target allocation, rebalancing and the steward apply only then. */
export const swaps = (data: Overview) => Boolean(data.policy.policy?.actions.includes("swap"));

/** Which prototype an agent is: one that may swap manages a treasury; one that only pays facilitates payments. */
export const kindOf = (data: Overview): Kind => (swaps(data) ? "treasury" : "facilitator");

export const units = (raw: bigint | string, decimals: number) => Number(raw) / 10 ** decimals;

/** The book's value at the API's prices. */
export const bookValue = (data: Pick<Overview, "book">) => totalUsd(data.book);

/** Payouts are confidential USDC (src/authorize.ts), which an empty wallet's book doesn't list. */
const USDC = { asset: ASSETS.USDC, decimals: 6, symbol: "USDC" };

/** A raw amount of `asset` in words at the book's decimals, or in raw units when the book doesn't list it. */
export function amountOf(raw: string, asset: string, book: Holding[]) {
  const h = book.find((b) => b.asset === asset) ?? (asset === USDC.asset ? USDC : undefined);
  return h ? amount(raw, h) : `${raw} ${asset.replace(/^nep141:/, "")}`;
}

/** A money action's request in words: what moves, how much, and to whom. */
export function describeRequest(request: Record<string, unknown>, book: Holding[], nameOf: (account: string) => string = (a) => a) {
  const r = request as Partial<Record<"origin_asset" | "destination_asset" | "asset" | "amount" | "recipient", string>>;
  return r.origin_asset && r.destination_asset && r.amount
    ? `${amountOf(r.amount, r.origin_asset, book)} → ${book.find((b) => b.asset === r.destination_asset)?.symbol ?? r.destination_asset}`
    : r.asset && r.amount
      ? `${amountOf(r.amount, r.asset, book)}${r.recipient ? ` to ${nameOf(r.recipient)}` : ""}`
      : JSON.stringify(request);
}

/** An account or id short enough for a badge: its head and tail, when it is longer than `max`. */
export const short = (id: string, max = 20) => (id.length > max ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

export const amount = (raw: bigint | string, h: Pick<Holding, "decimals" | "symbol">) => {
  const n = units(raw, h.decimals);
  const digits = n === 0 ? 0 : n < 1 ? 5 : n < 100 ? 3 : 2;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} ${h.symbol}`;
};

/** "1.5" at 6 decimals → "1500000"; null unless it is a positive decimal that fits. */
export function toUnits(value: string, decimals: number) {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return raw > 0n ? raw.toString() : null;
}

export const usd = (n: number | string | null | undefined) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function ago(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return relative.format(Math.round(seconds), "second");
}

/** Seconds until `iso`, ticking while `iso` is set. */
export function useCountdown(iso?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  return iso ? Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000)) : null;
}

/** 125 seconds → "2:05". */
export const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * One action at a time with its outcome: `attempt` runs it, shows its message or its error, and
 * refreshes affected reads on success or failure. Money actions default to refreshing every read.
 */
export function useAttempt(refreshKeys?: readonly QueryKey[]) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** Runs `work`; a string it returns is shown as its outcome. */
  async function attempt(work: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const outcome = await work();
      setMessage(typeof outcome === "string" && outcome ? outcome : undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refreshQueries(queryClient, refreshKeys);
    }
  }
  return { message, error, busy, attempt };
}

/** Per-asset colour, used everywhere an asset appears in a chart. */
export const ASSET_COLOR: Record<string, string> = {
  USDC: "bg-chart-3",
  wNEAR: "bg-chart-2",
  ETH: "bg-chart-1",
};

/**
 * Follows one strategy stream into React state. Every run refreshes the book and the
 * activity log when it ends, whether it executed, stopped or failed. Plan previews may select narrower refreshes.
 */
export function useRun<I, E>(start: (input: I) => Promise<AsyncIterable<E>>, refreshKeys?: readonly QueryKey[]) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<E[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [input, setInput] = useState<I>();
  const [error, setError] = useState<string>();

  async function run(next: I) {
    setInput(next);
    setEvents([]);
    setError(undefined);
    setState("running");
    try {
      for await (const event of await start(next)) setEvents((all) => [...all, event]);
      setState("done");
    } catch (e) {
      setError(errorMessage(e));
      setState("error");
    } finally {
      await refreshQueries(queryClient, refreshKeys);
    }
  }

  return { events, state, input, error, run };
}
