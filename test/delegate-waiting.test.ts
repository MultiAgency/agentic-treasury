import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { daoRequests, delegateWaiting, reconcileOwnerIntents } from "../src/owner-intents.js";

/**
 * One owner key, one nonce sequence: a NEAR delegate action executing raises the key's nonce, so a
 * second one prepared while the first waits for its vote would fail after its own vote. Both agents'
 * servers on a host keep their pending owner intents side by side in `.owner-intents/`.
 */

const home = process.cwd();
const OWNER = "c1bec849".padEnd(64, "0");
const future = new Date(Date.now() + 300_000).toISOString();
const delegate = (owner = OWNER, change: Record<string, unknown> = {}) =>
  ({ type: "agent_freeze", expiresAt: future, stage: "prepared", dao: { owner: { account_id: owner }, hash: "h", delegate: "AAAA" }, ...change });

beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), "delegate-"))); mkdirSync(".owner-intents"); });
afterEach(() => process.chdir(home));
const file = (name: string, entries: Record<string, unknown>) => writeFileSync(join(".owner-intents", name), JSON.stringify(entries));

test("a delegate action another agent's server prepared for the same owner is found", () => {
  file(".env.payout.json", { "intent-1": delegate() });
  assert.equal(delegateWaiting(OWNER)?.type, "agent_freeze");
});

test("submitted, settled, expired, signature-only and other owners' intents don't block", () => {
  file(".env.dao.json", {
    a: delegate(OWNER, { stage: "submitted" }),
    b: delegate(OWNER, { stage: "settled" }),
    c: delegate(OWNER, { expiresAt: new Date(Date.now() - 1).toISOString() }),
    d: { ...delegate(), dao: { owner: { account_id: OWNER }, hash: "h" } },
    e: delegate("someone-else"),
  });
  writeFileSync(join(".owner-intents", ".env.dao.expired.jsonl"), "{}\n");
  assert.equal(delegateWaiting(OWNER), undefined);
});

test("a DAO-signed approval names the payment it released, also once settled", () => {
  file(".env.json", { "vote-1": { ...delegate(OWNER, { type: "approval_vote", stage: "settled" }),
    paymentApproval: { approvalId: "a", correlationId: "op_payment", verdict: "approve", requestHash: "r" } } });
  const [request] = daoRequests();
  assert.equal(request?.state, "done");
  assert.deepEqual(request?.payment, { correlationId: "op_payment", verdict: "approve" });
});

test("an approval whose signing window closed still names its payment, read back from the archive", async () => {
  const past = new Date(Date.now() - 1).toISOString();
  file(".env.json", { "vote-2": { ...delegate(OWNER, { type: "approval_vote", expiresAt: past }),
    paymentApproval: { approvalId: "a", correlationId: "op_payment", verdict: "reject", requestHash: "r" } } });
  // An archive line from before payments were recorded, then a torn tail.
  writeFileSync(join(".owner-intents", ".env.expired.jsonl"), `${JSON.stringify({ correlationId: "vote-1", type: "approval_vote", expiresAt: past, hash: "h", delegate: null })}\n{"correlationId":"vo`);
  await reconcileOwnerIntents();
  const requests = daoRequests();
  assert.deepEqual(requests.map((r) => [r.correlationId, r.state, r.payment]), [
    ["vote-1", "expired", null],
    ["vote-2", "expired", { correlationId: "op_payment", verdict: "reject" }],
  ]);
});
