import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { offlineEnvironment } from '../../scripts/test-environment.mjs';

test('actual Treasury helper refuses ambiguous preparation and transport failure without fallback or retry', async ({}, info) => {
  const skill = process.env.PROTO_E2E_TREASURY_SKILL;
  test.skip(!skill, 'Supply --treasury-skill to test the external consumer checkout.');
  const dir = info.outputPath('client'); mkdirSync(dir, { recursive: true });
  const swaps = [{ from: 'usdc', to: 'near', amount: '1000000' }];
  const input = join(dir, 'swaps.json'); writeFileSync(input, JSON.stringify({ swaps }));
  const token = `tmc_00000000-0000-4000-8000-000000000000.${'x'.repeat(43)}`;
  const plan = { id: '00000000-0000-4000-8000-000000000000', source: 'external',
    actions: [{ type: 'swap', ...swaps[0], minAmountOut: '1' }] };
  for (const [name, command, response, path] of [
    ['changed', ['prepare', input], `new Response(JSON.stringify({json:${JSON.stringify({ ...plan, actions: [{ ...plan.actions[0], amount: '2000000' }] })}}))`, 'externalPlan'],
    ['missing', ['prepare', input], 'new Response("missing", {status:404})', 'externalPlan'],
    ['empty', ['prepare', input], 'new Response(JSON.stringify({json:null}))', 'externalPlan'],
    ['disconnect', ['execute', plan.id], '(function(){throw new Error("private upstream secret")})()', 'executePlan'],
  ]) {
    const log = join(dir, name + '.calls');
    const preload = join(dir, name + '.mjs');
    writeFileSync(preload, `import {appendFileSync} from 'node:fs'; globalThis.fetch=async (url)=>{appendFileSync(${JSON.stringify(log)},new URL(url).pathname+'\\n');return ${response};};`);
    const result = await promisify(execFile)(process.execPath, ['--import', preload, join(skill, 'scripts/treasury.mjs'), ...command], {
      env: { ...offlineEnvironment(), FORCE_COLOR: undefined, NODE_OPTIONS: process.env.NODE_OPTIONS,
        TREASURY_URL: 'https://127.0.0.1', TREASURY_NAME: 'portfolio', TREASURY_MACHINE_TOKEN: token },
    }).then(result => ({ ...result, code: 0 }), error => error);
    expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(token); expect(result.stderr).not.toContain('private upstream secret');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([`/machine/v1/a/portfolio/rpc/${path}`]);
    if (name === 'disconnect') expect(result.stderr).toContain('outcome may be unknown');
    if (name === 'missing') expect(result.stderr).toContain('do not substitute rebalance');
  }
});
