# Funded tests: manifest and results

The manifest and results of the funded runs of 2026-10-13 for the provider integration tests in
[ACCEPTANCE.md](ACCEPTANCE.md). Both runs had the user's explicit authorization. No production
treasury or payout agent is a fixture.

The fixed-funding runners are not product commands and are not in the tree. They are committed at
`c25b61b` (`src/envelope-phase1.ts`, `scripts/envelope-concurrency.ts`, `test/envelope-phase1.test.ts`): to
reproduce a run, check that commit out in a disposable worktree, and only for an explicitly authorized
funded experiment. "Phase" below means a
batch of funded tests, not a delivery phase of [signed-envelope.md](../signed-envelope.md).

## Scope

| Phase | Tests | Status |
|---|---|---|
| 1 | E10 (shield under the live destination configuration), monthly-cap refusal | **Run 2026-10-13T03:27Z, both passed** (see Results) |
| 2 | E2–E9 (concurrency, USD budget, retries, release, policy reduction, revocation) | E5 (USD budget under concurrency) run once 2026-10-13T03:32Z, held (see Results). The rest pending provider answers: their pass criteria are the semantics the providers state |
| — | E1 | Not rerun. The 2026-10-10 counterexample stands until a fix or version change warrants a retest |
| — | S1–S2, E11–E15, P1 | Pending Q3, Q5 and provider-controlled fault injection |

## Agent

A new agent, created for these tests by the laptop CLI owner (`AGENT_OWNER_ACCOUNT_ID` in `.env`), in its
own settings file: `ENV_FILE=.env.e2e pnpm create-agent`. Not the existing CLI agent `38da322c…`: it spent
USDC on 2026-10-10 and 10-11, and per-asset counters are UTC calendar periods, so its October usage would
contaminate the monthly case. One grant, labelled for treasury sends (`ENV_FILE=.env.e2e pnpm issue-grant treasury`), or `authorize`
refuses the swaps locally with `grant_purpose_denied`. Autopilot off; no strategy.

## Policy (phase 1)

Asset ids from `src/policy.ts`. USDC has 6 decimals.

```json
{
  "frozen": false,
  "actions": ["swap", "transfer"],
  "confidential": true,
  "owner_approval": false,
  "assets": ["nep141:wrap.near", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nep141:eth.omft.near"],
  "limits": {
    "per_transaction": { "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "5000000" },
    "hourly":          { "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "5000000" },
    "daily":           { "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "5000000" },
    "monthly":         { "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "3000000" }
  },
  "max_actions_per_hour": null,
  "destinations": "<copied byte-for-byte from the treasury agent's applied policy at preparation; record its revision>",
  "budget": { "daily_usd": "10", "weekly_usd": "10", "monthly_usd": "10" },
  "timelock_ms": 0
}
```

The actions, `confidential` and destination list reproduce the treasury's live configuration, so E10
tests it without touching the treasury. No transfer is made, so the copied destinations receive nothing.

Tooling (archived runner `src/envelope-phase1.ts`): `--write-policy <file>` wrote this policy with the
treasury's applied destinations and printed their revision; `ENV_FILE=.env.e2e pnpm update-policy --policy <file>`
signed it. `--preflight` reads only; `--run` performs steps 2–4 through `dispatch`, refuses any agent
but the `.env.e2e` one, and allows exactly three requests. It writes evidence to
`proto-releases/<timestamp>-envelope-phase1/`.

## Setup transactions (not test cases)

| # | Transaction | Signed by | Cost |
|---|---|---|---|
| S-a | `agent_create` (NEP-366) | CLI owner key | owner gas |
| S-b | `policy_update` to the policy above (NEP-366) | CLI owner key | owner gas |
| S-c | `grant_issue` (NEP-413) | CLI owner key | none on chain |
| S-d | Deposit 6 USDC to the agent's confidential balance | funding wallet | sender gas |
| S-e | Deposit 0.5 wNEAR to the agent's public balance (NEP-141 `storage_deposit` first if needed) | funding wallet | sender gas, storage |

