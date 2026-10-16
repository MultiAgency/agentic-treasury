import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { fastnearStatus } from "../src/fastnear-status.js";
afterEach(() => mock.restoreAll());
test("indexer diagnostic exposes only bounded health fields, never arbitrary upstream content", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ status: "ok", lag_seconds: 3, latest_block_height: 42, message: "private-value", latest_tx_block_height: "private-value" }));
  const result = await fastnearStatus("transactions");
  assert.equal(result.healthy, true); assert.equal(result.lagSeconds, 3);
  assert.equal(result.latestTransactionBlockHeight, null);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});
test("failed health reads report unavailable diagnostics without inferring outcomes", async () => {
  mock.method(globalThis, "fetch", async () => { throw new Error("private-value"); });
  const result = await fastnearStatus("transfers");
  assert.equal(result.healthy, false); assert.equal(result.httpStatus, null);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});
