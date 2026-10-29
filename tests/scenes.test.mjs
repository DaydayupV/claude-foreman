import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, baseConfig, apiAgent, hostArgs, write, ROOT, MESSAGES } from './helpers.mjs';
import { review } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const block = (names = ['code', 'research']) => `<!-- foreman:scenes -->\n${names.map((name) => `- **${name}**：规则`).join('\n')}\n<!-- /foreman:scenes -->`;
const prefs = (h, text = block()) => write(path.join(path.dirname(h.userConfig), 'preferences.md'), text);
const planArgs = (h, module = 'review', cell = 'complex', seats = ['codex']) => ['plan', '--cwd', h.cwd, '--module', module, '--cell', cell,
  '--group', 'scenes', ...seats.flatMap((seat) => ['--seat', seat]), ...(module === 'review' ? ['--target', 'claims', '--file', h.write('claims.txt', '待审主张')] : [])];
const sceneArgs = ['--scene', 'code', '--scene-why', '偏好中的代码规则'];
const config = () => {
  const c = baseConfig(); c.modules.review.gap = { simple: false, normal: false, complex: false }; return c;
};

test('场景只读独占行标记中的名称，项目块替换用户块，空块关闭场景', async (t) => {
  const h = sandbox(t), user = prefs(h, '- **outside**: 忽略\n' + block() + '\n- **tail**: 忽略');
  const url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs')).href;
  const script = h.write('read-scenes.mjs', `import { readScenes } from ${JSON.stringify(url)}; console.log(JSON.stringify(readScenes(process.cwd())));`);
  assert.deepEqual(output(await h.start(script).done), { names: ['code', 'research'], source: 'user', file: user, problems: [] });
  const project = h.write('.claude/foreman.md', '普通项目偏好');
  assert.equal(output(await h.start(script).done).source, 'user');
  write(project, '  <!-- foreman:scenes -->  \n- **local-2**: 规则\n  <!-- /foreman:scenes -->  ');
  assert.deepEqual(output(await h.start(script).done), { names: ['local-2'], source: 'project', file: project, problems: [] });
  write(project, block([]));
  assert.deepEqual(output(await h.start(script).done), { names: [], source: 'project', file: project, problems: [] });
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
    [block(['2code']), M.scenesBadName('2code')], [block(['代码']), M.scenesBadName('代码')], [block(['code', 'code']), M.scenesDuplicate('code')],
  ]) {
    write(file, text);
    assert.ok(output(await h.start(script).done).problems.includes(M.scenesBlockInvalid(file, reason)));
  }
});

test('seats/gap 格式错误在读配置时报错，逐场景席位不能少于必选数', async (t) => {
  const h = sandbox(t);
  for (const [field, value] of [['seats', {}], ['seats', { Code: 1 }], ['seats', { code_name: 2 }], ['seats', { code: 0 }],
    ['gap', 0], ['gap', {}], ['gap', { code: 1 }], ['gap', { code: 'false' }], ['gap', { '2code': true }]]) {
    const c = config(); c.modules.review[field].complex = value; h.config(c);
    failed(await h.bridge(['config']), M.configInvalid('modules.review.' + field + '.complex', M.invalid[field]));
  }
  for (const module of ['discuss', 'run', 'image']) {
    const c = config(); c.modules[module].gap = { simple: false }; h.config(c);
    failed(await h.bridge(['config']), M.gapReviewOnly('modules.' + module + '.gap'));
  }
  const c = config(); c.agents.second = { ...c.agents.codex };
  c.modules.review.complex = [{ agent: 'codex', required: true }, { agent: 'second', required: true }];
  c.modules.review.seats.complex = { code: 1, research: 3 }; h.config(c);
  failed(await h.bridge(['config']), M.seatsBelowRequired('modules.review.seats.complex.code', 1, 2));
});

