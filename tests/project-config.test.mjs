import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, baseConfig, opencodeAgent, piAgent, apiAgent, write, read, json, taskArgs, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;
const configArgs = (h) => ['config', '--cwd', h.cwd];

test('项目整格替换候选、顺序、必选、模型和强度，旧代号照常解析', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.second = { ...c.agents.codex }; c.agents.pi = piAgent(); c.agents.oc = opencodeAgent(); c.agents.api = apiAgent('http://127.0.0.1:1');
  c.modules.discuss.complex = [{ agent: 'codex', effort: 'low', required: true }]; h.config(c);
  write(path.join(path.dirname(h.userConfig), 'agent-aliases.json'), { old: 'codex' });
  const entries = [{ agent: 'pi', effort: 'max', required: true }, { agent: 'old', model: 'project-model', effort: 'max' },
    { agent: 'oc', effort: 'high' }, { agent: 'api', effort: 'high' }, { agent: 'second', effort: 'medium' }];
  const file = h.write('.claude/foreman.json', { modules: { discuss: { complex: entries } } }), before = read(file);
  const runs = path.join(h.home, 'project-runs');
  const out = output(await h.bridge(configArgs(h), { env: { FOREMAN_RUNS_DIR: runs } }));
  assert.equal(out.runs_dir, runs); assert.equal(out.effective.dispatch.runs_dir, runs);
  assert.deepEqual(out.effective.modules.discuss.complex, entries.map((item) => ({ ...item, agent: item.agent === 'old' ? 'codex' : item.agent })));
  assert.deepEqual(out.project_config, { path: file, cells: ['discuss.complex'] });
  assert.equal(Object.hasOwn(out, 'project_override'), false); assert.equal(Object.hasOwn(out, 'closed_by_project'), false);
  assert.equal(read(file), before); assert.equal(fs.existsSync(file + '.bak'), false);
});

test('项目按等级覆盖 seats/gap，整级替换场景对象并允许延长所有时长', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.modules.review.seats.complex = { old: 2 }; c.modules.review.gap = { simple: false, normal: false, complex: { old: false } }; h.config(c);
  h.write('.claude/foreman.md', '<!-- foreman:scenes -->\n- **code**: code\n- **research**: research\n<!-- /foreman:scenes -->');
  const file = h.write('.claude/foreman.json', { modules: { review: { seats: { complex: { code: 3, research: 6 } }, gap: { complex: { code: false, research: true }, normal: true } } },
    dispatch: { discuss_max_rounds: 5, timeout_min: 900, stall_min: 80, busy_ask_min: 10 } });
  const out = output(await h.bridge(configArgs(h)));
  assert.deepEqual(out.effective.modules.review.seats, { simple: 1, normal: 2, complex: { code: 3, research: 6 } });
  assert.deepEqual(out.resolved_modules.review.gap, { simple: false, normal: true, complex: { code: false, research: true } });
  for (const [key, value] of Object.entries(json(file).dispatch)) assert.equal(out.effective.dispatch[key], value);
  assert.deepEqual(out.scenes.problems, []);
  assert.deepEqual(out.project_config.cells, ['review.seats.complex', 'review.gap.complex', 'review.gap.normal', 'dispatch.discuss_max_rounds', 'dispatch.timeout_min', 'dispatch.stall_min', 'dispatch.busy_ask_min']);
});

test('项目不允许的顶层字段和 dispatch 字段忽略并提示，max_seats 不生效', async (t) => {
  const h = sandbox(t);
  const ignored = ['agents', 'auto', 'intro', 'dispatch.max_seats', 'dispatch.auto', 'dispatch.watch', 'dispatch.intro', 'dispatch.runs_dir'];
  h.write('.claude/foreman.json', { agents: {}, auto: false, intro: false,
    dispatch: { max_seats: 1, auto: false, watch: {}, intro: false, runs_dir: 'ignored', timeout_min: 20 } });
  const r = await h.bridge(configArgs(h)), out = output(r);
  assert.ok(r.stderr.includes(M.projectIgnored(M.list(ignored))));
  assert.equal(out.effective.dispatch.timeout_min, 20); assert.equal(out.effective.dispatch.auto, true);
  assert.equal(Object.hasOwn(out.effective.dispatch, 'max_seats'), false);
  assert.deepEqual(out.project_config.cells, ['dispatch.timeout_min']);
});

