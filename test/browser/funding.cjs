/** Offline task journeys. Run through test/browser/run.cjs to retain failure diagnostics. */
const { runTask } = require('./fixtures/task.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');
const { assertResponsive } = require('./fixtures/layout.cjs');

function fundingFixture(root) {
  const { budget, setup, overview } = workspaceEvidence({ policyDetails: true });
  return workspaceOpener(root, { budget, values(kind, options, state, run) {
    const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.payoutGrant && { grant: { ...setup.grant, label: "payout" } }), ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': options.linked ? { accountId: 'treasury.near', balances: { near: '1', usdc: '1000000' }, payees: [], dao: null, confidential: false } : null, held: options.held && !state.settled ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, approvalId: 'approval-' + correlationId, at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true } })) : [], unresolved: options.unresolved && kind === 'payables' ? [{ at: new Date().toISOString(), key: 'fixture-unresolved' }] : [],
      'inbox/list': [], 'workOrders/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: options.held ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, at: '2026-10-14T00:00:00Z' })) : [], complete: true }, paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true }, approvalId: 'approval-one', expiresAt: '2030-01-01T00:00:00Z' },
      'autopilot/get': { on: true, everyMin: 60, maxUsd: 10 },
      'autopilot/evidence': { ticks: [run] } };
    if (options.missingTerms && values.held.length) {
      values.held[0].request = {};
      values.held[1].request.asset = 'unknown-token';
    }
    if (options.unmanaged) {
      values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: '1000000', decimals: 6, usd: null }];
      values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
    }
    if (options.refusal) {
      values.pay = { outcome: 'refused', code: options.refusal };
      values.overview.digest = 'sha256:' + 'a'.repeat(64);
      values.overview.policy.status = 'APPLIED';
      values.overview.policy.policy.owner_approval = false;
      values.overview.policy.policy.destinations.list = [
        { action: 'transfer', address: 'payee.near', confidential: true },
        ...(options.topup ? [{ action: 'transfer', address: 'agent.near', confidential: true }] : []),
      ];
    }
    return values;
  } });
}

