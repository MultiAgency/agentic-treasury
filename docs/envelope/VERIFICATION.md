# Signed envelope verification record

Verified on 2026-10-12 from a workspace based on commit `9b9fe64f7669d82eb4a5a133c2f04ea6f32c0592`, public API
documentation fetched that day, and the pinned sources below. Application edits appeared during this
review; the rerun record pins the tested application sources, selected suites and fixtures separately
from the base commit. This verifies the implementation plan's
premises; it does not establish deployed provider correctness or complete the custody proof.

The [contract and delivery gates](../signed-envelope.md) and
[acceptance protocol](ACCEPTANCE.md) are the next-work specification. The
provider questions remain local drafts, outside the repository; no outreach or live execution was performed.
These deliverables live under `docs/` because `research/` is ignored by this repository. The existing
private research draft remains available, but the plan's links do not depend on ignored files.

## Evidence matrix

Second pass, 2026-10-12. Each claim carries one evidence class:

- **Observed:** seen on our own deployment, chain reads or logs.
- **Tested upstream:** asserted by a provider end-to-end test at the pinned commit; not run by us.
- **Source:** read in pinned public source. Deployed correspondence is not established (see Deployed
  identity), so source facts describe the pinned code, not necessarily the running service.
- **Documented:** stated in provider documentation or specifications.
- **Inferred:** our conclusion from the above.
- **Unknown:** no public evidence either way.

Pins: outlayer@b8c58c0, shared-tee-helpers@f75a74e (STH), skills@2e68162, sdk-typescript@00cdb65,
examples@859674f, out-layer/api-spec@fb54744. Each was the head of its default branch on 2026-10-12.

