/** Continuous first-owner journey. Real UI/connector, simulated gateway/provider/chain, no live traffic. */
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');
const { runTask } = require('./fixtures/task.cjs');
const { rpcValue } = require('./fixtures/rpc.cjs');
const usdc = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const expiresAt = '2099-01-01T00:00:00Z';
const digest = 'sha256:' + 'b'.repeat(64);

async function firstOwner(browser, root) {
 for (const kind of ['wallet', 'dao']) {
  const account = `fresh-${kind}.near`, daoId = `fresh-${kind}.sputnik-dao.near`;
  const owner = kind === 'dao' ? daoId : account, ownerAccount = kind === 'dao' ? 'a'.repeat(64) : account;
  const name = `own-${kind}-journey`, base = `/a/${name}`, paymentId = `first-payment-${kind}`;
  const state = { signedIn: false, reserved: false, created: false, releaseCreate: false, grant: false, funded: false, linked: kind === 'dao', payment: null, approved: false, settled: false };
  const records = [], writes = [], walletCalls = [], errors = [], network = [];
  const sessions = new Set();
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.exposeBinding('fixtureWalletCall', async (_, method, payload) => {
    walletCalls.push({ method, payload });
    if (method === 'transaction') {
      if (payload.receiverId === 'funding.fixture') state.funded = true;
      else {
        assert.equal(kind, 'dao');
        const last = records.at(-1); assert.ok(last);
        last.stage = 'submitted';
        if (last.type !== 'agent_create') settle(last);
      }
    }
  });
  await context.addInitScript(({ account, daoId }) => {
    if (!['http://frontend.test', 'https://payables.multiagency.ai'].includes(location.origin)) return;
    for (const prefix of ['', 'member:']) localStorage.setItem(prefix + 'selected-wallet:mainnet', 'fixture-wallet');
    const register = (id, accountId) => {
      const accounts = [{ accountId, publicKey: 'ed25519:fixture' }];
      const wallet = { manifest: { id, name: id === 'trezu-wallet' ? 'Trezu' : 'Offline wallet', features: { signMessage: true, signDelegateActions: true }, permissions: {} },
        getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
        signMessage: async payload => { await window.fixtureWalletCall('message', payload); return { accountId, publicKey: 'ed25519:fixture', signature: 'offline-signature' }; },
        signDelegateActions: async payload => { await window.fixtureWalletCall('delegate', payload); return { signedDelegateActions: ['offline-delegate'] }; },
        signAndSendTransaction: async payload => { await window.fixtureWalletCall('transaction', payload); return { status: { SuccessValue: btoa('1') } }; },
      };
      window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
    };
    register('fixture-wallet', account); register('trezu-wallet', daoId);
  }, { account, daoId });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  const paymentRequest = { recipient: 'supplier.near', asset: usdc, amount: '1000000', confidential: true };
  const knownPayment = () => ({ correlationId: paymentId, approvalId: state.payment === 'PENDING_APPROVAL' || state.approved ? 'approval-fixture' : undefined, at: '2026-10-15T12:00:00Z', request: paymentRequest });
  function settle(record) {
    record.stage = 'settled'; record.ownerSucceeded = true; record.status = 'SUCCESS';
    if (record.type === 'agent_create') state.created = true;
    if (record.type === 'grant_issue') state.grant = true;
    if (record.type === 'approval_vote') state.approved = true;
  }
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (!['frontend.test', 'payables.multiagency.ai'].includes(url.hostname)) {
      if (p.endsWith('manifest.json')) return route.fulfill({ json: { wallets: [] } });
      network.push(req.url()); return route.abort();
    }
    const json = value => route.fulfill({ json: value });
    if (p === '/gw/challenge') return json({ message: 'Offline sign-in challenge', recipient: url.host, nonce: Buffer.alloc(32, 7).toString('base64') });
    if (p === '/gw/session') { const body = req.postDataJSON(); assert.equal(body.accountId, account); state.signedIn = true; sessions.add(url.host); writes.push('signin'); return json({ account }); }
    if (p === '/gw/me') return json({ walkthroughs: true, selfService: true, invoices: null,
      agents: sessions.has(url.host) && state.reserved ? [{ name, owner, dao: kind === 'dao', area: 'payables', invoices: null }] : [],
      viewer: sessions.has(url.host) ? { account, access: state.reserved ? { [name]: { canSign: kind === 'wallet', canPropose: true, canVote: true, canExecute: true, canManage: true } } : {} } : null });
    if (p === '/gw/agents') { assert.deepEqual(req.postDataJSON(), { owner, kind, area: 'payables' }); state.reserved = true; writes.push('reserve'); return json({ name }); }
    if (p === '/gw/proposals') return json([]);
    if (p.includes('/rpc/')) {
      assert.ok(p.startsWith(base + '/rpc/'), 'every RPC retains the reserved agent');
      const method = p.split('/rpc/')[1], input = req.postData() ? req.postDataJSON().json : undefined;
      const result = value => json({ json: value });
      if (state.releaseCreate && !state.created) settle(records.find(r => r.type === 'agent_create'));
      if (method === 'owner/prepare') {
        writes.push(method + ':' + input.action.type);
        const id = `${kind}-${input.action.type}`;
        assert.ok(!records.some(r => r.correlationId === id), 'never prepare a duplicate owner action');
        const record = { correlationId: id, type: input.action.type, signer: kind, stage: 'prepared', expiresAt, ownerSucceeded: false, status: null,
          ...(input.action.type === 'approval_vote' ? { payment: { correlationId: input.action.correlationId, verdict: input.action.verdict } } : {}) };
        records.push(record);
        if (input.action.type === 'agent_create') { assert.equal(input.action.role, 'payout'); assert.deepEqual(input.action.payees, ['supplier.near']); }
        if (input.action.type === 'approval_vote') assert.equal(input.action.correlationId, paymentId);
        const transaction = { receiverId: daoId, actions: [{ type: 'FunctionCall', params: { methodName: 'add_proposal', args: { fixture: id }, gas: '1', deposit: '0' } }] };
        return result(kind === 'dao' ? { correlationId: id, expiresAt, digest, dao: { proposal: transaction, proposalAndVote: transaction, transaction } }
          : { correlationId: id, expiresAt, digest, intent: { standard: input.action.type === 'agent_create' ? 'nep366' : 'nep413', payload: input.action.type === 'agent_create' ? { senderId: account, receiverId: 'outlayer.near', actions: [], nonce: '1', maxBlockHeight: '999', publicKey: 'ed25519:fixture' } : { message: id, recipient: 'outlayer.near', nonce: Buffer.alloc(32, 8).toString('base64') } } });
      }
      if (method === 'owner/submit') {
        writes.push(method + ':' + input.correlationId); const record = records.find(r => r.correlationId === input.correlationId); assert.ok(record); record.stage = 'submitted';
        if (record.type === 'agent_create') return route.abort('failed'); // Accepted, response lost; never resubmit after reload.
        settle(record); return result({ status: 'SUCCESS' });
      }
      if (method === 'owner/status') {
        const record = records.find(r => r.correlationId === input.correlationId); assert.ok(record);
        return result(record.ownerSucceeded ? { stage: 'submitted', status: 'SUCCESS' } : { stage: kind === 'dao' ? 'voting' : 'submitting' });
      }
      if (method === 'treasury/link') { assert.equal(input.accountId, account); state.linked = true; writes.push('link'); return result({}); }
      if (method === 'treasury/fund') { assert.deepEqual(input, { asset: 'USDC', amount: '2000000' }); writes.push('fund'); return result({ transaction: { receiverId: 'funding.fixture', actions: [{ type: 'Transfer', params: { deposit: '1' } }] } }); }
      if (method === 'pay') {
        assert.ok(state.created && state.grant && state.funded); assert.equal(state.payment, null, 'no duplicate payment');
        assert.deepEqual(input, { ...paymentRequest, expectedPolicy: { revision: 1, digest } });
        writes.push('pay'); state.payment = 'PROCESSING'; return route.abort('failed'); // The payment exists, but no response reaches the browser.
      }
      const setup = { agentId: state.created ? name : null, wallet: state.created ? 'agent-fixture.near' : null, owner: state.created ? { type: 'near', account_id: ownerAccount } : null, executor: true,
        grant: state.grant ? { id: 'grant-fixture', label: 'payout', expiresAt } : null,
        dao: kind === 'dao' ? { id: daoId, owner: { account_id: ownerAccount }, funded: true } : null };
      const values = { setup, instance: { agentId: setup.agentId, executor: true, area: 'payables' },
        overview: { agentId: name, area: 'payables', digest, notInForce: null, agreed: ['supplier.near'], unmanaged: [], target: {}, rebalance: { minLegUsd: 1, maxCostBps: 100 },
          grants: state.grant ? [{ grant_id: 'grant-fixture', label: 'payout', expires_at: expiresAt, issued_at: '2026-10-15T12:00:00Z', revoked_at: null }] : [],
          book: [{ asset: usdc, symbol: 'USDC', decimals: 6, public: '0', confidential: state.funded ? '2000000' : '0', usd: state.funded ? 2 : 0, price: 1 }],
          policy: { status: 'APPLIED', revision: 1, policy: { actions: ['transfer'], owner_approval: true, frozen: false, assets: 'any', budget: {}, limits: {}, destinations: { mode: 'only', list: [{ action: 'transfer', address: 'supplier.near', confidential: true }] } }, usage: { budget: {} }, cooldowns: {} } },
        'owner/actions': records, 'owner/pending': [], policyHistory: [],
        'treasury/get': state.linked ? { accountId: owner, confidential: false, balances: { near: '1', usdc: '2000000' }, dao: kind === 'dao' ? { members: [account], approvers: [{ role: 'council', threshold: '1' }] } : null } : null,
        unresolved: state.payment === 'PROCESSING' && !state.approved ? [{ key: 'first-key', correlationId: paymentId, at: '2026-10-15T12:00:00Z', kind: 'payout', sent: true, status: 'PROCESSING', request: paymentRequest }] : [],
        held: state.payment === 'PENDING_APPROVAL' && !state.approved ? [knownPayment()] : [],
        paymentHistory: { items: state.payment ? [knownPayment()] : [], complete: true },
        paymentStatus: { status: state.settled ? 'SUCCESS' : state.approved ? 'PROCESSING' : state.payment, request: paymentRequest, approvalId: state.payment === 'PENDING_APPROVAL' || state.approved ? 'approval-fixture' : null, expiresAt, createdAt: '2026-10-15T12:00:00Z' },
        activity: state.payment ? [{ kind: 'payout', correlationId: paymentId, at: '2026-10-15T12:00:00Z', request: paymentRequest, status: state.settled ? 'SUCCESS' : state.payment }] : [],
        'agreements/list': [], 'workOrders/list': [], 'inbox/list': [], invoices: [], reconcileBooks: [], ledger: [],
        'autopilot/get': { on: false, everyMin: 60, maxUsd: 1 }, 'autopilot/evidence': { ticks: [] }, 'strategy/get': null,
      };
      assert.ok(method in values, `Unexpected RPC ${method}`);
      if (method === 'paymentStatus') assert.equal(input.correlationId, paymentId);
      return result(rpcValue(values, method));
    }
    return route.fulfill({ path: p.startsWith('/static/') ? root + p : root + '/index.html' });
  });

  await page.goto('http://frontend.test/workspace');
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('heading', { name: 'Your agents', exact: true }).waitFor();
  assert.deepEqual(writes, ['signin']);
  assert.equal(walletCalls[0].payload.recipient, 'frontend.test');
  await page.getByRole('radio', { name: 'Payables', exact: true }).click();
  if (kind === 'dao') {
    await page.getByRole('radio', { name: 'DAO through Trezu', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Trezu wallet', exact: true }).click();
    await page.getByText(daoId, { exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await page.getByRole('heading', { name: 'Set up the agent', exact: true }).waitFor();
  if (kind === 'wallet' && await page.getByRole('button', { name: 'My wallet', exact: true }).count()) await page.getByRole('button', { name: 'My wallet', exact: true }).click();
  await page.getByLabel('Agreed payees (NEAR Intents accounts, separated by commas)').fill('supplier.near');
  await page.getByRole('button', { name: kind === 'dao' ? 'Propose creating the agent' : 'Create agent', exact: true }).click();
  await expect.poll(() => records[0]?.stage).toBe('submitted');
  await page.reload();
  await expect(page.getByRole('button', { name: kind === 'dao' ? 'Propose creating the agent' : 'Create agent', exact: true })).toBeDisabled();
  const signedBefore = walletCalls.length, writesBefore = writes.length;
  await page.getByRole('button', { name: 'Check setup status', exact: true }).click();
  assert.equal(walletCalls.length, signedBefore); assert.equal(writes.length, writesBefore);
  state.releaseCreate = true; // Simulated external provider/DAO observation, not a second signature.
  await page.getByRole('button', { name: 'Check setup status', exact: true }).click();
  await page.getByRole('link', { name: 'Review the Payables grant', exact: true }).click();
  await page.getByRole('button', { name: kind === 'dao' ? 'Propose a new grant' : 'Issue a new grant', exact: true }).click();
  await expect.poll(() => state.grant).toBe(true);
  await page.getByRole('link', { name: 'Continue to funding', exact: true }).click();
  if (kind === 'wallet') {
    await page.getByText('Link a treasury account', { exact: true }).click();
    await page.getByRole('button', { name: new RegExp('^Use fresh-wallet') }).click();
  }
  await page.getByLabel('Funding amount', { exact: true }).fill('2');
  if (kind === 'dao' && await page.getByRole('button', { name: 'Connect in Trezu', exact: true }).count()) await page.getByRole('button', { name: 'Connect in Trezu', exact: true }).click();
  await page.getByRole('button', { name: kind === 'dao' ? 'File funding proposal' : 'Send', exact: true }).click();
  await expect.poll(() => state.funded).toBe(true);
  await page.getByRole('link', { name: 'Demos', exact: true }).click();
  await page.getByRole('link', { name: `Start short guide for payables with ${name}`, exact: true }).click();
  await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill('supplier.near');
  await page.getByLabel('Amount', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review payment', exact: true });
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(writes.includes('pay'), false);
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  await review.getByRole('button', { name: 'Send payment', exact: true }).click();
  await expect.poll(() => state.payment).toBe('PROCESSING');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Review payment', exact: true })).toBeDisabled();
  await page.getByText('Find an existing payment', { exact: true }).click();
  await page.locator(`a[href="${base}/follow/payment?payment=${paymentId}"]`).click();
  await page.getByText(/Outcome unresolved;/).waitFor();
  assert.equal(writes.filter(x => x === 'pay').length, 1);
  state.payment = 'PENDING_APPROVAL'; // Provider evidence resolves the unknown submission to a held payout.
  await page.reload();
  await page.getByRole('button', { name: kind === 'dao' ? 'File proposal and vote' : 'Sign approval', exact: true }).click();
  await page.getByRole('button', { name: kind === 'dao' ? 'Continue to proposal' : 'Continue to wallet', exact: true }).click();
  await expect.poll(() => state.approved).toBe(true);
  assert.equal(state.settled, false, 'owner approval never settles the payment');
  state.settled = true; // Independent provider settlement observation.
  await page.reload();
  await page.getByRole('link', { name: 'Link to this payment', exact: true }).waitFor();
  await expect(page.locator('main')).toContainText('Payment completed');
  await page.getByRole('link', { name: 'Demos', exact: true }).click();
  await page.getByRole('link', { name: 'Full confidential payables walkthrough', exact: true }).click();
  await page.getByRole('link', { name: 'Open full app for Confidential payables', exact: true }).click();
  await page.getByRole('link', { name: 'Sign in to the owner demo', exact: true }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('heading', { name: 'Your agents', exact: true }).waitFor();
  assert.equal(writes.filter(x => x === 'signin').length, 2, 'full-app host requires independent sign-in');
  assert.ok(walletCalls.some(call => call.method === 'message' && call.payload.recipient === 'payables.multiagency.ai'));
  await page.getByRole('link', { name: `Open agent ${name}`, exact: true }).click();
  await page.getByRole('radio', { name: /^All records/ }).click();
  await page.locator(`a[href="${base}/follow/payment?payment=${paymentId}"]`).click();
  await expect(page.locator('main')).toContainText('Payment completed');
  assert.equal(writes.filter(x => x === 'reserve').length, 1);
  assert.equal(writes.filter(x => x === 'pay').length, 1);
  assert.equal(records.length, 3); assert.deepEqual(errors, []); assert.deepEqual(network, []);
  console.log(`PASS fresh ${kind}: sign-in, reservation, interrupted owner creation, grant, funding, interrupted payment, approval, exact settlement and full-app reopen`);
  await context.close();
 }
}
runTask([firstOwner]);
