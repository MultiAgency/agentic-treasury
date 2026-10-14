const { rpcValue } = require('./fixtures/rpc.cjs');
const { openWorkspaceNavigation } = require("./fixtures/navigation.cjs");
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
          access: Object.fromEntries(['treasury', 'payables'].map(name => [name, { role: 'operator', canPropose: true, canVote: true }])) },
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
          'inbox/list': [], 'agreements/list': [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true },
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

  await check('explorer: invoice review and outcome survive page navigation without gateway or agent reads', async context => {
    const { page, network, errors } = await open(context, '/#/explore/payables/overview', { public: true });
    await page.getByRole('link', { name: 'Open example invoice', exact: true }).click();
    await page.getByLabel('Completed work', { exact: true }).fill('Example logo delivery');
    await page.getByRole('button', { name: 'Submit example invoice', exact: true }).click();
    await page.getByRole('button', { name: 'Simulate owner approval', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Review the agreement', exact: true }).click();
    await page.getByRole('link', { name: 'Create example invoice', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Payments', exact: true }).waitFor();
    assert.match(await page.getByRole('main').innerText(), /Example logo delivery/);
    await page.getByRole('button', { name: 'Simulate owner approval', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Activity', exact: true }).waitFor();
    await page.getByRole('button', { name: 'See example payout outcome', exact: true }).click();
    assert.match(await page.getByRole('status').innerText(), /Example payout completed/);
    assert.ok(await page.getByRole('status').evaluate(e => e === document.activeElement));
    await page.goBack();
    await page.getByRole('heading', { level: 1, name: 'Payments', exact: true }).waitFor();
    assert.match(await page.getByRole('main').innerText(), /Paid/);
    await page.reload();
    await page.getByLabel('Completed work', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Completed work', { exact: true }).inputValue(), 'One completed design milestone');
    assert.deepEqual(network.filter(p => p.startsWith('/gw/') || p.includes('/rpc')), []);
    assert.deepEqual(errors, []);
  });
  await check('explorer: treasury strategy, execution and revoked permission are reflected across pages', async context => {
    const { page, network, errors } = await open(context, '/#/explore/treasury/automations', { public: true });
    await page.getByLabel('Example strategy', { exact: true }).selectOption('reserve');
    await page.getByRole('button', { name: 'Preview plan', exact: true }).click();
    assert.match(await page.getByRole('main').innerText(), /Shift 10 percentage points/);
    await page.getByRole('button', { name: 'Check authorization', exact: true }).click();
    await page.getByRole('button', { name: 'Run example rebalance', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Runs', exact: true }).waitFor();
    assert.match(await page.getByRole('status').innerText(), /Example rebalance completed/);
    await page.getByRole('link', { name: 'Policy & grants', exact: true }).click();
    await page.getByLabel('Example grant', { exact: true }).selectOption('absent');
    await page.getByRole('link', { name: 'Try with this permission', exact: true }).click();
    await page.getByRole('button', { name: 'Preview plan', exact: true }).click();
    assert.match(await page.getByRole('status').innerText(), /Nothing is sent/);
    assert.doesNotMatch(await page.getByRole('table').innerText(), /Result/);
    await page.getByRole('link', { name: 'Inspect the outcome', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Runs', exact: true }).waitFor();
    assert.match(await page.getByRole('status').innerText(), /Stopped: owner permission absent/);
    assert.deepEqual(network.filter(p => p.startsWith('/gw/') || p.includes('/rpc')), []);
    assert.deepEqual(errors, []);
  });
  await check('public connect button starts sign-in and recovers from an unavailable gateway', async context => {
    const { page, calls } = await open(context, '/', { public: true });
    let challenges = 0;
    await page.route('**/gw/challenge', async route => {
      challenges++;
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.fulfill({ status: 503, json: { error: 'Sign-in is unavailable in this preview.' } });
    });
    const nav = page.getByRole('navigation', { name: 'Landing page' });
    assert.equal(challenges, 0);
    await nav.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    assert.ok(await nav.getByRole('button', { name: 'Connecting…', exact: true }).isDisabled());
    await nav.getByText('Sign-in is unavailable in this preview.', { exact: true }).waitFor();
    assert.match(await nav.getByRole('alert').innerText(), /Sign-in is unavailable/);
    assert.ok(await nav.getByRole('button', { name: 'Connect wallet', exact: true }).isEnabled());
    assert.equal(challenges, 1);
    assert.deepEqual(calls, []);
  });
  await check('simulation: autoplay stops for explicit approval and preserves keyboard focus', async context => {
    const { page, calls, errors } = await open(context, '/', { public: true });
    await page.getByRole('article', { name: 'Payables workflow' }).getByRole('button', { name: 'Demo' }).click();
    const demo = page.getByRole('region', { name: 'Payables simulation' });
    await page.clock.install();
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    assert.match(await demo.innerText(), /One completed design milestone/);
    await demo.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.fastForward(6100);
    const approval = demo.getByRole('button', { name: 'Simulate owner approval' });
    await approval.waitFor();
    assert.ok(await approval.evaluate(e => e === document.activeElement));
    assert.ok(await demo.getByRole('button', { name: 'Play', exact: true }).isDisabled());
    await page.clock.fastForward(20000);
    assert.match(await demo.getByRole('status').innerText(), /Held for owner review/);
    await page.keyboard.press('Enter');
    assert.ok(await demo.getByRole('button', { name: 'Next step' }).evaluate(e => e === document.activeElement));
    await page.keyboard.press('Enter');
    assert.match(await demo.getByRole('status').innerText(), /Example payout completed/);
    assert.ok(await demo.getByRole('status').evaluate(e => e === document.activeElement));
    await demo.getByRole('button', { name: 'Try again' }).click();
    await demo.getByRole('button', { name: 'Next step' }).click();
    await approval.waitFor();
    assert.ok(await demo.getByRole('button', { name: 'Play', exact: true }).isDisabled());
    await demo.getByRole('button', { name: 'Restart' }).click();
    assert.match(await demo.getByRole('status').innerText(), /Review the example invoice/);
    await demo.getByRole('combobox', { name: 'Owner permission to act' }).selectOption('absent');
    await demo.getByRole('button', { name: 'Next step' }).click();
    assert.match(await demo.getByRole('status').innerText(), /Stopped: owner permission absent/);
    assert.equal(await approval.count(), 0);
    assert.deepEqual(requests, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(errors, []);
  });
  await check('simulation: strategies change the plan and both treasury outcomes remain inspectable', async context => {
    const { page, calls } = await open(context, '/', { public: true });
    const article = page.getByRole('article', { name: 'Portfolio workflow' });
    await article.getByRole('button', { name: 'Demo' }).click();
    const demo = page.getByRole('region', { name: 'Portfolio simulation' });
    assert.match(await demo.getByRole('table').innerText(), /40%/);
    await demo.getByRole('combobox', { name: 'Example strategy', exact: true }).selectOption('reserve');
    assert.match(await demo.getByRole('table').innerText(), /70%/);
    await demo.getByRole('button', { name: 'Next step' }).click();
    assert.match(await demo.innerText(), /Shift 10 percentage points/);
    await demo.getByRole('button', { name: 'Next step' }).click();
    await demo.getByRole('button', { name: 'Next step' }).click();
    assert.match(await demo.getByRole('status').innerText(), /Example rebalance completed/);
    assert.match(await demo.getByRole('table').innerText(), /Result/);
    await demo.getByText('Inspect simulated AG-UI events', { exact: true }).click();
    assert.match(await demo.locator('pre').innerText(), /RUN_FINISHED/);
    await demo.getByRole('combobox', { name: 'Owner permission to act' }).selectOption('absent');
    assert.match(await demo.getByRole('table').innerText(), /Current/);
    await demo.getByRole('button', { name: 'Next step' }).click();
    assert.match(await demo.getByRole('status').innerText(), /Nothing is sent/);
    assert.doesNotMatch(await demo.getByRole('table').innerText(), /Result/);
    assert.match(await demo.locator('pre').innerText(), /RUN_FINISHED/);
    assert.deepEqual(calls, []);
  });
  await check('simulation: pause, background, offscreen, close and restart cancel playback', async context => {
    const { page, calls } = await open(context, '/', { public: true });
    const article = page.getByRole('article', { name: 'Portfolio workflow' });
    await article.getByRole('button', { name: 'Demo' }).click();
    const demo = page.getByRole('region', { name: 'Portfolio simulation' });
    await page.clock.install();
    await demo.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.fastForward(6100);
    await demo.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = await demo.getByRole('status').innerText();
    await page.clock.fastForward(20000);
    assert.equal(await demo.getByRole('status').innerText(), paused);
    await demo.getByRole('button', { name: 'Play', exact: true }).click();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await demo.getByRole('button', { name: 'Play', exact: true }).waitFor();
    await page.clock.fastForward(20000);
    assert.equal(await demo.getByRole('status').innerText(), paused);
    await page.evaluate(() => { delete document.hidden; });
    await demo.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
    await demo.getByRole('button', { name: 'Play', exact: true }).waitFor();
    await page.clock.fastForward(20000);
    assert.equal(await demo.getByRole('status').innerText(), paused);
    await demo.getByRole('button', { name: 'Play', exact: true }).click();
    await article.getByRole('button', { name: 'Close demo' }).click();
    await page.clock.fastForward(20000);
    await article.getByRole('button', { name: 'Demo' }).click();
    assert.equal(await demo.getByRole('status').innerText(), paused);
    await demo.getByRole('button', { name: 'Restart' }).click();
    assert.match(await demo.getByRole('status').innerText(), /Compare the example allocations/);
    assert.deepEqual(calls, []);
  });
  await check('recovery: known attention survives another agent loading', async context => {
    const { page } = await open(context, '/', { delay: 'overview', onlyTreasury: true, unresolved: true });
    await page.getByText(/1 money action has no proven outcome/).waitFor({ timeout: 1800 });
  });
  await check('recovery: known attention survives a failed sibling read', async context => {
    const { page } = await open(context, '/', { error: 'overview', unresolved: true });
    await page.getByText(/1 money action has no proven outcome/).waitFor({ timeout: 5000 });
    await page.getByText(/checks.*incomplete/i).first().waitFor();
  });
  await check('completion: quick demos restart current choices and explore the same area', async context => {
    const { page, calls } = await open(context, '/', { public: true });
    for (const name of ['Payables', 'Portfolio']) {
      await page.getByRole('article', { name: `${name} workflow` }).getByRole('button', { name: 'Demo', exact: true }).click();
      const demo = page.getByRole('region', { name: `${name} simulation` });
      await demo.getByRole('combobox', { name: 'Owner permission to act' }).selectOption('absent');
      await demo.getByRole('button', { name: 'Next step', exact: true }).click();
      assert.match(await demo.getByRole('status').innerText(), /Nothing is sent/);
      assert.equal(await demo.getByRole('link', { name: 'Explore', exact: true }).getAttribute('href'), `/#/explore/${name === 'Portfolio' ? 'treasury' : 'payables'}/overview`);
      assert.equal(await demo.getByRole('button', { name: 'Play', exact: true }).count(), 0);
      assert.equal(await demo.getByRole('button', { name: 'Previous step', exact: true }).count(), 0);
      await demo.getByRole('button', { name: 'Try again', exact: true }).click();
      assert.ok(await demo.getByRole('button', { name: 'Next step' }).evaluate(e => e === document.activeElement));
      assert.equal(await demo.getByRole('combobox', { name: 'Owner permission to act' }).inputValue(), 'absent');
      assert.equal(await demo.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
    }
    assert.deepEqual(calls, []);
  });
  await check('completion: full flow restarts with current choices and history collapsed', async context => {
    const { page } = await open(context, '/#/explore/treasury/automations', { public: true });
    for (const name of ['Preview plan', 'Check authorization', 'Run example rebalance']) await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Runs', exact: true }).waitFor();
    assert.equal(await page.getByRole('list', { name: 'Example activity' }).isVisible(), false);
    await page.getByRole('link', { name: 'Try again', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Strategy', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Policy & grants', exact: true }).click();
    await page.getByLabel('Example grant').selectOption('absent');
    await page.getByRole('link', { name: 'Try with this permission' }).click();
    await page.getByRole('button', { name: 'Preview plan', exact: true }).click();
    assert.match(await page.getByRole('status').innerText(), /Nothing is sent/);
  });
  await check('review: edited invoice matches every emitted state', async context => {
    const { page } = await open(context, '/#/explore/payables/invoices', { public: true });
    await page.getByLabel('Completed work').fill('Logo handoff for October');
    await page.getByRole('button', { name: 'Submit example invoice' }).click();
    await page.getByRole('button', { name: 'Simulate owner approval' }).click();
    await page.getByText('Inspect example AG-UI events', { exact: true }).click();
    const events = JSON.parse(await page.locator('pre').innerText());
    for (const event of events.filter(e => e.type === 'CUSTOM')) assert.equal(event.value.invoice.work, 'Logo handoff for October');
  });
  await check('review: reset restores grant, strategy and invoice defaults', async context => {
    const { page } = await open(context, '/#/explore/treasury/automations', { public: true });
    await page.getByLabel('Example strategy').selectOption('reserve');
    await page.locator('a[href="#/explore/treasury/policy"]').click();
    await page.getByLabel('Example grant').selectOption('absent');
    await page.getByRole('button', { name: 'Reset example' }).click();
    assert.equal(await page.getByLabel('Example grant').inputValue(), 'active');
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Policy & grants');
    await page.getByRole('link', { name: 'Strategy', exact: true }).click();
    assert.equal(await page.getByLabel('Example strategy').inputValue(), 'standard');
    await page.getByRole('link', { name: 'Explore Payables' }).click();
    await page.getByRole('link', { name: 'Payments', exact: true }).click();
    await page.getByLabel('Completed work').fill('Changed milestone');
    await page.getByRole('button', { name: 'Reset example' }).click();
    assert.equal(await page.getByLabel('Completed work').inputValue(), 'One completed design milestone');
  });
  await check('review: mobile overview prioritizes action and uses sequential headings', async context => {
    const { page } = await open(context, '/#/explore/treasury/overview', { public: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const action = page.getByRole('link', { name: 'Preview a rebalance', exact: true });
    await action.waitFor();
    const box = await action.boundingBox();
    assert.ok(box.y + box.height < 844, 'primary action fits in first mobile viewport');
    assert.equal(await page.getByRole('heading', { name: 'Illustrative allocation', level: 2 }).count(), 1);
  });
  await check('review: connecting initializes the member wallet and signs the challenge', async context => {
    await context.addInitScript(() => {
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
    const nav = page.getByRole('navigation', { name: 'Landing page' });
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
  await check('claims: qualifications stay visible without aggregate guarantee scores', async context => {
    const { page, calls } = await open(context, '/', { public: true });
    await page.getByText('View requirements', { exact: true }).first().click();
    const text = await page.locator('body').innerText();
    assert.doesNotMatch(text, /guarantees enforced by the signed policy/);
    assert.match(text, /These are catalog targets, not established guarantees/);
    assert.match(text, /Approval timing is public/);
    await page.getByText(/Control: the signed policy/).first().waitFor();
    assert.doesNotMatch(text, /Enforced by the signed policy/);
    const capRow = page.locator('li').filter({ hasText: "An over-limit payment can't go through, even with votes" });
    assert.match(await capRow.innerText(), /Per pinned provider source; deployed behavior unverified/);
    assert.doesNotMatch(await capRow.innerText(), /Tested offline/);
    assert.deepEqual(calls, [], 'public claims never read agent data');
  });
  await check('recovery: missing setup is not a missing grant', async context => {
    const { page } = await open(context, '/', { error: 'setup', unresolved: true });
    await page.getByText(/1 money action has no proven outcome/).waitFor();
    assert.equal(await page.getByText(/No live grant/).count(), 0);
  });
  await check('recovery: held payout survives unavailable balances', async context => {
    const { page } = await open(context, '/', { error: 'overview', held: true });
    await page.getByText(/payee.near is held for the owner/).waitFor();
  });
  await check('recovery: latest retained run is visible after a quiet day', async context => {
    const { page } = await open(context, '/a/treasury/', { oldRun: true });
    await page.getByRole('link', { name: 'Inspect run', exact: true }).waitFor({ timeout: 3000 });
  });
  await check('recovery: retained history is discoverable without an ID', async context => {
    const { page, calls } = await open(context, '/a/treasury/follow/run', { oldRun: true });
    await page.getByRole('heading', { name: 'Recorded observations', exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await page.getByRole('option').count(), 2);
    assert.ok(!calls.includes('autopilot/log'), 'historical runs do not start automatic recording reads');
  });
  await check('recovery: grantless member can inspect Activity', async context => {
    const { page, calls } = await open(context, '/a/treasury/activity', { noGrant: true });
    await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor({ timeout: 3000 });
    assert.ok(calls.includes('activity'));
    await page.getByRole('heading', { name: 'Continue setup', exact: true }).waitFor();
    assert.ok(!calls.includes('autopilot/tick'));
  });
  for (const unavailable of ['noGrant', 'approveOnly']) {
    await check(`recovery: ${unavailable} cannot start a treasury run`, async context => {
      const { page, calls } = await open(context, '/a/treasury/follow/run', { [unavailable]: true });
      const action = page.getByRole('button', { name: 'Run now', exact: true });
      await action.waitFor();
      assert.ok(await action.isDisabled());
      assert.ok(!calls.includes('autopilot/tick'));
      if (unavailable === 'approveOnly') assert.ok(!calls.includes('autopilot/log'));
    });
  }
  for (const width of [320, 390, 1280]) {
    await check(`explorer: landing entry and responsive page navigation at ${width}px`, async context => {
      const { page, calls, errors } = await open(context, '/', { public: true });
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('article', { name: 'Payables workflow' }).getByRole('link', { name: 'Explore', exact: true }).click();
      await page.getByRole('navigation', { name: 'Payables prototype' }).waitFor();
      assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Overview');
      assert.ok(await page.getByRole('main').evaluate(e => e === document.activeElement));
      await page.getByRole('link', { name: 'Payments', exact: true }).click();
      await page.getByRole('heading', { level: 1, name: 'Payments', exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `explorer-${width}.png`), fullPage: true });
      await page.getByRole('link', { name: 'Explore Portfolio', exact: true }).click();
      await page.getByRole('navigation', { name: 'Portfolio prototype' }).waitFor();
      await page.getByRole('link', { name: 'Back to landing page', exact: true }).click();
      await page.getByRole('heading', { name: 'Two agents. Two workflows.', exact: true }).waitFor();
      assert.deepEqual(calls, []);
      assert.deepEqual(errors, []);
    });
    await check(`simulation: responsive players and event inspection at ${width}px`, async context => {
      const { page, calls, errors } = await open(context, '/', { public: true });
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['Payables', 'Portfolio']) {
        await page.getByRole('article', { name: `${name} workflow` }).getByRole('button', { name: 'Demo' }).click();
        const demo = page.getByRole('region', { name: `${name} simulation` });
        await demo.getByText('Inspect simulated AG-UI events', { exact: true }).click();
        assert.match(await demo.locator('pre').innerText(), /RUN_STARTED/);
        await demo.getByRole('button', { name: 'Next step' }).click();
        assert.match(await demo.locator('pre').innerText(), /CUSTOM/);
        assert.match(await demo.innerText(), /No real funds/);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `simulation-${width}.png`), fullPage: true });
      assert.deepEqual(calls, []);
      assert.deepEqual(errors, []);
    });
    await check(`public disclosure and area order at ${width}px`, async context => {
      const { page, calls, errors } = await open(context, '/', { public: true });
      await page.setViewportSize({ width, height: 900 });
      const treasury = page.getByRole('heading', { name: 'Portfolio', level: 2, exact: true });
      await treasury.waitFor();
      const summaries = page.getByRole('group', { name: /Evidence coverage/ });
      assert.equal(await summaries.count(), 2);
      for (const summary of await summaries.all()) {
        assert.ok(await summary.isVisible());
        assert.match(await summary.innerText(), /Observed on mainnet/);
        assert.doesNotMatch(await summary.innerText(), /Mainnet · (this|another) agent/);
        assert.match(await summary.innerText(), /Offline only/);
        assert.match(await summary.innerText(), /Not supported/);
        assert.match(await summary.innerText(), /Not yet demonstrated/);
        assert.match(await summary.innerText(), /Known limitations/);
        assert.match(await summary.innerText(), /not live checks or proof of every guarantee/);
      }
      assert.doesNotMatch(await page.locator('body').innerText(), /Invoices filed at|The autopilot executed a rebalance alone|proposal #/);
      assert.doesNotMatch(await page.locator('body').textContent(), plannedBriefs);
      assert.equal(await page.getByText('Roadmap', { exact: true }).count(), 0);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `cards-${width}.png`), fullPage: true });
      assert.ok((await treasury.boundingBox()).y < (await page.getByRole('heading', { name: 'Members', exact: true }).boundingBox()).y);
      const workflows = page.getByRole('region', { name: 'Two agents. Two workflows.' });
      assert.equal(await workflows.getByRole('list').count(), 2);
      const flowBox = await workflows.boundingBox();
      assert.ok(flowBox.y + flowBox.height <= (await summaries.first().boundingBox()).y);
      await page.getByRole('link', { name: 'Explore the workflows', exact: true }).click();
      assert.equal(new URL(page.url()).hash, '#workflows');
      assert.equal(await page.getByRole('link', { name: /^(Payables|Portfolio) requirement stages$/ }).count(), 0);
      assert.ok(await page.getByRole('navigation', { name: 'Landing page' }).getByRole('button', { name: 'Connect wallet', exact: true }).isVisible());
      assert.ok((await page.getByRole('link', { name: 'Request a payment' }).boundingBox()).y < (await summaries.first().boundingBox()).y);
      await page.getByText('View requirements', { exact: true }).first().click();
      assert.ok(await page.getByRole('heading', { name: 'Capability targets', exact: true }).isVisible());
      assert.ok(await page.getByRole('heading', { name: 'Safety targets', exact: true }).isVisible());
      assert.deepEqual(calls, []);
      assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });
    await check(`compact run and directly accessible evidence at ${width}px`, async context => {
      const { page, calls, errors } = await open(context, '/a/treasury/');
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('link', { name: 'Inspect run', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Recorded observations', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Run now', exact: true }).count(), 0);
      const run = await page.getByRole('heading', { name: 'Latest treasury run', exact: true }).boundingBox();
      const figures = await page.getByText('Book value', { exact: true }).boundingBox();
      assert.ok(run.y < figures.y);
      await page.getByRole('link', { name: 'Inspect evidence and limitations', exact: true }).click();
      assert.ok(await page.locator('#evidence details').first().getAttribute('open') !== null);
      assert.doesNotMatch(await page.locator('#evidence').textContent(), plannedBriefs);
      assert.equal(await page.locator('#evidence details').count(), 1);
      assert.ok(await page.getByText(/The autopilot executed a rebalance alone/).isVisible());
      assert.equal(await page.getByRole('link', { name: /steward/i }).count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(!calls.includes('autopilot/tick'));
      assert.deepEqual(errors, []);
    });
  }
  await check('workspace leads with tasks and retains contextual evidence', async context => {
    const { page } = await open(context, '/');
    await page.getByRole('heading', { name: 'Current status', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: /^Open (Portfolio|Payables)$/ }).count(), 0);
    await openWorkspaceNavigation(page);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Portfolio', exact: true }).click();
    await page.getByRole('link', { name: 'Inspect evidence and limitations', exact: true }).click();
    assert.ok(await page.getByRole('heading', { name: 'Portfolio: requirements and evidence', exact: true }).isVisible());
    assert.ok(await page.getByText('Known limitations', { exact: true }).isVisible());
  });
  await check('payables evidence shows only its running brief', async context => {
    const { page } = await open(context, '/a/payables/');
    await page.getByRole('link', { name: 'Inspect evidence and limitations', exact: true }).click();
    assert.doesNotMatch(await page.locator('#evidence').textContent(), plannedBriefs);
    assert.equal(await page.locator('#evidence details').count(), 1);
    assert.ok(await page.getByText(/Invoices filed at invoices.multiagency.ai, voted and paid/).isVisible());
  });
  await check('workspace status loading remains explicit', async context => {
    const { page } = await open(context, '/', { delay: 'overview' });
    await page.getByText('Checking treasury…', { exact: true }).waitFor();
    await openWorkspaceNavigation(page);
    assert.ok(await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Portfolio', exact: true }).isVisible());
  });
  await check('workspace unavailable read recovers through retry', async context => {
    const { page, state } = await open(context, '/', { error: 'overview', onlyTreasury: true });
    await page.getByText(/treasury: checks are incomplete/).waitFor();
    await openWorkspaceNavigation(page);
    assert.ok(await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Portfolio', exact: true }).isVisible());
    state.error = undefined;
    if (await page.getByRole('dialog', { name: 'Workspace navigation' }).isVisible()) await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /^(Retry|Check again)$/ }).last().click();
    await page.getByRole('heading', { name: 'Portfolio', exact: true }).waitFor();
    await page.getByText(/treasury: checks are incomplete/).waitFor({ state: 'hidden' });
  });
  await check('failed background refresh labels cached status as stale', async context => {
    const { page, state } = await open(context, '/', { onlyTreasury: true });
    const heading = page.getByRole('heading', { name: 'Portfolio', exact: true });
    await heading.waitFor();
    state.error = 'overview';
    await page.getByText(/treasury: checks are incomplete/).waitFor({ timeout: 45_000 });
    const header = heading.locator('..');
    assert.ok(await page.getByText(/cached items may be out of date/).isVisible());
    assert.equal(await header.getByText('Policy in force', { exact: true }).count(), 0);
  });
  await check('unavailable attention is never reported as an empty queue', async context => {
    const { page } = await open(context, '/a/treasury/', { error: 'unresolved' });
    await page.getByText(/Attention checks are incomplete/).waitFor();
    assert.ok(await page.getByRole('button', { name: /^(Retry|Check again)$/ }).isVisible());
    assert.equal(await page.getByText('No items need attention in the records checked.', { exact: true }).count(), 0);
  });
  for (const outcome of ['refused', 'failed', 'unknown']) {
    await check(`${outcome} run never gets green stage-completion marks`, async context => {
      const { page, calls } = await open(context, '/a/treasury/follow/run', { outcome });
      if (outcome === 'unknown') await page.getByText(/Current stage and outcome are unknown/).waitFor();
      else await page.getByRole('heading', { name: 'Recorded observations', exact: true }).waitFor();
      if (outcome === 'failed') assert.ok(await page.getByText(/0 of 1 recorded swaps succeeded/).isVisible());
      if (outcome === 'refused') assert.ok(await page.getByText(/refused:/i).isVisible());
      if (outcome !== 'unknown') {
        await page.getByText('Following later operation outcomes.', { exact: true }).waitFor();
        assert.ok(calls.includes('autopilot/log'), 'recent run reads must validate successfully, not just be ignored by the fixture');
      }
      assert.equal(await page.locator('main .bg-success-muted svg').count(), 0);
      assert.ok(!calls.includes('autopilot/tick'));
    });
  }
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exitCode = results.length > 0 && results.every(result => result.pass) ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
