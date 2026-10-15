import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { ownerRequests } from "../src/owner-requests.js";
import { grantRequest } from "../src/grants.js";
import { file } from "../src/invoices.js";
import { pay } from "../src/agent.js";
import { ASSETS } from "../src/policy.js";
import { getInvoice, invoiceId } from "../src/invoice-store.js";
import { createWorkOrder, workOrderInvoice, workOrderPolicy, type WorkOrder } from "../src/work-order-store.js";
import { freshDirectory } from "./fixtures/harness.js";
import { authorityFixture, fixtureGrant, fixtureOwner, policyView } from "./fixtures/authority.js";

freshDirectory("work-order-binding");
let order: WorkOrder;
let sends: string[];
beforeEach(() => {
  order = createWorkOrder("parent-agent", { id: "12345678-1234-4234-8234-123456789abc",
    payee: "alice.near", amount: "1000000", note: "Design work", until: new Date(Date.now() + 3_600_000).toISOString(),
    asset: ASSETS.USDC, owner: fixtureOwner });
  process.env.WORK_ORDER_PARENT = order.parentAgentId;
  process.env.WORK_ORDER_ID = order.id;
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  sends = [];
  Object.assign(api, { ...authorityFixture(), getPolicy: async () => policyView(workOrderPolicy(order)),
    listGrants: async () => [{ ...fixtureGrant("invoices"), expires_at: order.until }],
    forGrant: () => ({ transfer: async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
      sends.push(idempotencyKey); return { correlation_id: "order-payment" };
    } }), getStatus: async (correlation_id: string) => ({ correlation_id, status: "PENDING_APPROVAL", details: { approval_id: "approval" } }) });
});

test("owner creation signs the fixed work-order policy and grant expires at its deadline", async () => {
  assert.deepEqual(ownerRequests.agent_create(fixtureOwner, "payout", [order.payee]).policy, workOrderPolicy(order));
  assert.throws(() => ownerRequests.agent_create({ ...fixtureOwner, account_id: "other.near" }, "payout"), /owner/);
  assert.equal((await grantRequest({ label: "invoices" })).request.expires_at, order.until);
  await assert.rejects(grantRequest({ label: "treasury" }), /work order/i);
});

test("altered terms and fresh submission identities cannot become payments in an order executor", async () => {
  const invoice = workOrderInvoice(order, order.payee);
  for (const changed of [{ amount: "1" }, { note: "Different work" }, { submission: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, { payee: "bob.near" }])
    await assert.rejects(file({ ...invoice, ...changed }, changed.payee ?? order.payee), /work order/i);
  assert.equal(sends.length, 0);
});

test("concurrent filing uses one order payment and later status requests never send again", async () => {
  const invoice = workOrderInvoice(order, order.payee);
  const results = await Promise.all(Array.from({ length: 8 }, () => file(invoice, order.payee)));
  assert.ok(results.every(result => result.status === "waiting"));
  assert.equal(sends.length, 1);
  assert.equal(getInvoice(invoiceId(invoice))!.operation.policyDigest?.startsWith("sha256:"), true);
  await file(invoice, order.payee);
  assert.equal(sends.length, 1);
});

test("manual payments cannot bypass the order's single invoice identity", async () => {
  assert.deepEqual(await pay({ asset: order.asset, amount: order.amount, recipient: order.payee, confidential: true }),
    { outcome: "refused", code: "work_order_binding" });
  assert.equal(sends.length, 0);
});

test("a mismatched grant deadline is refused at dispatch even when the policy permits the payment", async () => {
  Object.assign(api, { listGrants: async () => [fixtureGrant("invoices")] });
  assert.equal((await file(workOrderInvoice(order, order.payee), order.payee)).status, "refused");
  assert.equal(sends.length, 0);
});

test("deadline crossing during dispatch observations refuses without a provider submission", async () => {
  const input = workOrderInvoice(order, order.payee);
  const tokens = api.getTokens.bind(api);
  Object.assign(api, { getTokens: async () => {
    const result = await tokens();
    mock.method(Date, "now", () => Date.parse(order.until));
    return result;
  } });
  try {
    assert.equal((await file(input, order.payee)).status, "refused");
    assert.equal(sends.length, 0);
  } finally { mock.restoreAll(); }
});

test("a policy changed between intake and dispatch cannot release an altered order payment", async () => {
  let reads = 0;
  Object.assign(api, { getPolicy: async () => policyView({ ...workOrderPolicy(order), owner_approval: ++reads === 1 }) });
  assert.equal((await file(workOrderInvoice(order, order.payee), order.payee)).status, "refused");
  assert.equal(sends.length, 0);
});

test("an interrupted order payment stays on its original unresolved identity", async () => {
  Object.assign(api, { forGrant: () => ({ transfer: async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
    sends.push(idempotencyKey); throw new Error("response lost");
  } }) });
  const input = workOrderInvoice(order, order.payee);
  assert.equal((await file(input, order.payee)).status, "unknown");
  assert.equal((await file(input, order.payee)).status, "unknown");
  assert.equal(sends.length, 1);
  assert.equal(getInvoice(invoiceId(input))!.operation.idempotencyKey, sends[0]);
});
