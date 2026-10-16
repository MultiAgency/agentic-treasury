import { Effect, Result } from "effect";
import { z } from "zod";
import { PublicError } from "./public-error.js";
import { FastnearHttp, FastnearHttpLive, fastnearHttpLayer } from "./infrastructure/fastnear-http.js";
export { FastnearHttp } from "./infrastructure/fastnear-http.js";

const messages = {
  Authentication: "FastNear authentication or access failed. Check the server API key and endpoint.",
  RateLimit: "FastNear rate limit reached. Wait before refreshing this read.",
  Unavailable: "FastNear read unavailable. Check connectivity and try the read again.",
  InvalidResponse: "FastNear returned an invalid response. The read is unavailable.",
  ReportedError: "FastNear reported an error. The read is unavailable.",
  Incomplete: "Indexed history is incomplete: read limit, deadline or repeated cursor. No outcome inferred.",
  Cancelled: "FastNear read cancelled. No outcome inferred.",
  DepositEvidence: "Deposit evidence is unavailable: invalid transaction receipts or transfer events.",
} as const;
export class FastnearFailure extends PublicError {
  readonly _tag = "FastnearFailure";
  constructor(readonly kind: keyof typeof messages) { super(messages[kind]); }
}

/** Credentials belong only to documented FastNear HTTPS endpoints. */
export function fastnearAuthorization(url: string, key = process.env.FASTNEAR_API_KEY): Record<string, string> {
  const endpoint = new URL(url);
  const hosts = ["rpc.mainnet.fastnear.com", "archival-rpc.mainnet.fastnear.com", "free.rpc.fastnear.com", "tx.main.fastnear.com", "transfers.main.fastnear.com"];
  return key && endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.port && hosts.includes(endpoint.hostname)
    ? { Authorization: `Bearer ${key}` } : {};
}

export const readDeadline = <A, E, R>(read: Effect.Effect<A, E, R>, milliseconds = 120_000) =>
  Effect.timeoutOrElse(read, { duration: milliseconds, orElse: () => Effect.fail(new FastnearFailure("Incomplete")) });

/** The same abort signal owns fetch and body consumption; there are no automatic retries. */
export const fastnearPostEffect = (url: string, body: object) => readDeadline(Effect.gen(function* () {
  const client = yield* FastnearHttp;
  return yield* Effect.tryPromise({
    try: async signal => {
      signal.throwIfAborted();
      const response = await client.fetch(url, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json", ...fastnearAuthorization(url, client.apiKey()) },
        body: JSON.stringify(body), signal });
      if (!response.ok) {
        // Do not consume or echo error bodies. Cancellation is best effort, never an unbounded wait.
        void response.body?.cancel().catch(() => {});
        throw new FastnearFailure(response.status === 401 || response.status === 403 ? "Authentication"
          : response.status === 429 ? "RateLimit" : "Unavailable");
      }
      let result: unknown;
      try { result = await response.json(); } catch { throw new FastnearFailure("InvalidResponse"); }
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new FastnearFailure("InvalidResponse");
      if ("error" in result && result.error) throw new FastnearFailure("ReportedError");
      return result;
    },
    catch: error => error instanceof FastnearFailure ? error : new FastnearFailure("Unavailable"),
  });
}), 30_000);

export const transactionsEffect = (path: "/account" | "/transactions", body: object) =>
  fastnearPostEffect(`https://tx.main.fastnear.com/v0${path}`, body);
export const decodeRead = <A>(schema: z.ZodType<A>, value: unknown) => Effect.try({
  try: () => schema.parse(value), catch: () => new FastnearFailure("InvalidResponse"),
});

/** All pages are required. A cursor cycle or cap discards partial results. */
export function indexedPages<A, R>(page: (cursor?: string) => Effect.Effect<{ items: A[]; next?: string | null }, FastnearFailure, R>, maxPages = 100) {
  return Effect.gen(function* () {
    const items: A[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let count = 0; ; count++) {
      if (count >= maxPages || cursor && seen.has(cursor)) return yield* Effect.fail(new FastnearFailure("Incomplete"));
      if (cursor) seen.add(cursor);
      const result = yield* page(cursor);
      items.push(...result.items);
      cursor = result.next || undefined;
      if (!cursor) return items;
    }
  });
}

/** Keep typed public failures at the Promise boundary, never expose Effect causes or defects. */
export async function runFastnear<A>(read: Effect.Effect<A, FastnearFailure, FastnearHttp>, signal?: AbortSignal,
  client?: typeof FastnearHttp.Service): Promise<A> {
  if (signal?.aborted) throw new FastnearFailure("Cancelled");
  try {
    const result = await Effect.runPromise(Effect.result(readDeadline(read).pipe(
      Effect.provide(client ? fastnearHttpLayer(client) : FastnearHttpLive))), { signal });
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  } catch (error) {
    if (signal?.aborted) throw new FastnearFailure("Cancelled");
    throw error instanceof FastnearFailure ? error : new FastnearFailure("Unavailable");
  }
}

export const fastnearPost = <T>(url: string, body: object, signal?: AbortSignal): Promise<T> =>
  runFastnear(fastnearPostEffect(url, body), signal) as Promise<T>;
export const transactionsApi = <T>(path: "/account" | "/transactions", body: object, signal?: AbortSignal): Promise<T> =>
  runFastnear(transactionsEffect(path, body), signal) as Promise<T>;
