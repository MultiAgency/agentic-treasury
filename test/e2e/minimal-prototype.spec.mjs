import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';
import { writeFileSync } from 'node:fs';
import { recordConformance } from './conformance.mjs';

// The example prototype is served as the showcase host's own build; every call goes through the real
// gateway and agent server. Wallet signatures are real NEP-413 from the unfunded fixture key; the provider is simulated.
test('a new prototype signs in through the gateway, reads its scoped agent and takes one owner-signed action', async ({ browser }, info) => {
  const stack = await environment(info.outputPath('environment'), { frontendDist: join(import.meta.dirname, '../../examples/minimal-prototype') });
  const owner = await browserContext(browser, stack, OWNER), payee = await browserContext(browser, stack, PAYEE);
  try {
    const page = await owner.context.newPage(), conformance = recordConformance(page);
    await conformance.ready;
    await page.goto(`${stack.dashboard}/a/payout/`);
    await expect(page).toHaveTitle('Minimal prototype');
    await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
    const chooser = page.getByText('Local test wallet', { exact: true });
    await Promise.race([chooser.waitFor().then(() => chooser.click()).catch(() => {}), page.getByText(`Signed in as ${OWNER}.`).waitFor()]);
    await expect(page.getByText(`Signed in as ${OWNER}.`)).toBeVisible();
    await expect(page.locator('#agent')).toHaveText('Active.');

    const signedBefore = owner.signatures.length;
    await page.getByRole('button', { name: 'Pause agent' }).click();
    await expect(page.getByRole('status')).toHaveText('Signed and recorded.');
    await expect(page.locator('#agent')).toHaveText('Paused by its owner.');
    expect(owner.signatures.length).toBe(signedBefore + 1);
    await page.getByRole('button', { name: 'Resume agent' }).click();
    await expect(page.getByRole('status')).toHaveText('Signed and recorded.');
    await expect(page.locator('#agent')).toHaveText('Active.');
    expect(owner.signatures.length).toBe(signedBefore + 2);
    const controls = stack.simulated.intents.filter(i => i.control);
    expect(controls.map(i => [i.control, i.submitted])).toEqual([['agent_freeze', true], ['agent_unfreeze', true]]);
    expect(stack.simulated.requests.filter(r => r.path === '/v1/submit-intent')).toHaveLength(2);

    // The same host refuses scoped reads and actions without this owner's session.
    const other = await payee.context.newPage();
    await other.goto(`${stack.dashboard}/a/payout/`);
    const refused = await other.evaluate(async () => Promise.all(['overview', 'owner/prepare'].map(async procedure =>
      (await fetch(`/a/payout/rpc/${procedure}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: { action: { type: 'agent_freeze' }, signer: 'wallet' } }) })).status)));
    expect(refused).toEqual([401, 401]);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(owner.unexpected).toEqual([]); expect(payee.unexpected).toEqual([]);
    await conformance.settle();
    writeFileSync(info.outputPath('conformance.json'), JSON.stringify(conformance.results, null, 2));
    writeFileSync(info.outputPath('conformance-aborted.json'), JSON.stringify(conformance.aborted, null, 2));
    expect(conformance.results.filter(r => !r.ok)).toEqual([]);
  } finally {
    await owner.context.close(); await payee.context.close();
    await stack.close();
    expect(stack.simulated.errors).toEqual([]);
  }
});
