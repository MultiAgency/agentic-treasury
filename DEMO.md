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
shows the two areas, each brief as capabilities and guarantees, who enforces each guarantee, and how each is
known, and reads nothing from the server.

## What is verified

The table was checked on the 2026-10-12 build: dao `aa6ec064` and invoices `a3aa194a`, from commit `fe3330c`.
The current deployment is dao `708557e6` (2026-10-14 01:23Z), from a clean export of commit `2d94325` per the
deployer (Railway records no commit), and invoices `fcdc06a6` (2026-10-13 22:46:57Z), from `9b2941a`: `d9cb581` and
`2d94325` changed only dashboard pages and docs. On the live dashboard, Automations shows the "Latest run" panel with
the treasury's 00:50Z run, and Steward is out of the treasury menu. After the dao deploy, `pnpm smoke` passed against
both hosts, signed out and signed in as the operator. The walkthrough below describes this build. Before it: dao
`0d5964ea` (00:43Z, from `d9cb581`), whose text checks on the card bundle these rows refer to. Of the table, the first, second and fourth rows
have been re-checked on it, and the signed-in operator reads. Before it: dao `2d08148b` (2026-10-13 22:48:02Z, from `9b2941a`), after which the operator
signed in and opened both agents under the per-agent owner check; and earlier dao `cd3115ee` and invoices `1be6e29c`
(18:31–18:32Z, from `37cbba2`). Operation ids and amounts for the rows below are in the private release record.

| Claim | How it is known | When |
|---|---|---|
| Both hosts healthy; signed-out callers refused every agent read; cross-site writes refused | `pnpm smoke`, live, read-only | 2026-10-12 22:13Z; re-checked on dao `0d5964ea` / invoices `fcdc06a6`, 2026-10-14 00:48Z |
| One executor per agent | Railway: one live deployment each, older ones removed | 2026-10-12 22:13Z; re-checked 2026-10-14 00:48Z |
| State survives a restart and a redeploy | Signed-in smoke snapshot before and after | 2026-10-12 20:50–21:37Z |
| Autopilot runs on schedule on that build | First tick's evidence: scheduled, build digests match | 2026-10-12 21:37Z; re-checked on dao `0d5964ea`: the first scheduled tick, 2026-10-14 00:46:01Z, records that deployment |
| Invoice → DAO approval → payment, paid | Submitted at 21:46Z, inferred, by the deployed `invoices` service; approval prepared on an unidentified host, not this laptop's stores; proposal 50 filed and voted in two transactions; executed by the provider: SUCCESS | 2026-10-12 21:48Z |
| Same flow, not paid | Submitted at 22:16Z, inferred, by the deployed `invoices` service; approval prepared and signed by the user's local approve-only server running the one-click code, uncommitted at the time (proposal 51); executed by the provider: FAILED, reason redacted (an empty wallet afterwards suggests insufficient funds, unproven) | 2026-10-12 22:17Z |
| Signed-in views (member, operator, payee) | Signed-in `pnpm smoke` as the operator passed on dao `0d5964ea`: both agents open under the per-agent owner check, and the DAO's proposals read. The member and payee views, and the pages themselves, not re-checked | 2026-10-14 |
| Typecheck, offline tests, web build | Local; tests use mocks, not the provider or chain | per release |

Offline tests prove the code's own logic against mocked providers. They don't prove what the Agent API, OutLayer or
the DAO contract do; only a live check does.

## Before the demo

1. Check the demo's preconditions. It reads only, through the hosted gateway, with a signed-in operator session
   saved to a file (as for `pnpm run-report`):
   ```
   DASHBOARD_URL=https://proto.multiagency.ai REPORT_COOKIE_FILE=<file> pnpm demo-check
   ```
   It prints `ok` or `FIX` for: the payout wallet's USDC, payments already waiting, the treasury's daily budget
   left (with its reset time), the autopilot's next tick, and the book's drift. It exits nonzero on any `FIX`.
   An empty payout wallet is fixed from the payout agent's Overview: **Top up from the treasury** (operators).
2. Check both services from outside. It changes nothing:
   ```
   DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke
   ```
