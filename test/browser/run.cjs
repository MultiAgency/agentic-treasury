/** Run the offline browser regressions against the freshly built app. No server or executor starts. */
const { readdirSync, mkdtempSync, cpSync, rmSync, symlinkSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const suites = readdirSync(__dirname).filter(name => name.endsWith('.cjs') && name !== 'run.cjs').sort();
if (!suites.length) throw new Error('No browser suites found');
const requested = process.argv.slice(2);
for (const name of requested) {
  if (!suites.includes(name)) throw new Error(`Unknown browser suite: ${name}. Available: ${suites.join(', ')}`);
}
const env = { ...process.env };
// A full-suite command must not silently inherit an individual scenario filter.
for (const key of ['CASE_FILTER', 'SCENARIO', 'TEST_CASE', 'WIG_CASE']) delete env[key];
let failures = 0;
// Other sessions may rebuild or edit fixtures. Keep assets and tests fixed for this invocation.
const snapshot = mkdtempSync(join(tmpdir(), 'proto-browser-'));
try {
  cpSync(resolve(__dirname, '../../web/dist'), join(snapshot, 'dist'), { recursive: true });
  cpSync(__dirname, join(snapshot, 'test/browser'), { recursive: true });
  cpSync(resolve(__dirname, '../../src'), join(snapshot, 'src'), { recursive: true });
  cpSync(resolve(__dirname, '../../package.json'), join(snapshot, 'package.json'));
  symlinkSync(resolve(__dirname, '../../node_modules'), join(snapshot, 'node_modules'), 'dir');
  for (const name of requested.length ? requested : suites) {
    console.log(`\nBrowser suite: ${name}`);
    const result = spawnSync(process.execPath, [join(snapshot, 'test/browser', name), join(snapshot, 'dist')], {
      cwd: snapshot, env, stdio: 'inherit', timeout: 180_000,
    });
    if (result.error || result.status !== 0) {
      failures++;
      console.error(`${name} failed: ${result.error?.message ?? result.signal ?? result.status}`);
    }
  }
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
console.log(`\n${failures} browser suite(s) failed.`);
process.exitCode = failures ? 1 : 0;
