const { mkdirSync, writeFileSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');
const { chromium } = require('./browser.cjs');

// From invoices-d3's runner (Invoices test/browser/fixtures/task.cjs); Proto's build root is web/dist.
const FAILURES = resolve('.test-artifacts/browser-failures');
// A scenario that hasn't finished in this time fails by name (with diagnostics) instead of hanging the run.
const LIMIT_MS = Number(process.env.BROWSER_SCENARIO_LIMIT_MS || 5 * 60_000);

/** Writes a failed scenario's name, error and every page's console and page errors, synchronously. Returns the directory. */
function keepRecord(task, scenario, error, pages) {
  const dir = join(FAILURES, `${new Date().toISOString().replace(/[:.]/g, '-')}-${task}-${scenario}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'error.txt'), `${task} › ${scenario}\n\n${error?.stack ?? error}\n`);
  pages.forEach(({ page, log }, i) => writeFileSync(join(dir, `page-${i}.log`), `${page.url()}\n${log.join('\n')}\n`));
  return dir;
}
/** Keeps what a failed scenario leaves behind: the record above, plus a screenshot of each page still open. */
async function keepFailure(task, scenario, error, pages) {
  const dir = keepRecord(task, scenario, error, pages);
  await Promise.all(pages.map(({ page }, i) => page.isClosed() ? null : page.screenshot({ path: join(dir, `page-${i}.png`), fullPage: true }).catch(() => {})));
  return dir;
}

/**
 * Fails the process unless every registered scenario ran to completion, passed or failed. A scenario awaiting
 * something that never settles lets Node exit early with status 0, which would otherwise read as a pass.
 */
function requireEvery(task, scenarios, ran, running) {
  process.on('exit', () => {
    const missing = scenarios.filter(scenario => !ran.has(scenario.name)).map(scenario => scenario.name);
    if (!missing.length) return console.log(`${task}: ${ran.size} of ${scenarios.length} scenarios ran`);
    process.exitCode = 1;
    console.error(`${task}: ${ran.size} of ${scenarios.length} scenarios ran; did not run to completion: ${missing.join(', ')}`);
    const { scenario, pages } = running();
    if (scenario) console.error(`Kept failure diagnostics for ${scenario}: ${keepRecord(task, scenario, 'Did not finish: the process ran out of work while this scenario was still waiting.', pages)}`);
  });
}

/** One browser per task; fresh contexts, diagnostics and failures remain isolated per scenario. */
async function runTask(scenarios) {
  const root = resolve(process.argv[2] || 'web/dist'), task = basename(process.argv[1], '.cjs');
  const ran = new Set();
  let current, pages = [];
  requireEvery(task, scenarios, ran, () => ({ scenario: current, pages }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  // Every page a scenario opens records its console and page errors, so a failure can be traced afterwards.
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async options => {
    const page = await newPage(options), log = [];
    page.on('console', message => log.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', error => log.push(`[pageerror] ${error.stack ?? error.message}`));
    page.on('requestfailed', request => log.push(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
    pages.push({ page, log });
    return page;
  };
  try {
    for (const scenario of scenarios) {
      console.log(`Scenario: ${scenario.name}`);
      current = scenario.name; pages = [];
      let timer;
      try {
        await Promise.race([scenario(browser, root), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${scenario.name} did not finish within ${LIMIT_MS / 1000}s`)), LIMIT_MS); })]);
      }
      catch (error) {
        console.error(error); process.exitCode = 1;
        console.error(`Kept failure diagnostics for ${scenario.name}: ${await keepFailure(task, scenario.name, error, pages)}`);
      }
      finally { clearTimeout(timer); ran.add(scenario.name); current = undefined; for (const context of browser.contexts()) await context.close(); }
    }
  } finally { await browser.close(); }
}

/**
 * For a suite that runs its own browser loop: the same completion check and time limit, with the whole suite as one
 * scenario. On the time limit it exits at once, since the suite's own browser would otherwise keep the process alive.
 */
function runSuite(body) {
  const task = basename(process.argv[1], '.cjs'), ran = new Set();
  requireEvery(task, [{ name: task }], ran, () => ({ scenario: undefined, pages: [] }));
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${task} did not finish within ${LIMIT_MS / 1000}s`), { limit: true })), LIMIT_MS); });
  return Promise.race([body(), limit])
    .then(() => ran.add(task), error => {
      console.error(error); process.exitCode = 1;
      if (error?.limit) process.exit(1);
      ran.add(task);
    })
    .finally(() => clearTimeout(timer));
}
module.exports = { keepFailure, requireEvery, runSuite, runTask: scenarios => runTask(scenarios).catch(error => { console.error(error); process.exitCode = 1; }) };
