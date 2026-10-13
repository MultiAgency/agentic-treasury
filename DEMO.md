# Demo walkthrough

A DAO, `agentic.sputnik-dao.near`, owns two agents that run its treasury on mainnet. The treasury agent keeps the
treasury at its target allocation, and the payout agent pays the DAO's payees. The treasury is confidential:
anyone can see how the DAO governs its agents, but only members see the money.

| What | Where |
|---|---|
| Dashboard (public page, member sign-in) | https://proto.multiagency.ai |
| Invoice page for payees | https://invoices.multiagency.ai |
| The DAO on chain | https://nearblocks.io/address/agentic.sputnik-dao.near |

Keep confidential details out of the talk: no targets, limits, payees or amounts. The public page is the line: it
shows only what the DAO's contract shows on chain.

## What is verified

The table was checked on the 2026-10-12 build: dao `aa6ec064` and invoices `a3aa194a`, from commit `fe3330c`.
The current deployment is dao `2713d2ea` and invoices `07a35af2` (2026-10-13, 15:13–15:18Z; source commit `a23f0e1`
per the deployer, since Railway records no commit). The table hasn't been re-checked on it.

| Claim | How it is known | When |
|---|---|---|
| Both hosts healthy; signed-out callers refused every agent read; cross-site writes refused | `pnpm smoke`, live, read-only | 2026-10-12 22:13Z |
| One executor per agent | Railway: one live deployment each, older ones removed | 2026-10-12 22:13Z |
| State survives a restart and a redeploy | Signed-in smoke snapshot before and after | 2026-10-12 20:50–21:37Z |
| Autopilot runs on schedule on that build | First tick's evidence: scheduled, build digests match | 2026-10-12 21:37Z |
| Invoice → DAO approval → payment, paid | op_RCW0gaWGDo_… (1 USDC, 21:46Z): submitted, inferred, by the deployed `invoices` service; approval prepared on an unidentified host, not this laptop's stores; proposal 50 filed and voted in two transactions; executed by the provider: SUCCESS | 2026-10-12 21:48Z |
| Same flow, not paid | op_9rM_JoIh… (1 USDC, 22:16Z): submitted, inferred, by the deployed `invoices` service; approval prepared and signed by the user's local approve-only server running the one-click code, uncommitted at the time (proposal 51); executed by the provider: FAILED, reason redacted (an empty wallet afterwards suggests insufficient funds, unproven) | 2026-10-12 22:17Z |
| Signed-in views (member, operator, payee) | Not re-checked on that build | — |
| Typecheck, offline tests, web build | Local; tests use mocks, not the provider or chain | per release |

Offline tests prove the code's own logic against mocked providers. They don't prove what the Agent API, OutLayer or
the DAO contract do; only a live check does.

## Before the demo

1. Check both services from outside. It changes nothing:
   ```
   DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke
   ```
