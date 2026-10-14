const { rpcValue } = require('./fixtures/rpc.cjs');
/** Offline browser checks: serve the built files via interception; abort every external request.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome node test/browser/simplicity.cjs [web/dist]
 */
const { chromium } = require('./fixtures/browser.cjs');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
const at = '2026-01-01T00:00:00.000Z', end = '2026-01-01T00:01:00.000Z';
const context = { id: 'tick-1', agentId: 'fixture', at, trigger: 'schedule', schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null },
  build: { deployment: null, source: 'fixture', lockfile: null, packageJson: null }, policy: { revision: 1, digest: 'fixture', status: 'APPLIED' }, strategy: 'fixture', grant: null };
const metadata = (ref, time) => ({ eventId: ref, source: 'tick', recordRef: ref, recordedAt: time, observedAt: null, timing: time ? 'recorded' : 'unknown' });
const recording = { schemaVersion: 1, aguiVersion: '1.0.2', agentId: 'fixture', tickId: 'tick-1', exportedAt: end, completion: 'recorded-end', context,
  display: { asOf: end, assets: [] }, gaps: [{ code: 'association_missing' }], events: [
    { type: 'RUN_STARTED', threadId: 'tick:fixture:tick-1', runId: 'tick-1', timestamp: Date.parse(at), metadata: metadata('start', at) },
    { type: 'CUSTOM', name: 'treasury.observation', metadata: metadata('send', null), value: { stage: 'send', index: 0, correlationId: 'op-1', status: 'SENT', failureCode: null, historySource: 'journal', history: [], untimedHistory: [] } },
    { type: 'RUN_FINISHED', threadId: 'tick:fixture:tick-1', runId: 'tick-1', timestamp: Date.parse(end), metadata: metadata('end', end), result: { outcome: 'awaiting outcome', refusal: null, rejected: [] } },
  ], laterObservations: [{ correlationId: 'op-1', source: 'journal', record: { line: 1, recordedAt: '2026-01-01T00:02:00.000Z', idempotencyKey: 'key-1', type: 'status', status: 'SUCCESS' } }] };
const strategy = { targetBps: { usdc: 10000 }, minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 10 } };
const ready = { strategy, digest: 'fixture', grantSuffix: 'fixture', executor: true, on: true, grantMatches: false, unresolved: 0, grant: null, observedAt: at,
  readiness: { state: 'authorization-required', canEnable: false, reasons: ["The owner must issue a matching grant before this strategy can act on its schedule."] } };
const setup = { executor: true, agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: { id: 'grant', label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null };
const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(p => [p, { limit_usd: '100', remaining_usd: '90', spent_usd: '10' }]));
const overview = { agentId: 'fixture', digest: 'fixture', grants: [], rebalance: { minLegUsd: 2, maxCostBps: 250 }, notInForce: null, agreed: [], unmanaged: [], target: { usdc: 1 },
  book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: '0', confidential: '10000000', usd: 10, price: 1 }],
  policy: { status: 'APPLIED', revision: 1, policy: { actions: ['swap'], frozen: false, destinations: { mode: 'only', list: [] }, assets: 'any' }, usage: { budget }, cooldowns: {} } };

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const width of [320, 390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const calls = [], errors = []; let mismatch = false, unavailable = false;
      let releaseRecording;
      let recordingGate = new Promise(resolve => { releaseRecording = resolve; });
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), p = url.pathname;
        if (url.hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', owner: 'owner.near', dao: false }], invoices: null,
          viewer: { account: 'member.near', access: { treasury: { role: 'member', canPropose: false, canVote: false } } } } });
        if (p.includes('/rpc/')) {
          const method = p.split('/rpc/')[1]; calls.push(method);
          if (method === "autopilot/log") await recordingGate;
          if (method === 'strategy/get' && unavailable) return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Readiness unavailable' } } });
          const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup, overview, 'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], activity: [], 'owner/pending': [], 'owner/actions': [],
            'autopilot/get': { on: true, everyMin: 60, maxUsd: 10 }, 'strategy/get': ready,
            'autopilot/evidence': { ticks: [{ ...context, end: { endedAt: end, before: { error: 'unavailable' }, after: { error: 'unavailable' }, plan: null, steps: [], shields: [], rejected: [], refusal: null, outcome: 'awaiting outcome' } }] },
            'autopilot/log': mismatch ? { ...recording, agentId: 'wrong' } : recording };
          assert.ok(method in values, `Unexpected request: ${method}`);
          return route.fulfill({ json: { json: rpcValue(values, method) } });
        }
        if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
      });
      await page.goto('http://frontend.test/a/treasury/follow/run');
      await page.getByRole('button', { name: 'Inspect recording', exact: true }).waitFor();
      assert.ok(!calls.includes('autopilot/log'), 'recording is fetched only on request');
      assert.equal(await page.getByRole('button', { name: 'Download recording', exact: true }).count(), 0, 'download stays inside disclosure');
      await page.getByRole('button', { name: 'Inspect recording', exact: true }).click();
      await page.getByRole('status').filter({hasText:'Loading recording…'}).waitFor();
      await page.getByRole('button', { name: 'Close recording', exact: true }).click();
      releaseRecording();
      await page.waitForTimeout(300);
      assert.equal(await page.getByRole('button', { name: 'Close recording', exact: true }).count(), 0, 'late response cannot reopen inspector');
      await page.getByRole('button', { name: 'Inspect recording', exact: true }).click();
      await page.getByRole('status').filter({hasText:'Recording loaded.'}).waitFor();
      await page.getByText('Run end recorded. Operation outcomes are shown separately.', { exact: true }).waitFor();
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download recording', exact: true }).click();
      await downloaded;
      await page.getByRole('status').filter({hasText:/Recording prepared with 1 source gap/}).waitFor();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByText('Event timing unknown', { exact: true }).waitFor();
      assert.match(await page.getByRole('status').last().innerText(), /Status at run end: SENT/);
      await page.getByText('Later journal observations (1)', { exact: true }).click();
      await page.getByText(/op-1 · SUCCESS/).waitFor();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByText('This recorded end does not prove that any operation settled.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: recording overflow`);
      await page.getByRole('button', { name: 'Close recording', exact: true }).click();
      mismatch = true;
      await page.getByRole('button', { name: 'Inspect recording', exact: true }).click();
      await page.getByRole('status').filter({ hasText: /identity mismatch|does not match/i }).waitFor();
      assert.equal(await page.getByText('Historical · read only', { exact: true }).count(), 0, 'invalid snapshot never displays prior recording');
      await page.goto('http://frontend.test/a/treasury/automations');
      await page.getByText('Needs owner authorization', { exact: true }).waitFor();
      assert.equal(await page.getByText('Ready for scheduled runs', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: readiness overflow`);
      unavailable = true;
      await page.reload();
      await page.getByText('Readiness unavailable', { exact: true }).waitFor();
      assert.equal(await page.getByText('Needs owner authorization', { exact: true }).count(), 0);
      assert.ok(!calls.some(call => /(?:^|\/)(?:tick|set|save|enable|prepare|recover)$/.test(call)), 'inspection must never mutate');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: read-only recording, source gaps, unknown timing, later outcomes, identity refusal, readiness and unavailable reads`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
