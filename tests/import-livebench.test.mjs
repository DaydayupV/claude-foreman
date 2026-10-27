import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'tests/fixtures/livebench/2026-10-27.txt';
const CATALOG = 'foreman/skills/dispatch/scripts/models.json';
const UNKNOWN = ['Muse Spark Open', 'Smaug-Nemotron-3.5-NVFP4', 'Nemotron 3.5 Super VL', 'Inkling', 'Nemotron 3.5 Super VL (NVFP4)', 'Gemma 4 31B'];
const SCORES = { agentic: 77.9, design: 83.4, coding: 97.7, browser: 89.8, data: 80.3, research: 82, reasoning: 91.7 };
const LEGACY = { source: 'legacy-2026-10-18', tier: 'weak', strengths: ['coding'], weaknesses: [{ dim: 'agentic', level: 'weak' }] };

function sandbox(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-livebench-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['tools/import-livebench.mjs', CATALOG, FIXTURE]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  const input = path.join(dir, FIXTURE), out = path.join(dir, 'tiers.json'), catalog = path.join(dir, CATALOG);
  if (seed) fs.writeFileSync(out, JSON.stringify(seed));
  const run = (...extra) => spawnSync(process.execPath, [path.join(dir, 'tools/import-livebench.mjs'), '--input', input, '--date', '2026-10-27', '--out', out, ...extra], { cwd: os.tmpdir(), encoding: 'utf8' });
  return { input, out, catalog, run, read: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('解析 31 个模型，识别 open、board_names 和名字的大小写及空白', (t) => {
  const h = sandbox(t), catalog = JSON.parse(fs.readFileSync(h.catalog, 'utf8'));
  UNKNOWN.forEach((display, i) => { catalog.models[`unknown-${i}`] = { display }; });
  fs.writeFileSync(h.catalog, JSON.stringify(catalog));
  fs.writeFileSync(h.input, fs.readFileSync(h.input, 'utf8').replace('DeepSeek V4.1 Flash 1017', '  dEePsEeK   V4.1 Flash 1017  ').replace('Step 5 (Preview)', 'sTEP  5 (Preview)'));
  const r = h.run(); assert.equal(r.status, 0, r.stderr);
  const data = h.read(), models = Object.values(data.models);
  assert.equal(models.length, 31);
  assert.equal(models.filter((model) => model.open).length, 14);
  assert.equal(data.models['deepseek-flash'].overall, 74);
  assert.equal(data.models['deepseek-flash'].cost_per_task, 0.181);
  assert.equal(data.models['step-5-preview'].overall, 58.6);
  assert.equal(data.models['claude-fable-5-1'].open, false);
  assert.deepEqual(data.models['claude-fable-5-1'].scores, SCORES);
  assert.deepEqual(models.map((model) => model.overall), models.map((model) => model.overall).sort((a, b) => b - a));
  assert.deepEqual(Object.keys(data), ['schema_version', 'as_of', 'thresholds', 'dimensions', 'sources', 'models']);
});

test('对不上的六个原名逐个报告，不写入数据', (t) => {
  const h = sandbox(t), r = h.run(); assert.equal(r.status, 0, r.stderr);
  assert.equal(Object.keys(h.read().models).length, 25);
  assert.ok(r.stdout.includes(`对不上的名字（没写入）：\n${UNKNOWN.join('\n')}\n要收录就在 models.json 里加这个模型（或给已有模型加 board_names）`));
  for (const name of UNKNOWN) assert.ok(!fs.readFileSync(h.out, 'utf8').includes(name));
});

test('保留和覆盖 legacy，删除旧榜缺项及无引用来源，保留阈值和维度，重复导入不变', (t) => {
  const seed = { thresholds: { strong: 85.7, mid: 74 }, dimensions: Object.keys(SCORES).reverse(), sources: {
    'legacy-2026-10-18': { name: '旧表', checked: '2026-10-18' }, 'livebench-2026-10-20': { checked: '2026-10-20' }, unused: { checked: '2026-10-01' },
  }, models: { 'gpt-6-sol': LEGACY, 'gpt-5.5': LEGACY, 'claude-fable-5-1': LEGACY, 'gpt-6-astra': { source: 'livebench-2026-10-20', overall: 84.5 }, 'gpt-5.4-nano': { source: 'livebench-2026-10-20', overall: 80 } } };
  const h = sandbox(t, seed), r = h.run(); assert.equal(r.status, 0, r.stderr);
  const data = h.read();
  assert.deepEqual(data.models['gpt-6-sol'], LEGACY);
  assert.equal(data.models['claude-fable-5-1'].source, 'livebench-2026-10-27');
  assert.equal(data.models['claude-fable-5-1'].tier, undefined);
  assert.equal(data.models['gpt-5.4-nano'], undefined);
  assert.deepEqual(Object.keys(data.sources), ['livebench-2026-10-27', 'legacy-2026-10-18']);
  assert.deepEqual(Object.keys(data.models).slice(-2), ['gpt-5.5', 'gpt-6-sol']);
  assert.deepEqual(data.thresholds, seed.thresholds); assert.deepEqual(data.dimensions, seed.dimensions);
  assert.ok(r.stdout.includes('claude-fable-5-1  弱 → 85.7  强（档位变化）'));
  assert.ok(r.stdout.includes('gpt-6-astra  84.5 → 85.6  中\n'));
  assert.ok(r.stdout.includes('deepseek-flash  74  中'));
  assert.ok(r.stdout.includes('榜上已没有（已删除）：\ngpt-5.4-nano'));
  const before = fs.readFileSync(h.out, 'utf8'), repeat = h.run(); assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(fs.readFileSync(h.out, 'utf8'), before); assert.doesNotMatch(repeat.stdout, /新增：|更新：|已删除/);
});

test('--dry-run 不创建文件，也不修改已有文件', (t) => {
  const h = sandbox(t), r = h.run('--dry-run'); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(h.out), false); assert.ok(r.stdout.endsWith('只预览，没有写入文件\n'));
  fs.writeFileSync(h.out, JSON.stringify({ thresholds: { strong: 84, mid: 75 }, dimensions: Object.keys(SCORES), sources: {}, models: {} }));
  const before = fs.readFileSync(h.out, 'utf8'); assert.equal(h.run('--dry-run').status, 0);
  assert.equal(fs.readFileSync(h.out, 'utf8'), before);
});

test('无表头时采用默认顺序，并接受连续空格分隔', (t) => {
  const h = sandbox(t);
  fs.writeFileSync(h.input, fs.readFileSync(h.input, 'utf8').split('\n').slice(1).join('\n').replace(/\t/g, '  '));
  const r = h.run(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.read().models['claude-fable-5-1'].scores, SCORES);
});

test('有表头时按列名确定分数顺序', (t) => {
  const h = sandbox(t);
  fs.writeFileSync(h.input, 'Model\tOverall\tReasoning\tDesign\tCoding\tBrowser Use\tData Analysis\tResearch\tAgentic\tCost per Successful Task\n▸\nClaude Fable 5.1\n85.7\t91.7\t83.4\t97.7\t89.8\t80.3\t82.0\t77.9\t$6.904\n');
  const r = h.run(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.read().models['claude-fable-5-1'].scores, SCORES);
});

test('坏块必须报出行号和模型并退出，未匹配的坏块也不能跳过', (t) => {
  const h = sandbox(t);
  for (const scores of ['bad  1  2  3  4  5  6  7  $1', '80  1  $1', '80  1  2  3  4  5  6  7  1', '', '80  1  2  3  4  5  6  7  $1\nextra']) {
    fs.writeFileSync(h.input, `▸\nBad Model\n${scores}\n`);
    const r = h.run(); assert.equal(r.status, 1); assert.match(r.stderr, /第 \d+ 行（Bad Model）/);
    assert.equal(fs.existsSync(h.out), false);
  }
});

test('早于现有数据日期的榜单不导入，来源缺项先报出来，都不改文件', (t) => {
  const newer = { as_of: '2026-11-01', thresholds: { strong: 84, mid: 75 }, dimensions: Object.keys(SCORES), sources: {}, models: {} };
  const h = sandbox(t, newer), r = h.run();
  assert.equal(r.status, 1); assert.match(r.stderr, /--date 2026-10-27 早于现有数据的日期 2026-11-01/);
  assert.deepEqual(h.read(), newer);
  const orphan = { thresholds: { strong: 84, mid: 75 }, dimensions: Object.keys(SCORES), sources: {}, models: { 'glm-5.2': { ...LEGACY, source: 'legacy-2026-10-01' } } };
  const o = sandbox(t, orphan), r2 = o.run();
  assert.equal(r2.status, 1); assert.match(r2.stderr, /glm-5\.2（legacy-2026-10-01）/);
  assert.deepEqual(o.read(), orphan);
});
