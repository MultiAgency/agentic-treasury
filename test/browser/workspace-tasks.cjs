const { rpcValue } = require('./fixtures/rpc.cjs');
const { openWorkspaceNavigation } = require("./fixtures/navigation.cjs");
/**
 * Offline product-navigation regressions. Build first with pnpm build:web.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome \
 *   node test/browser/product-navigation.cjs [build-directory]
 * All requests are intercepted. No server, wallet, or executor is started.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
const { makeTick, recordingFor } = require('./fixtures/run.cjs');
const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(period => [period,
  { limit_usd: '100', remaining_usd: '90', spent_usd: '10' },
]));
const setup = { agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' },
  grant: { label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null };
const overview = kind => ({ agentId: 'fixture', digest: 'fixture', notInForce: null, agreed: [], unmanaged: [],
  rebalance: { minLegUsd: 1, maxCostBps: 100 }, target: { usdc: 1 },
  book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: '0', confidential: '10000000', usd: 10, price: 1 }],
  policy: { policy: { actions: kind === 'treasury' ? ['swap', 'transfer'] : ['transfer'], frozen: false,
    destinations: { mode: 'only', list: [] }, assets: 'any', budget: {}, limits: {} }, revision: 1, usage: { budget }, cooldowns: {} },
});


(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
  async function open(context, routePath, options = {}) {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const calls = [];
    const requests = [];
    const errors = [];
    const state = { error: options.error, delay: options.delay };
    const run = makeTick(options.outcome || 'quiet', budget);
    if (options.oldRun) {
      run.at = '2020-01-01T00:00:00Z';
      run.end.endedAt = run.at;
      run.end.before.at = run.at;
      run.end.after.at = run.at;
    }
    let gatewayReads = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'frontend.test') return route.abort();
      const pathname = url.pathname;
      if (pathname === '/gw/me') {
        if (++gatewayReads > 1 && options.invoiceLinkError) return route.fulfill({ status: 503, json: { error: 'Invoice link unavailable' } });
        return route.fulfill({ json: {
        agents: (options.onlyPayables ? ['payables'] : ['treasury', 'payables']).map(name => ({ name, owner: 'owner.near', dao: false })),
        invoices: options.noInvoiceLink ? null : 'https://invoices.example', viewer: options.public ? null : { account: 'owner.near',
          access: Object.fromEntries((options.onlyPayables ? ['payables'] : ['treasury', 'payables']).map(name => [name, { role: options.member && name === 'payables' ? 'member' : 'operator', canPropose: true, canVote: true }])) },
      } });
      }
      if (pathname.includes('/rpc/')) {
        const method = pathname.split('/rpc/')[1];
        calls.push(method);
        requests.push(pathname);
        if (method === state.delay && (!options.onlyTreasury || pathname.includes('/treasury/'))) await new Promise(resolve => setTimeout(resolve, 2500));
        if (page.isClosed()) return;
        if (method === state.error && (!options.onlyTreasury || pathname.includes('/treasury/'))) {
          return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture read unavailable' } } });
        }
        const kind = pathname.includes('/payables/') ? 'payables' : 'treasury';
        const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' && !state.settled ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, approvalId: 'approval-' + correlationId, at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true } })) : [], unresolved: options.unresolved && kind === 'payables' ? [{ at: new Date().toISOString(), key: 'fixture-unresolved' }] : [],
          'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: options.held ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, at: '2026-10-14T00:00:00Z' })) : [], complete: true }, paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true }, approvalId: 'approval-one', expiresAt: '2030-01-01T00:00:00Z' },
          'strategy/get': { strategy: { targetBps: { usdc: 10000 }, minLegUsd: 1, maxCostBps: 100, autopilot: { everyMin: 60, maxUsd: 10 } }, digest: 'fixture', on: false, executor: true, grantMatches: false, readiness: { state: 'authorization-required', canEnable: false, reasons: ['Owner authorization required.'] } },
          'autopilot/get': { on: true, everyMin: 60, maxUsd: 10 },
          'autopilot/evidence': { ticks: [run] } };
        if (options.unmanaged) {
          values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: '1000000', decimals: 6, usd: null }];
          values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
        }
        if (method === 'autopilot/log') {
          assert.equal(route.request().postDataJSON().json.tickId, run.id, 'recording read must select the displayed run');
          assert.ok(!options.approveOnly, 'approve-only views must not read recordings');
          return route.fulfill({ json: { json: recordingFor(run) } });
        }
        if (options.oldRun && method === 'autopilot/evidence') {
          const input = route.request().postData() || url.search;
          values[method] = { ticks: input.includes('since') ? [] : [run], corrupt: [] };
        }
        assert.ok(method in values, `Unexpected RPC: ${method}`);
        return route.fulfill({ json: { json: rpcValue(values, method) } });
      }
      if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname,
        contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
    });
    await page.goto('http://frontend.test' + routePath);
    return { page, calls, errors, state, requests };
  }
    for (const width of [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const { page, calls, errors } = await open(context, '/a/payables/', { held: true });
      await page.getByRole('heading', { name: 'Payables · Payments', exact: true }).waitFor();
      await page.getByText('Send a payment by hand', { exact: true }).waitFor();
      assert.ok(!calls.includes('paymentStatus'), 'payment list never mounts per-row polls');
      if (width < 1024) {
        const menu = page.getByRole('button', { name: 'Menu', exact: true });
        await menu.click();
        const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
        await drawer.waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await menu.evaluate(el => el === document.activeElement), true, 'Escape returns focus to Menu');
        assert.equal(await drawer.isVisible(), false);
      }
      await openWorkspaceNavigation(page);
      await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Agreements', exact: true }).click();
      await page.getByRole('heading', { name: 'Payables · Agreements', exact: true }).waitFor();
      assert.equal(await page.getByText('Send a payment by hand', { exact: true }).count(), 0, 'agreements no longer mounts payment creation');
      await page.getByRole('link', { name: 'Create a payment in Payments', exact: true }).click();
      await page.locator('#manual-payment').waitFor();
      assert.equal(new URL(page.url()).hash, '#manual-payment');
      await page.getByText('Send a payment by hand', { exact: true }).click();
      await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill('payee.near');
      page.once('dialog', dialog => dialog.dismiss());
      await openWorkspaceNavigation(page);
      await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Agreements', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, '/a/payables/', 'cancelled draft navigation stays on Payments');
      page.once('dialog', dialog => dialog.accept());
      await openWorkspaceNavigation(page);
      await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Activity', exact: true }).click();
      await page.getByRole('link', { name: 'Review invoices in Payments', exact: true }).click();
      await page.locator('#invoices').waitFor();
      assert.equal(new URL(page.url()).hash, '#invoices');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover|pay)$/.test(call)));
      await page.screenshot({ path: `/tmp/workspace-tasks-${width}.png`, fullPage: true });
      await context.close();
      console.log(`PASS ${width}px: drawer focus, task placement, retained anchors, draft protection and no writes`);
    }
    {
      const context = await browser.newContext();
      const { page, calls, errors } = await open(context, '/a/treasury/automations');
      await page.getByRole('heading', { name: 'Manual actions', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Sweep', exact: true }).count(), 0);
      await page.getByRole('link', { name: 'Preview a sweep', exact: true }).click();
      await page.getByRole('heading', { name: 'Sweep', exact: true }).waitFor();
      assert.match(page.url(), /funding#sweep$/);
      await page.goBack();
      await page.getByRole('heading', { name: 'Manual actions', exact: true }).waitFor();
      assert.deepEqual(errors, []);
      assert.ok(!calls.some(call => /(?:sweep|tick|save|enable|prepare|submit)$/.test(call)));
      await context.close();
      console.log('PASS sweep destination, retained back navigation and no writes');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
