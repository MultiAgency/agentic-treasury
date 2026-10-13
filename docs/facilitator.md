# Confidential Treasury Facilitator

A DAO's payout agent takes payment requests from people outside the DAO, holds funds in its
confidential balance, and files every payment for the DAO's vote. Requesters deal with the invoice
page, never with members. Mainnet: `agentic.sputnik-dao.near`, its payout agent, and
https://invoices.multiagency.ai.

## How it maps to the brief

| Brief | Here | How it is known |
|---|---|---|
| Requests from anyone | The invoice page signs in any NEAR account. An agreed payee files an invoice. Anyone else files an **agreement request** the DAO sees on the payout agent's Agreement page | Offline: `test/invoice-http.test.ts` |
| Whitelist = the DAO's agreement | Agreed payees are the confidential transfer destinations of the payout agent's `only` policy (`agreedPayees`, `src/authorize.ts`). Payees from the DAO's passed transfer proposals are offered for it (`daoPayees`, `src/chain.ts`) | Mainnet: payout agent added to the treasury agent's agreement by proposals #23–#25, 2026-10-11 |
| New payee needs a fresh signed agreement | Agreeing is a policy update the DAO votes on; the payee then files the invoice. Nothing is paid because a vote passed | Mainnet: an unlisted payee was refused with `policy_destination_denied`, 2026-10-11 (README) |
| Invoices against agreed terms | An agreement carries terms: each invoice at most an amount, until a deadline. Either side starts it: a payee requests it, or the DAO offers it (a purchase order, a bounty or grant award). Each held payout shows whether it is within its payee's terms | Offline: `test/agreements.test.ts`. The terms are this server's, not the policy's: the vote on each payment enforces them |
| Member quorum releases each payment | `owner_approval` holds every payout; the owner is the DAO, signing through NEAR MPC, so the DAO's own vote threshold is the quorum | Mainnet: approvals #17, #21, #26, #47; one-click #51 (README, docs/mainnet-log.md) |
| Over-limit refused even with votes | Caps are checked when the payment is requested, so an over-cap payment is refused before there is anything to vote on | Mainnet: 11 USDC against a 10 USDC hourly cap, 409 `policy_denied`, 2026-10-11 |
| Chain watchers can't rebuild the payout graph | Payments are confidential transfers; approval proposals read "Approve the pending confidential request" (#46–#53) | Mainnet: no public transactions on the payout account; the payee sees no sender, 2026-10-11 |
| Requesters never learn the roster | The invoice page reads no DAO roles | By design. A Sputnik DAO's roles, proposers and votes are public on chain, so the roster is never secret; requesters just never deal with it |

## Differences from the brief

- **Quorum.** The brief's provider-side `approval: { approvers, threshold }` doesn't exist in the
  Agent API SDK this repo uses (`@near-intents-agent-api/sdk`); `owner_approval` plus a DAO owner
  gives the same release-by-quorum.
- **Grant recipients.** Grants here carry only a label and an expiry; the policy alone says where
  funds may go, for every grant.
- **One-time grants and bounties.** An award is an agreement the DAO offers: the winner's account,
  an amount, a deadline. The winner signs in and files against it. Winners are hidden from chain
  watchers, not from the DAO, which agrees their account. Each payment is its own vote, so a long
  winners list means as many proposals; this suits small award lists, not mass payouts.
- **Asset.** USDC, not USDT.
- **Purchase orders.** This covers the invoicing half of the purchase-order brief: confidential
  supplier invoices paid against terms the DAO agreed. Not covered: a separately funded agent per
  order (containment per order), refusal at the grant, payment without a vote, and the supplier-side
  forward to its treasury.

## Gaps

- Cumulative caps used up while a payout is held aren't re-checked before the vote
  ([acceptance E8](envelope/ACCEPTANCE.md)).
- The agreement-request flow hasn't run on mainnet yet: record its proposal and op ids here once it
  has.
- See README **Not done yet** and [enforcement](enforcement.md).

## Next (planned, not built)

- **Auditor access.** A gateway role for an account outside the DAO that may read the policy, mandate
  digest, books and history, and act on nothing: confidential, not unauditable. The Agent API has no
  read-scoped grant, so this is the gateway's allowlist (`src/gateway/allowlist.ts`), not a grant.
