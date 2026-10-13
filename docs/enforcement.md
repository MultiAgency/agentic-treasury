# Enforcement: what the signed envelope guarantees today

What this prototype can claim about staying inside the owner's policy, the gaps, and the smallest sequence
to close them. Evidence and source pins are in the release record (proto-releases/…/GUARANTEE.md), which is kept
outside this repository.

The [signed-envelope verification plan](signed-envelope.md) defines the threat model, accounting
obligations and delivery gates. The [2026-10-12 verification record](envelope/VERIFICATION.md)
checks the premises against current public documentation and pinned source, and records the passing
local regression checks and their source-correspondence limitation. The
[2026-10-13 cryptographic and API checks](envelope/2026-10-13-binding-accounting-artifacts.md)
verify policy-transaction signatures but leave plaintext binding, cross-grant crash accounting and
signed spending artifacts unverified. Provider deployment correspondence remains outstanding.

**Claim:** "The prototype performs autonomous rebalancing with application checks and provider-enforced
limits. Output-asset enforcement is local, strict cumulative per-asset limits depend on provider
serialization that is not fully established, and USD-budget atomicity has not been independently verified."

## The envelope
The intended complete policy contains the following rules. The API documents signing the complete
policy; independently verifying the binding from its plaintext to the signed payload remains open.

- **Allowed assets.** A swap's input and output are in `assets`.
- **Permitted actions.** `actions`, with shield and unshield under `confidential`, and transfers only to
  `destinations`.
- **Cumulative per-asset spending caps.** Per transaction, hour, day and month. A swap spends its input.
  OutLayer's pinned tests describe the hour, day and month counters as UTC calendar periods, not rolling
  windows; the deployed version is not established.
- **A cross-asset USD budget.** Rolling 24 h, 7 d and 30 d, shared by every grant.

Outside the envelope:
- The strategy (allocation target, cost cap, per-run ceiling): an application rule bound to the owner's
  approval by the grant label.
- Holdings and their market value. Spending caps never bound exposure.

