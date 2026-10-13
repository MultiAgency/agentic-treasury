# Signed spending envelope verification plan

The target is a conditional safety guarantee: an agent submitting arbitrary requests cannot cause an
execution outside the owner's signed spending policy, assuming the identified enforcement and custody
components remain correct. The current implementation does not establish this guarantee. The
[enforcement assessment](enforcement.md) records what works today; this specification defines what must
be established before strengthening that claim.

This is a proposed verification contract, not a new provider protocol or a deployed accounting engine.
Provider-dependent semantics below remain unresolved until supported by evidence. Spending limits bound
turnover, not holdings, allocation drift, or market-value exposure. Confidentiality and scheduler
reliability are separate claims.

## Threat model

The agent may submit arbitrary operations, use every credential available to it, run concurrent copies
on different hosts, retry after timeouts, and bypass the planner and application authorization code.
Requests and responses may be delayed, reordered, duplicated or lost. Processes may crash at any point.
Policy changes and grant revocations may race with pending work.

The owner and its signing authority are trusted to authorize the intended policy. An owner who signs a
wider policy changes the agreement; that is not an agent bypass. The agent must not possess the owner's
signing authority or be able to cause an unreviewed signature. Review CLI owner-key access separately
from the hosted DAO deployment.

The Agent API, OutLayer coordinator, custody keystore, relevant contracts and valuation source are
trusted unless a specific obligation below removes that dependency. In particular, cumulative usage
and swap-artifact correctness currently depend on the coordinator. A TEE policy check does not remove
trust in the data or transaction artifact supplied to it. No claim here tolerates a malicious custody
provider, compromised owner, or arbitrary database rollback.

The implementation continues to use the NEAR Intents Agent API and OutLayer. Verification covers
their enforcement and the existing executor; a separate custody contract, enforcement service or
local budget engine is outside this plan.

## Agreement and operation identity

The agreement must bind the owner, agent, custody wallet, network/domain, policy revision, complete
policy, schema/canonicalization version and accounting semantics. Signature verification must connect
those terms to the bytes actually signed and to the policy actually enforced. A preview, local digest,
or API `APPLIED` response alone is insufficient independent evidence of that connection.

Existing API fields remain unchanged until its binding format is established. `mandateDigest` is a
local audit identifier, not an independently verified owner commitment. Its set normalization is a
project-specific preprocessing step; a verifier must reproduce it before hashing canonical JSON.

Each admitted operation needs immutable terms, a wallet-scoped identity, the authorizing policy
revision, applicable grant, charge vector, and durable lifecycle. Terms include action, input/output
assets, amount, recipient, confidentiality and any output floor. Reusing an identity with different
terms must fail. A new identity is new work and consumes new capacity.

## Accounting rules to resolve

| Subject | Required rule | Current evidence or open decision |
|---|---|---|
| Assets | Both assets of every swap must be allowed | Input checked in pinned policy engine; output check is local; historical direct-API counterexample |
| Per-asset amount | Define gross charged amount, including relevant fees and refunds | Do not infer it from display amounts or swap output |
| Per-asset windows | Specify timestamps, inclusive/exclusive edges and duration | Pinned OutLayer tests describe UTC calendar periods; the API reference says rolling; deployed semantics remain to be established |
| USD windows | Rolling 24 h, 7 d and 30 d | Documented in the public API; mechanism and edge cases unverified |
| USD valuation | Specify authoritative quote, timestamp, decimals, exact rounding and fee treatment | API documents fresh quote pricing; local floating-point `usdIn` is not authoritative accounting |
| Shield and unshield | Define per-asset and action-count treatment independently of USD treatment | Documented as USD-exempt; same-wallet restriction and destination compatibility need evidence |
| Queued and held work | Reserve capacity or perform a fresh atomic admission before release | Never let a previously checked operation execute later without one of those protections |
| Unknown outcome | Preserve its possible liability; never release solely on timeout or generic `FAILED` | Provider documents certain non-execution flags; their finality and replay behavior need evidence |
| Window expiry | State whether charging occurs at admission, dispatch or execution | If dispatch-time charged, delayed work must be re-admitted then; old reservations cannot authorize fresh-window spend |
| Policy reduction | Keep usage and unresolved liabilities; reject new work that no longer fits | Existing spend may already exceed a newly lowered cap; do not call that a new overspend |
| Grant revocation | Define the last cancellable point and revalidation before it | Already irreversible work cannot be recalled by changing a policy |
| Deposits | Distinguish outside credits from spending existing treasury funds | API explicitly documents no treasury spend; conversion-target restrictions remain an acquisition-policy question |

For the spending guarantee, unsolicited external credits are outside the agent's spending authority.
They do not imply that every token held is allowed. Deliberate deposit conversion must receive an
explicit scope decision before claiming an acquisition or holdings restriction.

