import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { before, after, test } from "node:test";
import { api } from "../src/api.js";
import { sessionToken } from "../src/signin.js";
import { recordCompensationAgreement, reviewCompensationRequest, compensationList } from "../src/compensation-store.js";
import { localCompensation } from "../src/compensation.js";
import { mandateDigest } from "../src/mandate.js";
import { payoutPolicy } from "../src/policy.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory } from "./fixtures/harness.js";
import { type CompensationRequest } from "../src/compensation-contract.js";
import { closeWorkOrders } from "../src/work-order-pool.js";
import { getWorkOrder } from "../src/work-order-store.js";

freshDirectory("compensation-http", { per: "suite" });
const secret = "compensation-http-test-session-secret";
Object.assign(process.env, { INVOICES_PUBLIC_HOST: "localhost:8791", INVOICES_SESSION_SECRET: secret, AGREEMENTS_SECRET: "compensation-test-bridge", AGENT_GRANT_TOKEN: "ngt_test" });
const { invoiceHandler } = await import("../src/invoice-http.js");
const server = createServer(invoiceHandler);
let origin: string, sent = 0;
before(async () => {
  Object.assign(api, { ...authorityFixture(), getPolicy: async () => policyView(payoutPolicy(["alice.near"])),
    forGrant: () => ({ transfer: async () => { sent++; return { correlation_id: "compensation-http-payment" }; } }),
    getStatus: async (id: string) => ({ correlation_id: id, status: "PENDING_APPROVAL" }),
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await closeWorkOrders(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
const cookie = (account: string) => `invoices_session=${sessionToken(account, secret)}`;
const post = (path: string, body: unknown, account = "alice.near", extra = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie(account), ...extra }, body: JSON.stringify(body) });
let request: CompensationRequest;
test("schema is public, private records are not; public metadata submits nothing", async () => {
  assert.equal((await fetch(`${origin}/api/compensation/schema`)).status, 200);
  assert.equal((await fetch(`${origin}/api/compensation`)).status, 401);
  assert.equal((await post("/internal/compensation", { command: { type: "list" } })).status, 404);
  assert.equal(sent, 0);
});
test("authenticated report intake is recipient-bound, replayable and does not prepare or send payment", async () => {
  const a = recordCompensationAgreement("private-council-member.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, terms: { payee: "alice.near", title: "October", document: "https://docs.google.com/document/d/example", signedOn: "2026-10-01", start: "2026-10-01", end: "2026-10-31", ceiling: "10000000", openingApproved: "0", scope: "GitHub work" } });
  const c = { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: { agreementId: a.id, amount: "1000000", start: "2026-10-01", end: "2026-10-16", contributions: "Delivered the scoped work", assessment: "Ready for review", evidence: ["https://github.com/example/repo/pull/1"] } };
  assert.equal((await post("/api/compensation", c, "alice.near", { origin: "https://evil.test" })).status, 403);
  assert.equal((await post("/api/compensation", { ...c, payee: "bob.near" })).status, 400);
  assert.equal((await post("/api/compensation", c, "bob.near")).status, 404);
  const response = await post("/api/compensation", c); assert.equal(response.status, 200);
  request = await response.json() as CompensationRequest;
  // Keep the shared-payout tests as compatibility coverage for a record saved before this release.
  const { payoutMode: _mode, ...legacy } = request;
  const db = new DatabaseSync(`.invoices/${process.env.AGENT_ID}.compensation.sqlite`);
  db.prepare("UPDATE requests SET record=? WHERE id=?").run(JSON.stringify(legacy), request.id); db.close();
  assert.equal((await post("/api/compensation", c)).status, 200);
  assert.equal(compensationList().requests.length, 1); assert.equal(sent, 0);
  const view = await localCompensation(process.env.AGENT_ID!, "owner.near", { type: "list" });
  assert.equal(view.payments.length, 0);
});
test("contributor read projection redacts reviewing member identities and other records", async () => {
  const c = { commandId: randomUUID(), id: request.id, expectedVersion: request.version, decision: "approved" as const, feedback: "Accepted" };
  request = reviewCompensationRequest("private-council-member.near", c);
  const own = await (await fetch(`${origin}/api/compensation`, { headers: { cookie: cookie("alice.near") } })).text();
  assert.ok(!own.includes("private-council-member"));
  const other = await (await fetch(`${origin}/api/compensation`, { headers: { cookie: cookie("bob.near") } })).json() as { requests: unknown[]; agreements: unknown[]; history: unknown[] };
  assert.deepEqual(other.requests, []); assert.deepEqual(other.agreements, []); assert.deepEqual(other.history, []);
});
test("payment preparation is separate, policy-bound submission uses dispatch once, and approval stays reserved", async () => {
  const prepare = { type: "prepare" as const, command: { commandId: randomUUID(), id: request.id, expectedVersion: request.version, mode: "shared" as const } };
  let view = await localCompensation(process.env.AGENT_ID!, "owner.near", prepare);
  assert.equal(sent, 0); assert.equal(view.payments[0]?.status, "PREPARED");
  const send = { type: "send" as const, id: request.id, expectedPolicy: { revision: 1, digest: mandateDigest(payoutPolicy(["alice.near"])) } };
  view = await localCompensation(process.env.AGENT_ID!, "owner.near", send);
  assert.equal(sent, 1); assert.equal(view.payments[0]?.status, "PENDING_APPROVAL");
  await localCompensation(process.env.AGENT_ID!, "owner.near", prepare);
  await localCompensation(process.env.AGENT_ID!, "owner.near", send);
  assert.equal(sent, 1); assert.equal(compensationList().agreements[0]?.remaining, "9000000");
});
test("new direct invoice submissions cannot bypass an existing compensation agreement", async () => {
  const response = await post("/api/invoices", { submission: randomUUID(), amount: "2", note: "Bypass" });
  assert.equal(response.status, 409); assert.equal(sent, 1);
});
test("retained report records and sessions remain readable during a provider outage", async () => {
  const previous = api.getPolicy;
  api.getPolicy = async () => { throw new Error("provider unavailable"); };
  try {
    const session = await fetch(`${origin}/api/compensation/session`, { headers: { cookie: cookie("alice.near") } });
    assert.equal(session.status, 200);
    const response = await fetch(`${origin}/api/compensation`, { headers: { cookie: cookie("alice.near") } });
    assert.equal(response.status, 200);
    assert.equal(sent, 1);
  } finally { api.getPolicy = previous; }
});
test("isolated preparation retains one exact order without creating, funding or sending an agent", async () => {
  const a = compensationList().agreements[0]!;
  const c = { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: { ...request.report, agreementId: a.id } };
  const submitted = await (await post("/api/compensation", c)).json() as CompensationRequest;
  const approved = reviewCompensationRequest("owner.near", { commandId: randomUUID(), id: submitted.id, expectedVersion: submitted.version, decision: "approved", feedback: "" });
  const until = new Date(Date.now() + 86400000).toISOString();
  const preparation = { type: "prepare" as const, command: { commandId: randomUUID(), id: approved.id, expectedVersion: approved.version, mode: "isolated" as const, until } };
  await localCompensation(process.env.AGENT_ID!, "owner.near", preparation);
  await localCompensation(process.env.AGENT_ID!, "owner.near", preparation);
  const order = getWorkOrder(process.env.AGENT_ID!, approved.id);
  assert.equal(order.payee, approved.payee); assert.equal(order.amount, approved.report.amount); assert.equal(order.until, until);
  assert.equal(sent, 1);
  await assert.rejects(localCompensation(process.env.AGENT_ID!, "owner.near", { ...preparation, command: { ...preparation.command, commandId: randomUUID(), mode: "shared", until: undefined } }), /another payment path/);
});
test("a stale reviewed policy refuses the shared submission without releasing compensation", async () => {
  const a = compensationList().agreements[0]!;
  const c = { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: { ...request.report, agreementId: a.id } };
  const submitted = await (await post("/api/compensation", c)).json() as CompensationRequest;
  const db = new DatabaseSync(`.invoices/${process.env.AGENT_ID}.compensation.sqlite`);
  const { payoutMode: _mode, ...legacy } = submitted;
  db.prepare("UPDATE requests SET record=? WHERE id=?").run(JSON.stringify(legacy), submitted.id); db.close();
  const approved = reviewCompensationRequest("owner.near", { commandId: randomUUID(), id: submitted.id, expectedVersion: submitted.version, decision: "approved", feedback: "" });
  await localCompensation(process.env.AGENT_ID!, "owner.near", { type: "prepare", command: { commandId: randomUUID(), id: approved.id, expectedVersion: approved.version, mode: "shared" } });
  const remaining = compensationList().agreements[0]!.remaining;
  const result = await localCompensation(process.env.AGENT_ID!, "owner.near", { type: "send", id: approved.id, expectedPolicy: { revision: 999, digest: mandateDigest(payoutPolicy(["alice.near"])) } });
  assert.equal(result.payments.find(p => p.requestId === approved.id)?.refused, "reviewed_policy_changed");
  assert.equal(sent, 1); assert.equal(compensationList().agreements[0]!.remaining, remaining);
});

test("a report's owner-set amount prepares one isolated payout and remains visible to its contributor", async () => {
  const a = compensationList().agreements[0]!;
  const { amount: _amount, ...report } = request.report;
  const body = { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: { ...report, agreementId: a.id } };
  const result = await post("/api/compensation", body);
  assert.equal(result.status, 200);
  const submitted = await result.json() as CompensationRequest;
  assert.equal(submitted.report.amount, undefined);
  const accepted = reviewCompensationRequest("owner.near", { commandId: randomUUID(), id: submitted.id, expectedVersion: submitted.version, decision: "approved", approvedAmount: "2000000", feedback: "Accepted the reported integration." });
  const command = { type: "prepare" as const, command: { commandId: randomUUID(), id: accepted.id, expectedVersion: accepted.version, mode: "isolated" as const, until: new Date(Date.now() + 86400000).toISOString() } };
  await localCompensation(process.env.AGENT_ID!, "owner.near", command);
  await localCompensation(process.env.AGENT_ID!, "owner.near", command);
  const order = getWorkOrder(process.env.AGENT_ID!, accepted.id);
  assert.equal(order.amount, "2000000"); assert.equal(order.payee, "alice.near");
  assert.equal(sent, 1);
  const response = await fetch(`${origin}/api/compensation`, { headers: { cookie: cookie("alice.near") } });
  const own = await response.json() as { requests: CompensationRequest[]; payments: { requestId: string; status: string }[] };
  assert.equal(response.status, 200);
  assert.equal(own.requests.find(r => r.id === accepted.id)?.approvedAmount, "2000000");
  assert.equal(own.payments.find(p => p.requestId === accepted.id)?.status, "preparing");
  assert.equal(JSON.stringify(own).includes("ed25519:"), false);
});
