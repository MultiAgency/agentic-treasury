const { rpcValue } = require('./fixtures/rpc.cjs');
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
    if (options.clock) await page.clock.install();
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
        const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.payoutGrant && { grant: { ...setup.grant, label: "payout" } }), ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': options.linked ? { accountId: 'treasury.near', balances: { near: '1', usdc: '1000000' }, payees: [], dao: null, confidential: false } : null, held: options.held && !state.settled ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, approvalId: 'approval-' + correlationId, at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true } })) : [], unresolved: options.unresolved && kind === 'payables' ? [{ at: new Date().toISOString(), key: 'fixture-unresolved' }] : [],
          'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: options.held ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, at: '2026-10-14T00:00:00Z' })) : [], complete: true }, paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true }, approvalId: 'approval-one', expiresAt: '2030-01-01T00:00:00Z' },
          'autopilot/get': { on: true, everyMin: 60, maxUsd: 10 },
          'autopilot/evidence': { ticks: [run] } };
        if (options.missingTerms && values.held.length) {
          values.held[0].request = {};
          values.held[1].request.asset = 'unknown-token';
        }
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
      const { page, calls } = await open(context, '/a/payables/funding', { payoutGrant: true });
      const sweep = page.getByRole('region', { name: 'Shield public funds' });
      await sweep.getByText('Shielding requires a treasury grant. Payout and invoice grants cannot shield funds.').waitFor();
      assert.equal(await sweep.getByRole('button', { name: 'Preview', exact: true }).isDisabled(), true);
      assert.equal(await sweep.getByRole('button', { name: 'Shield', exact: true }).isDisabled(), true);
      await sweep.getByText(/Other assets are not included in this sweep/).waitFor();
      assert.ok(!calls.includes('sweep'));
      await context.close();
      console.log('PASS payout grant explains unavailable sweep and managed asset scope');
    }
    for (const width of [320, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const { page, calls, errors } = await open(context, '/a/treasury/funding', { held: true, linked: true });
      await page.getByRole('heading', { name: 'Receive funds', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Send funds', exact: true }).waitFor();
      await page.getByText('Not established', { exact: true }).waitFor();
      const held = page.getByRole('list', { name: 'Held payout records' });
      assert.equal(await held.getByRole('link').count(), 2);
      assert.ok((await held.innerText()).includes('1 USDC'));
      assert.ok((await page.getByRole('table').innerText()).includes('10 USDC'));
      const incoming = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Receive funds', exact: true }) });
      const outgoing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Send funds', exact: true }) });
      assert.equal(await incoming.getByText('Money out: return funds to treasury.near', { exact: true }).count(), 0);
      assert.ok(await outgoing.getByText('Money out: return funds to treasury.near', { exact: true }).isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.ok(!calls.some(call => /^(pay|deposit|treasury\/link|owner\/prepare)$/.test(call)), 'browsing funding does not initiate actions');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/funding-${width}.png`, fullPage: true });
      await context.close();
      console.log(`PASS separated directions and reported versus held funds at ${width}px`);
    }
    {
      const context = await browser.newContext();
      const { page, state } = await open(context, '/a/payables/funding', { held: true, missingTerms: true, clock: true });
      await page.getByText('Payment terms unavailable', { exact: true }).waitFor();
      await page.getByText('1000000 raw units of unknown-token to payee.near', { exact: true }).waitFor();
      state.error = 'held';
      await page.clock.fastForward(16000);
      await page.getByText('Held payout amounts are unavailable.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('list', { name: 'Held payout records' }).count(), 0, 'failed refresh must not present cached amounts as current');
      await page.getByText('Not established', { exact: true }).waitFor();
      state.error = 'overview';
      await page.clock.fastForward(31000);
      await page.clock.runFor(10000);
      await page.getByText(/Last reported balances; the latest refresh failed/).waitFor();
      await page.getByText('Not established', { exact: true }).waitFor();
      await context.close();
      console.log('PASS missing terms, unknown assets and failed refresh do not invent available funds');
    }
    for (const error of ['held', 'unresolved', 'treasury/get']) {
      const context = await browser.newContext();
      const { page, calls } = await open(context, '/a/payables/funding', { error });
      await page.getByText('Not established', { exact: true }).waitFor();
      if (error === 'held') {
        await page.getByText('Held payout amounts are unavailable.', { exact: true }).waitFor();
        assert.equal(await page.getByText('No held payouts found in the records checked.', { exact: true }).count(), 0);
      }
      if (error === 'treasury/get') {
        await page.getByText('Linked account could not be checked.', { exact: true }).waitFor();
        assert.equal(await page.getByText('Link a treasury account', { exact: true }).count(), 0);
      }
      assert.ok(!calls.includes('pay'));
      await context.close();
      console.log(`PASS ${error} failure never implies available funds or absent account`);
    }
    {
      const context = await browser.newContext();
      const { page } = await open(context, '/a/payables/funding', { unresolved: true });
      await page.getByRole('link', { name: 'Review unresolved operations', exact: true }).waitFor();
      await page.getByText('No held payouts found in the records checked.', { exact: true }).waitFor();
      await page.getByText('Not established', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Get a deposit address', exact: true }).waitFor();
      await context.close();
      console.log('PASS empty held records do not prove spendability');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
