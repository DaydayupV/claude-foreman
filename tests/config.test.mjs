import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, read, json, write, baseConfig as oldBaseConfig, apiAgent, opencodeAgent, CODEX, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;
const baseConfig = () => {
  const c = oldBaseConfig();
  c.modules.default.review.gap = { simple: false, normal: false, complex: true };
  return c;
};

test('没有用户配置时生成初始配置并提示首次使用', async (t) => {
  const h = sandbox(t, { config: false });
  const r = await h.bridge(['config']);
  const c = output(r);
  assert.equal(c.image_configured, true);
  assert.equal(c.user_config, h.userConfig);
  assert.equal(c.effective.modules.default.run.simple, 'claude code');
  assert.equal(c.effective.modules.default.run.normal, 'claude code');
  assert.deepEqual(c.effective.agents, {});
  const saved = json(h.userConfig);
  assert.deepEqual(c.effective.dispatch.watch, { terminal: true, web: false });
  assert.equal(Object.hasOwn(saved.dispatch, 'web'), false);
  assert.deepEqual(saved, c.effective);
  assert.equal(r.stderr.split('\n')[0], `foreman: ${M.starterCreated(h.userConfig, M.starterNoCodex + M.starterNext)}`);
  assert.ok(!(await h.bridge(['config'])).stderr.includes('foreman:'));
  assert.equal(h.calls().length, 0);
});

test('零点十以前的配置自动改写并保留原文备份', async (t) => {
  const h = sandbox(t);
  const legacy = { auto_dispatch: false, watch: 'off', codex_bin: CODEX, model: 'legacy-model',
    max_parallel: 2, stall_min: 0, levels: { run: { normal: { effort: 'high' } }, discuss: { simple: { effort: 'low' } } } };
  h.config(legacy);
  const original = read(h.userConfig);
  const r = await h.bridge(['config']);
  const c = output(r), migrated = json(h.userConfig);
  assert.equal(read(`${h.userConfig}.bak`), original);
  assert.equal(migrated.auto_dispatch, undefined);
  assert.equal(migrated.agents['legacy-model'].bin, CODEX);
  assert.equal(c.effective.dispatch.auto, false);
  assert.deepEqual(c.effective.dispatch.watch, { terminal: false, web: false });
  assert.deepEqual(migrated.dispatch.watch, c.effective.dispatch.watch);
  assert.equal(Object.hasOwn(migrated.dispatch, 'web'), false);
  assert.deepEqual(c.resolved_modules.run.normal, [{ agent: 'legacy-model', model: 'legacy-model', effort: 'high', required: false, tier: null }]);
  assert.deepEqual(c.resolved_modules.discuss.simple, [{ agent: 'legacy-model', model: 'legacy-model', effort: 'low', required: false, tier: null }]);
  assert.ok(r.stderr.includes(M.configStructureMigrated(h.userConfig, `${h.userConfig}.bak`, 'codex → legacy-model')));
  await h.bridge(['config']);
  assert.equal(read(`${h.userConfig}.bak`), original);
});

for (const [name, change, key, reason] of [
  ['未知协作方类型被拒绝', (c) => { c.agents.codex.type = 'unknown'; }, 'agents.codex.type', M.invalid.agentType],
  ['执行等级不能使用 API 协作方', (c) => {
    c.agents.api = apiAgent('http://127.0.0.1:1');
    c.modules.default = { run: { complex: { agent: 'api', effort: 'high' } } };
  }, 'modules.default.run.complex[0].agent', M.modeNotSupported('api', 'api', 'run', 'discuss')],
  ['opencode 模型必须带厂商斜杠', (c) => { c.agents.oc = { ...opencodeAgent(), model: 'bad-model' }; }, 'agents.oc.model', M.invalid.opencodeModel],
  ['讨论等级不能为空', (c) => { c.modules.default = { discuss: { normal: [] } }; }, 'modules.default.discuss.normal', M.invalid.candidates],
  ['同一讨论等级不能重复参与方', (c) => {
    c.modules.default = { discuss: { normal: [{ agent: 'codex', effort: 'high' }, { agent: 'codex', effort: 'low' }] } };
  }, 'modules.default.discuss.normal[1]', M.invalid.duplicate],
]) {
  test(name, async (t) => {
    const h = sandbox(t), c = baseConfig();
    change(c);
    h.config(c);
    failed(await h.bridge(['config']), M.configInvalid(key, reason));
    assert.equal(h.calls().length, 0);
  });
}

