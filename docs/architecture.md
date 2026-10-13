# Architecture

Two prototypes share one core. Each agent runs in its own instance of the server (`src/server.ts`),
with its own wallet, grant, money lock and logs; the hosted gateway signs members in and forwards
their calls to those instances. Files are listed under `src/` unless a path says otherwise.

## The one rule

**One send site.** Every money action, whichever prototype starts it, goes through `dispatch` in
`agent.ts`: under the money lock, with no unresolved operation, a write-ahead record, `authorize`, then
the provider call. `test/send-path.test.ts` fails if any other file sends. The callers are
`invoices.ts` (an invoice's payment), `treasury.ts` and `plans.ts` (shields, swaps, sweeps), `probes.ts`
(refusal probes) and `agent.ts`'s own `pay` (a payment by hand).

## Shared core

| Concern | Files |
|---|---|
| Sending | `agent.ts` (dispatch), `authorize.ts` (checks the provider can't make; pure), `lock.ts`, `executor-lease.ts` |
| Records | `ops.ts` (the operation journal), `recover.ts`, `reconcile.ts`, `synced.ts`, `evidence.ts`, `inbox.ts` |
| The owner's rules | `policy.ts`, `mandate.ts` (the digest), `grants.ts`, `owner-intents.ts`, `owner-requests.ts`, `owner.ts`, `dao-owner.ts`, `nep413.ts`, `chain.ts` |
| Provider and values | `api.ts`, `holdings.ts`, `value.ts`, `ledger.ts` |
| Serving | `server.ts`, `router.ts`, `http.ts`, `signin.ts`, `env.ts`, `notify.ts` |

## Confidential Treasury Facilitator (the payout agent)

| Concern | Files |
|---|---|
| Intake | `invoice-http.ts` (the public invoice page, `/internal/agreements`), `agreements.ts` (requests, offers, terms), `invoices-server.ts` |
| Payments | `invoices.ts` (files an invoice through dispatch), `invoice-store.ts` (SQLite: identity, revisions, reservations), `payouts.ts` (held payouts) |
| Approval | `payment-approval.ts` (checks a held payout against provider evidence before the owner signs) |

## Agentic Treasury Management (the treasury agent)

| Concern | Files |
|---|---|
| Planning | `treasury.ts` (rebalance legs, quotes, sweep), `plans.ts` (saved, expiring plans executed once), `strategy.ts`, `strategy-digest.ts` |
| Running alone | `autopilot.ts` (the scheduled tick: sweep, then rebalance within its limit) |
| Experimental | `llm.ts` (the steward, reached only at `/steward`) |

## Around them

- **Gateway** (`gateway/`): member sign-in from the DAO's roles (`roles.ts`), which calls each role may
  make (`allowlist.ts`), the public on-chain page (`public.ts`, pinned by `test/public.test.ts`), and
  proposal decoding for "What am I voting on?" (`proposals.ts`, `sign-requests.ts`).
- **Web** (`web/src/`): one app for both prototypes. `lib.ts` `kindOf` picks the prototype from the
  agent's policy; `beats.ts` holds each prototype's claims and how each is known; `showcase.tsx` shows
  them.
- **Command line**: `create-agent.ts`, `issue-grant.ts`, `revoke-grant.ts`, `update-policy.ts`,
  `archive.ts`, `inspect.ts`, `books.ts`, `refusals.ts`, `smoke.ts`, `run-report.ts`, `report.ts`, `remote.ts`.

Files stay in one folder for now; moving them into these groups is a separate change, made in a quiet
window, since it touches nearly every import.
