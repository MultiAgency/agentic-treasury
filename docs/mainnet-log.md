# Mainnet log

Dated mainnet runs, with their op ids and proposal numbers. Each prototype's doc says which of these back
which claim:
[facilitator](facilitator.md), [treasury](treasury.md).

## A swap into an unlisted asset, 2026-10-10

A direct-API swap into an asset outside the policy's `assets` succeeded
(`op_F2Yko4W0gDPrZXy0EzVYxjCk_z9q1kz3rr8bWGWJglk`): the provider checks only the asset spent. This server now
refuses such a swap before sending ([enforcement](enforcement.md#status)).

## First payouts, 2026-10-11

Payouts from a confidential Trezu treasury (`agentic.sputnik-dao.near`), 2026-10-11. The payout agent
was created, granted and added to the treasury agent's agreement by DAO vote (proposals #23 to #25).

| Check | Result | Evidence |
|---|---|---|
| A payout waits for the DAO | 1 USDC to an agreed payee went `PENDING_APPROVAL`, was released by proposal #26 and settled | `op_ECYZZAMgrNUauo5YnlKdUrwmml8p_TP9yrs93ViY0GI` |
| A new payee is refused | Refused with `policy_destination_denied` before anything was recorded or voted on | treasury agent, 0.01 USDC to an unlisted account |
| Over-limit is refused | An 11 USDC transfer to the DAO refused with 409 `policy_denied`; nothing was sent | treasury agent under policy revision 8 (owner approval off, so no vote was involved), 17:51Z, `op_1rDuSQuaZfLdZRLoI-jRvoFEQdYmzCo91_nCLYVk8dc`. The only USDC limit it exceeded was the 10 USDC hourly cap; `policy_denied` doesn't name the rule |
| Agents fund each other without a vote | The treasury agent sent the payout agent 5 USDC inside its caps | `op_Y5KTotI2PhJPjWdtKN4SXxEGrAuymJrArNhmYYlHzh4` |
| Nothing public but the vote | The payout agent's account has no public transactions; no public NEAR Intents balances changed | NearBlocks, `mt_tokens_for_owner` |
| The payee sees no sender | near.com shows "Receive 1 USDC" with only a one-time 1Click deposit address, which 1Click's public status lookup doesn't know | deposit address `f26a8ae5…a17ee9` |

What stays visible or known: each approval is a public DAO proposal, so its timing shows; 1Click and
NEAR Intents can see the mapping, and their terms don't guarantee confidentiality. A held payment
stays approvable for 24 hours, but each vote request expires in about 5 minutes.

## Later runs

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

## Isolated test agent: shield and monthly cap, 2026-10-13T03:27Z

Run with the user's explicit authorization, during the unattended-run window, from base `9b9fe64` plus the
then-staged runner and `update-policy`, on an agent created for these tests by the laptop CLI owner,
never a production treasury or payout agent. Gas and storage ceilings weren't checked by the runner. The
remaining funds stay in the test agent. Agent `fbb390d7…2354` (wallet `7ad3bf83…f404`, owner
`treasury.multiagentic.near`), one grant (`b0f040b7…`, label `treasury:bc37ba01…`), autopilot off.
Policy revision 2: USDC caps of 5 per transaction, hour and day and 3 per month; a $10 USD budget in every
window; the destination list copied byte-for-byte from the treasury agent's revision 11. Funded with 8.88
USDC confidential (a DAO Trezu payment) and 0.5 wNEAR public (tx `5QGXHAWRvW36aSQTrR4fitDZApwWbyv2v1115pvhCVL6`).
Preflight: the applied policy matched, budget zero in every window, quote worst cost 179 bps.

| Step | Result | Evidence |
|---|---|---|
| Shield 0.5 wNEAR under the treasury's destination list | SUCCESS: public → confidential, USD budget $0 → $0 | `op_mPNFaz-SI04vTSkwNrxk7SH3XdR23jzPMoPFHwtE1KQ` |
| Swap 2 USDC → wNEAR | SUCCESS: USDC 8.88 → 6.88; budget $0 → $1.999536 | `op_Uli9thHSyzCONMy1iHrB_6JHiMhQPJWeQohdiBZlrxs` |
| The identical 2 USDC swap again | `policy_denied`, no correlation id, balances and budget unchanged | Only the 3 USDC monthly cap was exceeded: every other limit, the budget and the balance fit |

`policy_denied` names no rule and per-asset usage isn't exposed, so the monthly attribution rests on the
isolation and on the first swap being the agent's only USDC spend. Sequential, one grant, one host: it
shows the monthly cap enforced, not its behaviour under concurrency. Evidence, without tokens, is in the
release record `proto-releases/20261013T032658Z-envelope-phase1/`, outside this repository. The runner
is archived at commit `c25b61b` (`src/envelope-phase1.ts`).

## Isolated test agent: USD budget under concurrency, 2026-10-13T03:32Z

Same agent, policy revision 3 (`daily_usd` 3, all else unchanged), $1.000464 of the daily budget left.
Five $0.40 wNEAR → USDC swaps sent at the same instant straight to the API with the test grant, bypassing
this server's money lock (archived runner `scripts/envelope-concurrency.ts`, commit `c25b61b`).

- One accepted and settled (`op_13BiIirYsg208ObtehlBZqEwvW52gthNOoW0EZEvlRo`), one `wallet_busy`, three
  `spend_budget_exceeded`.
- Budget $1.999536 → $2.399537 against $3.00: no overshoot.
- More conservative than the figure suggests: two would have fit, one ran, and requests were refused while
  $0.60 remained. Why is unknown.

One trial, five requests, one grant, one host: not proof of atomicity across grants or API instances, or
after a crash. Evidence: `proto-releases/20261013T033230Z-envelope-concurrency/result.json`.

## Policy signatures and operation proofs, 2026-10-13T04:10Z

A read-only capture from `api.demo.agentsonintents.com`; nothing was generated, signed or submitted.

- All 15 returned policy revisions (treasury 1–11, payout 1, test agent 1–3) reproduce their API
  `policy_hash`. Nine captured NEP-366 policy delegates and nine custody ciphertext-store signatures
  verify, and fail when receiver, arguments or caller are changed. This binds the encrypted blobs, not
  their match with the readable policy. The policy-transaction checks used earlier RPC captures because
  fresh requests timed out; chain inclusion and historical key authority weren't independently checked.
- The ten retained NEP-413 owner signatures (five grant issues, one revocation, four approval votes)
  verify and match their recorded DAO hashes; changed messages and recipients fail. None is a policy
  update, so no owner policy signature has yet been verified against the enforced policy.
- Operation proofs: all three sampled successful operations (`op_XNaqLYyKbGtTqnqKudiH8uQGIPQKxYvU9oLjHXJdaW4`,
  `op_RCW0gaWGDo_fl7VYWln71qoFSPtfWGgXoGyVaStGvZ0`, `op_13BiIirYsg208ObtehlBZqEwvW52gthNOoW0EZEvlRo`)
  returned HTTP 501 `transparency_log_disabled`. That is an unavailable check, not evidence of a wrong
  debit.

Sanitized results: [report.json](envelope/results/20261013T0410Z/report.json),
[policy-signatures.json](envelope/results/20261013T0410Z/policy-signatures.json) and the
[capture manifest](envelope/results/20261013T0410Z/capture-manifest.json). Raw captures and the one-off
scripts are archived privately in `.evidence/provider-verification-20261013T0410Z/`.
