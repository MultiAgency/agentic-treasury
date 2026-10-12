# Enforcement: what the signed envelope guarantees today

What this prototype can claim about staying inside the owner's policy, the gaps, and the smallest sequence
to close them. Evidence and source pins are in the release record (proto-releases/…/GUARANTEE.md).

**Claim:** "The prototype performs autonomous rebalancing with application checks and provider-enforced
limits. Output-asset enforcement is local, cumulative per-asset limits are best-effort, and USD-budget
atomicity has not been independently verified."

## The envelope
The owner signs:
- **Allowed assets.** A swap's input and output are in `assets`.
- **Permitted actions.** `actions`, with shield and unshield under `confidential`, and transfers only to
  `destinations`.
- **Cumulative per-asset spending caps.** Per transaction, hour, day and month. A swap spends its input.
- **A cross-asset USD budget.** Rolling 24 h, 7 d and 30 d, shared by every grant.

Outside the envelope:
- The strategy (allocation target, cost cap, per-run ceiling): an application rule bound to the owner's
  approval by the grant label.
- Holdings and their market value. Spending caps never bound exposure.

## Status
| Constraint | Status |
|---|---|
| Output asset | **Observed enforcement failure.** A mainnet swap into an asset outside `assets` succeeded (op_F2Yko4W0gDPrZXy0EzVYxjCk_z9q1kz3rr8bWGWJglk, 2026-10-10). The open-source policy engine checks only a swap's input. Our executor checks the output (`assetGuard`); nothing below it does. |
| Cumulative per-asset caps | **Documented weakness in a component.** The policy engine calls them best-effort under concurrency. End-to-end reachability through the deployed API is unresolved: the API refuses a second money operation on a busy wallet (`wallet_busy`), but that refusal's scope and duration are unknown, as are its crash behaviour and whether usage is durable before the next admission. The provider's documentation contradicts itself on when usage is recorded. |
| USD budget | **Unverified.** Documented as atomic at dispatch and shared by all grants, with no evidence either way. |
| Input asset, actions, frozen, per-transaction cap | Enforced in the provider's TEE, per its source. The deployed version is not established. |
| Destinations | Enforced by the Agent API, per its docs. One mainnet refusal was observed. |
| Deposit conversion | **Open question, not a known bypass.** A deposit may name a `destination_asset` and needs only the API key. It converts incoming funds, not existing treasury funds. Whether the agreement should restrict assets acquired that way, and whose authority permits it, is to be decided. |
| Shield under a non-empty `only` list | **Untested.** The treasury agent has never shielded. |

## Two facts that limit any local guarantee
- **One live grant is not one sender.** Any number of processes can share a token. Counting grants fences
  nothing. Our money lock is a file lock on one host. The only cross-host serializer we know of is the
  provider's own `wallet_busy`, and its scope is unknown.
- **A local journal gives a local guarantee.** It bounds operations this executor sends. It can match the
  provider's envelope only after these are specified:
  - initial usage reconciliation, from the provider's history, for activity before the journal existed;
  - accounting prices: which quote, and whether charges are trued up to `amount_in`;
  - windows: the provider's rolling or calendar semantics;
  - unresolved operations: reservations kept on unknown outcomes;
  - policy changes: reductions never release usage;
  - external activity: operations other senders made, seen only once they reach the provider's history.

## Smallest implementation sequence

### Needed whatever the providers answer (after the money-path freeze)
1. **`authorize.ts`**, the confirmed single authorization rule, plus the output-asset rule: a swap whose
   `destination_asset` is outside `assets` is refused and recorded before anything is sent.
   - Done: the pure rule (src/authorize.ts) and its purpose-by-rule tests (test/authorize.test.ts).
   - Done: wired into `dispatch` (every send), `checkPaymentApproval` and `invoices.agreed()`. Plan
     refusals are now logged with their codes. The 8 authorization regressions are plain tests.
   - Trimmed 2026-10-12 at the user's direction to what the provider can't check: the identity and
     agent-status rules (and their two reads per send) are gone, and sends leave payees and the
     per-transaction cap to the provider. Approvals still check payee and cap against the policy now,
     since the provider checked them under the policy when the payment was requested.
   - Not yet deployed.
2. **One grant-using send site, enforced.** Done: test/send-path.test.ts fails if anything but
   `dispatch` → `send` (src/agent.ts) calls swap, transfer, shield, unshield or withdraw on a grant, or if
   the quote at src/treasury.ts:99 stops being `dry: true`.
3. **Decide the threat model.** If it includes bypass by the agent itself (its code, its LLM steward, or
   anyone on its host), isolate the credentials:
   - the grant token is readable only by a separate signer process, which the agent can't alter;
   - the agent has no other execution path.
   - Until that holds, the guarantee covers only the executor's code path.
   - The steward today only proposes plans, and execution goes through `executePlan`, so it has no
     direct send.

### Contingent on the providers' answers
| If the providers say | Then |
|---|---|
| The output asset is checked at admission (deployed) | Confirm with acceptance test E1. The local rule stays as defence in depth. |
| It isn't, or won't be | The output-asset limit stays an application guarantee. State that in the claim. |
| `wallet_busy` serializes until usage is durable, across hosts and grants | No local per-asset reservations. Confirm with E2–E4. |
| It doesn't | Local admission with reservations for operations through this executor, built only after the journal spec above is complete. The claim stays local. |
| USD charging is atomic, with stated semantics | Rely on it. Confirm with E5–E9. |
| It isn't | Add USD to the same local admission. The claim stays local. |
| Deposit conversion spends treasury funds, or the agreement must restrict acquired assets | Add deposits to `authorize` as their own admission path. |

## Acceptance tests
Offline tests prove our logic, using instrumented stand-ins and no provider calls.

| Test | Required |
|---|---|
| A1 | A swap into an asset outside `assets` is refused and recorded, with no send. |
| A2 | The same for a plan leg, an autopilot leg and a steward proposal. |
| A3 | A policy change between preview and execution is refused. |
| C1 | Only `dispatch` → `send` uses a grant (test/send-path.test.ts, done). |
| G1 | Without a session, as an outsider, or as a plain member, operator-only procedures never reach the agent server (test/gateway-denial.test.ts, done). |
| G2 | The member allowlist matches every router procedure (test/member-access.test.ts, done). |

If local reservations are built:

| Test | Required |
|---|---|
| B1, B2 | Two admissions that each fit but together exceed a cap or the budget: one is admitted. |
| B3 | Window boundaries match the specified semantics. |
| B4 | An unknown outcome keeps its reservation and blocks new sends; only proven non-execution releases it. |
| B5 | A same-key retry makes one charge. |
| B6 | A crash before the claim leaves the operation never submitted, with no send. |
| B7 | A policy reduction refuses new sends and keeps existing usage. |

Provider integration tests run on an isolated, funded agent with tiny limits, only with the owner's
authorization. They are reported separately, with operation ids.

| Test | Required |
|---|---|
| E1 | A direct-credential swap into an unlisted asset: record the result. Today it is expected to succeed. |
| E2–E4 | Concurrent requests across two grants exceeding an hourly cap, a monthly cap, and a burst: record the admissions and `wallet_busy` behaviour. |
| E5 | Concurrent requests across two grants exceeding the USD daily budget: at most one admitted. |
| E6 | A same-key retry after a client timeout: one execution, one charge. |
| E7 | FAILED with `never_executed` releases the charge. |
| E8, E9 | A policy reduction or grant revocation while an operation is queued or held: record the behaviour. |
| E10 | A shield under a non-empty `only` list: record the behaviour. |