test('场景一致性五种情况：不阻止 config，warnings 和 check 如实报告', async (t) => {
  const h = sandbox(t), c = config(); h.config(c);
  let out = output(await h.bridge(['config'])); assert.deepEqual(out.scenes, { names: [], source: null, file: null, problems: [] });
  c.modules.review.seats.complex = { code: 1, research: 2 }; h.config(c);
  out = output(await h.bridge(['config']));
  assert.deepEqual(out.scenes.problems, [M.scenesNotDefined('modules.review.seats.complex')]);
  assert.deepEqual(out.summary.warnings.find((w) => w.kind === 'scenes_mismatch').problems, out.scenes.problems);
  for (const module of ['discuss', 'review']) failed(await h.bridge(planArgs(h, module)), M.planScenesProblem(M.list(out.scenes.problems)));
  output(await h.bridge(planArgs(h, 'run')));
  const file = prefs(h, '<!-- foreman:scenes -->'); out = output(await h.bridge(['config']));
  assert.ok(out.scenes.problems.includes(M.scenesNotDefined('modules.review.seats.complex')));
  prefs(h); out = output(await h.bridge(['config'])); assert.deepEqual(out.scenes.problems, []);
  c.modules.review.seats.complex = { code: 1, extra: 2 }; h.config(c);
  out = output(await h.bridge(['config']));
  assert.deepEqual(out.scenes.problems, [M.scenesMismatch('modules.review.seats.complex', file, 'research', 'extra')]);
  const checked = await h.bridge(['check', '--format', 'md']);
  assert.equal(checked.code, 1, checked.stderr); assert.ok(checked.stdout.includes('- ❌ '));
  c.modules.review.seats.complex = 2; h.config(c);
  const unused = await h.bridge(['config']); out = output(unused);
  assert.deepEqual(out.scenes.problems, []); assert.ok(unused.stderr.includes(M.scenesUnused(file, M.list(['code', 'research']))));
  assert.ok(out.summary.warnings.some((w) => w.kind === 'scenes_unused'));
});

test('场景参数只用于讨论审查；拆分等级必填，未拆分等级可以记录，理由不能为空', async (t) => {
  const h = sandbox(t), c = config(); h.config(c);
  for (const module of ['run', 'image']) for (const args of [sceneArgs, ['--scene-why', '理由']]) failed(await h.bridge([...planArgs(h, module), ...args]), M.planSceneModuleOnly);
  failed(await h.bridge([...planArgs(h), ...sceneArgs]), M.planSceneNoScenes);
  prefs(h); c.modules.review.gap.complex = { code: false, research: true }; h.config(c);
  failed(await h.bridge(planArgs(h)), M.planSceneRequired('modules.review.gap.complex', M.list(['code', 'research'])));
  failed(await h.bridge([...planArgs(h), '--scene', 'unknown', '--scene-why', '规则']), M.planSceneUnknown('unknown', M.list(['code', 'research'])));
  for (const args of [['--scene', 'code'], ['--scene', 'code', '--scene-why', '  ']]) failed(await h.bridge([...planArgs(h), ...args]), M.planSceneWhyRequired);
  for (const module of ['discuss', 'review']) {
    const p = output(await h.bridge([...planArgs(h, module), ...sceneArgs]));
    assert.deepEqual([p.scene, p.scene_why, p.gap], ['code', sceneArgs[3], false]);
    const status = output(await h.bridge(['status', '--plan', p.plan_id]));
    assert.deepEqual([status.scene, status.scene_why, status.gap], ['code', sceneArgs[3], false]);
  }
});

test('场景按实际基础模型去重，必选先占位；主协作方比较集合且可用理由跳过', async (t) => {
  const h = sandbox(t), c = config(); prefs(h);
  for (const [name, model] of [['a', 'provider/shared'], ['b', 'different'], ['required', 'required-model']]) c.agents[name] = { ...c.agents.codex, model };
  c.modules.discuss.complex = [{ agent: 'codex', model: 'shared' }, { agent: 'a' }, { agent: 'b' }, { agent: 'required', required: true }];
  c.modules.discuss.seats.complex = { code: 2, research: 8 }; h.config(c);
  const args = (seats) => [...planArgs(h, 'discuss', 'complex', seats), ...sceneArgs];
  const p = output(await h.bridge(args(['codex', 'required']))); assert.equal(p.seat_target, 2);
  output(await h.bridge(args(['required', 'codex'])));
  failed(await h.bridge(args(['a', 'required'])), M.planSeatOrder('modules.discuss.seats.complex.code', M.list(['required', 'codex']), M.list(['a', 'required'])));
  failed(await h.bridge(args(['codex', 'b'])), M.planMissingRequired('modules.discuss.complex', 'required'));
  output(await h.bridge([...args(['a', 'required']), '--count-why', '首选额度用完']));
  const all = output(await h.bridge([...planArgs(h, 'discuss', 'complex', ['codex', 'b', 'required']), '--scene', 'research', '--scene-why', '研究规则']));
  assert.equal(all.seat_target, 3);
});

