import { fastnearAuthorization } from "./fastnear.js";

/** Operator diagnostic only; public indexer health never establishes an operation's outcome. */
export async function fastnearStatus(service: "transactions" | "transfers") {
  const host = service === "transactions" ? "tx.main.fastnear.com" : "transfers.main.fastnear.com";
  const url = `https://${host}/status`;
  const started = performance.now();
  try {
    const response = await fetch(url, { headers: fastnearAuthorization(url), redirect: "error", signal: AbortSignal.timeout(10_000) });
    const body: unknown = await response.json();
    const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const number = (key: string) => typeof fields[key] === "number" && Number.isSafeInteger(fields[key]) && (fields[key] as number) >= 0 ? fields[key] as number : null;
    return { service, httpStatus: response.status, elapsedMs: Math.round(performance.now() - started),
      healthy: response.ok && fields.status === "ok", lagSeconds: number("lag_seconds"),
      latestBlockHeight: number("latest_block_height"), latestTransactionBlockHeight: number("latest_tx_block_height") };
  } catch {
    return { service, httpStatus: null, elapsedMs: Math.round(performance.now() - started), healthy: false,
      lagSeconds: null, latestBlockHeight: null, latestTransactionBlockHeight: null };
  }
}
