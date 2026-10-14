/**
 * Offline showcase regressions. Build first with pnpm build:web.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome \
 *   node test/browser/showcase.cjs [build-directory]
 * All requests are intercepted. No server, wallet, or executor is started.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
        const values = { setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' ? [{ at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near' } }] : [], unresolved: options.unresolved && kind === 'payables' ? [{ at: new Date().toISOString(), key: 'fixture-unresolved' }] : [],
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
        return route.fulfill({ json: { json: values[method] } });
      }
      if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname,
        contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
    });
    await page.goto('http://frontend.test' + routePath);
    return { page, calls, errors, state };
  }

  await check('recovery: known attention survives another agent loading', async context => {
    const { page } = await open(context, '/', { delay: 'overview', onlyTreasury: true, unresolved: true });
    await page.getByText(/1 money action has no proven outcome/).waitFor({ timeout: 1800 });
  });
  await check('recovery: known attention survives a failed sibling read', async context => {
    const { page } = await open(context, '/', { error: 'overview', unresolved: true });
    await page.getByText(/1 money action has no proven outcome/).waitFor({ timeout: 5000 });
    await page.getByText(/checks.*incomplete/i).first().waitFor();
  });
  await check('claims: qualifications stay visible without aggregate guarantee scores', async context => {
    const { page, calls } = await open(context, '/', { public: true });
    await page.getByText('Requirements and stages', { exact: true }).first().click();
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
    await page.getByText(/This instance has no grant/).waitFor();
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
    await check(`public disclosure and area order at ${width}px`, async context => {
      const { page, calls, errors } = await open(context, '/', { public: true });
      await page.setViewportSize({ width, height: 900 });
      const treasury = page.getByRole('heading', { name: 'Treasury', exact: true });
      await treasury.waitFor();
      const summaries = page.getByRole('group', { name: /Evidence coverage/ });
      assert.equal(await summaries.count(), 2);
      for (const summary of await summaries.all()) {
        assert.ok(await summary.isVisible());
        assert.match(await summary.innerText(), /Mainnet · this agent/);
        assert.match(await summary.innerText(), /Mainnet · another agent/);
        assert.match(await summary.innerText(), /Offline only/);
        assert.match(await summary.innerText(), /Not yet demonstrated/);
        assert.match(await summary.innerText(), /Known limitations/);
        assert.match(await summary.innerText(), /Observations do not establish every guarantee/);
      }
      assert.doesNotMatch(await page.locator('body').innerText(), /Invoices filed at|The autopilot executed a rebalance alone|proposal #/);
      assert.doesNotMatch(await page.locator('body').textContent(), plannedBriefs);
      assert.equal(await page.getByText('Roadmap', { exact: true }).count(), 0);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `cards-${width}.png`), fullPage: true });
      if (width < 1024) assert.ok((await treasury.boundingBox()).y < (await page.getByRole('heading', { name: 'Members', exact: true }).boundingBox()).y);
      await page.getByText('Requirements and stages', { exact: true }).first().click();
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
  await check('compact cards retain evidence coverage and limitations', async context => {
    const { page } = await open(context, '/');
    await page.getByRole('link', { name: 'Open Treasury', exact: true }).waitFor();
    const summaries = page.getByRole('group', { name: /Evidence coverage/ });
    assert.equal(await summaries.count(), 2);
    for (const summary of await summaries.all()) {
      assert.ok(await summary.isVisible());
      assert.match(await summary.innerText(), /Known limitations/);
    }
    assert.equal(await page.getByText('Requirements and stages', { exact: true }).count(), 0);
  });
  await check('payables evidence shows only its running brief', async context => {
    const { page } = await open(context, '/a/payables/');
    await page.getByRole('link', { name: 'Inspect evidence and limitations', exact: true }).click();
    assert.doesNotMatch(await page.locator('#evidence').textContent(), plannedBriefs);
    assert.equal(await page.locator('#evidence details').count(), 1);
    assert.ok(await page.getByText(/Invoices filed at invoices.multiagency.ai, voted and paid/).isVisible());
  });
  await check('entry-card loading remains explicit', async context => {
    const { page } = await open(context, '/', { delay: 'overview' });
    await page.getByText('Loading treasury…', { exact: true }).waitFor();
    assert.ok(await page.getByRole('link', { name: 'Open treasury →', exact: true }).isVisible());
  });
  await check('entry-card unavailable read recovers through retry', async context => {
    const { page, state } = await open(context, '/', { error: 'overview', onlyTreasury: true });
    await page.getByText(/treasury is unavailable/).waitFor();
    assert.ok(await page.getByRole('link', { name: 'Open treasury →', exact: true }).isVisible());
    state.error = undefined;
    await page.getByRole('button', { name: /^(Retry|Check again)$/ }).last().click();
    await page.getByRole('heading', { name: 'Treasury', exact: true }).waitFor();
    assert.equal(await page.getByText(/treasury is unavailable/).count(), 0);
  });
  await check('failed background refresh labels cached status as stale', async context => {
    const { page, state } = await open(context, '/', { onlyTreasury: true });
    const heading = page.getByRole('heading', { name: 'Treasury', exact: true });
    await heading.waitFor();
    state.error = 'overview';
    await page.getByText(/Status could not be refreshed/).waitFor({ timeout: 45_000 });
    const header = heading.locator('..');
    assert.ok(await header.getByText(/Last read/).isVisible());
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
