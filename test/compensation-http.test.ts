import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { before, after, test } from "node:test";
import { api } from "../src/api.js";
import { sessionToken } from "../src/signin.js";
import { recordCompensationAgreement, reviewCompensationRequest, compensationList } from "../src/compensation-store.js";
import { localCompensation, ownerCompensation } from "../src/compensation.js";
import { CompensationError } from "../src/compensation-store.js";
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
  assert.equal((await post("/api/compensation", c)).status, 200);
  assert.equal(compensationList().requests.length, 1); assert.equal(sent, 0);
  const view = await localCompensation(process.env.AGENT_ID!, "owner.near", { type: "list" });
  assert.equal(view.payments.length, 0);
});
test("contributor read projection redacts reviewing member identities and other records", async () => {
  const c = { commandId: randomUUID(), id: request.id, expectedVersion: request.version, decision: "approved" as const, approvedAmount: "1000000", feedback: "Accepted" };
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
  assert.equal(response.status, 409); assert.equal((await response.json() as { code?: string }).code, "review_required"); assert.equal(sent, 1);
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
  const approved = reviewCompensationRequest("owner.near", { commandId: randomUUID(), id: submitted.id, expectedVersion: submitted.version, decision: "approved", approvedAmount: "1000000", feedback: "" });
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
  const approved = reviewCompensationRequest("owner.near", { commandId: randomUUID(), id: submitted.id, expectedVersion: submitted.version, decision: "approved", approvedAmount: "1000000", feedback: "" });
  await localCompensation(process.env.AGENT_ID!, "owner.near", { type: "prepare", command: { commandId: randomUUID(), id: approved.id, expectedVersion: approved.version, mode: "shared" } });
  const remaining = compensationList().agreements[0]!.remaining;
  await assert.rejects(localCompensation(process.env.AGENT_ID!, "owner.near", { type: "send", id: approved.id, expectedPolicy: { revision: 999, digest: mandateDigest(payoutPolicy(["alice.near"])) } }),
    (error: unknown) => error instanceof CompensationError && error.code === "reviewed_policy_changed");
  assert.equal((await localCompensation(process.env.AGENT_ID!, "owner.near", { type: "list" })).payments.find(p => p.requestId === approved.id)?.status, "PREPARED", "retryable after review");
  assert.equal(sent, 1); assert.equal(compensationList().agreements[0]!.remaining, remaining);
});

/** A fresh ordinary report by `payee` under `agreementId`, approved by the owner with an explicit amount. */
async function approvedReport(agreementId: string, payee = "alice.near", amount = "1000000") {
  const body = { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: { ...request.report, agreementId } };
  const submitted = await (await post("/api/compensation", body, payee)).json() as CompensationRequest;
  return reviewCompensationRequest("owner.near", { commandId: randomUUID(), id: submitted.id, expectedVersion: submitted.version, decision: "approved", approvedAmount: amount, feedback: "" });
}
const sharedPrepare = (r: CompensationRequest) => localCompensation(process.env.AGENT_ID!, "owner.near", { type: "prepare", command: { commandId: randomUUID(), id: r.id, expectedVersion: r.version, mode: "shared" } });
const sharedSend = (r: CompensationRequest) => localCompensation(process.env.AGENT_ID!, "owner.near", { type: "send", id: r.id, expectedPolicy: { revision: 1, digest: mandateDigest(payoutPolicy(["alice.near"])) } });

test("approval needs the owner's explicit amount, even when the report requested one", async () => {
  const a = compensationList().agreements[0]!;
  const body = { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true, report: { ...request.report, agreementId: a.id } };
  const submitted = await (await post("/api/compensation", body)).json() as CompensationRequest;
  assert.equal(submitted.report.amount, "1000000");
  assert.throws(() => reviewCompensationRequest("owner.near", { commandId: randomUUID(), id: submitted.id, expectedVersion: submitted.version, decision: "approved", feedback: "" }),
    (error: unknown) => error instanceof CompensationError && error.code === "amount_required");
});

test("a request bound to its isolated order stays isolated", async () => {
  const r = await approvedReport(compensationList().agreements[0]!.id);
  const isolated = { type: "prepare" as const, command: { commandId: randomUUID(), id: r.id, expectedVersion: r.version, mode: "isolated" as const, until: new Date(Date.now() + 86400000).toISOString() } };
  await localCompensation(process.env.AGENT_ID!, "owner.near", isolated);
  await assert.rejects(sharedPrepare(r), (error: unknown) => error instanceof CompensationError && error.code === "payment_bound" && /another payment path/.test(error.message));
});

