import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, seedRun, taskArgs, output, BRIDGE } from './helpers.mjs';

test('1000 条历史记录下同时派发 10 个假协作方任务，记录各段耗时', async (t) => {
  const h = sandbox(t), cfg = baseConfig();
  cfg.agents.codex.max_parallel = 20;
  h.config(cfg);
  for (let i = 0; i < 1000; i++) seedRun(h, `20000101-000000-${String(i).padStart(4, '0')}`,
    i === 0 ? { status: 'running', pid: process.pid } : {});
  const prefix = path.join(h.runs, '20000101-000000-');
  const probe = h.write('profile.mjs', `import fs from 'node:fs';
let reads = 0, probes = 0;
const archived = (file) => String(file).startsWith(${JSON.stringify(prefix)}) && String(file).endsWith('meta.json') && String(file) !== ${JSON.stringify(path.join(h.runs, '20000101-000000-0000', 'meta.json'))};
for (const name of ['readFileSync', 'existsSync', 'statSync']) {
  const original = fs[name];
  fs[name] = (file, ...args) => { if (archived(file)) { if (name === 'readFileSync') reads++; else probes++; } return original(file, ...args); };
}
process.once('exit', () => process.stderr.write('foreman-test-history ' + reads + ' ' + probes + '\\n'));
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  for (const phase of ['cold', 'warm']) {
    const began = performance.now(), wall = Date.now();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => h.start(probe,
      taskArgs(h, 'run', ['--no-snapshot', '--title', `speed-${phase}-${i}`]), { env: { FOREMAN_PROFILE: '1' }, timeout: 60000 }).done));
    const stages = {};
    for (const r of results) {
      output(r);
      for (const [, stage, ms] of r.stderr.matchAll(/^foreman-profile (\S+) ([\d.]+)$/gm)) (stages[stage] ??= []).push(Number(ms));
      if (phase === 'warm') assert.match(r.stderr, /^foreman-test-history 0 0$/m);
    }
    assert.equal(h.records().length, phase === 'cold' ? 1010 : 1020);
    const total = performance.now() - began;
    for (const stage of ['outside-scan', ...(phase === 'warm' ? ['process-query'] : []), 'lock-wait', 'locked-create', 'locked-admission', 'lock-release']) assert.ok(stages[stage]?.length, stage);
    const starts = h.records().filter((m) => m.title?.startsWith(`speed-${phase}-`)).map((m) => Date.parse(m.started_at));
    t.diagnostic(JSON.stringify({ phase, total_ms: +total.toFixed(1), all_started_ms: Math.max(...starts) - wall, start_span_ms: Math.max(...starts) - Math.min(...starts), stages: Object.fromEntries(
      Object.entries(stages).map(([name, values]) => [name, { n: values.length, mean: +(values.reduce((a, b) => a + b) / values.length).toFixed(1), max: +Math.max(...values).toFixed(1) }])) }));
  }
});