| Subject | Claim | Class | Reference |
|---|---|---|---|
| Deployed identity | `outlayer.near` code hash `2K9si4Kct6awAvbUTgAohivmfnGHV3UVXJc9KyQqvsae`; NEP-330 metadata has `build_info: null`, `link: null` | Observed | NEAR RPC `view_account`, `contract_source_metadata`, block 219756954 |
| | The contract's build script is non-reproducible, so a rebuild offers no hash to compare | Source | outlayer contract/build.sh:10 |
| | The coordinator reports `git_sha` `ff99b418b1be-dirty`, built 2026-10-09; that commit is not in the public repository | Observed | `api.outlayer.ai/health`; full 709-commit history |
| | No build identity found at the Agent API's `/health`, `/version` (404), `/v1/network` or OpenAPI `info.version` (`1.0.0`), on both `api.agentsonintents.com` and `api.demo.agentsonintents.com`, the host this repository's `.env` targets; both report mainnet and `outlayer.near` and expose the same paths | Observed | 2026-10-13; the hosted services' API host was not inspected |
| | On-chain TEE measurement allowlists exist, with no mapping from measurement to source | Observed | `dao.outlayer.near` `get_approved_measurements`; `worker.outlayer.near` |
| | Deployed-source correspondence | **Unknown: we could not establish it** | Not proof that none exists or that it is impossible |
| Output asset | A direct-API swap into an asset outside `assets` executed | Observed | op_F2Yko4W0gDPrZXy0EzVYxjCk_z9q1kz3rr8bWGWJglk, 2026-10-10 |
| | The policy engine evaluates `token_in` only; `token_out` is never read outside types and tests | Source | STH src/wallet_policy.rs:467–476, :1011–1014 |
| | Our dispatch refuses such a swap before sending | Observed | `asset_out_not_allowed` in `.ops`; src/authorize.ts:87 |
| | Deposits need only the API key and do not spend treasury funds | Documented | llms.txt; skills executions.md:12, :94 |
| | A deposit's conversion target is checked against `assets` | Unknown | No deposit op in the policy engine (STH :988–991) |
| Per-asset caps | Two simultaneous spends against one limit: exactly one passes; the loser gets `wallet_busy` or `policy_denied` | Tested upstream | outlayer tests/wallet_concurrent_spend_e2e.sh:3–31 |
| | Usage is written while the winner holds the wallet | Tested upstream | same, :272–273 |
| | One usage row per wallet, shared by every caller | Tested upstream | tests/velocity_two_doors_e2e.sh:5–10 |
| | A cross-chain withdraw holds the wallet after the HTTP reply | Tested upstream | tests/money_settlement_step3_e2e.sh:128–135 |
| | A swap holds the wallet for its duration ("the operation in front is a long one — a swap") | Documented | api-spec openapi.yaml:6283–6302 |
| | After a settled 2 USDC swap, the identical 2 USDC request is refused (`policy_denied`, nothing dispatched) when only the 3 USDC monthly cap is exceeded: per-transaction, hourly and daily caps (5), the $10 budget and the balance all fit | Observed | Isolated agent fbb390d7…, op_Uli9thHS… then the refusal, 2026-10-13T03:27Z; proto-releases/20261013T032658Z-envelope-phase1/. Attribution rests on the identical request and the isolation; per-asset usage is not exposed by the API |
| | Our swaps took 38.2 s and 38.5 s from dispatch commit to SUCCESS | Observed | op_chWGr75v9…, op_h5YOjfvIK…; a test-design input, not lock evidence |
| | No `wallet_busy` in our logs | Observed | `.ops`; expected, since our executor sends one operation at a time |
| | Lock implementation, and whether it coordinates across coordinator instances | Unknown | Not inferable from a test comment |
| | Usage recorded post-settlement, nothing reserved | Documented | CUSTODY.md:386 (current); :1077 (older) contradicts it |
| | The stateless engine leaves serialization to its caller | Source | STH :786–792 |
| | After a crash between broadcast and status write, the row stays uncharged until a read repairs it and charges once | Tested upstream | tests/stuck_request_repair_e2e.sh:3–31 (R1–R3) |
| | New admissions are blocked until that repair | Unknown | An exploitable overspend interval is not established |
| | Hourly and daily counters are UTC calendar buckets | Tested upstream | tests/velocity_accounting_e2e.sh:40–41 |
| | Monthly bucket `monthly:%Y-%m` | Source | Removed coordinator code (94a3c27 handlers.rs:221–223); current key unknown |
| | Provider limits are "rolling" | Documented | skills policy.md:54; contradicts the upstream tests |
| | Policy writes are not serialized with spends | Inferred | Policies are stored on chain by the owner; the keystore re-reads policy on each check (CUSTODY.md:375–376) |
| USD budget | Over-budget requests are refused at admission, before the provider | Observed | 6 `spend_budget_exceeded`, each 0.47–0.57 s after the request |
| | Charged atomically at dispatch; shared by all grants; uncertain work stays charged; released once on `never_executed` / `never_submitted`; rolling 24 h / 7 d / 30 d | Documented | skills policy.md:57, :61; llms.txt; sdk README.md:287 |
| | Queued (timelocked) work reserves nothing | Documented | examples 10-recipes/02-timelocked-payout.ts:10 |
| | Five simultaneous $0.40 swaps sent directly with one grant, $1.0005 of a $3 daily budget left (room for two): one accepted and settled, one `wallet_busy`, three `spend_budget_exceeded`; budget $1.999536 → $2.399537, no overshoot | Observed, one trial | Isolated agent fbb390d7…, 2026-10-13T03:32:30Z, op_13BiIirYsg208ObtehlBZqEwvW52gthNOoW0EZEvlRo; proto-releases/20261013T033230Z-envelope-concurrency/result.json |
| | Admission was more conservative than the remaining figure: with $0.40 in flight, $0.60 remained, yet further $0.40 requests were refused | Observed, one trial | Same; why is unknown (a larger reservation, refusal while anything is in flight, or pricing) |
| | Atomicity mechanism, cross-instance behaviour, recovery | Unknown | One sequential-host trial does not establish the mechanism; Agent API source is not public |
| Policy binding | `policy_hash` = sha256 of the returned policy JSON with sorted keys, no whitespace, array order kept | Observed | Recomputed for all 12 revisions of the treasury and payout agents |
| | `agent_policy_hash` is not a function of the policy: revisions 6 and 8 share `policy_hash` `a4e07f3…` but carry `3d90673…` and `0908ee0…` on chain | Observed | Treasury NEP-366 txs 6CF58cJ…, G1ktzFf… to `outlayer.near` |
| | `store_wallet_policy` takes no `agent_policy_hash` | Source | outlayer contract/src/wallet.rs:299–305 |
| | The policy blob is ECIES-encrypted to a keystore key; `wallet_signature` is made by the custody wallet key | Source | keystore-worker/src/crypto.rs; contract/src/wallet.rs:265–279 |
| | A NEP-413 `update_policy` message (budget-only edit) carries the complete plaintext policy, `expected_revision`, `agent_id`, `owner`, `owner_epoch`, `tenant_id`, `target_id`, `network: mainnet`, domain `near-intents-agent-api.owner-admin.v2`, a nonce and a 5-minute expiry; its NEP-413 recipient is the API host. An owner can therefore read exactly the terms and revision they sign | Observed | Generated, never signed, for CLI agent 38da322c… on api.demo.agentsonintents.com, 2026-10-13T03:16Z; captured in proto-releases/20261012T2314Z-envelope-verification/captures/ |
| | The preview's `policy_hash` equals sha256 of the signed message's policy (sorted keys, no whitespace), so the preview and the signed terms can be matched | Observed | Same capture |
| | A NEP-366 `policy_update` (an asset change) signs only a delegate to `outlayer.near` `store_wallet_policy` with `wallet_pubkey`, `encrypted_data`, `wallet_signature` and `agent_policy_hash`, deposit 0; the readable policy and its `policy_hash` appear only in the unsigned preview, and `agent_policy_hash` differs from `policy_hash` | Observed | Generated, never signed, same agent and host, 2026-10-13T03:23Z; same capture folder |
| | What `target_id` identifies | Unknown | Not the agent id, the wallet's NEAR account or wallet id, nor a plain sha256 of any of them |
| | The readable policy equals the encrypted policy enforced | Unknown | Not checkable by an owner or third party |
| Execution artifact | For Trusted ops (`swap`, `confidential`, which includes our payouts), the keystore checks only that the NEP-413 recipient is `intents.near` / `intents.far`, then signs the message unparsed | Source | keystore-worker/src/api.rs:4630–4632, :5729–5786; CUSTODY.md:172 |
| | An approval binds whether the op runs, not its token, amount or routing | Documented | CUSTODY.md:494–505 |
| | Our approval check binds the intended payment locally: payee, amount and asset recomputed to the provider's request hash before the DAO votes | Observed | src/payment-approval.ts; recomputed on mainnet 2026-10-11 |
| | The final signed artifact matches those terms | **Depends on an honest coordinator** | Deployed behaviour unknown |
| | Confidential swaps and transfers leave no public trace to check after the fact | Documented | CUSTODY.md:862–866 |
| Shielding | `destinations` covers withdrawals and transfers only | Documented | skills policy.md:28–30, :56 |
| | The address rule skips an op with no recipient | Source | STH :1026–1027 |
| | `policy_confidential_whitelist_conflict` | Absent | No public source, documentation or OpenAPI |
| | A shield under the treasury's live destination list succeeds and charges no USD budget | Observed | E10 on isolated agent fbb390d7…, op_mPNFaz-SI04…, 2026-10-13T03:27Z; proto-releases/20261013T032658Z-envelope-phase1/ |
| Operation proofs | The SDK verifier checks event inclusion, `correlation_id`, action, time and evidence hash; not policy revision, terms or budget admission | Source | sdk-typescript transparency/operation-proof.ts:60–134 |
| | Completeness, consistency and retention | Unknown | Not documented |
| Mediation | Grant tokens are readable outside the executor's code path | Observed | Local credential inventory (kept outside the repository) |