test('格子条目里拼错的字段照常加载，但提醒一句', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.default.run.complex = [{ agent: 'codex', effort: 'high', requird: true }]; h.config(c);
  const r = await h.bridge(['config']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stderr.includes(MESSAGES.zh.unknownEntryField('modules.default.run.complex[0].requird')), r.stderr);
});

test('项目配置忽略不允许的字段并保留允许的覆盖', async (t) => {
  const h = sandbox(t);
  const file = h.write('.claude/foreman.json', {
    unexpected: true, dispatch: { auto: false, runs_dir: 'ignored', timeout_min: 0.5, watch: 'auto', web: true },
    agents: { codex: { bin: 'ignored', model: 'project-model' }, extra: opencodeAgent() },
  });
  const original = read(file), r = await h.bridge(['config', '--cwd', h.cwd]), c = output(r);
  assert.equal(c.effective.dispatch.auto, true);
  assert.deepEqual(c.effective.dispatch.watch, { terminal: false, web: false });
  assert.equal(Object.hasOwn(c.effective.dispatch, 'web'), false);
  assert.equal(c.effective.dispatch.timeout_min, 0.5);
  assert.equal(c.runs_dir, h.runs);
  assert.equal(c.effective.agents.codex.bin, CODEX);
  assert.equal(c.effective.agents.codex.model, 'fake-codex');
  assert.equal(c.effective.agents.extra, undefined);
  assert.ok(r.stderr.includes(M.projectIgnored(M.list(['unexpected', 'dispatch.auto', 'dispatch.runs_dir', 'dispatch.watch', 'agents']))));
  assert.equal(read(file), original);
  assert.equal(fs.existsSync(`${file}.bak`), false);
});

test('项目配置可以把全局已有的 API 或 opencode 加入讨论等级', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.api = apiAgent('http://127.0.0.1:1');
  c.agents.oc = opencodeAgent();
  h.config(c);
  h.write('.claude/foreman.json', { levels: { discuss: { normal: [
    { agent: 'codex', effort: 'high' }, { agent: 'api', effort: null }, { agent: 'oc', effort: null },
  ] } } });
  const r = await h.bridge(['config', '--cwd', h.cwd]);
  assert.deepEqual(output(r).resolved_modules.discuss.normal.map((item) => item.agent), ['codex', 'api', 'oc']);
});

test('config 输出解析后的等级、协作方状态、偏好及记录目录', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.api = apiAgent('http://127.0.0.1:1');
  c.agents.oc = opencodeAgent();
  h.config(c);
  const preference = write(path.join(h.home, '.claude/foreman/preferences.md'), '偏好合成测试');
  const r = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(r.loaded_from, [h.userConfig]);
  assert.deepEqual(r.resolved_modules.discuss.complex, [{ agent: 'codex', model: 'fake-codex', effort: 'max', required: false, tier: null }]);
  assert.deepEqual(r.agents_status.api, { type: 'api', capabilities: { modes: ['discuss', 'review'], isolation: 'none', reads_code: false, reads_images: false, native_schema: false, native_review: false, images: false, resume: true, command_start_events: false }, model: 'fake-api', max_parallel: 4, api_key_env: null, key_set: true, key_source: 'config' });
  assert.equal(r.agents_status.oc.bin, opencodeAgent().bin);
  assert.equal(r.effective.agents.api.api_key, M.keyHidden);
  assert.deepEqual(r.preferences, [{ file: preference, exists: true }, { file: path.join(h.cwd, '.claude/foreman.md'), exists: false }]);
  assert.equal(r.runs_dir, h.runs);
  assert.equal(r.watch_launcher, path.join(h.runs, 'watch.mjs'));
});

test('英文覆盖变量使用英文首次提示', async (t) => {
  const h = sandbox(t, { config: false });
  const r = await h.bridge(['config'], { env: { FOREMAN_LANG: 'en' } });
  output(r);
  assert.equal(r.stderr.split('\n')[0], `foreman: ${MESSAGES.en.starterCreated(h.userConfig, MESSAGES.en.starterNoCodex + MESSAGES.en.starterNext)}`);
  assert.ok(fs.existsSync(h.userConfig));
});

