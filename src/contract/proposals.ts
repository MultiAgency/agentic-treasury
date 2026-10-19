import { z } from "zod";

/**
 * `GET /gw/proposals?dao=<account>`: the DAO's recent agent-owner signing proposals, each matched against what the
 * agents wait for. Single source: the gateway's `decodeProposals` (src/gateway/proposals.ts) returns these types.
 */
export const proposalCheck = z.union([
  /** The hash is recomputed from the readable payload: this is exactly what the vote signs. */
  z.object({ kind: z.literal("verified"), standard: z.literal("nep413"), message: z.unknown() }),
  /** The hash is recomputed from the delegate bytes; receiver and methods are read, the policy blob is encrypted. */
  z.object({ kind: z.literal("verified"), standard: z.literal("nep366"), receiver: z.string(), methods: z.array(z.string()) }),
  z.object({ kind: z.literal("mismatch"), reason: z.string() }),
]);
const base = { id: z.number(), proposer: z.string(), description: z.string(), status: z.string(), submittedAt: z.string(), votes: z.record(z.string(), z.string()), hash: z.string() };
export const decodedProposal = z.union([
  z.object({ ...base, what: z.literal("agent"), agent: z.string(), type: z.string(), correlationId: z.string(), expiresAt: z.string(),
    state: z.enum(["waiting", "done", "expired"]), check: proposalCheck }),
  /** An agent-owner signature nothing here prepared, every agent having answered: don't approve it without knowing where it's from. */
  z.object({ ...base, what: z.literal("unknown") }),
  /** An agent-owner signature no answering agent prepared, while `unanswered` agents couldn't be asked: not yet checkable. */
  z.object({ ...base, what: z.literal("unchecked"), unanswered: z.array(z.string()) }),
  /** A finished agent-owner proposal: what it signed was submitted and is no longer waited for. */
  z.object({ ...base, what: z.literal("past") }),
  /** Trezu's own confidential payment, signed on the DAO's path rather than the agents'. */
  z.object({ ...base, what: z.literal("trezu") }),
  z.object({ ...base, what: z.literal("other"), path: z.string() }),
]);
export const proposalsResponse = z.array(decodedProposal);
export type ProposalCheck = z.infer<typeof proposalCheck>;
export type Decoded = z.infer<typeof decodedProposal>;
