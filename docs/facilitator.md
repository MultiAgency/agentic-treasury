# Payables

A DAO's payout agent takes payment requests from people outside the DAO, holds funds in its
confidential balance, and files every payment for the DAO's vote. Requesters deal with the invoice
page, never with members. Mainnet: `agentic.sputnik-dao.near`, its payout agent, and
https://invoices.multiagency.ai.

## How each requirement is counted

Every requirement is one of its brief's use cases or outcomes in the Agent Connect experiment catalog, in
the catalog's words where they fit, split where the catalog mixes two kinds:

- A **capability** is what the agent does (rebalances, pays an invoice).
- A **guarantee** is what it can't do (pay an unagreed payee, exceed the budget), and says who stops a
  misbehaving agent: **the signed policy** (the provider refuses under the policy the owner signed, or the
  chain does, as with a DAO's vote), **our server** (only this repo's code holds it, so a user has to
  trust it), **not possible** (nobody can enforce it here), or **nothing yet**.

Every row says how it's known: **held on mainnet** (a guarantee) or **working on mainnet** (a capability),
a dated observation with real funds, on this area's own agent or on another (the other area's, or an
isolated test agent), and the row says which; **tested offline**; or **not yet**. The provider and its
custody are still trusted; [enforcement](enforcement.md) sets out how far, and what isn't established.

Each card shows two counts for its running brief, guarantees first: how many guarantees the signed
policy enforces, and how many requirements are on mainnet (on this agent, on another). Roadmap briefs
aren't counted. The signed-out page and the dashboard show the same rows (`web/src/beats.ts`): a row
changes here first, then there.

## 01 Confidential Treasury Facilitator

| Type | Requirement | Who stops it | How it's known | Evidence |
|---|---|---|---|---|
| Capability | A contractor invoices the DAO and gets paid | — | Working on mainnet | Invoices filed at invoices.multiagency.ai, voted and paid on the payout agent, 2026-10-12 and 2026-10-13 (`docs/mainnet-log.md`; DEMO.md "What is verified") (proposals #47, #50, #53, #54) |
| Capability | Requests reach the DAO without contacting a member | — | Working on mainnet | A payee signs in on the invoice page and files there; the DAO votes on the held payment. Invoices filed and paid that way on the payout agent, 2026-10-12 and 2026-10-13 (proposals #47, #53, #54) |
| Guarantee | No payment moves without the members' vote | The signed policy | Held on mainnet | The payout policy holds every payment for the owner, and the owner is the DAO, so only its on-chain vote releases one. Held and released by vote on the payout agent, 2026-10-11 to 2026-10-14 (proposals #26, #47, #53, #54, #56) |
| Guarantee | The contractor can't learn the council roster | Not possible on Sputnik | Tested offline | Not possible on Sputnik: a DAO's roles are public on chain. Our invoice page never reads them (`test/invoice-roster.test.ts`) |
| Capability | A bounty program pays winners from the private balance | — | Working on mainnet | The DAO offered an award; the winner filed under it on the invoice page and was paid confidentially from the payout agent after the DAO's vote, 2026-10-14 (`test/agreements.test.ts`) (proposals #56) |
| Capability | A new payee's request is routed to a new agreement | — | Working on mainnet | An account the DAO hadn't agreed to pay filed on the invoice page, 2026-10-14 00:55Z: recorded as an agreement request, nothing sent to the provider, then declined from the dashboard's Agreements (`test/invoice-http.test.ts`) |
| Guarantee | No one outside the DAO's agreement is paid | The signed policy | Held on mainnet, on another agent | The destination list is the agreement, and changing it takes the DAO's signature. An unlisted account refused with `policy_destination_denied` on the treasury agent, 2026-10-11; the treasury agent's list changed only by DAO vote (proposals #23, #24, #25) |
| Guarantee | An over-limit payment can't go through, even with votes | The signed policy | Tested offline | Enforced by the signed policy, per OutLayer source: the keystore re-checks the per-transaction cap before signing, after the vote; not observed. Our approval re-check is tested offline (`test/authorize.test.ts`, `test/two-machine.test.ts`). A cap refusal was seen on the treasury agent, 2026-10-11, with no vote involved |
| Guarantee | Chain watchers can't reconstruct the DAO's payout graph | The signed policy | Held on mainnet | Payees are confidential destinations in the policy, so a public payout matches none. The payout agent's account has no public transactions and the payee sees no sender, 2026-10-11. Limits: each approval is a public proposal whose timing shows, and 1Click and NEAR Intents can see the mapping |

## 03 Purchase orders (roadmap)

| Type | Requirement | Who stops it | How it's known | Evidence |
|---|---|---|---|---|
| Capability | Each order is its own agent and grant: created, funded, paid, expired | — | Not yet | Not built: an offer records a payee, a ceiling and a deadline, but there is no agent or grant per order |
| Guarantee | Supplier payments can't be traced to the business | The signed policy | Tested offline | Payouts are confidential transfers under the policy (`test/authorize.test.ts`); no order paid on mainnet |
| Capability | Inbound payments are swapped to stables and forwarded to the supplier's treasury | — | Not yet | Not built |
| Guarantee | A tampered order (wrong supplier, changed amount, late) is refused | Nothing yet | Not yet | Not built per order: a wrong payee is refused by the destination list, but an amount over the order or a late invoice only shows a badge to voters |

## 17 Campaign payouts (roadmap)

| Type | Requirement | Who stops it | How it's known | Evidence |
|---|---|---|---|---|
| Capability | A winners list is paid in one auditable batch | — | Not yet | Not built: each award is its own invoice and vote |
| Capability | Recurring disbursements run as scheduled, individually budgeted transfers | — | Not yet | Not built |
| Capability | Refund waves use the same mechanics | — | Not yet | Not built |
| Guarantee | A duplicate winner or inflated prize can't pay twice | Our server | Tested offline | The provider returns the original payment when a request repeats its key; a second request for the same payee and amount is refused by our server (`test/authorize.test.ts`) |
| Guarantee | A payout outside the campaign's list is refused | Nothing yet | Not yet | Not built: payees are the policy's agreed list; there is no campaign list |

## Gaps

- Agreed terms are shown to voters, not enforced: nothing refuses an invoice above its ceiling or past
  its deadline.
- A payee must be able to receive confidentially: the provider documents that a confidential transfer's
  recipient needs confidential intents enabled. A requester without it can be agreed but not paid; a public
  payout for them isn't built.
- An agreement request has been filed and declined on mainnet (2026-10-14), but agreeing to one, which
  files a policy update for the DAO's vote, hasn't run yet: record its date and proposal number here once
  it has.
- See README **Not done yet** and [enforcement](enforcement.md).

## Next (planned, not built)

- **Auditor access.** A gateway role for an account outside the DAO that may read the policy, mandate
  digest, books and history, and act on nothing: confidential, not unauditable. The Agent API has no
  read-scoped grant, so this is the gateway's allowlist (`src/gateway/allowlist.ts`), not a grant.
