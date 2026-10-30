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
  c.modules.default.discuss.complex = [{ agent: 'codex', effort: 'low', required: true }]; h.config(c);
  write(path.join(path.dirname(h.userConfig), 'agent-aliases.json'), { old: 'codex' });
  const entries = [{ agent: 'pi', effort: 'max', required: true }, { agent: 'old', model: 'project-model', effort: 'max' },
    { agent: 'oc', effort: 'high' }, { agent: 'api', effort: 'high' }, { agent: 'second', effort: 'medium' }];
  const file = h.write('.claude/foreman.json', { modules: { default: { discuss: { complex: entries } } } }), before = read(file);
  const runs = path.join(h.home, 'project-runs');
  const out = output(await h.bridge(configArgs(h), { env: { FOREMAN_RUNS_DIR: runs } }));
  assert.equal(out.runs_dir, runs); assert.equal(out.effective.dispatch.runs_dir, runs);
  assert.deepEqual(out.effective.modules.default.discuss.complex, entries.map((item) => ({ ...item, agent: item.agent === 'old' ? 'codex' : item.agent })));
  assert.deepEqual(out.project_config, { path: file, cells: ['default.discuss.complex'] });
  assert.equal(Object.hasOwn(out, 'project_override'), false); assert.equal(Object.hasOwn(out, 'closed_by_project'), false);
  assert.equal(read(file), before); assert.equal(fs.existsSync(file + '.bak'), false);
});

test('项目按等级覆盖 default seats/gap，场景块只覆写不同的级，并允许延长所有时长', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.modules.default.review.seats.complex = 2; c.modules.default.review.gap = { simple: false, normal: false, complex: false }; h.config(c);
  h.write('.claude/foreman.md', '<!-- foreman:scenes -->\n- **code**: code\n- **research**: research\n<!-- /foreman:scenes -->');
  const file = h.write('.claude/foreman.json', { modules: { default: { review: { seats: { complex: 3 }, gap: { normal: true } } }, research: { review: { seats: { complex: 6 }, gap: { complex: true } } } },
    dispatch: { discuss_max_rounds: 5, timeout_min: 900, stall_min: 80, busy_ask_min: 10 } });
  const out = output(await h.bridge(configArgs(h)));
  assert.deepEqual(out.effective.modules.default.review.seats, { simple: 1, normal: 2, complex: 3 });
  assert.deepEqual(out.effective.modules.research.review.seats, { simple: 1, normal: 2, complex: 6 });
  assert.deepEqual(out.resolved_modules.review.gap, { simple: false, normal: true, complex: false });
  assert.deepEqual(out.resolved_scenes.research.review.gap, { complex: true });
  for (const [key, value] of Object.entries(json(file).dispatch)) assert.equal(out.effective.dispatch[key], value);
  assert.deepEqual(out.scenes.problems, []);
  assert.deepEqual(out.project_config.cells, ['default.review.seats.complex', 'default.review.gap.normal', 'research.review.seats.complex', 'research.review.gap.complex', 'dispatch.discuss_max_rounds', 'dispatch.timeout_min', 'dispatch.stall_min', 'dispatch.busy_ask_min']);
});

test('项目不允许的顶层字段和 dispatch 字段忽略并提示，max_seats 不生效', async (t) => {
  const h = sandbox(t);
  const ignored = ['agents', 'auto', 'intro', 'dispatch.max_seats', 'dispatch.auto', 'dispatch.watch', 'dispatch.intro', 'dispatch.runs_dir'];
  const file = h.write('.claude/foreman.json', { agents: {}, auto: false, intro: false,
    dispatch: { max_seats: 1, auto: false, watch: {}, intro: false, runs_dir: 'ignored', timeout_min: 20 } });
  const r = await h.bridge(configArgs(h)), out = output(r);
  assert.ok(r.stderr.includes(M.projectIgnored(M.list(ignored), file)));
  assert.deepEqual(out.summary.warnings.find((w) => w.kind === 'project_ignored_keys'), { kind: 'project_ignored_keys', file, keys: ignored, message: M.projectIgnored(M.list(ignored), file) });
  assert.equal(out.effective.dispatch.timeout_min, 20); assert.equal(out.effective.dispatch.auto, true);
  assert.equal(Object.hasOwn(out.effective.dispatch, 'max_seats'), false);
  assert.deepEqual(out.project_config.cells, ['dispatch.timeout_min']);
});

