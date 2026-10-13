/**
 * What each prototype shows, item by item, and how it is known. Static on purpose: every line states
 * evidence someone can check, so a change here is a reviewed change (docs/facilitator.md,
 * docs/treasury.md hold the same table with sources).
 */

export type Kind = "facilitator" | "treasury";

/** How a claim is known, strongest first. */
export type Proof = "mainnet" | "offline" | "design" | "provider-docs" | "not-applicable";

/** `proposal`: the DAO proposal the evidence cites, linked to where anyone can read it. */
export type Beat = { claim: string; proof: Proof; evidence: string; proposal?: number };

/** A demo step; `on` says which site it happens on. */
export type Step = { text: string; on: "invoices" | "dashboard" };

export const PROTOTYPES: Record<Kind, { name: string; tagline: string; beats: Beat[]; demo: Step[] }> = {
  facilitator: {
    name: "Confidential Treasury Facilitator",
    tagline:
      "Anyone can ask the DAO to be paid. The agent holds funds in its confidential balance and files each payment for the DAO's vote; requesters never deal with members.",
    beats: [
      {
        claim: "A payee files an invoice, the DAO votes, and USDC lands confidentially",
        proof: "mainnet",
        evidence: "op_uUMA-amAfCgP… paid after proposal #47, 2026-10-12",
        proposal: 47,
      },
      {
        claim: "Someone the DAO hasn't agreed to pay is routed to a new agreement, not paid",
        proof: "offline",
        evidence: "Agreement requests: test/invoice-http.test.ts. The provider refused an unlisted payee with policy_destination_denied, 2026-10-11",
      },
      {
        claim: "Invoices are checked against agreed terms (amount, deadline), whether the payee asked or the DAO offered (an order, a bounty)",
        proof: "offline",
        evidence: "test/agreements.test.ts. Shown to voters beside each held payout; the vote enforces it",
      },
      {
        claim: "An over-limit payment is refused before there is anything to vote on",
        proof: "mainnet",
        evidence: "11 USDC against a 10 USDC hourly cap: 409 policy_denied, 2026-10-11",
      },
      {
        claim: "Chain watchers can't reconstruct who the DAO pays",
        proof: "mainnet",
        evidence: "Only the vote is public: the payout account has no public transactions, the payee sees no sender, 2026-10-11",
      },
      {
        claim: "The requester never sees a member account",
        proof: "design",
        evidence: "The invoice page reads no DAO roles. Sputnik roles and votes are still public on chain",
      },
    ],
    demo: [
      { on: "invoices", text: "Sign in with NEAR and ask to be paid. Someone the DAO hasn't agreed to pay files a request; nothing is paid." },
      { on: "dashboard", text: "On Agreements, agree to the request's terms. That files a policy update for the DAO's vote." },
      { on: "invoices", text: "Once agreed, the payee files the invoice. It is held for the DAO's vote." },
      { on: "dashboard", text: "Approve it on the Overview, checked against the terms. It is paid confidentially and shows in Activity." },
    ],
  },
  treasury: {
    name: "Agentic Treasury Management",
    tagline:
      "An agent rebalances the treasury toward its target on its own, quoting every swap, inside per-asset caps and a USD budget the DAO signed. Idle funds stay in the confidential balance.",
    beats: [
      {
        claim: "Balances in, a quoted plan out, swaps settle inside the caps (at most two for three assets)",
        proof: "mainnet",
        evidence: "Run now executed two legs, op_K4w1dsSM… and op_XNaqLYyK…, 2026-10-12 20:36Z",
      },
      {
        claim: "Scheduled rebalancing under the strategy the DAO approved",
        proof: "mainnet",
        evidence: "The autopilot executed op_YQnAILxJ… alone, plan bound to the strategy digest, 2026-10-12 16:17Z",
      },
      {
        claim: "A rebalance over the budget is refused and nothing moves",
        proof: "mainnet",
        evidence: "spend_budget_exceeded: $4.69 against $4.33 left, 2026-10-12 13:57Z and 14:06Z",
      },
      {
        claim: "Idle funds are swept into the confidential balance",
        proof: "offline",
        evidence: "test/sweep.test.ts. A shield under the same destination list worked on a test agent, op_mPNFaz-SI04…, 2026-10-13",
      },
      {
        claim: "The USD budget is charged atomically with each dispatch",
        proof: "provider-docs",
        evidence: "Per the Agent API's documentation; not independently verified (docs/enforcement.md)",
      },
      {
        claim: "Unshielding exactly what a payout needs",
        proof: "not-applicable",
        evidence: "Payouts are confidential transfers end to end, so funds never need to go public",
      },
    ],
    demo: [
      { on: "dashboard", text: "Overview: the book against its target, and the USD budget left this month." },
      { on: "dashboard", text: "Automations: preview a rebalance. Each leg is quoted and checked against the strategy's cost cap." },
      { on: "dashboard", text: "Run now: the swaps settle inside the caps, and the budget left drops by their value." },
      { on: "dashboard", text: "Activity: each swap with the policy revision it ran under." },
    ],
  },
};

export const PROOF_LABEL: Record<Proof, string> = {
  mainnet: "Shown on mainnet",
  offline: "Tested offline",
  design: "By design",
  "provider-docs": "Provider docs",
  "not-applicable": "Not needed",
};
