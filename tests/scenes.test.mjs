import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, baseConfig, apiAgent, hostArgs, seedRun, json, read, write, ROOT, MESSAGES } from './helpers.mjs';
import { review } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const block = (names = ['code', 'research']) => `<!-- foreman:scenes -->\n${names.map((name) => `- **${name}**：规则`).join('\n')}\n<!-- /foreman:scenes -->`;
const prefs = (h, text = block()) => write(path.join(path.dirname(h.userConfig), 'preferences.md'), text);
const planArgs = (h, module = 'review', cell = 'complex', seats = ['codex']) => ['plan', '--cwd', h.cwd, '--module', module, '--cell', cell,
  '--group', 'scenes', ...seats.flatMap((seat) => ['--seat', seat]), ...(module === 'review' ? ['--target', 'claims', '--file', h.write('claims.txt', '待审主张')] : [])];
const sceneArgs = ['--scene', 'code', '--scene-why', '偏好中的代码规则'];
const config = () => {
  const c = baseConfig(); c.modules.default.review.gap = { simple: false, normal: false, complex: false }; return c;
};

test('场景只读独占行标记中的名称，项目块替换用户块，空块关闭场景', async (t) => {
  const h = sandbox(t), user = prefs(h, '- **outside**: 忽略\n' + block() + '\n- **tail**: 忽略');
  const url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs')).href;
  const script = h.write('read-scenes.mjs', `import { readScenes } from ${JSON.stringify(url)}; console.log(JSON.stringify(readScenes(process.cwd())));`);
  assert.deepEqual(output(await h.start(script).done), { names: ['code', 'research'], source: 'user', file: user, problems: [], inactive: [] });
  const project = h.write('.claude/foreman.md', '普通项目偏好');
  assert.equal(output(await h.start(script).done).source, 'user');
  write(project, '  <!-- foreman:scenes -->  \n- **local-2**: 规则\n  <!-- /foreman:scenes -->  ');
  assert.deepEqual(output(await h.start(script).done), { names: ['local-2'], source: 'project', file: project, problems: [], inactive: [] });
  write(project, block([]));
  assert.deepEqual(output(await h.start(script).done), { names: [], source: 'project', file: project, problems: [], inactive: [] });
  write(project, '<!-- foreman:scenes -->');
  const invalid = output(await h.start(script).done);
  assert.equal(invalid.source, 'project'); assert.deepEqual(invalid.problems, [M.scenesBlockInvalid(project, M.scenesBlockUnpaired)]);
});

test('场景块记录不配对、多块、非法名称（含中文名）和重名', async (t) => {
  const h = sandbox(t), file = prefs(h);
  const url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs')).href;
  const script = h.write('read-scenes.mjs', `import { readScenes } from ${JSON.stringify(url)}; console.log(JSON.stringify(readScenes(null)));`);
  for (const [text, reason] of [
    ['<!-- /foreman:scenes -->\n<!-- foreman:scenes -->', M.scenesBlockUnpaired],
    [block() + '\n' + block(), M.scenesBlockMultiple],
    [block(['Code']), M.scenesBadName('Code')], [block(['code_name']), M.scenesBadName('code_name')],
    [block(['2code']), M.scenesBadName('2code')], [block(['代码']), M.scenesBadName('代码')], [block(['code', 'code']), M.scenesDuplicate('code')], [block(['default']), M.scenesReserved('default')], [block(['review']), M.scenesReserved('review')],
  ]) {
    write(file, text);
    assert.ok(output(await h.start(script).done).problems.includes(M.scenesBlockInvalid(file, reason)));
  }
});