## Funding, spending and ceilings

| Quantity | Value |
|---|---|
| Exact funding | 6 USDC (confidential) + 0.5 wNEAR (public) |
| Maximum requested swap input | 4 USDC across two requests: 2 USDC expected to execute (step 3), 2 USDC expected to be refused (step 4) |
| Shield | 0.5 wNEAR, an internal balance movement expected to incur no USD-budget charge |
| Test execution requests | exactly 3 (one shield, two swaps) |
| Quote-based execution-cost threshold | 250 bps worst cost per accepted quote; a quote above it is not executed |
| Gas ceiling | 0.05 NEAR across all setup and test transactions signed by the owner or the funding wallet |
| Storage ceiling | 0.01 NEAR (NEP-141 `storage_deposit` for the deposit address, if required) |
| Funds afterwards | stay in the test agent; returning them is a separate authorized action |

These are request and threshold ceilings, not a maximum possible loss. The 250 bps threshold bounds
execution cost only under the quoted prices and the provider's enforcement of each quote's
`min_amount_out` (≈ $0.05 on 2 USDC). Funded assets remain exposed to custody and market risk: wNEAR
bought in step 3 and shielded in step 2 can change value, and an execution dependency can fail or leave
an outcome uncertain. The $10 USD budget limits gross spending; it is not a loss ceiling. Exceeding the
gas or storage ceiling is a stop condition. Those ceilings apply to setup transactions signed by the owner
and funding wallets, which the runner neither signs nor measures: check them by hand from each
transaction's receipt.

## Order

Steps 3 and 4 run inside one UTC calendar month. Crossing an hour or day boundary between them only
resets counters that already fit.

1. **Preflight, immediately before step 2.** Record and confirm:
   - the applied policy equals the JSON above, with its revision; `status: APPLIED` and
     `provider_policy_synced: true`;
   - `usage.budget` zero for every window, and no open, held or unresolved operations. The API does not
     expose per-asset usage (`PolicyView.usage` has only `budget` and `timelock`), so zero per-asset usage
     rests on the agent being new, with no money operation before step 2;
   - balances: 6 USDC confidential, 0 public; 0.5 wNEAR public, 0 confidential;
   - one live grant, the one issued in S-c;
   - dry quotes for 2 USDC → wNEAR: a route exists at this size (2 USDC swaps succeeded on mainnet on
     2026-10-10), `min_amount_out` present, worst cost ≤ 250 bps, and the USDC price fresh so the budget
     can price it (no `spend_price_unavailable`).
2. **E10, shield under the live destination configuration.** Shield 0.5 wNEAR (no wNEAR limit, so no
   per-asset cap is involved). Expected: SUCCESS; an internal movement of public wNEAR −0.5 to
   confidential +0.5; **USD budget usage unchanged at $0** (shield is documented as uncharged). Record the observed budget. Whether a
   shield counts toward per-asset usage is not observable here.
3. **Monthly cap, first spend.** Dry-quote, then swap 2 USDC → wNEAR, confidential, with the quote's
   `min_amount_out`. Every limit fits: per-transaction, hourly and daily 5 USDC; monthly 3 USDC; budget
   $10; balance 6 USDC; actions and assets allowed; `max_actions_per_hour` null; no timelock, approval
   or schedule. Wait for SUCCESS and settlement (usage is recorded after settlement), then record
   balances and `usage.budget` (≈ $2 charged).
4. **Monthly cap, refusal.** Dry-quote, then swap 2 USDC → wNEAR. Competing constraints, each checked
   against recorded state: per-transaction 2 ≤ 5; hourly and daily at most 4 ≤ 5;
   budget ≈ $4 ≤ $10; balance 4 USDC ≥ 2; route and price as in preflight. Only monthly 4 > 3 fails.
   Expected: 409 `policy_denied`, nothing dispatched, balances and budget unchanged. Attribution rests on
   this isolation and on step 3's 2 USDC being the agent's only USDC spend, since `policy_denied` names
   no rule and per-asset usage is not observable. An admission here is a stop condition and is ambiguous:
   either the monthly cap was not enforced or step 3's usage had not been recorded yet.

