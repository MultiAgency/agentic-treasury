const { rpcValue } = require('./fixtures/rpc.cjs');
/**
 * Offline simplification regressions. Build first with pnpm build:web.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome \
 *   node test/browser/coherent-ui.cjs [build-directory]
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
        agents: (options.onlyPayables ? ['payables'] : ['treasury', 'payables']).map(name => ({ name, owner: 'owner.near', dao: Boolean(options.dao) })),
        invoices: options.noInvoiceLink ? null : 'https://invoices.example', viewer: options.public ? null : { account: 'owner.near',
          access: Object.fromEntries((options.onlyPayables ? ['payables'] : ['treasury', 'payables']).map(name => [name, { role: options.member && name === 'payables' ? 'member' : 'operator', canPropose: true, canVote: true }])) },
      } });
      }
      if (pathname === '/gw/proposals') return route.fulfill({ json: options.proposals || [] });
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
        const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' ? [{ at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near' } }] : [], unresolved: options.unresolved && kind === 'payables' ? [{ at: new Date().toISOString(), key: 'fixture-unresolved' }] : [],
          'inbox/list': [], 'agreements/list': options.agreements || (options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z' }] : []), activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true },
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
    const agreement = (id, status) => ({ id, status, payee: `${id}.near`, amount: '1000000', origin: 'payee', at: '2026-10-01T00:00:00Z',
      ...(status !== 'requested' && { terms: { maxAmount: '1000000', until: '2030-01-01T00:00:00Z' } }) });
    const agreements = [agreement('established', 'agreed'), agreement('request', 'requested'), agreement('unfinished', 'proposed'), agreement('closed', 'declined')];
    for (const width of [320, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const { page, calls, errors } = await open(context, '/a/payables/payees', { agreements });
      await page.getByRole('heading', { name: 'Requests to review (1)', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Policy approval needed (1)', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Established agreements (1)', exact: true }).waitFor();
      const headings = await page.locator('h3').allTextContents();
      assert.ok(headings.indexOf('Requests to review (1)') < headings.indexOf('Established agreements (1)'));
      assert.equal(await page.getByRole('button', { name: 'Agree to these terms', exact: true }).count(), 1);
      assert.ok(await page.getByRole('button', { name: 'Continue policy approval', exact: true }).isVisible());
      assert.ok(!await page.locator('input[name="offer-payee"]').isVisible(), 'new offer form stays secondary while decisions wait');
      await page.getByText('Offer terms (a purchase order, a bounty or grant award)', { exact: true }).click();
      await page.locator('input[name="offer-payee"]').fill('draft.near');
      // Background refresh must not close or erase an owner’s draft.
      await page.waitForTimeout(5500);
      assert.equal(await page.locator('input[name="offer-payee"]').inputValue(), 'draft.near');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: overflow`);
      assert.ok(!calls.some(call => /offer|propose|prepare|decline/.test(call)));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/home-agreements-${width}.png`, fullPage: true });
      await context.close();
      console.log(`PASS agreement decision groups, draft retention, no mutations at ${width}px`);
    }
    {
      const context = await browser.newContext();
      const { page, calls } = await open(context, '/', { agreements, unresolved: true, dao: true, proposals: [{ id: 42, what: 'past', status: 'Approved', proposer: 'owner.near', submittedAt: '2026-10-01T00:00:00Z', description: 'Completed fixture proposal' }] });
      await page.getByText(/1 money action has no proven outcome/).waitFor();
      await page.getByRole('link', { name: 'Review agreement requests' }).first().waitFor();
      assert.equal(await page.getByRole('link', { name: 'Continue agreement setup' }).first().getAttribute('href'), '/a/treasury/payees');
      assert.ok(!await page.getByText('Completed fixture proposal', { exact: true }).isVisible());
      await page.getByText('Recent completed proposals (1)', { exact: true }).click();
      assert.ok(await page.getByText('Completed fixture proposal', { exact: true }).isVisible());
      const attention = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Needs attention', exact: true }) });
      const rows = await attention.locator('li').allTextContents();
      assert.ok(rows.findIndex(text => text.includes('no proven outcome')) < rows.findIndex(text => text.includes('agreement request')), 'unresolved operations precede agreement requests');
      const headings = await page.locator('h2').allTextContents();
      assert.ok(headings.indexOf('What am I voting on?') < headings.indexOf('Current status'), 'voting decisions precede routine status');
      assert.ok(!calls.some(call => /offer|propose|prepare|decline/.test(call)));
      await context.close();
      console.log('PASS Home prioritizes unresolved operations and voting decisions');
    }
    for (const source of ['agreements/list', 'inbox/list']) {
      const context = await browser.newContext();
      const { page, errors } = await open(context, '/', { error: source, unresolved: true });
      await page.getByText(/checks are incomplete/).first().waitFor();
      await page.getByText(/1 money action has no proven outcome/).waitFor();
      await page.getByText('Policy in force', { exact: true }).first().waitFor();
      await page.getByText('Autopilot to $10', { exact: true }).waitFor();
      assert.equal(await page.getByText('No items need attention in the records checked.', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${source} failure retains known attention and independent status`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
