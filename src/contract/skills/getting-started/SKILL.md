---
name: getting-started
description: >
  Use when deciding how an app or external agent should work with MultiAgency agents through @multiagency/sdk: which client
  to use (owner or payee), how each kind of identity signs in and what the server enforces for it, how results report
  refused, unavailable and unknown outcomes, and what this package version supports. For owner tasks use owner-workflows;
  for payee tasks use payee-workflows.
metadata:
  purpose: 'Orients an app or agent author: the two clients, the four identities and their server-side limits, recovery kinds, and the supported surface of this package version.'
  type: lifecycle
  library: '@multiagency/sdk'
  library_version: '0.1.0'
sources:
  - 'MultiAgency/agentic-treasury-private:src/contract/index.ts'
  - 'MultiAgency/agentic-treasury-private:src/contract/payee-entry.ts'
  - 'MultiAgency/agentic-treasury-private:docs/agent-access.md'
---

# Working with MultiAgency agents

Each agent moves funds for its **owner** (a NEAR account or a Sputnik DAO) only inside the policy the owner signed.
This package gives apps and agents typed access to two kinds of work. It grants no authority: every call is authorized
by the gateway and the provider, never by the client or by this guidance.

1. Pick the client for the identity you act as (table below). Result: one of `ownerClient` (entry `@multiagency/sdk`) or
   `payeeClient` (entry `@multiagency/sdk/payee`, zod only).
2. Get that identity's session the supported way. Never handle a wallet's private key or copy browser cookies into an
   agent. Result: calls return data; a `session` (401) result means sign in again.
3. Do the task with owner-workflows or payee-workflows.
4. Keep every identity you send (`correlationId`, `commandId`, request `id`, `planId`) until you have read its outcome.

## Identities and what the server enforces

| Identity | How it is obtained | Reaches | Enforced server-side |
| --- | --- | --- | --- |
| Owner session | NEP-413 sign-in in a browser at the agent's host (`/gw/challenge` → wallet signs → `/gw/session`) | `/a/<agent>/rpc/*` through `ownerClient` | Access per agent from the wallet owner, or from the DAO policy for a member (propose, vote; execute and manage derived). A member never acts or spends as the DAO alone: owner actions need the owner's signature (a DAO vote). Calls outside access: 403. |
| Treasury machine credential | Issued by a wallet owner of a Treasury agent from the owner's session (`tmc_…` bearer) | `/machine/v1/a/<agent>/rpc/*` (Treasury's skill helper, not this package) | Fixed scopes (read, prepare, execute-plan, sweep), expiry, revocation, the owner's fresh access re-checked per call. Treasury only; DAO owners cannot issue it. |
| Payee session | NEP-413 sign-in on the payee entry (`/api/signin`) | `/api/*` on that entry through `payeeClient()` | Only the signed-in account's own invoices, work orders and reports. An account that has only requested onboarding terms is not yet a payee: an agreement makes it one. |
| Agent connection | Started by the payee from their signed-in browser session (`tac_…` bearer, shown once) | `GET`/`POST /api/compensation`, `GET /api/compensation/session` through `payeeClient({ base, token })` | Bound to host, entry, account and payout agent; expiry (at most 24h) and revocation; every other route 403 with no effect; never a browser session; each call attributed. |

## Results: decide by `kind`, never by message text

| `kind` | Meaning | What to do |
| --- | --- | --- |
| `ok: true` | The answer, validated against this version's schema | Use `value` |
| `session` | 401: no valid session | Sign in again (agent connection: start a new one) |
| `forbidden` | 403: this identity may not do this | Do not retry; it is a permission, not an outage |
| `refused` | Refused before anything was sent (optional `code`) | Correct the input or state, then act again |
| `busy`, `unresolved` | Owner money actions: another action holds the lock, or an earlier one has no proven outcome; nothing was sent | Follow existing operations, then try again |
| `provider` | The provider refused (proven) or a read failed at the provider | Check the recorded outcome before acting again |
| `unavailable` | A read failed or lost its answer | Reading again is safe |
| `unknown` | An action was sent and its outcome is not known (`identity` kept) | Never resend. Read the record by the kept identity |

## What this package version supports

`@multiagency/sdk` 0.1.0, entries:
- `@multiagency/sdk`: `ownerClient`, `ownerContract` and owner schemas, `mayCall` (display only), schemas for runs and proposals. Peers: zod ^4.6.7, `@orpc/client` and `@orpc/contract` 2.0.0-beta.44, `@ag-ui/core` 1.0.2.
- `@multiagency/sdk/payee`: `payeeClient`, payee and compensation schemas, agent-connection schemas. Peer: zod only.
- `@multiagency/sdk/release-server`: the shared release server for app releases.

The payee entry's capability ids are still `supplier-*-v1` (check them with `payeeClient().capabilities()`); an agent
connection's `role` is `PAYEE_ROLE`. Compare against the exported constants, never against literal strings.

## Completion

The task is done when the client answers `ok` for the reads you need and every action's outcome has been read by its
kept identity. If a result is `unknown`, the task is not done until the record is read; if it stays unreadable, report
it rather than acting again.
