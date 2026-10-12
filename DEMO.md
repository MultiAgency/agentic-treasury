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

This walkthrough describes the deployed build: dao `aa6ec064` and invoices `a3aa194a`, source
`~/agencies/proto-releases/20261012T2135Z-candidate/source.tgz` (sha256 `2859f81a…`, src digest `ce4a4f11…`).
That build is commit `fe3330c` plus an unused `src/restart-check.ts`; HEAD and the working tree are newer.

| Claim | How it is known | When |
|---|---|---|
| Both hosts healthy; signed-out callers refused every agent read; cross-site writes refused | `pnpm smoke`, live, read-only | 2026-10-12 22:13Z |
| One executor per agent | Railway: one live deployment each, older ones removed | 2026-10-12 22:13Z |
| State survives a restart and a redeploy | Signed-in smoke snapshot before and after | 2026-10-12 20:50–21:37Z |
| Autopilot runs on schedule on this build | First tick's evidence: scheduled, build digests match | 2026-10-12 21:37Z |
| Invoice → DAO approval → payment, paid | op_RCW0gaWGDo_… (1 USDC, 21:46Z): submitted, inferred, by the deployed `invoices` service; approval prepared on an unidentified host, not this laptop's stores; proposal 50 filed and voted in two transactions; executed by the provider: SUCCESS | 2026-10-12 21:48Z |
| Same flow, not paid | op_9rM_JoIh… (1 USDC, 22:16Z): submitted, inferred, by the deployed `invoices` service; approval prepared and signed by the user's local approve-only server running the one-click code, uncommitted at the time (proposal 51); executed by the provider: FAILED, reason redacted (an empty wallet afterwards suggests insufficient funds, unproven) | 2026-10-12 22:17Z |
| Signed-in views (member, operator, payee) | Not re-checked on this build | — |
| Typecheck, offline tests, web build | Local; tests use mocks, not the provider or chain | per release |

Offline tests prove the code's own logic against mocked providers. They don't prove what the Agent API, OutLayer or
the DAO contract do; only a live check does.

## Before the demo

1. Check both services from outside. It changes nothing:
   ```
   DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke
   ```
2. Sign in once to confirm the session works and the treasury agent's card shows Active, with autopilot on.
3. If you'll pay an invoice live, check that the payout agent's confidential USDC balance covers it. The deployed
   build doesn't check: an unfunded payment is held, voted on, and only then fails at the provider.
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

## 2. As a payee: submitting an invoice

1. Open https://invoices.multiagency.ai and sign in with NEAR. It signs a message, not a transaction. Accounts the DAO
   hasn't agreed to pay are refused.
2. Enter an amount and an optional note, and submit. The page returns a one-time submission id.
3. The invoice waits for the owner's approval. Nothing is paid until then.

## 3. As a member: governing the agents

1. On https://proto.multiagency.ai choose **Sign in with NEAR**. Access comes from the DAO's own policy: an account
   outside its roles is refused, and one the DAO removes loses access within a minute.
2. **What am I voting on?** lists each proposal asking the DAO to sign as the agents' owner. For an open one, the
   dashboard recomputes the hash from the action an agent prepared, so you see the action in words and that the hash
   really is that action. A hash nothing here prepared is flagged. The vote itself happens in Trezu.
3. Open the treasury agent:
   - **Overview**: the book against its target.
   - **Policy**: the mandate the DAO approved, with a digest anyone can recompute from the policy, and the agent's grants.
   - **Automations**: the autopilot, how often it runs, its ceiling and its last run. It acts only while its grant
     matches the strategy the DAO approved.
   - **Activity**: the books, with every execution, its assets and outcome, why it was sent and the policy revision
     it ran under, reconciled against the API's records.
4. Open the payout agent: payments waiting for approval. Releasing one files a proposal, and nothing is paid until
   the DAO votes.

## The live moment: one invoice, end to end

This is the one flow worth running in front of people. It joins the three views: a payee submits, the DAO checks
and votes, and the agent pays confidentially.

