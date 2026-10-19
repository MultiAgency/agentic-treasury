/** Static host entries: no gateway/private reads, mobile and desktop, and correct focused links. */
const assert = require('node:assert/strict');
const { runSuite } = require('./fixtures/task.cjs');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { assertResponsive } = require('./fixtures/layout.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const width of [320, 1280]) for (const [host, title] of [
      ['proto', 'Three ideas. Owner-signed authority.'], ['treasury', 'Your agency Treasury'],
      ['payables', 'Your confidential payments and work orders'],
    ]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(); const calls = []; const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url()); calls.push(url.pathname);
        if (url.pathname.startsWith('/static/')) return route.fulfill({ path: root + url.pathname, contentType: url.pathname.endsWith('.js') ? 'application/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
        if (url.pathname === '/' || url.pathname === '/favicon.svg') return route.fulfill({ path: path.join(root, url.pathname === '/' ? 'index.html' : 'favicon.svg') });
        return route.abort();
      });
      await page.goto(`https://${host}.multiagency.ai/`);
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      assert.deepEqual(calls.filter(p => /\/gw\/|\/rpc\/|\/api\//.test(p)), []);
      assert.equal(await page.getByRole('link', { name: /Steward/ }).count(), 0);
      if (host === 'proto') {
        assert.equal(await page.getByRole('link', { name: 'Short demos', exact: true }).getAttribute('href'), '/demos');
        assert.deepEqual(await page.getByRole('link', { name: 'Full walkthrough', exact: true }).evaluateAll(links => links.map(link => link.getAttribute('href'))), ['/payables', '/treasury', '/invoices']);
        for (const demo of ['Payables', 'Treasury']) assert.equal(await page.getByRole('link', { name: `Open ${demo}`, exact: true }).getAttribute('href'), `https://${demo.toLowerCase()}.multiagency.ai`);
        assert.equal(await page.getByRole('link', { name: 'Open work orders in Payables', exact: true }).getAttribute('href'), 'https://payables.multiagency.ai/workspace');
      }
      if (host === 'proto' || host === 'payables') assert.equal(await page.getByRole('link', { name: /Payee: submit/ }).getAttribute('href'), 'https://invoices.multiagency.ai');
      if (host === 'payables') await page.getByText(/Payee conversion and forwarding remain unimplemented/).waitFor();
      await assertResponsive(page, `${host} entry`); assert.deepEqual(errors, []);
      if (host === 'proto') await page.screenshot({ path: `/tmp/proto-shared-${width}.png`, fullPage: true });
      await context.close(); console.log(`PASS ${host} static entry ${width}px`);
    }
  } finally { await browser.close(); }
});
