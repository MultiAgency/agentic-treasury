import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { api } from "../src/api.js";
import { sessionToken } from "../src/signin.js";
import { payoutPolicy } from "../src/policy.js";
import { localWorkOrders, workOrders } from "../src/work-orders.js";
import { closeWorkOrders } from "../src/work-order-pool.js";
import { WorkOrderRefusal } from "../src/work-order-protocol.js";
import { freshDirectory } from "./fixtures/harness.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";

const secret = "work-order-session-test";
process.env.INVOICES_SESSION_SECRET = secret;
process.env.INVOICES_PUBLIC_HOST = "localhost:8791";
process.env.AGREEMENTS_SECRET = "work-order-bridge-test";
const { invoiceHandler } = await import("../src/invoice-http.js");
const server = createServer(invoiceHandler);
let origin: string;
const parent = process.env.AGENT_ID!;
const input = { id: "12345678-1234-4234-8234-123456789abc", payee: "alice.near", amount: "1000000",
  note: "Design work", until: new Date(Date.now() + 86_400_000).toISOString() };
freshDirectory("work-order-http", { per: "suite" });
before(async () => {
  Object.assign(api, { ...authorityFixture(), getPolicy: async () => policyView(payoutPolicy([input.payee])) });
  await localWorkOrders(parent, { type: "create", input });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await closeWorkOrders(); await new Promise<void>(resolve => server.close(() => resolve())); });
const headers = (account: string) => ({ cookie: `invoices_session=${sessionToken(account, secret)}` });
const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(origin + path,
  { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

test("work orders require authentication and expose only the signed-in payee's fixed terms", async () => {
  assert.equal((await fetch(origin + "/api/work-orders")).status, 401);
  assert.deepEqual(await (await fetch(origin + "/api/work-orders", { headers: headers("bob.near") })).json(), { orders: [] });
  const response = await fetch(origin + "/api/work-orders", { headers: headers("alice.near") });
  const text = await response.text();
  assert.equal(JSON.parse(text).orders[0].id, input.id);
  assert.doesNotMatch(text, /parentAgentId|owner|public_key|asset|grant|wallet/);
  assert.equal((await fetch(origin + `/api/work-orders/${input.id}`, { headers: headers("bob.near") })).status, 404);
  assert.equal((await post(`/api/work-orders/${input.id}/file`, {}, headers("bob.near"))).status, 404);
});

test("order intake rejects cross-origin writes and client-supplied replacement terms", async () => {
  assert.equal((await post(`/api/work-orders/${input.id}/file`, {}, { ...headers("alice.near"), origin: "https://other.test" })).status, 403);
  for (const override of [{ amount: "2" }, { payee: "bob.near" }, { submission: "new" }, { agentId: parent }])
    assert.equal((await post(`/api/work-orders/${input.id}/file`, override, headers("alice.near"))).status, 400);
});

test("the work-order bridge requires the secret and refuses a different configured parent", async () => {
  assert.equal((await post("/internal/work-orders", { parentAgentId: parent, request: { type: "list" } })).status, 404);
  const authorization = "Bearer work-order-bridge-test";
  assert.equal((await post("/internal/work-orders", { parentAgentId: "other", request: { type: "list" } }, { authorization })).status, 400);
  const result = await post("/internal/work-orders", { parentAgentId: parent, request: { type: "list" } }, { authorization });
  assert.equal((await result.json() as { result: { id: string }[] }).result[0]!.id, input.id);
  process.env.AGREEMENTS_URL = origin;
  try { assert.equal((await workOrders.list())[0]!.id, input.id); }
  finally { delete process.env.AGREEMENTS_URL; }
});

test("contributors propose fixed work orders without authorizing or filing a payout", async () => {
  const draft = { submission: "abcdef12-1234-4234-8234-123456789abc", amount: "2.50", note: "Contributor work",
    until: new Date(Date.now() + 2 * 86_400_000).toISOString() };
  assert.equal((await post("/api/work-orders", draft)).status, 401);
  assert.equal((await post("/api/work-orders", draft, { ...headers("carol.near"), origin: "https://other.test" })).status, 403);
  for (const extra of [{ payee: "alice.near" }, { owner: {} }, { agentId: parent }])
    assert.equal((await post("/api/work-orders", { ...draft, ...extra }, headers("carol.near"))).status, 400);
  const response = await post("/api/work-orders", draft, headers("carol.near"));
  assert.equal(response.status, 200);
  const result = await response.json() as { id: string; status: string };
  assert.equal(result.status, "requested");
  assert.deepEqual(await (await post("/api/work-orders", draft, headers("carol.near"))).json(), result);
  assert.equal((await post("/api/work-orders", { ...draft, amount: "3" }, headers("carol.near"))).status, 409);
  const order = (await workOrders.list()).find(order => order.id === result.id)!;
  assert.equal(order.payee, "carol.near");
  assert.equal(order.amount, "2500000");
  assert.equal((await fetch(origin + `/api/work-orders/${result.id}`, { headers: headers("alice.near") })).status, 404);
  const snapshot = await workOrders.get(result.id);
  assert.equal(snapshot.agentId, null);
  assert.equal(snapshot.invoice, null);
  assert.equal(snapshot.ownerActions.length, 0);
});

test("contributor intake bounds concurrent requests and preserves known identities", async () => {
  const { randomUUID } = await import("node:crypto");
  const draft = { amount: "1", note: "Bounded request", until: new Date(Date.now() + 86_400_000).toISOString() };
  const requests = Array.from({ length: 4 }, () => ({ ...draft, submission: randomUUID() }));
  const responses = await Promise.all(requests.map(body => post("/api/work-orders", body, headers("limits.near"))));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 200, 429]);
  const known = requests[responses.findIndex(response => response.status === 200)]!;
  assert.equal((await post("/api/work-orders", known, headers("limits.near"))).status, 200);
  for (const until of ["not-a-date", new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 366 * 86_400_000).toISOString()])
    assert.equal((await post("/api/work-orders", { ...draft, submission: randomUUID(), until }, headers("dates.near"))).status, 400);
});

