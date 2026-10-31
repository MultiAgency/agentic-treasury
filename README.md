# treasury

An agent managing a Treasury's holdings for its wallet owner, built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.3.0.

It demonstrates one SDK surface: **Treasury's machine route** (`/machine/v1/a/<agent>`), reached with `ownerClient`, an absolute base and an owner-issued `tmc_` bearer credential. It covers Treasury agents only, owned by a wallet. A DAO-owned agent is refused, since a member's permissions aren't the DAO's consent. The app path (`appClient`, owner consents, payout requests) is demonstrated by the MultiAgency dashboard instead.

The platform host doesn't serve the machine route yet, so this runs against the platform's simulated stack at [`5cd4d4d`](https://github.com/MultiAgency/platform/commit/5cd4d4d). Its provider, chain, signatures and settlement are simulated. Pointing at a hosted platform is a separate decision. The host, agent and credentials live in `.env`.

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).

## What the agent may do

Each credential reaches only its scopes, and the scopes don't imply one another. `src/config.ts` fixes the scopes each role's credential is issued with, and `src/machine.ts` narrows `ownerClient` to them. A call outside a role's scopes doesn't compile, and neither does using one role's client where another's scopes are expected. The server refuses either with `forbidden` anyway.

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

`stack:credential` acts as the owner through the stack's `machineCredential` control. It takes a role (`propose`, `execute` or `sweep`) and an optional lifetime in whole seconds from 60 to 86400 (default 3600), and prints the platform's error if issuing fails. It writes the token into `.env` through a new 0600 file renamed over it, so the token is never readable under another mode. Other lines, comments and blank lines are kept, and the token is never printed. Node reads `NODE_EXTRA_CA_CERTS` before it loads `.env`, so the stack's CA is exported in the shell instead.

## Commands

The agent proposes and the owner approves, each with its own credential:

| Command | Credential | Effect |
| --- | --- | --- |
| `status` | `TREASURY_PROPOSE_TOKEN` (`read`) | Reads `overview`, `unresolved` and `activity`. Moves nothing |
| `plan` | `TREASURY_PROPOSE_TOKEN` (`prepare`) | `rebalance`: quotes legs toward the owner's saved targets and saves a plan. Moves nothing |
| `plan swap <from> <to> <amount>` | `TREASURY_PROPOSE_TOKEN` (`prepare`) | `externalPlan`: quotes one chosen swap (atomic units of `<from>`) and saves a plan. Moves nothing |
| `execute <planId> [--yes]` | `TREASURY_EXECUTE_TOKEN` (`execute-plan`) | The owner's approval: executes a saved plan, which the executor claims at most once |
| `sweep [--execute [--yes]]` | `TREASURY_SWEEP_TOKEN` (`sweep`) | Previews, or shields, managed public balances |

`execute` and `sweep --execute` move funds only with `--yes` or a "y" answered at a terminal; otherwise they send nothing. Results print as JSON values, one after another (stream events as they arrive, then `{ outcome }`), decided by `kind`.

| Exit | Outcome | Meaning |
| --- | --- | --- |
| `0` | ok | Every leg (or shield) reported `SUCCESS`, or a read or proposal succeeded |
| `2` | `refused`, `forbidden`, `session`, `busy`, `unresolved`, `provider`, `unavailable` | Nothing was sent |
| `3` | `unknown` | An action may have taken effect: its answer was lost, or a leg's status isn't final |
| `4` | `partial` | At least one leg or shield was sent, and not every leg succeeded. Funds may have moved; read activity and unresolved before acting again. The outcome lists each leg's status and `correlationId` |

`execute` and `sweep` are decided from the legs they report, not from how their stream ends. The executor can reject a plan before any leg or after earlier legs moved funds, and it ends normally after a leg that didn't succeed.
- A leg counts as sent unless its status is `NOT_SENT`, or if a shield before it was sent.
- `rejected` with nothing sent is `refused` (2).
- Anything sent, followed by `rejected` or a leg that isn't `SUCCESS`, is `partial` (4). `FAILED` and `REFUNDED` don't prove that nothing moved.
- A status other than `SUCCESS`, `FAILED`, `REFUNDED` or `NOT_SENT` hasn't settled, so the outcome is `unknown` (3).
- A throw after the stream's first event, including one in the CLI's own output, is `unknown` (3).
- A lost sweep preview (`sweep` without `--execute`) is `unavailable` (2), with no records read: a preview takes no money lock and returns before any send.

Arguments are checked before `.env` is read, so a usage error prints usage (exit 2) even without configuration.

After `unknown` or `partial`, the CLI reads `unresolved` and `activity` with the read credential and prints them as `{ recorded }`. It never sends the action again.

To issue the owner's approval credentials on the stack:

```sh
pnpm stack:credential <run>/stack execute 600
pnpm stack:credential <run>/stack sweep 600
```

On the stack, the simulator quotes only USDC → wNEAR. The stack's default targets hold ETH, so `rebalance` can't quote toward them. As a **test-only workaround**, the stack test writes the owner's targets straight into the agent's strategy file, the way the platform's treasury conformance spec does: the stack has no control for them at 5cd4d4d. This is the one place this repository reaches past the stack's control files.

## Checks

```sh
pnpm typecheck
pnpm test                                  # unit tests
TREASURY_STACK=<run>/stack pnpm test:stack # the CLI end to end on a running stack
```

The stack test issues its own credentials (kept in memory, never in `.env`). It covers status, a proposed rebalance executed once with the owner's confirmation, a chosen swap, scope refusals and sweep. It's repeatable on one stack. The stack can't cause a Treasury provider outage or a lost reply at 5cd4d4d, so `test/commands.test.ts` covers `provider`, `unavailable` and `unknown` with a faked client: their exit codes, and that `unknown` reads `unresolved` and `activity` and never resends. It also covers every row of the execution mapping above: rejected before any leg, rejected after a leg, `FAILED`/`REFUNDED` legs, unsettled legs and shields, sweep shields, a lost preview, a throw mid-stream, and usage errors. `test/stack-credential.test.ts` runs the credential script against a fake stack directory.
