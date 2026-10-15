const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');
const { assertResponsive } = require('./fixtures/layout.cjs');
const { html, script } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  'import { invoicePage, invoiceBrowser } from "./src/invoice-page.ts"; console.log(JSON.stringify({html:invoicePage("Work order fixture"),script:invoiceBrowser}));'], { encoding: 'utf8' }));
const id = '12345678-1234-4234-8234-123456789abc';
const order = { version: 1, id, parentAgentId: 'parent', payee: 'payee.near', amount: '1250000', note: 'Synthetic design work',
  until: '2030-01-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', asset: 'usdc',
  owner: { type: 'near', account_id: 'owner.near', public_key: 'fixture' } };

async function ownerWorkOrder(browser, root) {
  const { setup, overview, budget } = workspaceEvidence({});
  let records = [];
  const open = workspaceOpener(root, { budget, values(kind) { return {
    instance: { agentId: 'fixture', executor: false }, setup: { ...setup, dao: { id: 'fixture.sputnik-dao.near', owner: setup.owner } }, overview: overview(kind),
    'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], invoices: [], activity: [],
    'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true }, 'autopilot/get': { on: false },
    'workOrders/list': records,
    'workOrders/get': { order: records[0], agentId: null, wallet: null, balance: null, policyReady: false,
      grant: null, invoice: null, ownerActions: [], approval: null, error: null },
  }; } });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const { page, calls, errors } = await open(context, '/a/payables/payees', { dao: true });
  let writes = 0;
  await page.route('**/rpc/workOrders/create', route => {
    writes++;
    const input = route.request().postDataJSON().json;
    assert.match(input.id, /^[0-9a-f-]{36}$/);
    assert.equal(input.amount, '1250000');
    assert.equal(input.payee, 'payee.near');
    records = [{ ...order, ...input }];
    return route.fulfill({ json: { json: records[0] } });
  });
  await page.getByText('Create a work order', { exact: true }).click();
  await page.getByRole('button', { name: 'Save work order', exact: true }).click();
  assert.equal(writes, 0);
  await page.getByLabel('Work order payee', { exact: true }).fill('payee.near');
  await page.getByLabel('Fixed amount (USDC)').fill('1.25');
  await page.getByLabel('Agreed work').fill('Synthetic design work');
  await page.getByRole('button', { name: 'Save work order', exact: true }).click();
  await page.getByText('Needs owner authorization', { exact: true }).waitFor();
  assert.equal(writes, 1);
  await page.getByRole('button', { name: 'Authorize work order', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /1.25 USDC to payee.near/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(!calls.includes('workOrders/prepare'));
  assert.ok((await page.getByRole('link', { name: 'Open work order on the invoice page' }).getAttribute('href')).includes(records[0].id));
  await assertResponsive(page, 'work-order-owner');
  await page.screenshot({ path: '/tmp/work-order-owner.png', fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
}

async function payeeWorkOrder(browser) {
  {
    const width = 390; // File once; resize each retained state for layout coverage.
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    let status = null, expiredSession = false, unavailable = false;
    const writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body: 'export class NearConnector {}' });
      if (url.hostname !== 'invoice.test') return route.abort();
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/invoice-browser.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path === '/api/session') return route.fulfill({ json: { account: 'payee.near', agreed: true } });
      if (path === '/api/invoices') return route.fulfill({ json: { invoices: [], agreements: [], agreed: true } });
      if (path.startsWith('/api/work-orders') && expiredSession) return route.fulfill({ status: 401, json: { error: 'Expired' } });
      if (path === '/api/work-orders') return route.fulfill({ json: { orders: [order] } });
      if (path.endsWith('/file')) {
        writes.push(route.request().postDataJSON()); status = 'waiting';
        return route.fulfill({ json: { id: 'same-invoice', status } });
      }
      if (path === '/api/work-orders/' + id) return route.fulfill(unavailable ? { status: 503, json: { error: 'Read unavailable' } } : { json: {
        id, amount: order.amount, note: order.note, until: order.until, createdAt: order.createdAt,
        ready: status === null, unavailable: false, invoice: status ? { id: 'same-invoice', status, amount: order.amount, note: order.note, filedAt: order.createdAt } : null,
      } });
      throw new Error('Unexpected invoice fixture request: ' + path);
    });
    await page.goto('https://invoice.test/?workOrder=' + id);
    await page.getByText('Ready to file.', { exact: false }).waitFor();
    await assertResponsive(page, 'work-order-ready');
    await page.getByRole('button', { name: 'File work order invoice', exact: true }).click();
    await page.locator('#work-order-status').filter({ hasText: 'Waiting for approval' }).waitFor();
    assert.deepEqual(writes, [{}]);
    await assertResponsive(page, 'work-order-held');
    assert.ok(await page.getByRole('button', { name: 'File work order invoice', exact: true }).isDisabled());
    await page.reload();
    await page.locator('#work-order-status').filter({ hasText: 'Waiting for approval' }).waitFor();
    assert.equal(writes.length, 1);
    status = 'paid'; await page.getByRole('button', { name: 'Check work orders', exact: true }).click();
    await page.locator('#work-order-status').filter({ hasText: 'Paid.' }).waitFor();
    await assertResponsive(page, 'work-order-paid');
    unavailable = true; await page.getByRole('button', { name: 'Check work orders', exact: true }).click();
    await page.getByText('Read unavailable', { exact: true }).waitFor();
    assert.ok(await page.locator('#work-order-file').isDisabled());
    await assertResponsive(page, 'work-order-invoice');
    await page.screenshot({ path: `/tmp/work-order-invoice-${width}.png`, fullPage: true });
    expiredSession = true; await page.getByRole('button', { name: 'Check work orders', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with NEAR', exact: true }).waitFor();
    assert.equal(await page.locator('#work-order-note').textContent(), '');
    assert.equal(await page.locator('#work-orders-list').textContent(), '');
    await assertResponsive(page, 'work-order-expired-session');
    assert.equal(writes.length, 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
}

runTask([ownerWorkOrder, payeeWorkOrder]);
