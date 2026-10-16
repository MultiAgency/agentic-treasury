import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { offlineEnvironment } from './test-environment.mjs';
import { checkFrontendContract } from './check-consumer-contract.mjs';
const dist = process.argv[2];
const area = process.argv[3] ?? 'treasury';
if (!['treasury', 'payables'].includes(area)) throw new Error('Area must be treasury or payables');
if (!dist || !existsSync(resolve(dist, 'index.html'))) throw new Error('Usage: node scripts/test-shared-frontend.mjs /absolute/path/to/consumer/web/dist [treasury|payables] (build the consumer first)');
// Frozen artifacts may have no matching source tree. Never substitute current source for them.
const consumer = process.argv[5] ?? resolve(dist, '../..');
if (process.argv[5] || existsSync(resolve(consumer, 'web/tsconfig.json'))) {
  const contract = checkFrontendContract(consumer, process.argv[4], area);
  if (!contract.ok) { console.error(contract.diagnostics); process.exit(1); }
  console.log('Consumer source contract passed; browser verification follows. Build provenance remains separate.');
} else console.log('Source contract not checked: artifact has no adjacent consumer source tree.');
const env = { ...offlineEnvironment(), SHARED_FRONTEND_DIST: resolve(dist), SHARED_FRONTEND_AREA: area, SHARED_RUNTIME_ROOT: resolve(process.argv[4] ?? '.'), NODE_OPTIONS: `--require ${JSON.stringify(resolve('test/fixtures/offline-network.cjs'))}` };
for (const key of ['BROWSER_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[key]) env[key] = process.env[key];
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/integration/shared-frontend.ts'], { env, stdio: 'inherit', timeout: 120_000 });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