## Stop conditions

Stop and report on any of: an unexpected admission or refusal; an operation without an identified id;
an UNCERTAIN or NEEDS_REVIEW outcome (poll the same id, never resend under a new key); any balance or
budget discrepancy; a policy that is not `APPLIED` and synced; a step that would exceed a ceiling above;
missing evidence for the previous step. A failed case blocks the claim it tests.

## Evidence

Per [ACCEPTANCE.md](ACCEPTANCE.md#evidence-per-case): case id, build identity, policy revision, grant id
(never the token), requests, operation ids, timestamps, usage and balances before and after, responses
and status history. Stored with the release record, not in this repository.

## Results (phase 1, 2026-10-13T03:27Z)

Run with the user's explicit authorization, during the observation run, from base `9b9fe64` plus the
staged runner and `update-policy`. Evidence: `proto-releases/20261013T032658Z-envelope-phase1/` (no tokens).

- **Setup.** Agent `fbb390d7…2354` (wallet `7ad3bf83…f404`, owner `treasury.multiagentic.near`); policy
  revision 2 with destinations copied byte-for-byte from treasury revision 11; grant `b0f040b7…`, label
  `treasury:bc37ba01…`.
- **Deviation: funding.** 8.88 USDC confidential (a DAO Trezu confidential payment) instead of 6; 0.5
  wNEAR public by `ft_transfer_call` to `intents.near` (tx 5QGXHAWRvW36aSQTrR4fitDZApwWbyv2v1115pvhCVL6).
  The balance never constrained step 4.
- **Preflight.** Applied policy matched; budget zero in every window; quote worst cost 179 bps.
- **E10, shield.** `op_mPNFaz-SI04vTSkwNrxk7SH3XdR23jzPMoPFHwtE1KQ`: SUCCESS; wNEAR 0.5 public → 0.5
  confidential; USD budget $0 → $0. Passed.
- **Step 3, first spend.** `op_Uli9thHSyzCONMy1iHrB_6JHiMhQPJWeQohdiBZlrxs`: SUCCESS; USDC 8.88 → 6.88
  confidential; USD budget $0 → $1.999536 in every window.
- **Step 4, refusal.** The identical 2 USDC request: `policy_denied`, no correlation id; balances and
  budget unchanged. Passed: only the monthly cap was exceeded, and the request was otherwise identical to
  one the provider had just admitted.

Limits of this evidence: sequential, one grant, one host; it shows the monthly cap enforced, not its
behaviour under concurrency (E2–E4). Gas and storage ceilings were not checked by the runner.

## Results (E5, 2026-10-13T03:32Z)

Run with the user's authorization on the same test agent. Policy revision 3 set `daily_usd` to 3, all else
unchanged; $1.999536 was already spent, leaving $1.000464. Five swaps of $0.40 wNEAR → USDC were sent at
the same instant directly to the API with the test grant, bypassing our money lock, by the archived
`scripts/envelope-concurrency.ts` (`ENVELOPE_N`, `ENVELOPE_USD_EACH`). It is guarded to the test agent and
refuses when the remaining budget would fit all N. It uses the grant directly, which
`test/send-path.test.ts` forbids in `src/`. Evidence: `proto-releases/20261013T033230Z-envelope-concurrency/result.json`.

- One accepted and settled (`op_13BiIirYsg208ObtehlBZqEwvW52gthNOoW0EZEvlRo`); one `wallet_busy`; three
  `spend_budget_exceeded`.
- Budget $1.999536 → $2.399537 against $3.00: no overshoot. Passed.
- Conservative: two would have fit, one ran; requests were refused for budget while $0.60 remained.

Limits: one trial, N = 5, one grant, one host. It does not exercise two grants, several API instances, a
crash, or the per-asset caps (E2–E4).

