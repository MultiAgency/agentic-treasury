import { test as base, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';
import { ownerAction, ownerRpc, payeeApi } from './payables-steps.mjs';
import { recordConformance } from './conformance.mjs';

// Owner steps go through the real gateway RPC with a locally signed NEP-413 payload (simulated signature);
// payee steps go through the payee API with a wallet-signed session. Settlement is simulated.
const test = base.extend({
  stack: async ({}, use, info) => {
    const stack = await environment(info.outputPath('environment'));
    try { await use(stack); }
    finally { await stack.close(); expect(stack.simulated.errors).toEqual([]); }
  },
  people: async ({ browser, stack }, use, info) => {
    const owner = await browserContext(browser, stack, OWNER), payee = await browserContext(browser, stack, PAYEE);
    const ownerPage = await owner.context.newPage(), conformance = recordConformance(ownerPage);
    await conformance.ready;
    try {
      await use({ owner: ownerPage, payee: await payee.context.newPage() });
      // Every owner answer received in these flows conforms to the published contract.
      await conformance.settle();
      writeFileSync(info.outputPath('conformance.json'), JSON.stringify(conformance.results, null, 2));
      writeFileSync(info.outputPath('conformance-aborted.json'), JSON.stringify(conformance.aborted, null, 2));
      expect(conformance.results.filter(r => !r.ok)).toEqual([]);
    }
    finally {
      for (const [i, { context, unexpected }] of [owner, payee].entries()) {
        for (const [n, page] of context.pages().entries()) writeFileSync(info.outputPath(`${i}-${n}.txt`), await page.locator('body').innerText().catch(() => 'Page unavailable'));
        await context.close(); expect(unexpected).toEqual([]);
      }
    }
  },
});

/** Authorize and exactly fund an existing order. Under-funding refuses filing without any transfer. */
async function authorizeAndFund(stack, rpc, payee, id, amount) {
  await ownerAction(rpc, id, 'create');
  const created = (await rpc('workOrders/get', { id })).agentId;
  expect(created).toBe(stack.simulated.created().at(-1));
  await ownerAction(rpc, id, 'grant');
  const ready = await rpc('workOrders/get', { id });
  expect(ready).toMatchObject({ policyReady: true, balance: '0', error: null });
  expect(ready.grant.expiresAt).toBe(new Date(ready.order.until).toISOString());
  const deposit = await rpc('workOrders/deposit', { id });
  expect(deposit.address).toBe(ready.wallet);
  stack.simulated.fund(created, BigInt(amount) - 1n);
  const short = await payee('POST', `/api/work-orders/${id}/file`, {});
  expect(short).toMatchObject({ status: 409, body: { code: 'work_order_not_ready' } });
  expect((await payee('GET', `/api/work-orders/${id}`)).body).toMatchObject({ ready: false, invoice: null });
  expect(stack.simulated.transfers).toHaveLength(0);
  stack.simulated.fund(created, 1n);
  return created;
}

/** Payee files once; the held payout needs the owner's separate approval; settlement is observed, not assumed. */
async function fileApproveSettle(stack, rpc, payee, id, created, amount) {
  const filed = await payee('POST', `/api/work-orders/${id}/file`, {});
  expect(filed.status).toBe(200);
  expect(stack.simulated.transfers).toHaveLength(1);
  const [transfer] = stack.simulated.transfers;
  expect(transfer).toMatchObject({ agent: created, status: 'PENDING_APPROVAL', body: { recipient: PAYEE, amount } });
  await expect.poll(async () => (await rpc('workOrders/get', { id })).approval?.correlationId).toBe(transfer.correlation);
  const vote = await ownerAction(rpc, id, 'approve');
  expect(transfer.status).toBe('PROCESSING');
  expect((await payee('GET', `/api/work-orders/${id}`)).body.invoice.status).not.toBe('paid');
  stack.simulated.settle(transfer.correlation);
  await expect.poll(async () => (await payee('GET', `/api/work-orders/${id}`)).body.invoice?.status).toBe('paid');
  await expect.poll(async () => (await rpc('workOrders/status', { id, correlationId: vote })).status).toBe('SUCCESS');
  const again = await payee('POST', `/api/work-orders/${id}/file`, {});
  expect(again.body.status ?? again.body.invoice?.status).toBe('paid');
  expect(stack.simulated.transfers).toHaveLength(1);
  expect(stack.simulated.requests.filter(r => r.path === `/v1/agents/${stack.simulated.id}/transfer`)).toHaveLength(0);
}

test('purchase order: fixed terms, owner authorization, exact funding, contributor filing, payout approval and settlement', async ({ stack, people }) => {
  const rpc = await ownerRpc(people.owner, stack), payee = await payeeApi(people.payee, stack);
  const id = globalThis.crypto.randomUUID(), amount = '3000000';
  await rpc('workOrders/create', { id, payee: PAYEE, amount, note: 'Purchase order: catering', until: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  const early = await payee('POST', `/api/work-orders/${id}/file`, {});
  expect(early.status).toBeGreaterThanOrEqual(400);
  const created = await authorizeAndFund(stack, rpc, payee, id, amount);
  await fileApproveSettle(stack, rpc, payee, id, created, amount);
});

test('contribution report: approval, isolated preparation, exact funding, filing, payout approval and settlement', async ({ stack, people }) => {
  const rpc = await ownerRpc(people.owner, stack), payee = await payeeApi(people.payee, stack);
  const uuid = () => globalThis.crypto.randomUUID(), agreementId = uuid(), amount = '2000000';
  await rpc('compensation/agreement', { commandId: uuid(), id: agreementId, expectedVersion: 0, terms: { payee: PAYEE, title: 'Community sponsorship',
    document: 'https://example.test/agreement', signedOn: '2026-10-01', start: '2026-10-01', end: '2026-10-31', ceiling: '10000000', openingApproved: '0', scope: 'Local workflow' } });
  const view = (await payee('GET', '/api/compensation')).body;
  expect(view.agreements.map(a => a.id)).toEqual([agreementId]);
  const requestId = uuid();
  const report = { agreementId, start: '2026-10-01', end: '2026-10-15', contributions: 'Hosted the meetup', assessment: 'Delivered as agreed', evidence: [] };
  const submitted = await payee('POST', '/api/compensation', { commandId: uuid(), id: requestId, expectedVersion: 0, report, submit: true });
  expect(submitted.status).toBe(200);
  let request = (await rpc('compensation/list')).requests.find(r => r.id === requestId);
  await rpc('compensation/review', { commandId: uuid(), id: requestId, expectedVersion: request.version, decision: 'approved', approvedAmount: amount, feedback: 'Approved' });
  request = (await rpc('compensation/list')).requests.find(r => r.id === requestId);
  expect(stack.simulated.transfers).toHaveLength(0);
  await rpc('compensation/prepare', { type: 'prepare', command: { commandId: uuid(), id: requestId, expectedVersion: request.version, mode: 'isolated', until: new Date(Date.now() + 2 * 86_400_000).toISOString() } });
  const [order] = await rpc('workOrders/list');
  expect(order).toMatchObject({ id: requestId, payee: PAYEE, amount });
  const created = await authorizeAndFund(stack, rpc, payee, requestId, amount);
  await fileApproveSettle(stack, rpc, payee, requestId, created, amount);
});

test('purchase order: owner rejects the held payout; nothing settles and filing again sends nothing new', async ({ stack, people }) => {
  const rpc = await ownerRpc(people.owner, stack), payee = await payeeApi(people.payee, stack);
  const id = globalThis.crypto.randomUUID(), amount = '3000000';
  await rpc('workOrders/create', { id, payee: PAYEE, amount, note: 'Purchase order: rejected', until: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  await authorizeAndFund(stack, rpc, payee, id, amount);
  expect((await payee('POST', `/api/work-orders/${id}/file`, {})).status).toBe(200);
  const [transfer] = stack.simulated.transfers;
  await expect.poll(async () => (await rpc('workOrders/get', { id })).approval?.correlationId).toBe(transfer.correlation);
  const vote = await ownerAction(rpc, id, 'reject');
  await expect.poll(async () => (await rpc('workOrders/status', { id, correlationId: vote })).status).toBe('FAILED');
  expect(transfer.status).toBe('FAILED');
  await expect.poll(async () => (await payee('GET', `/api/work-orders/${id}`)).body.invoice?.status).toBe('failed');
  await payee('POST', `/api/work-orders/${id}/file`, {});
  expect(stack.simulated.transfers).toHaveLength(1);
  expect(() => stack.simulated.settle(transfer.correlation)).toThrow('Not approved');
});