test('旧结构、补 seats 和补 watch 迁移都原样保留废弃 projects，条目不再参与校验', async (t) => {
  const h = sandbox(t), projects = { relative: { levels: { unknown: {} }, agents: null } };
  for (const kind of ['levels', 'seats', 'watch']) {
    const c = baseConfig(); c.projects = projects;
    if (kind === 'levels') { c.levels = c.modules.default; delete c.modules; }
    if (kind === 'seats') delete c.modules.default.review.seats;
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
    [{ modules: { default: { review: { normal: [{ agent: 'missing' }] } } } }, m.unknownAgentProject('modules.default.review.normal[0]', 'missing', h.userConfig)],
    [{ modules: { default: { review: { normal: [] } } } }, m.configInvalid('modules.default.review.normal', m.invalid.candidates)],
    [{ modules: { default: { unknown: {} } } }, m.configInvalid('modules.default.unknown', m.invalid.module)],
    [{ modules: { default: null } }, m.configInvalid('modules.default', m.invalid.object)],
    [{ modules: { default: {}, run: {} } }, m.modulesMixed('modules')],
    [{ modules: { code: {} } }, m.modulesDefaultMissing('modules')],
  ]) {
    const file = h.write('.claude/foreman.json', entry), before = read(file);
    failed(await h.bridge(configArgs(h), { env: { FOREMAN_LANG: lang } }), m.projectConfigInvalid(file, message));
    assert.equal(read(file), before);
  }
});

test('项目 levels 只在内存迁移，可以打开用户关掉的执行和图像格子', async (t) => {
  const h = sandbox(t), file = h.write('.claude/foreman.json', { levels: { run: { simple: { agent: 'codex', effort: 'high' } }, image: { generate: { agent: 'codex' } } } }), before = read(file);
  const r = await h.bridge(configArgs(h)), out = output(r);
  assert.deepEqual(out.effective.modules.default.run.simple, [{ agent: 'codex', effort: 'high' }]);
  assert.deepEqual(out.effective.modules.default.image.generate, [{ agent: 'codex' }]);
  assert.ok(r.stderr.includes(M.projectOldFormat(file))); assert.equal(read(file), before);
  assert.equal(fs.existsSync(file + '.bak'), false);
});

test('项目配成 Claude Code 后仍可点名派出并续接', async (t) => {
  const h = sandbox(t);
  h.write('.claude/foreman.json', { modules: { default: { run: { complex: 'claude code' } } } });
  const first = output(await h.bridge(taskArgs(h, 'run', ['--agent', 'codex', '--no-snapshot'])));
  assert.equal(first.outside_cell, true);
  const again = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-', '--reason', 'rework']));
  assert.equal(again.agent, 'codex'); assert.equal(again.outside_cell, true);
});

for (const lang of ['zh', 'en']) test('废弃 projects 不校验、不生效，每次读取提醒并保留原键：' + lang, async (t) => {
  const h = sandbox(t), c = baseConfig(), m = MESSAGES[lang];
  c.agents.idle = { ...c.agents.codex };
  c.projects = { 'relative/project': { modules: { default: { review: { normal: [{ agent: 'idle' }] } } } }, '~/project/': null, [h.cwd]: { dispatch: { timeout_min: 900 } } };
  h.config(c);
  for (let i = 0; i < 2; i++) {
    const r = await h.bridge(configArgs(h), { env: { FOREMAN_LANG: lang } }), out = output(r), keys = Object.keys(c.projects);
    assert.equal(out.effective.dispatch.timeout_min, 1); assert.equal(out.project_config, null);
    assert.deepEqual(out.summary.warnings.find((w) => w.kind === 'obsolete_projects'), { kind: 'obsolete_projects', keys,
      entries: { ...c.projects, '~/project/': {} }, dropped: {}, message: m.obsoleteProjects(m.list(keys)) });
    assert.ok(out.summary.warnings.some((w) => w.kind === 'unused_agent' && w.agent === 'idle'));
    assert.equal(r.stderr.split(m.obsoleteProjects(m.list(keys))).length - 1, 1);
    assert.ok(r.stderr.includes(lang === 'en' ? '/foreman-en:setup' : '/foreman:setup'));
    assert.deepEqual(json(h.userConfig).projects, c.projects);
  }
});

