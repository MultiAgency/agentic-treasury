import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Router } from "../../src/router.js";

/**
 * Where this agent's pages live: "" when a local agent server serves them, "/a/<agent>" behind the
 * hosted gateway, which forwards that prefix's calls to the agent's own server.
 */
export const BASE = (location.pathname.match(/^\/a\/[a-z0-9-]+/)?.[0] ?? "") as "" | `/${string}`;

export const client: RouterClient<Router> = createORPCClient(new RPCLink({ url: `${BASE}/rpc` }));

export type Overview = Awaited<ReturnType<typeof client.overview>>;
export type Holding = Overview["book"][number];

/** Whether the policy lets the agent swap. The target allocation, rebalancing and the steward apply only then. */
export const swaps = (data: Overview) => Boolean(data.policy.policy?.actions.includes("swap"));

export const units = (raw: bigint | string, decimals: number) => Number(raw) / 10 ** decimals;

export const amount = (raw: bigint | string, h: Pick<Holding, "decimals" | "symbol">) => {
  const n = units(raw, h.decimals);
  const digits = n === 0 ? 0 : n < 1 ? 5 : n < 100 ? 3 : 2;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} ${h.symbol}`;
};

/** "1500000" at 6 decimals → "1.5", exactly: the inverse of `toUnits`. */
export function fromUnits(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ""}`;
}

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

/** Per-asset colour, used everywhere an asset appears in a chart. */
export const ASSET_COLOR: Record<string, string> = {
  USDC: "bg-chart-3",
  wNEAR: "bg-chart-2",
  ETH: "bg-chart-1",
};

/**
 * Follows one strategy stream into React state. Every run refreshes the book and the
 * activity log when it ends, whether it executed, stopped or failed.
 */
export function useRun<I, E>(start: (input: I) => Promise<AsyncIterable<E>>) {
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
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    } finally {
      await queryClient.invalidateQueries();
    }
  }

  return { events, state, input, error, run };
}
