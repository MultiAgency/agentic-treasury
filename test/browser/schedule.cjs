/** Offline browser checks: serve the built files via interception; abort every external request.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome node test/browser/schedule.cjs [web/dist]
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
        const values = { setup: { ...setup, executor: !options.approveOnly, grant: options.noGrant ? null : setup.grant,
          dao: options.dao ? { id: 'fixture.dao', owner: { account_id: 'owner.near' } } : null },
          overview: options.payables ? { ...overview, policy: { ...overview.policy, policy: { ...overview.policy.policy, actions: ['transfer'] } } } : overview,
          'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], activity: [], 'owner/pending': [], 'owner/actions': ownerActions,
          'autopilot/get': current, 'strategy/get': { ...ready, digest, executor: !options.approveOnly, on: current.on, strategy: saved, grantMatches: options.approveOnly ? null : authorized,
            readiness: { state: options.approveOnly ? 'approve-only' : authorized ? 'off' : 'authorization-required', canEnable: !options.approveOnly && authorized,
              reasons: options.approveOnly ? ['Check authorization on the executor.'] : authorized ? [] : ready.readiness.reasons } } };
        assert.ok(method in values, `Unexpected request: ${method}`);
        return route.fulfill({ json: { json: values[method] } });
      }
      if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
    });
    try {
      await page.goto('http://frontend.test/a/treasury/automations');
      await page.getByRole('heading', { name: 'Automations', exact: true }).waitFor();
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
  for (const dao of [false, true]) await check(`${dao ? 'DAO' : 'wallet'} renews a live matching grant without changing strategy`, { dao, on: true }, async ({ page, writes, state }) => {
    const renew = page.getByRole('button', { name: 'Review grant renewal', exact: true });
    await renew.waitFor();
    assert.equal(await renew.isDisabled(), true, 'renewal still requires schedule off');
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await renew.click();
    await page.getByRole('heading', { name: 'Renew the grant for this saved strategy', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
    assert.deepEqual(writes.map(w => w.method), ['autopilot/stop'], 'review and cancel do not issue a grant');
    await renew.click();
    await page.getByRole('button', { name: dao ? 'Propose grant renewal' : 'Renew in wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Turn on', exact: true }).waitFor();
    assert.equal(state().on, false, 'renewal never enables the schedule');
    assert.deepEqual(writes.filter(w => w.method === 'owner/prepare').map(w => w.body.action), [
      { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: 'sha256:' + 'a'.repeat(64) },
    ]);
    assert.ok(writes.every(w => ['autopilot/stop', 'owner/prepare', 'owner/submit'].includes(w.method)), 'no strategy save, revoke, or enable');
  });
  await check('confirmation freezes the reviewed digest through polling', { clock: true }, async ({ page, change, writes }) => {
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    const reviewedText = await page.getByRole('dialog').locator('p').first().innerText();
    // Another operator saved a new strategy and its owner authorized it before this poll.
    change(); await pollStrategy(page);
    const modal = page.getByRole('dialog');
    assert.equal(await modal.getByRole('button', { name: 'Turn on', exact: true }).isDisabled(), true);
    await modal.getByRole('alert').waitFor();
    assert.equal(await modal.locator('p').first().innerText(), reviewedText);
    assert.equal(writes.length, 0);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on', exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(writes.find(w => w.method === 'autopilot/enable').body.expectedDigest, 'sha256:' + 'c'.repeat(64));
  });
  await check('confirmation stays invalid after unavailable readiness recovers', { clock: true }, async ({ page, unavailable, writes }) => {
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    unavailable(true); await pollStrategy(page);
    const modal = page.getByRole('dialog');
    assert.equal(await modal.getByRole('button', { name: 'Turn on', exact: true }).isDisabled(), true);
    unavailable(false); await pollStrategy(page);
    assert.equal(await modal.getByRole('button', { name: 'Turn on', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(writes.length, 0);
    assert.equal(await page.getByRole('button', { name: 'Turn on', exact: true }).evaluate(e => e === document.activeElement), true);
  });
  await check('confirmation retains unchanged review after polling', { clock: true }, async ({ page, writes }) => {
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    await pollStrategy(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on', exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(writes.find(w => w.method === 'autopilot/enable').body.expectedDigest, 'sha256:' + 'a'.repeat(64));
  });
  const edit = async page => { await page.getByRole('button', { name: 'Edit strategy', exact: true }).click(); };
  const save = async page => {
    await page.getByRole('button', { name: 'Review change', exact: true }).click();
    await page.getByRole('button', { name: 'Save with autopilot off', exact: true }).click();
  };
  for (const dao of [false, true]) await check(`${dao ? 'DAO' : 'wallet'} full allocation-save-authorize-enable`, { dao, width: dao ? 1280 : 320 }, async ({ page, writes, state }) => {
    await edit(page);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Edit strategy');
    await page.getByLabel('USDC (%)', { exact: true }).fill('60');
    await page.getByLabel('wNEAR (%)', { exact: true }).fill('20');
    await page.getByLabel('ETH (%)', { exact: true }).fill('20');
    await page.getByLabel('Run every (minutes)', { exact: true }).fill('120');
    await save(page);
    await page.getByRole('button', { name: 'Review authorization', exact: true }).click();
    assert.equal(state().on, false);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Authorize this saved strategy');
    await page.evaluate(() => window.scrollTo(0, 0));
    if (process.env.BROWSER_ARTIFACTS) await page.screenshot({ path: process.env.BROWSER_ARTIFACTS + '/' + (dao ? 'dao' : 'wallet') + '-strategy-review.png', fullPage: true });
    await page.getByRole('button', { name: dao ? 'Propose strategy authorization' : 'Authorize in wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Turn on', exact: true }).waitFor();
    assert.equal(state().on, false, 'grant completion does not enable');
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    assert.equal(state().on, false, 'dialog is not enablement');
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on', exact: true }).click();
    await page.getByText('Schedule on', { exact: true }).waitFor();
    assert.equal(state().everyMin, 120);
    assert.deepEqual(writes.find(w => w.method === 'strategy/save').body.strategy.targetBps, { usdc: 6000, near: 2000, eth: 2000 });
    assert.equal(writes.filter(w => w.method === 'autopilot/enable').length, 1);
    assert.equal(writes.filter(w => w.method === 'owner/prepare').length, 1);
  });
  await check('stop refreshes strategy and schedule without unrelated provider reads', { on: true, clock: true }, async ({ page, calls }) => {
    await page.getByText('Ready for scheduled runs', { exact: true }).waitFor();
    const before = calls.length;
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await page.getByText('Schedule off', { exact: true }).waitFor();
    const refreshed = calls.slice(before);
    assert.ok(refreshed.includes('strategy/get'));
    assert.ok(refreshed.includes('autopilot/get'));
    assert.deepEqual(refreshed.filter(method => !['autopilot/stop', 'strategy/get', 'autopilot/get'].includes(method)), []);
  });
  await check('save active schedule turns it off', { on: true }, async ({ page, state }) => {
    await edit(page); await page.getByLabel('Run every (minutes)', { exact: true }).fill('120'); await save(page);
    await page.getByText('Schedule off', { exact: true }).waitFor(); assert.equal(state().on, false);
  });
  await check('invalid allocation and failed save preserve draft', { saveFails: true }, async ({ page, recover }) => {
    await edit(page); await page.getByLabel('USDC (%)', { exact: true }).fill('99');
    await page.getByRole('button', { name: 'Review change', exact: true }).click();
    await page.getByText('Target allocations must add up to 100%.', { exact: true }).first().waitFor();
    await page.getByLabel('USDC (%)', { exact: true }).fill('50');
    await page.getByLabel('Run every (minutes)', { exact: true }).fill('120'); await save(page);
    await page.getByText('Save unavailable; draft retained', { exact: true }).waitFor(); recover();
    await page.getByRole('button', { name: 'Back to edit', exact: true }).click();
    assert.equal(await page.getByLabel('Run every (minutes)', { exact: true }).inputValue(), '120');
  });
  await check('keyboard cancel protects a dirty draft and restores focus', {}, async ({ page }) => {
    await edit(page); await page.getByLabel('Run every (minutes)', { exact: true }).fill('120');
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    page.once('dialog', d => d.dismiss()); await cancel.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.getByLabel('Run every (minutes)', { exact: true }).inputValue(), '120');
    page.once('dialog', d => d.accept()); await cancel.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Edit strategy', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Edit strategy');
  });
  await check('stale save requires comparison and renewed review', {}, async ({ page, change, writes }) => {
    await edit(page); await page.getByLabel('Run every (minutes)', { exact: true }).fill('120'); change(); await save(page);
    await page.getByRole('button', { name: 'Review against latest strategy', exact: true }).click();
    assert.equal(await page.getByLabel('Run every (minutes)', { exact: true }).inputValue(), '120');
    await save(page); await page.getByText('Needs owner authorization', { exact: true }).waitFor();
    assert.equal(writes.filter(w => w.method === 'strategy/save').at(-1).body.expectedDigest, 'sha256:' + 'c'.repeat(64));
  });
  await check('failed wallet authorization stays recoverable after reload', { authorized: false, signFail: true }, async ({ page, writes }) => {
    await page.getByRole('button', { name: 'Review authorization', exact: true }).click();
    await page.getByRole('button', { name: 'Authorize in wallet', exact: true }).click();
    await page.getByText('Wallet declined fixture', { exact: true }).waitFor();
    await page.reload(); await page.getByRole('link', { name: 'Review owner action', exact: true }).waitFor();
    assert.equal(writes.filter(w => w.method === 'owner/prepare').length, 1);
    assert.equal(writes.filter(w => w.method === 'autopilot/enable').length, 0);
  });
  await check('confirmation checks current authorization again', {}, async ({ page, writes, revoke }) => {
    await page.getByRole('button', { name: 'Turn on', exact: true }).click(); revoke();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on', exact: true }).click();
    await page.getByText('Strategy authorization changed', { exact: true }).waitFor();
    assert.equal(writes.filter(w => w.method === 'autopilot/enable').length, 1);
  });
  await check('stop ignores invalid draft and missing grant', { on: true, noGrant: true }, async ({ page, writes, state }) => {
    await edit(page); await page.getByLabel('Run every (minutes)', { exact: true }).fill('0');
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await page.getByText('Schedule off', { exact: true }).waitFor();
    assert.equal(state().everyMin, 60); assert.equal(writes.at(-1).method, 'autopilot/stop');
  });
  await check('stop remains available with unavailable readiness', { on: true, unavailable: true }, async ({ page, state }) => {
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await page.getByText('Schedule off', { exact: true }).waitFor(); assert.equal(state().on, false);
  });
  for (const source of ['strategy', 'schedule']) await check(`failed ${source} refresh replaces cached readiness and recovers`, { on: true, clock: true }, async ({ page, unavailable, writes }) => {
    await page.getByText('Ready for scheduled runs', { exact: true }).waitFor();
    const route = '**/rpc/autopilot/get';
    const fail = request => request.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Schedule unavailable' } } });
    if (source === 'strategy') unavailable(true);
    else await page.route(route, fail);
    await pollStrategy(page);
    await page.getByText(source === 'strategy' ? 'Readiness unavailable' : 'Schedule unavailable', { exact: true }).waitFor();
    assert.equal(await page.getByText('Ready for scheduled runs', { exact: true }).count(), 0);
    await page.getByText('Readiness unknown', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Turn off', exact: true }).isEnabled(), true);
    if (source === 'strategy') unavailable(false);
    else await page.unroute(route, fail);
    await pollStrategy(page);
    await page.getByText('Ready for scheduled runs', { exact: true }).waitFor();
    assert.deepEqual(writes, [], 'refresh and recovery do not change executor settings');
  });
  for (const options of [{ member: true }, { approveOnly: true }]) await check('read-only controls ' + JSON.stringify(options), options, async ({ page }) => {
    await page.getByText('Treasury strategy', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Edit strategy', exact: true }).count(), 0);
    const enable = page.getByRole('button', { name: 'Turn on', exact: true });
    assert.ok(await enable.count() === 0 || await enable.isDisabled());
  });
  await check('Payables has no Treasury strategy workflow', { payables: true }, async ({ page, calls }) => {
    await page.getByRole('button', { name: /Preview/i }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Turn on', exact: true }).count(), 0);
    assert.equal(calls.includes('strategy/get'), false);
  });
  await check('Payables retains stop for an existing schedule', { payables: true, on: true }, async ({ page, state }) => {
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await page.getByText('Schedule off. Operations already submitted may still finish.', { exact: true }).waitFor();
    assert.equal(state().on, false);
  });
  await browser.close(); if (!executed || failures) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
