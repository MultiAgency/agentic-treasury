import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { z } from "zod";
import { ownerOutputs, ownerStreams } from "./owner-outputs.js";
import type { OwnerInputs } from "./owner-inputs.js";
import { READS } from "./permissions.js";

export type OwnerProcedure = keyof typeof ownerOutputs & keyof OwnerInputs;
type Stream = (typeof ownerStreams)[number];
export type OwnerOutput<P extends OwnerProcedure> = z.output<(typeof ownerOutputs)[P]>;
type Identity = Record<string, unknown>;
/** Supplementary provider facts on a `provider` failure (not retry flags or authorization decisions). */
export type RefusalDetails = { availableAt?: string; budgetRemainingUsd?: string };
/** Per-call options: an aborted read is `unavailable`; an aborted mutation or stream is `unknown` (it may have been accepted). */
export type OwnerCallOptions = { signal?: AbortSignal };

/**
 * Recovery is decided by `kind`, never by message text.
 * - `session` (401) / `forbidden` (403): from the status alone.
 * - `unresolved` / `busy`: refused before anything was sent; follow existing operations, then try again.
 * - `refused`: the platform refused before sending (with `code` when it names a reason).
 * - `provider`: the provider refused or failed; check the recorded outcome before retrying.
 * - `unavailable`: a read failed or returned an invalid answer; reading again is safe.
 * - `unknown`: a mutation or stream may have taken effect. Keep `identity`, read the existing records, never resend.
 */
export type OwnerFailure =
  | { ok: false; kind: "session"; status: 401; error: string }
  | { ok: false; kind: "forbidden"; status: 403; error: string }
  | { ok: false; kind: "unresolved" | "busy"; error: string }
  | { ok: false; kind: "refused"; error: string; code?: string }
  | { ok: false; kind: "provider"; error: string; code?: string; details: RefusalDetails }
  | { ok: false; kind: "unavailable" }
  | { ok: false; kind: "unknown"; procedure: OwnerProcedure; identity: Identity };
export type OwnerResult<T> = { ok: true; value: T } | OwnerFailure;

