import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { dispatch, LocalRefusal } from "../src/agent.js";
import { api } from "../src/api.js";
import { acquireMoneyLock, UnresolvedOperations } from "../src/lock.js";
import { mandateDigest } from "../src/mandate.js";
import { readOps, record } from "../src/ops.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";

// Offline: the API's policy and token reads are fixed, and anything that would send fails the test.
const home = process.cwd();
before(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "guard-")));
  process.env.AGENT_ID = "a".repeat(64);
  Object.assign(api, {
    getPolicy: async () => ({ policy: treasuryPolicy, revision: 7 }),
    getTokens: async () => [{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 }],
    forGrant: () => assert.fail("a refused swap must not reach the API"),
  });
});
after(() => process.chdir(home));

const USDT = "nep141:usdt.tether-token.near";

test("a swap into an asset outside the policy is refused before sending, and logged like any refusal", async () => {
  const lock = await acquireMoneyLock();
  try {
    const swap = { origin_asset: ASSETS.USDC, destination_asset: USDT, amount: "2000000", confidential: true };
    await assert.rejects(dispatch(lock, "rebalance", { method: "swap", request: swap }), LocalRefusal);
  } finally {
    await lock.release();
  }

  const [op] = readOps();
  assert.equal(op?.refused, "asset_out_not_allowed");
  assert.equal(op?.correlationId, undefined, "nothing was sent");
  // The attempt carries the mandate it was refused under.
  assert.equal(op?.policyRevision, 7);
  assert.equal(op?.policyDigest, mandateDigest(treasuryPolicy));
  assert.equal(op?.usdIn, 2);

  // A refusal is a proven outcome: it doesn't block the next money action.
  const next = await acquireMoneyLock();
  await next.release();
});

test("a lock lost while the policy is read stops dispatch before anything is logged or sent", async () => {
  let held = true;
  const lock = { get held() { return held; }, release: async () => {} };
  const policyRead = api.getPolicy;
  // The holder stalls past the lock's stale window during the read; another process takes it over.
  Object.assign(api, { getPolicy: async () => ((held = false), { policy: treasuryPolicy, revision: 7 }) });
  try {
    const before = readOps().length;
    const swap = { origin_asset: ASSETS.USDC, destination_asset: ASSETS.wNEAR, amount: "1000000", confidential: true };
    await assert.rejects(dispatch(lock, "rebalance", { method: "swap", request: swap }), /money lock/);
    assert.equal(readOps().length, before, "nothing logged");
  } finally {
    Object.assign(api, { getPolicy: policyRead });
  }
});

test("an earlier action left without an outcome in the same run stops the next one", async () => {
  const lock = await acquireMoneyLock();
  try {
    // As a previous dispatch in this run leaves it: sent, its outcome never learned.
    record({ at: new Date().toISOString(), idempotencyKey: "swap:lost", kind: "rebalance", method: "swap", request: {} });
    const before = readOps().length;
    const swap = { origin_asset: ASSETS.USDC, destination_asset: ASSETS.wNEAR, amount: "1000000", confidential: true };
    await assert.rejects(dispatch(lock, "rebalance", { method: "swap", request: swap }), UnresolvedOperations);
    assert.equal(readOps().length, before, "nothing logged");
  } finally {
    await lock.release();
  }
});
