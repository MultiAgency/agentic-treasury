# Architecture

Two prototypes share one core. Each agent runs in its own instance of the server (`src/server.ts`),
with its own wallet, grant, money lock and logs; the hosted gateway signs members in and forwards
their calls to those instances. Files are listed under `src/` unless a path says otherwise.

## The one rule

**One send site.** Every money action, whichever prototype starts it, goes through `dispatch` in
`agent.ts`: under the money lock, with no unresolved operation, a write-ahead record, `authorize`, then
the provider call. `test/send-path.test.ts` fails if any other file sends. The callers are
`invoices.ts` (an invoice's payment), `treasury.ts` and `plans.ts` (shields, swaps, sweeps) and
`agent.ts`'s own `pay` (a payment by hand).

## Shared core

| Concern | Files |
|---|---|
| Sending | `agent.ts` (dispatch), `authorize.ts` (checks the provider can't make; pure), `lock.ts`, `executor-lease.ts` |
| Records | `ops.ts` (the operation journal), `recover.ts`, `reconcile.ts`, `synced.ts`, `evidence.ts`, `inbox.ts` |
| The owner's rules | `policy.ts`, `mandate.ts` (the digest), `grants.ts`, `owner-intents.ts`, `owner-requests.ts`, `owner.ts`, `dao-owner.ts`, `nep413.ts`, `chain.ts` |
| Provider and values | `api.ts`, `holdings.ts`, `value.ts`, `ledger.ts` |
| Serving | `server.ts`, `router.ts`, `http.ts`, `signin.ts`, `env.ts`, `notify.ts` |

## Confidential Treasury Facilitator (the payout agent)

| Concern | Files |
|---|---|
| Intake | `invoice-http.ts` (the public invoice page, `/internal/agreements`), `agreements.ts` (requests, offers, terms), `invoices-server.ts` |
| Payments | `invoices.ts` (files an invoice through dispatch), `invoice-store.ts` (SQLite: identity, revisions, reservations), `payouts.ts` (held payouts) |
| Approval | `payment-approval.ts` (checks a held payout against provider evidence before the owner signs) |

## Agentic Treasury Management (the treasury agent)

| Concern | Files |
|---|---|
| Planning | `treasury.ts` (rebalance legs, quotes, sweep), `plans.ts` (saved, expiring plans executed once), `strategy.ts`, `strategy-digest.ts` |
| Running alone | `autopilot.ts` (the scheduled tick: sweep, then rebalance within its limit) |
| Experimental | `llm.ts` (the steward, reached only at `/steward`) |

## Around them

- **Gateway** (`gateway/`): member sign-in from the DAO's roles (`roles.ts`), which calls each role may
  make (`allowlist.ts`), and, for members, proposal decoding for "What am I voting on?" (`proposals.ts`, `sign-requests.ts`).
- **Web** (`web/src/`): one app for both prototypes. `lib.ts` `kindOf` picks the prototype from the
  agent's policy; `beats.ts` holds each prototype's claims and how each is known; `showcase.tsx` shows
  them.
- **Command line**: `create-agent.ts`, `issue-grant.ts`, `revoke-grant.ts`, `update-policy.ts`,
  `archive.ts`, `inspect.ts`, `books.ts`, `smoke.ts`, `run-report.ts`, `report.ts`, `remote.ts`.

Files stay in one folder for now; moving them into these groups is a separate change, made in a quiet
window, since it touches nearly every import.

## How the money path stays safe on one host

The provider enforces the signed policy; what that guarantees is in [enforcement](enforcement.md). This
is what the server adds around it.

### Sends, journal and recovery

New money actions recheck lock ownership and unresolved operations after
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

### Checks before each send

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

### Invoice storage

Anyone signs in with a full-access NEAR wallet key and files an amount and optional note for their
own account. An agreed payee's filing is an invoice; anyone else's is an agreement request, stored apart
from payments (`.agreements/`, `src/agreements.ts`) and never sent. Sign-in uses near-connect's wallet list pinned to one reviewed
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
