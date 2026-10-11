# Agentic Treasury

An AI agent manages a treasury on [NEAR Intents](https://near.org/intents) through the
[NEAR Intents Agent API](https://api.agentsonintents.com/llms.txt), inside a policy its owner signed.
The owner can be a person's wallet or a Sputnik DAO, such as a [Trezu](https://trezu.org) treasury.

> Runs on NEAR mainnet with real funds. Use a low-value account and small amounts.

## How it works

- The **owner** signs a **policy**: allowed actions, assets, caps, budget, and where funds may go.
- The owner issues a **grant** that lets this server act for the **agent** inside that policy.
- The agent swaps, shields and pays. The Agent API and the wallet provider refuse anything outside the
  policy before funds move. The one gap they leave, a swap into an asset the policy doesn't list, is
  refused by this server (see Not done yet).
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

Owner intents persist `prepared → submitted → settled` in the existing private per-instance file.
Here `submitted` means submission was attempted, not proven accepted. A restart polls the same ID,
including after signing expiry, and finishes agent creation, grant promotion, or approval settlement.
It never signs again or automatically resubmits an ambiguous owner request. Settled results remain
available after restart. Records already deleted by older versions cannot be reconstructed locally.

The dashboard runs status-only reconciliation every 10 seconds, independently of strategy execution.
`pnpm reconcile --poll` performs one pass. Unknown IDs, failed reads, `UNCERTAIN`, and `NEEDS_REVIEW`
remain unresolved. `--replay` is an explicit operator action; provider deduplication semantics are
unconfirmed, so replay may duplicate an ambiguous request.

Plans simulate cumulative swaps and shields using guaranteed output floors, then recheck remaining
feasibility between legs. Policy, strategy digest, cost ceiling, and expiry are checked after
asynchronous preflight before each send, including a swap following an automatic shield.
These recovery and execution checks are offline fault-tested; they are not mainnet-validated.
Autopilot demonstration remains a separate milestone.

## Run it

```sh
pnpm install
cp .env.example .env   # add an API key from https://partners.demo.agentsonintents.com
pnpm demo              # dashboard on http://localhost:8787
```

The dashboard walks you through creating an agent and issuing its grant. Everything is also
available from the command line: see the scripts in `package.json`.

## Two kinds of agent

- A **treasury agent** swaps between USDC, wNEAR and ETH toward a target, shields anything public,
  and can be steered by an LLM whose responses are verified against its TEE. No vote per action.
- A **payout agent** only transfers USDC, confidentially, to payees the owner agreed to. Every payout
  waits for the owner's approval, and its caps are checked before any vote, so an approval given by
  mistake still can't exceed them.

Each instance of the server runs one agent. To run a second beside the first, give it its own
settings file: `ENV_FILE=.env.payout PORT=8790 pnpm server`. It shares the API keys in `.env` but keeps
its own agent, grant and treasury, and each agent has its own action log in `.ops/`.

## Public intake

`pnpm intake` (`src/intake-server.ts`) lets anyone ask the payout agent to pay one of its agreed
payees, without learning who approves. A requester pastes an invoice; the verified model reads it into
a payee, an amount and a reference; the requester checks them; the intake files one payout, which
waits for the owner's approval. The requester sees only the request's status, never an account or a
member. A payee outside the agreement is answered "needs a new agreement" before anything is sent, and
the API refuses anything over the caps before any vote. Each request (payee, amount, reference) files
once.

The intake holds only its own grant on the payout agent. It listens on loopback unless
`TURNSTILE_SECRET_KEY` is set; every write needs a Cloudflare Turnstile token, and each address may
read 10 and file 5 requests an hour.

**Deploy on Railway** (`Dockerfile`, `railway.json`, one replica):

1. Issue the intake's grant with a separate settings file, so its token never replaces the dashboard's:
   copy `AGENT_ID`, `TREASURY_ACCOUNT` and `TREASURY_CONFIDENTIAL` from `.env.payout` into `.env.intake`,
   run `ENV_FILE=.env.intake GRANT_PURPOSE=intake PORT=8794 pnpm server`, propose the grant from its
   page (one DAO vote), then take `AGENT_GRANT_TOKEN` from `.env.intake` to Railway.
2. Create a Turnstile widget for the intake's domain.
3. Attach a volume at `/data`: the money lock, the ops log and the intake's record of filed requests
   live there, and losing them could let a resubmitted invoice be filed twice.
4. Set the variables: `AGENT_ID` (the payout agent), `AGENT_GRANT_TOKEN` (the intake's grant),
   `NEAR_INTENTS_AGENT_API_KEY`, `NEAR_INTENTS_AGENT_API_URL`, `NEARAI_API_KEY`, `TURNSTILE_SITE_KEY`,
   `TURNSTILE_SECRET_KEY`, and optionally `INTAKE_TITLE`. Railway sets `PORT`.

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

## Not done yet

- The API keeps signing requests open for 5 to 10 minutes, so a slow council misses the window.
- Trezu shows these proposals as a generic "sign on v1.signer", so members vote on a hash they can't
  read. The dashboard should say what each one does.
- The public payout intake (`pnpm intake`) runs locally only: it isn't deployed, and its own grant isn't issued yet.
- The policy's asset list limits what the agent spends, not what it buys: the wallet lets a swap into an
  unlisted asset through. This server refuses one before sending, but the wallet should enforce it.
- The API's `agent_policy_hash` can't be recomputed from the policy, so the mandate digest is this
  server's own: the signed payload isn't shown to commit to it.
- Confidential credits from outside the API can't be attributed: nothing public indexes `intents.far`.
- A refusal says `policy_denied` without naming the rule that refused.
- The autopilot (off by default) hasn't yet run unattended for days, and its warnings stay in the dashboard:
  nothing reaches the owner outside it.
- Auto-execution doesn't yet require a grant that approves the current strategy.
