import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { api } from "../src/api.js";
import { sessionToken } from "../src/signin.js";
import { AgentConnections } from "../src/agent-connections.js";
import { PAYEE_ROLE } from "../src/contract/agent-connection.js";
import { compensationList, recordCompensationAgreement } from "../src/compensation-store.js";
import { listInvoices } from "../src/invoice-store.js";
import { payoutPolicy } from "../src/policy.js";
import { payeeClient } from "../src/contract/client.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory } from "./fixtures/harness.js";
import { closeWorkOrders } from "../src/work-order-pool.js";

// The contractor-report agent connection on a real payee server: issuance from the browser session only,
// exactly the permitted routes for the bearer, and refusal everywhere else, without any business mutation.
freshDirectory("agent-connections", { per: "suite" });
const secret = "agent-connections-test-session";
Object.assign(process.env, { INVOICES_PUBLIC_HOST: "localhost:8791", INVOICES_SESSION_SECRET: secret, AGENT_GRANT_TOKEN: "ngt_test" });
const { invoiceHandler } = await import("../src/invoice-http.js");
const server = createServer(invoiceHandler);
let origin: string, sent = 0, agreementId: string;
before(async () => {
  Object.assign(api, { ...authorityFixture(), getPolicy: async () => policyView(payoutPolicy(["alice.near"])),
    forGrant: () => ({ transfer: async () => { sent++; return { correlation_id: "agent-connection-payment" }; } }) });
  agreementId = recordCompensationAgreement("owner.near", { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, terms: { payee: "alice.near", title: "October",
    document: "https://docs.google.com/document/d/example", signedOn: "2026-10-01", start: "2026-10-01", end: "2026-10-31", ceiling: "10000000", openingApproved: "0", scope: "Work" } }).id;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await closeWorkOrders(); await new Promise<void>(resolve => server.close(() => resolve())); });

