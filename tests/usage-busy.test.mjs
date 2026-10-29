import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plannedSandbox as sandbox, baseConfig, apiAgent, taskArgs, seedRun, write, json, output, poll, MESSAGES } from './helpers.mjs';
import { discussion, review } from './fixtures/reports.mjs';
import { apiServer } from './fake/api-server.mjs';

const M = MESSAGES.zh;
function configure(h, api) {
  const config = baseConfig(); config.agents.api = apiAgent(api.url);
  for (const mode of ['discuss', 'review']) config.modules.default[mode].complex = [{ agent: 'api' }];
  h.config(config);
}
function queued(h, id, cwd, minutes = 1) {
  const ts = new Date(Date.now() - minutes * 60000).toISOString();
  seedRun(h, id, { cwd, module: 'discuss', mode: 'discuss', kind: 'discuss', agent: 'api', agent_type: 'api', model: 'fake-api',
    group: 'queue', status: 'running', pid: process.pid, ended_at: undefined }, null,
  [{ type: 'api.request', ts }, { type: 'api.queued', ts }]);
}

test('await-busy 按任务目录采用项目阈值，同一目录只加载一次', async (t) => {
  const h = sandbox(t), config = baseConfig(); config.dispatch.busy_ask_min = 2; h.config(config);
  const other = path.join(h.home, 'other'), projects = [h.cwd, other].map((cwd) => path.join(cwd, '.claude/foreman.json'));
  write(projects[0], { dispatch: { busy_ask_min: 0.01 } }); write(projects[1], { dispatch: { busy_ask_min: 2 } });
  queued(h, 'fast-a', h.cwd); queued(h, 'fast-b', h.cwd);
  queued(h, 'slow', other); queued(h, 'long-queue', other, 3);
  const capture = path.join(h.home, 'config-reads.json');
  const preload = h.write('count-config.mjs', `import fs from 'node:fs';
const read = fs.readFileSync, projects = ${JSON.stringify(projects)}, counts = {};
fs.readFileSync = function (file, ...args) {
  if (projects.includes(String(file))) {
    counts[file] = (counts[file] || 0) + 1;
    fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(counts));
  }
  return read.call(this, file, ...args);
};`);
  const r = output(await h.bridge(['await-busy', '--group', 'queue'], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }));
  assert.deepEqual(r.busy.map((run) => run.run_id).sort(), ['fast-a', 'fast-b', 'long-queue']);
  assert.deepEqual(r.running.sort(), ['fast-a', 'fast-b', 'long-queue', 'slow']); assert.equal(r.done, false);
  assert.deepEqual(json(capture), Object.fromEntries(projects.map((file) => [file, 1])));
});

test('await-busy 用户阈值为零时仍采用项目阈值，并忽略阈值为零的任务', async (t) => {
  const h = sandbox(t), disabled = path.join(h.home, 'disabled'); fs.mkdirSync(disabled);
  h.write('.claude/foreman.json', { dispatch: { busy_ask_min: 0.01 } });
  queued(h, 'enabled', h.cwd); queued(h, 'disabled', disabled, 10);
  const r = output(await h.bridge(['await-busy', '--group', 'queue']));
  assert.deepEqual(r.busy.map((run) => run.run_id), ['enabled']);
  assert.deepEqual(r.running.sort(), ['disabled', 'enabled']); assert.equal(r.done, false);
});

test('await-busy 全部零阈值时禁用，--after 统一覆盖任务阈值', async (t) => {
  const h = sandbox(t), disabled = path.join(h.home, 'disabled'); fs.mkdirSync(disabled);
  h.write('.claude/foreman.json', { dispatch: { busy_ask_min: 0.01 } });
  queued(h, 'enabled', h.cwd); queued(h, 'disabled', disabled, 10);
  assert.deepEqual(output(await h.bridge(['await-busy', '--run', 'disabled'])), { busy: [], running: [], done: true, disabled: true });
  const r = output(await h.bridge(['await-busy', '--group', 'queue', '--after', '2']));
  assert.deepEqual(r.busy.map((run) => run.run_id), ['disabled']);
  assert.deepEqual(r.running.sort(), ['disabled', 'enabled']); assert.equal(r.done, false);
});