test('平铺 modules 与补 seats/gap/watch 共用一次迁移、备份和权限，项目只在内存迁移', async (t) => {
  const h = sandbox(t), c = config(); c.modules = c.modules.default;
  delete c.modules.review.gap; delete c.modules.discuss.seats; delete c.dispatch.watch;
  h.config(c); const before = read(h.userConfig), bak = h.userConfig + '.bak';
  const results = await Promise.all([h.bridge(['config']), h.bridge(['config'])]);
  for (const r of results) assert.deepEqual(output(r).resolved_modules.review.gap, { simple: false, normal: false, complex: true });
  assert.equal(read(bak), before);
  assert.equal(results.filter((r) => r.stderr.includes(M.configScenesWritten(h.userConfig, bak))).length, 1);
  assert.ok(json(h.userConfig).modules.default.discuss.seats);
  assert.equal((await h.bridge(['config'])).stderr, '');
  const project = h.write('.claude/foreman.json', { modules: { run: { complex: 'claude code' } } }), raw = read(project);
  const r = await h.bridge(['config', '--cwd', h.cwd]);
  assert.equal(output(r).resolved_modules.run.complex, 'claude code');
  assert.ok(r.stderr.includes(M.projectModulesFlat(project))); assert.equal(read(project), raw);
});

test('平铺迁移写入失败只补内存，保留原文且释放锁', async (t) => {
  const h = sandbox(t), c = config(); c.modules = c.modules.default; h.config(c);
  const before = read(h.userConfig), url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs')).href;
  const script = h.write('readonly-config.mjs', `import fs from 'node:fs';
const original = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => { if (String(file).endsWith('.tmp')) throw new Error('synthetic write failure'); return original(file, ...args); };
const { loadConfig } = await import(${JSON.stringify(url)});
const { adapters } = await import(${JSON.stringify(new URL('./adapters/index.mjs', url).href)});
console.log(JSON.stringify(loadConfig(null, adapters)));`);
  const r = await h.start(script).done, loaded = output(r);
  assert.deepEqual(loaded.modules, loaded.scene_modules.default);
  assert.equal(loaded.modules.run.complex[0].agent, 'codex');
  assert.ok(r.stderr.includes('synthetic write failure')); assert.equal(read(h.userConfig), before);
});

test('modules 拒绝混写、缺 default、非法场景名和旧 seats/gap 对象，错误不改写', async (t) => {
  const h = sandbox(t);
  for (const [modules, message] of [
    [{ default: {}, run: {} }, M.modulesMixed('modules')], [{ code: {} }, M.modulesDefaultMissing('modules')],
    [{ default: {}, Code: {} }, M.configInvalid('modules.Code', M.scenesBadName('Code'))],
    [{ default: {}, code: null }, M.configInvalid('modules.code', M.invalid.object)],
    [{ default: null }, M.configInvalid('modules.default', M.invalid.object)],
  ]) {
    h.config({ ...config(), modules }); const before = read(h.userConfig);
    failed(await h.bridge(['config']), message); assert.equal(read(h.userConfig), before);
  }
  for (const scene of ['default', 'code']) for (const [field, value] of [['seats', { code: 1 }], ['seats', 0], ['gap', { code: false }], ['gap', 0]]) {
    const c = config(); c.modules[scene] ??= { review: {} }; c.modules[scene].review[field] = { complex: value }; h.config(c);
    failed(await h.bridge(['config']), M.configInvalid(`modules.${scene}.review.${field}.complex`, M.invalid[field]));
  }
});

test('场景视图整格替换、继承其余格子，seats/gap 按级合并，resolved_scenes 只列差异', async (t) => {
  const h = sandbox(t), c = config(); prefs(h); c.agents.second = { ...c.agents.codex, model: 'second' };
  c.modules.code = { review: { complex: [{ agent: 'second', effort: 'high', required: true }], seats: { complex: 1 }, gap: { complex: true } } };
  c.modules.research = { review: { simple: c.modules.default.review.simple } }; h.config(c);
  const out = output(await h.bridge(['config']));
  assert.deepEqual(out.effective.modules.code.review.normal, out.effective.modules.default.review.normal);
  assert.deepEqual(out.effective.modules.code.review.seats, { simple: 1, normal: 2, complex: 1 });
  assert.deepEqual(out.effective.modules.code.run, out.effective.modules.default.run);
  assert.deepEqual(out.resolved_scenes, { code: { review: { complex: [{ agent: 'second', model: 'second', effort: 'high', required: true, tier: null }], seats: { complex: 1 }, gap: { complex: true } } } });
  assert.ok(!out.summary.warnings.some((w) => w.kind === 'unused_agent' && w.agent === 'second'));
  const url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs')).href;
  const script = h.write('views.mjs', `import { loadConfig, sceneView, isScened } from ${JSON.stringify(url)};
import { adapters } from ${JSON.stringify(new URL('./adapters/index.mjs', url).href)};
const c = loadConfig(null, adapters); console.log(JSON.stringify({ code: sceneView(c, 'code').modules, changes: ['complex', 'normal'].map(cell => isScened(c, 'review', cell)) }));`);
  const loaded = output(await h.start(script).done);
  assert.deepEqual(loaded.code, out.effective.modules.code); assert.deepEqual(loaded.changes, [true, false]);
});