3. Sign in once to confirm the session works and the treasury agent's card shows Active, with autopilot on.
4. If you'll pay an invoice live, check that the payout agent's confidential USDC balance covers it. An unfunded
   invoice is refused before it reaches a vote (see [Balance check](#balance-check)).
5. Have a payee account ready in a wallet if you'll submit an invoice live.

## Who sees what

| Persona | Gets in by | Sees | Can do |
|---|---|---|---|
| Visitor (signed out) | — | The two areas, Payables and Treasury: each brief's capabilities and guarantees, who enforces each guarantee and how each is known | Sign in; ask to be paid on the invoice page |
| Member | Being in one of the DAO's groups | Both agents: books, policy, autopilot, held payments | File owner actions as DAO proposals; vote in Trezu if the DAO lets them |
| Operator | Being named beside the agent in `dashboard.json`, or owning it from a wallet | Everything a member sees | Money and configuration actions; each call is recorded before it runs |
| Payee | Signing in on the invoice page with an account the DAO agreed to pay | Their own invoices and their status | Submit invoices |

Today the DAO has one member, who is also the only operator. Signing in with that account shows the
operator view; showing a member-only view needs a second account in the DAO.

## The two areas, outcome by outcome

Each row is one outcome from the area's brief: what to do, what you'll see, and what it leaves as
evidence. What has been shown so far, and where this build differs from each brief, is in the area's doc:
[facilitator](docs/facilitator.md), [treasury](docs/treasury.md).

### Confidential Treasury Facilitator

| Outcome | Do | See | Leaves |
|---|---|---|---|
| Request → vote → paid confidentially | On the invoice page, an agreed payee submits; on the payout agent's Overview, approve; vote | The invoice moves from waiting to paid; the payee sees no member account | The approval's proposal # |
| A new payee is routed to a new agreement | Sign in on the invoice page with an account the DAO hasn't agreed to pay, and submit | The page says it waits for the DAO; the request appears on **Agreements** | The request, then the policy update's proposal # once agreed |
| Over-limit is refused | Submit an invoice over the per-payment cap | Expected: refused before anything is voted on (not yet shown on this agent) | A refusal with its code, and no proposal |
| Chain watchers can't rebuild the payouts | Open the DAO's proposals on a block explorer or in Trezu | Approvals read "Approve the pending confidential request": no payee, no amount | The proposal #s |

### Agentic Treasury Management

| Outcome | Do | See | Leaves |
|---|---|---|---|
| Balances in, quoted plan out, swaps inside the caps | Automations → Preview, then Run now | Each leg quoted and within the cost cap; the budget figure drops by the swaps' value | Each swap in Activity, with the policy revision it ran under |
| A breach is refused | A run whose value exceeds the budget left | Activity shows it refused with `spend_budget_exceeded`; nothing moved | A refusal with its code |
| Idle funds go confidential | When the agent holds a public balance, let the autopilot run | "Held privately" returns to 100% | The shield in Activity |

Record what a run leaves in [docs/mainnet-log.md](docs/mainnet-log.md), and update the area's doc and the
area cards (`web/src/beats.ts`) to match.

## The two stories

One scripted run per area, run live from start to finish. The waits are part of the experience: each step
says what's happening and roughly how long it takes. Run `pnpm demo-check` first, and show the configuration as
signed: don't retune the strategy or limits for a demo.

### Agentic Treasury Management: the AI proposes, the autopilot corrects

1. **Steward** (an experiment, not in the menu: open `/a/treasury/steward`): ask it to propose a small swap of USDC into wNEAR. The
   model's plan appears in a few seconds.
2. **Execute plan.** Every step goes through the same checks and policy as any other send. The swap settles in
   about a minute: Overview's Allocation now drifts from the target, and the budget figure drops.
3. **Automations → Run now.** The autopilot reads the book, plans the correction and quotes each leg, then sells
   the wNEAR back toward the target, in about a minute and a half. It plays out under **Latest run**, right below
   the Autopilot settings: the book before, the quoted plan, the send, and the daily budget before and after.
4. **Activity** lists the steward's swap and the autopilot's correction, each with the policy revision it ran
   under.
5. **The refusal.** When the daily budget is nearly used (`demo-check` and Overview show what's left), ask the
   Steward for one more swap larger than what remains, and execute it. The provider refuses it, Activity shows
   "refused · over the USD budget", and nothing moves: the provider refuses a request over the budget the DAO
   signed, whoever asks.

Both swaps spend the daily USD budget, so rehearse after it resets (`demo-check` prints when) and leave room for
the live run. Run on mainnet on 2026-10-13, per the operator's record: the steward's swap at 17:55Z, before the
18:31Z deployment, and the autopilot's correction at 18:39Z, on dao `cd3115ee`.

### Confidential Treasury Facilitator: a request, a vote, a confidential payment

1. **The payee asks.** On https://invoices.multiagency.ai, sign in as a payee account the DAO agreed to pay (not a
   DAO member, so the payee never touches the DAO side) and submit a small invoice. In a few seconds the page
   shows it waiting for approval, and says nothing is paid until then.
2. **The DAO hears about it.** The executor's Telegram alert arrives within about a minute; its link opens the
   payout agent's Overview, with the payment first, shown beside the payee's agreed terms (a payee
   agreed before terms existed shows none on record).
3. **A member approves.** A member who may propose and vote files and votes in one wallet confirmation; "What am I
   voting on?" on the DAO home shows the proposal with its hash verified. From here the signing window is about
   five minutes, so approve only when ready to finish.
4. **It's paid.** The DAO's signature is picked up, the payment released and settled in a minute or two; the
   invoice page shows **Paid**, and the payout agent's Activity lists it, naming the payee. **Follow a payment →**
   (under Held payouts) shows its path from request to settlement.

A new payee adds one step at the start: their first submission is an agreement request, which the DAO agrees on
**Agreements** (see [the live moment](#the-live-moment-one-invoice-end-to-end-facilitator)).

**Short on time?** File the invoice, or run the steward's swap, just before presenting, and start from the next
step: an invoice stays approvable for 24 hours.

### Paying a list at once: Trezu, not this agent

The payout agent pays one invoice per vote. For a list (a round of awards, a payroll), Trezu, the DAO's
treasury app, offers a confidential bulk payment. One vote pays up to 25 recipients in one token. The chain
shows the proposal, the votes and one hash per recipient, but not who or how much. It pays from the DAO's own
treasury, not through the payout agent, so none of this site's checks or records apply to it. This is per
Trezu's source (near-devhub/trezu at `c1ecee0`), and it hasn't yet been run on this DAO.

Before: the DAO has passed Trezu's one-time "Start activation" proposal for confidential bulk payments, and
Trezu shows a bulk-payment credit available. Each batch attaches a small NEAR deposit when it starts.

1. In Trezu, **Payments → Bulk Payments**: a member with the Requestor role enters the list, or uploads it as
   a CSV, in one token.
2. The proposal reads "Confidential proposal. Details are hidden for privacy." Open it on a block explorer:
   its description carries only payload hashes.
3. Vote in Trezu. The vote must go through Trezu's relay; a vote cast elsewhere leaves the batch awaiting
   approval. Trezu then has each payment signed and sent.

Record the proposal number in [docs/facilitator.md](docs/facilitator.md) beside "A winners list is paid in one
auditable batch". That row stays "not yet" for this agent.

### A recorded fallback

Record each story once when it runs cleanly, for short pitches and for when mainnet is slow. The live site is for
people who want to sign in and look for themselves.

## 1. As a visitor: what a confidential treasury shows

1. Open https://proto.multiagency.ai without signing in. Each card lists its brief's capabilities and guarantees;
   each guarantee names who stops a misbehaving agent, and each row says whether it's held or working on mainnet,
   tested offline, or not yet. The running brief is open; the roadmap is folded and uncounted. Nothing else: no
   balances, payments, roster or proposals.
2. For what anyone can see on chain, open the DAO on a block explorer: each approval reads "Approve the pending
   confidential request", with no payee or amount. The council's roster is public there, as it is for any Sputnik
   DAO; this site doesn't advertise it.

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
3. Open the treasury agent (**Treasury**). Its menu runs Overview, Automations,
   Funding, Policy, Activity:
   - **Overview**: the book against its target, and the budget figure: whichever USD budget window (day, week or
     month) has least left, since that one refuses first, labelled by its period ("Daily budget left").
   - **Steward** (experimental, at `/a/treasury/steward`, not in the menu): a model proposes a plan inside the policy; nothing moves until it is executed.
   - **Funding**: money in from the DAO and money out, back to it or to a listed payee.
   - **Policy**: the mandate the DAO approved, with a digest anyone can recompute from the policy, and the agent's grants.
   - **Automations**: the autopilot, how often it runs, its ceiling and its last run. It acts only while its grant
     matches the strategy the DAO approved.
   - **Activity**: every execution, its assets and outcome, what kind of action it was and the policy revision it
     ran under (open a row for the digest), and the books reconciled against the API's records.
4. Open the payout agent (**Payables**). Its menu runs Overview, Agreements, Funding,
   Policy, Activity. Its Overview lists payments waiting for approval first, each marked within or outside its
   payee's agreed terms, approvable for 24 hours. Releasing one files a proposal, and nothing is paid
   until the DAO votes. **Agreements** lists requests from new payees and offers the DAO made; agreeing records the
   terms and files the policy update that lists the payee.
5. Each agent's Overview shows its area card, after any held payouts: capabilities and guarantees, who enforces
   each guarantee and how each is known, with the evidence for each.

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
numbers in [docs/facilitator.md](docs/facilitator.md) when it first runs on mainnet.

**The approval window is about 5 minutes.** Releasing a payment prepares a signature request, and the API's signing
window closes about five minutes later; the proposal's description says when. Vote in Trezu right after filing.
On 2026-10-12, a payment approved within minutes (proposal #47) was paid. One approved an hour after it was held
(#46) failed, but its wallet was empty, so the window isn't shown to be the cause
([log](docs/mainnet-log.md#invoices-2026-10-12)).

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
  its execution evidence before deciding whether a new invoice is safe. For the 2026-10-12 22:17Z
  payout, the provider reported `FAILED` with the reason redacted. The empty wallet
  afterwards suggested insufficient funds but did not prove non-execution.
- **Unknown outcome:** the payout agent blocks new sends until the original outcome is established.
  Reconciliation polls a known operation ID; without one, provider/operator investigation is required.
  Never resubmit an unknown payment.

### Balance check

In the current deployment (above). A payment or invoice is refused with `insufficient_balance` when the
payout wallet's confidential balance, less payments this executor holds for approval, is below its amount, so it never
goes to a vote. The refusal is final and nothing was sent: funding the wallet doesn't revive that invoice. Fund the wallet, then have the payee
submit a new invoice. It's a limited check:
- It isn't checked again at approval: a wallet emptied while a payment is held still fails after the vote. The
  provider's reported balance still includes payments held for approval (mainnet, 2026-10-13,
  [log](docs/mainnet-log.md#a-held-payout-stays-in-the-reported-balance-2026-10-13)), so subtracting them doesn't
  count them twice.
- It counts only payments held in this executor's own log. Payments held before that log existed, or by another
  instance, come from the API's history and don't reduce the balance it checks.
- It doesn't guarantee settlement after approval.

## The autopilot moment: a rebalance inside the limits (Treasury Management)

Balances in, a plan out, two quoted swaps inside the caps, and the budget meter dropping. Three assets need at
most two swaps to rebalance, so two is the honest number. Nothing signed changes.

1. Pick a day with budget room: Policy shows the daily USD budget, and Automations the autopilot's ceiling per
   run, which is about what the run needs.
2. Just before, fund the treasury agent with USDC from the DAO (Funding → money in), enough to put USDC over its
   target by about that ceiling. Overview's Allocation shows the gap.
3. Automations → preview: the plan should show two legs, USDC → wNEAR and USDC → ETH, each above the minimum leg,
   totalling no more than the ceiling, each with its quote's worst cost under the strategy's cost cap. Prices move:
   if the total is over the ceiling, the autopilot would leave it for the owner, so adjust the top-up and preview
   again.
4. Run now. Both swaps play out under **Latest run** on Automations and settle in about a minute; the daily budget
   shown there drops by their USD value, and Activity lists both with the policy revision and digest they ran under.

## What keeps it safe

- The agents run under rules the DAO approved, and changing those rules takes a DAO vote.
- Each agent has exactly one executor: the `dao` service for the treasury agent, the `invoices` service for the
  payout agent. Every other instance is approve-only.
- The public page reads nothing from the server. Treasury data and proposals reach signed-in members only, and money
  actions operators only.
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
tests that is in [docs/architecture.md](docs/architecture.md#how-the-money-path-stays-safe-on-one-host); the tests and what deployment shows are in
[enforcement](docs/enforcement.md#local-crash-and-concurrency-recovery).
