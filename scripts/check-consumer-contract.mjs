import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { API } from 'typescript/unstable/sync';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Type-only comparison: no router, configuration, state or provider code is executed.
 * @param {string} consumer
 * @param {string} [provider]
 * @param {string[]} [groups]
 */
export function checkConsumerContract(consumer, provider = root, groups = undefined) {
  const actual = resolve(provider, 'src/router.ts');
  const expected = resolve(consumer, 'src/router.ts');
  for (const path of [actual, expected]) if (!existsSync(path)) throw new Error(`Missing router: ${path}`);
  const temporary = mkdtempSync(join(tmpdir(), 'proto-contract-'));
  try {
    writeFileSync(join(temporary, 'check.ts'), `
import type { RouterClient } from ${JSON.stringify(fileURLToPath(import.meta.resolve('@orpc/server')).replace(/\.mjs$/, '.d.mts'))};
import type { Router as Actual } from ${JSON.stringify(actual)};
import type { Router as Expected } from ${JSON.stringify(expected)};
declare const actual: RouterClient<Actual>;
const expected: ${groups ? `Pick<RouterClient<Expected>, ${groups.map(key => JSON.stringify(key)).join(' | ')}>` : 'RouterClient<Expected>'} = actual;
void expected;
`);
    writeFileSync(join(temporary, 'tsconfig.json'), JSON.stringify({
      extends: resolve(root, 'tsconfig.json'),
      compilerOptions: {
        module: 'ESNext', moduleResolution: 'Bundler', allowImportingTsExtensions: true,
        types: [], typeRoots: [resolve(root, 'node_modules/@types')],
        noEmit: true,
      },
      files: ['./check.ts'], include: [],
    }));
    const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'),
      '-p', join(temporary, 'tsconfig.json'), '--pretty', 'false'], {
      encoding: 'utf8', timeout: 120_000,
    });
    return { ok: result.status === 0, diagnostics: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}` };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Compile the actual frontend with a restricted Router type, using an in-memory overlay only. */
export function checkFrontendUsage(consumer, groups) {
  if (!Array.isArray(groups) || !groups.length || groups.some(key => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)))
    throw new Error('Invalid frontend router groups');
  const router = resolve(consumer, 'src/router.ts');
  if (!existsSync(router)) throw new Error(`Missing router: ${router}`);
  const virtual = resolve(consumer, 'src/.proto-frontend-contract.ts');
  const narrowed = `import type { Router as Backend } from './router.js';
export type Router = Pick<Backend, ${groups.map(key => JSON.stringify(key)).join(' | ')}>;`;
  const config = resolve(consumer, 'web/tsconfig.json');
  if (!existsSync(config)) throw new Error(`Missing frontend configuration: ${config}`);
  const frontend = resolve(consumer, 'web/src') + '/';
  const redirected = new Set();
  const api = new API({ cwd: resolve(consumer), fs: {
    fileExists: path => resolve(path) === virtual ? true : undefined,
    readFile: path => {
      path = resolve(path);
      if (path === virtual) return narrowed;
      if (!path.startsWith(frontend) || !/\.[cm]?[jt]sx?$/.test(path) || !existsSync(path)) return undefined;
      // Redirect only frontend references. Backend modules retain their complete Router type.
      return readFileSync(path, 'utf8').replace(/(["'])(\.[^"'\n]+)\1/g, (literal, _quote, specifier) => {
        const target = resolve(dirname(path), specifier).replace(/\.js$/, '.ts');
        if (target !== router && target + '.ts' !== router) return literal;
        redirected.add(path);
        return JSON.stringify(virtual);
      });
    },
  } });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (!project || !project.rootFiles.length) throw new Error('Frontend project has no source files');
      const p = project.program;
      const errors = [...p.getConfigFileParsingDiagnostics(), ...p.getProgramDiagnostics(),
        ...p.getSyntacticDiagnostics(), ...p.getGlobalDiagnostics(), ...p.getSemanticDiagnostics()];
      if (!redirected.has(resolve(consumer, 'web/src/shared/client.ts')))
        throw new Error('Frontend client does not reference the declared Router; review the contract adapter');
      return { ok: errors.length === 0, diagnostics: errors.map(d => `${d.fileName ?? config}: TS${d.code}: ${d.text}`).join('\n') };
    } finally { snapshot.dispose(); }
  } finally { api.close(); }
}

export function checkFrontendContract(consumer, provider = root, area) {
  if (!['treasury', 'payables'].includes(area)) throw new Error('Frontend area must be treasury or payables');
  const { routerGroups } = JSON.parse(readFileSync(resolve(root, `contracts/${area}-frontend.json`), 'utf8'));
  const usage = checkFrontendUsage(consumer, routerGroups);
  return usage.ok ? checkConsumerContract(consumer, provider, routerGroups) : usage;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/check-consumer-contract.mjs /consumer/root [/proto/root] [treasury|payables|backend]');
  const inferred = basename(resolve(process.argv[2]));
  const area = process.argv[4] ?? (['treasury', 'payables'].includes(inferred) ? inferred : 'backend');
  const result = area !== 'backend' ? checkFrontendContract(process.argv[2], process.argv[3], area)
    : checkConsumerContract(process.argv[2], process.argv[3]);
  console.log(result.ok ? `${area} contract is compatible with Proto (source types only).` : result.diagnostics);
  process.exitCode = result.ok ? 0 : 1;
}
