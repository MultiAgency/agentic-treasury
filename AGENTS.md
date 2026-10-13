# Agentic Treasury — agent guide

An AI agent moves a DAO's or wallet's funds on NEAR Intents mainnet, only inside a policy the owner
signed. The product is **credibility**: a reviewer must be able to check every claim we make. Real
funds move; treat every change near the money path as a change to a bank.

Vocabulary is in `CONTEXT.md`: use its terms in code, tests, docs and conversation (owner, executor,
policy, grant, purpose, authorization, operation, unresolved, held payout, refusal). Read it first.

## Where things are
- `README.md` — what runs, how to start it, the first mainnet results, and **Not done yet**.
- `docs/architecture.md` — which files are shared core, facilitator or treasury; the one send site.
- `docs/money-path.md` — the local safeguards: dispatch, journal, reconciliation, invoice storage,
  checks before each send. `docs/mainnet-log.md` — later dated mainnet runs.
- `docs/operations.md` — deployment, executor migration and state preservation.
- `DEMO.md` — the hosted walkthrough (kept out of the app so copy edits don't redeploy `dao`).
- `docs/enforcement.md` — what the signed envelope guarantees today and the sequence to close gaps;
  `docs/signed-envelope.md` + `docs/envelope/` — threat model, acceptance, verification record.
- `docs/unattended-run.md` — how autopilot evidence is collected and reported.

## The money path
Files: `src/agent.ts` (dispatch), `authorize.ts`, `lock.ts`, `ops.ts`, `plans.ts`, `treasury.ts`, `autopilot.ts`,
`invoices.ts`, `invoice-store.ts`, `payouts.ts`, `payment-approval.ts`, `owner-intents.ts`,
`owner-requests.ts`, `owner.ts`, `recover.ts`, `reconcile.ts`, `probes.ts` (live refusal probes send
for real). Invariants every change keeps:
- **One send site.** Every submission (dashboard, CLI, invoice, autopilot) goes through `dispatch`:
  under the money lock, no unresolved operation, write-ahead record, then send.
  `test/send-path.test.ts` enforces it.
- **Fail safe.** An unknown outcome stays unresolved and blocks new sends; it never authorizes
  another send. Ambiguous replay stays blocked. Missing evidence refuses; it is never trusted.
- **Provider-first.** The provider enforces the policy; `authorize.ts` adds only checks the provider
  can't make (policy in force, live grant for the purpose, output asset, duplicate held payout, plan
  binding). It is pure: no fetch, send, record or `Date.now()`. Ask before adding a rule there.
- **One executor per agent.** Any other instance runs `EXECUTOR=off` (approve-only: reads and
  approves, never sends). The lease is single-host, not distributed fencing; say so where relevant.
- **Approvals are verified from provider evidence** and re-checked right before signing; an attempted
  owner signature is poll-only after restart, never resubmitted.
- **Mandate digest** (`src/mandate.ts`) is recorded with every plan and money action.

## Live systems
- Hosts: https://proto.multiagency.ai (`dao` service: gateway + treasury executor + payout
  approve-only) and https://invoices.multiagency.ai (payout executor). Railway, one replica each,
  state on the `/data` volume.
- Deploys, restarts and dashboard money actions are the user's. Prepare and verify; let them ship.
- The signed-out public page shows only what is public on chain (DAO roles and proposals). No
  balances, amounts, payees, policies or invoice data. `test/public.test.ts` pins
  `src/gateway/public.ts`'s imports.
- `pnpm refusals --live` and `pnpm test:live` move or touch real funds: run only when asked, never
  scheduled. `pnpm smoke` is the read-only check of both hosts.
- An unattended run or freeze may be in progress: ask the user before editing money-path files.

## Calibrated claims
Every sentence in README, DEMO.md and docs states exactly what was shown, and how:
- Mainnet facts cite evidence: op id, proposal number, tx hash, deployment id, date (UTC).
- Distinguish *offline-tested*, *mainnet-observed*, *per provider docs/source (pinned commit)*, and
  *unverified*. A deployed provider version is never assumed from its source.
- A newly found gap goes into **Not done yet** or `docs/enforcement.md` in the same change.
- A claim the code no longer supports is fixed or removed in the same change.

## Working here
- Other sessions edit this repo concurrently. When files change unexpectedly, check which sessions
  are active and ask the likely owner before editing or attributing; agree on file ownership.
- Designs already confirmed with the user (authorize, journal, owner-intents) are built as recorded;
  settled questions stay settled.
- Reproduce before fixing: a failing test, an offline fault test, or recorded mainnet evidence.
  Provider behaviour is a hypothesis until observed or found in pinned source.
- Tests are offline by default (`test/offline.env`). Crash and concurrency tests use real SQLite and
  child processes; keep them that way.

## Done means
- `pnpm typecheck` and `pnpm test` pass; new money-path behaviour has a test that fails without it.
- `CONTEXT.md` updated when a concept is added or renamed.
- README/DEMO/docs claims match the change (see Calibrated claims).
- State-format changes ship with a migration that requires a stopped executor and preserves
  `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`.
