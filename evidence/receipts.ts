/**
 * The apps' simulated workflow receipts that Proto's evidence view shows as "Recorded simulation". Each copy in
 * evidence/receipts/ is sanitized from its source receipt (scripts/evidence-receipts.ts) and pinned here; `pnpm
 * evidence:check` fails if a copy or its source changes. Simulated provider, chain, wallet signatures, funding and
 * settlement: no real funds.
 */
export type ReceiptApp = "payables" | "treasury";
export type ReceiptWorkflow = "payables" | "treasury" | "invoices" | "builder";
export type ReceiptEntry = {
  id: string;
  workflow: ReceiptWorkflow;
  title: string;
  /** When the receipt was recorded (UTC). */
  recordedAt: string;
  /** The Proto snapshot the run used (its run digest). */
  snapshot: string;
  source: { app: ReceiptApp; path: string; sha256: string };
  copySha256: string;
  /** The copy's steps as the evidence view lists them (checked against the copy). */
  steps: string[];
  note?: string;
};

export const receipts: ReceiptEntry[] = [
  {
    "id": "payables-sponsorship",
    "workflow": "payables",
    "title": "Sponsorship: request \u2192 review \u2192 owner approval \u2192 confidential payment",
    "recordedAt": "2026-10-19T16:15:16.993Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/sponsorship-2026-10-19T16-15-16-993Z/receipt.json",
      "sha256": "85165bb64880367990708c878405bc974449f378b1700edbdbe2dc470ef55155"
    },
    "copySha256": "2791b0c518498a6aa03e06a6bf9d507961f78312155f3c7ecd5142438e35e971",
    "steps": [
      "Northside Garden requests 20 USDC from Riverside Commons \u00b7 waiting",
      "Owner approves the held confidential payout (simulated wallet signature)",
      "Provider settles the payout (simulated) and both sides record it \u00b7 paid (provider SUCCESS)"
    ]
  },
  {
    "id": "payables-sponsorship-owner-rejects",
    "workflow": "payables",
    "title": "Sponsorship: the owner rejects the held payout; nothing moves",
    "recordedAt": "2026-10-19T16:15:54.728Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/sponsorship-2026-10-19T16-15-54-728Z/receipt.json",
      "sha256": "d36cb0a3cc11b172e2b0232d5991e2fe3b9701751b470898b0d1b0b82d3f9cea"
    },
    "copySha256": "0fca5bc09916a631d8e203490b63248171adf367d57d5e8c601b38a95c641613",
    "steps": [
      "Northside Garden requests 20 USDC from Riverside Commons \u00b7 waiting",
      "Owner rejects the held confidential payout (simulated wallet signature)",
      "Both sides record the rejected payout; nothing moved \u00b7 rejected (provider FAILED)"
    ]
  },
  {
    "id": "invoices-purchase-order",
    "workflow": "invoices",
    "title": "Purchase order: fixed terms \u2192 authorization and funding \u2192 invoice \u2192 approval \u2192 settlement",
    "recordedAt": "2026-10-19T16:16:32.613Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/purchase-order-2026-10-19T16-16-32-613Z/receipt.json",
      "sha256": "206dc630710748ea3bdcba03384a3e9bdcd9dbfe4a3861f263aafa75d223dd01"
    },
    "copySha256": "492582c9f0bf9759348cbaf0d40d1e8a598ec339bf61bcd98c11099bd8a2dff0",
    "steps": [
      "Owner records fixed terms",
      "Owner authorizes the order agent (simulated wallet signature)",
      "Owner authorizes the order grant until the deadline (simulated wallet signature)",
      "Owner funds exactly the order amount (simulated deposit arrival)",
      "Payee files the order invoice \u00b7 waiting",
      "Owner approves the held payout (simulated wallet signature)",
      "Provider settles the payout (simulated) and both sides record it"
    ]
  },
  {
    "id": "invoices-purchase-order-short-funding",
    "workflow": "invoices",
    "title": "Purchase order: funding one unit short refuses the invoice until the exact top-up",
    "recordedAt": "2026-10-19T16:17:10.476Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/purchase-order-2026-10-19T16-17-10-476Z/receipt.json",
      "sha256": "b7cb8cc938c296a25388dac2259db88cad8e56c918a9b393468a43eb26d575f1"
    },
    "copySha256": "54747bf2f271b5407e2094642f8eb082b0d7d375ad523e15c1ae14abf40afaa7",
    "steps": [
      "Owner records fixed terms",
      "Owner authorizes the order agent (simulated wallet signature)",
      "Owner authorizes the order grant until the deadline (simulated wallet signature)",
      "Owner funds one unit short (simulated deposit arrival)",
      "Payee filing is refused while funding is short",
      "Owner tops up the exact shortfall (simulated deposit arrival)",
      "Payee files the order invoice \u00b7 waiting",
      "Owner approves the held payout (simulated wallet signature)",
      "Provider settles the payout (simulated) and both sides record it"
    ]
  },
  {
    "id": "invoices-purchase-order-lost-filing",
    "workflow": "invoices",
    "title": "Purchase order: a lost filing response stays unknown and stops the run (by design)",
    "recordedAt": "2026-10-19T16:17:49.125Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/purchase-order-2026-10-19T16-17-49-125Z/receipt.json",
      "sha256": "32de269ef86595f2aee83583fb7fea6c157599a60ea7a83be7e5f91bfb478840"
    },
    "copySha256": "c0bcd2ed5e5bab4d15eb3b6597f08e87b0a7f89501c6e8b9154ea87f57164fb3",
    "steps": [
      "Owner records fixed terms",
      "Owner authorizes the order agent (simulated wallet signature)",
      "Owner authorizes the order grant until the deadline (simulated wallet signature)",
      "Owner funds exactly the order amount (simulated deposit arrival)",
      "Payee files the order invoice \u00b7 unknown"
    ],
    "note": "The run stops at the unknown filing: it is never refiled, and no second payment is created."
  },
  {
    "id": "builder-isolated",
    "workflow": "builder",
    "title": "Builder agreement, isolated order: report \u2192 review \u2192 payment",
    "recordedAt": "2026-10-19T16:18:28.627Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/contribution-report-2026-10-19T16-18-28-627Z/receipt.json",
      "sha256": "2fa8adbd93eac5e552c3b8948fcdb42cfe28462a730267c2f2ea5530dfbeb5a5"
    },
    "copySha256": "e549db5db1484f4f7120ad6e5425830698f3ef253433871fbf114d4a76c2ccd7",
    "steps": [
      "Owner records the signed period agreement",
      "Contributor submits report 1: early assignment: onboarding review and icon set",
      "Owner reviews report 1 at 25 USDC (no payment)",
      "Owner prepares report 1's isolated payout",
      "Owner authorizes the order agent (simulated wallet signature)",
      "Owner authorizes the order grant until the deadline (simulated wallet signature)",
      "Owner funds exactly the order amount (simulated deposit arrival)",
      "Payee files the order invoice \u00b7 waiting",
      "Owner approves the held payout (simulated wallet signature)",
      "Provider settles the payout (simulated) and both sides record it",
      "Contributor reads report 1's payment and the remaining cap",
      "Contributor submits report 2: later assignment: launch banner set",
      "Owner reviews report 2 at 20 USDC (refused: ceiling_exceeded)",
      "Owner reviews report 2 at 15 USDC (no payment)",
      "Owner prepares report 2's isolated payout",
      "Owner authorizes the order agent (simulated wallet signature)",
      "Owner authorizes the order grant until the deadline (simulated wallet signature)",
      "Owner funds exactly the order amount (simulated deposit arrival)",
      "Payee files the order invoice \u00b7 waiting",
      "Owner approves the held payout (simulated wallet signature)",
      "Provider settles the payout (simulated) and both sides record it",
      "Contributor reads report 2's payment and the remaining cap",
      "Contributor submits report 3: work after the period: November newsletter art"
    ]
  },
  {
    "id": "builder-isolated-lost-payee-reply",
    "workflow": "builder",
    "title": "Builder agreement, isolated order: the contributor's reply is lost and recovered by identity",
    "recordedAt": "2026-10-19T16:19:15.039Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/contribution-report-2026-10-19T16-19-15-039Z/receipt.json",
      "sha256": "2ede548ec21898a6da1a0d9fb61ff9e9027a1bb926f19221510cddb788ac51d3"
    },
    "copySha256": "12586f2289ea6a5894430a16ebe7f9f5d6988fac830b9ef8496ab14f762e743b",
    "steps": [
      "Owner records the signed period agreement",
      "Contributor submits report 1: early assignment: onboarding review and icon set",
      "Owner reviews report 1 at 25 USDC (no payment)",
      "Owner prepares report 1's isolated payout",
      "Owner authorizes the order agent (simulated wallet signature)",
      "Owner authorizes the order grant until the deadline (simulated wallet signature)",
      "Owner funds exactly the order amount (simulated deposit arrival)",
      "Payee files the order invoice \u00b7 waiting",
      "Owner approves the held payout (simulated wallet signature)",
      "Provider settles the payout (simulated) and both sides record it",
      "Contributor reads report 1's payment and the remaining cap",
      "Contributor submits report 2: later assignment: launch banner set",
      "Owner reviews report 2 at 20 USDC (refused: ceiling_exceeded)",
      "Owner reviews report 2 at 15 USDC (no payment)",
      "Owner prepares report 2's isolated payout",
      "Owner authorizes the order agent (simulated wallet signature)",
      "Owner authorizes the order grant until the deadline (simulated wallet signature)",
      "Owner funds exactly the order amount (simulated deposit arrival)",
      "Payee files the order invoice \u00b7 waiting",
      "Owner approves the held payout (simulated wallet signature)",
      "Provider settles the payout (simulated) and both sides record it",
      "Contributor reads report 2's payment and the remaining cap",
      "Contributor submits report 3: work after the period: November newsletter art"
    ]
  },
  {
    "id": "builder-isolated-lost-filing",
    "workflow": "builder",
    "title": "Builder agreement, isolated order: a lost filing stops the run (by design)",
    "recordedAt": "2026-10-18T07:51:11.954Z",
    "snapshot": "9d13e95ad8b85210f2c3188ca8f38f9ecb7c2b7162e8c2a6d61785b63065a3f8",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/contribution-report-2026-10-18T07-51-11-954Z/receipt.json",
      "sha256": "e74e0dbfbdf8c04e6bb385983b716e60fc7d1ae0a3eb324ad3164fbe32b6258c"
    },
    "copySha256": "5166c86588881b9770bf67197ca7a0a529d56e2779718ef381ba853e5ce6cc29",
    "steps": [
      "Owner records the signed period agreement",
      "Contributor submits report 1: early assignment: onboarding review and icon set",
      "Owner reviews report 1 at 25 USDC (no payment)",
      "Owner prepares report 1's isolated payout",
      "Owner authorizes the order agent (simulated wallet signature)",
      "Owner authorizes the order grant until the deadline (simulated wallet signature)",
      "Owner funds exactly the order amount (simulated deposit arrival)",
      "Payee files the order invoice \u00b7 unknown"
    ]
  },
  {
    "id": "treasury-strategy",
    "workflow": "treasury",
    "title": "Treasury skill recipe: balances and budget \u2192 chosen swaps quoted as one plan \u2192 owner-authorized execution \u2192 recorded outcomes",
    "recordedAt": "2026-10-18T06:52:09.678Z",
    "snapshot": "e27183cb27da43c7bd1caa1f96a2544f1f8f2f93fc2428f0bbdd4017d1217d6e",
    "source": {
      "app": "treasury",
      "path": ".test-artifacts/demo/run-16dTLf/receipt.json",
      "sha256": "95e226bda07bdfc221be917b550daa20955d162475692228671aa0c659448f13"
    },
    "copySha256": "860a54094d3f783f7e8ab1358c279da2e35ab8e0815cdbb09a5b87de0d6e528f",
    "steps": [
      "strategy fixture written",
      "machine credential issued",
      "observed",
      "plan saved",
      "execution authorized",
      "execution returned",
      "outcome observed"
    ],
    "note": "Quotes chosen swaps (externalPlan), not an allocation rebalance; budget headroom after execution is not recorded."
  },
  {
    "id": "treasury-strategy-lost-response",
    "workflow": "treasury",
    "title": "Treasury skill recipe: a swap response is lost; the outcome stays unresolved and nothing is resent",
    "recordedAt": "2026-10-18T06:52:16.286Z",
    "snapshot": "e27183cb27da43c7bd1caa1f96a2544f1f8f2f93fc2428f0bbdd4017d1217d6e",
    "source": {
      "app": "treasury",
      "path": ".test-artifacts/demo/run-avaGZl/receipt.json",
      "sha256": "4baf765a5f20bb36750098873c99643d65b4d00efa9549fe7ec3001d219c7471"
    },
    "copySha256": "79a451880a1928befbfde77a5f2d215c880ec6aaf2468e73984dca8dcd0e118e",
    "steps": [
      "strategy fixture written",
      "machine credential issued",
      "observed",
      "plan saved",
      "execution authorized",
      "execution returned",
      "outcome observed",
      "unresolved-send block probed"
    ],
    "note": "Quotes chosen swaps (externalPlan), not an allocation rebalance."
  },
  {
    "id": "builder-shared",
    "workflow": "builder",
    "title": "Builder agreement, shared payout: setup once (payee added, payout agent funded), then reports paid within the cap; over-cap and out-of-period reports refused",
    "recordedAt": "2026-10-19T16:45:53.106Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/shared-builder-2026-10-19T16-45-53-106Z/receipt.json",
      "sha256": "d7311c685029f8e37508ba226593e34ec8b9e4d8356835d5f8245baa768900b9"
    },
    "copySha256": "5b6b7996a0698e7d24d3bb62c09a56b8aba41595145bb24cddddd1f54f49ec6f",
    "steps": [
      "Owner records the period agreement in Agreements",
      "Setup, once: owner adds the builder to the payout policy (one wallet signature)",
      "Setup, once: fund the payout agent (simulated deposit arrival)",
      "Setup ready on the owner's screen: payout agent, builder in the signed policy, payout grant, funding",
      "Contributor submits report 1: early assignment: onboarding review and icon set",
      "Owner approves report 1 at 25 USDC in the review screen (no payment)",
      "Owner prepares report 1's shared payout \u00b7 PREPARED",
      "Owner sends report 1's payout for approval \u00b7 PENDING_APPROVAL",
      "Owner approves report 1's held payout (one simulated wallet signature) \u00b7 PENDING_APPROVAL",
      "Provider settles report 1's payout (simulated); exactly one transfer \u00b7 SUCCESS",
      "Report 1 closes: contributor sees it paid; no new agent, grant or deposit",
      "Contributor submits report 2: later assignment: launch banner set",
      "Owner tries 20 USDC on report 2: the screen blocks it",
      "Proto refuses the same 20 USDC decision: ceiling_exceeded",
      "Owner approves report 2 at 15 USDC in the review screen (no payment)",
      "Owner prepares report 2's shared payout \u00b7 PREPARED",
      "Owner sends report 2's payout for approval \u00b7 PENDING_APPROVAL",
      "Owner approves report 2's held payout (one simulated wallet signature) \u00b7 PENDING_APPROVAL",
      "Provider settles report 2's payout (simulated); exactly one transfer \u00b7 SUCCESS",
      "Report 2 closes: contributor sees it paid; no new agent, grant or deposit",
      "Contributor submits report 3: work after the period: November newsletter art"
    ],
    "note": "Shared payout path (the owner's explicit choice; isolated orders remain the default)."
  },
  {
    "id": "builder-shared-lost-payee-reply",
    "workflow": "builder",
    "title": "Builder agreement, shared payout: the contributor's reply is lost and resumed with the same request identity",
    "recordedAt": "2026-10-19T16:21:55.225Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/shared-builder-2026-10-19T16-21-55-225Z/receipt.json",
      "sha256": "72b3045cdfd630af1b07348f6425ae3ee5d5fab7c1272e03f3ec81c5dcd1a15c"
    },
    "copySha256": "237f9a2c1894fe0e18affaa2d5789b388df69516a6c11e8d513588590207f8e7",
    "steps": [
      "Owner records the period agreement in Agreements",
      "Setup, once: owner adds the builder to the payout policy (one wallet signature)",
      "Setup, once: fund the payout agent (simulated deposit arrival)",
      "Setup ready on the owner's screen: payout agent, builder in the signed policy, payout grant, funding",
      "Contributor submits report 1: early assignment: onboarding review and icon set",
      "Owner approves report 1 at 25 USDC in the review screen (no payment)",
      "Owner prepares report 1's shared payout \u00b7 PREPARED",
      "Owner sends report 1's payout for approval \u00b7 PENDING_APPROVAL",
      "Owner approves report 1's held payout (one simulated wallet signature) \u00b7 PENDING_APPROVAL",
      "Provider settles report 1's payout (simulated); exactly one transfer \u00b7 SUCCESS",
      "Report 1 closes: contributor sees it paid; no new agent, grant or deposit",
      "Contributor submits report 2: later assignment: launch banner set",
      "Owner tries 20 USDC on report 2: the screen blocks it",
      "Proto refuses the same 20 USDC decision: ceiling_exceeded",
      "Owner approves report 2 at 15 USDC in the review screen (no payment)",
      "Owner prepares report 2's shared payout \u00b7 PREPARED",
      "Owner sends report 2's payout for approval \u00b7 PENDING_APPROVAL",
      "Owner approves report 2's held payout (one simulated wallet signature) \u00b7 PENDING_APPROVAL",
      "Provider settles report 2's payout (simulated); exactly one transfer \u00b7 SUCCESS",
      "Report 2 closes: contributor sees it paid; no new agent, grant or deposit",
      "Contributor submits report 3: work after the period: November newsletter art"
    ],
    "note": "Shared payout path (the owner's explicit choice; isolated orders remain the default)."
  },
  {
    "id": "builder-shared-lost-send",
    "workflow": "builder",
    "title": "Builder agreement, shared payout: a lost send stays unknown with one submission and no resend; the next send is refused and stays prepared (stopped by design)",
    "recordedAt": "2026-10-19T16:23:49.323Z",
    "snapshot": "92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f",
    "source": {
      "app": "payables",
      "path": ".test-artifacts/workflows/shared-builder-2026-10-19T16-23-49-323Z/receipt.json",
      "sha256": "d6dd163288faf7c90ff9aca7d9379e8d84a689f7ced55d36c901c31ee9e475ce"
    },
    "copySha256": "4acd2577fa6d5d224e1dd949f0b643667a9f03c12f47f2a0e73bf58cd7efe7e7",
    "steps": [
      "Owner records the period agreement in Agreements",
      "Setup, once: owner adds the builder to the payout policy (one wallet signature)",
      "Setup, once: fund the payout agent (simulated deposit arrival)",
      "Setup ready on the owner's screen: payout agent, builder in the signed policy, payout grant, funding",
      "Contributor submits report 1: early assignment: onboarding review and icon set",
      "Owner approves report 1 at 25 USDC in the review screen (no payment)",
      "Owner prepares report 1's shared payout \u00b7 PREPARED",
      "Owner sends report 1's payout for approval (answer lost) \u00b7 UNKNOWN",
      "Contributor submits report 2: later assignment: launch banner set",
      "Owner tries 20 USDC on report 2: the screen blocks it",
      "Proto refuses the same 20 USDC decision: ceiling_exceeded",
      "Owner approves report 2 at 15 USDC in the review screen (no payment)",
      "Owner prepares report 2's shared payout \u00b7 PREPARED",
      "Owner sends report 2's payout: refused while report 1's outcome is unknown \u00b7 PREPARED"
    ],
    "note": "Shared payout path (the owner's explicit choice; isolated orders remain the default)."
  }
];
