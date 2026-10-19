const assert = require('node:assert/strict');
const { runSuite } = require('./fixtures/task.cjs');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const mobile of [false, true]) {
      const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, colorScheme: mobile ? 'dark' : 'light' });
      const records = [], writes = [], errors = [];
      const label = 'A'.repeat(80);
      let loseIssue = false, loseRevoke = false, denied = false, held;
      let holdIssue = false;
      page.on('pageerror', error => errors.push(error.message));
      const gateway = { agents: [{ name: 'portfolio', owner: 'owner.near', area: 'treasury', dao: false }], viewer: { account: 'owner.near', access: { portfolio: { canManage: true } } }, invoices: null };
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), p = url.pathname;
        if (url.hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/access-session') return route.fulfill({ json: gateway });
        if (p.startsWith('/gw/machine-credentials/')) {
          const method = route.request().method();
          if (denied) return route.fulfill({ status: 401, json: { error: 'Session ended' } });
          if (method === 'GET') return route.fulfill({ json: { credentials: records } });
          writes.push(method);
          if (method === 'POST') {
            const input = route.request().postDataJSON();
            const credential = { ...input, id: `fixture-${records.length}`, version: 2, account: 'owner.near', owner: 'owner.near', agent: 'portfolio', host: 'frontend.test', createdAt: Date.now(), expiresAt: Date.now() + input.ttlSeconds * 1000, revoked: false };
            records.push(credential);
            if (holdIssue) { held = { route, credential }; return; }
            if (loseIssue) return route.abort();
            return route.fulfill({ status: 201, json: { token: 'fixture-secret-never-cache', credential } });
          }
          records.find(r => p.endsWith(r.id)).revoked = true;
          if (loseRevoke) return route.abort();
          return route.fulfill({ json: { revoked: true } });
        }
        if (p.includes('/rpc/')) throw new Error(`Access screen must not depend on observations: ${p}`);
        if (p.startsWith('/static/')) return route.fulfill({ path: path.join(root, p) });
        return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
      });
      await page.goto('https://frontend.test/a/portfolio/access');
      await page.getByText('No agent access has been issued for this Treasury.').waitFor();
      assert.equal(writes.length, 0);
      assert.equal(await page.getByRole('checkbox', { name: 'Read Treasury' }).isChecked(), true);
      assert.equal(await page.getByRole('checkbox', { name: 'Execute saved plans' }).isChecked(), false);
      assert.equal(await page.getByLabel('Access duration').inputValue(), '3600');
      await page.getByLabel('Access label').fill(label);
      await page.getByRole('button', { name: 'Review access', exact: true }).click();
      assert.equal(writes.length, 0);
      assert.match(await page.locator(':focus').innerText(), /Review access for/);
      await page.getByRole('button', { name: 'Change permissions' }).click();
      assert.equal(await page.getByLabel('Access label').evaluate(e => document.activeElement === e), true);
      await page.getByRole('checkbox', { name: 'Execute saved plans' }).check();
      await page.getByRole('button', { name: 'Review access', exact: true }).click();
      await page.getByText(/There is no separate budget/).waitFor();
      assert.equal(await page.locator('body').evaluate(e => e.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: 'Grant access', exact: true }).click();
      await page.getByLabel('Access credential').waitFor();
      assert.equal(writes.length, 1);
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw Error('denied'); } } }); });
      await page.getByRole('button', { name: 'Copy credential' }).click();
      await page.getByText('Could not copy. Select the credential and copy it manually.').waitFor();
      assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('fixture-secret')), false);
      await page.getByRole('button', { name: 'Hide credential' }).click();
      assert.equal(await page.getByLabel('Access credential').count(), 0);
      loseRevoke = true;
      await page.getByRole('button', { name: `Revoke access for ${label}`, exact: true }).click();
      assert.equal(await page.locator('body').evaluate(e => e.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: 'Confirm revocation' }).click();
      await page.getByText(/Revocation is not confirmed/).waitFor();
      await page.getByText('Revoked', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Keep access' }).click();
      loseIssue = true;
      await page.getByLabel('Access label').fill('Lost response');
      await page.getByRole('button', { name: 'Review access', exact: true }).click();
      await page.getByRole('button', { name: 'Grant access', exact: true }).click();
      await page.getByText(/Issuance outcome is unknown/).waitFor();
      assert.equal(writes.filter(x => x === 'POST').length, 2);
      assert.equal(await page.getByRole('button', { name: 'Grant access', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'I reviewed existing access' }).click();
      loseIssue = false; holdIssue = true;
      await page.getByLabel('Access label').fill(label);
      await page.getByRole('button', { name: 'Review access', exact: true }).click();
      await page.getByRole('button', { name: 'Grant access', exact: true }).click();
      await page.waitForFunction(() => document.body.innerText.includes('Granting access'));
      while (!held) await new Promise(r => setTimeout(r, 10));
      // Unmount the old context before a late issuance reply can return.
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
      await held.route.fulfill({ status: 201, json: { token: 'late-secret', credential: held.credential } }).catch(() => {});
      await page.getByText(/Private details are hidden/).waitFor();
      assert.equal(await page.getByLabel("Access credential").count(), 0);
      await page.reload();
      await page.getByRole('heading', { name: 'Existing access', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Access credential').count(), 0);
      assert.equal(await page.locator('body').evaluate(e => e.scrollWidth <= innerWidth), true);
      const targets = await page.locator('button:visible, input:not([type=checkbox]):visible, select:visible').evaluateAll(elements => elements.map(e => ({ text: e.getAttribute('aria-label') || e.textContent, height: e.getBoundingClientRect().height })));
      assert.ok(targets.every(t => t.height >= 44), JSON.stringify(targets));
      loseRevoke = false;
      await page.getByRole('button', { name: `Revoke access for ${label}`, exact: true }).click();
      await page.getByRole('button', { name: 'Confirm revocation' }).click();
      await page.getByText(`Access revoked for ${label}.`, { exact: true }).waitFor();
      assert.equal(await page.locator('body').evaluate(e => e.scrollWidth <= innerWidth), true);
      denied = true;
      await page.getByRole('button', { name: 'Refresh access' }).click();
      await page.getByText(/Private details are hidden/).waitFor();
      assert.equal(await page.getByRole('article').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Agent access: desktop/light, mobile/dark, explicit consent, focus, one-time secrets, ambiguous outcomes and late redaction passed');
  } finally { await browser.close(); }
});
