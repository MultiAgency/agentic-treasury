# Deployment and migration

These instructions describe the repository configuration. Deploys, restarts and money actions are
performed by the owner. For the product and recorded results, see [README](../README.md).

Preserve the complete state when moving an executor: `.ops/`, `.invoices/` (including SQLite journals),
`.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, any legacy `.intake/` files, and its
settings file. Stop writers before copying state; never start the destination before stopping the
source. The lease coordinates processes on one host only.

## Dashboard

**Deploy the dashboard on Railway** (service `dao`: `Dockerfile.dashboard`, one replica, a volume at
`/data`). One container runs the public gateway (`src/gateway/server.ts`) and, on loopback beside it,
each agent server listed in `deploy/dashboard.json`. An agent with `"executor": false` runs approve-only.
All state lives on the volume in `/data/state`; the app stays in `/app`.

1. Create the service and attach a volume at `/data`. Point it at its Dockerfile with the variable
   `RAILWAY_DOCKERFILE_PATH=Dockerfile.dashboard`. The repository’s `railway.json` selects the payout
   `Dockerfile`; the dashboard uses its own Dockerfile. Set the healthcheck path to `/health`.
2. Set `NEAR_INTENTS_AGENT_API_KEY`, `NEAR_INTENTS_AGENT_API_URL`, `NEARAI_API_KEY`, `FASTNEAR_API_KEY`,
   and `SESSION_SECRET` (random, 32+ characters). `TRUST_PROXY=true` is set in the image.
3. For the first boot only, give each agent its settings file as a base64 variable: `DAO_ENV` and
   `PAYOUT_ENV` for `.env.dao` and `.env.payout`. To move an existing executor's state, also set
   `RESTORE_ARCHIVE` (a base64 gzipped tar of its complete state, listed above) and `RESTORE_SHA256`
   (that tar's SHA-256). `deploy/dashboard-entrypoint.sh` restores only
   when the checksum matches and no state exists, and writes a settings file only if it is missing.
   Delete these four variables once the service has started: they hold grant tokens and owner intents,
   which from then on live only on the volume.
4. Deploy with `railway up --service dao`. To test before DNS is in place, set `DASHBOARD_HOST` to the
   service's Railway domain. Sign-in is bound to that host instead of `host` in `deploy/dashboard.json`.
   Then point a CNAME at the target `railway domain status <domain> --service dao` shows, and remove
   `DASHBOARD_HOST`.

Each agent has exactly one executor, and nothing enforces that across machines: the executor lease
covers one host. Every other copy of an agent, such as the owner's laptop, sets `EXECUTOR=off`. Such a
copy needs no grant token (it shows the executor's grant, read from the API) and refuses to issue grants,
since the new token would be saved on the wrong machine. To move an executor back, stop the `dao`
service, copy the agent's state files out of `/data/state`, and remove `EXECUTOR=off` from the laptop's
settings file before starting it there.

To stop an agent's sends, freeze its policy by owner vote: the provider refuses every send while the
executor keeps reconciling. To stop one host from sending, set `EXECUTOR=off` there.

## Payout executor

The payout executor now serves both the private dashboard and public invoice page. Stop an existing
payout server before starting `ENV_FILE=.env.payout pnpm invoices`: the dashboard listens on loopback
port 8790 and invoices on 8791. Both use the payout agent's existing grant, money lock and recovery
loop. One host is the agent's executor; any other instance of the same agent, such as the owner's
local dashboard while the executor runs on Railway, sets `EXECUTOR=off`: it reads and approves as the
owner but never sends, reconciles or serves invoices. A lifetime lease prevents a second
current-version executor on the same host/user; it is not distributed fencing.
For an existing `pnpm server` or gateway-managed worker, set `INVOICES_PORT=8791` in that worker's
settings instead. A gateway can point at the already-running loopback worker without `envFile`.

**Agreements across hosts.** Agreement requests and offers live with the invoice page, in the payout
executor's `.agreements/`. The hosted dashboard's approve-only payout instance reads and answers them on
that host: set the same random `AGREEMENTS_SECRET` (32+ characters) on the invoices service and in the
dashboard's `.env.payout`, and `AGREEMENTS_URL=https://invoices.multiagency.ai` in `.env.payout`. Without
the secret on the invoices service, its `/internal/agreements` endpoint doesn't exist; without both on
the dashboard, its Agreements list reads its own (empty) store.

