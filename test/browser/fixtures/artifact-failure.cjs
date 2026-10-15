const { chromium } = require('./browser.cjs');
const { rpcValue } = require('./rpc.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage();
    if (process.argv[2] === 'page-error') {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html',
        body: '<script>throw new Error("Unexpected page error fixture")</script>' }));
      const observed = page.waitForEvent('pageerror');
      await page.goto('http://fixture.invalid');
      await observed; // No test assertion throws: the shared harness must reject this run.
    } else {
      await page.route('**/*', route => route.fulfill({ body: String(rpcValue({}, 'unexpected-write')) }));
      await page.goto('http://fixture.invalid').catch(() => {});
    }
    await page.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