test('visual 按顺序时只计能看图的候选；普通模式和没拆分的等级不检查候选顺序', async (t) => {
  const h = sandbox(t), c = config(); c.agents.api = apiAgent('http://127.0.0.1:1'); c.agents.second = { ...c.agents.codex, model: 'second' };
  c.modules.review.complex = [{ agent: 'api' }, { agent: 'codex' }, { agent: 'second' }]; c.modules.review.seats.complex = 1; h.config(c);
  output(await h.bridge(planArgs(h, 'review', 'complex', ['second'])));
  prefs(h); h.write('shot.png', Buffer.from([137, 80, 78, 71]));
  output(await h.bridge(planArgs(h, 'review', 'complex', ['second'])));
  c.modules.review.seats.complex = { code: 1, research: 1 }; h.config(c);
  const args = ['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'complex', '--group', 'visual', '--target', 'visual', '--file', 'shot.png', '--seat', 'codex', ...sceneArgs];
  assert.equal(output(await h.bridge(args)).seat_target, 1);
  failed(await h.bridge(args.map((v) => v === 'codex' ? 'second' : v)), M.planSeatOrder('modules.review.seats.complex.code', 'codex', 'second'));
});

test('补漏遵循开关及候选顺序，理由可放行遗漏或换人，但同基础模型始终拒绝', async (t) => {
  const h = sandbox(t), c = config(); prefs(h);
  for (const name of ['second', 'third']) c.agents[name] = { ...c.agents.codex, model: name };
  c.modules.review.complex = ['codex', 'second', 'third'].map((agent) => ({ agent })); c.modules.review.seats.complex = 1;
  c.modules.review.gap.complex = { code: true, research: false }; h.config(c);
  const args = (seats) => [...planArgs(h, 'review', 'complex', seats), ...sceneArgs];
  failed(await h.bridge(args(['codex'])), M.planGapMissing('modules.review.gap.complex.code', M.list(['second', 'third'])));
  output(await h.bridge([...args(['codex']), '--count-why', '这次不补漏']));
  output(await h.bridge(args(['codex', 'second=GaP'])));
  failed(await h.bridge(args(['codex', 'third=补漏'])), M.planGapNotNext('second', 'third'));
  output(await h.bridge([...args(['codex', 'third=gap']), '--count-why', 'second 额度用完']));
  failed(await h.bridge([...args(['codex', 'second=gap', 'third=补漏']), '--count-why', '理由']), M.planGapMultiple);
  c.agents.second.model = c.agents.codex.model; h.config(c);
  for (const cell of ['simple', 'normal', 'complex']) {
    c.modules.review[cell] = c.modules.review.complex; c.modules.review.seats[cell] = 1; h.config(c);
    failed(await h.bridge([...planArgs(h, 'review', cell, ['codex', 'second=gap']), ...sceneArgs, '--count-why', '理由']), M.gapSeatSameModel(2, 'fake-codex'));
  }
});

test('启动补漏席与 submit 登记的 Claude Code 模型比较，不能用启动模型覆盖绕过', async (t) => {
  const h = sandbox(t), c = config(); c.agents.second = { ...c.agents.codex, model: 'claude-opus-4-6' };
  c.modules.review.normal = [{ agent: 'codex' }, { agent: 'second' }]; c.modules.review.seats.normal = 1; c.modules.review.gap.normal = true; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'review', 'normal', ['codex', 'second=gap'])));
  output(await h.bridge([...hostArgs(h, p), '--model', 'anthropic/claude-opus-4.6']));
  const args = ['review', '--plan', p.plan_id, '--seat', '2', '--brief', '-'];
  failed(await h.bridge(args), M.gapSeatSameAsHost(2, 'claude-opus-4-6'));
  failed(await h.bridge([...args, '--model', 'claude-opus-4-6']), M.gapSeatSameAsHost(2, 'claude-opus-4-6'));
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 0);
  const other = output(await h.bridge(planArgs(h, 'review', 'normal', ['codex', 'second=gap'])));
  output(await h.bridge([...hostArgs(h, other), '--model', 'different-host']));
  failed(await h.bridge(['review', '--plan', other.plan_id, '--seat', '2', '--brief', '-', '--model', 'different-host']), M.gapSeatSameAsHost(2, 'different-host'));
  const scenario = h.scenario({ last_message: review });
  output(await h.bridge(['review', '--plan', other.plan_id, '--seat', '2', '--brief', '-'], { env: scenario.env }));
});

