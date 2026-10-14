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
  const results = [];
  const filter = process.env.CASE_FILTER;
  async function check(name, work) {
    if (filter && !name.includes(filter)) return;
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    try { await work(context); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
    finally { await context.close(); }
  }
  async function open(context, routePath, options = {}) {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const calls = [];
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
        agents: ['treasury', 'payables'].map(name => ({ name, owner: 'owner.near', dao: false })),
        invoices: options.noInvoiceLink ? null : 'https://invoices.example', viewer: options.public ? null : { account: 'owner.near',
          access: Object.fromEntries(['treasury', 'payables'].map(name => [name, { role: 'operator', canPropose: true, canVote: true }])) },
      } });
      }
      if (pathname.includes('/rpc/')) {
        const method = pathname.split('/rpc/')[1];
        calls.push(method);
        if (method === state.delay && (!options.onlyTreasury || pathname.includes('/treasury/'))) await new Promise(resolve => setTimeout(resolve, 2500));
        if (page.isClosed()) return;
        if (method === state.error && (!options.onlyTreasury || pathname.includes('/treasury/'))) {
          return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture read unavailable' } } });
        }
        const kind = pathname.includes('/payables/') ? 'payables' : 'treasury';
        const values = { instance: { agentId: 'fixture', executor: !options.approveOnly }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' ? [{ at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near' } }] : [], unresolved: options.unresolved && kind === 'payables' ? [{ at: new Date().toISOString(), key: 'fixture-unresolved' }] : [],
          'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true },
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
    return { page, calls, errors, state };
  }


  for (const width of [320, 390, 1280]) {
    await check(`funding starts with a deposit at ${width}px`, async context => {
      const { page, calls } = await open(context, '/a/treasury/funding');
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('button', { name: 'Get a deposit address', exact: true }).waitFor();
      assert.ok(!await page.getByRole('textbox', { name: 'Treasury NEAR account' }).isVisible());
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `funding-${width}.png`), fullPage: true });
      const disclosure = page.getByText('Link a treasury account', { exact: true });
      await disclosure.focus(); await page.keyboard.press('Enter');
      assert.ok(await page.getByRole('textbox', { name: 'Treasury NEAR account' }).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(!calls.includes('treasury/link'));
    });
    await check(`agreements keep direct policy setup secondary at ${width}px`, async context => {
      const { page, calls } = await open(context, '/a/payables/payees');
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('heading', { name: 'Agreements', exact: true }).waitFor();
      assert.ok(await page.getByRole('textbox', { name: 'Payee’s NEAR account', exact: true }).first().isVisible());
      assert.ok(!await page.locator('input[name="payee"]').isVisible());
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `agreements-${width}.png`), fullPage: true });
      const disclosure = page.getByText('Add a payee without agreement terms', { exact: true });
      await disclosure.focus(); await page.keyboard.press('Enter');
      assert.ok(await page.locator('input[name="payee"]').isVisible());
      assert.ok(await page.getByText('This updates the policy only. Offer terms above to record an amount ceiling and deadline.').isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(!calls.some(call => /offer|propose|prepare|execute/.test(call)));
    });
  }
  await check('optional linking is not an Overview blocker', async context => {
    const { page } = await open(context, '/a/treasury/');
    await page.getByRole('heading', { name: 'Needs attention', exact: true }).waitFor();
    assert.equal(await page.getByText(/No treasury linked/).count(), 0);
  });
  for (const excluded of [false, true]) {
    await check(`unmanaged asset: ${excluded ? 'excluded' : 'allowed'} by policy`, async context => {
      const { page, calls } = await open(context, '/a/treasury/', { unmanaged: true, excluded });
      const row = page.getByRole('listitem').filter({ hasText: 'The agent holds 1 OTHER,' });
      await row.waitFor();
      if (excluded) {
        const action = row.getByRole('link', { name: /Review policy assets/ });
        assert.ok((await action.getAttribute('href')).endsWith('/policy'));
      } else {
        assert.equal(await row.getByRole('link').count(), 0);
        assert.equal(await row.getByText('Review policy assets').count(), 0);
        assert.ok(await row.getByText(/outside the assets its strategies manage/).isVisible());
      }
      assert.ok(!calls.some(call => /prepare|execute|update/.test(call)));
    });
  }
  for (const state of ['configured', 'missing', 'unavailable']) {
    await check(`agreed payee with ${state} invoice link`, async context => {
      const { page, errors } = await open(context, '/a/payables/payees', {
        agreed: true, noInvoiceLink: state === 'missing', invoiceLinkError: state === 'unavailable',
      });
      await page.getByText('Agreed, invoice not filed yet', { exact: true }).waitFor();
      if (state === 'configured') assert.equal(await page.getByRole('link', { name: 'Open invoice page', exact: true }).count(), 1);
      else if (state === 'missing') await page.getByText("Ask the operator for this agent's invoice page address.", { exact: true }).waitFor();
      else await page.getByText('Invoice link unavailable', { exact: true }).waitFor();
      assert.equal(await page.getByText(/Share the invoice page above/).count(), 0);
      assert.deepEqual(errors, []);
    });
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  if (!results.length || results.some(result => !result.pass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
