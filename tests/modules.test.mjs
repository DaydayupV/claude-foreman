import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, baseConfig, read, json, write, opencodeAgent, apiAgent, CODEX, ROOT, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;

test('模块遍历顺序一致，单对象只在内存规范为列表', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.modules.run.complex = { agent: 'codex', effort: 'max' };
  c.modules.discuss.simple = { agent: 'codex' };
  c.modules.image.generate = { agent: 'codex' };
  h.config(c);
  const before = read(h.userConfig), out = output(await h.bridge(['config']));
  assert.equal(out.image_configured, true);
  assert.deepEqual(out.effective.modules.run.complex, [c.modules.run.complex]);
  assert.deepEqual(out.effective.modules.discuss.simple, [c.modules.discuss.simple]);
  assert.deepEqual(out.resolved_modules.image.generate, [{ agent: 'codex', model: 'fake-codex', effort: null, required: false }]);
  assert.equal(read(h.userConfig), before);
  const url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs')).href;
  const script = h.write('cells.mjs', `import { MODULE_CELLS, cellList, eachCell, eachEntry, mapCells } from ${JSON.stringify(url)};
const modules = ${JSON.stringify(out.effective.modules)};
const list = [{ agent: 'codex' }];
console.log(JSON.stringify({ cells: eachCell(modules).map(({ module, cell, key }) => [module, cell, key]),
  entries: eachEntry(modules).map(({ at }) => at), same: cellList(list) === list,
  closed: [cellList(null), cellList('claude code')], mapped: mapCells(modules, (v, { key }) => key), spec: MODULE_CELLS }));`);
  const cells = output(await h.start(script).done);
  assert.equal(cells.same, true);
  assert.deepEqual(cells.closed, [[], []]);
  assert.deepEqual(cells.cells.map(([module, cell]) => `${module}.${cell}`), ['discuss.simple', 'discuss.normal', 'discuss.complex', 'run.simple', 'run.normal', 'run.complex', 'review.simple', 'review.normal', 'review.complex', 'image.generate', 'image.draw']);
  assert.equal(cells.mapped.image.draw, 'modules.image.draw');
  assert.ok(cells.entries.includes('modules.image.generate[0]'));
});

test('levels 迁移一次备份，顺序强度不变且不补格子或 required', async (t) => {
  const h = sandbox(t), c = baseConfig();
  const levels = { discuss: { normal: [{ agent: 'second', effort: 'low' }, { agent: 'codex', effort: 'max' }] }, run: { complex: { agent: 'codex', effort: 'high' } }, review: { simple: { agent: 'second' } } };
  h.config({ agents: { ...c.agents, second: { ...c.agents.codex } }, levels });
  const before = read(h.userConfig), bak = `${h.userConfig}.bak`;
  const results = await Promise.all(Array.from({ length: 4 }, () => h.bridge(['config'])));
  results.forEach((r) => assert.equal(output(r).image_configured, false));
  assert.equal(results.filter((r) => r.stderr.includes(M.configModulesMigrated(h.userConfig, bak))).length, 1);
  assert.equal(results.filter((r) => r.stderr.includes('有一处行为变化')).length, 1);
  assert.equal(read(bak), before);
  assert.deepEqual(json(h.userConfig), { agents: { ...c.agents, second: { ...c.agents.codex } }, levels: M.levelsNote, modules: {
    discuss: levels.discuss, run: { complex: [levels.run.complex] }, review: { simple: [levels.review.simple] },
  } });
  // 说明留在 modules 前面，打开文件先看到它
  assert.deepEqual(Object.keys(json(h.userConfig)), ['agents', 'levels', 'modules']);
  assert.deepEqual(fs.readdirSync(path.dirname(h.userConfig)).filter((name) => name.includes('.bak')), ['config.json.bak']);
  const again = await h.bridge(['config']);
  assert.equal(again.stderr, '');
  assert.equal(output(again).effective.levels, undefined);
});