for (const mode of ['discuss', 'review']) test(`API ${mode} 未返回用量时写 null 和提示，stats 计入缺失`, async (t) => {
  const h = sandbox(t), report = mode === 'review' ? review : discussion, api = await apiServer(t, [{ usage: null, answer: report }]);
  configure(h, api); h.write('source.txt', 'evidence\n');
  const extra = mode === 'review' ? ['--target', 'files', '--file', 'source.txt'] : [];
  const r = output(await h.bridge(taskArgs(h, mode, ['--no-snapshot', ...extra])));
  assert.deepEqual(r.report, report); assert.equal(r.usage, null); assert.equal(r.usage_scope, null); assert.ok(r.notes.includes(M.apiUsageMissing));
  assert.equal(h.result(r.run_id).usage, null); assert.equal(h.events(r.run_id).some((e) => e.type === 'api.usage'), false);
  const stats = output(await h.bridge(['stats']));
  assert.deepEqual(stats.rows.find((r) => r.participant !== 'host').tokens, { input: null, cached_input: null, output: null, runs: 0, missing_runs: 1 });
});

test('API 明确返回零用量时保留零值，不记缺失提示', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ usage: { prompt_tokens: 0, completion_tokens: 0 } }]); configure(h, api);
  const r = output(await h.bridge(taskArgs(h, 'discuss')));
  assert.deepEqual(r.usage, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
  assert.equal(r.notes.includes(M.apiUsageMissing), false);
  assert.ok(h.events(r.run_id).some((e) => e.type === 'api.usage'));
});

for (const missing of [0, 1]) test(`API ${missing === 0 ? '首次回答' : '修复回答'}缺用量时整轮记 null`, async (t) => {
  const h = sandbox(t), scenes = [{ answer: {} }, { answer: discussion }]; scenes[missing].usage = null;
  const api = await apiServer(t, scenes); configure(h, api);
  const r = output(await h.bridge(taskArgs(h, 'discuss')));
  assert.equal(api.requests.length, 2); assert.deepEqual(r.report, discussion);
  assert.equal(r.usage, null); assert.equal(r.usage_scope, null); assert.ok(r.notes.includes(M.apiUsageMissing));
  assert.equal(h.events(r.run_id).filter((e) => e.type === 'api.done').length, 2);
  assert.equal(h.events(r.run_id).filter((e) => e.type === 'api.usage').length, 1);
  assert.equal(h.result(r.run_id).usage, null);
});

test('API 修复请求被取消时保留已返回的累计用量，不加缺失提示', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: {} }, { queued: true, gate: 'cancel' }]); configure(h, api);
  const running = h.startBridge(taskArgs(h, 'discuss')), meta = await h.running();
  await poll(() => h.events(meta.id).some((e) => e.type === 'api.queued'), '修复请求排队');
  assert.equal(output(await h.bridge(['cancel', '--run', meta.id])).status, 'cancelled');
  const r = output(await running.done, 1);
  assert.equal(api.requests.length, 2); assert.equal(r.status, 'cancelled');
  assert.deepEqual(r.usage, { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10 });
  assert.ok(r.notes.includes(M.cancelledUsagePartial)); assert.equal(r.notes.includes(M.apiUsageMissing), false);
});

test('API 取消前未收到用量时只保留通用取消提示', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ queued: true, gate: 'cancel' }]); configure(h, api);
  const running = h.startBridge(taskArgs(h, 'discuss')), meta = await h.running();
  await poll(() => h.events(meta.id).some((e) => e.type === 'api.queued'), '请求排队');
  assert.equal(output(await h.bridge(['cancel', '--run', meta.id])).status, 'cancelled');
  const r = output(await running.done, 1);
  assert.equal(r.status, 'cancelled'); assert.equal(r.usage, null);
  assert.ok(r.notes.includes(M.cancelledUsageMissing)); assert.equal(r.notes.includes(M.apiUsageMissing), false);
});
