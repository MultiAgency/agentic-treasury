const { rpcValue } = require('./fixtures/rpc.cjs');
/** Offline browser checks: serve the built files via interception; abort every external request.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome node test/browser/schedule.cjs [web/dist]
 */
const { chromium } = require('./fixtures/browser.cjs');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
const at = '2026-01-01T00:00:00.000Z';
const strategy = { targetBps: { usdc: 5000, near: 2500, eth: 2500 }, minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 10 } };
const ready = { strategy, digest: 'fixture', grantSuffix: 'fixture', executor: true, on: true, grantMatches: false, unresolved: 0, grant: null, observedAt: at,
  readiness: { state: 'authorization-required', canEnable: false, reasons: ["The owner must issue a matching grant before this strategy can act on its schedule."] } };
const setup = { executor: true, agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: { id: 'grant', label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null };
const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(p => [p, { limit_usd: '100', remaining_usd: '90', spent_usd: '10' }]));
const overview = { agentId: 'fixture', digest: 'fixture', grants: [], rebalance: { minLegUsd: 2, maxCostBps: 250 }, notInForce: null, agreed: [], unmanaged: [], target: { usdc: 1 },
  book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: '0', confidential: '10000000', usd: 10, price: 1 }, { asset: 'near', symbol: 'wNEAR', decimals: 24, public: '0', confidential: '0', usd: 0, price: 1 }, { asset: 'eth', symbol: 'ETH', decimals: 18, public: '0', confidential: '0', usd: 0, price: 1 }],
  policy: { status: 'APPLIED', revision: 1, policy: { actions: ['swap'], frozen: false, destinations: { mode: 'only', list: [] }, assets: 'any' }, usage: { budget }, cooldowns: {} } };