for (const note of [MESSAGES.zh.levelsNote, MESSAGES.en.levelsNote, '手写的说明']) test(`levels 是说明文字又有 modules 时照常读取，不再迁移（${note.slice(0, 8)}）`, async (t) => {
  const h = sandbox(t), c = baseConfig();
  h.config({ ...c, levels: note });
  const before = read(h.userConfig), r = await h.bridge(['config']), out = output(r);
  assert.equal(r.stderr, '');
  assert.equal(read(h.userConfig), before);
  assert.equal(out.effective.levels, undefined);
  assert.deepEqual(out.resolved_modules.run.complex, [{ agent: 'codex', model: 'fake-codex', effort: 'max', required: false }]);
  assert.equal(fs.existsSync(`${h.userConfig}.bak`), false);
});

test('levels 是字符串却没有 modules 时报错，文件不变', async (t) => {
  const h = sandbox(t);
  h.config({ agents: baseConfig().agents, levels: M.levelsNote });
  const before = read(h.userConfig);
  failed(await h.bridge(['config']), M.configInvalid('levels', M.invalid.object));
  assert.equal(read(h.userConfig), before);
});

test('带说明的文件再次改写旧类型时保留原来的说明', async (t) => {
  const h = sandbox(t), c = baseConfig();
  h.config({ ...c, agents: { codex: { ...c.agents.codex, type: 'codex' } }, levels: '手写的说明' });
  const r = await h.bridge(['config']);
  assert.ok(r.stderr.includes('改成新写法'), r.stderr);
  assert.ok(!r.stderr.includes('levels 改写成 modules'), r.stderr);
  const migrated = json(h.userConfig);
  assert.equal(migrated.levels, '手写的说明');
  assert.deepEqual(Object.keys(migrated).slice(-2), ['levels', 'modules']);
  assert.equal(migrated.agents[Object.keys(migrated.agents)[0]].type, 'codex cli');
});

for (const [name, config] of [
  ['只有旧类型', { agents: { codex: { type: 'codex', bin: CODEX, model: 'demo' } } }],
  ['只有零点十以前的键', { codex_bin: CODEX, model: 'demo', auto_dispatch: true }],
  ['说明是空字符串', { ...baseConfig(), agents: { codex: { ...baseConfig().agents.codex, type: 'codex' } }, levels: '' }],
]) test(`没写 levels 的旧配置改写后也留说明（${name}）`, async (t) => {
  const h = sandbox(t);
  h.config(config);
  output(await h.bridge(['config']));
  const migrated = json(h.userConfig);
  assert.equal(migrated.levels, M.levelsNote);
  assert.deepEqual(Object.keys(migrated).slice(-2), ['levels', 'modules']);
  assert.equal((await h.bridge(['config'])).stderr, '');
});

test('项目配置里的 levels 说明和 modules 同时出现时照常收紧', async (t) => {
  const h = sandbox(t);
  const file = h.write('.claude/foreman.json', { levels: M.levelsNote, modules: { run: { complex: 'claude code' } } });
  const before = read(file), r = await h.bridge(['config', '--cwd', h.cwd]), out = output(r);
  assert.equal(out.effective.modules.run.complex, 'claude code');
  assert.deepEqual(out.closed_by_project, ['run.complex']);
  assert.ok(!r.stderr.includes(M.projectOldFormat(file)), r.stderr);
  assert.equal(read(file), before);
});

test('image_configured 只看用户是否写了图像块，项目配置不影响', async (t) => {
  const h = sandbox(t), c = baseConfig(); delete c.modules.image; h.config(c);
  h.write('.claude/foreman.json', { modules: { image: { generate: [{ agent: 'codex' }] } } });
  let out = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.equal(out.image_configured, false);
  assert.deepEqual(out.resolved_modules.image, { generate: null, draw: null });
  c.modules.image = {}; h.config(c);
  assert.equal(output(await h.bridge(['config', '--cwd', h.cwd])).image_configured, true);
  c.modules.image = { generate: null, draw: null }; h.config(c);
  h.write('.claude/foreman.json', { modules: { image: { generate: null } } });
  out = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.equal(out.image_configured, true);
  assert.deepEqual(out.resolved_modules.image, { generate: null, draw: null });
});