test("a shared send to a builder outside the payout policy refuses as payee_not_agreed and sends nothing", async () => {
  const carol = recordCompensationAgreement("owner.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, terms: { payee: "carol.near", title: "Builder", document: "https://docs.google.com/document/d/carol", signedOn: "2026-10-01", start: "2026-10-01", end: "2026-10-31", ceiling: "10000000", openingApproved: "0", scope: "Builder work" } });
  const r = await approvedReport(carol.id, "carol.near");
  await sharedPrepare(r);
  const before = sent;
  await assert.rejects(sharedSend(r), (error: unknown) => error instanceof CompensationError && error.code === "payee_not_agreed");
  assert.equal(sent, before);
  assert.equal((await localCompensation(process.env.AGENT_ID!, "owner.near", { type: "list" })).payments.find(p => p.requestId === r.id)?.status, "PREPARED", "the retained payment can be sent once the builder is agreed");
});

test("a shared send above the available balance refuses before sending and retries on the same identity", async () => {
  const r = await approvedReport(compensationList().agreements[0]!.id);
  await sharedPrepare(r);
  const balances = api.getBalances, before = sent;
  // Available = balance less held payouts: one unit short of this payment.
  api.getBalances = (async (_id: string, { source }: { source: string }) => ({ near_account_id: "fixture.near", source, balances: [{ asset_id: (await import("../src/policy.js")).ASSETS.USDC, balance_raw: "999999" }] })) as typeof api.getBalances;
  try {
    await assert.rejects(sharedSend(r), (error: unknown) => error instanceof CompensationError && error.code === "insufficient_balance");
    assert.equal(sent, before, "nothing was sent");
    const view = await localCompensation(process.env.AGENT_ID!, "owner.near", { type: "list" });
    assert.equal(view.payments.find(p => p.requestId === r.id)?.status, "PREPARED", "the payment stays prepared on its identity");
  } finally { api.getBalances = balances; }
  const retried = await sharedSend(r);
  assert.equal(sent, before + 1, "the same retained payment is sent once funds suffice");
  assert.equal(retried.payments.filter(p => p.requestId === r.id).length, 1, "one payment identity");
});

test("a report's owner-set amount prepares one isolated payout and remains visible to its contributor", async () => {
  const before = sent;
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
  assert.equal(sent, before);
  const response = await fetch(`${origin}/api/compensation`, { headers: { cookie: cookie("alice.near") } });
  const own = await response.json() as { requests: CompensationRequest[]; payments: { requestId: string; status: string }[] };
  assert.equal(response.status, 200);
  assert.equal(own.requests.find(r => r.id === accepted.id)?.approvedAmount, "2000000");
  assert.equal(own.payments.find(p => p.requestId === accepted.id)?.status, "preparing");
  assert.equal(JSON.stringify(own).includes("ed25519:"), false);
});

test("through the approve-only bridge only the executor's coded refusal stays refused; any other failure stays uncertain", async () => {
  const saved = { url: process.env.AGREEMENTS_URL, port: process.env.INVOICES_PORT, fetch: globalThis.fetch };
  process.env.AGREEMENTS_URL = "http://executor.test"; delete process.env.INVOICES_PORT;
  const answer = (status: number, body: string, type = "application/json") => { globalThis.fetch = async () => new Response(body, { status, headers: { "content-type": type } }); };
  const send = () => ownerCompensation("owner.near", { type: "send", id: randomUUID(), expectedPolicy: { revision: 1, digest: `sha256:${"0".repeat(64)}` } });
  try {
    answer(400, JSON.stringify({ error: "Refresh the request.", code: "stale_request" }));
    await assert.rejects(send(), (error: unknown) => error instanceof CompensationError && error.code === "stale_request");
    // An uncoded executor error, a 5xx and a proxy page may follow a send: never presented as refused.
    for (const [status, body, type] of [[400, JSON.stringify({ error: "disk full" }), "application/json"], [502, JSON.stringify({ error: "x", code: "stale_request" }), "application/json"], [502, "<html>Bad gateway</html>", "text/html"]] as const) {
      answer(status, body, type);
      await assert.rejects(send(), (error: unknown) => error instanceof Error && !(error instanceof CompensationError), `${status} ${body}`);
    }
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.AGREEMENTS_URL; else process.env.AGREEMENTS_URL = saved.url;
    if (saved.port !== undefined) process.env.INVOICES_PORT = saved.port;
  }
});
