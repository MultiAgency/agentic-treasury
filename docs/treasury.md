# Treasury

A treasury agent rebalances the DAO's treasury toward its target on its own: it reads balances,
quotes every swap, and executes only inside the per-asset caps and USD budget the DAO signed. Idle
funds stay in the confidential balance. Mainnet: `agentic.sputnik-dao.near`'s treasury agent.

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

## 02 Agentic Treasury Management

| Type | Requirement | Who stops it | How it's known | Evidence |
|---|---|---|---|---|
| Capability | Rebalances to target allocations on a schedule | — | Working on mainnet | The autopilot executed a rebalance alone, its plan bound to the strategy digest, 2026-10-12 16:17Z (`test/autopilot.test.ts`, `test/rebalance.test.ts`) |
| Guarantee | Can't exceed per-asset limits | The signed policy | Held on mainnet | The policy caps every asset per transaction, hour, day and month. On the treasury agent, a transfer over its hourly cap was refused with `policy_denied` (policy revision 8, 2026-10-11); a swap over the monthly cap was refused on an isolated test agent, 2026-10-13 |
| Capability | Quotes every route before executing | — | Working on mainnet | Two quoted legs executed on the treasury agent, 2026-10-12 20:36Z (`test/rebalance.test.ts`, `test/plans.test.ts`) |
| Capability | Shows budget headroom ticking down with each dispatch | — | Working on mainnet | On the treasury agent, a Run now swap took the daily budget left down by its value, shown as before and after under Automations' Latest run, 2026-10-14 00:50Z. The Overview and each run show the window with least left (`test/budget-window.test.ts`) |
| Guarantee | A rebalance over the budget is refused before anything moves | The signed policy | Held on mainnet | Refused with `spend_budget_exceeded`, nothing moved, on the treasury agent, 2026-10-12 13:57Z and 14:06Z |
| Guarantee | Can't spend more than the USD budget, even with simultaneous requests | The signed policy | Held on mainnet, on another agent | Five simultaneous swaps on an isolated test agent: one settled, the rest refused, no overshoot, 2026-10-13 (one trial) |
| Capability | Sweeps idle stables into the confidential balance | — | Working on mainnet | A small USDC deposit to a public deposit address landed in the treasury agent's public balance; the dashboard's Sweep (the same sweep the autopilot runs each tick) shielded it, and nothing was left public, 2026-10-14 00:33Z to 00:39Z (`test/autopilot.test.ts`) |
| Guarantee | The resting position can't be traced on chain | Our server | Held on mainnet | No public NEAR Intents balance on chain and all three assets confidential, read-only check, 2026-10-13T23:03Z. Kept so by our deposits' and swaps' requests: the policy allows public swaps and unshield (`docs/enforcement.md`). Funds still can't leave: the destination list is empty |

## 09 Adaptive DCA (roadmap)

| Type | Requirement | Who stops it | How it's known | Evidence |
|---|---|---|---|---|
| Capability | Daily buys of listed tokens, sized between a floor and a cap by a signal | — | Not yet | Not built: the strategy is a target allocation |
| Capability | Pauses on a cold streak or regime change | — | Not yet | Not built |
| Guarantee | A token outside the list can't be bought | Our server | Tested offline | The provider checks only the asset a swap spends; our server refuses buying an unlisted one (`test/authorize.test.ts`). A swap into an unlisted asset succeeded through the API directly, 2026-10-10 |
| Guarantee | A buy can't exceed the per-cycle cap | The signed policy | Not yet | The policy's per-transaction and hourly caps would stop it; DCA isn't built |

## 18 House Money (roadmap)

| Type | Requirement | Who stops it | How it's known | Evidence |
|---|---|---|---|---|
| Capability | The principal moves to a safe account once gains cover it, exactly once | — | Not yet | Not built: the treasury agent's policy lets no funds leave |
| Guarantee | Drawdowns can't touch the banked principal | Nothing yet | Not yet | Not built |
| Guarantee | Nothing comes back from the safe account | Nothing yet | Not yet | Not built |

## 08 Bitcoin treasury (roadmap)

| Type | Requirement | Who stops it | How it's known | Evidence |
|---|---|---|---|---|
| Capability | Inbound BTC lands in a public checking balance from any sender | — | Not yet | Not built: no BTC asset, and deposits land confidential |
| Capability | One-time deposit addresses with refund destinations, reconciled from provider records | — | Not yet | Partly built: one-time deposit addresses and reconciliation from the provider's history exist; no refund destinations |
| Capability | A scheduled sweep to the confidential treasury, within a cap and a delay | — | Not yet | Partly built: every tick shields public balances; no separate treasury and no delay |
| Guarantee | An oversized sweep is refused at the per-transaction cap | The signed policy | Not yet | The policy caps each transaction; not shown for a sweep |
| Capability | The owner can cancel a sweep during the veto window | — | Not yet | Not built: needs the provider's timelock tested on mainnet first |

## Gaps

- Not listed above: the catalog's "unshielding exactly what a payout needs". Payouts are confidential
  transfers between confidential balances, so the treasury keeps no public reserve; a payee who can't
  receive confidentially would need a public payout, not built ([enforcement](enforcement.md)).
- What a swap buys is checked by this server, not by the provider; strict cumulative per-asset
  limits and USD-budget atomicity are unproven ([enforcement](enforcement.md)).
- The autopilot hasn't run unattended for days. Outside the dashboard, its warnings reach the owner
  only through the optional Telegram notices (README **Notifications**).

## Next (planned, not built)

- **Undo window.** The policy's `timelock_ms` holds each execution; the dashboard lists them
  (`listScheduledExecutions`) with a countdown and a cancel (`execution_cancel`), so the owner has a
  veto on every autopilot swap. Needs its own money-path design first: today a queued execution
  counts as unresolved and blocks new sends, and provider timelocks are held because their
  release-time checks aren't established ([architecture](architecture.md#how-the-money-path-stays-safe-on-one-host)).