CUSTODY.md still disagrees with itself about when cumulative usage is recorded. Blame resolves it: the
post-settlement statement (:386, 2026-08-25) is current, and the before-execution statement (:1077,
2026-02-22) matches the coordinator code since removed from the repository. Upstream tests show usage
written while the lock is held; the deployed behaviour is not established.

## Plan corrections

1. Add execution-artifact binding as a separate proof obligation. Correct accounting of requested terms
   is insufficient if a different debit can be signed.
2. Separate spending authority from acquisition/holdings rules. Incoming deposits are documented as
   non-spending; a forbidden conversion target should be an acceptance failure only if the agreed scope
   includes that restriction.
3. Use the audit-proof endpoint as possible evidence of particular events, without treating `PROVEN`
   as proof of complete or correct budget accounting.
4. A lowered cap can be below historical spend. The invariant constrains new admissions while retaining
   old usage; it does not retroactively make an owner's reduction invalid or erase charges.
5. Pin window and delayed-operation semantics before implementing reservations. A reservation must not
   age out while still authorizing a new debit in a later window.
6. Require signature-to-policy verification before calling the local mandate digest owner-signed.
7. Keep phase 3's architecture decision open. Public inspection does not establish enough remote
   semantics to justify implementing a second budget engine or claiming isolated enforcement today.

