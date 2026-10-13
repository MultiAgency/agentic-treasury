import { authorityFixture, policyView } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { api } from "../src/api.js";
import { sessionToken } from "../src/signin.js";
import { payoutPolicy } from "../src/policy.js";
import { getInvoice, invoiceId } from "../src/invoice-store.js";
import { mayCall } from "../src/gateway/allowlist.js";
import { freshDirectory } from "./fixtures/harness.js";
import { remoteStore } from "../src/agreements.js";

const secret = "test-only-invoice-session-secret";
process.env.INVOICES_SESSION_SECRET = secret;
process.env.INVOICES_PUBLIC_HOST = "localhost:8791";
process.env.AGREEMENTS_SECRET = "test-only-agreements-secret";
const { invoiceHandler } = await import("../src/invoice-http.js");
const server = createServer(invoiceHandler);
let origin: string;
const sent: { recipient: string; amount: string }[] = [];
const payees = ["alice.near", "bob.near"];
freshDirectory("invoice-http", { per: "suite" });
before(async () => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  Object.assign(api, {
    ...authorityFixture(),
    getPolicy: async () => policyView(payoutPolicy(payees)),
    forGrant: () => ({ transfer: async (_id: string, request: { recipient: string; amount: string }) => {
      sent.push(request); return { correlation_id: `invoice-http-${sent.length}` };
    } }),
    getStatus: async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
});

const cookie = (payee: string) => `invoices_session=${sessionToken(payee, secret)}`;
const submit = (headers: Record<string, string>, payload: unknown) => fetch(`${origin}/api/invoices`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload),
});
const draft = { submission: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", amount: "1", note: "Work" };

test("HTTP endpoints reject missing or forged identity before filing", async () => {
  assert.equal((await submit({}, draft)).status, 401);
  assert.equal((await submit({ cookie: "invoices_session=forged" }, draft)).status, 401);
  assert.equal((await fetch(`${origin}/api/invoices`)).status, 401);
  assert.equal(sent.length, 0);
});

test("cross-origin writes fail; authenticated account, not JSON recipient, controls payment", async () => {
  assert.equal((await submit({ cookie: cookie("alice.near"), origin: "https://evil.test" }, draft)).status, 403);
  const response = await submit({ cookie: cookie("alice.near"), origin: "http://localhost:8791" }, { ...draft, payee: "bob.near" });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "paid");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.recipient, "alice.near");
  assert.equal(getInvoice(invoiceId({ payee: "alice.near", submission: draft.submission }))?.reservation, "0");
});

test("retries retain identity and another signed-in payee cannot read it", async () => {
  const response = await submit({ cookie: cookie("alice.near") }, draft);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  const other = await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("bob.near") } });
  assert.deepEqual(await other.json(), { invoices: [], agreements: [] });
  const mine = await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("alice.near") } });
  const text = await mine.text();
  assert.equal((JSON.parse(text) as { invoices: unknown[] }).invoices.length, 1);
  assert.ok(!text.includes("correlation") && !text.includes("ngt_") && !text.includes("idempotency"));
});

test("invoice review and cancellation are operator-only at the gateway", () => {
  for (const path of ["invoices", "cancelPreparedInvoice"]) {
    assert.equal(mayCall("member", path), false);
    assert.equal(mayCall("operator", path), true);
  }
});

const request = { submission: "cccccccc-dddd-eeee-ffff-000000000001", amount: "2.5", note: "Bounty: docs" };

test("an account not yet agreed files an agreement request: recorded, visible only to it, never paid", async () => {
  const response = await submit({ cookie: cookie("carol.near") }, request);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "requested");
  assert.equal(sent.length, 1, "nothing was sent");
  assert.equal(getInvoice(invoiceId({ payee: "carol.near", submission: request.submission })), undefined, "no invoice or reservation");
  const own = await (await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("carol.near") } })).json() as { agreements: { status: string; amount: string }[] };
  assert.deepEqual(own.agreements.map((a) => [a.status, a.amount]), [["requested", "2500000"]]);
  const other = await (await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("bob.near") } })).json() as { agreements: unknown[] };
  assert.deepEqual(other.agreements, [], "another payee never sees it");
});

test("the internal endpoint answers only the shared secret, and the dashboard's store works through it", async () => {
  for (const authorization of [undefined, "Bearer wrong", "Bearer test-only-agreements-secre"])
    assert.equal((await fetch(`${origin}/internal/agreements`, { headers: authorization ? { authorization } : {} })).status, 404);
  const store = remoteStore(origin, "test-only-agreements-secret");
  const [carol] = (await store.list()).filter((a) => a.payee === "carol.near");
  assert.equal(carol?.status, "requested");
  await store.propose(carol!.id, new Date(Date.now() + 86_400_000));
  assert.equal((await store.list()).find((a) => a.id === carol!.id)?.status, "proposed");
  await assert.rejects(store.offer({ payee: "not an account!", amount: "1", note: "", until: new Date(Date.now() + 1000) }), /payee/);
  await assert.rejects(store.offer({ payee: "dana.near", amount: "1", note: "", until: new Date(Date.now() - 1000) }), /future/);
  const offered = await store.offer({ payee: "dana.near", amount: "5", note: "Award", until: new Date(Date.now() + 86_400_000) });
  await store.decline(offered);
  assert.equal((await store.list()).find((a) => a.id === offered)?.status, "declined");
});

test("once agreed, the payee files the request as an invoice: same identity, paid through the one send path", async () => {
  payees.push("carol.near");
  const response = await submit({ cookie: cookie("carol.near") }, request);
  assert.equal((await response.json() as { status: string }).status, "paid");
  assert.equal(sent.at(-1)?.recipient, "carol.near");
  assert.equal(sent.at(-1)?.amount, "2500000");
  const own = await (await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("carol.near") } })).json() as { agreements: unknown[]; invoices: unknown[] };
  assert.deepEqual(own.agreements, [], "a filed agreement shows as its invoice");
  assert.equal(own.invoices.length, 1);
});
