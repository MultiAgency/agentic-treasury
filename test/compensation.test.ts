import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { compensationList, compensationHistory, recordCompensationAgreement, saveCompensationRequest, reviewCompensationRequest, bindCompensationPayment } from "../src/compensation-store.js";
import { approvedCompensation, type CompensationRequest } from "../src/compensation-contract.js";
import { mayCall } from "../src/gateway/allowlist.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

freshDirectory("compensation");
offline();
const terms = { payee: "alice.near", title: "October work", document: "https://docs.google.com/document/d/example", signedOn: "2026-10-01", start: "2026-10-01", end: "2026-10-31", ceiling: "1000000000", openingApproved: "100000000", scope: "Authorized GitHub issues" };
const agreement = () => recordCompensationAgreement("owner.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, terms });
function submit(agreementId: string, amount = "600000000") {
  return saveCompensationRequest("alice.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: { agreementId, amount, start: "2026-10-01", end: "2026-10-16", contributions: "Delivered the authorized integration", assessment: "Tested; awaiting acceptance", evidence: ["https://github.com/example/project/pull/1"] } });
}
// An approval states the owner's amount explicitly; here the requested amount unless a test overrides it.
const review = (r: CompensationRequest, decision: "approved" | "changes_requested" | "declined" = "approved", feedback = "") =>
  ({ commandId: randomUUID(), id: r.id, expectedVersion: r.version, decision, feedback, ...(decision === "approved" && r.report.amount && { approvedAmount: r.report.amount }) });

test("intake records a proposal without consuming allowance; exact approval retry reserves once", () => {
  const a = agreement(), r = submit(a.id);
  assert.equal(compensationList().agreements[0]!.remaining, "900000000");
  const command = review(r);
  const approved = reviewCompensationRequest("owner.near", command);
  assert.deepEqual(reviewCompensationRequest("owner.near", command), approved);
  assert.equal(compensationList().agreements[0]!.remaining, "300000000");
  assert.equal(compensationHistory().length, 3);
});
test("over-ceiling submissions remain reviewable; approval and stale decisions refuse", () => {
  const a = agreement(), r = submit(a.id, "1000000000");
  assert.equal(r.state, "submitted");
  assert.throws(() => reviewCompensationRequest("owner.near", review(r)), /remaining agreement ceiling/);
  const returned = reviewCompensationRequest("owner.near", review(r, "changes_requested", "Please revise the amount"));
  assert.throws(() => reviewCompensationRequest("owner.near", review(r)), /changed/);
  const revised = saveCompensationRequest("alice.near", { commandId: randomUUID(), id: r.id, expectedVersion: returned.version, submit: true, report: { ...r.report, amount: "200000000" } });
  reviewCompensationRequest("owner.near", review(revised));
  assert.equal(compensationHistory("alice.near").length, 5);
  assert.throws(() => saveCompensationRequest("alice.near", { commandId: randomUUID(), id: r.id, expectedVersion: revised.version + 1, submit: true, report: r.report }), /draft or returned/);
});
test("account scope, period and recipient cannot be substituted", () => {
  const a = agreement(), r = submit(a.id);
  assert.equal(compensationList("bob.near").requests.length, 0);
  assert.equal(compensationHistory("bob.near").length, 0);
  assert.throws(() => saveCompensationRequest("bob.near", { commandId: randomUUID(), id: r.id, expectedVersion: r.version, submit: true, report: r.report }), /not found/);
  assert.throws(() => saveCompensationRequest("bob.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: r.report }), /not found/);
  assert.throws(() => saveCompensationRequest("alice.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: { ...r.report, end: "2026-11-01" } }), /fit the agreement/);
});
test("agreement amendments preserve history and require submitted terms to be reviewed again", () => {
  const a = agreement(), r = submit(a.id);
  const changed = recordCompensationAgreement("owner.near", { commandId: randomUUID(), id: a.id, expectedVersion: 1, terms: { ...terms, ceiling: "1100000000" } });
  assert.equal(changed.version, 2);
  assert.throws(() => reviewCompensationRequest("owner.near", review(r)), /Terms changed/);
  assert.throws(() => recordCompensationAgreement("owner.near", { commandId: randomUUID(), id: a.id, expectedVersion: 2, terms: { ...terms, payee: "bob.near" } }), /cannot change/);
});
test("one approved request binds one payment path; binding retains the ceiling reservation", () => {
  const a = agreement(), r = submit(a.id);
  const approved = reviewCompensationRequest("owner.near", review(r));
  const c = { commandId: randomUUID(), id: r.id, expectedVersion: approved.version, mode: "isolated" as const, until: new Date(Date.now() + 86400000).toISOString() };
  const bound = bindCompensationPayment("owner.near", c);
  assert.deepEqual(bindCompensationPayment("owner.near", c), bound);
  assert.throws(() => bindCompensationPayment("owner.near", { ...c, commandId: randomUUID(), mode: "shared", until: undefined }), /another payment path/);
  assert.equal(compensationList().agreements[0]!.remaining, "300000000");
});
test("command identities cannot be reused with altered content or actors", () => {
  const a = agreement(), r = submit(a.id), c = review(r);
  reviewCompensationRequest("owner.near", c);
  assert.throws(() => reviewCompensationRequest("other.near", c), /different content/);
  assert.throws(() => reviewCompensationRequest("owner.near", { ...c, feedback: "changed" }), /different content/);
});
test("concurrent real processes cannot over-approve a shared ceiling", async () => {
  const a = agreement(), left = submit(a.id), right = submit(a.id);
  const fixture = fileURLToPath(new URL("./fixtures/compensation-review.ts", import.meta.url));
  const barrier = mkdtempSync(join(tmpdir(), "compensation-barrier-"));
  const child = (r: CompensationRequest, name: string) => new Promise<{ state?: string; error?: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--import", import.meta.resolve("tsx"), fixture, JSON.stringify(review(r))], { cwd: globalThis.process.cwd(),
      env: { ...globalThis.process.env, COMPENSATION_BARRIER: barrier, COMPENSATION_NAME: name } });
    let output = "", stderr = "";
    process.stdout.on("data", chunk => output += chunk); process.stderr.on("data", chunk => stderr += chunk);
    process.on("error", reject); process.on("close", code => { if (code) reject(new Error(stderr)); else { try { resolve(JSON.parse(output)); } catch (e) { reject(e); } } });
  });
  const running = Promise.all([child(left, "left"), child(right, "right")]);
  // Contention witness: one review holds its decision while the other has attempted its own and stays blocked.
  const seen = (file: string) => existsSync(join(barrier, file));
  const until = async (ready: () => boolean) => { for (let i = 0; i < 500 && !ready(); i++) await new Promise(r => setTimeout(r, 20)); return ready(); };
  let outcomes: { state?: string; error?: string }[];
  try {
    assert.ok(await until(() => (seen("left.entered") || seen("right.entered")) && seen("left.attempt") && seen("right.attempt")), "both reviews reached their decision");
    await new Promise(r => setTimeout(r, 300));
    assert.equal(["left", "right"].filter(n => seen(`${n}.entered`)).length, 1, "the second review is blocked while the first decides");
  } finally {
    // Always let both reviews finish, so a failed witness never leaves processes waiting.
    writeFileSync(join(barrier, "release"), "");
    outcomes = await running;
    rmSync(barrier, { recursive: true, force: true });
  }
  assert.equal(outcomes.filter(o => o.state === "approved").length, 1);
  assert.equal(outcomes.filter(o => /remaining agreement ceiling/.test(o.error ?? "")).length, 1, JSON.stringify(outcomes));
  assert.equal(compensationList().agreements[0]!.remaining, "300000000");
});
test("missing or corrupt state refuses rather than reopening an empty allowance", () => {
  agreement();
  const path = `.invoices/${process.env.AGENT_ID}.compensation.sqlite`;
  unlinkSync(path);
  assert.throws(() => compensationList(), /missing/);
  writeFileSync(path, "broken sqlite");
  assert.throws(() => compensationList(), /file is not a database/, "the corrupt store itself refuses, not an unrelated failure");
});
test("a crash after committing approval retains its command receipt and reservation after restart", () => {
  const a = agreement(), r = submit(a.id), c = review(r);
  const fixture = fileURLToPath(new URL("./fixtures/compensation-review.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fixture, JSON.stringify(c), "crash-after-commit"], { cwd: process.cwd(), env: process.env });
  assert.equal(result.signal, "SIGKILL");
  const retained = reviewCompensationRequest("owner.near", c);
  assert.equal(retained.state, "approved");
  assert.equal(compensationList().agreements[0]!.remaining, "300000000");
  assert.equal(compensationHistory().length, 3);
});
test("an empty or partially missing initialized schema cannot recreate an allowance", () => {
  agreement();
  const path = `.invoices/${process.env.AGENT_ID}.compensation.sqlite`;
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE requests"); db.close();
  assert.throws(() => compensationList(), /incomplete/);
});
test("private review and financial handoff have explicit capability requirements", () => {
  const reader = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
  assert.equal(mayCall(reader, "compensation/list"), true);
  for (const action of ["review", "prepare", "send", "agreement"]) assert.equal(mayCall(reader, `compensation/${action}`), false);
  assert.equal(mayCall({ ...reader, canExecute: true }, "compensation/review"), true);
  assert.equal(mayCall({ ...reader, canManage: true }, "compensation/agreement"), true);
});

test("amount-free reports require owner compensation and explanation, reserve that amount once", () => {
  const a = agreement();
  const { amount: _amount, ...report } = submit(a.id).report;
  const r = saveCompensationRequest("alice.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report });
  assert.equal(r.report.amount, undefined);
  assert.throws(() => reviewCompensationRequest("owner.near", review(r)), /compensation amount/);
  const c = { ...review(r), approvedAmount: "200000000", feedback: "Accepted the integration and tests under the signed terms." };
  const accepted = reviewCompensationRequest("owner.near", c);
  assert.equal(accepted.approvedAmount, "200000000");
  assert.deepEqual(reviewCompensationRequest("owner.near", c), accepted);
  assert.equal(compensationList().agreements[0]!.remaining, "700000000");
  assert.equal(accepted.report.amount, undefined);
  // With the owner's explicit amount, an amount-free report may take the shared payout.
  const bound = bindCompensationPayment("owner.near", { commandId: randomUUID(), id: r.id, expectedVersion: accepted.version, mode: "shared" });
  assert.equal(bound.payment?.mode, "shared"); assert.equal(approvedCompensation(bound), "200000000");
});

test("owner-decided compensation cannot exceed the ceiling or change the contributor's invoice", () => {
  const a = agreement(), r = submit(a.id);
  assert.throws(() => reviewCompensationRequest("owner.near", { ...review(r), approvedAmount: "950000000", feedback: "Reviewed" }), /remaining agreement ceiling/);
  assert.throws(() => reviewCompensationRequest("owner.near", { ...review(r), approvedAmount: "200000000" }), /explanation/);
  const accepted = reviewCompensationRequest("owner.near", { ...review(r), approvedAmount: "200000000", feedback: "Accepted the completed portion." });
  assert.equal(accepted.report.amount, "600000000");
  assert.equal(accepted.approvedAmount, "200000000");
  assert.equal(compensationList().agreements[0]!.remaining, "700000000");
});

test("missing owner compensation on a new approved invoice refuses instead of trusting its billed amount", () => {
  const a = agreement(), r = submit(a.id);
  const accepted = reviewCompensationRequest("owner.near", { ...review(r), approvedAmount: "200000000", feedback: "Accepted portion" });
  const { approvedAmount: _amount, ...damaged } = accepted;
  const db = new DatabaseSync(`.invoices/${process.env.AGENT_ID}.compensation.sqlite`);
  db.prepare("UPDATE requests SET record=? WHERE id=?").run(JSON.stringify(damaged), r.id); db.close();
  assert.throws(() => compensationList(), /Approved compensation evidence is missing/);
});
