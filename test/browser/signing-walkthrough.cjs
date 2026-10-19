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
  // Payables reviews now open the same agent's screens in the Payables app (released and working there): the walkthrough
  // links to them instead of embedding Proto's copies, and opening chapters sends nothing.
  for (const workflow of ['payables', 'invoices']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    const { page, calls, errors } = await open(context, `/a/payables/demos/${workflow}`);
    await page.getByRole('heading', { name: 'Do it with my agent', exact: true }).waitFor();
    const chapters = page.getByRole('radiogroup', { name: 'Live walkthrough chapters', exact: true });
    assert.equal(await chapters.getByRole('radio').count(), 4);
    for (const radio of await chapters.getByRole('radio').all()) await radio.click();
    const href = name => page.getByRole('link', { name, exact: true }).getAttribute('href');
    if (workflow === 'payables') {
      assert.equal(await href('Review policy and signing in Payables'), 'https://payables.multiagency.ai/a/payables/policy');
      assert.equal(await href('Follow owner signatures and proposals in Payables'), 'https://payables.multiagency.ai/a/payables/activity');
      await chapters.getByRole('radio').first().click();
      assert.match(await page.getByRole('link').filter({ hasText: 'in Payables' }).first().getAttribute('href'), /^https:\/\/payables\.multiagency\.ai\/a\/payables\//);
    } else {
      assert.equal(await href('Review orders and their owner actions in Payables'), 'https://payables.multiagency.ai/a/payables/payees');
      assert.equal(await href('Open orders in Payables'), 'https://payables.multiagency.ai/a/payables/payees');
    }
    assert.equal(await page.locator('summary', { hasText: 'Policy and owner signing' }).count(), 0, 'no embedded copy of the app screen');
    assert.equal(await page.locator('summary', { hasText: 'Agreements and payee authorization' }).count(), 0);
    await assertResponsive(page, `signing-${workflow}`);
    assert.ok(!calls.some(method => ['owner/prepare', 'owner/submit', 'pay', 'executePlan', 'workOrders/create'].includes(method)));
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${workflow}: chapters link to the agent's Payables screens; nothing embedded or sent`);
  }
  // On a deployment whose gateway names the Payables host (a local stack), links stay on that deployment.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const { page, errors } = await open(context, '/a/payables/demos/payables', { apps: { payables: 'payables.local.test:8443' } });
    await page.getByRole('heading', { name: 'Do it with my agent', exact: true }).waitFor();
    const protocol = await page.evaluate(() => location.protocol);
    assert.equal(await page.getByRole('link', { name: 'Review policy and signing in Payables', exact: true }).getAttribute('href'), `${protocol}//payables.local.test:8443/a/payables/policy`);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS configured Payables host: chapter links use this deployment, not the hosted domain');
  }
  for (const workflow of ['treasury']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    const { page, calls, errors } = await open(context, `/a/${workflow === 'treasury' ? 'treasury' : 'payables'}/demos/${workflow}`);
    await page.getByRole('heading', { name: 'Do it with my agent', exact: true }).waitFor();
    const chapters = page.getByRole('radiogroup', { name: 'Live walkthrough chapters', exact: true });
    assert.equal(await chapters.getByRole('radio').count(), 4);
    // Each Treasury chapter opens the same agent's screen in Treasury (A6): strategy, the guided run's steps, and owner actions.
    const expected = ['/automations', '/demo#preview', '/demo#preview', '/demo'];
    for (const [index, radio] of (await chapters.getByRole('radio').all()).entries()) {
      await radio.click();
      // Scoped to the walkthrough: the frame's setup step may also link to Treasury while no grant is reported.
      const guide = chapters.locator('xpath=ancestor::section[1]');
      assert.equal(await guide.getByRole('link').filter({ hasText: / in Treasury$/ }).first().getAttribute('href'), `https://treasury.multiagency.ai/a/treasury${expected[index]}`);
    }
    assert.equal(await page.getByRole('link', { name: 'Review policy and signing in Treasury', exact: true }).getAttribute('href'), 'https://treasury.multiagency.ai/a/treasury/policy');
    assert.equal(await page.getByRole('link', { name: 'Follow owner signatures and proposals in Treasury', exact: true }).getAttribute('href'), 'https://treasury.multiagency.ai/a/treasury/activity#owner-actions');
    assert.equal(await page.getByRole('link', { name: 'Open the guided run in Treasury', exact: true }).getAttribute('href'), 'https://treasury.multiagency.ai/a/treasury/demo');
    assert.equal(await page.locator('summary', { hasText: 'Strategy and grant signing' }).count(), 0, 'no embedded copy of the app screen');
    for (const radio of await chapters.getByRole('radio').all()) await radio.click();
    await assertResponsive(page, workflow);
    mkdirSync('/tmp/proto-signing-walkthrough', { recursive: true });
    await page.screenshot({ path: `/tmp/proto-signing-walkthrough/${workflow}.png`, fullPage: true });
    assert.ok(!calls.some(method => ['owner/prepare', 'pay', 'executePlan', 'workOrders/create'].includes(method)));
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${workflow}: four chapters link to the agent's Treasury screens; no automatic signing or execution`);
  }
}
runTask([signing]);
