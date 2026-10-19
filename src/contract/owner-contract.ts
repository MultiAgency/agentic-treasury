import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { executePlanInput, ownerPrepareInput, ownerStatusInput, ownerSubmitInput } from "./inputs.js";
import { ownerOutputs } from "./owner-outputs.js";

/**
 * Typed owner errors: recovery is decided by `data.kind`, never by message text. Every schema is loose, so an
 * error's data reaches the client exactly as raised (oRPC sends the validated value; nothing may be stripped).
 * Data that does not match (for example input validation's `{ issues }`) is sent unchanged as an undefined error.
 */
const refused = z.looseObject({ kind: z.literal("refused"), code: z.string().optional() });
export const ownerErrors = {
  /** Refused before anything was sent: an earlier operation has no proven outcome, or another action holds the lock. */
  CONFLICT: { data: z.discriminatedUnion("kind", [z.looseObject({ kind: z.literal("unresolved") }), z.looseObject({ kind: z.literal("busy") }), refused]) },
  /** Refused by the platform, or by the provider (with its code and supplementary details). */
  BAD_REQUEST: { data: z.discriminatedUnion("kind", [refused, z.looseObject({
    kind: z.literal("provider"), code: z.string().optional(), availableAt: z.string().nullable(), budgetRemainingUsd: z.string().optional(),
  })]) },
};

const procedure = oc.errors(ownerErrors);

/**
 * The owner contract, contract-first: inputs, outputs and typed errors in one place. The server implements it
 * (src/rpc/*, `implement` with output validation off: reads validate only, mutations and streams are not validated
 * server-side) and `ownerClient` is typed from it.
 */
export const ownerContract = {
  overview: procedure.output(ownerOutputs.overview),
  activity: procedure.output(ownerOutputs.activity),
  unresolved: procedure.output(ownerOutputs.unresolved),
  strategy: { get: procedure.output(ownerOutputs["strategy/get"]) },
  owner: {
    prepare: procedure.input(ownerPrepareInput).output(ownerOutputs["owner/prepare"]),
    submit: procedure.input(ownerSubmitInput).output(ownerOutputs["owner/submit"]),
    status: procedure.input(ownerStatusInput).output(ownerOutputs["owner/status"]),
  },
  rebalance: procedure.output(eventIterator(ownerOutputs.rebalance)),
  executePlan: procedure.input(executePlanInput).output(eventIterator(ownerOutputs.executePlan)),
};
export type OwnerContract = typeof ownerContract;