test('每个完整场景视图校验能力、必选与席位，错误路径包含场景', async (t) => {
  const h = sandbox(t); prefs(h);
  for (const [modules, message] of [
    [{ review: { complex: [{ agent: 'codex', required: true }, { agent: 'second', required: true }], seats: { complex: 1 } } }, M.seatsBelowRequired('modules.code.review.seats.complex', 1, 2)],
    [{ run: { complex: [{ agent: 'codex', required: true }, { agent: 'second', required: true }] } }, M.configInvalid('modules.code.run.complex', M.invalid.oneRequired)],
    [{ run: { complex: [{ agent: 'api' }] } }, M.configInvalid('modules.code.run.complex[0].agent', M.modeNotSupported('api', 'api', 'run', 'discuss'))],
  ]) {
    const c = config(); c.agents.second = { ...c.agents.codex }; c.agents.api = apiAgent('http://127.0.0.1:1'); c.modules.code = modules; h.config(c);
    failed(await h.bridge(['config']), message);
  }
});

test('项目先合成自己的场景视图，再覆盖用户视图；记录路径带场景', async (t) => {
  const h = sandbox(t), c = config(); prefs(h);
  c.agents.second = { ...c.agents.codex, model: 'second' };
  c.modules.code = { run: { complex: [{ agent: 'second' }] }, review: { seats: { complex: 3 }, gap: { complex: true } } }; h.config(c);
  const project = h.write('.claude/foreman.json', { modules: { default: { run: { complex: [{ agent: 'codex', effort: 'low' }] }, review: { seats: { complex: 1 } } },
    code: { review: { gap: { complex: false } } }, research: { review: { seats: { complex: 4 } } } }, dispatch: { timeout_min: 9 } });
  const out = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(out.effective.modules.code.run.complex, [{ agent: 'codex', effort: 'low' }]);
  assert.equal(out.effective.modules.code.review.seats.complex, 1); assert.equal(out.effective.modules.code.review.gap.complex, false);
  assert.equal(out.effective.modules.research.review.seats.complex, 4);
  assert.deepEqual(out.project_config, { path: project, cells: ['default.run.complex', 'default.review.seats.complex', 'code.review.gap.complex', 'research.review.seats.complex', 'dispatch.timeout_min'] });
});

test('一致性问题阻止所有 plan、直派、计划席启动与续接，config/check/status/stats 仍能读', async (t) => {
  const h = sandbox(t), c = config(); prefs(h); h.config(c);
  const p = output(await h.bridge(planArgs(h, 'run')));
  const id = '20000101-000000-scene'; seedRun(h, id, { scene: 'code', session_id: 'fake-session' });
  c.modules.unknown = { review: { seats: { complex: 1 } } }; h.config(c);
  const out = output(await h.bridge(['config'])), message = M.scenesProblem(M.list(out.scenes.problems));
  assert.deepEqual(out.scenes.problems, [M.scenesUndefined('unknown', path.join(path.dirname(h.userConfig), 'preferences.md'), h.userConfig)]);
  for (const module of ['discuss', 'review', 'run', 'image']) {
    const args = module === 'image' ? [...planArgs(h, module, 'draw'), '--route', '4'] : planArgs(h, module);
    failed(await h.bridge(args), message);
  }
  failed(await h.bridge(['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-']), message);
  failed(await h.bridge(['run', '--plan', p.plan_id, '--seat', '1', '--brief', '-']), message);
  failed(await h.bridge(['resume', '--run', id, '--level', 'complex', '--reason', 'rework', '--brief', '-']), message);
  const checked = await h.bridge(['check']); assert.equal(checked.code, 1); assert.equal(JSON.parse(checked.stdout).ok, false);
  output(await h.bridge(['status', '--plan', p.plan_id])); output(await h.bridge(['stats', '--by', 'scene']));
});

