/** Session expiry clears private presentation while retaining the original invoice submission identity. */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('./fixtures/browser.cjs');
const { html, script } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  'import { invoicePage, invoiceBrowser } from "./src/invoice-page.ts"; console.log(JSON.stringify({html:invoicePage("Invoice fixture"),script:invoiceBrowser}));'], { encoding: 'utf8' }));
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const status of [401, 403]) for (const method of ['GET', 'POST']) {
      const page = await browser.newPage(); page.setDefaultTimeout(5000); await page.clock.install();
      let expired = false;
      let nextAccount = 'payee.near', holdSubmission = false, pendingSubmission;
      const errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('invoice-draft:payee.near', JSON.stringify({ amount: '7.50', note: 'Private draft', submission: 'original-id' })));
      await page.route('**/*', async route => {
        const { hostname, pathname: p } = new URL(route.request().url());
        if (hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body:
          'export class NearConnector { async disconnect() {} async connect() {} async getConnectedWallet() { return {wallet:{signMessage:async()=>({accountId:"payee.near",publicKey:"mock",signature:"mock"})}}; }}' });
        if (hostname !== 'invoice.test') return route.abort();
        if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (p === '/invoice-browser.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (p === '/api/session') return route.fulfill({ json: { account: 'payee.near', agreed: true } });
        if (route.request().method() === 'POST') writes.push(p);
        if (p === '/api/invoices' && route.request().method() === 'POST' && holdSubmission) { pendingSubmission = route; return; }
        if (p === '/api/signout') return route.fulfill({ json: {} });
        if (p === '/api/signin/challenge') return route.fulfill({ json: { message: 'mock', recipient: 'mock', nonce: Buffer.alloc(32).toString('base64') } });
        if (p === '/api/signin') { expired = false; return route.fulfill({ json: { account: nextAccount, agreed: true } }); }
        if (p === '/api/invoices') return route.fulfill(expired ? { status, contentType: 'text/html', body: 'Sign in again' } : {
          json: { invoices: [{ id: 'private-invoice', status: 'unknown', amount: '1000000', note: 'Private invoice', filedAt: '2026-01-01T00:00:00Z' }], agreements: [], agreed: true } });
        throw new Error('Unexpected invoice request: ' + p);
      });
      await page.goto('https://invoice.test/');
      await page.getByText(/Private invoice/).waitFor();
      expired = true;
      await page.getByRole('button', { name: method === 'GET' ? 'Check invoice status again' : 'Submit invoice', exact: true }).click();
      await page.getByRole('button', { name: 'Sign in with NEAR' }).waitFor();
      assert.equal(await page.getByText(/Private invoice/).count(), 0);
      assert.equal(await page.locator('#amount').isVisible(), false);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('invoice-draft:payee.near')).submission), 'original-id');
      await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
      await page.getByRole('button', { name: 'Submit invoice', exact: true }).waitFor();
      assert.equal(await page.locator('#amount').inputValue(), '7.50');
      assert.equal(await page.locator('#note').inputValue(), 'Private draft');
      await page.getByText(/This form retains a previous submission/).waitFor();
      assert.deepEqual(writes, [...(method === 'POST' ? ['/api/invoices'] : []), '/api/signin/challenge', '/api/signin']);
      if (method === 'POST') {
        holdSubmission = true;
        const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/invoices' && request.method() === 'POST');
        await page.getByRole('button', { name: 'Submit invoice', exact: true }).click(); await started;
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        nextAccount = 'other.near';
        await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
        await page.getByText('other.near', { exact: true }).waitFor();
        await page.locator('#amount').fill('2.00'); await page.locator('#note').fill('Other private draft');
        const late = page.waitForResponse(response => new URL(response.url()).pathname === '/api/invoices' && response.request().method() === 'POST');
        await pendingSubmission.fulfill({ status, contentType: 'text/html', body: 'Old session denied' }); await late;
        await page.clock.runFor(100);
        assert.equal(await page.getByText('other.near', { exact: true }).isVisible(), true, 'a late denial cannot expire a newer account session');
        assert.equal(await page.locator('#amount').inputValue(), '2.00');
        assert.equal(await page.locator('#note').inputValue(), 'Other private draft');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('invoice-draft:payee.near')).submission), 'original-id');
      }
      assert.deepEqual(errors, []);
      await page.close(); console.log(`PASS ${method} HTTP${status} removes invoice presentation and reauthentication preserves submission identity`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