test('旧结构、补 seats 和补 watch 迁移都原样保留废弃 projects，条目不再参与校验', async (t) => {
  const h = sandbox(t), projects = { relative: { levels: { unknown: {} }, agents: null } };
  for (const kind of ['levels', 'seats', 'watch']) {
    const c = baseConfig(); c.projects = projects;
    if (kind === 'levels') { c.levels = c.modules; delete c.modules; }
    if (kind === 'seats') delete c.modules.review.seats;
    if (kind === 'watch') c.dispatch.watch = 'off';
    h.config(c);
    const out = output(await h.bridge(configArgs(h)));
    assert.equal(out.project_config, null); assert.deepEqual(json(h.userConfig).projects, projects);
    assert.equal(out.effective.dispatch.timeout_min, 1);
  }
});

for (const lang of ['zh', 'en']) test('项目校验指出文件和具体字段：' + lang, async (t) => {
  const h = sandbox(t), m = MESSAGES[lang];
  for (const [entry, message] of [
    [{ dispatch: { timeout_min: 0 } }, m.configInvalid('dispatch.timeout_min', m.invalid.minutes)],
    [{ dispatch: { stall_min: -1 } }, m.configInvalid('dispatch.stall_min', m.invalid.minutes)],
    [{ dispatch: { busy_ask_min: '2' } }, m.configInvalid('dispatch.busy_ask_min', m.invalid.minutes)],
    [{ dispatch: { discuss_max_rounds: 0 } }, m.configInvalid('dispatch.discuss_max_rounds', m.invalid.positiveInt)],
    [{ modules: { review: { normal: [{ agent: 'missing' }] } } }, m.unknownAgent('modules.review.normal[0]', 'missing')],
    [{ modules: { review: { normal: [] } } }, m.configInvalid('modules.review.normal', m.invalid.candidates)],
    [{ modules: { unknown: {} } }, m.configInvalid('modules.unknown', m.invalid.module)],
  ]) {
    const file = h.write('.claude/foreman.json', entry), before = read(file);
    failed(await h.bridge(configArgs(h), { env: { FOREMAN_LANG: lang } }), m.projectConfigInvalid(file, message));
    assert.equal(read(file), before);
  }
});

test('项目 levels 只在内存迁移，可以打开用户关掉的执行和图像格子', async (t) => {
  const h = sandbox(t), file = h.write('.claude/foreman.json', { levels: { run: { simple: { agent: 'codex', effort: 'high' } }, image: { generate: { agent: 'codex' } } } }), before = read(file);
  const r = await h.bridge(configArgs(h)), out = output(r);
  assert.deepEqual(out.effective.modules.run.simple, [{ agent: 'codex', effort: 'high' }]);
  assert.deepEqual(out.effective.modules.image.generate, [{ agent: 'codex' }]);
  assert.ok(r.stderr.includes(M.projectOldFormat(file))); assert.equal(read(file), before);
  assert.equal(fs.existsSync(file + '.bak'), false);
});

test('项目配成 Claude Code 后仍可点名派出并续接', async (t) => {
  const h = sandbox(t);
  h.write('.claude/foreman.json', { modules: { run: { complex: 'claude code' } } });
  const first = output(await h.bridge(taskArgs(h, 'run', ['--agent', 'codex', '--no-snapshot'])));
  assert.equal(first.outside_cell, true);
  const again = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-', '--reason', 'rework']));
  assert.equal(again.agent, 'codex'); assert.equal(again.outside_cell, true);
});

for (const lang of ['zh', 'en']) test('废弃 projects 不校验、不生效，每次读取提醒并保留原键：' + lang, async (t) => {
  const h = sandbox(t), c = baseConfig(), m = MESSAGES[lang];
  c.agents.idle = { ...c.agents.codex };
  c.projects = { 'relative/project': { modules: { review: { normal: [{ agent: 'idle' }] } } }, '~/project/': null, [h.cwd]: { dispatch: { timeout_min: 900 } } };
  h.config(c);
  for (let i = 0; i < 2; i++) {
    const r = await h.bridge(configArgs(h), { env: { FOREMAN_LANG: lang } }), out = output(r), keys = Object.keys(c.projects);
    assert.equal(out.effective.dispatch.timeout_min, 1); assert.equal(out.project_config, null);
    assert.deepEqual(out.summary.warnings.find((w) => w.kind === 'obsolete_projects'), { kind: 'obsolete_projects', keys, message: m.obsoleteProjects(m.list(keys)) });
    assert.ok(out.summary.warnings.some((w) => w.kind === 'unused_agent' && w.agent === 'idle'));
    assert.equal(r.stderr.split(m.obsoleteProjects(m.list(keys))).length - 1, 1);
    assert.deepEqual(json(h.userConfig).projects, c.projects);
  }
});
