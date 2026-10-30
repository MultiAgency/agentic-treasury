import type { OwnerFailure } from "@multiagency/sdk";

/** Exit codes: 0 ok; 2 nothing was sent; 3 unknown, an action may have taken effect and must not be sent again. */
export const EXIT = { ok: 0, notSent: 2, unknown: 3 } as const;

export const exitCode = (result: { ok: true } | OwnerFailure): number =>
  result.ok ? EXIT.ok : result.kind === "unknown" ? EXIT.unknown : EXIT.notSent;
