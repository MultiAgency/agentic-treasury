# The money path

How this server keeps money actions safe on one host: the single send site, the journal, reconciliation,
owner intents, invoice storage, and the checks made before each send. The provider enforces the signed
policy; what it guarantees is in the [enforcement assessment](enforcement.md).

## Sends, journal and recovery

Live refusal probes are disabled by default and in the dashboard. Use offline adversarial tests and
recorded mainnet evidence for routine demonstrations. `pnpm refusals --live` explicitly opts into
real requests that can move funds; never schedule them. An unknown outcome stops the probes and
requires reconciliation. New money actions recheck lock ownership and unresolved operations after
preflight. This closes the reproduced preflight lock-loss scenario; ownership loss during an
in-flight send remains a single-host residual risk, not a distributed fencing guarantee.

Owner intents persist `prepared → submitted → settled` in a private per-instance file. Updates take
an inter-process lock and reload the file before modification, so concurrent preparation and settlement
preserve each other's records. `submitted` means submission was attempted, not proven accepted.
Approval signatures are poll-only after an attempt. For other owner actions, the existing recovery
flow can resend the saved signature only while the API reports `PENDING_SIGNATURE` and the signing
window remains open. Settled results remain available after restart. Records deleted by older versions
cannot be reconstructed locally. This is single-host coordination, not distributed fencing.

The agent's executor runs status-only reconciliation every 10 seconds (an `EXECUTOR=off` instance doesn't), independently of strategy execution.
`pnpm reconcile --poll` performs one pass. Unknown IDs, failed reads, `UNCERTAIN`, and `NEEDS_REVIEW`
remain unresolved. Nothing is resent: provider deduplication and lookup semantics remain unverified.

Plans simulate cumulative swaps and shields using guaranteed output floors, then recheck remaining
feasibility between legs. Policy, strategy digest, cost ceiling, and expiry are checked after
asynchronous preflight before each send, including a swap following an automatic shield.
These recovery and execution checks are offline fault-tested; they are not mainnet-validated.

New non-invoice operations use journal v2: a durable preparation followed by a durable submission
claim before the provider call. On the next money-lock acquisition, an unclaimed preparation is
resolved as `never_submitted`. Claimed operations without an outcome and ambiguous legacy records
remain blocked. Invoice preparation keeps its existing SQLite lifecycle. Before upgrading, follow the
[stopped-writer migration](operations.md#journal-v2-and-owner-intent-locking-upgrade).

## Execution checks

Every money submission (invoice, dashboard, CLI, autopilot) goes through one dispatch: under the
money lock, with no earlier operation of unknown outcome, written ahead to the log before it is sent.
Policy enforcement is delegated to the Agent API and OutLayer, with the evidence and limitations
listed in the [enforcement assessment](enforcement.md). Provider refusals are recorded.
Dispatch also refuses locally, recording why, what the provider can't see or check
(`src/authorize.ts`): a policy that is frozen, unapplied or unsynchronized; no live grant; a grant for
another purpose (the autopilot's must carry its strategy's digest); a swap into an asset the policy
doesn't list (the provider checks only the asset spent); a payout that isn't a confidential USDC
transfer, repeats one already held, or that the wallet can't cover (the provider would hold it for a
vote and fail it after); an invoice under a policy that doesn't hold it for the owner;
and a plan's send once its plan, strategy or policy changed, or its swap costs more than the strategy allows. Status reconciliation uses no grant and can discover settlement after revocation.

A held, never-submitted invoice retains its key, can be revalidated by submitting
the original form, and never blocks other money actions; an attempted submission whose outcome is
unknown still does. Changed invoice content requires review.

Owner approval is verified from the provider's own evidence, so any instance of the agent can
approve, including an approve-only one (`EXECUTOR=off`) that never saw the payment sent. The
approval and the held execution must name each other and this agent's wallet; the approval must be
a confidential transfer whose `{to, token, amount}` hash to the provider's `request_hash` (the wallet
provider's canonical operation), to a payee, asset and amount within the applied policy (destinations,
assets, per-transaction cap, owner approval on). If this instance recorded the payment, it must match
that record and any invoice behind it must be unrevised. Incomplete or unsupported provider terms are
refused, never trusted. Preparation binds the approval ID, request hash, correlation ID, policy digest
and invoice revision; the checks run again immediately before submitting a wallet or DAO signature, and
a changed term or policy invalidates the approval. Approving needs the owner's signature, not this
instance's grant. Rejection needs only the identity checks. An attempted approval signature is
poll-only after restart or an ambiguous response, never automatically resubmitted.

These checks trust the Agent API's identity, policy and balance responses; their local observation
age is not an independent proof of chain-state freshness. A policy or revocation can change after the
final read, so the provider's own enforcement stays the boundary. Provider timelocks and schedules are
held because their release-time checks have not been established.

## Invoices

Contractors sign in with a full-access NEAR wallet key and file an amount and optional note for their
own account. Only agreed payees can submit. Sign-in uses near-connect's wallet list pinned to one reviewed
commit (`WALLET_MANIFEST` in `src/invoice-http.ts`). Residual supply-chain risk: each wallet's code
still loads from the URL that list names, mostly `raw.githubusercontent.com`, which its maintainers
can change; the page also allows inline and `https:` scripts because wallets run as inline code in
sandboxed frames that inherit its policy. Wallets can't read the session, and every signature is
verified server-side, so the remaining risk is a wallet that phishes for keys. The provider payout policy must still require owner
approval and confidential transfers. Invoice and dashboard commands share the same execution path.

Before a payment can be sent, `.invoices/<agent>.sqlite` atomically stores the submission identity,
initial revision, exact payment request, stable idempotency key and reservation. A second transaction
marks submission attempted before network I/O. A crash after that point is ambiguous even when the
network call may never have started. Missing correlation IDs, failed reads and uncertain outcomes
never authorize another send. Reconciliation polls known operation IDs and never resends: **ambiguous
replay is not possible**.

Retries of the same form retain the same payment identity. Changed amount/note contents are retained
as revisions requiring review; they never modify an existing payment or create a second attempt.
The browser retains its pending form ID across reloads. A genuinely new form is a new business
occurrence; there is no semantic duplicate-invoice detector. Activity shows revisions, operation IDs
and reserved amounts. Operators may cancel a payment only when its durable state proves submission
never began. A held/unknown payment retains its reservation until a proven terminal outcome. These
reservations are records of encumbrances, not yet a full available-cash or liquidity-control engine.

Before upgrading an existing payout executor, follow the
[invoice migration instructions](operations.md#invoice-migration-and-deployment).

SQLite provides local atomicity, not exactly-once remote payment execution. These paths are covered
by offline concurrency, HTTP authorization and process-crash tests, and the flow ran on mainnet on
2026-10-12 ([mainnet log](mainnet-log.md)).