const cookie = (account: string) => ({ cookie: `invoices_session=${sessionToken(account, secret)}` });
const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(`${origin}${path}`, { method, headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const report = () => ({ commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true,
  report: { agreementId, amount: "1000000", start: "2026-10-01", end: "2026-10-15", contributions: "Delivered", assessment: "Ready", evidence: [] } });
async function start(account = "alice.near") {
  const response = await call("POST", "/api/agent-connections", cookie(account), { label: "Report agent" });
  assert.equal(response.status, 201);
  return await response.json() as { connection: { id: string; permissions: string[] }; token: string };
}

test("only the contractor's browser session issues, lists and revokes; an agent can never manage connections", async () => {
  assert.equal((await call("POST", "/api/agent-connections", {}, { label: "x" })).status, 401);
  const { connection, token } = await start();
  assert.deepEqual(connection.permissions, ["compensation.read", "compensation.submit"]);
  for (const [method, path] of [["GET", "/api/agent-connections"], ["POST", "/api/agent-connections"], ["DELETE", `/api/agent-connections/${connection.id}`]] as const)
    assert.equal((await call(method, path, { ...cookie("alice.near"), ...bearer(token) }, method === "POST" ? { label: "y" } : undefined)).status, 403, `${method} ${path}`);
  const listed = await (await call("GET", "/api/agent-connections", cookie("alice.near"))).text();
  assert.match(listed, new RegExp(connection.id));
  assert.doesNotMatch(listed, /secretHash|tac_/, "never the hash or the secret");
  assert.deepEqual(JSON.parse(await (await call("GET", "/api/agent-connections", cookie("bob.near"))).text()).connections, [], "another account sees none");
  assert.equal((await call("DELETE", `/api/agent-connections/${connection.id}`, cookie("bob.near"))).status, 404, "another account cannot revoke");
});

test("the bearer reaches exactly its own reports: read, submit, session; the cookie is never consulted", async () => {
  const { connection, token } = await start();
  const agent = payeeClient({ base: origin, token });
  const submitted = report();
  // A different account's cookie alongside the bearer changes nothing: the connection's account acts.
  const response = await call("POST", "/api/compensation", { ...bearer(token), ...cookie("bob.near") }, submitted);
  assert.equal(response.status, 200);
  assert.equal(compensationList("alice.near").requests.filter(r => r.id === submitted.id).length, 1);
  const view = await agent.compensation();
  assert.ok(view.ok && view.value.requests.some(r => r.id === submitted.id));
  assert.deepEqual(await agent.compensationSession(), { ok: true, value: { account: "alice.near" } });
  // An exact retry returns the same record: the agent recovers a lost reply by identity, never by a new request.
  const again = await agent.submitReport(submitted);
  assert.ok(again.ok && again.value.id === submitted.id);
  const lines = readFileSync(".agent-connections/access.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(lines.some(l => l.connectionId === connection.id && l.method === "POST" && l.commandId === submitted.commandId && l.id === submitted.id && l.account === "alice.near"));
  assert.ok(lines.every(l => l.host === "localhost:8791" && l.instance === "/" && l.agentId === process.env.AGENT_ID));
  assert.equal(sent, 0, "a report never sends a payment");
});

test("every excluded route refuses the bearer before any business effect, and it never becomes a browser session", async () => {
  const { token } = await start();
  const before = { invoices: listInvoices().length, requests: compensationList().requests.length };
  const excluded: [string, string, unknown?][] = [["GET", "/api/invoices"], ["POST", "/api/invoices", { submission: randomUUID(), amount: "1000000", note: "x" }],
    ["POST", `/api/invoices/${"0".repeat(32)}/continue`, {}], ["GET", "/api/work-orders"], ["POST", "/api/work-orders", {}], ["GET", `/api/work-orders/${randomUUID()}`],
    ["POST", `/api/work-orders/${randomUUID()}/file`, {}], ["GET", "/api/session"], ["POST", "/api/signin", {}], ["POST", "/api/signin/challenge", {}],
    ["POST", "/api/signout", {}], ["POST", "/api/compensation/signin", {}], ["PUT", "/api/compensation", {}]];
  for (const [method, path, body] of excluded) {
    const response = await call(method, path, { ...bearer(token), ...cookie("alice.near") }, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.headers.get("set-cookie"), null, `${method} ${path} opens no session`);
  }
  assert.deepEqual({ invoices: listInvoices().length, requests: compensationList().requests.length }, before, "no business mutation");
  assert.equal(sent, 0);
});

test("expired, revoked, malformed and substituted connections are refused as 401 with nothing changed", async () => {
  const store = new AgentConnections(".agent-connections");
  const binding = { role: PAYEE_ROLE, account: "alice.near", host: "localhost:8791", instance: "/", agentId: process.env.AGENT_ID!, permissions: ["compensation.read", "compensation.submit"] as const, label: "x" };
  // Positive control: a token issued the same way, with the matching binding, is accepted, so each refusal below is
  // caused by its one difference.
  const control = store.issue(binding).token;
  assert.equal((await call("GET", "/api/compensation", { authorization: `Bearer ${control}` })).status, 200, "a correctly bound connection reads");
  const expired = store.issue({ ...binding, ttlSeconds: 60 }, Date.now() - 120_000).token;
  const otherHost = store.issue({ ...binding, host: "other.example" }).token;
  const otherInstance = store.issue({ ...binding, instance: "/i/own-000000000000000000000000" }).token;
  const otherAgent = store.issue({ ...binding, agentId: "f".repeat(64) }).token;
  const { connection, token: revoked } = await start();
  assert.equal((await call("DELETE", `/api/agent-connections/${connection.id}`, cookie("alice.near"))).status, 200);
  const live = (await start()).token;
  const forged = `${live.slice(0, live.lastIndexOf(".") + 1)}${"A".repeat(43)}`;
  const requests = compensationList().requests.length;
  for (const token of [expired, otherHost, otherInstance, otherAgent, revoked, forged, "tmc_not-a-connection", "Basic x"]) {
    for (const [method, body] of [["GET", undefined], ["POST", report()]] as const)
      assert.equal((await call(method, "/api/compensation", { authorization: token.startsWith("tac_") ? `Bearer ${token}` : token }, body)).status, 401, token.slice(0, 12));
  }
  assert.equal(compensationList().requests.length, requests);
  const agent = await payeeClient({ base: origin, token: revoked }).compensation();
  assert.deepEqual(agent, { ok: false, kind: "session", status: 401, error: "Invalid, expired or revoked agent connection." });
});

test("the client's connection methods run on the browser session; a lost start is unavailable, never retried", async () => {
  const browser = payeeClient({ base: origin, fetch: (input, init) => fetch(input, { ...init, headers: { ...init.headers as Record<string, string>, ...cookie("alice.near") } }) });
  const started = await browser.startAgentConnection({ label: "From the page", ttlSeconds: 600 });
  assert.ok(started.ok);
  const listed = await browser.agentConnections();
  assert.ok(listed.ok && listed.value.connections.some(c => c.id === started.value.connection.id));
  assert.deepEqual(await browser.revokeAgentConnection(started.value.connection.id), { ok: true, value: { revoked: true } });
  let requests = 0;
  const lost = payeeClient({ base: origin, fetch: async () => { requests++; throw new TypeError("network"); } });
  assert.deepEqual(await lost.startAgentConnection({ label: "x" }), { ok: false, kind: "unavailable" });
  assert.equal(requests, 1);
  assert.ok(existsSync(".agent-connections"));
});
