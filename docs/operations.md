# Operations

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

## Unattended run: observing the treasury autopilot

How a 24-hour observation of the scheduled autopilot is started, recorded and reported. It answers one
question: does the scheduler run on its own without missed ticks, duplicate execution, actions outside its
schedule, or manual recovery? It says nothing about custody guarantees or economic benefit
([enforcement](enforcement.md)).

### What records the evidence
- **The scheduler itself**, not a watcher, appends synced lines to `.evidence/<agent id>.jsonl` in the
  agent's state directory (on `dao`, `/data/state/.evidence/`, a volume with backups enabled). See
  src/evidence.ts.
  - **`start`, written before the tick acts:** a unique tick id, the trigger (`schedule` or `operator`),
    the scheduler's recorded settings (on, interval, limit, and the run its schedule counts from), and the
    build: Railway's deployment id plus sha256 digests of the `src/` tree, `pnpm-lock.yaml` and
    `package.json`. Also the policy revision and digest, the strategy digest, and the live grant's id and
    label (never the token).
  - **`end`, written after:** the book, drift, budget usage and unresolved operations before and after;
    the plan with its legs and quotes; each step's and shield's status and correlation id; rejection
    reasons; a proven refusal's code; and the tick's own summary.
- **Write failures:**
  - If the start can't be written, the tick doesn't run and the inbox says so.
  - If the end can't be written, the inbox says so.
  - A start without an end is reported as incomplete (interrupted, or outcome unknown), never as success
    or failure.
  - A line that doesn't parse, such as a torn final line, is counted as unreadable, not trusted.
  - Every log here appends through one function (`src/synced.ts`). After a torn final line, the next
    record starts its own line, so a crash mid-append loses only the torn line (offline-tested,
    `test/synced.test.ts`).
- **Interventions:** the gateway records every operator call beyond a member's reads in
  `.evidence/interventions.jsonl` (account, agent, procedure, time) before forwarding it. If the record
  can't be written, the call isn't run. Calls made on a host directly (CLI, shell) are not in this record.
  An unreadable line in the record is counted and fails the "no operator interventions" criterion, since
  it may have been a call. Builds up to c25b61b skipped such lines instead; `pnpm run-report` refuses a
  gateway that doesn't count them.
- **Reading the records:** `autopilot/evidence` on the treasury agent server, and `/gw/interventions`
  (operator-only). In the build under observation (fe3330c), `autopilot/evidence` is operator-only too, so
  the gateway records each read of it in the intervention record; the report lists those reads separately as
  operator reads, not interventions. Later builds make it a member read, which the gateway doesn't record.
- **The report:** `pnpm run-report` (src/run-report.ts, logic in src/report.ts, tests in
  test/report.test.ts). It reads the evidence, the intervention record and the books, and reports:
  - each criterion;
  - configuration segments (build, mandate or scheduler settings);
  - every tick's outcome: executed, no-op, refused, failed, skipped or incomplete;
  - the incident behind each failed criterion.

Nothing depends on a chat session or a laptop staying up. Collection runs only while a build containing
src/evidence.ts runs on `dao`.

### How the report judges
- **Scheduled work:**
  - Only completed scheduled ticks count. Operator, skipped and incomplete ticks are named inside any gap
    they fall in.
  - Each gap is judged by the interval the later tick recorded, plus 3 minutes.
  - Records are sorted, and both window bounds apply.
- **Duplicates:**
  - "Duplicate references" (an operation or plan named by two ticks) is reported apart from duplicate
    execution.
  - Duplicate execution is confirmed only when one plan leg settled twice. An execution no tick recorded
    with the same terms as one a tick recorded is a suspected duplicate: separate operations can share
    terms.
  - If executions no tick recorded exist without such a match, the answer is "cannot be established",
    not "yes".
- **Unresolved operations** seen at a tick are reported as an observation. Interventions come only from
  the gateway's record and operator-triggered ticks, so "none" means none recorded there.
- **Refusals** show a control was invoked, not that it refused correctly. A failed shield or step, or an error, is a failure.

### Starting a window
1. Deploy a build whose `src/` contains authorization, evidence collection and the execution-mode
   removal, from a reviewed snapshot. Record the deployment id, image digest, and the snapshot's `src/`,
   lockfile and `package.json` digests.
2. Confirm the autopilot is on and hourly, and that the live grant approves the strategy in force.
3. Wait for the first scheduled tick. Its start line must match the deployment id and all three digests.
   Its end line fixes the starting book, budget and mandate.
4. The window starts at that tick, in UTC, and ends 24 h later.

### During the window
- Don't press "Run now".
- Don't force imbalances, raise limits or manufacture trades.
- A correct no-op or refusal is a valid outcome.
- Any operator action, payment or approval in the window is reported as an incident, not hidden.
- If the build, policy, strategy or grant changes, the report starts a new segment. Evidence from earlier
  segments still counts for its own configuration.

### Generating the report
Sign in to the dashboard as an operator in a browser. Save the `dao_session` cookie to a 0600 file, never
pasted anywhere. Then run:

    DASHBOARD_URL=https://proto.multiagency.ai REPORT_COOKIE_FILE=<file> \
    SINCE=<window start> UNTIL=<window end> OUT=<report.md> pnpm run-report

### Success
- **The run succeeds when** it has, with incidents recorded honestly:
  - no unexplained missed ticks;
  - no duplicate execution;
  - no execution outside scheduled ticks;
  - no unresolved operation needing manual recovery;
  - every tick able to read its book and mandate.
- **No particular number of swaps is required.**
- **Reported separately from the result:** operational reliability is one thing. Custody guarantees (atomic
  budgets, strict monthly caps, the bought asset) and economic benefit are separate claims that one day
  doesn't support.