test('Markdown 席位、补漏、派法按场景顺序列出，并说明项目覆盖', async (t) => {
  const h = sandbox(t), c = config(); prefs(h);
  c.agents.second = { ...c.agents.codex, model: 'second' }; c.modules.review.complex.push({ agent: 'second' }); h.config(c);
  const project = h.write('.claude/foreman.json', { modules: { review: { seats: { complex: { code: 1, research: 2 } }, gap: { complex: { code: false, research: true } } } } });
  const r = await h.bridge(['config', '--cwd', h.cwd, '--format', 'md']); assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('| 审查 complex | code 1 · research 2 | code 关 · research 开 | 2 | 0 | code：从 2 个候选里挑 1 个；research：2 个候选全上；补漏轮没有剩余模型，不做 |'), r.stdout);
  assert.ok(r.stdout.includes(M.reportProjectConfig(project, M.list(['review.seats.complex', 'review.gap.complex']))));
});

test('场景块写错而配置没有按场景写时只提醒，照常建计划；按场景写了才拦', async (t) => {
  const h = sandbox(t), c = config(); h.config(c); prefs(h, '<!-- foreman:scenes -->\n- **code**：规则');
  const file = path.join(path.dirname(h.userConfig), 'preferences.md');
  const run = await h.bridge(planArgs(h));
  output(run); assert.ok(run.stderr.includes(M.scenesBlockInvalid(file, M.scenesBlockUnpaired)));
  c.modules.review.seats.complex = { code: 1 }; h.config(c);
  failed(await h.bridge(planArgs(h)), M.scenesNotDefined('modules.review.seats.complex'));
});

test('只写 --scene-why 不写 --scene 被拒绝；场景对不上时席位表按配置写的场景名列出', async (t) => {
  const h = sandbox(t), c = config(); h.config(c); prefs(h);
  failed(await h.bridge([...planArgs(h), '--scene-why', '规则']), M.planSceneWhyRequired);
  c.modules.review.seats.complex = { code: 1, extra: 2 }; h.config(c);
  const md = (await h.bridge(['config', '--cwd', h.cwd, '--format', 'md'])).stdout;
  assert.ok(md.includes('code 1 · research — · extra 2') || md.includes('code 1 · extra 2'), md);
  assert.ok(!md.includes('undefined'));
});

test('带补漏席的审查计划 submit 必须写 --model；没写 model 的 Codex 协作方按 Codex 配置的默认模型去重', async (t) => {
  const h = sandbox(t), c = config(); c.agents.second = { ...c.agents.codex, model: 'second' };
  c.modules.review.normal = [{ agent: 'codex' }, { agent: 'second' }]; c.modules.review.seats.normal = 1; c.modules.review.gap.normal = true; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'review', 'normal', ['codex', 'second=gap'])));
  failed(await h.bridge(hostArgs(h, p)), M.submitModelForGap(p.plan_id));
  prefs(h); write(path.join(h.home, '.codex', 'config.toml'), 'model = "shared-default"\n');
  c.agents.bare = { type: 'codex cli' }; c.agents.same = { ...c.agents.codex, model: 'shared-default' };
  c.modules.review.complex = [{ agent: 'bare' }, { agent: 'same' }, { agent: 'second' }];
  c.modules.review.seats.complex = { code: 2, research: 2 }; h.config(c);
  output(await h.bridge([...planArgs(h, 'review', 'complex', ['bare', 'second']), ...sceneArgs]));
  failed(await h.bridge([...planArgs(h, 'review', 'complex', ['bare', 'same']), ...sceneArgs]),
    M.planSeatOrder('modules.review.seats.complex.code', M.list(['bare', 'second']), M.list(['bare', 'same'])));
});