(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  let failures = 0;
  let executed = 0;
  async function check(name, options, test) {
    if (process.env.TEST_CASE && !name.includes(process.env.TEST_CASE)) return;
    executed++;
    const page = await browser.newPage({ viewport: { width: options.width || 390, height: 900 }, reducedMotion: 'reduce' });
    if (options.clock) await page.clock.install();
    page.setDefaultTimeout(8000);
    // Use the connector's supported injected-wallet interface; no product test hooks or real signatures.
    await page.addInitScript(signFail => {
      for (const prefix of ['', 'member:']) localStorage.setItem(prefix + 'selected-wallet:mainnet', 'fixture-wallet');
      const accounts = [{ accountId: 'owner.near', publicKey: 'ed25519:fixture' }];
      const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true, signDelegateActions: true }, permissions: {} },
        getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
        signMessage: async () => { if (signFail) throw new Error('Wallet declined fixture'); return { accountId: 'owner.near', publicKey: 'ed25519:fixture', signature: 'offline-signature' }; },
        signAndSendTransaction: async () => ({ status: { SuccessValue: '' } }) };
      window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
    }, !!options.signFail);
    const calls = [], writes = [], errors = [];
    let current = { on: options.on ?? false, everyMin: 60, maxUsd: 10 };
    let saved = structuredClone(strategy), digest = 'sha256:' + 'a'.repeat(64);
    let authorized = options.authorized ?? true, ownerActions = [], saveFails = !!options.saveFails, unavailable = !!options.unavailable;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.hostname !== 'frontend.test') return route.abort();
      if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', owner: 'owner.near', dao: !!options.dao }], invoices: null,
        viewer: { account: 'owner.near', access: { treasury: { role: options.member ? 'member' : 'operator', canPropose: true, canVote: true } } } } });
      if (p.includes('/rpc/')) {
        const method = p.split('/rpc/')[1]; calls.push(method);
        const body = route.request().postDataJSON()?.json;
        const fail = message => route.fulfill({ status: 409, json: { json: { defined: false, code: 'CONFLICT', message } } });
        if (['strategy/save','autopilot/enable','autopilot/stop','owner/prepare','owner/submit'].includes(method)) writes.push({ method, body });
        if (method === 'strategy/save') {
          if (saveFails) return fail('Save unavailable; draft retained');
          if (body.expectedDigest !== digest) return fail('The saved strategy changed');
          saved = body.strategy; current = { ...saved.autopilot, on: false }; authorized = false; digest = 'sha256:' + 'b'.repeat(64);
          return route.fulfill({ json: { json: { strategy: saved, digest, on: false } } });
        }
        if (method === 'autopilot/enable') {
          if (!authorized || body.expectedDigest !== digest) return fail('Strategy authorization changed');
          current.on = true; return route.fulfill({ json: { json: { strategy: saved, digest, on: true } } });
        }
        if (method === 'autopilot/stop') { current.on = false; return route.fulfill({ json: { json: { on: false } } }); }
        if (method === 'owner/prepare') {
          assert.equal(body.action.expectedStrategyDigest, digest);
          assert.equal(current.on, false, 'authorization starts only while off');
          ownerActions = [{ correlationId: 'grant-action', type: 'grant_issue', signer: options.dao ? 'dao' : 'wallet', stage: 'prepared', expiresAt: '2030-01-01T00:00:00Z', ownerSucceeded: false }];
          const prepared = { correlationId: 'grant-action', expiresAt: '2030-01-01T00:00:00Z', digest: null };
          if (options.dao) prepared.dao = { proposalAndVote: { receiverId: 'fixture.dao', actions: [] }, proposal: { receiverId: 'fixture.dao', actions: [] } };
          else prepared.intent = { standard: 'nep413', payload: { message: 'fixture strategy grant', recipient: 'offline', nonce: Buffer.alloc(32).toString('base64') } };
          return route.fulfill({ json: { json: prepared } });
        }
        if (method === 'owner/submit' || method === 'owner/status') {
          authorized = true; ownerActions = [{ ...ownerActions[0], stage: 'settled', ownerSucceeded: true, status: 'SUCCESS' }];
          return route.fulfill({ json: { json: method === 'owner/status' ? { stage: 'submitted', status: 'SUCCESS' } : { status: 'SUCCESS' } } });
        }
        if (method === 'strategy/get' && unavailable) return fail('Readiness unavailable');
        const values = { instance: { agentId: 'fixture', executor: !options.approveOnly }, setup: { ...setup, executor: !options.approveOnly, grant: options.noGrant ? null : setup.grant,
          dao: options.dao ? { id: 'fixture.dao', owner: { account_id: 'owner.near' } } : null },
          overview: options.payables ? { ...overview, policy: { ...overview.policy, policy: { ...overview.policy.policy, actions: ['transfer'] } } } : overview,
          'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], activity: [], 'owner/pending': [], 'owner/actions': ownerActions,
          'autopilot/get': current, 'strategy/get': { ...ready, digest, executor: !options.approveOnly, on: current.on, strategy: saved, grantMatches: options.approveOnly ? null : authorized,
            readiness: { state: options.approveOnly ? 'approve-only' : authorized ? 'off' : 'authorization-required', canEnable: !options.approveOnly && authorized,
              reasons: options.approveOnly ? ['Check authorization on the executor.'] : authorized ? [] : ready.readiness.reasons } } };
        assert.ok(method in values, `Unexpected request: ${method}`);
        return route.fulfill({ json: { json: rpcValue(values, method) } });
      }
      if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
    });
    try {
      await page.goto('http://frontend.test/a/treasury/automations');
      await page.getByRole('heading', { name: options.payables ? 'Shield public funds' : 'Strategy', exact: true }).waitFor();
      await test({ page, calls, writes, state: () => current, revoke: () => { authorized = false; }, change: () => { digest = 'sha256:' + 'c'.repeat(64); saved = { ...saved, minLegUsd: 4, autopilot: { everyMin: 120, maxUsd: 20 } }; current = { ...current, everyMin: 120, maxUsd: 20 }; }, unavailable: value => { unavailable = value; }, recover: () => { saveFails = false; } });
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      console.log('PASS ' + name);
    } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
    finally { await page.close(); }
  }
  async function pollStrategy(page) {
    const response = page.waitForResponse(r => r.url().includes('/rpc/strategy/get'));
    await page.clock.fastForward(31000);
    await response;
    await page.clock.runFor(1000);
  }
  await check('active strategy distinguishes saved settings from an unsaved draft', { on: true, width: 320 }, async ({ page, writes }) => {
    const progress = page.getByRole('list', { name: 'Strategy setup' });
    await progress.getByText('Authorized for the saved strategy', { exact: true }).waitFor();
    await progress.getByText('On · ready for scheduled runs', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit strategy', exact: true }).click();
    await progress.getByText('Unsaved draft', { exact: true }).waitFor();
    await page.getByText(/Your draft does not change the saved strategy/).waitFor();
    assert.equal(writes.length, 0, 'editing is not saving or stopping');
    assert.ok(await page.getByRole('button', { name: 'Turn off', exact: true }).isVisible());
    await page.screenshot({ path: '/tmp/strategy-clarity-320.png', fullPage: true });
  });
  await check('authorization is separate from an off schedule', { on: false, authorized: false, width: 1280 }, async ({ page, writes }) => {
    const progress = page.getByRole('list', { name: 'Strategy setup' });
    await progress.getByText('Matching grant needed', { exact: true }).waitFor();
    await progress.getByText('Off · no scheduled runs', { exact: true }).waitFor();
    await page.getByText('Review authorization for the saved strategy. Authorizing does not turn on the schedule.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Review authorization', exact: true }).click();
    assert.equal(writes.length, 0, 'review alone does not authorize');
    await page.getByRole('button', { name: 'Authorize in wallet', exact: true }).click();
    await progress.getByText('Authorized for the saved strategy', { exact: true }).waitFor();
    await progress.getByText('Off · no scheduled runs', { exact: true }).waitFor();
    assert.ok(!writes.some(w => w.method === 'autopilot/enable'));
    await page.screenshot({ path: '/tmp/strategy-clarity-1280.png', fullPage: true });
  });
  await browser.close();
  assert.ok(executed > 0);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
