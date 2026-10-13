# Agentic Treasury

An AI agent manages a treasury on [NEAR Intents](https://near.org/intents) through the
[NEAR Intents Agent API](https://api.agentsonintents.com/llms.txt), inside a policy its owner signed.
The owner can be a person's wallet or a Sputnik DAO, such as a [Trezu](https://trezu.org) treasury.

> Runs on NEAR mainnet with real funds. Use a low-value account and small amounts.

Two areas, each one agent owned by the same DAO, `agentic.sputnik-dao.near`. Each runs a brief from
the Agent Connect catalog and plans more:

| Area | What it shows | Details |
|---|---|---|
| **Payables** (Confidential Treasury Facilitator) | Anyone asks the DAO to be paid; agreements carry terms (contractor requests, purchase orders, bounty and grant awards); each payment is held for the DAO's vote and paid confidentially | [docs/facilitator.md](docs/facilitator.md) |
| **Treasury** (Agentic Treasury Management) | An agent rebalances toward a target on its own, quoting every swap, inside per-asset caps and a USD budget the DAO signed; idle funds stay confidential | [docs/treasury.md](docs/treasury.md) |

Each doc measures its briefs requirement by requirement (complete, tested, live) and lists what isn't covered.

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

How the money path keeps these safe (one send site, the journal, reconciliation, owner intents, invoice
storage and the checks before each send) is in [docs/architecture.md](docs/architecture.md#how-the-money-path-stays-safe-on-one-host).

## Run it

```sh
pnpm install
cp .env.example .env   # add an API key from https://partners.demo.agentsonintents.com
pnpm demo              # dashboard on http://localhost:8787
```

The dashboard walks you through creating an agent and issuing its grant, and runs every money action.
The command line has only what the dashboard doesn't: owner actions signed with a local key, and checks.

| Owner actions, signed with `AGENT_OWNER_PRIVATE_KEY` instead of a wallet or DAO vote | |
|---|---|
| `pnpm create-agent` | Creates an agent with the policy in `src/policy.ts` and saves `AGENT_ID` |
| `pnpm issue-grant [treasury\|payout\|invoices] [suffix]` | Issues a grant and saves its token |
| `pnpm revoke-grant [grant id]` | Lists live grants, or revokes one |
| `pnpm update-policy [--policy file] [--diff]` | Prints the change from the policy in force, then signs it without asking; `--diff` only prints |
| `pnpm archive` | Freezes, then archives the agent (reversible) |

| Checks | |
|---|---|
| `pnpm inspect [--whoami]` | The agent's policy, balances and grants, as the API returns them |
| `pnpm reconcile [--poll]` | Operations without a proven outcome; `--poll` reads their statuses once, resending nothing |
| `pnpm books [--csv]` | Balances against chain transfers and recorded executions; `--csv` prints the ledger |
| `pnpm smoke` | Read-only check of the hosted dashboard and invoice page |
| `pnpm run-report` | The unattended-run report ([operations](docs/operations.md#unattended-run-observing-the-treasury-autopilot)) |

## Hosted demo

Two pages on Railway. Signing in with a NEAR wallet signs a message, never a transaction.

- **Dashboard**, https://proto.multiagency.ai. Signed out, it shows the two areas, Payables and
  Treasury: each brief from the Agent Connect catalog as capabilities (what the agent does) and guarantees
  (what it can't do). Each guarantee names who stops a misbehaving agent (the signed policy, our server, or
  nobody yet), and each row says how it's known: held or working on mainnet, tested offline, or not yet. Each
  card counts its running brief's guarantees enforced by the signed policy and its requirements on mainnet.
  It reads nothing from the server. Members of `agentic.sputnik-dao.near` sign in to see the treasury and
  the proposals.
  It is the treasury agent's executor and runs the payout agent approve-only.
- **Invoices**, https://invoices.multiagency.ai, where anyone asks the DAO to be paid. It is the payout
  agent's executor.

Each agent in `deploy/dashboard.json` names its `owner`, and the gateway decides per agent who may see
it, from that owner at most a minute old. When the owner is a Sputnik DAO, an account in any of its roles
is a member: it reads everything and may file owner actions as proposals, which do nothing until the DAO
votes. Any other owner account signs in itself and operates its agents, signing owner actions with its
own wallet. Accounts listed in an agent's `operators` can also move its money and change its settings.
Anyone else is refused at sign-in. Signed out, the gateway lists only the DAOs' agents, which their
on-chain proposals already name; a wallet's agent is listed only to those who may see it. None of this
limits whoever runs the host, who can read every agent's state there. Both hosted agents are owned by the DAO; a wallet-owned agent behind the
gateway is tested offline only (`test/gateway-denial.test.ts`). On the invoice page anyone may sign in, but only payees in
the payout agent's policy file invoices; anyone else files an agreement request.

The demo walkthrough is in [DEMO.md](DEMO.md).

Deployment, executor migration and state preservation are documented in the
[operations guide](docs/operations.md#dashboard). Each agent requires one executor host; the local
lease does not enforce that across machines. Other instances use `EXECUTOR=off`.

## Two kinds of agent

- A **treasury agent** swaps between USDC, wNEAR and ETH toward a target, shields anything public,
  and, as an experiment reached only at `/steward`, can be steered by an LLM whose responses are verified
  against its TEE. No vote per action.
- A **payout agent** only transfers USDC, confidentially, to payees the owner agreed to. Every payout
  waits for the owner's approval. Approval verification checks the intended terms against the current
  policy; cumulative enforcement and the final signed artifact retain the provider dependencies
  described in the [enforcement assessment](docs/enforcement.md).

Each instance of the server runs one agent. To run a second beside the first, give it its own
settings file: `ENV_FILE=.env.payout PORT=8790 pnpm server`. It shares the API keys in `.env` but keeps
its own agent, grant and treasury, and each agent has its own action log in `.ops/`. The payout agent's
executor, which also serves the invoice page, starts with `ENV_FILE=.env.payout pnpm invoices`; any other
instance of an agent runs `EXECUTOR=off` ([operations](docs/operations.md#payout-executor)).

## Notifications

Each executor can tell the owner on Telegram when something waits for a person: a payment held for
approval, a money action still without a proven outcome after about five minutes (sends are paused
until it's reconciled; one merely in flight settles sooner), or the autopilot's open warnings and
decisions. It reads only the executor's own state, once a minute, and announces each item once while it
stays open, across restarts too (`src/notify.ts`). Messages name the agent and link to the page where the
owner acts on the item; they never carry amounts, payees or balances, since Telegram sees them.
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (and optionally `NOTIFY_NAME`, `NOTIFY_LINK`) on the
executor's service; without them it does nothing.

## Invoices

The payout executor serves both the private dashboard and public invoice page through the same
grant, money lock and recovery loop. See [payout setup](docs/operations.md#payout-executor).

Anyone signs in with a full-access NEAR wallet key and files an amount and optional note for their
own account. An agreed payee's filing is an invoice; anyone else's is an **agreement request**, which is
never a payment. Agreements carry terms (an amount per invoice and a deadline), and the DAO can also
offer them first, as a purchase order or an award. Agreeing lists the payee in the policy by vote; the
payee then files the invoice, which is held for its own vote ([facilitator](docs/facilitator.md)).
The hosted dashboard reads the invoice host's agreements with a shared secret (`AGREEMENTS_URL`,
`AGREEMENTS_SECRET`; [operations](docs/operations.md#payout-executor)). Sign-in, storage, retries and
recovery are in [docs/architecture.md](docs/architecture.md#invoice-storage).

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
`nearcom:<the agent's wallet account>`, which the Funding page links to. Without the `nearcom:`
prefix, Trezu sends the payment out as a public withdrawal.

## Mainnet evidence

Each area's doc maps every claim to how it is known: [Payables](docs/facilitator.md),
[Treasury](docs/treasury.md). Every dated mainnet run, with its DAO proposal numbers, is in
[docs/mainnet-log.md](docs/mainnet-log.md). Operation ids and amounts are kept in a private record, since the
treasury is confidential; they are available to reviewers on request.

Beyond the briefs, the signed-out page lists how the hosts were shown to run on mainnet (`PROVEN` in
`web/src/beats.ts`):
- On the 2026-10-12 build ([DEMO.md](DEMO.md#what-is-verified)):
  - state survived a restart and a redeploy;
  - the autopilot ran on schedule;
  - each agent had one executor;
  - signed-out callers were refused every agent read.
- Every policy revision reproduces its hash, and the owner's grant and approval signatures verify
  ([log](docs/mainnet-log.md#policy-signatures-and-operation-proofs-2026-10-13t0410z)).

## Not done yet

The [enforcement assessment](docs/enforcement.md#status) tracks the current evidence for the signed
spending envelope, including cumulative limits, policy binding and execution-artifact trust.
A provider `FAILED` status is currently treated as terminal locally; it is not independently verified
as proof that a replacement payment is safe. See [recovery guidance](DEMO.md#the-live-moment-one-invoice-end-to-end-facilitator).

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
- An agent owned by a person's wallet was created and granted from a local dashboard on mainnet, and its
  autopilot then swapped under that grant on its own (2026-10-13, [mainnet log](docs/mainnet-log.md));
  behind the hosted gateway it is offline-tested only. Creating one signs a NEAR delegate
  action; the dashboard offers only the wallets HOT's near-connect list declares it for (today HOT, Meteor,
  Intear, Ledger and NEAR Mobile), read live; Meteor has signed through it so far.
- The owner's wallet picker loads HOT's near-connect wallet list from its `main` branch, unpinned, and each
  wallet's code from wherever that list points. The server checks every owner signature against what it
  prepared before relaying it, but a changed wallet could still phish for the owner's keys.
- Agreed terms (an amount per invoice and a deadline) are shown to voters beside each held payout;
  nothing refuses an invoice outside them.
- A DAO or other contract account can be paid, but can't ask to be paid on the invoice page: sign-in
  there needs a full-access key.
- The autopilot (off by default) hasn't yet run unattended for days. Outside the dashboard, its warnings
  reach the owner only through the optional Telegram notices (Notifications, above).
