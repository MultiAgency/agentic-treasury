/** Offline public overview regressions. Every request is intercepted; no server or wallet starts. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { assertResponsive } = require('./fixtures/layout.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  const results = [];
  async function check(name, width, work) {
    if (process.env.CASE_FILTER && !name.includes(process.env.CASE_FILTER)) return;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      if (url.origin !== 'http://frontend.test') return route.abort();
      if (url.pathname === '/gw/me') return route.fulfill({ json: {
        agents: [], invoices: null, viewer: null,
      } });
      if (url.pathname.startsWith('/static/')) return route.fulfill({ path: root + url.pathname,
        contentType: url.pathname.endsWith('.js') ? 'application/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
      if (url.pathname.includes('/rpc/') || url.pathname.startsWith('/gw/')) return route.abort();
      return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
    });
    try {
      await work(page, requests);
      assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      results.push({ name, width, pass: true });
    } catch (error) {
      results.push({ name, width, pass: false, error: error.message });
    } finally { await context.close(); }
  }

  for (const width of [320, 1280]) {
    await check('sign-in replaces public and legacy walkthroughs', width, async (page, requests) => {
      for (const suffix of ['/', '/#/explore/payables/overview', '/a/treasury/#/explore/treasury/policy']) {
        await page.goto(`http://frontend.test${suffix}`);
        await page.getByRole('heading', { name: 'Agentic Treasury', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Connect wallet', exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: /See how it works|Explore|requirement stages/ }).count(), 0);
        assert.equal(await page.getByText('View requirements', { exact: true }).count(), 0);
        assert.equal(await page.getByRole('heading', { name: 'Run with real funds', exact: true }).count(), 0);
        await assertResponsive(page, 'sign-in entry');
      }
      assert.deepEqual(requests.filter(url => /\/rpc\/|manifest\.json/.test(url)), []);
    });
  }
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exitCode = results.length > 0 && results.every(result => result.pass) ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
