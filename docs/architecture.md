# Architecture

Two areas, Payables and Treasury, share one core. Each agent runs in its own instance of the server (`src/server.ts`),
with its own wallet, grant, money lock and logs; the hosted gateway signs members in and forwards
their calls to those instances. Files are listed under `src/` unless a path says otherwise.

## The one rule

**One send site.** Every money action, whichever area starts it, goes through `dispatch` in
`agent.ts`: under the money lock, with no unresolved operation, a write-ahead record, `authorize`, then
the provider call. `test/send-path.test.ts` fails if any other file sends. The callers are
`invoices.ts` (an invoice's payment), `treasury.ts` and `plans.ts` (shields, swaps, sweeps) and
`agent.ts`'s own `pay` (a payment by hand).

## Shared core

`src/router.ts` composes `rpc/owner.ts`, `rpc/payables.ts`, `rpc/treasury.ts` and
`rpc/observations.ts`. Shared transport error handling lives in `rpc/base.ts`; shared input schemas
live in `rpc/inputs.ts`. This extraction retains procedure paths, gateway access classifications and
existing domain calls. Submission remains centralized in dispatch.

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
| Intake | `invoice-http.ts` (public routes, `/internal/agreements`), `invoice-page.ts` (HTML and copy), `invoice-browser.js` (checked browser module), `agreements.ts` (requests, offers, terms), `invoices-server.ts` |
| Payments | `invoices.ts` (files an invoice through dispatch), `invoice-store.ts` (SQLite: identity, revisions, reservations), `payouts.ts` (held payouts) |
| Approval | `payment-approval.ts` (checks a held payout against provider evidence before the owner signs) |

## Agentic Treasury Management (the treasury agent)

| Concern | Files |
|---|---|
| Planning | `treasury.ts` (rebalance legs, quotes, sweep), `planning/` (plan model, checks, storage, observations and execution; `plans.ts` retains compatibility exports), `strategy.ts`, `strategy-digest.ts` |
| Running alone | `autopilot.ts` (the scheduled tick: sweep, then rebalance within its limit) |
| Experimental | `llm.ts` (the steward, reached only at `/steward`) |

## Around them

- **Gateway** (`gateway/`): sign-in decided per agent from its owner (`roles.ts`): a DAO's roles, or the
  owner account itself; which calls each role may
  make (`allowlist.ts`), and, for members, proposal decoding for "What am I voting on?" (`proposals.ts`, `sign-requests.ts`).
- **Web** (`web/src/`): one app for both areas. `format.ts` `kindOf` uses the configured area, with a policy-based fallback for legacy instances; `beats.ts` holds each area's briefs, requirements and stages; `showcase.tsx` shows
  them. `timeline-payment.tsx` and `timeline-run.tsx` follow one held payment or the latest autopilot
  run step by step, each step read from its own record; they show data only on the instance that holds
  those records (approvals filed there, evidence its executor wrote).
- **Command line**: `create-agent.ts`, `issue-grant.ts`, `revoke-grant.ts`, `update-policy.ts`,
  `archive.ts`, `inspect.ts`, `books.ts`, `smoke.ts`, `run-report.ts`, `report.ts`, `remote.ts`.

Planning is grouped under `src/planning/`: `model.ts` defines the saved contract, `checks.ts` is pure,
`store.ts` preserves the existing `.plans/` format and claims, `observation.ts` reads current facts,
and `execution.ts` coordinates execution. Treasury previews import storage and observations directly,
so planning and execution no longer form a runtime import cycle. `src/plans.ts` keeps existing imports
compatible. The source digest changes with this extraction; state paths, saved plan digests and the
single send site do not. Existing execution/recovery tests and `test/planning-boundaries.test.ts`
cover this locally; it does not establish new mainnet behavior.
Other domain-wide file moves remain separate changes because they touch nearly every import.

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
A browser wallet's signature is relayed only if it is the owner's key, as the API names it, over exactly
the prepared intent: the NEP-413 message, or a NEP-366 delegate action from the owner's account calling
exactly the prepared methods, arguments, gas and deposits (`src/owner-signature.ts`). The wallet's own
code loads from outside this repo, so this doesn't rest on the API's check. Offline-tested, and passed
by a browser wallet's delegate action and message signature on mainnet (2026-10-13, mainnet log); a
tampered signature hasn't been seen live. A wallet that adds a `callbackUrl` to a NEP-413 signature is
refused, safe but possibly too strict for some wallets. A DAO's signature is found on chain and
verified against the prepared hash (`findSignature` in `src/dao-owner.ts`) before it is submitted.
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
final read, so the provider's own enforcement stays the boundary. The local authorization path does
not reject a policy merely because it has a provider timelock, and it does not inspect the provider's
scheduled-execution queue. Provider release-time checks remain unverified; no local hold on all
delayed execution is claimed.

### Invoice storage

Anyone signs in with a full-access NEAR wallet key and files an amount and optional note for their
own account. An agreed payee's filing is an invoice; anyone else's is an agreement request, stored apart
from payments (`.agreements/`, `src/agreements.ts`) and never sent. Sign-in uses near-connect's wallet list pinned to one reviewed
commit (`WALLET_MANIFEST` in `src/invoice-page.ts`). Residual supply-chain risk: each wallet's code
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
occurrence; there is no semantic duplicate-invoice detector. Payments shows invoice revisions, operation IDs
and reserved amounts. Operators may cancel a payment only when its durable state proves submission
never began. A held/unknown payment retains its reservation until a proven terminal outcome. These
reservations are records of encumbrances, not yet a full available-cash or liquidity-control engine.

Before upgrading an existing payout executor, follow the
[invoice migration instructions](operations.md#invoice-migration-and-deployment).

SQLite provides local atomicity, not exactly-once remote payment execution. These paths are covered
by offline concurrency, HTTP authorization and process-crash tests, and the flow ran on mainnet on
2026-10-12 ([mainnet log](mainnet-log.md)).

## Frontend responsibilities (offline-tested)

Frontend infrastructure is separated into `client.ts`, `queries.ts`, `format.ts` and `action-hooks.ts`;
`lib.ts` retains compatibility exports. Query factories accept an explicit client and cache scope.
Local agent documents keep their existing keys; Home keeps its fleet namespace. Agent switching
still loads a new document. `workspace-observations.ts` owns fleet observations, `proposals.tsx`
presents proposals, and `attention.ts` supplies shared agreement and grant destinations. Each status
badge requires only its own observations; failed attention sources remain explicit alongside known items.

`agent-context.ts` has no shell dependency. Payment details, retained Activity and run records have
recovery views while setup or overview is loading or has failed. Treasury-link reads are limited to pages using them and
do not gate the shell. The private `instance` read returns configured identity and executor mode
without provider calls. Combined with gateway permissions, it exposes schedule stopping during
provider failures; the server still refuses members and approve-only instances. Offline fixtures in
`test/browser/task-loading.cjs` reproduce failed and indefinitely pending setup, overview and treasury-link reads.

`read-failure.tsx` distinguishes failed initial reads from failed refreshes. Activity and shared
workspace history retain previously loaded records with their read time; empty cached lists never
establish a current absence during failure. The payment recovery view labels cached outcomes as
last reported, and unavailable unresolved-operation reads retain references without recovery controls.
Schedule recovery explains operator and executor restrictions. `test/browser/failure-states.cjs`
checks retained records, open evidence, explicit retries and permission explanations offline.

The Policy page separates policy and current-grant observations from allowed actions, owner controls
and revision evidence. `policy-observations.tsx` presents the server's policy check without combining
it with grant liveness into authorization. Approve-only instances do not claim to hold a grant token.
Missing revision evidence stays explicit in `policy-evidence.tsx`; grant controls retain their existing
signing behavior. `test/browser/policy-clarity.cjs` checks these presentation boundaries offline.

`setup-progress.tsx` reads recorded owner actions before onboarding offers agent creation. An unfinished
creation, a succeeded creation awaiting setup readback, or unavailable records keeps that button
disabled. Its refresh reads setup and owner records without signing or submitting. Returning owners
without a reported grant first see unfinished setup actions, then a policy, Payables grant or Strategy
destination based on available observations. Records cover this instance only; funding requests made
through wallets or Trezu still need review there. `test/browser/onboarding-clarity.cjs` checks these
paths on mobile and desktop with offline fixtures.

Owner action preparation exposes its correlation ID and a durable Activity link. Component-owned
status observation in `owner-observation.ts` stops on unmount; server recovery remains independent.
Returning to Activity reads durable records. Approval success is displayed separately from payment
settlement, and missing evidence retains existing retry restrictions.

`main.tsx` lazy-loads the authenticated application and fictional example workspace at their entry
decisions. Public illustrations use the canonical summaries without mounting authenticated reads.
The production build places these applications in asynchronous chunks; this is a bundle-boundary
check, not a measured startup improvement or deployed observation.


The hosted signed-in frontend shares one desktop navigation rail and a mobile navigation drawer across Home, Payables,
Treasury and Activity (`web/src/app/workspace.tsx`). The gateway's accessible-agent list determines
which areas appear; permissions remain agent-scoped. Area navigation loads the existing `/a/<agent>/`
URL as a new document, preserving the existing client/cache isolation and draft unload warnings.
The shared Home shows independent attention checks, agreement requests and compact status;
Activity groups recent money and owner records by agent with an area filter. Neither view aggregates
balances or authorizes actions. Failed reads remain explicit and one failed agent does not hide another.
Area task names come from `web/src/app/navigation.ts`: Payments for Payables, Portfolio, Strategy and Runs
for Treasury, plus funding, policy/grants and Activity. URLs remain unchanged. Compact payment rows
link to the existing detail route; only the selected record mounts live payment-status reads and
approval controls. Home attention items link to that same identity.
The standalone local-agent layout and signed-out example routes remain separate.
`test/browser/workspace.cjs` checks navigation, recovery access, filtering and absence of mutation
calls at 320px, 390px and 1280px with intercepted requests. This is local, offline-tested behavior;
the shared workspace has not been verified on a deployed host.

The workspace attention summary owns fleet reads once; incomplete checks and retry controls appear
there without repeating them in the compact status section. Treasury grant warnings link directly to
Strategy; an unknown area retains the Policy destination. Activity describes recorded operations,
including refusals, without implying every record was submitted. Invoice administration is on Payments;
Activity retains a link to it and loads Books only when “Compare balances with records” is opened.
When setup confirms an executor operator, an unrelated overview failure leaves the existing schedule
stop control accessible alongside Activity recovery. These presentation boundaries are checked with
intercepted requests in `test/browser/decision-clarity.cjs`; no deployed behavior is inferred.

The invoice listener serves the page and its browser module from the same origin. The browser
module owns drafts, refresh ordering and DOM updates; TypeScript checks its JSDoc types during
`pnpm typecheck`. It is served as JavaScript without another build step. The browser regression
loads the complete page renderer and module with mocked API and wallet responses; the HTTP test
checks that the listener serves both resources. Neither test extracts functions from source comments.
Sign-out clears private rows, invalidates outstanding status reads, stops polling, and restores
keyboard focus to sign-in (`test/browser/invoice-focus.cjs`, offline). The synthetic payee journey
checks request, agreement, invoice and outcome presentation at mobile and desktop widths
(`test/browser/invoice-journey.cjs`); owner decisions there are fixture transitions, not real signatures.

The Treasury strategy UI derives labels and control permissions in `web/src/features/portfolio/strategy-presentation.ts`.
This is presentation only; server controls and dispatch still recheck authorization. Query refreshes
can name affected reads for local changes, or skip shared invalidation for plan previews.
Money execution and recovery retain broad invalidation. These behaviors are tested offline in
`test/strategy-presentation.test.ts`, `test/query-refresh.test.ts` and the browser suites.

Invoice session isolation is offline browser-tested: account changes clear rendered records and
polling, and pending reads or submissions from the previous session cannot update the new account's
form or lists. Saved drafts remain scoped by account. This does not cancel a submission already
accepted by the server.

### Stable area identity and payment discovery

An optional `area` in gateway configuration (`payables` or `treasury`) supplies `DASHBOARD_AREA` to
that child process and appears in gateway metadata. It controls presentation only; policy, grant and
role checks still govern actions. Standalone or externally started agent servers can set
`DASHBOARD_AREA` explicitly. Legacy instances without it keep policy-based area inference. The
workspace labels configured areas without fetching their balances. Disabling swaps leaves the
Treasury area's navigation and recorded runs accessible, while swap previews remain unavailable.
This is offline-tested in `test/area-config.test.ts` and `test/browser/area-identity.cjs`.

`web/src/features/payables/payment-records.ts` joins retained local transfers, provider history, held observations and
owner records for display. A failed or incomplete provider history read cannot hide a transfer already
present in local activity. Identity-only observations preserve previously known terms. Display memory
is scoped to the agent and document; it is neither durable evidence nor authorization. Queue rows do
not start individual status polls; the selected payment does. Approval state and settlement are still
read separately, and source errors/incomplete history remain visible. Unit tests and the local-history
browser regression cover this behavior; no deployed observation is claimed.

### Reads with local effects

Some existing read handlers also maintain local recovery state: `setup` may adopt a staged grant,
`held` may record a terminal provider observation, and invoice status refreshes may update the invoice
record and reservation. The executor also reconciles independently of the dashboard. These effects
are intentionally retained; consolidating presentation queries does not remove their recovery role.
A future separation must preserve restart and approve-only behavior, not merely rename endpoints.

### Agreement responses and deposit evidence (offline-tested)

The remote agreement store validates successful responses: agreement lists and terms, a nonempty
offer ID, and an explicit acknowledgment for proposing or declining. Malformed responses leave the
result unconfirmed; the client does not retry a mutation that may already have been applied.
Valid server error messages and the existing request timeout are retained. The regression fixtures
are in `test/agreement-responses.test.ts`; the local agreement record format is unchanged.

Ledger deposit lookups validate receipt structure and transfer events before selecting an asset.
Malformed evidence makes the ledger read unavailable with a sanitized error, including when a valid
transfer precedes a malformed event. Valid receipts with no matching transfer retain a null asset.
Each ledger invocation fetches each distinct deposit transaction hash once, with at most four
concurrent single-hash requests, then resolves each deposit address independently. Failed reads stop
new lookups and drain in-flight requests before rejecting. There is no persistent cache, and each
new read still looks up historical deposits. `test/ledger.test.ts` covers these behaviors offline;
this is not a deployed-provider observation or a measured production performance improvement.

### Workspace task organization (local implementation)

The frontend is grouped into `app/`, `shared/`, `features/` and `public/` under `web/src`.
`app/shell.tsx` composes navigation without waiting for provider reads; the agent task boundary retains
onboarding and independent recovery behavior, including records while setup is pending. Task query
factories compose through `shared/queries.ts`, preserving the existing agent and fleet cache keys.
Home skips agreement-request reads for known Treasury areas; it retains held, unresolved, inbox and
schedule observations because Treasury can transfer and Payables may retain a legacy schedule.

The desktop rail nests task destinations in the current area. Mobile uses a native modal navigation
drawer with Escape, focus restoration and a visible current-page label. Same-agent task links use the
router; switching agents loads a new document. Existing payment/run URLs and legacy anchors remain.
Payments contains secondary manual payment creation and invoice administration. Agreements concerns
terms and policy inclusion. Strategy separates saved configuration, owner authorization, schedule and
manual rebalance; sweep belongs to Balances & funding, with a link from the old automation anchor.
Activity links to invoice administration and retains operation, owner-action, recovery and books views.

Payment discovery and selected-payment observations are separate hooks. Normal review and recovery
share status polling and a display that distinguishes owner decision from payment outcome. Only a
selected payment polls its provider status. Pure stage derivation never reconstructs approval evidence
from settlement. Confirmation controls live with owner actions, separate from generic UI primitives.
Public examples share only data-free task vocabulary with the workspace. They retain fictional state
and cannot import authenticated observation or action modules.

These changes require no RPC or state-format migration. They are local frontend changes, not a new
mainnet observation or provider-enforcement claim. Offline validation includes feature-boundary and
payment-stage tests plus the workspace, payment, recovery, strategy and public browser fixtures.