test('席位数和补漏报错标出项目来源，包括场景继承 default；配置校验也带来源', async (t) => {
  const h = sandbox(t), c = baseConfig();
  for (const name of ['second', 'third']) c.agents[name] = { ...c.agents.codex, model: name };
  c.modules.default.review.complex = ['codex', 'second', 'third'].map((agent) => ({ agent })); h.config(c);
  h.write('.claude/foreman.md', '<!-- foreman:scenes -->\n- **code**: 代码\n<!-- /foreman:scenes -->');
  const file = path.join(h.cwd, '.claude/foreman.json');
  for (const scene of ['default', 'code']) {
    const args = ['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'complex', '--group', 'origins', '--target', 'claims', '--file', h.write('claims.txt', '主张'),
      '--scene', scene, '--scene-why', '规则', '--seat', 'codex'];
    // 报错里写出项目配置实际写的键：场景格子的值来自项目的 default 时写 default 的键
    const key = `modules.${scene}.review`, from = (at) => M.fromProjectConfig(file, at);
    write(file, { modules: { default: { review: { seats: { complex: 1 }, gap: { complex: false } } } } });
    failed(await h.bridge([...args, '--seat', 'second']), M.planSeatCount(`${key}.seats.complex`, 1, 1, 2) + from('modules.default.review.seats.complex'));
    failed(await h.bridge([...args, '--seat', 'second=gap']), M.planGapOff(`${key}.gap.complex`) + from('modules.default.review.gap.complex'));
    const project = { modules: { default: { review: { seats: { complex: 1 } } } } };
    project.modules[scene] ??= { review: {} }; project.modules[scene].review.gap = { complex: true }; write(file, project);
    failed(await h.bridge(args), M.planGapMissing(`${key}.gap.complex`, M.list(['second', 'third'])) + from(`${key}.gap.complex`));
  }
  c.modules.default.review.complex[0].required = c.modules.default.review.complex[1].required = true; h.config(c);
  write(file, { modules: { default: { review: { seats: { complex: 1 } } } } });
  failed(await h.bridge(configArgs(h)), M.projectConfigInvalid(file, M.seatsBelowRequired('modules.default.review.seats.complex', 1, 2) + M.fromProjectConfig(file, 'modules.default.review.seats.complex')));
});

test('废弃项目提醒提供现行迁移内容、丢弃字段，平铺转 default 且不带出 api key', async (t) => {
  const h = sandbox(t), c = baseConfig(), modules = { review: { normal: [{ agent: 'codex', api_key: 'synthetic-nested-key' }] } };
  c.projects = { flat: { modules, agents: { api: { api_key: 'synthetic-project-key' } }, api_key: 'synthetic-top-key',
    dispatch: { discuss_max_rounds: 3, timeout_min: 7, stall_min: 2, busy_ask_min: 1, auto: false, runs_dir: 'ignored' } },
    scenes: { modules: { default: {}, code: { review: { seats: { normal: 1 } } } } } }; h.config(c);
  const r = await h.bridge(configArgs(h)), warning = output(r).summary.warnings.find((w) => w.kind === 'obsolete_projects');
  assert.deepEqual(warning.entries, { flat: { modules: { default: { review: { normal: [{ agent: 'codex' }] } } },
    dispatch: { discuss_max_rounds: 3, timeout_min: 7, stall_min: 2, busy_ask_min: 1 } }, scenes: c.projects.scenes });
  assert.deepEqual(warning.dropped, { flat: ['modules.review.normal[0].api_key', 'agents', 'api_key', 'dispatch.auto', 'dispatch.runs_dir'] });
  assert.equal(/synthetic-(nested|project|top)-key/.test(r.stdout + r.stderr), false);
});