2. Sign in once to confirm the session works and the treasury agent's card shows Active, with autopilot on.
3. If you'll pay an invoice live, check that the payout agent's confidential USDC balance covers it. An unfunded
   invoice is refused before it reaches a vote (see [Balance check](#balance-check)).
4. Have a payee account ready in a wallet if you'll submit an invoice live.

## Who sees what

| Persona | Gets in by | Sees | Can do |
|---|---|---|---|
| Visitor (signed out) | — | The DAO's roles and proposals, from chain | Nothing |
| Member | Being in one of the DAO's groups | Both agents: books, policy, autopilot, held payments | File owner actions as DAO proposals; vote in Trezu if the DAO lets them |
| Operator | Being named in `dashboard.json` | Everything a member sees | Money and configuration actions; each call is recorded before it runs |
| Payee | Signing in on the invoice page with an account the DAO agreed to pay | Their own invoices and their status | Submit invoices |

Today the DAO has one member, `multiagentic.near`, who is also the only operator. Signing in with it shows the
operator view; showing a member-only view needs a second account in the DAO.

## 1. As a visitor: what a confidential treasury shows

1. Open https://proto.multiagency.ai without signing in. It shows the DAO's roles and its latest proposals, read
   from chain.
2. Point out what each proposal reveals. An owner signature shows only the hash the DAO signs, and a Trezu
   confidential payment shows only that it happened. There are no balances, amounts or payees.
3. Open the block explorer link: the page shows nothing the chain doesn't.

## 2. As a payee: asking to be paid (Facilitator)

1. Open https://invoices.multiagency.ai and sign in with NEAR. It signs a message, not a transaction. Any account
   can sign in; the page never shows the DAO's members or its other payees.
2. Enter an amount and an optional note, and submit. An agreed payee files an invoice, which waits for the owner's
   approval. An account the DAO hasn't agreed to pay files an **agreement request** instead: nothing is paid, and
   the page says it waits for the DAO.
3. Once the DAO agrees, the request shows "Agreed" with **File this invoice**. An offer from the DAO (a purchase
   order or an award) shows its terms with **Use these terms**.

## 3. As a member: governing the agents

1. On https://proto.multiagency.ai choose **Sign in with NEAR**. Access comes from the DAO's own policy: an account
   outside its roles is refused, and one the DAO removes loses access within a minute.
2. **What am I voting on?** lists each proposal asking the DAO to sign as the agents' owner. For an open one, the
   dashboard recomputes the hash from the action an agent prepared, so you see the action in words and that the hash
   really is that action. A hash nothing here prepared is flagged. The vote itself happens in Trezu.
3. Open the treasury agent (**Agentic Treasury Management**):
   - **Overview**: the book against its target.
   - **Policy**: the mandate the DAO approved, with a digest anyone can recompute from the policy, and the agent's grants.
   - **Automations**: the autopilot, how often it runs, its ceiling and its last run. It acts only while its grant
     matches the strategy the DAO approved.
   - **Activity**: every execution, its assets and outcome, what kind of action it was and the policy revision it
     ran under (open a row for the digest), and the books reconciled against the API's records.
4. Open the payout agent (**Confidential Treasury Facilitator**): its Overview lists payments waiting for approval
   first, each marked within or outside its payee's agreed terms. Releasing one files a proposal, and nothing is paid
   until the DAO votes. **Agreements** lists requests from new payees and offers the DAO made; agreeing records the
   terms and files the policy update that lists the payee.
5. Each prototype's Overview opens with **What this shows**: every claim with how it is known (shown on mainnet,
   tested offline, provider docs, or by design).

## The live moment: one invoice, end to end (Facilitator)

This is the one flow worth running in front of people. It joins the three views: a payee submits, the DAO checks
and votes, and the agent pays confidentially.

1. As the payee, submit a small invoice (step 2 above).
2. As a member, approve it on the payout agent's Overview. A member who may both propose and vote files the
   proposal and votes in one wallet confirmation; anyone else files a proposal for the DAO to vote on.
3. On the home page, "What am I voting on?" shows it with its hash verified. If it still waits for votes, vote in Trezu.
4. The payment settles in the payout agent's Activity a minute or two later.

**With a new payee** (two votes, so rehearse it as a sequence): the payee's first submission is an agreement
request. On **Agreements**, agree to its terms: that files a policy update for the DAO's vote. Policy edits have a
10-minute cooldown, and two owner actions pending at once can collide, so file one at a time. Once it passes, the
payee files the invoice from the request, and steps 2–4 follow. This flow is tested offline; record its proposal
and op ids in [docs/facilitator.md](docs/facilitator.md) when it first runs on mainnet.

**The approval window is about 5 minutes.** Releasing a payment prepares a signature request, and the API's signing
window closes about five minutes later; the proposal's description says when. Vote in Trezu right after filing.
In the 2026-10-12 rehearsal, a payment approved after an hour failed and one approved after 4 minutes succeeded.

**Recovery.** A fresh invoice creates a new payment. Before replacing one, establish that the original
was refused before submission or that provider execution evidence proves it cannot pay the recipient.
A generic `FAILED` status, an expired approval or an empty wallet is insufficient on its own. The current
code treats `FAILED` as terminal; it does not independently establish that replacement is safe.
See the [recorded limitation](docs/enforcement.md#recovery-limitation).

- **A vote missed the window:** check the existing approval first. An attempted signature is poll-only
  after an ambiguous response or restart. Prepare a fresh approval for the same held payment only after
  establishing the prior request cannot execute; expiry alone must not trigger resubmission.
- **The payout agent refused an invoice** (for example, a payee the DAO no longer agrees to pay): it is resolved as
  refused, and nothing was sent. The payee may submit a new one.
- **A payment failed at the provider after the vote:** reconcile the original operation and inspect
  its execution evidence before deciding whether a new invoice is safe. For op_9rM_JoIh…
  (2026-10-12 22:17Z), the provider reported `FAILED` with the reason redacted. The empty wallet
  afterwards suggested insufficient funds but did not prove non-execution.
- **Unknown outcome:** the payout agent blocks new sends until the original outcome is established.
  Reconciliation polls a known operation ID; without one, provider/operator investigation is required.
  Never resubmit an unknown payment.

### Balance check

In source commit `a23f0e1`, which the deployer reports as the current deployment (above). A payment or invoice is refused with `insufficient_balance` when the
payout wallet's confidential balance, less payments this executor holds for approval, is below its amount, so it never
goes to a vote. The refusal is final and nothing was sent: funding the wallet doesn't revive that invoice. Fund the wallet, then have the payee
submit a new invoice. It's a limited check:
- It isn't checked again at approval: a wallet emptied while a payment is held still fails after the vote. The
  provider's reported balance still includes payments held for approval (mainnet, 2026-10-13: 2 USDC credited,
  `op_YFl1C3nr9…`; 1 USDC held, `op_-PNz_6ZYk…`; balance read at 15:25Z: 2 USDC), so subtracting them doesn't count
  them twice.
- It counts only payments held in this executor's own log. Payments held before that log existed, or by another
  instance, show in Activity as `remote` but don't reduce the balance it checks.
- It doesn't guarantee settlement after approval.

## The autopilot moment: a rebalance inside the limits (Treasury Management)

Balances in, a plan out, two quoted swaps inside the caps, and the budget meter dropping. Three assets need at
most two swaps to rebalance, so two is the honest number. Nothing signed changes.

1. Pick a day with budget room: the daily USD budget is $25, and the run needs about $5 of it.
2. Just before, send about 9.50 USDC from the DAO to the treasury agent (Treasury → Fund the agent). USDC is now
   about $4.75 over its 50% target.
3. Automations → preview: the plan should show two legs, USDC → wNEAR and USDC → ETH, each at least $2, totalling
   $5 or less, each with its quote's worst cost under the 250 bps cap. Prices move: if the total is over $5, the
   autopilot would leave it for the owner, so adjust the top-up and preview again.
4. Run now. Both swaps settle in about a minute; Overview's "Monthly budget left" drops by their USD value, and
   Activity lists both with the policy revision and digest they ran under.

## What keeps it safe

- The agents run under rules the DAO approved, and changing those rules takes a DAO vote.
- Each agent has exactly one executor: the `dao` service for the treasury agent, the `invoices` service for the
  payout agent. Every other instance is approve-only.
- The public page reads only from chain. Treasury data reaches signed-in members only, and money actions operators
  only.
- Sign-in is bound to each site's host: a signature made for another site can't be used.
- State lives on each service's volume and survives a restart. To check, run `pnpm smoke` with `SMOKE_COOKIE_FILE`
  and `SMOKE_SNAPSHOT` before and after (see `src/smoke.ts`).

## What it doesn't guarantee

Say "autonomous rebalancing with application checks and provider-enforced limits", not "the agent can never exceed
its signed policy". At the custody level:
- What a swap buys is checked only by this server, not by the provider.
- The provider serializes spends per wallet (per its own tests), but whether that holds until usage is recorded,
  for swaps that settle later, is unconfirmed: strict per-asset limits aren't established.
- The provider's USD-budget atomicity hasn't been independently verified.

The plan is in `docs/enforcement.md`.

How the server keeps its own sends safe on one host (the journal, crash recovery, owner-action locking) and what
tests that is in [docs/money-path.md](docs/money-path.md); the tests and what deployment shows are in
[enforcement](docs/enforcement.md#local-crash-and-concurrency-recovery).
