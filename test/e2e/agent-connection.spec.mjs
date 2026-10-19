import { test as base, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';
import { ownerAction, ownerRpc, programFetch, payeeApi } from './payables-steps.mjs';
import { payeeClient } from '../../src/contract/client.ts';

// The first permitted action set on the common agent-connection mechanism: a contractor connects their own agent
// for their compensation reports only. The agent runs outside a browser with the connection token; filing and every
// owner step stay with people. Provider, deposits and settlement are simulated; signatures come from the test wallet.
const test = base.extend({
  stack: async ({}, use, info) => {
    const stack = await environment(info.outputPath('environment'));
    try { await use(stack); }
    finally { await stack.close(); expect(stack.simulated.errors).toEqual([]); }
  },
  people: async ({ browser, stack }, use) => {
    const owner = await browserContext(browser, stack, OWNER), payee = await browserContext(browser, stack, PAYEE);
    try { await use({ owner: await owner.context.newPage(), payee: await payee.context.newPage() }); }
    finally { for (const { context, unexpected } of [owner, payee]) { await context.close(); expect(unexpected).toEqual([]); } }
  },
});

test('an agent connection reports for the contractor, recovers a lost reply by identity and follows the same request to paid', async ({ stack, people }) => {
  test.setTimeout(180_000);
  const rpc = await ownerRpc(people.owner, stack), contractor = await payeeApi(people.payee, stack);
  const agreementId = randomUUID(), requestId = randomUUID(), amount = '2000000';
  await rpc('compensation/agreement', { commandId: randomUUID(), id: agreementId, expectedVersion: 0, terms: { payee: PAYEE, title: 'Agent-reported work',
    document: 'https://example.test/agreement', signedOn: '2026-10-01', start: '2026-10-01', end: '2026-10-31', ceiling: '10000000', openingApproved: '0', scope: 'Local workflow' } });

  // 1. The signed-in contractor connects their agent: exactly the contractor-report permissions, shown once.
  const started = await contractor('POST', '/api/agent-connections', { label: 'Report agent', ttlSeconds: 3600 });
  expect(started.status).toBe(201);
  const { connection, token } = started.body;
  expect(connection).toMatchObject({ role: 'payee', account: PAYEE, permissions: ['compensation.read', 'compensation.submit'], revoked: false });
  const agent = payeeClient({ base: stack.invoices, token, fetch: programFetch });

  // 2. The agent submits a report and loses the reply. It reads the same request id and never sends again.
  let posts = 0;
  const losing = payeeClient({ base: stack.invoices, token, fetch: async (input, init) => {
    if (init.method === 'POST') posts++;
    await programFetch(input, init); throw new TypeError('reply lost');
  } });
  const command = { commandId: randomUUID(), id: requestId, expectedVersion: 0, submit: true,
    report: { agreementId, start: '2026-10-01', end: '2026-10-15', contributions: 'Hosted the meetup', assessment: 'Delivered as agreed', evidence: [] } };
  expect(await losing.submitReport(command)).toEqual({ ok: false, kind: 'unknown', identity: { commandId: command.commandId, id: requestId, expectedVersion: 0 } });
  const recovered = await agent.compensation();
  expect(recovered.ok).toBe(true);
  expect(recovered.value.requests.filter(r => r.id === requestId)).toHaveLength(1);
  expect(posts, 'one submission; recovery is a read').toBe(1);

  // 3. The owner reviews and authorizes through the existing Payables flow; the order is funded exactly.
  const version = async () => (await rpc('compensation/list')).requests.find(r => r.id === requestId).version;
  await rpc('compensation/review', { commandId: randomUUID(), id: requestId, expectedVersion: await version(), decision: 'approved', approvedAmount: amount, feedback: 'Approved' });
  await rpc('compensation/prepare', { type: 'prepare', command: { commandId: randomUUID(), id: requestId, expectedVersion: await version(), mode: 'isolated', until: new Date(Date.now() + 2 * 86_400_000).toISOString() } });
  await ownerAction(rpc, requestId, 'create');
  await ownerAction(rpc, requestId, 'grant');
  await rpc('workOrders/deposit', { id: requestId });
  stack.simulated.fund(stack.simulated.created().at(-1), BigInt(amount));

  // The connection reaches nothing else: not filing, not a browser session, not connection management.
  const asAgent = (method, path, body) => programFetch(`${stack.invoices}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const filedByAgent = await asAgent('POST', `/api/work-orders/${requestId}/file`, {});
  expect(filedByAgent.status, 'E2E_AGENT_ROUTE_RESTRICTED').toBe(403);
  expect(stack.simulated.transfers, 'E2E_AGENT_ROUTE_RESTRICTED').toHaveLength(0);
  for (const [method, path, body] of [['GET', '/api/session'], ['POST', '/api/signout', {}], ['GET', '/api/invoices'], ['GET', '/api/work-orders'], ['GET', '/api/agent-connections'], ['POST', '/api/agent-connections', { label: 'more' }]]) {
    const refused = await asAgent(method, path, body);
    expect(refused.status, `${method} ${path}`).toBe(403);
    expect(refused.headers.get('set-cookie'), `${method} ${path} opens no browser session`).toBeNull();
  }

  // 4. The human contractor files the order invoice in the app; the owner approves; settlement is observed.
  expect((await contractor('POST', `/api/work-orders/${requestId}/file`, {})).status).toBe(200);
  expect(stack.simulated.transfers).toHaveLength(1);
  await expect.poll(async () => (await rpc('workOrders/get', { id: requestId })).approval?.correlationId).toBe(stack.simulated.transfers[0].correlation);
  await ownerAction(rpc, requestId, 'approve');
  stack.simulated.settle(stack.simulated.transfers[0].correlation);

  // 5. The agent follows the same request to its recorded payment.
  await expect.poll(async () => { const view = await agent.compensation(); return view.ok && view.value.payments.find(p => p.requestId === requestId)?.status; }).toBe('paid');
  expect(stack.simulated.transfers).toHaveLength(1);

  // Attribution: each bearer call on the executor names the connection; the write names its command identity.
  const lines = readFileSync(join(stack.directory, 'executor/.agent-connections/access.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(lines.every(l => l.connectionId === connection.id && l.account === PAYEE)).toBe(true);
  expect(lines.filter(l => l.method === 'POST')).toEqual([expect.objectContaining({ path: '/api/compensation', commandId: command.commandId, id: requestId })]);

  // Revocation ends the agent's access at once; the contractor's own session is unaffected.
  expect((await contractor('DELETE', `/api/agent-connections/${connection.id}`)).status).toBe(200);
  expect(await agent.compensation()).toEqual({ ok: false, kind: 'session', status: 401, error: 'Invalid, expired or revoked agent connection.' });
  expect((await contractor('GET', '/api/compensation')).status).toBe(200);
});
