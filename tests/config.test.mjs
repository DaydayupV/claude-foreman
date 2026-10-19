import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, read, json, write, baseConfig, apiAgent, opencodeAgent, CODEX, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;

test('没有用户配置时生成初始配置并提示首次使用', async (t) => {
  const h = sandbox(t, { config: false });
  const r = await h.bridge(['config']);
  const c = output(r);
  assert.equal(c.image_configured, true);
  assert.equal(c.user_config, h.userConfig);
  assert.equal(c.effective.modules.run.simple, 'claude code');
  assert.equal(c.effective.modules.run.normal, 'claude code');
  assert.deepEqual(c.effective.agents, {});
  assert.deepEqual(json(h.userConfig), c.effective);
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
  assert.deepEqual(c.resolved_modules.run.normal, [{ agent: 'legacy-model', model: 'legacy-model', effort: 'high', required: false }]);
  assert.deepEqual(c.resolved_modules.discuss.simple, [{ agent: 'legacy-model', model: 'legacy-model', effort: 'low', required: false }]);
  assert.ok(r.stderr.includes(M.configStructureMigrated(h.userConfig, `${h.userConfig}.bak`, 'codex → legacy-model')));
  await h.bridge(['config']);
  assert.equal(read(`${h.userConfig}.bak`), original);
});

for (const [name, change, key, reason] of [
  ['未知协作方类型被拒绝', (c) => { c.agents.codex.type = 'unknown'; }, 'agents.codex.type', M.invalid.agentType],
  ['执行等级不能使用 API 协作方', (c) => {
    c.agents.api = apiAgent('http://127.0.0.1:1');
    c.modules = { run: { complex: { agent: 'api', effort: 'high' } } };
  }, 'modules.run.complex[0].agent', M.modeNotSupported('api', 'api', 'run', 'discuss')],
  ['opencode 模型必须带厂商斜杠', (c) => { c.agents.oc = { ...opencodeAgent(), model: 'bad-model' }; }, 'agents.oc.model', M.invalid.opencodeModel],
  ['讨论等级不能为空', (c) => { c.modules = { discuss: { normal: [] } }; }, 'modules.discuss.normal', M.invalid.candidates],
  ['同一讨论等级不能重复参与方', (c) => {
    c.modules = { discuss: { normal: [{ agent: 'codex', effort: 'high' }, { agent: 'codex', effort: 'low' }] } };
  }, 'modules.discuss.normal[1]', M.invalid.duplicate],
]) {
  test(name, async (t) => {
    const h = sandbox(t), c = baseConfig();
    change(c);
    h.config(c);
    failed(await h.bridge(['config']), M.configInvalid(key, reason));
    assert.equal(h.calls().length, 0);
  });
}

test('项目配置忽略不允许的字段并保留允许的覆盖', async (t) => {
  const h = sandbox(t);
  const file = h.write('.claude/foreman.json', {
    unexpected: true, dispatch: { auto: false, runs_dir: 'ignored', timeout_min: 0.5 },
    agents: { codex: { bin: 'ignored', model: 'project-model' }, extra: opencodeAgent() },
  });
  const original = read(file), r = await h.bridge(['config', '--cwd', h.cwd]), c = output(r);
  assert.equal(c.effective.dispatch.auto, true);
  assert.equal(c.effective.dispatch.timeout_min, 0.5);
  assert.equal(c.runs_dir, h.runs);
  assert.equal(c.effective.agents.codex.bin, CODEX);
  assert.equal(c.effective.agents.codex.model, 'fake-codex');
  assert.equal(c.effective.agents.extra, undefined);
  assert.ok(r.stderr.includes(M.projectIgnored(M.list(['unexpected', 'dispatch.auto', 'dispatch.runs_dir', 'agents']))));
  assert.equal(read(file), original);
});

test('项目配置不能把额外的 API 或 opencode 加入讨论等级', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.api = apiAgent('http://127.0.0.1:1');
  c.agents.oc = opencodeAgent();
  h.config(c);
  h.write('.claude/foreman.json', { levels: { discuss: { normal: [
    { agent: 'codex', effort: 'high' }, { agent: 'api', effort: null }, { agent: 'oc', effort: null },
  ] } } });
  const r = await h.bridge(['config', '--cwd', h.cwd]);
  assert.deepEqual(output(r).resolved_modules.discuss.normal, [{ agent: 'codex', model: 'fake-codex', effort: 'high', required: false }]);
  for (const name of ['api', 'oc']) assert.ok(r.stderr.includes(M.projectAgentDropped(name, 'modules.discuss.normal')));
});

test('config 输出解析后的等级、协作方状态、偏好及记录目录', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.api = apiAgent('http://127.0.0.1:1');
  c.agents.oc = opencodeAgent();
  h.config(c);
  const preference = write(path.join(h.home, '.claude/foreman/preferences.md'), '偏好合成测试');
  const r = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(r.loaded_from, [h.userConfig]);
  assert.deepEqual(r.resolved_modules.discuss.complex, [{ agent: 'codex', model: 'fake-codex', effort: 'max', required: false }]);
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