async function fundingBalances(browser, root) {
  const open = fundingFixture(root);
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const { page, calls } = await open(context, '/a/payables/funding', { payoutGrant: true });
    const sweep = page.getByRole('region', { name: 'Shield public funds' });
    await sweep.getByText('Shield public funds', { exact: true }).click();
    await sweep.getByText('Shielding requires a treasury grant. Payout and invoice grants cannot shield funds.').waitFor();
    assert.equal(await sweep.getByRole('button', { name: 'Preview', exact: true }).isDisabled(), true);
    assert.equal(await sweep.getByRole('button', { name: 'Shield', exact: true }).isDisabled(), true);
    await sweep.getByText(/Other assets are not included in this sweep/).waitFor();
    assert.ok(!calls.includes('sweep'));
    await context.close();
    console.log('PASS payout grant explains unavailable sweep and managed asset scope');
  }
  {
    const width = 390;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const { page, calls, errors } = await open(context, '/a/treasury/funding', { held: true, linked: true });
    await page.getByRole('heading', { name: 'Receive funds', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Send funds', exact: true }).waitFor();
    await page.getByText('Not established', { exact: true }).waitFor();
    const held = page.getByRole('list', { name: 'Held payout records' });
    assert.equal(await held.getByRole('link').count(), 2);
    assert.ok((await held.innerText()).includes('1 USDC'));
    assert.ok((await page.getByRole('table').innerText()).includes('10 USDC'));
    const incoming = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Receive funds', exact: true }) });
    const outgoing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Send funds', exact: true }) });
    assert.equal(await incoming.getByText('Money out: return funds to treasury.near', { exact: true }).count(), 0);
    assert.ok(await outgoing.getByText('Money out: return funds to treasury.near', { exact: true }).isVisible());
    await assertResponsive(page, 'funding directions and held balances');
    assert.ok(!calls.some(call => /^(pay|deposit|treasury\/link|owner\/prepare)$/.test(call)), 'browsing funding does not initiate actions');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/funding-${width}.png`, fullPage: true });
    await context.close();
    console.log(`PASS separated directions and reported versus held funds at ${width}px`);
  }
  {
    const context = await browser.newContext();
    const { page, state, calls } = await open(context, '/a/payables/funding', { held: true, missingTerms: true, clock: true });
    await page.getByText('Payment terms unavailable', { exact: true }).waitFor();
    await page.getByText('1000000 raw units of unknown-token to payee.near', { exact: true }).waitFor();
    state.error = 'held';
    await page.clock.fastForward(16000);
    await page.getByText('Held payout amounts are unavailable.', { exact: true }).waitFor();
    assert.equal(await page.getByText('No held payouts found in the records checked.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('list', { name: 'Held payout records' }).count(), 0, 'failed refresh must not present cached amounts as current');
    await page.getByText('Not established', { exact: true }).waitFor();
    state.error = 'overview';
    await page.clock.fastForward(31000);
    await page.clock.runFor(10000);
    await page.getByText(/Last reported balances; the latest refresh failed/).waitFor();
    await page.getByText('Not established', { exact: true }).waitFor();
    await context.close();
    assert.ok(!calls.includes('pay'));
    console.log('PASS missing terms, unknown assets and failed refresh do not invent available funds');
  }
  {
    const context = await browser.newContext();
    const { page, calls } = await open(context, '/a/payables/funding', { error: 'treasury/get' });
    await page.getByText('Linked account could not be checked.', { exact: true }).waitFor();
    await page.getByText('Not established', { exact: true }).waitFor();
    assert.equal(await page.getByText('Link a treasury account', { exact: true }).count(), 0);
    assert.ok(calls.includes('treasury/get'), 'the unavailable linked-account read must be reached');
    assert.ok(!calls.includes('pay'));
    await context.close();
    console.log('PASS unavailable linked account never implies an absent account or available funds');
  }
  {
    const context = await browser.newContext();
    const { page } = await open(context, '/a/payables/funding', { unresolved: true });
    await page.getByRole('link', { name: 'Review unresolved operations', exact: true }).waitFor();
    await page.getByText('No held payouts found in the records checked.', { exact: true }).waitFor();
    await page.getByText('Not established', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Get a deposit address', exact: true }).waitFor();
    await context.close();
    console.log('PASS empty held records do not prove spendability');
  }
}

async function fundingPresentation(browser, root) {
  const results = [];
  const filter = process.env.CASE_FILTER;
  async function check(name, work) {
    if (filter && !name.includes(filter)) return;
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    try { await work(context); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
    finally { await context.close(); }
  }
  const open = fundingFixture(root);
  const width = 390;
  await check(`funding starts with a deposit at ${width}px`, async context => {
    const { page, calls } = await open(context, '/a/treasury/funding');
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Get a deposit address', exact: true }).waitFor();
    assert.ok(!await page.getByRole('textbox', { name: 'Treasury NEAR account' }).isVisible());
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `funding-${width}.png`), fullPage: true });
    const disclosure = page.getByText('Link a treasury account', { exact: true });
    await disclosure.focus(); await page.keyboard.press('Enter');
    assert.ok(await page.getByRole('textbox', { name: 'Treasury NEAR account' }).isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(!calls.includes('treasury/link'));
  });
  for (const excluded of [false, true]) {
    await check(`unmanaged asset: ${excluded ? 'excluded' : 'allowed'} by policy`, async context => {
      const { page, calls } = await open(context, '/a/treasury/', { unmanaged: true, excluded });
      await page.getByRole('heading', { name: 'Portfolio · Overview', exact: true }).waitFor();
      assert.equal(await page.getByText(/No treasury linked/).count(), 0, 'optional linking is not an Overview blocker');
      const row = page.getByRole('listitem').filter({ hasText: 'The agent holds 1 OTHER,' });
      await row.waitFor();
      if (excluded) {
        const action = row.getByRole('link', { name: /Review policy assets/ });
        assert.ok((await action.getAttribute('href')).endsWith('/policy'));
      } else {
        assert.equal(await row.getByRole('link').count(), 0);
        assert.equal(await row.getByText('Review policy assets').count(), 0);
        assert.ok(await row.getByText(/outside the assets its strategies manage/).isVisible());
      }
      assert.ok(!calls.some(call => /prepare|execute|update/.test(call)));
    });
  }
  for (const refusal of ['grant_missing', 'duplicate_held_payout']) {
    await check(`payment refusal ${refusal} links to its next task`, async context => {
      const { page, calls, requests } = await open(context, '/a/treasury/funding', { refusal });
      await page.getByText('Send money to a payee', { exact: true }).click();
      const recipient = page.getByLabel('Recipient’s NEAR account', { exact: true });
      await recipient.waitFor();
      if (refusal === 'grant_missing') {
        assert.equal(await page.locator('select[name=asset]').count(), 0, 'one available asset needs no selector');
        assert.equal(await page.getByRole('button', { name: 'payee.near', exact: true }).count(), 0, 'one recipient picker');
        assert.equal(await page.locator('datalist option[value="payee.near"]').count(), 1);
      }
      await recipient.fill('payee.near');
      await page.getByLabel('Amount', { exact: true }).fill('1');
      await page.getByRole('button', { name: 'Review payment', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
      const next = page.getByRole('link', { name: refusal === 'grant_missing' ? 'Review the grant' : 'Review the existing held payout', exact: true });
      await next.waitFor();
      assert.equal(await next.getAttribute('href'), refusal === 'grant_missing' ? '/a/treasury/policy#grants' : '/a/treasury/');
      await page.getByText('Refusal code', { exact: true }).focus();
      await page.keyboard.press('Space');
      await page.getByText(refusal, { exact: true }).waitFor();
      assert.equal(calls.filter(call => call === 'pay').length, 1);
      assert.deepEqual(requests.filter(request => request.endsWith('/rpc/pay')), ['/a/treasury/rpc/pay']);
    });
  }
  await check('top-up refusal points to its treasury grant', async context => {
    const { page, requests } = await open(context, '/a/payables/', { refusal: 'grant_missing', topup: true });
    await page.getByText('Funding and budget details', { exact: true }).click();
    await page.getByLabel('USDC to send', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Top up from the treasury', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
    const next = page.getByRole('link', { name: 'Review the grant', exact: true });
    await next.waitFor();
    assert.equal(await next.getAttribute('href'), '/a/treasury/policy#grants');
    assert.deepEqual(requests.filter(request => request.endsWith('/rpc/pay')), ['/a/treasury/rpc/pay']);
  });
  console.log(JSON.stringify(results, null, 2));
  if (!results.length || results.some(result => !result.pass)) process.exitCode = 1;
}

runTask([fundingBalances, fundingPresentation]);
