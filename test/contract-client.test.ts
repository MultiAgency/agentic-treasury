import assert from "node:assert/strict";
import { test } from "node:test";
import { payeeClient } from "../src/contract/index.js";

const submission = "0b3a9c2e-4f61-4d2a-9b7e-1c5d8e2f6a90";
const draft = { submission, amount: "1", note: "Work" };
function fixture(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, client: payeeClient({ base: "/i/own-0123456789abcdef01234567", fetch: async (url, init) => { calls.push({ url, init }); return answer(); } }) };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a lost mutation response is unknown, echoes the caller's identity, and is never retried", async () => {
  const { calls, client } = fixture(() => { throw new TypeError("network"); });
  assert.deepEqual(await client.submitInvoice(draft), { ok: false, kind: "unknown", identity: { submission } });
  assert.deepEqual(await client.fileWorkOrder(submission), { ok: false, kind: "unknown", identity: { workOrderId: submission } });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(String(calls[0]!.init.body)).submission, submission);
  assert.equal(calls[0]!.url, "/i/own-0123456789abcdef01234567/api/invoices");
});

test("a server failure or unreadable success after a mutation is unknown, not a refusal", async () => {
  for (const response of [json(502, { error: "Invoice backend unavailable." }), new Response("<html>", { status: 200 }), json(200, { id: 1 })])
    assert.deepEqual(await fixture(() => response).client.continueInvoice("a".repeat(32)), { ok: false, kind: "unknown", identity: { invoiceId: "a".repeat(32) } });
});

test("a failed read is unavailable and carries no identity", async () => {
  assert.deepEqual(await fixture(() => { throw new TypeError("network"); }).client.invoices(), { ok: false, kind: "unavailable" });
  assert.deepEqual(await fixture(() => json(200, { invoices: "no" })).client.invoices(), { ok: false, kind: "unavailable" });
});

test("401 and 403 stay distinct; other 4xx answers are refusals with their public code", async () => {
  assert.deepEqual(await fixture(() => json(401, { error: "Sign in." })).client.invoices(), { ok: false, kind: "session", status: 401, error: "Sign in." });
  assert.deepEqual(await fixture(() => json(403, { error: "Wrong origin." })).client.submitInvoice(draft), { ok: false, kind: "forbidden", status: 403, error: "Wrong origin." });
  assert.deepEqual(await fixture(() => json(409, { code: "stale_request", error: "Refresh." })).client.submitInvoice(draft),
    { ok: false, kind: "refused", status: 409, error: "Refresh.", code: "stale_request" });
});

test("compensation commands keep every caller identity; invalid input never reaches the network", async () => {
  const { calls, client } = fixture(() => { throw new TypeError("network"); });
  const command = { commandId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f", id: "7a1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f", expectedVersion: 3, submit: true,
    report: { agreementId: "8b1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f", start: "2026-10-01", end: "2026-10-02", contributions: "Work", assessment: "Done", evidence: [] } };
  assert.deepEqual(await client.submitReport(command), { ok: false, kind: "unknown", identity: { commandId: command.commandId, id: command.id, expectedVersion: 3 } });
  assert.throws(() => client.submitReport({ ...command, expectedVersion: -1 }));
  assert.equal(calls.length, 1);
});

test("401 and 403 stay session and forbidden even when the body is not JSON (a proxy or gateway page)", async () => {
  const page = (status: number) => () => new Response("<html>Sign in again</html>", { status, headers: { "content-type": "text/html" } });
  assert.deepEqual(await fixture(page(401)).client.invoices(), { ok: false, kind: "session", status: 401, error: "Sign in again." });
  assert.deepEqual(await fixture(page(401)).client.submitInvoice(draft), { ok: false, kind: "session", status: 401, error: "Sign in again." });
  assert.deepEqual(await fixture(page(403)).client.invoices(), { ok: false, kind: "forbidden", status: 403, error: "This account may not do that." });
  assert.deepEqual(await fixture(page(403)).client.submitInvoice(draft), { ok: false, kind: "forbidden", status: 403, error: "This account may not do that." });
});