test('加载配置、补写席位和迁移 levels 都写全 watch 两项，重复加载不改写', async (t) => {
  const h = sandbox(t);
  for (const kind of ['current', 'seats', 'levels']) {
    const c = baseConfig();
    c.dispatch.watch = 'off';
    if (kind === 'seats') for (const mode of ['discuss', 'review']) delete c.modules.default[mode].seats;
    if (kind === 'levels') { c.levels = c.modules.default; delete c.modules; }
    h.config(c);
    const original = read(h.userConfig);
    assert.deepEqual(output(await h.bridge(['config'])).effective.dispatch.watch, { terminal: false, web: false });
    assert.equal(Object.hasOwn(json(h.userConfig).dispatch, 'web'), false);
    assert.notEqual(read(h.userConfig), original);
    const savedConfig = json(h.userConfig);
    assert.deepEqual(savedConfig.dispatch.watch, { terminal: false, web: false });
    assert.ok(savedConfig.modules.default.discuss.seats);
    assert.ok(savedConfig.modules.default.review.seats);
    const saved = read(h.userConfig);
    assert.deepEqual(output(await h.bridge(['config'])).effective.dispatch.watch, { terminal: false, web: false });
    assert.equal(read(h.userConfig), saved);
  }
});

test('旧 web 开启后迁移仍保留该值，新项目配置不能关闭它', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.dispatch.watch = 'off';
  c.dispatch.web = true;
  delete c.modules.default.discuss.seats;
  h.config(c);
  const file = h.write('.claude/foreman.json', { dispatch: { watch: { terminal: false, web: false } } }), original = read(file);
  assert.deepEqual(output(await h.bridge(['config', '--cwd', h.cwd])).effective.dispatch.watch, { terminal: false, web: true });
  assert.deepEqual(json(h.userConfig).dispatch.watch, { terminal: false, web: true });
  assert.equal(read(file), original);
  assert.equal(fs.existsSync(`${file}.bak`), false);
});

for (const [dispatch, watch] of [
  [undefined, { terminal: true, web: false }],
  [{}, { terminal: true, web: false }],
  [{ watch: 'auto' }, { terminal: true, web: false }],
  [{ watch: 'off', web: true }, { terminal: false, web: true }],
  [{ web: false }, { terminal: true, web: false }],
  [{ web: true }, { terminal: true, web: true }],
  [{ watch: { terminal: true, web: true }, web: false }, { terminal: true, web: true }],
  [{ watch: { terminal: false, web: false }, web: 'true' }, { terminal: false, web: false }],
]) test(`watch 迁移补默认值并优先使用新对象：${JSON.stringify(dispatch)}`, async (t) => {
  const h = sandbox(t), c = baseConfig();
  if (dispatch === undefined) delete c.dispatch; else c.dispatch = dispatch;
  h.config(c);
  const original = read(h.userConfig);
  assert.deepEqual(output(await h.bridge(['config'])).effective.dispatch.watch, watch);
  assert.deepEqual(json(h.userConfig).dispatch.watch, watch);
  assert.equal(Object.hasOwn(json(h.userConfig).dispatch, 'web'), false);
  assert.equal(read(`${h.userConfig}.bak`), original);
  const saved = read(h.userConfig);
  output(await h.bridge(['config']));
  assert.equal(read(h.userConfig), saved);
  assert.deepEqual(fs.readdirSync(path.dirname(h.userConfig)).filter((name) => name.includes('.bak')), ['config.json.bak']);
});

for (const lang of ['zh', 'en']) test(`watch 严格校验对象、两项布尔值和额外键 (${lang})`, async (t) => {
  const h = sandbox(t);
  for (const watch of [null, true, [], {}, 'invalid', { terminal: true }, { terminal: 'auto', web: false },
    { terminal: true, web: 0 }, { terminal: true, web: false, extra: true }]) {
    const c = baseConfig(); c.dispatch.watch = watch; h.config(c);
    const original = read(h.userConfig);
    failed(await h.bridge(['config'], { env: { FOREMAN_LANG: lang } }), MESSAGES[lang].watchShape);
    assert.equal(read(h.userConfig), original);
    assert.equal(fs.existsSync(`${h.userConfig}.bak`), false);
  }
  const c = baseConfig(); c.dispatch.watch = 'auto'; c.dispatch.web = 'true'; h.config(c);
  failed(await h.bridge(['config'], { env: { FOREMAN_LANG: lang } }), MESSAGES[lang].watchShape);
});
