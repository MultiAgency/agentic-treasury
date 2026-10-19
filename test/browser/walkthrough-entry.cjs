/** New hosted entry with offline wallet boundaries. No real signatures or executor starts. */
const assert = require('node:assert/strict');
const { runTask } = require('./fixtures/task.cjs');
const { expect } = require('@playwright/test');
const { assertResponsive } = require('./fixtures/layout.cjs');

async function entry(browser, root) {
  {
    const width = 390;
    for (const kind of ['wallet', 'dao']) for (const area of ['payables', 'treasury']) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(() => {
        if (location.origin !== 'http://frontend.test') return;
        const accounts = [{ accountId: 'team.sputnik-dao.near', publicKey: 'ed25519:fixture' }];
        const wallet = { manifest: { id: 'trezu-wallet', name: 'Trezu', features: {}, permissions: {} },
          getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {} };
        window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
      });
      const page = await context.newPage(); page.setDefaultTimeout(6000);
      let saved; const writes = [], errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        const p = url.pathname;
        if (url.hostname !== 'frontend.test') {
          if (p.endsWith('manifest.json')) return route.fulfill({ json: { wallets: [] } });
          return route.abort();
        }
        if (p === '/gw/me') return route.fulfill({ json: { walkthroughs: true, selfService: true, invoices: 'https://other-agent.example',
          agents: saved ? [{ name: 'own-fixture', owner: saved.owner, area: saved.area, dao: saved.kind === 'dao', invoices: null }] : [],
          viewer: { account: 'alice.near', access: saved ? { 'own-fixture': { canSign: kind === 'wallet', canPropose: kind === 'dao', canVote: kind === 'dao', canExecute: true, canManage: true } } : {} } } });
        if (p === '/gw/agents') { saved = route.request().postDataJSON(); writes.push(saved); return route.fulfill({ json: { name: 'own-fixture' } }); }
        if (p.includes('/rpc/')) {
          const method = p.split('/rpc/')[1];
          const values = { setup: { agentId: null, wallet: null, owner: null, grant: null, executor: true,
            dao: kind === 'dao' ? { id: saved.owner, owner: { account_id: 'mpc.near' }, funded: true } : null }, 'owner/actions': [] };
          assert.ok(method in values, `Unexpected RPC ${method}`);
          return route.fulfill({ json: { json: values[method] } });
        }
        return route.fulfill({ path: p.startsWith('/static/') ? root + p : root + '/index.html' });
      });
      await page.goto('http://frontend.test/');
      await page.getByRole('heading', { name: 'Your agents', exact: true }).waitFor();
      assert.deepEqual(writes, []);
      assert.equal(await page.getByRole('navigation', { name: 'Workspace', exact: true }).count(), 1, 'the same signed-in frame as a launcher-only host');
      await page.getByRole('radio', { name: area === 'payables' ? 'Payables' : 'Portfolio', exact: true }).click();
      if (kind === 'dao') {
        await page.getByRole('radio', { name: 'DAO through Trezu', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Continue setup', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Connect Trezu wallet', exact: true }).click();
        await page.getByText('team.sputnik-dao.near', { exact: true }).waitFor();
      }
      await assertResponsive(page, `setup choice ${kind} ${width}`);
      if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: `/tmp/walkthrough-entry-${kind}-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
      await page.getByRole('heading', { name: 'Set up the agent', exact: true }).waitFor();
      assert.deepEqual(saved, { owner: kind === 'wallet' ? 'alice.near' : 'team.sputnik-dao.near', kind, area });
      assert.equal(writes.length, 1, 'only a reservation, never an owner signature or payment');
      await page.getByText(/Selected owner:/).waitFor();
      await assertResponsive(page, `reserved setup ${kind} ${width}`);
      assert.equal(new URL(page.url()).pathname, '/a/own-fixture/', 'the reservation opens the agent page, where onboarding continues');
      await page.reload();
      await page.getByRole('heading', { name: 'Set up the agent', exact: true }).waitFor();
      assert.equal(writes.length, 1);
      await page.goto('http://frontend.test/');
      await page.getByRole('heading', { name: 'Your agents', exact: true }).waitFor();
      const app = area === 'treasury' ? 'Treasury' : 'Payables';
      await expect(page.getByRole('link', { name: `Open in ${app} for own-fixture`, exact: true })).toHaveAttribute('href', `https://${area}.multiagency.ai/a/own-fixture/`);
      await expect(page.getByRole('link', { name: 'Walkthroughs for own-fixture', exact: true })).toHaveAttribute('href', '/a/own-fixture/');
      assert.equal(writes.length, 1, 'returning home never provisions or submits');
      await page.getByRole('link', { name: 'Walkthroughs for own-fixture', exact: true }).click();
      await page.getByRole('heading', { name: 'Set up the agent', exact: true }).waitFor();
      assert.equal(writes.length, 1, 'opening a saved agent resumes without another reservation');
      await page.goto('http://frontend.test/demos');
      await page.getByRole('heading', { name: 'Demos and validation', exact: true }).waitFor();
      const titles = { treasury: 'Treasury', payables: 'Confidential payables', invoices: 'Purchase orders and invoices' };
      // Each workflow names its data source and limitation, and its recorded simulations come from Proto's own evidence.
      assert.equal(await page.getByText('Live', { exact: true }).count(), 3);
      assert.equal(await page.getByText('Limitation:', { exact: true }).count(), 3);
      await page.getByRole('heading', { name: 'Variation: Recurring builder agreement', exact: true }).waitFor();
      assert.ok(await page.getByText('Recorded simulation', { exact: true }).count() >= 3);
      assert.match(await page.locator('body').innerText(), /Recorded 2026-10-18 \d\d:\d\d UTC/);
      assert.doesNotMatch(await page.locator('body').innerText(), /\/Users\//);
      for (const workflow of ['treasury', 'payables', 'invoices']) {
        const available = workflow === 'treasury' ? area === 'treasury' : area === 'payables';
        const shortLink = page.getByRole('link', { name: `Start short guide for ${workflow} with own-fixture`, exact: true });
        assert.equal(await shortLink.count(), available ? 1 : 0);
        if (available) await expect(shortLink).toHaveAttribute('href', `/a/own-fixture/demos/${workflow}`);
        await page.getByRole('link', { name: `Full ${titles[workflow].toLowerCase()} walkthrough`, exact: true }).click();
        await page.getByRole('heading', { name: `${titles[workflow]} walkthrough`, exact: true }).waitFor();
        assert.equal(new URL(page.url()).pathname, `/${workflow}`);
        const fullLink = page.getByRole('link', { name: `Open complete walkthrough for ${workflow} with own-fixture`, exact: true });
        assert.equal(await fullLink.count(), available ? 1 : 0);
        if (available) await expect(fullLink).toHaveAttribute('href', `/a/own-fixture/walkthrough/${workflow}`);
        await page.reload();
        await page.getByRole('heading', { name: `${titles[workflow]} walkthrough`, exact: true }).waitFor();
        await page.getByRole('link', { name: 'Back to demos', exact: true }).click();
        await page.getByRole('heading', { name: 'Demos and validation', exact: true }).waitFor();
      }
      assert.equal(writes.length, 1, 'all short and complete entry routes are read-only');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${kind} ${width}px: ${area} selection, reservation, bound onboarding, no money submission and read-only reload`);
    }
  }
}
runTask([entry]);
