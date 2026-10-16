import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Effect } from "effect";
import { indexedPages, runFastnear } from "../src/fastnear.js";

test("indexed reads reject repeated cursors and exhausted pages instead of partial results", async () => {
  await assert.rejects(runFastnear(indexedPages(() => Effect.succeed({ items: [1], next: "opaque" }))), /incomplete/);
  let cursor = 0;
  await assert.rejects(runFastnear(indexedPages(() => Effect.succeed({ items: [1], next: String(++cursor) }), 2)), /incomplete/);
});

test("DAO signature discovery rejects a repeated cursor instead of returning no signature", async t => {
  const { findSignature } = await import("../src/dao-owner.js");
  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ account_txs: [{ transaction_hash: "fixture" }], resume_token: "repeated" }));
  t.after(() => mock.restoreAll());
  await assert.rejects(findSignature("fixture.near", { owner: { public_key: "fixture" }, hash: "fixture", since: 1 } as never), /incomplete/);
  assert.equal(fetch.mock.callCount(), 2);
});

test("missing DAO history is unavailable evidence, not absence of a signature", async t => {
  const { findSignature } = await import("../src/dao-owner.js");
  mock.method(globalThis, "fetch", async () => Response.json({}));
  t.after(() => mock.restoreAll());
  await assert.rejects(findSignature("fixture.near", { owner: { public_key: "fixture" }, hash: "fixture", since: 1 } as never), /invalid response/);
});
