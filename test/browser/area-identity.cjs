const { rpcValue } = require('./fixtures/rpc.cjs');
const { openWorkspaceNavigation } = require("./fixtures/navigation.cjs");
/** Offline regression: disabling swaps must not change a configured agent's area. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const area of ['treasury', 'payables']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      page.setDefaultTimeout(5000);
      const errors = [], calls = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED')) errors.push(message.text()); });
      await page.route('**/*', async route => {
        const { hostname, pathname } = new URL(route.request().url());
        if (hostname !== 'frontend.test') return route.abort();
        if (pathname === '/gw/me') return route.fulfill({ json: {
          agents: [{ name: 'custom-agent', area, owner: 'owner.near', dao: false }], invoices: null,
          viewer: { account: 'owner.near', access: { 'custom-agent': { role: 'member', canPropose: false, canVote: false } } },
        } });
        if (pathname.includes('/rpc/')) {
          const method = pathname.split('/rpc/')[1]; calls.push(method);
          const values = {
            instance: { agentId: 'fixture', executor: false },
            setup: { agentId: 'fixture', executor: false, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: null, dao: null },
            overview: { area, agentId: 'fixture', digest: 'fixture', notInForce: null, agreed: [], unmanaged: [], book: [], target: {},
              rebalance: { minLegUsd: 1, maxCostBps: 100 }, policy: { policy: { actions: ['transfer'], frozen: false, assets: 'any', destinations: { mode: 'only', list: [] } }, usage: { budget: {} }, cooldowns: {} } },
            'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], activity: [],
            'owner/actions': [], 'owner/pending': [], paymentHistory: { items: [], complete: true },
            'autopilot/get': { on: false, everyMin: 60, maxUsd: 0 }, 'autopilot/evidence': { ticks: [], corrupt: [] },
          };
          assert.ok(method in values, `Unexpected RPC: ${method}`);
          return route.fulfill({ json: { json: rpcValue(values, method) } });
        }
        if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname,
          contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
      });
      await page.goto('http://frontend.test/a/custom-agent/');
      const label = area === 'treasury' ? 'Portfolio' : 'Payables';
      await page.getByRole('heading', { name: `${label} · ${area === 'treasury' ? 'Overview' : 'Payments'}`, exact: true }).waitFor().catch(async error => {
        console.error('Page errors:', errors, 'Page:', await page.locator('body').innerText(), 'Reads:', calls); throw error;
      });
      await openWorkspaceNavigation(page);
      await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: label, exact: true }).waitFor();
      if (area === 'treasury') {
        await openWorkspaceNavigation(page);
        await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Runs', exact: true }).click();
        await page.getByRole('heading', { name: 'Portfolio · Runs', exact: true }).waitFor();
        await page.reload();
        await page.getByRole('heading', { name: 'Portfolio · Runs', exact: true }).waitFor();
      }
      assert.deepEqual(errors, []);
      assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover)$/.test(call)));
      await page.close();
      console.log(`PASS configured ${area}: stable navigation without swap permission, no writes`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