test('偏好未配块的场景提醒并按 default 使用；坏块只有 default 时仅提醒', async (t) => {
  const h = sandbox(t), c = config(); h.config(c); const file = prefs(h);
  let r = await h.bridge(['config']), out = output(r);
  assert.ok(r.stderr.includes(M.scenesNoBlock(M.list(['code', 'research']))));
  assert.ok(out.summary.warnings.some((w) => w.kind === 'scenes_unused'));
  const planned = await h.bridge([...planArgs(h, 'run'), ...sceneArgs]), note = M.sceneNotNeeded('modules.run.complex', 'code');
  assert.deepEqual(output(planned).notes, [note]); assert.ok(planned.stderr.includes(note));
  const direct = await h.bridge(['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--no-snapshot', ...sceneArgs]);
  output(direct); assert.ok(direct.stderr.includes(note));
  write(file, block(['default'])); r = await h.bridge(['config']); out = output(r);
  assert.deepEqual(out.scenes.problems, []); assert.ok(r.stderr.includes(M.scenesReserved('default')));
  output(await h.bridge(planArgs(h, 'run')));
  c.modules.code = {}; h.config(c); out = output(await h.bridge(['config']));
  assert.ok(out.scenes.problems.some((p) => p.includes(M.scenesReserved('default'))));
});

test('--scene 对所有模块有效，default 可兜底，场景不同的格子和席位开关都要求理由', async (t) => {
  const h = sandbox(t), c = config(); h.config(c);
  output(await h.bridge([...planArgs(h, 'run'), '--scene', 'default', '--scene-why', '普通任务']));
  failed(await h.bridge([...planArgs(h, 'run'), ...sceneArgs]), M.planSceneNoScenes);
  prefs(h); c.modules.code = { run: { complex: [{ agent: 'codex', effort: 'high' }] }, review: { seats: { complex: 1 } } }; h.config(c);
  for (const module of ['run', 'review']) {
    failed(await h.bridge(planArgs(h, module)), M.sceneRequired(`modules.${module}.complex`, M.list(['default', 'code', 'research']), M.sceneDiff('code', module === 'run' ? M.reportCandidate : 'seats.complex')));
    for (const args of [['--scene', 'code'], ['--scene', 'code', '--scene-why', '  ']]) failed(await h.bridge([...planArgs(h, module), ...args]), M.planSceneWhyRequired);
    failed(await h.bridge([...planArgs(h, module), '--scene-why', '理由']), M.planSceneMissing);
    failed(await h.bridge([...planArgs(h, module), '--scene', 'gone', '--scene-why', '理由']), M.planSceneUnknown('gone', M.list(['default', 'code', 'research'])));
    const p = output(await h.bridge([...planArgs(h, module), ...sceneArgs])); assert.equal(p.scene, 'code');
    assert.equal(p.seats[0].effort, module === 'run' ? 'high' : 'max');
  }
});

test('场景必选名单可不同，少于 default 时输出 notes、stderr，status 返回该场景 required', async (t) => {
  const h = sandbox(t), c = config(); prefs(h); c.agents.second = { ...c.agents.codex, model: 'second' };
  c.modules.default.discuss.complex[0].required = true;
  c.modules.code = { discuss: { complex: [{ agent: 'second', effort: 'high', required: true }] } }; h.config(c);
  const r = await h.bridge([...planArgs(h, 'discuss', 'complex', ['second']), ...sceneArgs]), p = output(r);
  const note = M.sceneDropsRequired('code', 'modules.code.discuss.complex', 'codex');
  assert.deepEqual(p.required, ['second']); assert.deepEqual(p.notes, [note]); assert.ok(r.stderr.includes(note));
  assert.deepEqual(output(await h.bridge(['status', '--plan', p.plan_id])).required, ['second']);
  output(await h.bridge(hostArgs(h, p)));
  failed(await h.bridge(['discuss', '--plan', p.plan_id, '--seat', '1', '--scene', 'code', '--brief', '-']), M.sceneFixedByPlan);
  failed(await h.bridge(['discuss', '--plan', p.plan_id, '--seat', '1', '--scene-why', '理由', '--brief', '-']), M.sceneFixedByPlan);
  c.modules.default.discuss.complex[0].effort = 'low'; h.config(c);
  const { discussion } = await import('./fixtures/reports.mjs'); h.scenario({ last_message: discussion });
  const started = output(await h.bridge(['discuss', '--plan', p.plan_id, '--seat', '1', '--brief', '-']));
  const meta = h.records().find((m) => m.id === started.run_id); assert.equal(meta.agent, 'second'); assert.equal(meta.scene, 'code');
});

