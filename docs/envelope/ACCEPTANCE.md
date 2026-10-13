# Signed envelope acceptance protocol

These cases validate the [verification contract](../signed-envelope.md). This document owns the
acceptance criteria; [enforcement.md](../enforcement.md) records current findings. Existing test IDs
are retained. Offline checks prove local behavior; provider tests produce observations, not an
unrestricted proof of a closed service.

## Existing local regression checks

Run with `test/offline.env`, never live credentials:

```sh
pnpm exec tsx --env-file=test/offline.env --test test/mandate.test.ts test/authorize.test.ts test/send-path.test.ts test/money-safety.test.ts test/plan-recovery.test.ts test/autopilot.test.ts test/recover.test.ts
```

These cover digest reproducibility, local output-asset denial, grant/strategy authority, changed or
expired plans, send-site structure and conservative recovery. Send-site scans are maintenance checks;
they do not constrain an adversary who has the credentials. A1–A3 and C1 remain application checks.

## Baseline acceptance cases

Offline tests prove our logic, using instrumented stand-ins and no provider calls.

| Test | Required |
|---|---|
| A1 | A swap into an asset outside `assets` is refused and recorded, with no send. |
| A2 | The same for a plan leg, an autopilot leg and a steward proposal. |
| A3 | A policy change between preview and execution is refused. |
| C1 | Only `dispatch` → `send` uses a grant (test/send-path.test.ts, done). |
| G1 | Without a session, as an outsider, or as a plain member, operator-only procedures never reach the agent server (test/gateway-denial.test.ts, done). |
| G2 | The member allowlist matches every router procedure (test/member-access.test.ts, done). |

Accounting verification cases for the existing provider integration (the offline model specifies
these obligations; it is not a production accounting engine):

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

## Cases required for the stronger claim

| ID | Experiment or evidence | Acceptance |
|---|---|---|
| S1 | Verify an actual owner signature and decode or open its complete policy commitment | Match wallet, domain, revision, complete terms and applied policy; changed terms fail verification |
| S2 | Attempt use of another wallet/domain, stale revision or modified preview | No cross-wallet/domain replay or preview substitution can authorize different terms |
| M1 | Inventory direct API, other grants, hosts, owner keys, recovery, approvals, withdrawal and signing paths | No agent-controlled path bypasses the selected enforcement boundary |
| E1 | Direct-credential swap into an unlisted output asset | Refused before custody dispatch; historical success is a counterexample, not a passing baseline |
| E2–E4 | Two requests that each fit but jointly exceed hourly/monthly per-asset caps; burst and boundary cases; one asynchronously settling swap; monthly cases inside one UTC calendar month | Combined admitted liability stays within the cap across grants and API instances |
| E5 | Two requests that each fit but jointly exceed daily, weekly or monthly USD budgets, including different input assets | At most one admitted; one shared account budget with no grant-specific allowance multiplication |
| E6 | Same identity and terms retried around timeout/restart, then changed terms under that identity | At most one remote execution and one charge; changed terms refused; observe retention limits |
| E7 | Refusal, partial failure, proven non-execution (including `never_executed` evidence), refund and uncertain outcome | Release only capacity no longer liable; no generic failure or expiry releases possible spend |
| E8 | Tighten assets, recipients or budget while work is queued or held | Defined release-time checks apply; old usage remains; no obsolete permission becomes executable |
| E9 | Revoke/freeze at each dispatch boundary | No new irreversible execution after the specified cutoff; already irreversible work identified |
| E10 | Shield and unshield under the actual non-empty destination policy (shield passed 2026-10-13, see FUNDED-TESTS.md; unshield not yet run) | Same-wallet movement and documented USD exemption; record asset/counter behavior separately |
| E11 | Fail before and after reservation, dispatch commit, remote acceptance and settlement recording | No lost liability, unauthorized dispatch, or duplicate execution; unknown outcomes remain accounted |
| E12 | Delay work across each window edge; change clocks or simulate restart | Behavior matches explicit timestamps/window semantics; pending liability cannot disappear early |
| E13 | Missing/stale prices, extreme raw amounts, decimal edges, fees and settlement differences | Exact conservative charge; no unreserved excess debit or round-down escape |
| E14 | Reviewed artifact construction and controlled artifact-mismatch test | Actual signed debit, assets, recipient and route are bound to admitted terms or the coordinator trust assumption is explicit |
| E15 | Restore older accounting state or introduce a previously unknown external operation | Admission fails closed until authoritative reconciliation; rollback does not silently replenish capacity |
| P1 | Verify operation-proof opening, event hash, inclusion, checkpoint, attestation and accepted measurement | Establish exactly the recorded event; separately prove completeness, consistency and accounting if claiming them |

Run each concurrency case from one grant and from distinct grants/hosts. Ensure sufficient test balance
and a valid route so an unrelated balance or minimum-trade refusal cannot masquerade as a cap pass.
For an illustrative cap of 10 units and requests of 6 units each, at most one may be admitted. Repeat
after a busy-wallet response and around settlement: transient serialization alone is not the claim.
For source or model tests, simulate crashes and adversarial schedules without real funds. Infrastructure
fault injection and artifact substitution against a provider require a provider-controlled test setup.

## Live test preparation

The phase 1 manifest is [FUNDED-TESTS.md](FUNDED-TESTS.md). Before seeking approval, prepare a concrete manifest naming the isolated agent and wallet, allowed
assets, exact raw amounts, policy and grant revisions, maximum number of irreversible requests, total
funding/loss ceiling, network fees, route minimums, expected outcomes and stop conditions. No production
treasury or payout agent is a test fixture. No live tests are authorized by this protocol alone.

Avoid claiming safety from the policy being tested when sizing the test balance: bound the funds
available even if that policy fails. Disable automation on the isolated agent. Complete pagination of
grants and open work; record the effective policy and usage before each case. Scope tests requiring
owner signatures and policy cooldowns explicitly. A 30-day boundary cannot be inferred from a short
wall-clock run; it needs a controlled clock in the implementation/model plus integration evidence.

Stop on any unexpected admission, unidentified operation, ambiguous outcome, missing evidence or
budget/balance discrepancy. Poll and reconcile the same operation; do not generate a new key to try
again. Do not reuse funds expected from an unresolved refund. Preserve the original evidence and
record any operator intervention. A failed safety case blocks the stronger claim.

## Evidence per case

Record the case ID, environment/build identity, policy signature and revision, grant IDs (never tokens),
immutable requests, operation identities, authoritative timestamps, usage/balances before and after,
responses, status history, provider request IDs, execution evidence and any proof verification result.
Compare actual debits against admitted amounts; a request log alone is insufficient. Redact credentials
and protect confidential policy/treasury data without discarding the private evidence needed to review it.

A refusal needs attribution. `spend_budget_exceeded` demonstrates a USD-budget refusal;
`policy_denied` alone does not identify a monthly-cap refusal. For the monthly case, isolate the monthly
limit from every other possible refusal: per-transaction, hourly and daily caps and the USD budget set
above the test amounts, sufficient balance, the action and assets allowed, and no outstanding usage. Use
one settled spend, then a request that crosses only the monthly cap, inside one UTC calendar month.
Record the effective policy and usage before and after. Lack of a history row alone does not prove
nothing reached custody.

## Release decision

Publish each obligation as established, conditional on a named trusted component, or unresolved, with
supporting evidence. Separate bounded-model results from a general preservation argument and from
the deployed implementation correspondence. Do not promote an operation's `PROVEN` audit status into
a claim that the spending envelope is proven. Any unresolved obligation keeps the current narrower
release claim.
