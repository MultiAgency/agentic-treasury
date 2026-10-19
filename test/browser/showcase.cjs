const { rpcValue } = require('./fixtures/rpc.cjs');
const { runSuite } = require('./fixtures/task.cjs');
/**
 * Offline showcase regressions. Build first with pnpm build:web.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome \
 *   node test/browser/showcase.cjs [build-directory]
 * All requests are intercepted. No server, wallet, or executor is started.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
const { makeTick, recordingFor } = require('./fixtures/run.cjs');
const plannedBriefs = /Purchase orders|Campaign payouts|Adaptive DCA|House Money|Bitcoin treasury/;
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


runSuite(async () => {
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
    const network = [];
    page.on('request', request => network.push(new URL(request.url()).pathname));
    const errors = [];
    const state = { error: options.error, delay: options.delay };
    const run = makeTick(options.outcome || 'quiet', budget);
    if (options.oldRun) {
      run.at = '2020-01-01T00:00:00Z';
      run.end.endedAt = run.at;
      run.end.before.at = run.at;
      run.end.after.at = run.at;
    }
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'frontend.test') return route.abort();
      const pathname = url.pathname;
      if (pathname === '/gw/me') return route.fulfill({ json: {
        agents: ['treasury', 'payables'].map(name => ({ name, owner: 'owner.near', dao: false })),
        invoices: 'https://invoices.example', viewer: options.public ? null : { account: 'owner.near',
          access: Object.fromEntries(['treasury', 'payables'].map(name => [name, { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true }])) },
      } });
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
          'inbox/list': [], 'workOrders/list': [], 'agreements/list': [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true },
          'autopilot/get': { on: true, everyMin: 60, maxUsd: 10 },
          'autopilot/evidence': { ticks: [run] } };
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
    return { page, calls, errors, state, network };
  }

  await check('public connect button starts sign-in and recovers from an unavailable gateway', async context => {
    const { page, calls } = await open(context, '/', { public: true });
    let challenges = 0;
    await page.route('**/gw/challenge', async route => {
      challenges++;
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.fulfill({ status: 503, json: { error: 'Sign-in is unavailable in this preview.' } });
    });
    const nav = page.getByRole('main');
    assert.equal(challenges, 0);
    await nav.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    assert.ok(await nav.getByRole('button', { name: 'Connecting…', exact: true }).isDisabled());
    await nav.getByText('Sign-in is unavailable in this preview.', { exact: true }).waitFor();
    assert.match(await nav.getByRole('alert').innerText(), /Sign-in is unavailable/);
    assert.ok(await nav.getByRole('button', { name: 'Connect wallet', exact: true }).isEnabled());
    assert.equal(challenges, 1);
    assert.deepEqual(calls, []);
  });
  await check('review: connecting initializes the member wallet and signs the challenge', async context => {
    await context.addInitScript(() => {
      // Context scripts also run in the initial blank document, which has no storage origin.
      if (location.origin !== 'http://frontend.test') return;
      localStorage.setItem('member:selected-wallet:mainnet', 'fixture-wallet');
      const accounts = [{ accountId: 'owner.near', publicKey: 'ed25519:fixture' }];
      const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true }, permissions: {} },
        getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
        signMessage: async () => ({ ...accounts[0], signature: 'offline-signature' }) };
      window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
    });
    const { page, network, errors } = await open(context, '/', { public: true });
    const challenge = { message: 'Offline sign-in', recipient: 'frontend.test', nonce: Buffer.alloc(32).toString('base64') };
    let signed;
    await page.route('**/gw/challenge', route => route.fulfill({ json: challenge }));
    await page.route('**/gw/session', route => {
      signed = route.request().postDataJSON();
      return route.fulfill({ status: 503, json: { error: 'Offline signature received' } });
    });
    const nav = page.getByRole('main');
    await nav.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await nav.getByText('Offline signature received', { exact: true }).waitFor();
    assert.equal(signed.signature, 'offline-signature');
    assert.equal(signed.nonce, challenge.nonce);
    assert.equal(signed.accountId, 'owner.near');
    assert.ok(network.some(url => url.includes('fastnear/near-connect') && url.endsWith('manifest.json')));
    assert.ok(!network.some(url => url.includes('hot-dao/near-selector')));
    assert.deepEqual(errors, []);
  });
  await check('review: public pages do not discover wallets before connection', async context => {
    for (const path of ['/', '/#/explore/treasury/overview']) {
      const { page, network } = await open(context, path, { public: true });
      await page.getByRole('heading', { level: 1 }).waitFor();
      await page.waitForTimeout(500);
      assert.deepEqual(network.filter(url => url.includes('manifest.json')), []);
      await page.close();
    }
  });
  await check('claims: sign-in entry offers no public evidence or guarantee scores', async context => {
    const { page, calls } = await open(context, '/', { public: true });
    await page.getByRole('heading', { name: 'Agentic Treasury', exact: true }).waitFor();
    const text = await page.locator('body').innerText();
    assert.match(text, /real funds on mainnet/);
    assert.doesNotMatch(text, /guarantees enforced|View requirements|Observed on mainnet|proposal #/);
    assert.deepEqual(calls, [], 'public entry never reads agent data');
  });
  for (const width of [320, 390, 1280]) {
    await check(`public disclosure and area order at ${width}px`, async context => {
      const { page, calls, errors } = await open(context, '/', { public: true });
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('heading', { name: 'Agentic Treasury', exact: true }).waitFor();
      assert.equal(await page.getByRole('group', { name: /Evidence coverage/ }).count(), 0);
      assert.equal(await page.getByRole('link', { name: 'See how it works', exact: true }).count(), 0);
      assert.ok(await page.getByRole('button', { name: 'Connect wallet', exact: true }).isVisible());
      assert.doesNotMatch(await page.locator('body').textContent(), plannedBriefs);
      assert.doesNotMatch(await page.locator('body').innerText(), /proposal #/);
      assert.deepEqual(calls, []);
      assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });
  }
  // The agent page carries its area's running brief: requirements, how each is known, and its evidence.
  for (const kind of ['treasury', 'payables']) {
    await check(`${kind} agent page shows only its running brief's requirements and evidence`, async context => {
      const { page, calls, errors } = await open(context, `/a/${kind}/`);
      const heading = page.getByRole('heading', { name: /: requirements and evidence$/ });
      await heading.waitFor();
      const card = heading.locator('xpath=ancestor::*[.//summary][1]');
      const briefs = card.locator('summary').filter({ hasText: /^\d{2} / });
      assert.equal(await briefs.count(), 1);
      if (kind === 'payables') assert.deepEqual(await briefs.allTextContents(), ['01 Confidential Treasury Facilitator']);
      await briefs.click();
      assert.ok(await page.getByText(kind === 'treasury' ? /The autopilot executed a rebalance alone/ : /Invoices filed at invoices.multiagency.ai, voted and paid/).isVisible());
      assert.doesNotMatch(await card.textContent(), plannedBriefs);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(!calls.includes('autopilot/tick'));
      assert.deepEqual(errors, []);
    });
  }
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exitCode = results.length > 0 && results.every(result => result.pass) ? 0 : 1;
});
