const { rpcValue } = require('./fixtures/rpc.cjs');
/** Offline setup and return visits. Requests are fixtures; no wallet or executor starts. */
const assert = require('node:assert/strict');
const { chromium } = require('./fixtures/browser.cjs');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
(async () => {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
 try {
  for (const width of [390, 1280]) for (const scenario of ['new', 'creation-submitted', 'creation-succeeded', 'records-error', 'return-payables', 'return-treasury', 'return-policy', 'return-proposal', 'return-complete']) {
   const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(6000);
   const returning = scenario.startsWith('return-'), treasury = scenario === 'return-treasury', calls = [], errors = [];
   let grantReported = false;
   page.on('pageerror', e => errors.push(e.message));
   await page.route('**/*', async route => {
    const { hostname, pathname: p } = new URL(route.request().url());
    if (hostname !== 'frontend.test') return route.abort();
    if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'fixture', area: treasury ? 'treasury' : 'payables', owner: 'owner.near', dao: true }], viewer: { account: 'owner.near', access: { fixture: { role: 'operator', canPropose: true, canVote: true } } } } });
    if (p.includes('/rpc/')) {
     const method = p.split('/rpc/')[1]; calls.push(method);
     if (scenario === 'records-error' && method === 'owner/actions') return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Setup records unavailable' } } });
     const values = {
      instance: { agentId: returning ? 'fixture' : null, area: treasury ? 'treasury' : 'payables', executor: true },
      setup: { agentId: returning ? 'fixture' : null, executor: true, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: grantReported ? { id: 'reported', label: 'payout', expiresAt: '2099-01-01T00:00:00Z' } : null, dao: { id: 'owner.sputnik-dao.near', funded: true, owner: { account_id: 'owner.near' } } },
      overview: { agentId: 'fixture', area: treasury ? 'treasury' : 'payables', digest: 'fixture', notInForce: scenario === 'return-policy' ? 'revision 1 is not yet synchronized with the provider' : null, agreed: [], book: [], unmanaged: [], target: {}, grants: [], rebalance: { minLegUsd: 1, maxCostBps: 100 }, policy: { status: 'APPLIED', revision: 1, policy: { actions: treasury ? ['swap'] : ['transfer'], assets: 'any', budget: {}, limits: {}, frozen: false, owner_approval: true, destinations: { mode: 'only', list: [] } }, usage: { budget: {} }, cooldowns: {} } },
      'owner/actions': ['creation-submitted', 'creation-succeeded', 'return-proposal', 'return-complete'].includes(scenario) ? [{ correlationId: 'existing-setup', type: returning ? 'grant_issue' : 'agent_create', signer: 'dao', stage: scenario === 'creation-succeeded' ? 'settled' : 'submitted', ownerSucceeded: scenario === 'creation-succeeded', status: scenario === 'creation-succeeded' ? 'SUCCESS' : null }] : [],
      'owner/pending': [], 'treasury/get': null, policyHistory: [], unresolved: [], held: [], activity: [], 'inbox/list': [],
     };
     assert.ok(method in values, `Unexpected RPC ${method}`); return route.fulfill({ json: { json: rpcValue(values, method) } });
    }
    return route.fulfill({ path: p.startsWith('/static/') ? root + p : root + '/index.html' });
   });
   await page.goto('http://frontend.test/a/fixture/policy');
   if (returning) {
    await page.getByRole('heading', { name: 'Continue setup', exact: true }).waitFor();
    if (scenario === 'return-proposal' || scenario === 'return-complete') {
     await page.getByText('existing-setup', { exact: true }).waitFor();
     if (scenario === 'return-complete') {
      grantReported = true;
      await page.getByRole('button', { name: 'Check setup status', exact: true }).click();
      const next = page.getByRole('link', { name: 'Continue to Payments', exact: true });
      await next.waitFor(); assert.match(await next.getAttribute('href'), /\/a\/fixture\/?$/);
      await page.getByText(/Each action still requires its own authorization and balance checks/).waitFor();
     }
    }
    else {
     const next = page.getByRole('heading', { name: 'Continue setup', exact: true }).locator('..').locator('..').locator('..');
     const link = next.getByRole('link', { name: scenario === 'return-treasury' ? 'Review and authorize the Portfolio strategy' : scenario === 'return-policy' ? 'Review policy and permissions' : 'Review the Payables grant', exact: true });
     await link.waitFor(); assert.match(await link.getAttribute('href'), scenario === 'return-treasury' ? /automations$/ : scenario === 'return-policy' ? /policy$/ : /policy#grants$/);
    }
   } else {
    await page.getByRole('heading', { name: 'Existing setup actions', exact: true }).waitFor();
    const create = page.getByRole('button', { name: 'Propose creating the agent', exact: true });
    await create.waitFor();
    if (scenario === 'new') await page.getByText(/No matching setup actions recorded on this instance/).waitFor();
    else if (scenario === 'records-error') await page.getByText(/Setup actions could not be loaded/).waitFor();
    else await page.getByText('existing-setup', { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), scenario !== 'new');
    await page.getByRole('button', { name: 'Check setup status', exact: true }).click();
   }
   assert.deepEqual(errors, []); assert.ok(!calls.some(m => /prepare|submit|^pay$|stop|tick/.test(m)));
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
   console.log(`PASS onboarding ${width}px: ${scenario}`); await page.close();
  }
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
