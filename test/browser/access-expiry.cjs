/** Authorization loss must clear only the affected private views, including during gateway refresh. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { rpcValue } = require('./fixtures/rpc.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    async function open(routePath, options = {}) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.clock.install(); page.setDefaultTimeout(5000);
      const state = { denied: false, unavailable: false, procedureDenied: false, holdProposals: false, status: 403, gatewayReads: 0, proposalDenials: 0, waiting: [], waitingProposals: [], errors: [], calls: [] };
      page.on('pageerror', error => state.errors.push(error.message));
      const gateway = () => {
        const names = state.denied ? ['healthy'] : ['payables', 'healthy'];
        return { agents: names.map(name => ({ name, owner: 'owner.near', dao: Boolean(options.dao), area: 'payables' })),
          invoices: null, viewer: { account: 'owner.near', access: Object.fromEntries(names.map(name => [name,
            { role: 'operator', canPropose: false, canVote: false }])) } };
      };
      const proposals = (suffix = '') => ['payables', 'healthy'].map((agent, index) => ({
        id: 42 + index, what: 'agent', agent, type: 'policy_update', correlationId: `${agent}-policy`,
        state: 'waiting', expiresAt: '2099-01-01T00:00:00Z', status: 'InProgress', proposer: 'owner.near', votes: {},
        hash: `${agent}-hash`, submittedAt: '2026-10-01T00:00:00Z', description: '',
        check: { kind: 'verified', standard: 'nep413', message: { payee: `${agent}-private-proposal${suffix}.near` } },
      }));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), p = url.pathname;
        if (url.hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/me') {
          state.gatewayReads++;
          if (state.denied) { state.waiting.push(route); return; }
          return route.fulfill({ json: gateway() });
        }
        if (p === '/gw/proposals') {
          if (state.holdProposals) { state.waitingProposals.push(route); return; }
          if (state.procedureDenied) {
            state.proposalDenials++;
            // Bound a broken client's self-refetch loop so a failing regression can finish.
            if (state.proposalDenials > 8) return route.abort();
            return route.fulfill({ status: 403, json: { error: 'Proposal access denied', access: 'procedure' } });
          }
          if (options.sharedDao) return route.fulfill({ json: proposals() });
          return route.fulfill({ json: [{ id: 42, what: 'unknown', status: 'InProgress', proposer: 'owner.near', votes: {}, hash: 'fixture-proposal-hash',
            submittedAt: '2026-10-01T00:00:00Z', description: 'Private proposal description' }] });
        }
        if (p.includes('/rpc/')) {
          const agent = p.split('/')[2], method = p.split('/rpc/')[1];
          state.calls.push([agent, method]);
          if (state.procedureDenied && method === 'deposit') return route.fulfill({ status: 403, json: options.encodedProcedure
            ? { json: { defined: false, code: 'FORBIDDEN', message: 'Operators only', data: { fixture: 'underlying-rpc' } } }
            : { error: 'Operators only', access: 'procedure' } });
          if (agent === 'payables' && state.denied) return route.fulfill({ status: state.status,
            json: { error: 'Access denied', access: state.status === 401 ? 'session' : 'agent' } });
          if (agent === 'payables' && state.unavailable) return route.fulfill({ status: 503,
            json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture unavailable' } } });
          const payee = agent === 'payables' ? 'private-payee.near' : 'healthy-payee.near';
          const values = {
            instance: { agentId: agent, executor: true },
            setup: { agentId: agent, executor: true, wallet: `${agent}.near`, owner: { type: 'near', account_id: 'owner.near' }, grant: null, dao: null },
            overview: { agentId: agent, area: 'payables', digest: 'fixture', notInForce: null, agreed: [payee], unmanaged: [], target: {}, rebalance: { minLegUsd: 1, maxCostBps: 100 },
              book: [], grants: [], policy: { revision: 1, status: 'APPLIED', policy: { actions: ['transfer'], assets: 'any', budget: {}, owner_approval: true, confidential: true,
                destinations: { mode: 'only', list: [{ action: 'transfer', address: payee, confidential: true }] } } } },
            'treasury/get': null, 'autopilot/get': { on: false, everyMin: 60, maxUsd: 0 },
            held: [{ correlationId: `${agent}-payment`, at: new Date().toISOString(), request: { recipient: payee, asset: 'usdc', amount: '1000000' } }],
            unresolved: [], 'inbox/list': [], 'agreements/list': [], 'owner/actions': [], 'owner/pending': [], policyHistory: [],
          };
          if (options.payment) Object.assign(values, {
            activity: [], paymentHistory: { items: [], complete: true },
            paymentStatus: { status: 'PROCESSING', request: { recipient: payee, asset: 'usdc', amount: '1000000' }, approvalId: 'fixture-approval' },
            'owner/pending': [{ correlationId: 'fixture-owner-action', hash: 'fixture-proposal-hash', state: 'waiting',
              payment: { correlationId: `${agent}-payment`, verdict: 'approve' } }],
            'owner/status': { stage: 'voting', expiresAt: '2099-01-01T00:00:00Z' },
          });
          return route.fulfill({ json: { json: rpcValue(values, method) } });
        }
        if (p.startsWith('/static/')) return route.fulfill({ path: root + p,
          contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
      });
      await page.goto('http://frontend.test' + routePath);
      return { page, state, gateway, proposals };
    }
    {
      const { page, state, gateway } = await open('/');
      await page.getByText(/private-payee.near/).waitFor();
      await page.getByText(/healthy-payee.near/).waitFor();
      const before = state.gatewayReads;
      state.denied = true;
      await page.clock.fastForward(31000); await page.clock.runFor(100);
      await page.getByText(/private-payee.near/).waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/healthy-payee.near/).isVisible(), true, 'a denied agent must not hide a healthy agent');
      await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: /payables/ }).waitFor({ state: 'hidden' });
      assert.ok(state.gatewayReads > before, 'denial rechecks cached gateway permissions');
      for (const request of state.waiting.splice(0)) await request.fulfill({ json: gateway() });
      await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: /payables/ }).waitFor({ state: 'hidden' });
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS Home clears denied-agent terms before metadata returns and keeps healthy-agent observations');
    }
    for (const status of [401, 403]) {
      const { page, state, gateway } = await open('/a/payables/policy');
      await page.getByText(/private-payee.near/).waitFor();
      state.status = status; state.denied = true;
      await page.clock.fastForward(31000); await page.clock.runFor(100);
      await page.getByText(/private-payee.near/).waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('heading', { name: 'Allowed actions', exact: true }).count(), 0);
      state.denied = false;
      for (const request of state.waiting.splice(0)) await request.fulfill({ json: gateway() });
      await page.getByRole('button', { name: 'Check access again', exact: true }).click();
      await page.getByText(/private-payee.near/).waitFor();
      assert.deepEqual(state.errors, []);
      await page.close(); console.log(`PASS agent policy hides private state during HTTP${status} permission refresh`);
    }
    {
      const { page, state } = await open('/');
      await page.getByText(/private-payee.near/).waitFor();
      await page.getByText(/healthy-payee.near/).waitFor();
      state.denied = true;
      await page.clock.fastForward(31000); await page.clock.runFor(100);
      await page.getByText(/private-payee.near/).waitFor({ state: 'hidden' });
      for (const request of state.waiting.splice(0)) await request.fulfill({ status: 503, json: { error: 'Gateway permission refresh unavailable' } });
      await page.getByText(/Workspace permissions could not be refreshed/).waitFor();
      assert.equal(await page.getByText(/healthy-payee.near/).isVisible(), true);
      assert.equal(await page.getByText(/private-payee.near/).count(), 0);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS failed permission refresh retains healthy-agent views without restoring denied records');
    }
    {
      const { page, state } = await open('/');
      await page.getByText(/private-payee.near/).waitFor();
      state.unavailable = true;
      await page.clock.fastForward(31000); await page.clock.runFor(100);
      await page.getByText(/checks are incomplete/).waitFor();
      assert.equal(await page.getByText(/private-payee.near/).isVisible(), true, 'transient outages retain explicitly stale observations');
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS transient provider failure retains labelled observations');
    }
    {
      const { page, state, proposals } = await open('/', { dao: true, sharedDao: true });
      await page.getByText('What the signature authorizes', { exact: true }).first().waitFor();
      for (const disclosure of await page.getByText('What the signature authorizes', { exact: true }).all()) await disclosure.click();
      await page.getByText(/payables-private-proposal\.near/).waitFor();
      await page.getByText(/healthy-private-proposal\.near/).waitFor();
      state.holdProposals = true;
      await page.clock.fastForward(15001); await page.clock.runFor(100);
      assert.equal(state.waitingProposals.length, 1, 'hold a proposal read that started before access changed');
      state.denied = true;
      await page.clock.fastForward(15000); await page.clock.runFor(100);
      await page.getByText(/private-payee.near/).waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/payables-private-proposal/).count(), 0, 'cached private proposal payload must disappear with the denied agent');
      assert.equal(await page.getByText(/healthy-private-proposal\.near/).isVisible(), true);
      for (const request of state.waitingProposals.splice(0)) await request.fulfill({ json: proposals('-late') });
      await page.getByText(/healthy-private-proposal-late\.near/).waitFor();
      assert.equal(await page.getByText(/payables-private-proposal/).count(), 0, 'a late successful proposal read must not restore denied payloads');
      for (const request of state.waiting.splice(0)) await request.fulfill({ status: 503, json: { error: 'Gateway permission refresh unavailable' } });
      await page.getByText(/Workspace permissions could not be refreshed/).waitFor();
      assert.equal(await page.getByText(/healthy-private-proposal-late\.near/).isVisible(), true);
      assert.equal(await page.getByText(/payables-private-proposal/).count(), 0);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS shared-DAO proposals remove only denied-agent payloads, including cached and late results');
    }
    {
      const { page, state } = await open('/', { dao: true });
      await page.getByText('Private proposal description', { exact: true }).waitFor();
      const before = state.gatewayReads;
      state.procedureDenied = true;
      await page.clock.fastForward(15001); await page.clock.runFor(500);
      await page.getByText('Proposal access denied', { exact: true }).waitFor();
      assert.equal(await page.getByText('Private proposal description', { exact: true }).count(), 0);
      assert.equal(state.proposalDenials, 1, 'a proposal denial must not retry or invalidate itself');
      assert.ok(state.gatewayReads > before, 'proposal denial refreshes role metadata');
      assert.equal(await page.getByText(/healthy-payee.near/).isVisible(), true);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS gateway procedure denial redacts cached proposals promptly without a refetch loop');
    }
    {
      const { page, state } = await open('/a/payables/follow/payment?payment=payables-payment', { dao: true, payment: true });
      await page.getByText('Payment history and public visibility', { exact: true }).click();
      await page.getByText('Proposal #42: voting, 0 votes so far.', { exact: true }).waitFor();
      state.procedureDenied = true;
      await page.clock.fastForward(10001); await page.clock.runFor(500);
      await page.getByText('Proposal access denied', { exact: true }).waitFor();
      await page.getByText(/Proposal #42/).first().waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/Proposal #42/).count(), 0);
      assert.equal(await page.getByText(/private-payee.near/).first().isVisible(), true, 'permitted payment evidence remains available');
      assert.equal(state.proposalDenials, 1);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS denied proposal records disappear from the payment timeline without hiding permitted payment evidence');
    }
    for (const encodedProcedure of [false, true]) {
      const { page, state } = await open('/a/payables/funding', { encodedProcedure });
      await page.getByRole('button', { name: 'Get a deposit address', exact: true }).waitFor();
      const before = state.gatewayReads;
      state.procedureDenied = true;
      await page.getByRole('button', { name: 'Get a deposit address', exact: true }).click();
      await page.getByText('Operators only', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Access unavailable', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Get a deposit address', exact: true }).isVisible(), true);
      if (!encodedProcedure) assert.ok(state.gatewayReads > before, 'procedure denial refreshes role metadata without removing permitted reads');
      assert.deepEqual(state.errors, []);
      await page.close(); console.log(`PASS ${encodedProcedure ? 'encoded RPC' : 'gateway procedure-only'} denial preserves authorized agent reads`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