/** oRPC codes that mean the server refused before acting. TIMEOUT and CLIENT_CLOSED_REQUEST are not: the outcome is unknown. */
const REFUSALS = new Set(["BAD_REQUEST", "NOT_FOUND", "METHOD_NOT_SUPPORTED", "NOT_ACCEPTABLE", "CONFLICT", "PRECONDITION_FAILED", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "UNPROCESSABLE_CONTENT", "TOO_MANY_REQUESTS"]);
class GatewayDenial extends Error { constructor(readonly status: 401 | 403, message: string) { super(message); } }
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Typed owner procedures under an agent base (`""` or `/a/<agent>`), same wire as the app's oRPC client. Never retries. */
export function ownerClient({ base = "", fetch: send = globalThis.fetch }: { base?: "" | `/${string}`; fetch?: Fetch } = {}) {
  const client = createORPCClient(new RPCLink({ url: `${base}/rpc`, async fetch(url, init) {
    // Same origin in a browser; outside one, relative paths resolve against localhost (tests and tools pass their own fetch).
    const response = await send(new URL(url, globalThis.location?.href ?? "http://localhost"), init);
    // Gateway denials are plain JSON, not encoded RPC errors; the status alone decides.
    if (response.status === 401 || response.status === 403) {
      const body = await response.clone().json().catch(() => null) as { error?: unknown; json?: { code?: unknown } } | null;
      if (typeof body?.json?.code !== "string") throw new GatewayDenial(response.status, typeof body?.error === "string" ? body.error : response.status === 401 ? "Sign in again." : "This account may not do that.");
    }
    return response;
  } })) as unknown as Record<string, unknown>;
  const procedure = (path: string) => path.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], client) as (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;

  function failure(error: unknown, path: OwnerProcedure, identity: Identity): OwnerFailure {
    const mutation = !READS.has(path);
    const lost: OwnerFailure = mutation ? { ok: false, kind: "unknown", procedure: path, identity } : { ok: false, kind: "unavailable" };
    if (error instanceof GatewayDenial) return error.status === 401 ? { ok: false, kind: "session", status: 401, error: error.message } : { ok: false, kind: "forbidden", status: 403, error: error.message };
    if (!(error instanceof ORPCError)) return lost;
    if (error.code === "UNAUTHORIZED") return { ok: false, kind: "session", status: 401, error: error.message };
    if (error.code === "FORBIDDEN") return { ok: false, kind: "forbidden", status: 403, error: error.message };
    const data = (error.data ?? {}) as { kind?: unknown; code?: unknown; availableAt?: unknown; budgetRemainingUsd?: unknown };
    const code = typeof data.code === "string" ? data.code : undefined;
    if (data.kind === "unresolved" || data.kind === "busy") return { ok: false, kind: data.kind, error: error.message };
    if (data.kind === "refused") return { ok: false, kind: "refused", error: error.message, ...(code && { code }) };
    if (data.kind === "provider") return { ok: false, kind: "provider", error: error.message, ...(code && { code }), details: {
      ...(typeof data.availableAt === "string" && { availableAt: data.availableAt }),
      ...(typeof data.budgetRemainingUsd === "string" && { budgetRemainingUsd: data.budgetRemainingUsd }) } };
    // Untyped refusal codes come before the handler acted (input validation, not found); anything else may follow an effect.
    return REFUSALS.has(error.code) ? { ok: false, kind: "refused", error: error.message, ...(code && { code }) } : lost;
  }

  return {
    /** One read or non-stream mutation; the answer is validated against the published output schema. */
    async call<P extends Exclude<OwnerProcedure, Stream>>(path: P, ...[input, options]: OwnerInputs[P] extends undefined ? [input?: undefined, options?: OwnerCallOptions] : [input: OwnerInputs[P], options?: OwnerCallOptions]): Promise<OwnerResult<OwnerOutput<P>>> {
      const identity = (input ?? {}) as Identity;
      let output: unknown;
      try { output = await procedure(path)(input, { signal: options?.signal }); } catch (error) { return failure(error, path, identity); }
      const parsed = ownerOutputs[path].safeParse(output);
      if (parsed.success) return { ok: true, value: parsed.data as OwnerOutput<P> };
      return READS.has(path) ? { ok: false, kind: "unavailable" } : { ok: false, kind: "unknown", procedure: path, identity };
    },
    /** A stream's events, each validated; a lost stream or invalid event ends it as `unknown` with the input identity. */
    async *stream<P extends Stream>(path: P, input: OwnerInputs[P], options?: OwnerCallOptions): AsyncGenerator<OwnerOutput<P>, OwnerFailure | undefined> {
      const identity = (input ?? {}) as Identity;
      let events: AsyncIterable<unknown>;
      try { events = await procedure(path)(input, { signal: options?.signal }) as AsyncIterable<unknown>; } catch (error) { return failure(error, path, identity); }
      let started = false;
      const iterator = events[Symbol.asyncIterator]();
      // An open stream must end on abort even if the transport keeps it open: race each read with the signal.
      const aborted = new Promise<"aborted">(resolve => {
        if (options?.signal?.aborted) resolve("aborted");
        options?.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next === "aborted") { void iterator.return?.(); return { ok: false, kind: "unknown", procedure: path, identity }; }
          if (next.done) break;
          started = true;
          const parsed = ownerOutputs[path].safeParse(next.value);
          if (!parsed.success) { void iterator.return?.(); return { ok: false, kind: "unknown", procedure: path, identity }; }
          yield parsed.data as OwnerOutput<P>;
        }
      } catch (error) {
        // After any event, part of the stream may have taken effect: only a failure before the first event keeps its kind.
        return started ? { ok: false, kind: "unknown", procedure: path, identity } : failure(error, path, identity);
      }
      return undefined;
    },
  };
}
export type OwnerClient = ReturnType<typeof ownerClient>;
