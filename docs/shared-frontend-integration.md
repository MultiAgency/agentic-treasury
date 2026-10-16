# Independently built product frontends

Proto can serve an independently built product frontend on a configured host while retaining its
same-origin gateway, host-bound sign-in and per-agent authorization. The frozen r2 integration
was deployed on 2026-10-16 UTC; see the [execution record](proto-release-execution.md) for
the exact deployment, hosted checks and remaining limits. Offline integration tests remain
separate evidence and do not establish live money flows or state migration.

## Configuration

Add `frontendDist` to an existing entry in `dashboard.json`'s `hosts` map, for example:

```json
"frontendDist": "/app/frontends/treasury"
```

The value must be an absolute directory containing the built `index.html`. Configuration loading
fails if that entry is missing or is not a file. Paths come from deployment configuration, never
from a query parameter or forwarded header. Preserve that host's agent assignments and areas.
Hosts without the field retain Proto's `web/dist`. Supplier intake keeps its existing routing.

The configured build serves the host's page routes, scoped `/a/<instance>/` pages, and static assets.
`/gw/*` and `/a/<instance>/rpc/*` continue through Proto's gateway. The actual request Host selects
both the build and sign-in audience; `X-Forwarded-Host` cannot select either. Each frontend runs
under its own product origin, with no cross-origin cookie sharing or CORS relaxation.

The default image builds only Proto's frontend. The shared-frontend release image must separately
package the selected product build at the configured path. DNS changes, image assembly and
rollout are not performed by the integration test. Keep one executor per agent; serving another
frontend does not require starting the sibling repository's gateway or executor.

## Treasury consumer contract

The Treasury repository retains standalone support and adds a shared-gateway adapter:

- `GET /gw/me`: `selfService: true` and `setupAreas` containing `treasury` enable Treasury setup.
  Explicit shared-host restrictions take precedence over `selfServiceTreasury`.
- Shared reservation: `POST /gw/agents` with `{ owner, kind, area: "treasury" }`, returning `{ name }`.
  The wallet owner comes from the authenticated viewer. Navigate to `/a/<name>/`.
- Standalone reservation retains `/gw/treasuries` and its existing input format.
- Malformed hosted discovery stays unavailable. HTML fallback is allowed only for intentional
  HTTP loopback local development outside `/a/` routes.

Reservation signs nothing and creates no provider agent. Owner signing, grants and money actions
retain their existing separate flows. The adapter does not migrate `.treasuries/` registrations
into Proto's `.hosted/` registry or reassign existing executors.

## Offline verification

Build the consumer repository independently, then run from Proto:

```sh
node scripts/test-shared-frontend.mjs /absolute/path/to/treasury/web/dist treasury
node scripts/test-shared-frontend.mjs /absolute/path/to/payables/web/dist payables
```

The runner accepts a built artifact rather than importing sibling server source. It removes
application credentials, points provider configuration at offline fixtures, and blocks Node
connections outside loopback. The browser blocks other hosts, popups and WebSockets; its two
fixture hostnames are forwarded over loopback to the real Proto gateway.

The check exercises a real NEP-413 challenge/signature and session, shared discovery, navigation
into an agent, scoped reads, missing-agent denial, signed-out denial, another owner's denial,
sibling-host session isolation, and HTML-discovery failure. The wallet key, chain responses and
agent observations are fixtures. Owner signing and money calls are absent. This establishes
frontend/gateway compatibility in the fixture, not provider behavior or mainnet readiness.

`test/frontend-config.test.ts` covers missing builds, relative path rejection and the optional
legacy default. Treasury owns its adapter tests and standalone regressions. The shared browser
check is explicit because it requires the independently built sibling artifact and Chromium.

## Payables consumer contract and verification

Shared hosts always advertise `setupAreas`, including `[]` when setup is disabled or no area is
assigned. Omitting this field would let a consumer mistake a shared host for a standalone gateway.
`test/shared-discovery.test.ts` reproduced that omission before the gateway fix and covers both
host restrictions and the global setup switch.

Payables enables setup only for `selfService: true` with `payables` permitted by `setupAreas`.
It reserves through `/gw/agents` using the authenticated wallet owner and `area: "payables"`, then
navigates to `/a/<name>/`. Its standalone `/gw/payables` behavior remains owned by the Payables repo.
Managed reservations advertise `managed: true` so setup retains their owner and area.
Shared supplier links come from the selected agent's `invoices` field; missing links must not fall
back to the global intake. A supplier page is public entry, while private supplier records require
that instance's supplier session.

The Payables browser variant additionally checks a real offline reservation for a second wallet
owner, scoped navigation, admission after child startup, and its discovered `/i/<name>/` supplier
URL. A configured agent with no supplier URL displays the unavailable message even when a global
legacy intake is configured. Wallet, chain and agent observations are fixtures; no owner action
or payment is submitted. The fixture waits for child readiness and reloads after reservation; this
does not establish automatic UI recovery during a slow production startup.

`test/hosted-gateway.test.ts` separately exercises the real managed supplier routing and verifies
that a supplier cookie cannot read another instance's work orders, even if its cookie name is
changed. These server checks complement the browser check; they are not a single deployed journey.
Positive supplier-link rendering and exact work-order query preservation remain covered by the
Payables repository's reported adapter/browser tests, not by this real-gateway browser fixture.
Deployed wallet behavior, positive work-order journeys across both built frontends, image packaging,
DNS and rollout remain unverified here.

Validation on 2026-10-15 UTC: Proto typecheck and 741 offline tests passed. The independently
built Treasury and Payables artifacts each passed the shared browser check. Run these commands
sequentially with `pnpm test`: managed-agent fixtures allocate ports from the same 9000–9999 range.
The Payables check initially failed during fixture development and concurrent runs; the final
separate run passed. No sibling source edits, deployment, restart of live services, migration or
live-funds tests were performed.


## Explicit supplier entry for an existing payout agent

The shared-frontend candidate configures `agents[].invoices` for the existing static `payout` as
`https://invoices.multiagency.ai/submit`. This is a deliberate mapping to its retained invoice
executor, not a global fallback. The field is optional, allowed only for `area: "payables"`, and
must be HTTPS without credentials or a fragment. Query fields are preserved. Static entries
without it still advertise no supplier URL. Managed registrations retain their generated scoped
supplier URL and never inherit this static mapping.

The Payables integration test verifies discovery, the selected static agent's invoice link, the
exact retained work-order query and reload, alongside a separate missing-link agent and managed
supplier routing. `test/static-supplier-route.test.ts` checks the production route/proxy forwarding
two different work-order IDs and other query fields without replay; only its HTTPS transport is
adapted to a loopback fixture. The public `/submit` route still reaches the retained invoice
executor. No executor assignment, grant, owner signing or state format changes are included.

Fallback review: public generated-domain challenge reads on 2026-10-15 still returned recipients
`treasury.multiagency.ai` and `payables.multiagency.ai`. These observations do not establish working
owner sign-in or private access on the generated domains. That release gate remains open until
owner-controlled browser verification is returned; no domain move or standalone restart occurred.