/** Every line of every operation journal under this directory: dispatch records a request before any send. */
const journalLines = () => existsSync(".ops") ? readdirSync(".ops").filter(f => f.endsWith(".jsonl")).flatMap(f => readFileSync(join(".ops", f), "utf8").split("\n").filter(Boolean)) : [];

test("filing an order that is not yet authorized and exactly funded is a coded refusal, and creates nothing", async () => {
  const journal = journalLines();
  const response = await post(`/api/work-orders/${input.id}/file`, {}, headers("alice.near"));
  assert.equal(response.status, 409);
  const body = await response.json() as { code: string; error: string };
  assert.equal(body.code, "work_order_not_ready");
  assert.match(body.error, /Nothing was sent/);
  const snapshot = await workOrders.get(input.id);
  assert.equal(snapshot.invoice, null);
  assert.equal(snapshot.ownerActions.length, 0);
  assert.deepEqual(journalLines(), journal, "no request was recorded, so nothing was sent");
});

test("through the approve-only bridge, only the known not-ready refusal stays typed; anything else stays uncertain", async () => {
  process.env.AGREEMENTS_URL = origin;
  try {
    // Not authorized or funded: the executor refuses before any send, and the approve-only host keeps that refusal.
    for (const call of [() => workOrders.file(input.id), () => workOrders.deposit(input.id)])
      await assert.rejects(call(), (error: unknown) => error instanceof WorkOrderRefusal && error.code === "work_order_not_ready");
    const snapshot = await workOrders.get(input.id);
    assert.equal(snapshot.invoice, null, "no submission");
    assert.equal(snapshot.ownerActions.length, 0);
    // Any other executor error is not a refusal.
    await assert.rejects(workOrders.status(input.id, "not-an-action"), (error: unknown) => error instanceof Error && !(error instanceof WorkOrderRefusal));
    // An unknown refusal code, a generic 400 and a provider-style 5xx are not reconstructed either.
    for (const answer of [{ status: 400, body: { error: "x", refusal: "something_else" } }, { status: 400, body: { error: "x" } }, { status: 502, body: { error: "x", refusal: "work_order_not_ready" } }]) {
      const original = globalThis.fetch;
      globalThis.fetch = async () => Response.json(answer.body, { status: answer.status });
      try { await assert.rejects(workOrders.file(input.id), (error: unknown) => error instanceof Error && !(error instanceof WorkOrderRefusal), JSON.stringify(answer)); }
      finally { globalThis.fetch = original; }
    }
  } finally { delete process.env.AGREEMENTS_URL; }
});