test('已有备份加时间戳，校验失败的 levels 不改原文', async (t) => {
  const h = sandbox(t), c = baseConfig();
  h.config({ agents: c.agents, levels: { run: { complex: { agent: 'codex' } } } });
  write(`${h.userConfig}.bak`, 'earlier backup');
  const before = read(h.userConfig);
  output(await h.bridge(['config']));
  assert.equal(read(`${h.userConfig}.bak`), 'earlier backup');
  const backup = fs.readdirSync(path.dirname(h.userConfig)).find((name) => name.startsWith('config.json.bak-'));
  assert.equal(read(path.join(path.dirname(h.userConfig), backup)), before);
  h.config({ agents: c.agents, levels: { discuss: { normal: [] } } });
  const invalid = read(h.userConfig);
  failed(await h.bridge(['config']), M.configInvalid('modules.discuss.normal', M.invalid.candidates));
  assert.equal(read(h.userConfig), invalid);
});

for (const project of [false, true]) test(`${project ? '项目' : '用户'}不能同时写 levels 和 modules，文件不变`, async (t) => {
  const h = sandbox(t), config = { levels: {}, modules: {} };
  const file = project ? h.write('.claude/foreman.json', config) : (h.config(config), h.userConfig);
  const before = read(file);
  failed(await h.bridge(['config', ...(project ? ['--cwd', h.cwd] : [])]), M.configBothFormats(file));
  assert.equal(read(file), before);
  assert.equal(fs.existsSync(`${file}.bak`), false);
});

for (const [module, cell, value, reason, at = ''] of [
  ['run', 'complex', [], M.invalid.candidates],
  ['image', 'generate', [], M.invalid.imageCandidates],
  ['image', 'draw', 'claude code', M.invalid.imageCandidates],
  ['image', 'generate', 'claude code', M.invalid.imageCandidates],
  ['run', 'complex', null, M.invalid.candidates],
  ['review', 'normal', [{ agent: 'codex' }, { agent: 'codex' }], M.invalid.duplicate, '[1]'],
  ['discuss', 'normal', [{ agent: 'codex', required: 1 }], M.invalid.boolean, '[0].required'],
  ['discuss', 'simple', [{}], M.invalid.agentRef, '[0].agent'],
  ['image', 'generate', [{ agent: 'oc' }], M.imagesNotSupported('oc', 'opencode cli'), '[0].agent'],
  ['image', 'draw', [{ agent: 'oc' }], M.runAccessRequired('oc', 'opencode cli'), '[0].agent'],
]) test(`模块校验 ${module}.${cell} ${JSON.stringify(value)}`, async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.oc = opencodeAgent(); c.agents.api = apiAgent('http://127.0.0.1:1');
  c.modules[module][cell] = value; h.config(c);
  failed(await h.bridge(['config']), M.configInvalid(`modules.${module}.${cell}${at}`, reason));
  assert.equal(h.calls().length, 0);
});

test('modules 的对象校验和用户席位上限校验不绕过配置错误', async (t) => {
  const h = sandbox(t);
  for (const [config, key, reason] of [
    [{ agents: null, modules: { run: { complex: [{ agent: 'codex' }] } } }, 'agents', M.invalid.object],
    [{ modules: null }, 'modules', M.invalid.object],
    [{ dispatch: { max_seats: 0 } }, 'dispatch.max_seats', M.invalid.positiveInt],
  ]) { h.config(config); failed(await h.bridge(['config']), M.configInvalid(key, reason)); }
});

for (const [module, cell] of [['run', 'complex'], ['image', 'generate'], ['image', 'draw']]) test(`${module}.${cell} 最多一个必选`, async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.second = { ...c.agents.codex };
  c.modules[module][cell] = [{ agent: 'codex', required: true }, { agent: 'second', required: true }]; h.config(c);
  failed(await h.bridge(['config']), M.configInvalid(`modules.${module}.${cell}`, M.invalid.oneRequired));
});

