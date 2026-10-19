/** Every Proto page that moved to an agent's app redirects there with its query and hash; none renders a 404. Offline. */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');

// The redirect map is read from the router, so a newly moved path is covered without editing this suite.
const router = readFileSync(join(__dirname, '../../web/src/app/router.tsx'), 'utf8');
const MOVED = JSON.parse(router.match(/export const MOVED = (\[[^\]]*\])/)[1]);

async function redirects(browser, root) {
  assert.ok(MOVED.includes('/activity') && MOVED.includes('/follow/payment'), 'the redirect map is read from the router');
  const { setup, overview, budget } = workspaceEvidence();
  const open = workspaceOpener(root, { budget, values: kind => ({ setup, overview: overview(kind), 'treasury/get': null }) });
  const cases = [
    { agent: 'payables', app: 'https://payables.multiagency.ai' },
    { agent: 'treasury', app: 'https://treasury.multiagency.ai' },
    // A local stack's gateway names the app host; the redirect stays on that deployment's protocol.
    { agent: 'payables', app: 'http://payables.local.test:8443', apps: { payables: 'payables.local.test:8443' } },
    // The area comes from the gateway session: a failing agent read never strands a saved link.
    { agent: 'treasury', app: 'https://treasury.multiagency.ai', error: 'setup' },
  ];
  for (const { agent, app, apps, error } of cases) {
    for (const path of MOVED) {
      const context = await browser.newContext();
      const query = path === '/follow/payment' ? '?payment=fixture-payment' : '?from=proto';
      const { page, errors } = await open(context, `/a/${agent}${path}${query}#section`, { external: true, ...(apps && { apps }), ...(error && { error }) });
      await page.waitForURL(url => !url.href.startsWith('http://frontend.test'))
        .catch(async () => assert.fail(`${agent}${path}: no redirect; page shows ${(await page.locator('body').innerText()).slice(0, 200)}`));
      assert.equal(page.url(), `${app}/a/${agent}${path === '/workspace' ? '/' : path}${query}#section`, `${agent}${path}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log(`PASS ${agent}${apps ? ' (configured host)' : ''}${error ? ` (${error} read failing)` : ''}: ${MOVED.length} moved paths redirect to ${app} with query and hash`);
  }
}
runTask([redirects]);
