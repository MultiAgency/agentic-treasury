# Policy, accounting and signed-artifact verification

Read-only capture: **2026-10-13T04:10:03.956Z**, `https://api.demo.agentsonintents.com`.
**The complete signed-envelope guarantee remains unverified.** No operations were generated,
signed or submitted, and no deployment changed.

| Obligation | Result |
|---|---|
| Policy to signature | All 15 returned policy revisions reproduce their API hash. Nine captured NEP-366 policy delegates and nine custody ciphertext-store signatures verify, including mutation controls. This binds the encrypted blobs, not their correspondence with the readable policy. |
| Cumulative accounting across grants and crashes | Existing trials use one grant. This readback found one active grant per sampled agent and one total grant on the isolated agent. Cross-grant admission and admission before provider crash repair remain untested. |
| Transaction actually signed | The policy delegates bind receiver and arguments. No custody-signed spending payload was obtained. All three sampled operation-proof requests returned HTTP 501 `transparency_log_disabled`. |

The ten retained NEP-413 owner signatures also verify and match their recorded DAO hashes;
changed messages and recipients fail verification. They comprise five grant issues, one revocation
and four approval votes—none is a policy update. API hashes cover treasury revisions 1–11,
payout revision 1 and isolated-agent revisions 1–3.

The nine policy-transaction checks use earlier RPC captures because fresh requests timed out.
Their keys match the implicit sender accounts; changed receivers and arguments invalidate the
signatures. Custody signatures verify the pinned contract's domain-separated ciphertext-store hash,
and reject a changed caller. Captures report `FINAL`; this run did not independently verify chain
inclusion or historical access-key authority. Transaction and capture hashes are recorded in
[policy-signatures.json](results/20261013T0410Z/policy-signatures.json).

Proof requests sampled these successful operations:

- Treasury swap: `op_XNaqLYyKbGtTqnqKudiH8uQGIPQKxYvU9oLjHXJdaW4`.
- Payout transfer: `op_RCW0gaWGDo_fl7VYWln71qoFSPtfWGgXoGyVaStGvZ0`.
- Isolated swap: `op_13BiIirYsg208ObtehlBZqEwvW52gthNOoW0EZEvlRo`.

The disabled endpoint is an observed limitation, not evidence of an incorrect debit. An audit-event
inclusion proof alone would not establish the custody-signed spending bytes.

At OutLayer `b8c58c00be33d83c7c60769b646e0ba11e8a39ec`, the inspected crash-repair test reads
status before checking usage; it does not test competing admission before repair. The inspected
trusted-signing path checks recipient and nonce without parsing asset, amount or routing.
These source findings do not establish deployed behavior. Existing source analysis remains in
[VERIFICATION.md](VERIFICATION.md); remaining experiments belong to [ACCEPTANCE.md](ACCEPTANCE.md).

[Sanitized results](results/20261013T0410Z/report.json) and the
[capture manifest](results/20261013T0410Z/capture-manifest.json) retain the evidence references.
Raw captures and the one-off audit scripts are archived privately in
`.evidence/provider-verification-20261013T0410Z/`; the scripts are not maintained product commands.
The archive includes reproduction instructions. It must be retained to reproduce these checks.

The original offline run passed typecheck and tests (278 passed, 10 skipped), but concurrent edits
prevented a fixed-tree result. Its record is `/private/tmp/proto-binding-verification-20261013/`.
