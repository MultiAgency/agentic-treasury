# Mainnet log

Dated mainnet runs after the first payouts, which are in the [README](../README.md#mainnet-results).

Invoices on mainnet, 2026-10-12: the page is live on Railway. A contractor signed in with a NEAR
wallet as an agreed payee, submitted 1 USDC, the DAO approved it from the dashboard (listed as `remote`,
from the API's history), and it was paid (`op_v9arO4LB3y5…`); the same flow ran locally first
(`op_uGL7aTAhD1u…`). Earlier test invoices were imported read-only with their recorded outcomes.

The same flow at the custom domains, with both executors on Railway, 2026-10-12: an invoice filed at
invoices.multiagency.ai, approved from proto.multiagency.ai and voted in Trezu (proposal #47), was paid
(`op_uUMA-amAfCgPJ9Icfc8gJlQgK8SeUOPdDfs40mm3nBA`). The invoice before it was held, approved an hour
later (#46), and then failed: the payout wallet was empty, and the API had taken it to `PENDING_APPROVAL`
anyway (`op_v5cnpSsa6u3…`). The treasury agent refilled it with 2 USDC, without a vote (`op_QtfZedy0…`).

One-click approval, 2026-10-12 22:17 UTC: a member who may propose and vote filed the approval and voted on
it in one transaction (`add_proposal` + `act_proposal`, tx `HcBkN62VzByJmrWWa26TTiQJKavLcoxZGX9AXDfJyuUh`),
so proposal #51 executed at once and the server submitted the signature (`intent_V69AdRkC…`). The payout
itself (`op_9rM_JoIhNqq5…`) then failed at the provider, with the reason redacted. The wallet was empty when checked
afterwards, which suggests insufficient funds (the deployment then had no balance check), but that's unproven. A failed
vote rolls the filing back: reproduced on a local sandbox with mainnet's DAO code (global hash `DtHZA1…`): a stale id,
a missing id and too little gas each left no proposal, kept the id counter and refunded the bond.

A held payout stays in the reported balance, 2026-10-13 (UTC): the empty payout wallet was credited 2 USDC
(`op_YFl1C3nr9ISSfjmDnxG7nBcs5HMIgBoVekQSSifMHC4`, 15:22:52Z), a 1 USDC invoice payout was held for approval
(`op_-PNz_6ZYkHxnHTrfuFWK4C1pVN0erP4WZkdlcKlDGrY`, 15:23:23Z), and the confidential balance still read 2 USDC at
15:25:03Z. The balance check subtracts held payouts itself, so it doesn't count them twice.

The treasury agent rebalancing itself under a DAO-approved strategy, 2026-10-12 (UTC). The strategy
(`.strategy/.env.dao.json`: 50/25/25, cost cap 250 bps at the swap's floor, at most $5 per hourly run) is
approved only by a grant whose label carries its digest, `treasury:117b0a425eba717b9bd2d4759f06b3c4`.

| Time | What happened | Evidence |
|---|---|---|
| 13:19 | The strategy's ceiling was raised to $5 without a new grant: the autopilot planned a $4.68 swap and sent nothing, asking the owner for a grant with the new label | inbox; no request in the ops log |
| 13:28–13:55 | The DAO voted grants for the new strategy (one per change of ceiling and cost cap) | grants `…27f16cbd…`, `…117b0a42…` |
| 13:57, 14:06 | The swap passed the strategy and grant checks; the Agent API refused it: $4.69 against $4.33 left in the daily USD budget. Nothing moved | `spend_budget_exceeded`, recorded as refusals |
| 16:17 | After the budget reset, the autopilot executed the swap alone: 0.83 wNEAR → USDC, $4.60, settling the book at 25.0 / 48.4 / 26.6 % against 25 / 50 / 25 | `op_YQnAILxJH0znMq0KkfedpvSNLj9SMKn5ixAuq26vPzc` (SUCCESS), plan `3085918c` with the strategy digest |
| 17:20 | Execution moved to the hosted `dao` service on Railway; the laptop's dashboard is approve-only | Railway deployment `c8934842` |
| 20:36 | On Railway, a run (Run now) executed a $4.60 rebalance alone, as two legs, settling the book at 50 / 25 / 25. A run executes only if its whole plan is within the $5 ceiling and each leg at least $2; the run before, at $6.30, was left for the owner | `op_K4w1dsSM6qnsy6H4MQs4pJEk6xaB8qBOm5z_4flr5S4` (USDC → wNEAR), `op_XNaqLYyKbGtTqnqKudiH8uQGIPQKxYvU9oLjHXJdaW4` (USDC → ETH) |

Along the way, two new pre-send checks held every agent until fixed: refused requests counted as missing
history, and budgets compared as text ("25" vs "25.00"). Both failed safe: nothing was sent.
