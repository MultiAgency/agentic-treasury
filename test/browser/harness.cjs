const assert = require('node:assert/strict');
const { runSuite } = require('./fixtures/task.cjs');
const { spawn } = require('node:child_process');
const { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');

runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const target of [page, context]) {
      const base = route => route.fulfill({ body: 'baseline' });
      const override = route => route.fulfill({ body: 'temporary failure' });
      await target.route('**/*', base);
      await target.route('**/data', override);
      await page.goto('http://fixture.invalid/data');
      assert.equal(await page.locator('body').innerText(), 'temporary failure');
      await target.unroute('**/data', override);
      await page.goto('http://fixture.invalid/data');
      assert.equal(await page.locator('body').innerText(), 'baseline');
      await target.unroute('**/*', base);
    }
    await context.close();
    console.log('PASS diagnostic wrappers preserve page and context handler removal');
  } finally { await browser.close(); }
  for (const [failure, log, message] of [
    ['route-error', 'fixture-errors.log', /Unexpected RPC: unexpected-write/],
    ['page-error', 'page-errors.log', /Unexpected page error fixture/],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'browser-harness-'));
    try {
      const child = spawn(process.execPath, [join(__dirname, 'fixtures/artifact-failure.cjs'), failure], {
        env: { ...process.env, PROTO_BROWSER_ARTIFACTS: directory }, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 1, stderr);
      assert.match(readFileSync(join(directory, log), 'utf8'), message);
      const context = readdirSync(directory).find(name => name.startsWith('context-'));
      assert.ok(context, `${failure} retains its context diagnostics`);
      assert.ok(statSync(join(directory, context, 'trace.zip')).size > 0);
      assert.ok(statSync(join(directory, context, 'page-0.png')).size > 0);
      console.log(`PASS ${failure} fails the process even when the scenario returns normally; trace and screenshot retained`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
