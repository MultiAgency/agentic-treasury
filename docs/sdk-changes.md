# @multiagency/sdk changes

Every SDK change appends a note under **Unreleased** when it is made: what changed for the apps, and any wire change
all apps must update for together. A release candidate sets the version in `package-version.ts` and puts its heading
over the notes. Under 0.x, any public-interface change bumps at least the minor version.

## Unreleased

## 0.1.0 (2026-10-19)

- **Shared builder payouts.** A fresh report may now be paid from the payout agent's shared balance: the owner chooses
  `mode: "shared"` or `"isolated"` at `compensation/prepare`. A request already bound to one path keeps it
  (`payment_bound`).
- **Approval states the amount.** `compensation/review` with `decision: "approved"` requires `approvedAmount`
  (`amount_required` otherwise); a report's requested amount is only a proposal. Payables already sends it.
- `requestRecord` loses `payoutMode`. Payee clients that parse it are unaffected (unknown keys are dropped); no
  capability id changes.
- **Removed export:** `compensationAmount` (from `./payee`). Show `approvedAmount` as the compensation and the report's
  amount as requested. `approvedCompensation` returns `approvedAmount` and now throws when an approved request has
  none; 0.0.1 fell back to the report's amount.
- **Retryable local refusals.** A send refused by Proto's own checks before submission (for example
  `insufficient_balance`, `reviewed_policy_changed`, `payee_not_agreed`) now fails `compensation/send` with that code
  and leaves the payment prepared on its identity; sending again after fixing the cause pays it once. Provider refusals
  and unknown outcomes are unchanged.

## 0.0.1 (2026-10-18)

Numbering restarts at 0.0.1; the earlier local tarballs (`@multiagency/proto-contract` 1.0.0–1.5.0, `@multiagency/sdk`
1.6.0) are history. No backwards compatibility with them.

- Package `@multiagency/proto-contract` → `@multiagency/sdk`. Payee entry `./supplier` → `./payee`.
- Payee names in code: `payeeClient`, `payeeContract`, `compatiblePayeeFrontend`, `payeeWorkOrderRequest`,
  `payeeCompensationView`, `PAYEE_REPORT_PERMISSIONS`. No aliases.
- **Wire change, all apps together:** an agent connection's `role` is `"payee"` (`PAYEE_ROLE`). 1.5.0 clients (Invoices G
  and earlier) reject it, so those releases are not rollback targets across this change.
- Hosted contributor sessions signed before this release end once (their session key derivation changed).
- Unchanged on the wire: routes, `supplier-*-v1` capability ids, cookies, records.
- Agent guidance ships as TanStack Intent skills: `getting-started`, `owner-workflows`, `payee-workflows`
  (`npx @tanstack/intent@0.5.5 list`). Every example is typechecked and run against the packed tarball.
