/** Offline rehearsal and generated UI boundaries. All traffic is mocked; no wallet or executor. */
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');
const { assertResponsive } = require('./fixtures/layout.cjs');
const { expect } = require('@playwright/test');

async function player(browser, root) {
  const { setup, overview, budget } = workspaceEvidence({ policyDetails: true, grants: true });
  const open = workspaceOpener(root, { budget, values(kind) { return {
    setup: { ...setup, executor: false }, instance: { agentId: 'fixture', executor: false }, overview: overview(kind),
    'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], invoices: [], activity: [],
    'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true }, 'autopilot/get': { on: false }, 'workOrders/list': [],
  }; } });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const { page, calls, errors } = await open(context, '/a/payables/demos/payables/play', { clock: true, onlyPayables: true });
    await page.getByRole('region', { name: 'Interactive Payables demo' }).waitFor();
    await page.getByRole('heading', { name: 'Good work starts with an agreement.' }).waitFor();
    await page.getByText('Simulation · fictional records · no funds move', { exact: true }).waitFor();
    assert.ok(!calls.includes('demoGuide/compose'), 'entry never invokes inference');
    await assertResponsive(page, `payables-player-${width}`);
    mkdirSync('/tmp/proto-payables-player', { recursive: true });
    await page.screenshot({ path: `/tmp/proto-payables-player/watch-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Play demo', exact: true }).click();
    await page.clock.runFor(6100);
    await page.getByRole('heading', { name: 'The contributor asks to be paid.' }).waitFor();
    await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
    await page.clock.runFor(9000);
    await page.getByRole('heading', { name: 'The contributor asks to be paid.' }).waitFor();
    await page.getByRole('button', { name: 'Let me try', exact: true }).click();
    await page.getByRole('button', { name: 'Continue rehearsal', exact: true }).click();
    await page.getByRole('heading', { name: 'Now the owner decides.' }).waitFor();
    await page.getByRole('button', { name: 'Explain this signature', exact: true }).click();
    await page.getByText(/Illustrative approval summary only/).waitFor();
    await page.getByRole('button', { name: 'Back to this scene', exact: true }).click();
    await page.getByRole('button', { name: 'Simulate approval', exact: true }).click();
    await page.getByText('Approval recorded · payment not confirmed', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Explore unknown outcome', exact: true }).click();
    await page.getByText('Payment outcome unknown · new sends blocked', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue rehearsal', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Back one scene', exact: true }).click();
    await page.getByRole('button', { name: 'Continue rehearsal', exact: true }).click();
    await page.getByText('Simulated success', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Restart rehearsal', exact: true }).click();
    await page.getByRole('button', { name: 'Continue rehearsal', exact: true }).click();
    await page.getByRole('button', { name: 'Continue rehearsal', exact: true }).click();
    await page.getByRole('button', { name: 'Explore rejection', exact: true }).click();
    await page.getByText('Sample approval rejected · not paid', { exact: true }).waitFor();
    assert.equal(await page.getByText('Simulated success', { exact: true }).count(), 0);
    await page.reload();
    await page.getByRole('heading', { name: 'Good work starts with an agreement.' }).waitFor();

    let response = 'valid', generationCount = 0, release;
    await page.route('**/rpc/demoGuide/compose', async route => {
      generationCount++;
      const input = route.request().postDataJSON().json;
      assert.deepEqual(Object.keys(input).sort(), ['mode', 'question', 'role', 'stage']);
      if (response === 'delayed') await new Promise(resolve => { release = resolve; });
      if (response === 'error') return route.fulfill({ status: 503, json: { json: { defined: false, code: 'SERVICE_UNAVAILABLE', message: 'Fixture unavailable' } } });
      const event = { type: 'CUSTOM', name: 'multiagency.payables.guide', value: { version: 1, source: 'model', mode: input.mode, stage: input.stage, role: input.role,
        scene: { title: 'A tailored view of permissions', narration: 'Compare who acts with the policy they act under.', layout: 'compare', panels: ['policy', 'roles'], choices: ['policy'] } } };
      if (response === 'invalid') event.value.scene.choices = ['send_money'];
      await route.fulfill({ json: { json: event } }).catch(() => {}); // A scene change cancels an in-flight request.
    });
    await page.getByRole('button', { name: 'Explain the policy and grant side by side', exact: true }).click();
    await page.getByRole('heading', { name: 'A tailored view of permissions' }).waitFor();
    await page.getByText(/AI-composed explanation/).waitFor();
    await assertResponsive(page, `generated-payables-${width}`);
    await page.screenshot({ path: `/tmp/proto-payables-player/generated-${width}.png`, fullPage: true });
    response = 'invalid';
    await page.getByRole('button', { name: 'Ask AI guide', exact: true }).click();
    await page.getByText('Keep going with the scripted guide', { exact: true }).waitFor();
    assert.equal(await page.getByText('send_money', { exact: true }).count(), 0);
    response = 'error';
    await page.getByRole('button', { name: 'Ask AI guide', exact: true }).click();
    await page.getByText('Keep going with the scripted guide', { exact: true }).waitFor();
    response = 'delayed';
    await page.getByRole('button', { name: 'Ask AI guide', exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.getByRole('button', { name: 'Continue rehearsal', exact: true }).click();
    release(); await page.clock.runFor(100);
    await page.getByRole('heading', { name: 'The contributor asks to be paid.' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'A tailored view of permissions' }).count(), 0);

    await page.getByRole('radio', { name: 'Use my agent', exact: true }).click();
    await page.getByText('Live workspace · real funds', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Run with real funds', exact: true }).waitFor();
    assert.equal(await page.getByText('25 USDC · sample', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Simulate approval', exact: true }).count(), 0);
    await page.getByText(/This host is approve-only/).waitFor();
    await page.getByRole('radio', { name: 'Try', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'Run with real funds', exact: true }).count(), 0, 'live controls hidden in rehearsal');
    await page.getByRole('radio', { name: 'Use my agent', exact: true }).click();
    await page.getByRole('heading', { name: 'Run with real funds', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.equal(generationCount, 4);
    assert.ok(!calls.some(method => ['pay', 'owner/prepare', 'owner/submit', 'workOrders/create'].includes(method)));
    await context.close();
    console.log(`PASS ${width}px: rehearsal playback/branches, AI catalog, invalid/stale response refusal, live separation; no money writes`);
  }
}
runTask([player]);