## Invoice migration and deployment

**Upgrade and migration:** stop old invoice/payout writers first and back up the complete persistent
state listed above before starting the new executor. Existing JSONL invoice history is imported read-only: recorded outcomes (paid, failed, refused) are shown as
they were, open ones as needing review, and missing business-to-payment links are never guessed. Non-invoice operations continue using their existing `.ops/` JSONL log;
new invoice operations are authoritative in SQLite and projected into the same activity/recovery
views. Each legacy file is moved to `.invoices/legacy/` once imported, so a stale writer can only start a new
file, which is imported in turn; its ids are never filed again. The `.sqlite.initialized` marker
prevents a missing database from silently becoming an empty one; restore the database rather than
removing the marker. Preserve SQLite journals and use a consistent backup. Do not roll back to an
old writer after new SQLite payments without reconciling/exporting the new records.

**Deploy on Railway** (`Dockerfile`, `railway.json`, one replica, one executor host per agent):

1. Move the payout executor and its persistent state together. Any other instance of this agent, such
   as the owner's local dashboard, runs with `EXECUTOR=off`. The database cannot coordinate with an
   independent volume.
2. Attach `/data` with the migrated state. Keep the existing payout agent's `AGENT_ID`,
   `AGENT_GRANT_TOKEN`, `NEAR_INTENTS_AGENT_API_KEY` and `NEAR_INTENTS_AGENT_API_URL` in the environment.
   These variables are its settings: what the service saves itself (a new grant token, the treasury link)
   isn't read back after a restart, so rotate its grant by changing `AGENT_GRANT_TOKEN` here.
3. Set `INVOICES_PUBLIC_HOST`, `INVOICES_SESSION_SECRET` (random, 32+ bytes), and optionally
   `INVOICES_TITLE`. Railway's `PORT` is the public invoice port; `AGENT_PORT` defaults to 8790 for
   private dashboard/RPC access inside the host. The public invoice listener exposes no dashboard RPC.
4. Review imported and unresolved records before submitting new invoices. An outcome without a
   correlation ID requires provider/operator investigation; there is no assumed lookup-by-key API.


## Journal v2 and owner-intent locking upgrade

This is an additive state-format migration. Stop the executor and every server/CLI that writes this
agent's operations or this instance's owner intents before installing the new build. Do not perform
an overlapping rollout with old writers: they do not participate in the owner-intent lock or write
journal submission claims.

1. Back up the complete state listed at the top of this guide, including `.ops/`, `.invoices/`,
   `.owner-intents/`, `.strategy/`, `.plans/` and `.evidence/`. Preserve SQLite journals and settings.
2. Keep existing JSONL and owner-intent JSON files in place. No rewrite or backfill is needed:
   unversioned operation records remain legacy, and missing submission evidence remains ambiguous.
   Never add `journalVersion: 2` to an old request to clear an unresolved operation.
3. Start only the new build. New non-invoice request lines carry `journalVersion: 2`; a separate
   `SUBMISSION_ATTEMPTED` line commits before the provider call. Startup/reconciliation acquires the
   money lock and may append `never_submitted` only to an unclaimed v2 preparation. Existing invoice
   records keep their SQLite schema and continuation rules.
4. Owner-intent JSON retains its format. All new writers lock its per-instance path and reload it
   before updating; expired preparations and settled-token cleanup run under that lock too. A dead
   writer's lock must become stale before takeover. Do not delete a live writer's lock.
5. Review unresolved operations before resuming work. An attempted operation without an ID still
   requires investigation. Do not downgrade to writers that ignore v2 claims or owner-intent locking;
   stop and review state compatibility before any rollback.

This migration preserves historical evidence and does not reinterpret legacy uncertainty as proof
of non-execution. The fixes have offline process-crash and concurrency coverage; deployment remains
a separate owner action.