1. As the payee, submit a small invoice (step 2 above).
2. As a member, release it from the payout agent. That files an approval proposal.
3. On the home page, "What am I voting on?" shows it with its hash verified. Vote in Trezu.
4. The payment settles in the payout agent's Activity a minute or two later.

**The approval window is about 5 minutes.** Releasing a payment prepares a signature request, and the API's signing
window closes about five minutes later; the proposal's description says when. Vote in Trezu right after filing.
In the 2026-10-12 rehearsal, a payment approved after an hour failed and one approved after 4 minutes succeeded.

**Recovery.** Before creating a replacement payment or invoice, the original must have a definitive unpaid outcome,
reconciled with the API: FAILED, or refused before anything was sent. A fresh submission is a new payment, so it
could pay twice if the original later succeeds.
- **A vote missed the window:** release the same held payment again rather than voting on the old proposal. That
  prepares a new approval for the same payment, so the payment itself isn't duplicated. The old proposal can be left
  to expire.
- **The payout agent refused an invoice** (for example, a payee the DAO no longer agrees to pay): it is resolved as
  refused, and nothing was sent. The payee may submit a new one.
- **A payment failed at the provider after the vote:** confirm the status is FAILED (`pnpm reconcile` on the payout
  agent's executor), fix the cause, then the payee submits a new invoice. Example: op_9rM_JoIh…, 2026-10-12 22:17Z.
  The provider reported FAILED with the reason redacted. The wallet was empty when checked afterwards, which
  supports, but doesn't prove, insufficient funds.
- **Unknown outcome:** a payment whose outcome the server couldn't prove shows as unknown, and the payout agent sends
  nothing more until an operator runs `pnpm reconcile`. Never resubmit an unknown payment; wait for reconciliation
  to make it definitive.

**Next release (not deployed): balance check.** A payment or invoice is refused with `insufficient_balance` when the
payout wallet's confidential balance at that moment is below its amount, so it never goes to a vote. The refusal is
final and nothing was sent: funding the wallet doesn't revive that invoice. Fund the wallet, then have the payee
submit a new invoice. It's a limited check:
- It doesn't count other held payments against the balance, so two payments that each fit can together exceed it.
- It isn't repeated at approval, so a payment can still fail after the vote if the balance drops in between.
- It doesn't guarantee settlement after approval.

## What keeps it safe

- The agents run under rules the DAO approved, and changing those rules takes a DAO vote.
- Each agent has exactly one executor: the `dao` service for the treasury agent, the `invoices` service for the
  payout agent. Every other instance is approve-only.
- The public page reads only from chain. Treasury data reaches signed-in members only, and money actions operators
  only.
- Sign-in is bound to each site's host: a signature made for another site can't be used.
- State lives on each service's volume and survives a restart. To check, run `pnpm smoke` with `SMOKE_COOKIE_FILE`
  (and `SMOKE_INVOICES_COOKIE_FILE` for a payee) and `SMOKE_SNAPSHOT` before and after (see `src/smoke.ts`).

## What it doesn't guarantee

Say "autonomous rebalancing with application checks and provider-enforced limits", not "the agent can never exceed
its signed policy". At the custody level:
- What a swap buys is checked only by this server, not by the provider.
- The provider's cumulative per-asset limits are best-effort under concurrent sends.
- The provider's USD-budget atomicity hasn't been independently verified.

The plan is in `docs/enforcement.md`.

Two known correctness gaps have regression tests marked todo, so the suite doesn't fail on them:
- **A send that crashes between its write-ahead record and its claim** (`test/journal.test.ts`). A process dying
  mid-send (a deploy, restart or crash) leaves the action unresolved even though nothing reached the provider. That
  agent then sends nothing until an operator runs `pnpm reconcile`. In the demo, this only happens if a service
  restarts during a payment or an autopilot trade.
- **Two processes preparing owner actions on one instance** (`test/owner-intents-race.test.ts`). A command-line owner
  action run in the same container as the server can make one of them lose its held request. Its proposal then can't
  be completed and has to be prepared again. The dashboard alone doesn't trigger it.
