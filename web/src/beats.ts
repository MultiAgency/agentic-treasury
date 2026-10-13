/**
 * Each area's briefs, requirement by requirement. Every requirement is one of its brief's use cases or
 * outcomes in the Agent Connect experiment catalog, in the catalog's words where they fit, split where the
 * catalog mixes two kinds: a capability (what the agent can do) or a guarantee (what it can't). A guarantee
 * says who stops a misbehaving agent; the claim is only as strong as what doesn't rest on this server.
 * Every row says how it's known. Static on purpose: every line states evidence someone can check, so a
 * change here is a reviewed change. The source is each brief's table in docs/facilitator.md and
 * docs/treasury.md, citing docs/mainnet-log.md: a row changes there first, then here. Evidence is a dated,
 * described observation; the only raw ids are proposal numbers, which are public on chain.
 */

export type Kind = "facilitator" | "treasury";

/** Who stops a misbehaving agent: the signed policy (the provider, or the chain for a DAO's vote), this server, nobody here can, or nothing yet. */
export type Stopper = "policy" | "server" | "impossible" | "nothing";

/** How it's known: seen on mainnet with real funds, covered by offline tests, or not yet. */
export type Known = "mainnet" | "offline" | "not-yet";

/**
 * A capability (what the agent can do) or a guarantee (what it can't); only a guarantee has `stoppedBy`.
 * `where`: for one seen on mainnet, this area's own agent or another (the other area's, or an isolated test
 * agent). `proposals`: the DAO proposals the evidence cites, linked to where anyone can read them.
 */
export type Requirement = {
  type: "capability" | "guarantee";
  text: string;
  stoppedBy?: Stopper;
  known: Known;
  where?: "agent" | "other";
  evidence: string;
  proposals?: number[];
};

/** A brief from the Agent Connect experiment catalog, by its catalog number. An area lists the brief it runs first, then its roadmap. */
export type Brief = { catalog: string; title: string; requirements: Requirement[] };

/** A demo step; `on` says which site it happens on. */
export type Step = { text: string; on: "invoices" | "dashboard" };

