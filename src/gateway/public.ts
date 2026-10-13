import { Near } from "near-kit";
import { type DaoPolicy, mainnet } from "../chain.js";
import { type DaoProposal, signRequestOf } from "./sign-requests.js";

/**
 * What anyone may see without signing in: only what the DAO's contract already shows to everyone,
 * read from chain. Nothing here asks an agent server: balances, payments, payees, invoices and the
 * agents' policies stay confidential, for members only.
 */

export type PublicProposal = {
  id: number;
  status: string;
  proposer: string;
  submittedAt: string;
  votes: Record<string, string>;
  description: string;
  /** The proposal's kind in words, from its on-chain arguments. */
  action: string;
  /** For a signature request, the hash the DAO is asked to sign. */
  hash: string | null;
};

export type PublicView = {
  dao: string;
  roles: { name: string; members: string[] }[];
  proposals: PublicProposal[];
};

/** The agents' owner key path (src/dao-owner.ts). */
const OWNER_PATH = "agent-owner";

function actionOf(dao: string, p: DaoProposal): Pick<PublicProposal, "action" | "hash"> {
  const sign = signRequestOf(p);
  if (sign)
    return {
      action: sign.path === dao ? "Confidential payment (Trezu)" : sign.path === OWNER_PATH ? "Signature as the agents' owner" : `Signature on path ${sign.path}`,
      hash: sign.hash,
    };
  const [kind, args] = typeof p.kind === "string" ? [p.kind, {}] : Object.entries(p.kind)[0] ?? ["Unknown", {}];
  if (kind === "FunctionCall") return { action: `Call to ${String(args.receiver_id)}`, hash: null };
  if (kind === "Transfer") return { action: "Transfer", hash: null };
  if (kind === "ChangePolicy") return { action: "Policy change", hash: null };
  return { action: kind, hash: null };
}

export function publicView(dao: string, policy: DaoPolicy, proposals: DaoProposal[]): PublicView {
  return {
    dao,
    roles: policy.roles.flatMap((r) => (typeof r.kind === "object" ? [{ name: r.name, members: r.kind.Group }] : [])),
    proposals: proposals
      .map((p) => ({
        id: p.id,
        status: p.status,
        proposer: p.proposer,
        submittedAt: new Date(Number(BigInt(p.submission_time) / 1_000_000n)).toISOString(),
        votes: p.votes,
        description: p.description,
        ...actionOf(dao, p),
      }))
      .sort((a, b) => b.id - a.id),
  };
}

const near = new Near(mainnet);
const CACHE_MS = 30_000;
let cached: { at: number; view: Promise<PublicView> } | undefined;

/** The DAO's public view, read from chain at most every 30 s however many visitors ask. */
export function readPublicView(dao: string, limit = 30, now = Date.now()): Promise<PublicView> {
  if (!cached || now - cached.at > CACHE_MS) {
    const view = (async () => {
      const [policy, last] = await Promise.all([near.view<DaoPolicy>(dao, "get_policy"), near.view<number>(dao, "get_last_proposal_id")]);
      if (!policy) throw new Error(`${dao} is not a Sputnik DAO`);
      const proposals = last ? ((await near.view<DaoProposal[]>(dao, "get_proposals", { from_index: Math.max(0, last - limit), limit })) ?? []) : [];
      return publicView(dao, policy, proposals);
    })();
    cached = { at: now, view };
    // A failed read isn't kept: the next visitor tries again.
    view.catch(() => {
      if (cached?.view === view) cached = undefined;
    });
  }
  return cached.view;
}