for (const module of ['discuss', 'review']) test(`${module} 的必选数不能超过 max_seats，项目配置只按更严的值`, async (t) => {
  const h = sandbox(t), c = baseConfig(), cwdArgs = ['config', '--cwd', h.cwd];
  c.agents.second = { ...c.agents.codex }; c.agents.third = { ...c.agents.codex };
  c.modules[module].complex = [{ agent: 'codex', required: true }, { agent: 'second', required: true }, { agent: 'third', required: true }];
  c.dispatch.max_seats = 2; h.config(c);
  failed(await h.bridge(['config']), M.configInvalid(`modules.${module}.complex`, M.requiredOverSeats(3, 2)));
  // 项目配置调高席位不生效，照样报用户配置的错
  h.write('.claude/foreman.json', { dispatch: { max_seats: 9 } });
  failed(await h.bridge(cwdArgs), M.configInvalid(`modules.${module}.complex`, M.requiredOverSeats(3, 2)));
  // 必选数等于上限可以；项目调低到必选数以下要报错
  c.dispatch.max_seats = 3; h.config(c);
  assert.equal(output(await h.bridge(cwdArgs)).effective.dispatch.max_seats, 3);
  h.write('.claude/foreman.json', { dispatch: { max_seats: 2 } });
  failed(await h.bridge(cwdArgs), M.projectSeatsBelowRequired(2, `modules.${module}.complex`, 3));
  // 项目把这一格关掉后没有必选了，调低照常生效
  h.write('.claude/foreman.json', { dispatch: { max_seats: 2 }, modules: { [module]: { complex: 'claude code' } } });
  assert.equal(output(await h.bridge(cwdArgs)).effective.dispatch.max_seats, 2);
});

for (const [module, cell, reason] of [['unknown', 'simple', M.invalid.module], ['image', 'complex', M.invalid.imageCell], ['run', 'draw', M.invalid.level]]) test(`拒绝未知模块或格子 ${module}.${cell}`, async (t) => {
  const h = sandbox(t); h.config({ modules: { [module]: { [cell]: null } } });
  failed(await h.bridge(['config']), M.configInvalid(module === 'unknown' ? 'modules.unknown' : `modules.${module}.${cell}`, reason));
});

test('图像引用参与旧类型改名、去重与 codex 保留判断', async (t) => {
  const h = sandbox(t);
  h.config({ agents: { codex: { type: 'codex', bin: CODEX, model: 'image-model' }, same: { type: 'codex', bin: CODEX, model: 'image-model' } },
    modules: { image: { generate: [{ agent: 'codex' }, { agent: 'same' }], draw: { agent: 'codex', effort: 'high' } } } });
  const out = output(await h.bridge(['config']));
  assert.deepEqual(Object.keys(out.effective.agents), ['image-model']);
  assert.deepEqual(out.effective.modules.image.generate, [{ agent: 'image-model' }]);
  assert.deepEqual(out.effective.modules.image.draw, [{ agent: 'image-model', effort: 'high' }]);
  assert.deepEqual(json(path.join(path.dirname(h.userConfig), 'agent-aliases.json')), { codex: 'image-model', same: 'image-model' });
  assert.deepEqual(out.summary.agents['image-model'].used_at, ['modules.image.generate[0]', 'modules.image.draw[0]']);
});

test('check 和 summary 覆盖仅用于图像的协作方、强度和 shell 提醒', async (t) => {
  const h = sandbox(t);
  h.config({ agents: { codex: baseConfig().agents.codex, oc: { ...opencodeAgent(), run_access: 'shell' } },
    modules: { image: { generate: [{ agent: 'codex', effort: 'high', required: true }], draw: [{ agent: 'oc', effort: 'low' }] } } });
  const out = output(await h.bridge(['check']));
  assert.equal(out.ok, true);
  assert.deepEqual(out.agents.oc.variants[0].used_at, ['modules.image.draw[0]']);
  assert.equal(out.summary.modules.image.generate[0].required, true);
  assert.ok(out.summary.warnings.some((w) => w.kind === 'shell_access' && w.agent === 'oc'));
  assert.ok(h.calls().some((call) => call.operation === 'sandbox'));
  assert.ok(!out.summary.warnings.some((w) => w.kind === 'unused_agent'));
});
