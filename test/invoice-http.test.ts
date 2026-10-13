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

const secret = "test-only-invoice-session-secret";
process.env.INVOICES_SESSION_SECRET = secret;
process.env.INVOICES_PUBLIC_HOST = "localhost:8791";
const { invoiceHandler } = await import("../src/invoice-http.js");
const server = createServer(invoiceHandler);
let origin: string;
const sent: { recipient: string; amount: string }[] = [];
freshDirectory("invoice-http", { per: "suite" });
before(async () => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  Object.assign(api, {
    ...authorityFixture(),
    getPolicy: async () => policyView(payoutPolicy(["alice.near", "bob.near"])),
    forGrant: () => ({ transfer: async (_id: string, request: { recipient: string; amount: string }) => {
      sent.push(request); return { correlation_id: "invoice-http" };
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
  assert.deepEqual(await other.json(), { invoices: [] });
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
