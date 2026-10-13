# Offline verification record, 2026-10-13

This record describes the captured local verification run. Current findings are maintained in the
[enforcement assessment](../enforcement.md); required checks are in the
[acceptance protocol](ACCEPTANCE.md). The implementation uses the NEAR Intents Agent API and OutLayer.

## Deliverables

- The abstract accounting model was a specification experiment, not an implementation test. Its
  sources and explanation are archived in `.evidence/prototype-cleanup-20261013/`; it is no longer
  part of the regular suite. The captured results below describe the historical run.
- `scripts/verify-envelope.mjs`: runs typecheck and the offline suite, saves logs and hashes public
  source files before and after. It reports persistent source changes during the run and imposes a
  two-minute timeout per check. Use a new absolute output directory:

  ```sh
  node scripts/verify-envelope.mjs /private/tmp/envelope-verification-unique
  ```

## Captured results

Evidence: [20261013T0315Z/verification.json](results/20261013T0315Z/verification.json),
[typecheck log](results/20261013T0315Z/typecheck.log) and
[test log](results/20261013T0315Z/test.log).

- Typecheck passed. The suite reported 277 tests: 265 passed, zero failed, 10 skipped and two TODOs.
- All nine model tests passed. Each safe exploration exhausted 228 reachable states and 528
  transitions. All six unsafe variants produced counterexamples; an incomplete search did not pass.
- The two TODOs concern the write-ahead-before-claim crash and concurrent owner-action preparation.
  They were not fixed or waived by the run. The skipped checks require live agent or inference credentials.
- Before/after hashes matched for the captured interval. They describe that snapshot, not subsequent
  edits or an independently selected release. They cannot detect a change followed by reversion.

The immutable record retains the historical hash of the removed envelope-contract proposal. It is
not an active design or implementation dependency. Logs and evidence have not been rewritten.

These artifacts establish offline results only. They do not verify provider enforcement, policy
signature binding, deployment correspondence or the stronger custody claim. No live operation or
deployment was performed by this verification runner. Live observations are recorded separately in
[VERIFICATION.md](VERIFICATION.md).
