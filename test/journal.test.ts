import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { acquireMoneyLock } from "../src/lock.js";
import { readOps, record } from "../src/ops.js";
import { ASSETS } from "../src/policy.js";

/**
 * Regressions for the single operation journal (see CONTEXT.md, "Operation"). Each is a todo until the
 * journal lands after the money-path freeze and authorize.ts: it runs and reports, but doesn't fail the suite.
 */
const PENDING = "the journal lands after authorize.ts and the money-path freeze";

const home = process.cwd();
beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "journal-")));
  process.env.AGENT_ID = "a".repeat(64);
});
afterEach(() => process.chdir(home));

test("a send recorded but never claimed is resolved as never submitted when the lock is next taken", { todo: PENDING }, async () => {
  // A crash between the write-ahead record and the claim: provably nothing reached the provider.
  record({ at: new Date().toISOString(), idempotencyKey: "payout:crashed", kind: "payout", method: "transfer",
    request: { asset: ASSETS.USDC, amount: "1", recipient: "payee.near", confidential: true } });
  const lock = await acquireMoneyLock();
  await lock.release();
  assert.equal(readOps().find((op) => op.idempotencyKey === "payout:crashed")?.refused, "never_submitted");
});
