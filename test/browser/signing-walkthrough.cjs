/** Offline wallet/DAO signing through walkthrough controls. No live network or signatures. */
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { expect } = require('@playwright/test');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');
const { assertResponsive } = require('./fixtures/layout.cjs');

async function signing(browser, root) {
  const { setup, overview, budget } = workspaceEvidence({ policyDetails: true, grants: true });
  const open = workspaceOpener(root, { budget, values(kind, options) { return {
    setup: { ...setup, executor: true, grant: null, dao: options.dao ? { id: 'fixture.dao', owner: { account_id: 'owner.near' } } : null },
    instance: { agentId: 'fixture', executor: true }, overview: overview(kind), 'treasury/get': null,
    held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], invoices: [], activity: [],
    'owner/pending': [], 'owner/actions': [], policyHistory: [], paymentHistory: { items: [], complete: true },
    'autopilot/get': { on: false }, 'strategy/get': null, 'workOrders/list': [],
  }; } });
  for (const dao of [false, true]) {
    const context = await browser.newContext({ viewport: { width: dao ? 1280 : 390, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      if (location.hostname !== "frontend.test") return;
      window.fixtureSignatures = [];
      for (const prefix of ['', 'member:']) localStorage.setItem(prefix + 'selected-wallet:mainnet', 'fixture-wallet');
      const accounts = [{ accountId: 'owner.near', publicKey: 'ed25519:fixture' }];
      const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true, signDelegateActions: true }, permissions: {} },
        getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
        signMessage: async payload => { window.fixtureSignatures.push(payload); return { accountId: 'owner.near', publicKey: 'ed25519:fixture', signature: 'offline-signature' }; },
        signAndSendTransaction: async payload => { window.fixtureSignatures.push(payload); return { status: { SuccessValue: '' } }; } };
      window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
    });
    const { page, calls, errors } = await open(context, '/a/payables/demos/payables', { dao });
    const writes = [];
    await page.route('**/rpc/owner/prepare', async route => {
      const input = route.request().postDataJSON().json;
      writes.push({ method: 'prepare', input });
      assert.deepEqual(input, { signer: dao ? 'dao' : 'wallet', action: { type: 'grant_issue' } });
      const prepared = { correlationId: 'walkthrough-grant', expiresAt: '2030-01-01T00:00:00Z', digest: null };
      if (dao) prepared.dao = { proposal: { receiverId: 'fixture.dao', actions: [] }, proposalAndVote: { receiverId: 'fixture.dao', actions: [] } };
      else prepared.intent = { standard: 'nep413', payload: { message: 'exact fixture grant', recipient: 'offline', nonce: Buffer.alloc(32).toString('base64') } };
      await route.fulfill({ json: { json: prepared } });
    });
    await page.route('**/rpc/owner/submit', async route => {
      writes.push({ method: 'submit', input: route.request().postDataJSON().json });
      await route.fulfill({ json: { json: { status: 'SUCCESS' } } });
    });
    await page.route('**/rpc/owner/status**', route => route.fulfill({ json: { json: { stage: 'submitted', status: 'SUCCESS' } } }));
    await page.getByRole('heading', { name: 'Do it with my agent', exact: true }).waitFor();
    const chapters = page.getByRole('radiogroup', { name: 'Live walkthrough chapters', exact: true });
    for (const radio of await chapters.getByRole('radio').all()) await radio.click();
    assert.equal(writes.length, 0);
    assert.deepEqual(await page.evaluate(() => window.fixtureSignatures), []);
    await page.getByRole('button', { name: 'Review policy and signing controls', exact: true }).click();
    await page.getByRole('heading', { name: 'Grants', exact: true }).waitFor();
    const policy = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Policy and owner signing' }) }).first();
    await policy.getByRole('button', { name: 'Edit', exact: true }).click();
    const draft = policy.getByRole('textbox').first();
    if (await draft.count()) await draft.fill('12');
    await chapters.getByRole('radio').first().click();
    if (await draft.count()) await expect(draft).toHaveValue('12');
    assert.equal(writes.length, 0, 'chapter changes and opening reviews never prepare owner actions');
    await page.getByRole('button', { name: dao ? 'Propose a new grant' : 'Issue a new grant', exact: true }).click();
    await expect.poll(() => writes.filter(write => write.method === 'prepare').length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.fixtureSignatures.length)).toBe(1);
    if (!dao) {
      await expect.poll(() => writes.filter(write => write.method === 'submit').length).toBe(1);
      assert.equal(writes[1].input.correlationId, 'walkthrough-grant');
      assert.equal((await page.evaluate(() => window.fixtureSignatures))[0].message, 'exact fixture grant');
    } else assert.equal(writes.filter(write => write.method === 'submit').length, 0, 'DAO proposal is followed, not replaced by a member owner signature');
    await assertResponsive(page, `signing-${dao ? 'dao' : 'wallet'}`);
    assert.ok(!calls.some(method => ['pay', 'executePlan', 'workOrders/create'].includes(method)));
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${dao ? 'DAO' : 'wallet'}: chapter navigation preserves review; explicit grant action uses existing exact signing flow`);
  }
  for (const workflow of ['treasury', 'invoices']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    const { page, calls, errors } = await open(context, `/a/${workflow === 'treasury' ? 'treasury' : 'payables'}/demos/${workflow}`);
    await page.getByRole('heading', { name: 'Do it with my agent', exact: true }).waitFor();
    const chapters = page.getByRole('radiogroup', { name: 'Live walkthrough chapters', exact: true });
    assert.equal(await chapters.getByRole('radio').count(), 4);
    if (workflow === 'treasury') {
      await page.getByRole('button', { name: 'Review strategy and grant here', exact: true }).click();
      await page.getByText('Strategy and grant signing', { exact: true }).waitFor();
    } else {
      assert.equal(await page.getByRole('button', { name: 'Follow owner signatures and proposals', exact: true }).count(), 0, 'order signatures must not open parent history');
      await page.getByRole('button', { name: 'Review the selected order’s owner actions', exact: true }).click();
      await page.getByText('Create a work order', { exact: true }).click();
      await page.getByRole('textbox', { name: 'Agreed work', exact: true }).fill('Retain this order draft');
    }
    for (const radio of await chapters.getByRole('radio').all()) await radio.click();
    if (workflow === 'invoices') await expect(page.getByRole('textbox', { name: 'Agreed work', exact: true })).toHaveValue('Retain this order draft');
    await assertResponsive(page, workflow);
    mkdirSync('/tmp/proto-signing-walkthrough', { recursive: true });
    await page.screenshot({ path: `/tmp/proto-signing-walkthrough/${workflow}.png`, fullPage: true });
    assert.ok(!calls.some(method => ['owner/prepare', 'pay', 'executePlan', 'workOrders/create'].includes(method)));
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${workflow}: four chapters, persistent controls, no automatic signing or execution`);
  }
}
runTask([signing]);
