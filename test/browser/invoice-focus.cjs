/** Full invoice page and browser module, with all network and wallet interactions mocked. */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('./fixtures/browser.cjs');
// Import the real page renderer. No HTTP listener, executor, or source-text extraction.
const { html, script } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  'import { invoicePage, invoiceBrowser } from "./src/invoice-page.ts"; console.log(JSON.stringify({html:invoicePage("Invoice fixture"),script:invoiceBrowser}));'], { encoding: 'utf8' }));
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    await page.clock.install();
    const errors = [], submissions = [];
    page.on('pageerror', error => errors.push(error.message));
    let records = [{ id: 'fixture', status: 'unknown', amount: '1000000', filedAt: '2026-01-01T00:00:00Z' }];
    let agreements = [], agreed = false, unavailable = false, defer = false;
    const queued = [];
    const response = (status = 'paid') => ({ invoices: [{ ...records[0], id: 'fixture', status, amount: '1000000', filedAt: '2026-01-01T00:00:00Z' }], agreements: [], agreed: true });
    let sessionReads = 0;
    let pendingSubmission, holdSubmission = false;
    await page.addInitScript(() => localStorage.setItem('invoice-draft:payee.near', JSON.stringify({ amount: '7.50', note: 'Saved work', submission: 'original-id' })));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body: 'export class NearConnector { async disconnect() {} async connect() {} async getConnectedWallet() { return {wallet:{signMessage:async()=>({accountId:"bob.near",publicKey:"mock",signature:"mock"})}}; }}' });
      if (url.hostname !== 'invoice.test') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname === '/invoice-browser.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/api/signout') return route.fulfill({ json: {} });
      if (url.pathname === '/api/signin/challenge') return route.fulfill({ json: { message: 'mock', recipient: 'mock', nonce: Buffer.alloc(32).toString('base64') } });
      if (url.pathname === '/api/signin') return route.fulfill({ json: { account: 'bob.near', agreed: true } });
      if (url.pathname === '/api/session') { sessionReads++; return route.fulfill({ json: { account: 'payee.near', agreed } }); }
      if (url.pathname === '/api/invoices' && route.request().method() === 'POST') {
        submissions.push(route.request().postDataJSON());
        if (holdSubmission) { pendingSubmission = route; return; }
        return route.fulfill({ json: { status: 'failed' } });
      }
      if (url.pathname === '/api/invoices') {
        if (defer) { queued.push(route); return; }
        if (unavailable) return route.fulfill({ status: 503, json: {} });
        return route.fulfill({ json: { invoices: records, agreements, agreed } });
      }
      throw new Error('Unexpected invoice request: ' + url.pathname);
    });
    await page.goto('https://invoice.test/');
    const refresh = () => page.evaluate(() => document.getElementById('refresh').onclick());
    await page.getByText(/Last checked/).waitFor();
    await page.getByRole('button', { name: 'Send request', exact: true }).waitFor();
    agreed = true; await refresh();
    await page.getByRole('button', { name: 'Submit invoice', exact: true }).waitFor();
    assert.equal(await page.locator('#amount').inputValue(), '7.50');
    assert.equal(await page.locator('#note').inputValue(), 'Saved work');
    assert.equal(sessionReads, 1);
    // Provider failure retains the submission identity across a deliberate second click.
    await page.locator('#submit').click();
    await page.getByText(/This alone does not establish/).waitFor();
    await page.waitForFunction(() => !document.getElementById('submit').disabled);
    await page.locator('#submit').click();
    await page.waitForFunction(() => !document.getElementById('submit').disabled);
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions.map(item => item.submission), ['original-id', 'original-id']);
    assert.equal(await page.locator('#amount').inputValue(), '7.50');
    const copy = page.getByRole('button', { name: 'Copy review reference' });
    await copy.focus();
    await page.evaluate(() => { window.focused = document.activeElement; });
    await refresh();
    assert.equal(await page.evaluate(() => focused === document.activeElement), true);
    records[0] = { ...records[0], status: 'needs_review', note: 'Updated evidence' }; await refresh();
    assert.equal(await page.evaluate(() => focused === document.activeElement), true);
    assert.match(await page.locator('#invoices').innerText(), /Updated evidence/);
    records[0].status = 'paid'; await refresh();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'refresh');
    assert.equal(await copy.count(), 0);
    records = []; await refresh();
    assert.equal(await page.locator('#invoices li').count(), 0);
    agreements = [{ id: 'agreement', status: 'agreed', origin: 'owner', amount: '1000000', terms: { maxAmount: '2000000', until: '2030-01-01T00:00:00Z' }, note: 'First', at: '2026-01-01T00:00:00Z' }];
    await refresh();
    await page.getByRole('button', { name: 'Use these terms' }).focus();
    await page.evaluate(() => { window.agreementButton = document.activeElement; });
    agreements[0].note = 'Updated'; await refresh();
    assert.equal(await page.evaluate(() => agreementButton === document.activeElement), true);
    await page.getByRole('button', { name: 'Use these terms' }).click();
    assert.equal(await page.locator('#note').inputValue(), 'Updated');
    assert.equal(await page.locator('#amount').inputValue(), '2');
    unavailable = true; await refresh();
    assert.match(await page.locator('#refresh-error').innerText(), /could not be checked/);
    assert.equal(await page.locator('#amount').inputValue(), '2');
    unavailable = false;
    const retried = page.waitForResponse(r => new URL(r.url()).pathname === '/api/invoices');
    await page.clock.fastForward(15000); await retried;
    await page.waitForFunction(() => document.getElementById('refresh-error').textContent === '');
    // Start requests through the actual refresh button handler; release network responses in reverse order.
    defer = true;
    async function begin(slot) {
      const requested = page.waitForRequest(r => new URL(r.url()).pathname === '/api/invoices');
      await page.evaluate(slot => { window[slot] = document.getElementById('refresh').onclick(); }, slot);
      await requested;
      while (!queued.length) await new Promise(resolve => setImmediate(resolve));
      return queued.shift();
    }
    for (const olderFails of [false, true]) {
      const old = await begin('oldRead'), latest = await begin('newRead');
      await latest.fulfill({ json: response() }); await page.evaluate(() => newRead);
      await old.fulfill(olderFails ? { status: 503, json: {} } : { json: response('prepared') }); await page.evaluate(() => oldRead);
      assert.match(await page.locator('#invoices').innerText(), /Paid/);
      assert.equal(await page.getByRole('button', { name: 'Continue this prepared invoice' }).count(), 0);
      assert.equal(await page.locator('#refresh-error').innerText(), '');
    }
    const old = await begin('oldRead'), latest = await begin('newRead');
    await latest.fulfill({ status: 503, json: {} }); await page.evaluate(() => newRead);
    await old.fulfill({ json: response('prepared') }); await page.evaluate(() => oldRead);
    assert.match(await page.locator('#invoices').innerText(), /Paid/);
    assert.match(await page.locator('#refresh-error').innerText(), /could not be checked/);
    // Session changes clear records immediately and quarantine both reads and submissions.
    holdSubmission = true;
    await page.locator('#amount').fill('3');
    await page.evaluate(() => { window.oldSubmit = document.getElementById('submit').onclick(); });
    while (!pendingSubmission) await new Promise(resolve => setImmediate(resolve));
    const oldSessionRead = await begin('oldSessionRead');
    await page.locator('#signout').click();
    await page.locator('#signin').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'signin', 'sign-out restores a visible keyboard target');
    assert.equal(await page.locator('#agreements-card').isVisible(), false);
    assert.equal(await page.locator('#agreements li').count(), 0);
    assert.equal(await page.locator('#invoices li').count(), 0);
    await oldSessionRead.fulfill({ json: response('unknown') });
    await page.evaluate(() => oldSessionRead);
    const readsBefore = queued.length;
    await page.clock.fastForward(30000);
    assert.equal(queued.length, readsBefore, 'signed-out polling must stop');
    await page.evaluate(() => localStorage.setItem('invoice-draft:bob.near', JSON.stringify({ amount: '9', note: 'Bob draft', submission: 'bob-id' })));
    await page.locator('#signin').click();
    await page.waitForFunction(() => document.getElementById('account').textContent === 'bob.near');
    assert.equal(await page.locator('#invoices li').count(), 0);
    assert.equal(await page.locator('#agreements li').count(), 0);
    await pendingSubmission.fulfill({ json: { status: 'paid' } });
    await page.evaluate(() => oldSubmit);
    assert.equal(await page.locator('#amount').inputValue(), '9');
    assert.equal(await page.locator('#note').inputValue(), 'Bob draft');
    assert.equal(await page.locator('#refresh-status').innerText(), '');
    assert.equal(await page.locator('#error').isVisible(), false);
    while (!queued.length) await new Promise(resolve => setImmediate(resolve));
    await queued.shift().fulfill({ json: { invoices: [], agreements: [], agreed: true } });
    await page.getByText(/Last checked/).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS invoice page: module loading, eligibility, drafts, focus, failure recovery, submission identity, overlapping refreshes, session isolation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
