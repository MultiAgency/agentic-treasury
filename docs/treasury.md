# Agentic Treasury Management

A treasury agent rebalances the DAO's treasury toward its target on its own: it reads balances,
quotes every swap, and executes only inside the per-asset caps and USD budget the DAO signed. Idle
funds stay in the confidential balance. Mainnet: `agentic.sputnik-dao.near`'s treasury agent.

## How it maps to the brief

| Brief | Here | How it is known |
|---|---|---|
| Scheduled rebalancing to targets within per-asset caps | The autopilot (`src/autopilot.ts`) plans from balances (`src/treasury.ts`), runs only while its grant's label carries the digest of the strategy the DAO approved | Mainnet: `op_YQnAILxJ…` executed alone, 2026-10-12 16:17Z (docs/mainnet-log.md) |
| Quote every route before executing | Each leg is dry-quoted and dropped above the strategy's cost cap; plans expire after 5 minutes and run at most once (`src/plans.ts`) | Mainnet: two quoted legs, `op_K4w1dsSM…`, `op_XNaqLYyK…`, 2026-10-12 20:36Z |
| Budget headroom ticks down | Overview's "Monthly budget left" reads the provider's usage | Mainnet: dashboard, from the policy's `usage.budget` |
| A breach is refused | The Agent API refuses over-budget spends | Mainnet: `spend_budget_exceeded`, $4.69 against $4.33 left, 2026-10-12 13:57Z and 14:06Z; nothing moved |
| Idle stables swept confidential | The autopilot shields every public balance before rebalancing | Offline: `test/sweep.test.ts`. A shield under the same destination list worked on a test agent (`op_mPNFaz-SI04…`, 2026-10-13); the treasury agent itself has never shielded |
| Budget charged atomically with dispatch | Provider-enforced | Per provider docs; not independently verified ([enforcement](enforcement.md)) |

## Differences from the brief

- **Three quoted swaps.** Three assets need at most two swaps to rebalance, so the demo shows two.
- **Unshield for payouts.** Not needed: payouts are confidential transfers from the payout agent,
  which the treasury agent funds without a vote (`op_Y5KTotI2…`, 2026-10-11). Funds don't go public, as long as the payee can receive confidentially
  ([enforcement](enforcement.md#what-a-stronger-claim-needs)).
- **No address whitelist.** The brief expects whitelist mode to conflict with shielding. Here the
  treasury agent's `only` list (the DAO and the payout agent) didn't stop a shield on a test agent
  with the same list; no `policy_confidential_whitelist_conflict` exists in any public source.

Where this lives in the code: [architecture](architecture.md).

## Gaps

- What a swap buys is checked by this server, not by the provider; strict cumulative per-asset
  limits and USD-budget atomicity are unproven ([enforcement](enforcement.md)).
- The autopilot hasn't run unattended for days; its warnings stay in the dashboard.

## Next (planned, not built)

- **Undo window.** The policy's `timelock_ms` holds each execution; the dashboard lists them
  (`listScheduledExecutions`) with a countdown and a cancel (`execution_cancel`), so the owner has a
  veto on every autopilot swap. Needs its own money-path design first: today a queued execution
  counts as unresolved and blocks new sends, and provider timelocks are held because their
  release-time checks aren't established ([architecture](architecture.md#how-the-money-path-stays-safe-on-one-host)).
- **Asset pinning, shown.** The policy lists the assets the agent spends; this server also refuses a
  swap into an unlisted one (`asset_out_not_allowed`, `src/authorize.ts`), which the provider doesn't
  check. Add it to the dashboard's evidence once refused on mainnet.