## Status
| Constraint | Status |
|---|---|
| Output asset | **Observed enforcement failure.** A direct-API mainnet swap into an asset outside `assets` succeeded (op_F2Yko4W0gDPrZXy0EzVYxjCk_z9q1kz3rr8bWGWJglk, 2026-10-10). The open-source policy engine checks only a swap's input (wallet_policy.rs:467–476, :1011–1014), unchanged at the head of every public provider repo on 2026-10-12. Our executor checks the output (`outputAssetRefusal`, src/policy.ts); nothing below it is shown to. |
| Cumulative per-asset caps | **Serialized per wallet, per upstream tests; strict enforcement unproven. A monthly-cap refusal is observed:** on an isolated agent, after a settled 2 USDC swap, the identical 2 USDC request was refused with `policy_denied` and nothing dispatched; only the monthly cap (3 USDC) was exceeded (op_Uli9thHSyzCONMy1iHrB_6JHiMhQPJWeQohdiBZlrxs then the refusal, 2026-10-13T03:27Z; proto-releases/20261013T032658Z-envelope-phase1/; runner src/envelope-phase1.ts, committed at c25b61b). Sequential, not concurrent. Upstream end-to-end tests show that of two simultaneous spends against one limit exactly one passes, that usage is written while the wallet is held, that every caller shares one usage row, and that a crash leaves an operation uncharged until a later read repairs it and charges it once (outlayer@b8c58c0 tests/wallet_concurrent_spend_e2e.sh, velocity_two_doors_e2e.sh, stuck_request_repair_e2e.sh). The API specification documents that a swap holds the wallet for its duration. Unknown: whether new admissions are blocked until a crashed operation is repaired, how the lock coordinates across service instances, and which version is deployed. The coordinator is private. |
| USD budget | **Held in one concurrent trial; mechanism unverified.** Five simultaneous $0.40 swaps sent directly with one grant, with room for two: one executed, one got `wallet_busy`, three got `spend_budget_exceeded`, and the budget did not overshoot (isolated agent, 2026-10-13T03:32Z; proto-releases/20261013T033230Z-envelope-concurrency/result.json; runner scripts/envelope-concurrency.ts, committed at c25b61b). Admission was more conservative than the reported remaining budget. One trial, one grant, one host: not proof of atomicity across grants or instances, or after a crash. |
| Signed policy binding | **Not independently verifiable.** The API's `policy_hash` is reproducible: sha256 of the returned policy with sorted keys (recomputed on 2026-10-13 for all 15 returned revisions: treasury 1–11, payout 1, isolated agent 1–3). The on-chain `agent_policy_hash` is not a function of the policy, and the public `store_wallet_policy` takes no such argument. The enforced policy is stored encrypted to a custody keystore key and signed by the custody wallet key, not the owner, so it proves neither that the owner signed those terms nor that no owner authorization exists elsewhere. A NEP-413 `update_policy` message, captured unsigned on the demo host, carries the complete plaintext policy, revision, agent, owner and domain, so an owner can read what they sign for API-enforced edits; whether the provider-enforced part matches it is the open question. |
| Execution artifact | **Coordinator trust assumption, in pinned source.** For swaps and confidential transfers (including payouts), the keystore checks only that the signed message is addressed to `intents.near` or `intents.far`, then signs it unparsed (keystore-worker/src/api.rs:5729–5786). Our approval check binds the intended payment locally (payee, amount, asset to the provider's request hash), and the owner's approval binds whether the operation runs; that the final signed artifact carries those terms depends on an honest coordinator. Deployed behaviour unknown. |
| Operation audit proof | **Unavailable on the sampled deployment.** At 2026-10-13T04:10Z, all three sampled successful operations returned HTTP 501 `transparency_log_disabled` from the demo API. Operation IDs and captures are in the linked verification record. Even an available event inclusion proof would not by itself establish signed spending bytes, complete history or atomic enforcement. |
| Input asset, actions, frozen, per-transaction cap | Enforced in the provider's TEE, per its source. The deployed version is not established. |
| Destinations | Enforced by the Agent API, per its docs. One mainnet refusal was observed. |
| Deposit conversion | **Scope question, not a known spending bypass.** Public API docs explicitly say deposits need an API key, no grant or owner signature, and do not spend treasury funds. Whether the agreement restricts conversion targets, and whether that is enforced, remains open. |
| Shield under a non-empty `only` list | **Observed working on an isolated agent.** Under a destination list copied byte-for-byte from the treasury's (revision 11), a shield of 0.5 wNEAR succeeded and charged no USD budget (op_mPNFaz-SI04vTSkwNrxk7SH3XdR23jzPMoPFHwtE1KQ, 2026-10-13T03:27Z, test agent fbb390d7…; evidence in proto-releases/20261013T032658Z-envelope-phase1/). The treasury agent itself has still never shielded. No `policy_confidential_whitelist_conflict` exists in any public source. |

## Recovery limitation

In current local source, `src/ops.ts` treats `SUCCESS`, `REFUNDED` and `FAILED` as terminal;
`src/recover.ts` records the status without checking separate non-execution evidence. Invoice
accounting also treats those statuses as terminal (`src/invoice-store.ts`). This relies on provider
status semantics. It does not independently establish that a failed operation had no payment effect
or that a replacement payment is safe. Acceptance case E7 requires that distinction; it remains open.
A missing operation ID on a claimed or legacy operation cannot be repaired by status-only reconciliation.

## Local crash and concurrency recovery

Offline process tests cover two fixes, in source commit `a23f0e1`, which the deployer reports as the
deployment of 2026-10-13 (dao `2713d2ea`, invoices `07a35af2`); the deployed source itself isn't verified:

- Journal v2 distinguishes a durable preparation from a submission claim. The sole send site writes
  the claim before the provider call. The next money-lock holder resolves only unclaimed v2
  preparations as `never_submitted`. Claimed, legacy and malformed records never gain an inferred
  non-execution outcome. Prepared invoices retain their existing SQLite continuation rules.
- Owner-action updates acquire a per-instance lock, reload durable state, and serialize preparation,
  submission, reconciliation and expiry. Separate processes retain both preparations and cannot
  overwrite another process's settled result with an older snapshot. Simultaneous first submissions
  observe the saved lifecycle before deciding whether to send.

The tests use real processes and storage with offline provider stand-ins (`test/journal.test.ts`,
`test/owner-intents-race.test.ts`). Locks are single-host leases; they do not fence a stalled process
across hosts or prove remote exactly-once execution. See the
[upgrade procedure](operations.md#journal-v2-and-owner-intent-locking-upgrade).

## Two facts that limit any local guarantee
- **One live grant is not one sender.** Any number of processes can share a token. Counting grants fences
  nothing. Our money lock is a file lock on one host. The only cross-host serializer we know of is the
  provider's per-wallet lock (`wallet_busy`); its interval relative to usage recording is unknown.
- **A local journal gives a local guarantee.** It bounds operations this executor sends. It can match the
  provider's envelope only after these are specified:
  - initial usage reconciliation, from the provider's history, for activity before the journal existed;
  - accounting prices: which quote, and whether charges are trued up to `amount_in`;
  - windows: per-asset counters in UTC calendar periods (pinned tests), USD budget rolling 24 h / 7 d /
    30 d (docs), with edges and the monthly bucket confirmed on the deployed version;
  - unresolved operations: reservations kept on unknown outcomes;
  - policy changes: reductions never release usage;
  - external activity: operations other senders made, seen only once they reach the provider's history.

## Smallest implementation sequence

### Existing integration and independent verification
1. **`authorize.ts`**, the confirmed single authorization rule, plus the output-asset rule: a swap whose
   `destination_asset` is outside `assets` is refused and recorded before anything is sent.
   - Done: the pure rule (src/authorize.ts) and its purpose-by-rule tests (test/authorize.test.ts).
   - Done: wired into `dispatch` (every send), `checkPaymentApproval` and `invoices.agreed()`. Plan
     refusals are now logged with their codes. The authorization regressions are plain tests (test/authorization.test.ts).
   - Trimmed 2026-10-12 at the user's direction to what the provider can't check: the identity and
     agent-status rules (and their two reads per send) are gone, and sends leave payees and the
     per-transaction cap to the provider. Approvals still check payee and cap against the policy now,
     since the provider checked them under the policy when the payment was requested.
   - Verified in current local source. Deployed-source correspondence was not established by the public-documentation review; do not infer deployment from these tests.
2. **One grant-using send site, enforced.** Done: test/send-path.test.ts fails if anything but
   `dispatch` → `send` (src/agent.ts) calls swap, transfer, shield, unshield or withdraw on a grant, or if
   the quote in src/treasury.ts `quoteLeg` stops being `dry: true`.
3. **Verify execution routes.** The credential and route inventory is
   kept locally, outside the repository (research/enforcement/M1-CREDENTIALS.md). Check which rules
   the Agent API and OutLayer enforce on every route available to the agent, including direct use of
   its grant. Application checks cover only the executor's code path.
   - The steward today only proposes plans, and execution goes through `executePlan`, so it has no
     direct send.

### Resolve with implementation and deployment evidence

Keep the Agent API and OutLayer integration. Public-source review and authorized isolated tests can
proceed independently; ask providers for evidence that cannot be obtained that way. Missing evidence
does not justify a separate signer, custody contract or local budget engine.

| Finding | Then |
|---|---|
| The output asset is checked at admission (deployed) | Confirm with acceptance test E1. The local rule stays as defence in depth. |
| It isn't, or won't be | The output-asset limit stays an application guarantee. State that in the claim. |
| `wallet_busy` serializes until usage is durable, across hosts and grants | No local per-asset reservations. Confirm with E2–E4. |
| It doesn't | Record the exact failure and required provider correction. Keep strict cumulative enforcement unproven. |
| USD charging is atomic, with stated semantics | Rely on it. Confirm with E5–E9. |
| It isn't | Record the exact failure and required provider correction. Keep atomic USD enforcement unproven. |
| Deposit conversion spends treasury funds, or the agreement must restrict acquired assets | Add deposits to `authorize` as their own admission path. |

## Acceptance tests

The [acceptance protocol](envelope/ACCEPTANCE.md) owns the A/B/C/G/E test cases, signature and
artifact checks, evidence requirements and live-test preparation. Current findings stay in the
status table above; dated observations and source pins stay in the
[verification record](envelope/VERIFICATION.md).
