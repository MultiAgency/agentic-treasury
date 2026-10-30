# treasury

An agent managing a Treasury's holdings for its wallet owner, built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.3.0.

It demonstrates one SDK surface: **Treasury's machine route** (`/machine/v1/a/<agent>`), reached with `ownerClient`, an absolute base and an owner-issued `tmc_` bearer credential. It covers Treasury agents only, owned by a wallet. A DAO-owned agent is refused, since a member's permissions aren't the DAO's consent. The app path (`appClient`, owner consents, payout requests) is demonstrated by the MultiAgency dashboard instead.

The platform host doesn't serve the machine route yet, so this runs against the platform's simulated stack at [`5cd4d4d`](https://github.com/MultiAgency/platform/commit/5cd4d4d). Its provider, chain, signatures and settlement are simulated. Pointing at a hosted platform is a separate decision. The host, agent and credentials live in `.env`.

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).

## What the agent may do

Each credential reaches only its scopes, and the scopes don't imply one another. `src/machine.ts` narrows `ownerClient` to them, so a call outside a credential's scopes doesn't compile, and the server refuses it with `forbidden` anyway.

| Scope | Procedures |
| --- | --- |
| `read` | `instance`, `overview`, `policyHistory`, `strategy/get`, `autopilot/get`, `activity`, `unresolved`, `autopilot/evidence`, `autopilot/log`, `ledger`, `ledgerCsv` |
| `prepare` | `rebalance`, `externalPlan` |
| `execute-plan` | `executePlan` |
| `sweep` | `sweep` |

Nothing on this route signs owner actions or changes policy, grants, schedules or payments.

## Run it on the simulated stack

Requires Node ≥ 24.22 and pnpm 12.15.

```sh
git clone https://github.com/MultiAgency/platform.git ../platform && git -C ../platform checkout 5cd4d4d
(cd ../platform && pnpm install --frozen-lockfile && pnpm test:e2e:stack --no-browser --treasury)
```

The stack prints `Isolated stack ready: <run>/stack/state.json`. Its Treasury agent is `portfolio`, owned by `owner.near`, with 100 simulated USDC. In this repository:

```sh
pnpm install
pnpm stack:credential <run>/stack propose        # the owner issues a read + prepare credential into .env
export NODE_EXTRA_CA_CERTS=<run>/stack/environment/localhost.crt
pnpm treasury status
```

`stack:credential` acts as the owner through the stack's `machineCredential` control. It writes the token to `.env` (mode 0600) and never prints it. Node reads `NODE_EXTRA_CA_CERTS` before it loads `.env`, so the stack's CA is exported in the shell instead.

## Commands

| Command | Credential | Effect |
| --- | --- | --- |
| `status` | `TREASURY_PROPOSE_TOKEN` (`read`) | Reads `overview`, `unresolved` and `activity`. Moves nothing |

Results print as JSON, decided by `kind`. Exit codes: `0` ok, `2` nothing was sent, `3` unknown (an action may have taken effect; read `activity` and `unresolved`, and never send it again).

## Checks

```sh
pnpm typecheck
pnpm test
```