test('直派和续接保留场景及理由，换级仍取同一场景；场景消失和重写场景拒绝', async (t) => {
  const h = sandbox(t), c = config(); prefs(h); c.agents.second = { ...c.agents.codex, model: 'second' };
  c.modules.code = { run: { complex: [{ agent: 'second', effort: 'high' }], normal: [{ agent: 'second', effort: 'low' }] } }; h.config(c);
  const args = ['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--no-snapshot'];
  failed(await h.bridge(args), M.sceneRequired('modules.run.complex', M.list(['default', 'code', 'research']), M.sceneDiff('code', M.reportCandidate)));
  failed(await h.bridge([...args, '--scene-why', '理由']), M.planSceneMissing);
  failed(await h.bridge([...args, ...sceneArgs, '--agent', 'codex']), M.agentNotInLevel('codex', 'modules.code.run.complex', 'second'));
  failed(await h.bridge([...args, '--scene', 'default', '--scene-why', '理由', '--agent', 'second']), M.agentNotInLevel('second', 'modules.default.run.complex', 'codex'));
  const first = output(await h.bridge([...args, ...sceneArgs]));
  const resume = ['resume', '--run', first.run_id, '--level', 'normal', '--reason', 'rework', '--brief', '-'];
  failed(await h.bridge([...resume, ...sceneArgs]), M.sceneFixedByPlan);
  failed(await h.bridge([...resume, '--scene-why', '理由']), M.sceneFixedByPlan);
  const again = output(await h.bridge(resume)), meta = h.records().find((m) => m.id === again.run_id);
  assert.equal(meta.scene, 'code'); assert.equal(meta.scene_why, sceneArgs[3]); assert.equal(meta.effort, 'low'); assert.equal(meta.agent, 'second');
  delete c.modules.code; h.config(c); prefs(h, block(['research']));
  failed(await h.bridge(['resume', '--run', again.run_id, '--level', 'normal', '--reason', 'rework', '--brief', '-']), M.resumeSceneGone('code'));
});

