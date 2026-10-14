# Agentic Treasury

An AI agent moves an owner's funds on NEAR Intents, only inside a policy the owner signed. This glossary
names the concepts that the code, tests and reviews share.

## Parties

**Owner**:
The wallet or Sputnik DAO that signs the agent's policy, issues its grants and approves held payouts.
_Avoid_: admin, user

**Agent**:
One Agent API agent with its own wallet, policy and grant, run by one instance of this server.
_Avoid_: bot, worker

**Treasury agent**:
An agent that swaps and shields toward a strategy without a vote per action. It runs the **Treasury**
area (docs/treasury.md).

**Payout agent**:
An agent that only makes confidential USDC transfers to agreed payees, each held for the owner's approval.
It runs the **Payables** area (docs/facilitator.md).

**Area** / **Brief**:
An area is what one agent shows: **Payables** (the payout agent) or **Treasury** (the treasury agent). A
brief is an experiment from the Agent Connect catalog that an area runs or plans, keeping its catalog
number and title (01 Confidential Treasury Facilitator, 02 Agentic Treasury Management). Each brief's
requirements distinguish mainnet observations, offline tests, pinned provider source with deployed
behavior unverified, and requirements not yet demonstrated.
_Avoid_: prototype (for an area), use case

**Executor**:
The one instance that sends, reconciles and serves invoices for an agent. Any other instance of the same
agent is **approve-only**: it reads and approves as the owner, and never sends.
_Avoid_: primary, leader

**Member** / **Operator**:
Who may use the hosted dashboard, decided per agent from its owner. A member is named in one of the
owner DAO's group roles (a token-weighted role names no one): reads everything and may file owner actions
as proposals. An operator may also move money and change settings: an owner that is a wallet, for its own
agents, or an account named beside an agent in the dashboard's configuration, for that agent.

## Mandate

**Policy**:
The owner-signed rules that the provider enforces: allowed actions, assets, caps, budget and destinations.
A policy is **in force** when it is applied, synchronized, not frozen, and bound to the agent's wallet.
_Avoid_: rules, config

**Mandate digest**:
The sha256 of a policy's canonical JSON, recorded with every plan and every money action.

**Grant**:
The owner's permission for this server to act for the agent, named by its **grant label**.
_Avoid_: token, credential (the grant token is only the secret that proves the grant)

**Grant label**:
What a grant is for, signed by the owner: `treasury`, `payout` or `invoices`, optionally followed by a
suffix such as a strategy digest (`treasury:<digest>`). Each purpose names the labels that may act for it.

**Purpose**:
Why a send or approval happens: `treasury`, `autopilot`, `payout`, `invoice` or `approval`. A purpose
decides which rules apply and which grant labels may act for it.
_Avoid_: kind, type

**Authorization**:
The single decision of whether a send or approval, with a given purpose, may go ahead, covering what
the provider can't check itself. It decides; it never fetches, sends or records.
_Avoid_: guard, gate, check

**Agreed payee**:
A recipient listed as a confidential transfer destination in a policy whose destinations mode is
`only`. A policy in `except` mode has no agreed payees.
_Avoid_: allowlisted address, destination

**Agreement**:
An owner's consent to pay a payee, with **terms**: an amount ceiling per invoice and a deadline. A payee
*requests* one from the invoice page (an **agreement request**), or the owner *offers* one first (a
purchase order, a bounty or grant award). Agreeing makes the payee an agreed payee by policy update;
the terms are this server's record, shown beside each held payout, and enforced by the vote on it.
_Avoid_: whitelist entry, PO (unless it is one)

**Strategy**:
The owner's target allocation and limits for a treasury agent. The autopilot acts only while its live
grant's label carries the digest of the strategy in force.

**Plan**:
A saved, expiring list of swaps and shields, bound to the policy and strategy it was made under.

**Rebalance**:
Planning swaps toward the strategy's target allocation: legs under its minimum are left alone, legs that
could cost more than its cap at their floor are left out, and the rest are saved as a plan. Nothing moves
until the plan is executed.

**Steward**:
An experimental LLM that proposes a plan in conversation, its responses verified against its TEE. It only
proposes; the plan executes like any other.

## Money actions

**Operation**:
One money action in the agent's log, identified by its idempotency key from the write-ahead record
through its outcome. New non-invoice operations record preparation and then a durable submission
claim before the provider call. A preparation without a claim proves it was never submitted; a claim
without an outcome remains unresolved. Legacy records without this distinction remain unresolved.
_Avoid_: transaction, job

**Unresolved operation**:
An operation without a proven outcome that blocks new sends: any but a held payout or a prepared
invoice, which are open but can't be lost. While one exists, no new operation may be sent.
_Avoid_: pending, stuck

**Held payout**:
A payout the provider holds for the owner's approval. Its outcome is open, but it can't be lost, so it
does not block new sends.
_Avoid_: pending approval (as a noun)

**Refusal**:
A proven outcome that nothing was sent, recorded with a code.

**Sweep**:
Shielding every public balance into the confidential one: the agent keeps nothing public.

**Money lock**:
The lock every money action runs under: one money-moving run at a time across this host's processes,
refused while an unresolved operation exists. It is single-host, not distributed fencing.

**Owner intent**:
An owner action (create, grant, freeze, policy update, approval vote) prepared by the server and signed
by the owner's wallet or a DAO vote, kept `prepared → submitted → settled` so a restart follows it.

**Invoice**:
A payee's request to be paid, which becomes one payout operation with a stable key and immutable terms. Until it is
submitted it is **prepared**: nothing is in flight, so it is not an unresolved operation.

## Autopilot and records

**Autopilot**:
The treasury agent acting on its own schedule, off by default: each **tick** reads the status of open
operations, sweeps, and executes a rebalance only up to the strategy's auto-execute limit. A tick whose
start can't be recorded does not run; a missing end means it was interrupted or its outcome is unknown.
_Avoid_: bot, cron job

**Tick**:
One autopilot run: sweep, then rebalance if the strategy's grant approves it and the plan fits the
limit. Scheduled on the strategy's interval, counted from the previous tick's end, or run by an
operator. Each records a start and an end in the evidence. New ticks also record intermediate stage
starts/returns and provider-accepted submissions in a supplementary progress file. These observations
never authorize a send or establish settlement; older ticks have no reconstructed stages.

**Run log / Recording**:
A private, versioned projection of a tick's recorded observations into AG-UI events. It preserves the
tick's outcome separately from later journal observations. Missing timing stays unknown; a recorded
tick end does not prove every operation settled. It never authorizes a money action. The adapter is
offline-tested. Members can export a recording from its executor and inspect its recorded observations
in the dashboard. The inspector is read-only, with no timed playback or live stream; it keeps source
gaps, unknown timing and later observations explicit. The inspector and export access controls are
tested offline, not mainnet-observed.

**Inbox**:
What the agent tells its owner while no one is watching: a record of each tick, and warnings or
requests that stay open until the owner dismisses them.

**Books**:
The agent's balances checked against outside records: public balances against chain transfers,
confidential balances against the API's recorded executions. A difference is unexplained: it can reflect
outside credits or incomplete records.

**Intervention**:
An operator call through the hosted dashboard beyond what a member may do, recorded before it runs
(or not run). The unattended-run report counts them.