## Safety obligations

For every capped dimension `d` (asset/window or USD/window), admission at time `t` under policy `P`
requires:

```text
charged(d, t) + outstanding(d, t) + proposed(d, operation) <= limit(P, d)
```

`charged` and `outstanding` are disjoint: settlement must replace a reservation, not double-count it
or create a gap. Unresolved liabilities remain represented according to the declared window semantics.
An operation's final debit cannot exceed its reserved bound; otherwise it needs further atomic
admission before the extra debit becomes irreversible. Use integer raw units and specified decimal
USD arithmetic, not binary floating point.

The proof must establish all of these properties:

1. **Signed authority:** the enforced policy is the policy the owner signed for this wallet and domain.
2. **Complete mediation:** every route that can debit the wallet passes through enforcement, including
   other grants, hosts, approval release, recovery, withdrawal and any general signing capability.
3. **Atomic admission:** concurrent requests cannot spend the same capacity. Policy validation,
   reservation and durable operation creation share one serialization boundary.
4. **Execution binding:** the signed/submitted artifact implements the admitted terms, and its actual
   debit fits the reserved bound. A correct check on a different operation is insufficient.
5. **Durable conservation:** settlement, refunds, crashes, retries, migrations and policy changes never
   erase a possible charge. Startup requires authoritative initial usage and pending-work reconciliation.
6. **Bounded replay:** one admitted operation cannot produce multiple executions. Remote deduplication
   needs established scope and retention; otherwise an ambiguous submission is poll-only.
7. **Fresh authority:** policy changes and revocations are ordered relative to admission and the last
   irreversible dispatch point. Held work cannot silently retain obsolete authority.

A suitable abstract lifecycle is `proposed → reserved → submission_attempted → settled`, with
`unknown` retaining liability and `proven_nonexecution` releasing it. This is a specification, not the
current journal's state machine. The transition to `submission_attempted` precedes network I/O, so a
crash before an actual send can conservatively retain a reservation. No local transaction makes a
remote payment exactly once.

The initial state, each transition, and each external assumption need a preservation argument. A
bounded model checker can find counterexamples but does not by itself prove all production traces.
Implementation review must connect the model's atomic steps to actual transactions, locks and remote
guarantees. Audit-event inclusion alone does not prove completeness, correct admission or conservation.

## Delivery sequence and decision gates

Current findings are maintained in the [enforcement assessment](enforcement.md).

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 1. Specify | This contract, with accounting questions resolved | Each rule and trust assumption is explicit; owner intent maps to signed bytes |
| 2. Verify provider | [Evidence record](envelope/VERIFICATION.md), public source, deployment evidence and isolated tests | Deployed mechanisms and versions support each obligation, or gaps are explicitly accepted |
| 3. Verify execution routes | Credential-path inventory for the existing Agent API and OutLayer integration | Establish which rules cover every route available to the agent |
| 4. Address confirmed gaps | Targeted integration fixes or provider fixes supported by evidence | Reviewed implementation preserves all applicable obligations |
| 5. Verify | Model, implementation review, offline and isolated integration results | Counterexamples resolved; remaining assumptions stated |
| 6. Release | Signed policy evidence, code/build identity, results and exact claim | Independent reviewer can reproduce checks for that deployment |

Keep the provider enforcement boundary and verify it end to end. Missing evidence limits the claim;
it does not establish a need for replacement custody or accounting. Use public documentation, pinned
source, offline tests and authorized isolated experiments to resolve what we can independently.
Provider questions supplement that work when evidence is unavailable.

Do not restore previously removed per-send gates or introduce local budget reservations solely to
compensate for unanswered provider questions. The decision depends on semantics, initial usage,
credential isolation and deployment evidence, not on how many local checks can be added.

## Acceptance and release

The [acceptance protocol](envelope/ACCEPTANCE.md) extends the existing A/B/C/G/E tests.
Record offline logic, public source inspection, provider statements, live observations and deployed
attestation as different evidence classes. Neither a successful demo nor an attested log event closes
all seven obligations.

The functional demonstration remains balances → quoted plan → swaps → budget decrements, a separately
attributed monthly-cap refusal, and a shield under the actual policy. Scheduler uptime and privacy
observations are reported separately.

**Proposed scope change, pending acceptance:** payouts are confidential transfers, which move funds
between confidential balances with no unshield, and the treasury keeps no public reserve. This replaces
the original "unshield exactly what a payout needs" requirement. Exact-shortfall unshielding is not
implemented. It is not universally unnecessary: the provider documents that a confidential transfer's
recipient must have confidential intents enabled, so a payee without it would need an explicit public
payout, built then and bound to that payout's approved terms. Recipient compatibility needs explicit
handling before a payout is approved.
