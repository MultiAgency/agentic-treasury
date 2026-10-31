import type { OwnerFailure, OwnerProcedure } from "@multiagency/sdk";

/**
 * Exit codes: 0 ok; 2 nothing was sent; 3 unknown, an action may have taken effect and must not be sent again;
 * 4 partial, at least one leg or shield was sent and not every leg succeeded: funds may have moved.
 */
export const EXIT = { ok: 0, notSent: 2, unknown: 3, partial: 4 } as const;

/** One send an execution reported: a plan's leg (with the shield it needed first) or a sweep's shield. */
export type Leg = { index?: number; asset?: string; status: string; correlationId: string; failureCode?: string | null; shield?: { amount: string; status: string } };
/** At least one leg or shield was sent, and not every leg succeeded: funds may have moved. */
export type Partial = { ok: false; kind: "partial"; error: string; legs: Leg[] };
export type Outcome = { ok: true } | OwnerFailure | Partial;

export const exitCode = (result: Outcome): number =>
  result.ok ? EXIT.ok : result.kind === "unknown" ? EXIT.unknown : result.kind === "partial" ? EXIT.partial : EXIT.notSent;

/** Hands each event of a stream to `onEvent` as it arrives; the stream's end is its outcome. Never resends. */
export async function follow<E>(stream: AsyncGenerator<E, OwnerFailure | undefined>, onEvent: (event: E) => void): Promise<Outcome> {
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return next.value ?? { ok: true };
    onEvent(next.value);
  }
}

/** The provider's final statuses (the platform's `src/ops.ts`). FAILED and REFUNDED don't prove that nothing moved. */
const SETTLED = new Set(["SUCCESS", "FAILED", "REFUNDED"]);
const NOT_SENT = "NOT_SENT";
const sent = (status: string) => status !== NOT_SENT;
const unsettled = (status: string) => sent(status) && !SETTLED.has(status);

/**
 * Decides an execution from the legs it reported, not from how its stream ended: the executor rejects a plan before any
 * leg, or after earlier legs moved funds, and ends normally after a leg that didn't succeed.
 */
export function settle(ended: Outcome, legs: Leg[], rejected: string[] | null, unknown: { procedure: OwnerProcedure; identity: Record<string, unknown> }): Outcome {
  // The SDK already reports a stream lost after any event as unknown, and any other failure as proven before sending.
  if (!ended.ok) return ended;
  if (legs.some(leg => unsettled(leg.status) || (leg.shield && unsettled(leg.shield.status))))
    return { ok: false, kind: "unknown", ...unknown };
  const moved = legs.filter(leg => sent(leg.status) || (leg.shield && sent(leg.shield.status)));
  const problems = rejected ? `: ${rejected.join("; ")}` : "";
  if (!moved.length)
    return rejected || legs.length ? { ok: false, kind: "refused", error: `Nothing was sent${problems}` } : { ok: true };
  if (rejected || legs.some(leg => leg.status !== "SUCCESS"))
    return { ok: false, kind: "partial", error: `At least one leg or shield was sent, and not every leg succeeded. Funds may have moved; read activity and unresolved before acting again${problems}`, legs };
  return { ok: true };
}