test('补漏任意候选可用且不按模型去重计席；CLI 默认模型仍参与补漏查重和 submit', async (t) => {
  const h = sandbox(t), c = config(); prefs(h);
  for (const name of ['second', 'third']) c.agents[name] = { ...c.agents.codex, model: name };
  c.modules.default.review.complex = ['codex', 'second', 'third'].map((agent) => ({ agent }));
  c.modules.code = { review: { seats: { complex: 1 }, gap: { complex: true } } }; h.config(c);
  const args = (seats) => [...planArgs(h, 'review', 'complex', seats), ...sceneArgs];
  failed(await h.bridge(args(['codex'])), M.planGapMissing('modules.code.review.gap.complex', M.list(['second', 'third'])));
  output(await h.bridge([...args(['codex']), '--count-why', '无需补漏']));
  const p = output(await h.bridge(args(['codex', 'third=gap'])));
  failed(await h.bridge(hostArgs(h, p)), M.submitModelForGap(p.plan_id));
  output(await h.bridge([...hostArgs(h, p), '--model', 'third']));
  failed(await h.bridge(['review', '--plan', p.plan_id, '--seat', '2', '--brief', '-']), M.gapSeatSameAsHost(2, 'third'));
  const other = output(await h.bridge(args(['codex', 'third=gap'])));
  output(await h.bridge([...hostArgs(h, other), '--model', 'host-model']));
  failed(await h.bridge(['review', '--plan', other.plan_id, '--seat', '2', '--brief', '-', '--model', 'host-model']), M.gapSeatSameAsHost(2, 'host-model'));
  h.scenario({ last_message: review });
  output(await h.bridge(['review', '--plan', other.plan_id, '--seat', '2', '--brief', '-']));
  failed(await h.bridge([...args(['codex', 'second=gap', 'third=gap']), '--count-why', '理由']), M.planGapMultiple);
  write(path.join(h.home, '.codex/config.toml'), 'model = "shared-default"\n');
  c.agents.bare = { type: 'codex cli' }; c.agents.second.model = 'shared-default';
  c.modules.code.review.complex = [{ agent: 'bare' }, { agent: 'second' }, { agent: 'third' }];
  c.modules.code.review.seats.complex = 2; c.modules.code.review.gap.complex = false; h.config(c);
  assert.equal(output(await h.bridge(args(['bare', 'second']))).seat_target, 2);
  for (const cell of ['simple', 'normal', 'complex']) {
    c.modules.code.review[cell] = c.modules.code.review.complex; h.config(c);
    failed(await h.bridge([...planArgs(h, 'review', cell, ['bare', 'second=gap']), ...sceneArgs, '--count-why', '理由']), M.gapSeatSameModel(2, 'shared-default'));
  }
});

test('Markdown 默认表保持数字，差异场景单列表格含必选和推理强度，check 引用场景专用方', async (t) => {
  const h = sandbox(t), c = config(); prefs(h); c.agents.second = { ...c.agents.codex, model: 'second' };
  c.modules.code = { review: { complex: [{ agent: 'second', effort: 'high', required: true }], seats: { complex: 1 }, gap: { complex: true } } }; h.config(c);
  for (const lang of ['zh', 'en']) {
    const r = await h.bridge(['config', '--format', 'md'], { env: { FOREMAN_LANG: lang } }); assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(MESSAGES[lang].reportSceneTable('code')));
    assert.ok(r.stdout.includes(`| ${MESSAGES[lang].reportModuleNames.review} complex | second · high ★ | 1 |`));
    assert.ok(!r.stdout.includes('| review.normal |'));
  }
  h.scenario({ codex_catalog: { models: ['fake-codex', 'second'].map((slug) => ({ slug, supported_reasoning_levels: ['medium', 'high', 'max'].map((effort) => ({ effort })) })) } });
  const checked = output(await h.bridge(['check']));
  assert.ok(checked.agents.second.efforts.some((v) => v.used_at.includes('modules.code.review.complex[0]')));
  assert.ok(!checked.summary.warnings.some((w) => w.kind === 'unused_agent' && w.agent === 'second'));
  c.modules.code.review.complex[0].model = 'cell-model'; h.config(c);
  const models = output(await h.bridge(['models']));
  assert.ok(models.agents.second.configured_models.includes('cell-model'));
});

test('图像计划也要求场景，启动与计划内续接从计划恢复场景视图', async (t) => {
  const h = sandbox(t), c = config(); prefs(h);
  c.modules.default.image.draw = [{ agent: 'codex', effort: 'max' }];
  c.modules.code = { image: { draw: [{ agent: 'codex', effort: 'high', required: true }] } }; h.config(c);
  const args = [...planArgs(h, 'image', 'draw'), '--route', '4'];
  failed(await h.bridge(args), M.sceneRequired('modules.image.draw', M.list(['default', 'code', 'research']), M.sceneDiff('code', M.reportCandidate)));
  const question = { question: '图像路线', options: ['④ 纯矢量 / 代码'] };
  write(path.join(path.dirname(h.userConfig), 'answers/test-session.jsonl'), JSON.stringify({ event: 'answered', questions: [question], answers: { [question.question]: question.options[0] } }) + '\n');
  const p = output(await h.bridge([...args, ...sceneArgs]));
  assert.deepEqual(p.required, ['codex']); assert.equal(p.seats[0].effort, 'high');
  const launch = ['image', '--plan', p.plan_id, '--seat', '1', '--brief', '-', '--scope', 'out'];
  failed(await h.bridge([...launch, ...sceneArgs]), M.sceneFixedByPlan);
  const first = output(await h.bridge(launch)), meta = h.records().find((m) => m.id === first.run_id);
  assert.equal(meta.scene, 'code');
  const file = path.join(h.runs, first.run_id, 'meta.json'); write(file, { ...json(file), scene: 'research', scene_why: '旧 meta' });
  const again = output(await h.bridge(['resume', '--run', first.run_id, '--reason', 'rework', '--brief', '-']));
  const resumed = h.records().find((m) => m.id === again.run_id);
  assert.equal(resumed.scene, 'code'); assert.equal(resumed.scene_why, sceneArgs[3]); assert.equal(resumed.effort, 'high');
});

