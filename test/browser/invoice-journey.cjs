/** Synthetic payee journey. All requests, including wallet-module imports, are intercepted. */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('./fixtures/browser.cjs');
const { html, script } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  'import { invoicePage, invoiceBrowser } from "./src/invoice-page.ts"; console.log(JSON.stringify({html:invoicePage("Payee journey"),script:invoiceBrowser}));'], { encoding: 'utf8' }));
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(8000);
      let agreements = [], invoices = [], agreed = false, unavailable = false;
      const writes = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), p = url.pathname;
        if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body: `export class NearConnector {
          async connect() {} async disconnect() {} async getConnectedWallet() { return { wallet: { signMessage: async () => ({ accountId: 'synthetic-payee.near', publicKey: 'fixture', signature: 'fixture' }) } }; }
        }` });
        if (url.hostname !== 'invoice.test') return route.abort();
        if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (p === '/invoice-browser.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (p === '/api/session') return route.fulfill({ json: { account: null, agreed: false } });
        if (route.request().method() === 'POST') writes.push({ path: p, body: route.request().postDataJSON() });
        if (p === '/api/signin/challenge') return route.fulfill({ json: { nonce: 'AAAA', message: 'Offline sign-in', recipient: 'invoice.test' } });
        if (p === '/api/signin') return route.fulfill({ json: { account: 'synthetic-payee.near', agreed } });
        if (p === '/api/invoices' && route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          if (!agreed) {
            agreements = [{ id: 'agreement', origin: 'payee', status: 'requested', amount: '1250000', note: body.note, submission: body.submission, at: new Date().toISOString() }];
            return route.fulfill({ json: { status: 'requested' } });
          }
          invoices = [{ id: 'invoice', status: 'waiting', amount: '1250000', note: body.note, filedAt: new Date().toISOString() }];
          agreements = [];
          return route.fulfill({ json: { status: 'waiting' } });
        }
        if (p === '/api/invoices') return route.fulfill(unavailable ? { status: 503, json: {} } : { json: { agreements, invoices, agreed } });
        throw new Error('Unexpected fixture request: ' + p);
      });
      await page.goto('https://invoice.test/');
      await page.getByRole('button', { name: 'Sign in with NEAR' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Send request', exact: true }).waitFor();
      await page.getByLabel('Amount (USDC)').fill('1.25');
      await page.getByLabel("What's it for? (optional)").fill('Synthetic work');
      await page.getByRole('button', { name: 'Send request', exact: true }).click();
      await page.getByText(/Waiting for the DAO to agree/).waitFor();
      const original = writes.find(w => w.path === '/api/invoices').body.submission;
      const refresh = () => page.getByRole('button', { name: 'Check invoice status again' }).click();
      agreements[0].status = 'proposed'; await refresh();
      await page.getByText(/DAO still needs to approve the policy/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'File this invoice' }).count(), 0);
      agreements[0].status = 'agreed'; agreed = true; await refresh();
      await page.getByRole('button', { name: 'File this invoice' }).click();
      await page.getByText(/Waiting for approval/).waitFor();
      assert.equal(writes.filter(w => w.path === '/api/invoices')[1].body.submission, original);
      for (const [status, text] of [['paying', /Settlement is not yet confirmed/], ['unknown', /do not create a replacement invoice/], ['refused', /nothing was sent for this invoice/], ['paid', /^Paid\.$/]]) {
        invoices[0].status = status; await refresh(); await page.getByText(text).waitFor();
      }
      unavailable = true; await refresh(); await page.getByText(/Invoice status could not be checked/).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(writes.map(w => w.path), ['/api/signin/challenge', '/api/signin', '/api/invoices', '/api/invoices']);
      console.log(`PASS payee journey ${width}: synthetic sign-in, request, owner decision observations, stable invoice identity, held payout, processing, unresolved, refusal, paid, unavailable read`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
