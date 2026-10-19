/** Offline live-demo regressions. All browser traffic is intercepted; no executor or wallet starts. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { rpcValue } = require('./fixtures/rpc.cjs');
const { expect } = require('@playwright/test');
const root = path.resolve(process.argv[2] || 'web/dist');
const digest = 'sha256:' + 'a'.repeat(64);
const paymentId = 'demo-payment-fixture';
const usdc = { asset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6 };
const payment = { recipient: 'payee.near', asset: usdc.asset, amount: '1000000', confidential: true };
const grantLabel = (kind, state) => state.wrongPurpose ? 'approval' : kind === 'treasury' ? 'treasury' : 'payout';
const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(period => [period,
  { limit_usd: '100', remaining_usd: '90', spent_usd: '10' },
]));

function overview(kind, state) {
  return { agentId: kind, area: kind, digest, notInForce: state.notInForce ? 'Policy is not in force.' : null,
    agreed: state.noPayees ? [] : ['payee.near'], unmanaged: [],
    grants: state.unverifiedGrant ? [] : [{ grant_id: 'grant-fixture', label: grantLabel(kind, state),
      expires_at: state.expired ? '2020-01-01T00:00:00Z' : '2030-01-01T00:00:00Z', revoked_at: state.revoked ? '2026-10-01T00:00:00Z' : null }],
    rebalance: { minLegUsd: 1, maxCostBps: 100 }, target: { [usdc.asset]: 1 },
    book: [{ ...usdc, public: '0', confidential: state.empty ? '0' : '10000000', usd: state.empty ? 0 : 10, price: 1 }],
    policy: { status: 'APPLIED', revision: 1, policy: { actions: kind === 'treasury' ? ['swap', 'transfer'] : ['transfer'],
      frozen: false, owner_approval: true, destinations: { mode: 'only', list: [{ action: 'transfer', address: 'payee.near', confidential: true }] },
      assets: 'any', budget: {}, limits: {} }, usage: { budget }, cooldowns: {} },
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    async function open(routePath, options = {}) {
      const context = await browser.newContext({ viewport: { width: options.width || 390, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      if (options.clock) await page.clock.install();
      const calls = [], writes = [], errors = [], requests = [];
      const state = { ...options, submitted: false, settled: false };
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'frontend.test') return route.abort();
        const pathname = url.pathname;
        requests.push(pathname);
        if (pathname === '/gw/me') return route.fulfill({ json: {
          walkthroughs: state.guided, selfService: state.guided,
          agents: ['treasury', 'payables'].map(name => ({ name, area: name, owner: 'owner.near', dao: false })),
          invoices: 'https://invoices.example', viewer: state.public ? null : { account: 'owner.near',
            access: Object.fromEntries(['treasury', 'payables'].map(name => [name, { canSign: !state.member, canPropose: !state.member, canVote: !state.member, canExecute: !state.member, canManage: !state.member }])) },
        } });
        if (pathname.includes('/rpc/')) {
          const method = pathname.split('/rpc/')[1];
          const kind = pathname.includes('/payables/') ? 'payables' : 'treasury';
          calls.push(method);
          if (method === 'workOrders/list') return route.fulfill({ json: { json: [] } });
          if (method === state.error) return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture observation unavailable' } } });
          const setup = { agentId: kind, wallet: kind + '.near', owner: { type: 'near', account_id: 'owner.near' }, executor: !state.approveOnly,
            grant: state.noGrant ? null : { id: 'grant-fixture', label: grantLabel(kind, state), expiresAt: state.expired ? '2020-01-01T00:00:00Z' : '2030-01-01T00:00:00Z' }, dao: null };
          const knownPayment = { correlationId: paymentId, approvalId: 'approval-fixture', at: '2026-10-14T12:00:00Z', request: payment };
          const values = { setup, instance: { agentId: kind, executor: !state.approveOnly }, overview: overview(kind, state),
            'treasury/get': null, unresolved: state.unresolved ? [{ key: 'unresolved-fixture', at: '2026-10-14T12:00:00Z', status: 'PROCESSING' }] : [],
            held: (state.held || state.submitted) && !state.settled ? [knownPayment] : [],
            'inbox/list': [], 'workOrders/list': [], 'agreements/list': [], activity: [],
            invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [],
            paymentHistory: { items: state.held || state.submitted ? [knownPayment] : [], complete: true },
            paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: payment, approvalId: 'approval-fixture', expiresAt: '2030-01-01T00:00:00Z' },
            'strategy/get': null, 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10 }, 'autopilot/evidence': { ticks: [] },
          };
          if (method === 'paymentStatus') assert.equal(route.request().postDataJSON().json.correlationId, paymentId, 'follow the selected operation');
          if (method === 'pay') {
            assert.ok(state.allowPay, 'only the explicit payment scenario may submit');
            writes.push({ method, input: route.request().postDataJSON().json });
            if (state.payRefused) return route.fulfill({ json: { json: { outcome: 'refused', code: 'insufficient_balance' } } });
            state.submitted = true;
            return route.fulfill({ json: { json: { outcome: 'sent', correlationId: paymentId, status: 'PENDING_APPROVAL' } } });
          }
          return route.fulfill({ json: { json: rpcValue(values, method) } });
        }
        if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname,
          contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
      });
      await page.goto('http://frontend.test' + routePath);
      return { page, context, calls, writes, errors, requests, state };
    }

    const DEMO = '/a/payables/demos/payables';
    const PAYABLES = 'https://payables.multiagency.ai/a/payables';

    for (const kind of ['treasury', 'payables']) {
      const app = kind === 'treasury' ? 'Treasury' : 'Payables';
      const { page, context, writes, errors } = await open(`/a/${kind}/`, { guided: true });
      await page.getByRole('heading', { name: `${app} agent`, exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: `Open ${app}`, exact: true }).first().getAttribute('href'), `https://${kind}.multiagency.ai/a/${kind}/`);
      const guides = kind === 'treasury' ? ['treasury'] : ['payables', 'invoices'];
      for (const id of guides) {
        assert.equal(await page.locator(`a[href="/a/${kind}/demos/${id}"]`).count(), 1);
        assert.equal(await page.locator(`a[href="/a/${kind}/walkthrough/${id}"]`).count(), 1);
      }
      assert.equal(await page.locator('a[href="/a/payables/demos/payables/play"]').count(), kind === 'payables' ? 1 : 0);
      assert.equal(await page.getByRole('heading', { name: 'Run with real funds', exact: true }).count(), 0, 'the agent page embeds no money action');
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS agent page: links to the agent\'s app, its guides and the rehearsal; no money action embedded');
    for (const workflow of ['treasury', 'payables', 'invoices']) for (const version of ['demos', 'walkthrough']) {
      const agent = workflow === 'treasury' ? 'treasury' : 'payables';
      const { page, context, writes, errors } = await open(`/a/${agent}/${version}/${workflow}`, { guided: true });
      await page.getByRole('navigation', { name: 'Walkthrough versions' }).waitFor();
      assert.equal(await page.getByRole('complementary', { name: 'Walkthrough guidance' }).count(), version === 'demos' ? 1 : 0);
      if (workflow === 'invoices') await page.getByRole('heading', { name: 'Purchase-order walkthrough', exact: true }).waitFor();
      else if (workflow === 'treasury') await page.getByRole('link', { name: 'Open the guided run in Treasury', exact: true }).waitFor();
      else await page.getByRole('heading', { name: 'Run with real funds', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('navigation', { name: 'Walkthrough versions' }).waitFor();
      assert.deepEqual(writes, [], 'guide entry and reload never submit');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS all three short and complete guides open without submitting; Treasury and order steps link to their apps');

    for (const width of [320, 1280]) {
      const { page, context, writes, errors } = await open('/', { width });
      await page.getByRole('heading', { name: 'Your agents', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Open in Payables for payables', exact: true }).getAttribute('href'), `${PAYABLES}/`);
      assert.equal(await page.getByRole('link', { name: 'Open in Treasury for treasury', exact: true }).getAttribute('href'), 'https://treasury.multiagency.ai/a/treasury/');
      await page.getByRole('link', { name: 'Walkthroughs for payables', exact: true }).click();
      await page.getByRole('heading', { name: 'Payables agent', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(writes, [], 'the launcher and agent page never preview, send or approve');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: launcher opens each agent's app and its walkthroughs without mutation`);
    }

    {
      const { page, context, writes, errors, state } = await open(DEMO, { allowPay: true });
      const reviewButton = page.getByRole('button', { name: 'Review payment', exact: true });
      await expect(reviewButton).toBeEnabled();
      await page.getByRole('heading', { name: 'Request a real payment', exact: true }).waitFor();
      if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: '/tmp/live-demo-payables-390.png', fullPage: true });
      assert.deepEqual(writes, []);
      await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill(payment.recipient);
      await page.getByLabel('Amount', { exact: true }).fill('1');
      await reviewButton.click();
      const review = page.getByRole('dialog', { name: 'Review payment', exact: true });
      await expect(review).toContainText('1 USDC');
      await expect(review).toContainText(payment.recipient);
      await expect(review).toContainText('Required by the reviewed policy.');
      await review.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.deepEqual(writes, [], 'review and cancellation must not send');
      assert.equal(await page.getByRole('heading', { name: 'Your payment', exact: true }).count(), 0);
      await reviewButton.click();
      await review.getByRole('button', { name: 'Send payment', exact: true }).click();
      const follow = page.getByRole('link', { name: 'Follow this payment in Payables', exact: true });
      await follow.waitFor();
      await page.getByRole('heading', { name: 'Your payment', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Open this payment in Payables', exact: true }).getAttribute('href'), `${PAYABLES}/follow/payment?payment=${paymentId}`);
      assert.ok(page.url().endsWith('/demos/payables'), 'the returned payment is followed inline');
      await expect(page.getByRole('complementary', { name: 'Walkthrough guidance' })).toContainText(`Selected payment: ${paymentId}`);
      assert.deepEqual(writes, [{ method: 'pay', input: { ...payment, expectedPolicy: { revision: 1, digest } } }]);
      assert.equal(await follow.getAttribute('href'), `${PAYABLES}/follow/payment?payment=${paymentId}`);
      assert.equal(await page.getByText('Paid', { exact: true }).count(), 0, 'held does not establish payment completion');
      state.settled = true;
      await page.getByText('Paid', { exact: true }).first().waitFor({ timeout: 20_000 });
      assert.equal(writes.length, 1, 'completion follows the same payment without resubmission');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS payables: reviewed amount and recipient, no send on cancellation, explicit submit, durable identity and settlement');
    }

    {
      const { page, context, writes, errors, state } = await open(DEMO, { allowPay: true, held: true });
      await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill(payment.recipient);
      await page.getByLabel('Amount', { exact: true }).fill('1');
      await page.getByRole('button', { name: 'Review payment', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
      await page.getByRole('heading', { name: 'Your payment', exact: true }).waitFor();
      state.payRefused = true;
      await page.getByRole('button', { name: 'Review payment', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
      await page.getByText(/^Refused ·/).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Review funding in Payables', exact: true }).getAttribute('href'), `${PAYABLES}/funding`);
      await page.getByText(/No payment selected in this walkthrough/).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Your payment', exact: true }).count(), 0, 'a refusal cannot select a previous held payout');
      assert.equal(writes.length, 2);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS payment refusal links to Payables and does not manufacture an outcome selection');

    for (const [name, options, message] of [
      ['member', { member: true }, 'Your access: Review only'],
      ['approve-only', { approveOnly: true }, 'This instance: Approve-only'],
      ['missing grant', { noGrant: true }, 'Send grant: Review needed'],
      ['expired grant', { expired: true }, 'Send grant: Expired'],
      ['revoked grant', { revoked: true }, 'Send grant: Review needed'],
      ['unverified grant', { unverifiedGrant: true }, 'Send grant: Review needed'],
      ['wrong purpose', { wrongPurpose: true }, 'Send grant: Review needed'],
      ['policy unavailable', { notInForce: true }, 'Policy: Review needed'],
      ['unfunded', { empty: true }, 'Funds: Funding needed'],
      ['unresolved', { unresolved: true }, 'Unresolved operations: 1 unresolved'],
      ['read failure', { error: 'unresolved' }, 'Observations: Unavailable'],
    ]) {
      const { page, context, writes, errors } = await open(DEMO, options);
      await page.getByRole('heading', { name: 'Request a real payment', exact: true }).waitFor();
      await page.getByText(message, { exact: true }).waitFor();
      const send = page.getByRole('button', { name: 'Review payment', exact: true });
      if (options.approveOnly) assert.equal(await send.count(), 0, 'an approve-only instance offers no send');
      else await expect(send).toBeDisabled();
      assert.equal(await page.getByRole('link', { name: 'Review all operations and recovery in Payables', exact: true }).getAttribute('href'), `${PAYABLES}/activity`);
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${name}: blocks new payments and links to recovery in Payables`);
    }

    {
      const { page, context, calls, writes, errors } = await open(DEMO, { approveOnly: true, noGrant: true, held: true });
      await page.getByRole('heading', { name: 'Find your payment', exact: true }).waitFor();
      const invoice = page.getByRole('link', { name: 'Open separate invoice demo', exact: true });
      assert.equal(await invoice.getAttribute('href'), 'https://invoices.example');
      assert.equal(await page.getByRole('button', { name: 'Review payment', exact: true }).count(), 0);
      const queue = page.getByRole('list', { name: 'Payment records' });
      await queue.getByRole('link').first().waitFor();
      assert.ok(!calls.includes('paymentStatus'), 'queue must not poll or approve each payment');
      assert.equal(await queue.getByRole('link').filter({ hasText: paymentId }).getAttribute('href'), `${PAYABLES}/follow/payment?payment=${paymentId}`);
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS approve-only payables: configured invoice path; retained held payouts open in Payables without a send grant');
    }

    {
      const { page, context, writes, errors, state } = await open(DEMO);
      const action = page.getByRole('button', { name: 'Review payment', exact: true });
      await expect(action).toBeEnabled();
      state.error = 'overview';
      await page.getByRole('button', { name: 'Check observations', exact: true }).click();
      await page.getByText('Observations: Unavailable', { exact: true }).waitFor();
      await expect(action).toBeDisabled();
      assert.equal(await page.getByText('Real funds on mainnet', { exact: true }).count(), 1, 'retained demo stays present while fresh observations fail');
      state.error = undefined;
      await page.getByRole('button', { name: 'Check observations', exact: true }).click();
      await expect(action).toBeEnabled();
      assert.deepEqual(writes, [], 'refresh only reads observations');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS failed refresh: retained observations never authorize a new payment, successful refresh restores readiness');

    {
      const { page, context, writes, errors, state } = await open(DEMO, { clock: true });
      const reviewButton = page.getByRole('button', { name: 'Review payment', exact: true });
      await expect(reviewButton).toBeEnabled();
      await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill(payment.recipient);
      await page.getByLabel('Amount', { exact: true }).fill('1');
      await reviewButton.click();
      const review = page.getByRole('dialog', { name: 'Review payment', exact: true });
      const confirm = review.getByRole('button', { name: 'Send payment', exact: true });
      await expect(confirm).toBeEnabled();
      state.unresolved = true;
      await page.clock.fastForward(5_100);
      await page.clock.runFor(100);
      await expect(confirm).toBeDisabled();
      assert.deepEqual(writes, [], 'new unresolved evidence invalidates an already open review');
      await review.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS changed observations invalidate an open payment confirmation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