test('审查意见回归：新写法缺 gap 不按旧做法补写；计划的场景被删后拒绝启动；模块名不能当场景名；拼错字段只报一次；空 modules 可用', async (t) => {
  const h = sandbox(t), c = config(); delete c.modules.default.review.gap;
  c.modules.code = { review: { gap: { complex: true } } }; h.config(c); prefs(h);
  const out = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(out.resolved_scenes.code.review.gap, { complex: true });
  assert.equal(json(h.userConfig).modules.default.review.gap, undefined);
  // 计划用 code 场景建好以后，偏好里删掉 code，启动计划席要拒绝
  c.modules.default.review.gap = { simple: false, normal: false, complex: false }; c.modules.code = { review: { seats: { complex: 1 } } }; h.config(c);
  const p = output(await h.bridge([...planArgs(h), ...sceneArgs]));
  output(await h.bridge([...hostArgs(h, p), '--model', 'host-model']));
  delete c.modules.code; h.config(c); prefs(h, block(['research']));
  failed(await h.bridge(['review', '--plan', p.plan_id, '--seat', '1', '--brief', '-']), M.planSceneGone(p.plan_id, 'code'));
  // 拼错的字段：default 里写错一次，有两个场景块时也只提醒一次
  c.modules.default.run.complex = [{ agent: 'codex', requird: true }]; c.modules.research = { review: { seats: { complex: 1 } } }; h.config(c);
  const r = await h.bridge(['config', '--cwd', h.cwd]);
  assert.equal(r.stderr.split('requird').length - 1, 1, r.stderr);
  // 项目配置写空的 modules 不报错
  h.write('.claude/foreman.json', { modules: {} });
  output(await h.bridge(['config', '--cwd', h.cwd]));
});

test('场景名 constructor 不会碰到对象原型：没写块时等于 default，写了块时按块合并', async (t) => {
  const h = sandbox(t), c = config(); h.config(c); prefs(h, block(['constructor']));
  output(await h.bridge([...planArgs(h), '--scene', 'constructor', '--scene-why', '规则']));
  c.modules.constructor = { review: { seats: { complex: 1 } } }; h.config(c);
  const out = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(out.resolved_scenes.constructor.review.seats, { complex: 1 });
  output(await h.bridge([...planArgs(h), '--scene', 'constructor', '--scene-why', '规则']));
});