## Reproducible evidence

The public [source manifest](sources/2026-10-12/manifest.json) records SHA-256 hashes, URLs, source pins
and the local commit, so each source can be fetched again and checked. The exact copies of llms.txt, the
OpenAPI schema and the pinned policy reference are kept with the release records
(`proto-releases/20261012T2314Z-envelope-verification/sources/`), not in this repository. No
credentials, account-specific responses or confidential balances are included.

- [Agent API documentation](https://api.agentsonintents.com/llms.txt): policy, agent actions and spending budget sections.
- [Agent API schema](https://api.agentsonintents.com/openapi.json): `Policy`, `Intent`, `IntentPreview`, policy history and operation proof routes.
- [Pinned policy reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/2e68162a0cb136c28194e49330345a78064761c0/near-intents-agent-api/references/policy.md): field ownership and atomic-dispatch statement.
- [Pinned policy engine](https://github.com/out-layer/shared-tee-helpers/blob/f75a74e5bcffb5434feeb5da6a0078a43d712622/src/wallet_policy.rs#L465): input selection; usage commentary around line 786; token enforcement around line 1018.
- [Pinned custody documentation](https://github.com/out-layer/outlayer/blob/b8c58c00be33d83c7c60769b646e0ba11e8a39ec/CUSTODY.md#L386): usage lifecycle; artifact trust around line 493; contradictory usage statement around line 1077.

The two pinned OutLayer checkouts had clean working trees during inspection. Their commits identify
source versions, not the deployed service. The older mainnet observations were reviewed from the
existing release record and provider-question draft; they were not independently replayed this turn.

Focused offline validation used the command in [ACCEPTANCE.md](ACCEPTANCE.md): the first run had **56
passed**, and a rerun after concurrent edits had **57 passed**, both with zero failed, skipped or TODO.
The rerun record (`proto-releases/20261012T2314Z-envelope-verification/local-verification.json`) identifies an unselected test that changed during the
observation interval. Application source, selected suites and fixtures matched their captured hashes
at verification. These seven suites cover the application properties listed there; they are not a
provider integration test or proof of accounting atomicity. The runner required sandbox escalation for
its local IPC socket and used `test/offline.env`, whose API/RPC endpoints point at a closed local port.

The rerun record is a historical snapshot of the working tree at 2026-10-12T23:14:02Z. Source has
changed since (for example the `src/mandate.ts` comment, and the staged review set), so its hashes
describe that snapshot, not the current tree. A new record is generated when a release candidate is
verified; this one is kept unchanged.

## Outstanding dependencies

Six questions remain for the providers:

1. What identifies the deployed enforcement code?
2. What prevents admission before crash-recovered usage is accounted for?
3. What coordinates wallet admission across service instances?
4. How are USD reservations made atomic and recovered?
5. What binds owner-authorized policy and operation terms to the actual signing artifact?
6. Will both swap assets be enforced?

E10 settled shielding under the treasury's destination list (2026-10-13); unshield under it remains untested. The current defensible promise is conditional on an
honest, correct API, coordinator and custody stack. Protection against a compromised coordinator would need
the signing boundary to verify the actual transaction terms; application authorization and credential
isolation alone cannot provide it. Until
these are resolved, phases 1 and 2 have concrete specifications and verified premises, but their exit
criteria remain open. No stronger guarantee is approved by this record.
