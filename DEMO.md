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

## Before the demo

1. Check both services from outside. It changes nothing:
   ```
   DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke
   ```
2. Sign in once as a member to confirm the session works and the treasury agent's card shows Active, with autopilot on.
3. Have a payee account ready in a wallet if you'll submit an invoice live.

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

Do steps 2–3 back to back. The signing window is about 5 minutes, and a payment approved long after it was prepared
can fail at the provider. In the 2026-10-12 rehearsal, a payment approved after an hour failed and one approved after
4 minutes succeeded. If one was left waiting, prepare it again rather than approving the old one: it keeps the same
payment identity, so it can't be paid twice.

## What keeps it safe

- The agents run under rules the DAO approved, and changing those rules takes a DAO vote.
- Each agent has exactly one executor: the `dao` service for the treasury agent, the `invoices` service for the
  payout agent. Every other instance is approve-only.
- The public page reads only from chain. Treasury data reaches signed-in members only, and money actions operators
  only.
- Sign-in is bound to each site's host: a signature made for another site can't be used.
- State lives on each service's volume and survives a restart. To check, run `pnpm smoke` with `SMOKE_COOKIE_FILE`
  (and `SMOKE_INVOICES_COOKIE_FILE` for a payee) and `SMOKE_SNAPSHOT` before and after (see `src/smoke.ts`).