test('项目偏好只启用定义过的用户场景，空块不阻止建计划、直派或续接', async (t) => {
  const h = sandbox(t), c = config(); prefs(h);
  c.agents.second = { ...c.agents.codex, model: 'second' };
  c.modules.code = { review: { seats: { complex: 1 } } };
  c.modules.research = { run: { complex: [{ agent: 'codex', effort: 'low' }] },
    review: { complex: [{ agent: 'codex', required: true }, { agent: 'second', required: true }] } }; h.config(c);
  const file = h.write('.claude/foreman.md', block(['code']));
  h.write('.claude/foreman.json', { modules: { default: { review: { seats: { complex: 1 } } } } });
  for (const lang of ['zh', 'en']) {
    const m = MESSAGES[lang], opts = { env: { FOREMAN_LANG: lang } }, r = await h.bridge(['config', '--cwd', h.cwd], opts), out = output(r);
    assert.deepEqual(out.scenes, { names: ['code'], source: 'project', file, problems: [], inactive: ['research'] });
    assert.deepEqual(Object.keys(out.effective.modules), ['default', 'code']); assert.equal(out.resolved_scenes.research, undefined);
    assert.equal(r.stderr.split(m.scenesInactive('research', file)).length - 1, 1);
    failed(await h.bridge([...planArgs(h, 'run'), '--scene', 'research', '--scene-why', '规则'], opts), m.planSceneInactive('research', file, m.list(['default', 'code'])));
  }
  output(await h.bridge(planArgs(h, 'run')));
  const first = output(await h.bridge(['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--no-snapshot']));
  write(file, block([]));
  const out = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(out.scenes.inactive, ['code', 'research']); assert.deepEqual(out.scenes.problems, []);
  // 空场景块：总配置 md 说这个项目不分场景，不再说要写 --scene
  const md = (await h.bridge(['config', '--cwd', h.cwd, '--format', 'md'])).stdout;
  assert.ok(md.includes(M.sceneSourceNone(file))); assert.equal(md.includes(M.sceneSource(file, 'project')), false);
  output(await h.bridge(planArgs(h))); output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--reason', 'rework', '--brief', '-']));
  h.config(null); output(await h.bridge(['config', '--cwd', h.cwd]));
});

test('项目自己写的未定义场景仍报 problem，指出配置文件；没有偏好块也照旧报错', async (t) => {
  const h = sandbox(t), c = config(); c.modules.research = {}; h.config(c); const user = prefs(h);
  const file = h.write('.claude/foreman.md', block(['code'])), project = h.write('.claude/foreman.json', { modules: { default: {}, research: {} } });
  let out = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(out.scenes.inactive, []); assert.deepEqual(out.scenes.problems, [M.scenesUndefined('research', file, project)]);
  failed(await h.bridge(planArgs(h, 'run')), M.scenesProblem(M.list(out.scenes.problems)));
  write(file, '普通项目偏好'); write(user, '普通用户偏好');
  out = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(out.scenes.problems, [M.scenesUndefined('research', null, project)]);
});

test('场景要求只列当前格子的候选、seats 和 gap 差异，中英都指出所属场景', async (t) => {
  const h = sandbox(t), c = config(); prefs(h); c.agents.second = { ...c.agents.codex };
  c.modules.code = { review: { normal: [{ agent: 'second' }], seats: { normal: 1, complex: 1 } } };
  c.modules.research = { review: { gap: { normal: true } } }; h.config(c);
  for (const lang of ['zh', 'en']) {
    const m = MESSAGES[lang], diffs = m.list([m.sceneDiff('code', m.list([m.reportCandidate.toLowerCase(), 'seats.normal'])), m.sceneDiff('research', 'gap.normal')]);
    failed(await h.bridge(planArgs(h, 'review', 'normal'), { env: { FOREMAN_LANG: lang } }), m.sceneRequired('modules.review.normal', m.list(['default', 'code', 'research']), diffs));
  }
});

test('模型位置只列实际写入的格子，default 带名称，项目覆盖带文件，继承不重复', async (t) => {
  const h = sandbox(t), c = config(), model = 'round29-unrated'; prefs(h);
  c.modules.default.run.complex = [{ agent: 'codex', model }];
  c.modules.code = { review: { normal: [{ agent: 'codex', model }] } };
  c.modules.research = { review: { seats: { complex: 1 } } }; h.config(c);
  const project = h.write('.claude/foreman.json', { modules: { default: { discuss: { normal: [{ agent: 'codex', model }] } },
    code: { review: { complex: [{ agent: 'codex', model }] } } } });
  const out = output(await h.bridge(['config', '--cwd', h.cwd]));
  const expected = [`${project}: modules.default.discuss.normal[0]`, 'modules.default.run.complex[0]', 'modules.code.review.normal[0]', `${project}: modules.code.review.complex[0]`];
  for (const kind of ['unrated_models', 'unpriced_models']) assert.deepEqual(out.summary.warnings.find((w) => w.kind === kind).models.find((m) => m.model === model).used_at, expected);
  assert.equal(out.summary.agents.codex.used_at.some((at) => at.includes('modules.research.')), false);
});