export const PROTOTYPES: Record<Kind, { name: string; tagline: string; briefs: [Brief, ...Brief[]]; demo: Step[] }> = {
  facilitator: {
    name: "Payables",
    tagline:
      "Anyone can ask the DAO to be paid. The payout agent holds funds in its confidential balance and files each payment for the DAO's vote; requesters never deal with members.",
    briefs: [
      {
        catalog: "01",
        title: "Confidential Treasury Facilitator",
        requirements: [
          {
            type: "capability",
            text: "A contractor invoices the DAO and gets paid",
            known: "mainnet",
            where: "agent",
            evidence:
              "Invoices filed, voted and paid on the payout agent, 2026-10-12",
            proposals: [47, 50],
          },
          {
            type: "guarantee",
            text: "No payment moves without the members' vote",
            stoppedBy: "policy",
            known: "mainnet",
            where: "agent",
            evidence:
              "The payout policy holds every payment for the owner, and the owner is the DAO, so only its on-chain vote releases one. Held, voted and paid on the payout agent, 2026-10-12",
            proposals: [47, 50],
          },
          {
            type: "guarantee",
            text: "The contractor can't learn the council roster",
            stoppedBy: "impossible",
            known: "offline",
            evidence:
              "Not possible on Sputnik: a DAO's roles are public on chain. Our invoice page never reads them (test/invoice-roster.test.ts)",
          },
          {
            type: "capability",
            text: "A bounty program pays winners from the private balance",
            known: "offline",
            evidence:
              "The DAO offers an award and the winner's invoice files under it (test/agreements.test.ts); payouts are confidential transfers. No award paid on mainnet yet",
          },
          {
            type: "capability",
            text: "A new payee's request is routed to a new agreement",
            known: "offline",
            evidence:
              "Recorded as a request, never paid (test/invoice-http.test.ts); the flow hasn't run on mainnet",
          },
          {
            type: "guarantee",
            text: "No one outside the DAO's agreement is paid",
            stoppedBy: "policy",
            known: "mainnet",
            where: "other",
            evidence:
              "The destination list is the agreement, and changing it takes the DAO's signature. An unlisted account refused with policy_destination_denied on the treasury agent, 2026-10-11; the treasury agent's list changed only by DAO vote",
            proposals: [23, 24, 25],
          },
          {
            type: "guarantee",
            text: "An over-limit payment can't go through, even with votes",
            stoppedBy: "policy",
            known: "offline",
            evidence:
              "The policy caps each payment; per OutLayer source the keystore re-checks the per-transaction cap before signing, after the vote. Our approval re-check is tested offline (test/authorize.test.ts, test/two-machine.test.ts). A cap refusal was seen on the treasury agent, 2026-10-11, but with no vote",
          },
          {
            type: "guarantee",
            text: "Chain watchers can't reconstruct the DAO's payout graph",
            stoppedBy: "policy",
            known: "mainnet",
            where: "agent",
            evidence:
              "Payees are confidential destinations in the policy, so a public payout matches none. The payout agent's account has no public transactions and the payee sees no sender, 2026-10-11. Each approval's proposal and its timing are public",
          },
        ],
      },
      {
        catalog: "03",
        title: "Purchase orders",
        requirements: [
          {
            type: "capability",
            text: "Each order is its own agent and grant: created, funded, paid, expired",
            known: "not-yet",
            evidence:
              "Not built: an offer records a payee, a ceiling and a deadline, but there is no agent or grant per order",
          },
          {
            type: "guarantee",
            text: "Supplier payments can't be traced to the business",
            stoppedBy: "policy",
            known: "offline",
            evidence:
              "Payouts are confidential transfers under the policy (test/authorize.test.ts); no order paid on mainnet",
          },
          {
            type: "capability",
            text: "Inbound payments are swapped to stables and forwarded to the supplier's treasury",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "guarantee",
            text: "A tampered order (wrong supplier, changed amount, late) is refused",
            stoppedBy: "nothing",
            known: "not-yet",
            evidence:
              "Not built per order: a wrong payee is refused by the destination list, but an amount over the order or a late invoice only shows a badge to voters",
          },
        ],
      },
      {
        catalog: "17",
        title: "Campaign payouts",
        requirements: [
          {
            type: "capability",
            text: "A winners list is paid in one auditable batch",
            known: "not-yet",
            evidence:
              "Not built: each award is its own invoice and vote",
          },
          {
            type: "capability",
            text: "Recurring disbursements run as scheduled, individually budgeted transfers",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "capability",
            text: "Refund waves use the same mechanics",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "guarantee",
            text: "A duplicate winner or inflated prize can't pay twice",
            stoppedBy: "server",
            known: "offline",
            evidence:
              "The provider returns the original payment when a request repeats its key; a second request for the same payee and amount is refused by our server (test/authorize.test.ts)",
          },
          {
            type: "guarantee",
            text: "A payout outside the campaign's list is refused",
            stoppedBy: "nothing",
            known: "not-yet",
            evidence:
              "Not built: payees are the policy's agreed list; there is no campaign list",
          },
        ],
      },
    ],
    demo: [
      { on: "invoices", text: "Sign in with NEAR and ask to be paid. Someone the DAO hasn't agreed to pay files a request; nothing is paid." },
      { on: "dashboard", text: "On Agreements, agree to the request's terms. That files a policy update for the DAO's vote." },
      { on: "invoices", text: "Once agreed, the payee files the invoice. It is held for the DAO's vote." },
      { on: "dashboard", text: "Approve it on the Overview, shown beside its terms. It is paid confidentially and shows in Activity." },
    ],
  },
  treasury: {
    name: "Treasury",
    tagline:
      "The treasury agent rebalances toward its target on its own, quoting every swap, inside per-asset caps and a USD budget the DAO signed. Idle funds stay in the confidential balance.",
    briefs: [
      {
        catalog: "02",
        title: "Agentic Treasury Management",
        requirements: [
          {
            type: "capability",
            text: "Rebalances to target allocations on a schedule",
            known: "mainnet",
            where: "agent",
            evidence:
              "The autopilot executed a rebalance alone, its plan bound to the strategy digest, 2026-10-12 16:17Z (test/autopilot.test.ts, test/rebalance.test.ts)",
          },
          {
            type: "guarantee",
            text: "Can't exceed per-asset limits",
            stoppedBy: "policy",
            known: "mainnet",
            where: "agent",
            evidence:
              "The policy caps every asset per transaction, hour, day and month. A transfer over the hourly cap refused with policy_denied on the treasury agent, 2026-10-11; the monthly cap also refused on an isolated test agent, 2026-10-13",
          },
          {
            type: "capability",
            text: "Quotes every route before executing",
            known: "mainnet",
            where: "agent",
            evidence:
              "Two quoted legs executed on the treasury agent, 2026-10-12 20:36Z (test/rebalance.test.ts, test/plans.test.ts)",
          },
          {
            type: "capability",
            text: "Shows budget headroom ticking down with each dispatch",
            known: "offline",
            evidence:
              "The Overview shows the provider's usage for the window with least left (test/budget-window.test.ts); no dated observation on the treasury agent",
          },
          {
            type: "guarantee",
            text: "A rebalance over the budget is refused before anything moves",
            stoppedBy: "policy",
            known: "mainnet",
            where: "agent",
            evidence:
              "Refused with spend_budget_exceeded, nothing moved, on the treasury agent, 2026-10-12 13:57Z and 14:06Z",
          },
          {
            type: "guarantee",
            text: "Can't spend more than the USD budget, even with simultaneous requests",
            stoppedBy: "policy",
            known: "mainnet",
            where: "other",
            evidence:
              "Five simultaneous swaps on an isolated test agent: one settled, the rest refused, no overshoot, 2026-10-13 (one trial)",
          },
          {
            type: "capability",
            text: "Sweeps idle stables into the confidential balance",
            known: "offline",
            evidence:
              "Our autopilot shields public balances each tick (test/autopilot.test.ts). Never run on the treasury agent: deposits land confidential, and the only shield was a one-off script on an isolated test agent",
          },
          {
            type: "guarantee",
            text: "The resting position can't be traced on chain",
            stoppedBy: "server",
            known: "not-yet",
            evidence:
              "Our deposits and swaps ask for the confidential balance, but the policy allows public swaps and unshield, so this rests on our requests (docs/enforcement.md). Funds still can't leave: the destination list is empty",
          },
        ],
      },
      {
        catalog: "09",
        title: "Adaptive DCA",
        requirements: [
          {
            type: "capability",
            text: "Daily buys of listed tokens, sized between a floor and a cap by a signal",
            known: "not-yet",
            evidence:
              "Not built: the strategy is a target allocation",
          },
          {
            type: "capability",
            text: "Pauses on a cold streak or regime change",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "guarantee",
            text: "A token outside the list can't be bought",
            stoppedBy: "server",
            known: "offline",
            evidence:
              "The provider checks only the asset a swap spends; our server refuses buying an unlisted one (test/authorize.test.ts). A swap into an unlisted asset succeeded through the API directly, 2026-10-10",
          },
          {
            type: "guarantee",
            text: "A buy can't exceed the per-cycle cap",
            stoppedBy: "policy",
            known: "not-yet",
            evidence:
              "The policy's per-transaction and hourly caps would stop it; DCA isn't built",
          },
        ],
      },
      {
        catalog: "18",
        title: "House Money",
        requirements: [
          {
            type: "capability",
            text: "The principal moves to a safe account once gains cover it, exactly once",
            known: "not-yet",
            evidence:
              "Not built: the treasury agent's policy lets no funds leave",
          },
          {
            type: "guarantee",
            text: "Drawdowns can't touch the banked principal",
            stoppedBy: "nothing",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "guarantee",
            text: "Nothing comes back from the safe account",
            stoppedBy: "nothing",
            known: "not-yet",
            evidence:
              "Not built",
          },
        ],
      },
      {
        catalog: "08",
        title: "Bitcoin treasury",
        requirements: [
          {
            type: "capability",
            text: "Inbound BTC lands in a public checking balance from any sender",
            known: "not-yet",
            evidence:
              "Not built: no BTC asset, and deposits land confidential",
          },
          {
            type: "capability",
            text: "One-time deposit addresses with refund destinations, reconciled from provider records",
            known: "not-yet",
            evidence:
              "Partly built: one-time deposit addresses and reconciliation from the provider's history exist; no refund destinations",
          },
          {
            type: "capability",
            text: "A scheduled sweep to the confidential treasury, within a cap and a delay",
            known: "not-yet",
            evidence:
              "Partly built: every tick shields public balances; no separate treasury and no delay",
          },
          {
            type: "guarantee",
            text: "An oversized sweep is refused at the per-transaction cap",
            stoppedBy: "policy",
            known: "not-yet",
            evidence:
              "The policy caps each transaction; not shown for a sweep",
          },
          {
            type: "capability",
            text: "The owner can cancel a sweep during the veto window",
            known: "not-yet",
            evidence:
              "Not built: needs the provider's timelock tested on mainnet first",
          },
        ],
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

export const STOPPER_LABEL: Record<Stopper, string> = {
  policy: "The signed policy",
  server: "Our server",
  impossible: "Not possible on Sputnik",
  nothing: "Nothing yet",
};

/** How it's known, in words: a guarantee "held" on mainnet, a capability was "working" there. */
export const knownLabel = (r: Requirement) =>
  r.known === "mainnet" ? `${r.type === "guarantee" ? "Held" : "Working"} on mainnet${r.where === "other" ? ", on another agent" : ""}` : r.known === "offline" ? "Tested offline" : "Not yet";

/**
 * What our own code has shown on mainnet beyond the briefs' requirements: how the hosts run. Claims
 * only, as the signed-out page shows them; each one's record is in the comment beside it.
 */
export const PROVEN: string[] = [
  "State survives a restart and a redeploy", // DEMO.md "What is verified": smoke snapshots, 2026-10-12 20:50–21:37Z
  "The autopilot runs on schedule on the deployed build", // DEMO.md: first tick's evidence, 2026-10-12 21:37Z
  "One executor per agent", // DEMO.md: one live deployment each, 2026-10-12 22:13Z
  "Signed-out callers are refused every agent read", // DEMO.md: pnpm smoke, live, read-only, 2026-10-12 22:13Z
  "Every policy revision reproduces its hash, and the owner's grant and approval signatures verify", // docs/mainnet-log.md, 2026-10-13T04:10Z
];
