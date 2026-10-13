# Agentic Treasury

An AI agent manages a treasury on [NEAR Intents](https://near.org/intents) through the
[NEAR Intents Agent API](https://api.agentsonintents.com/llms.txt), inside a policy its owner signed.
The owner can be a person's wallet or a Sputnik DAO, such as a [Trezu](https://trezu.org) treasury.

> Runs on NEAR mainnet with real funds. Use a low-value account and small amounts.

## How it works

- The **owner** signs a **policy**: allowed actions, assets, caps, budget, and where funds may go.
- The owner issues a **grant** that lets this server act for the **agent** inside that policy.
- The agent swaps, shields and pays through the Agent API and OutLayer, with application checks and
  provider-enforced limits. Output-asset enforcement is local; strict cumulative per-asset enforcement
  and USD-budget atomicity remain unproven. See the [enforcement assessment](docs/enforcement.md) for
  the evidence and remaining gaps.
- Every policy has a **mandate digest**: sha256 of its canonical JSON (`src/mandate.ts`), which anyone
  holding the policy can recompute. Every plan and every money action records the digest it ran under.
- The **books** compare public balances against the chain's
  `intents.near` transfers (FastNear's Transfers API), confidential ones against the API's recorded
  executions. Differences are unexplained: external credits, incomplete records or observation timing
  can cause them. This is not independent proof of confidential custody. `pnpm books` prints them,
  and `pnpm books --csv` exports the ledger.

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

The dashboard runs status-only reconciliation every 10 seconds, independently of strategy execution.
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
[stopped-writer migration](docs/operations.md#journal-v2-and-owner-intent-locking-upgrade).


## Run it

```sh
pnpm install
cp .env.example .env   # add an API key from https://partners.demo.agentsonintents.com
pnpm demo              # dashboard on http://localhost:8787
```

The dashboard walks you through creating an agent and issuing its grant. Everything is also
available from the command line: see the scripts in `package.json`.

## Hosted demo

Two pages on Railway. Signing in with a NEAR wallet signs a message, never a transaction.

- **Dashboard**, https://proto.multiagency.ai. Signed out, it shows only what the DAO's contract shows
  on chain: its roles and proposals. Members of `agentic.sputnik-dao.near` sign in to see the treasury.
  It is the treasury agent's executor and runs the payout agent approve-only.
- **Invoices**, https://invoices.multiagency.ai, for the payout agent's agreed payees. It is the payout
  agent's executor.

The gateway reads who may sign in from the DAO's own policy, at most a minute old. An account in any DAO
role is a member: it reads everything and may file owner actions as proposals, which do nothing until
the DAO votes. Accounts listed in `operators` (`deploy/dashboard.json`) can also move money and change
settings. Anyone else is refused at sign-in. Only payees in the payout agent's policy can file invoices.

The demo walkthrough is in [DEMO.md](DEMO.md).

Deployment, executor migration and state preservation are documented in the
[operations guide](docs/operations.md#dashboard). Each agent requires one executor host; the local
lease does not enforce that across machines. Other instances use `EXECUTOR=off`.

## Two kinds of agent

- A **treasury agent** swaps between USDC, wNEAR and ETH toward a target, shields anything public,
  and can be steered by an LLM whose responses are verified against its TEE. No vote per action.
- A **payout agent** only transfers USDC, confidentially, to payees the owner agreed to. Every payout
  waits for the owner's approval. Approval verification checks the intended terms against the current
  policy; cumulative enforcement and the final signed artifact retain the provider dependencies
  described in the [enforcement assessment](docs/enforcement.md).

Each instance of the server runs one agent. To run a second beside the first, give it its own
settings file: `ENV_FILE=.env.payout PORT=8790 pnpm server`. It shares the API keys in `.env` but keeps
its own agent, grant and treasury, and each agent has its own action log in `.ops/`. The payout agent's
executor, which also serves the invoice page, starts with `ENV_FILE=.env.payout pnpm invoices`; any other
instance of an agent runs `EXECUTOR=off` ([operations](docs/operations.md#payout-executor)).

## Invoices

The payout executor serves both the private dashboard and public invoice page through the same
grant, money lock and recovery loop. See [payout setup](docs/operations.md#payout-executor).

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
[invoice migration instructions](docs/operations.md#invoice-migration-and-deployment).

SQLite provides local atomicity, not exactly-once remote payment execution. These paths are covered
by offline concurrency, HTTP authorization and process-crash tests, and the flow ran on mainnet on
2026-10-12 (below).

## Execution checks

Every money submission (invoice, dashboard, CLI, autopilot) goes through one dispatch: under the
money lock, with no earlier operation of unknown outcome, written ahead to the log before it is sent.
Policy enforcement is delegated to the Agent API and OutLayer, with the evidence and limitations
listed in the [enforcement assessment](docs/enforcement.md). Provider refusals are recorded.
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

## DAO ownership

A DAO has no keys, but it can sign through NEAR's MPC network. The owner is an account whose only
key is derived from the DAO, so every owner action becomes a DAO proposal calling `v1.signer.sign`.
When the vote passes, the server picks up the signature and submits it. The Agent API needs no
changes. See `src/dao-owner.ts`.

Tested on mainnet with `agentic.sputnik-dao.near`: creating an agent, issuing a grant, changing its
policy and freezing it, each by DAO vote (proposals #9 to #12). The freeze was filed from the
dashboard through Trezu. Later, policy edits and the approvals of two held payouts were filed and
voted the same way from the dashboard; both payouts settled (approvals #17 and #21, edits #20 and #22).

A confidential Trezu treasury funds its agent with a payment from its confidential balance to
`nearcom:<the agent's wallet account>`, which the Treasury page links to. Without the `nearcom:`
prefix, Trezu sends the payment out as a public withdrawal.

## Mainnet results

Payouts from a confidential Trezu treasury (`agentic.sputnik-dao.near`), 2026-10-11. The payout agent
was created, granted and added to the treasury agent's agreement by DAO vote (proposals #23 to #25).

| Check | Result | Evidence |
|---|---|---|
| A payout waits for the DAO | 1 USDC to an agreed payee went `PENDING_APPROVAL`, was released by proposal #26 and settled | `op_ECYZZAMgrNUauo5YnlKdUrwmml8p_TP9yrs93ViY0GI` |
| A new payee is refused | Refused with `policy_destination_denied` before anything was recorded or voted on | treasury agent, 0.01 USDC to an unlisted account |
| Over-limit is refused | Refused with 409 `policy_denied` before anything was recorded or voted on | 11 USDC against a 10 USDC hourly cap |
| Agents fund each other without a vote | The treasury agent sent the payout agent 5 USDC inside its caps | `op_Y5KTotI2PhJPjWdtKN4SXxEGrAuymJrArNhmYYlHzh4` |
| Nothing public but the vote | The payout agent's account has no public transactions; no public NEAR Intents balances changed | NearBlocks, `mt_tokens_for_owner` |
| The payee sees no sender | near.com shows "Receive 1 USDC" with only a one-time 1Click deposit address, which 1Click's public status lookup doesn't know | deposit address `f26a8ae5…a17ee9` |

What stays visible or known: each approval is a public DAO proposal, so its timing shows; 1Click and
NEAR Intents can see the mapping, and their terms don't guarantee confidentiality. A held payment
stays approvable for 24 hours, but each vote request expires in about 5 minutes.

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
afterwards, which suggests insufficient funds (the deployment has no balance check), but that's unproven. A failed
vote rolls the filing back: reproduced on a local sandbox with mainnet's DAO code (global hash `DtHZA1…`): a stale id,
a missing id and too little gas each left no proposal, kept the id counter and refunded the bond.

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

## Not done yet

The [enforcement assessment](docs/enforcement.md#status) tracks the current evidence for the signed
spending envelope, including cumulative limits, policy binding and execution-artifact trust.
A provider `FAILED` status is currently treated as terminal locally; it is not independently verified
as proof that a replacement payment is safe. See [recovery guidance](DEMO.md#the-live-moment-one-invoice-end-to-end).

- The API keeps signing requests open for 5 to 10 minutes, so a slow council misses the window.
- Trezu shows these proposals as a generic "sign on v1.signer", so a member voting there sees only a hash.
  The dashboard's "What am I voting on?" shows what each one does; check it there first.
- Two owner actions signed as NEAR delegate actions (create, freeze, unfreeze, policy update) pending at
  once share a nonce, so the second fails after its vote passes. File them one at a time.
- The policy's asset list limits what the agent spends, not what it buys: the wallet lets a swap into an
  unlisted asset through. This server refuses one before sending, but the wallet should enforce it.
- The owner can't verify the enforced policy: it is stored encrypted to the custody keystore, and the
  public `store_wallet_policy` takes no `agent_policy_hash`. The mandate digest is this server's own;
  the signed payload isn't shown to commit to it.
- Confidential credits from outside the API can't be attributed: nothing public indexes `intents.far`.
- A refusal says `policy_denied` without naming the rule that refused.
- The autopilot (off by default) hasn't yet run unattended for days, and its warnings stay in the dashboard:
  nothing reaches the owner outside it.
