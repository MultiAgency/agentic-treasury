import { ownerClient, type OwnerClient, type OwnerFailure, type OwnerInputs, type OwnerOutput, type OwnerProcedure, type OwnerResult } from "@multiagency/sdk";
import type { Config } from "./config.ts";

/**
 * What each machine credential scope reaches on `/machine/v1` (the platform's `src/gateway/machine-auth.ts` at 5cd4d4d).
 * Scopes don't imply one another: preparing doesn't permit executing, and executing doesn't permit reading.
 */
export const SCOPES = {
  read: ["instance", "overview", "policyHistory", "strategy/get", "autopilot/get", "activity", "unresolved", "autopilot/evidence", "autopilot/log", "ledger", "ledgerCsv"],
  prepare: ["rebalance", "externalPlan"],
  "execute-plan": ["executePlan"],
  sweep: ["sweep"],
} as const satisfies Record<string, readonly OwnerProcedure[]>;
export type Scope = keyof typeof SCOPES;

type Reach<S extends Scope> = (typeof SCOPES)[S][number];
type Streamed = Parameters<OwnerClient["stream"]>[0];
type Args<P extends OwnerProcedure> = undefined extends OwnerInputs[P] ? [input?: OwnerInputs[P]] : [input: OwnerInputs[P]];

/** `ownerClient` narrowed to the procedures a credential's scopes reach, so a call outside them doesn't compile. */
export type Machine<S extends Scope> = {
  call<P extends Exclude<Reach<S>, Streamed>>(path: P, ...input: Args<P>): Promise<OwnerResult<OwnerOutput<P>>>;
  stream<P extends Extract<Reach<S>, Streamed>>(path: P, input: OwnerInputs[P]): AsyncGenerator<OwnerOutput<P>, OwnerFailure | undefined>;
};

/** The agent's machine route with a bearer credential; `scopes` are the ones the owner issued it with. */
export function machine<S extends Scope>({ origin, agent }: Config, token: string, _scopes: readonly S[]): Machine<S> {
  return ownerClient({ base: `${origin}/machine/v1/a/${agent}` as `https://${string}`, fetch: (input, init) => fetch(input, {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` }, credentials: "omit", redirect: "error" }) });
}
