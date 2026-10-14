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
    destinations: { mode: 'only', list: [] }, assets: 'any' }, usage: { budget }, cooldowns: {} },
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
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      const { page, calls, state, errors } = await open(context, '/a/payables/', { held: true });
      const queue = page.getByRole('list', { name: 'Payment records' });
      await queue.getByRole('link').first().waitFor();
      assert.equal(await queue.getByRole('link').count(), 2);
      assert.ok(!calls.includes('paymentStatus'), 'queue must not start per-payment polling');
      assert.equal(await page.getByRole('button', { name: 'Sign approval', exact: true }).count(), 0);
      const selected = queue.getByRole('link').filter({ hasText: 'payment-one' });
      await selected.click();
      await page.getByRole('link', { name: 'Link to this payment', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('payment'), 'payment-one');
      assert.equal(await page.getByRole('link', { name: 'Link to this payment', exact: true }).count(), 1);
      assert.ok(calls.includes('paymentStatus'));
      state.settled = true;
      await page.reload();
      await page.getByText('Paid', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('payment'), 'payment-one');
      await page.getByRole('link', { name: 'All payments', exact: true }).click();
      await page.getByRole('list', { name: 'Payment records' }).getByRole('link').first().waitFor();
      assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover)$/.test(call)));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: '/tmp/product-payments-queue.png', fullPage: true });
      state.settled = false;
      await openWorkspaceNavigation(page);
      await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Home', exact: true }).click();
      const review = page.getByRole('link', { name: 'Review payment', exact: true }).first();
      await review.waitFor();
      assert.match(await review.getAttribute('href'), /\/a\/payables\/follow\/payment\?payment=payment-(one|two)$/);

      await context.close();
      console.log('PASS payment queue: no per-record polling, canonical review, retained selection after settlement and reload, no writes');
    }
    for (const width of [320, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const { page, calls, errors } = await open(context, '/a/payables/', { member: true });
      await page.getByRole('heading', { name: 'Payables · Payments', exact: true }).waitFor();
      const area = () => page.getByRole('navigation', { name: 'Area', exact: true });
      await openWorkspaceNavigation(page);
      await area().getByRole('link', { name: 'Payments', exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Portfolio', exact: true }).click();
      await page.getByRole('heading', { name: 'Portfolio · Overview', exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      await area().getByRole('link', { name: 'Strategy', exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      await area().getByRole('link', { name: 'Balances & funding', exact: true }).click();
      await page.getByRole('heading', { name: 'Balances', exact: true }).waitFor();
      const balances = page.getByRole('table', { name: 'Managed assets, public and confidential balances' });
      assert.match(await balances.innerText(), /10 USDC/);
      await page.getByText(/not the amount available for new payments/).waitFor();

      await openWorkspaceNavigation(page);
      await area().getByRole('link', { name: 'Runs', exact: true }).click();
      await page.getByRole('heading', { name: 'Portfolio · Runs', exact: true }).waitFor();
      assert.match(page.url(), /follow\/run/);
      await page.reload();
      await page.getByRole('heading', { name: 'Portfolio · Runs', exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      const activeInMenu = await area().getByRole('link', { name: 'Runs', exact: true }).evaluate(link => {
        const item = link.getBoundingClientRect(), menu = link.closest('nav').getBoundingClientRect();
        return item.left >= menu.left && item.right <= menu.right;
      });
      assert.ok(activeInMenu, 'selected task remains visible after direct reload on mobile');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|recover)$/.test(call)));
      await page.screenshot({ path: `/tmp/product-navigation-${width}.png`, fullPage: true });
      await context.close();
      console.log(`PASS ${width}px: task navigation, retained URLs, reload, no writes`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
