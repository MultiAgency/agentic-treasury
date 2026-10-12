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
An agent that swaps and shields toward a strategy without a vote per action.

**Payout agent**:
An agent that only makes confidential USDC transfers to agreed payees, each held for the owner's approval.

**Executor**:
The one instance that sends, reconciles and serves invoices for an agent. Any other instance of the same
agent is **approve-only**: it reads and approves as the owner, and never sends.
_Avoid_: primary, leader

## Mandate

**Policy**:
The owner-signed rules that the provider enforces: allowed actions, assets, caps, budget and destinations.
A policy is **in force** when it is applied, synchronized, not frozen, and bound to the agent's wallet.
_Avoid_: rules, config

**Mandate digest**:
The sha256 of a policy's canonical JSON, recorded with every plan and every money action.

**Grant**:
The owner's permission for this server to act for the agent, labelled with its **purpose**.
_Avoid_: token, credential (the grant token is only the secret that proves the grant)

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

**Strategy**:
The owner's target allocation and limits for a treasury agent. The autopilot acts only while its live
grant's label carries the digest of the strategy in force.

**Plan**:
A saved, expiring list of swaps and shields, bound to the policy and strategy it was made under.

## Money actions

**Operation**:
One money action in the agent's log, identified by its idempotency key from the write-ahead record
through its outcome.
_Avoid_: transaction, job

**Unresolved operation**:
An operation without a proven outcome. While one exists, no new operation may be sent.
_Avoid_: pending, stuck

**Held payout**:
A payout the provider holds for the owner's approval. Its outcome is open, but it can't be lost, so it
does not block new sends.
_Avoid_: pending approval (as a noun)

**Refusal**:
A proven outcome that nothing was sent, recorded with a code.

**Invoice**:
A payee's request to be paid, which becomes one payout operation with a stable key and immutable terms.
