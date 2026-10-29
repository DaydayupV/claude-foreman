import { D as displayText } from '../foreman/skills/dispatch/scripts/display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, baseConfig, seedRun, write, json, lines, opencodeAgent, apiAgent, ROOT, MESSAGES } from './helpers.mjs';
import { report } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const D = { ...MESSAGES.en, ...displayText }; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套
const scripts = path.join(ROOT, 'foreman/skills/dispatch/scripts');
const labels = ['① 位图', '② 位图 + 矢量混合', '③ 纯矢量（先出参考图）', '④ 纯矢量 / 代码'];
const question = (text = '图像路线：这次选哪条路线？') => ({ question: text, header: '路线', multiSelect: false, options: labels });
const answersFile = (h, session = 'test-session') => path.join(path.dirname(h.userConfig), 'answers', `${session}.jsonl`);
const savedAnswers = (h, records) => write(answersFile(h), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const answer = (h, route = 2, extra = {}) => savedAnswers(h, [{ event: 'answered', at: '2026-10-19T01:02:03.000Z', tool_use_id: 'toolu-route',
  questions: [question()], answers: { [question().question]: labels[route - 1] }, ...extra }]);
const configure = (h) => {
  const c = baseConfig();
  c.modules.default.image = { generate: [{ agent: 'codex', effort: 'medium', required: true }], draw: [{ agent: 'codex', effort: 'max' }] };
  h.config(c);
  return c;
};
const planArgs = (h, cell = 'generate', route = 2, seats = ['codex']) => ['plan', '--cwd', h.cwd, '--module', 'image', '--cell', cell,
  '--group', 'image-group', ...(route == null ? [] : ['--route', route]), ...seats.flatMap((s) => ['--seat', s])];
const launch = (p, extra = []) => ['image', '--plan', p.plan_id, '--seat', '1', '--brief', '-', ...extra];
const noPlans = (h) => {
  assert.equal(fs.existsSync(path.join(h.runs, 'plans')), false);
  assert.equal(h.records().length, 0);
  assert.equal(h.calls().length, 0);
};
const hookInput = (event, route = 2) => ({ session_id: 'test-session', hook_event_name: event, tool_name: 'AskUserQuestion', tool_use_id: 'toolu-route',
  tool_input: { questions: [{ ...question(), options: labels.map((label) => ({ label, description: '合成描述' })) }],
    ...(event === 'PostToolUse' ? { answers: { [question().question]: labels[route - 1] } } : {}) } });

test('图像计划的路线、格子、角色及审查参数错误在确认前拒绝且不落盘', async (t) => {
  const h = sandbox(t); configure(h);
  for (const [args, message] of [
    [planArgs(h, 'generate', null), M.planRouteRequired],
    ...['0', '5', '01', 'bitmap'].map((v) => [planArgs(h, 'generate', v), M.planRouteChoices(v)]),
    [planArgs(h, 'generate', 4), M.planRouteCell('④', 'generate', M.routeUses[4])],
    [planArgs(h, 'draw', 1), M.planRouteCell('①', 'draw', M.routeUses[1])],
    [planArgs(h, 'generate', 2, ['codex=画师']), M.generateNoRoles],
    ...['run', 'review', 'discuss'].map((module) => [planArgs(h).map((v) => v === 'image' ? module : v), M.planRouteImageOnly]),
    ...[['--target', 'files'], ['--file', 'x.svg'], ['--uncommitted'], ['--base', 'HEAD'], ['--commit', 'HEAD']]
      .map((flags) => [[...planArgs(h), ...flags], M.planReviewOnly]),
  ]) failed(await h.bridge(args), message);
  noPlans(h);
});

test('图像计划重验候选、必选、模型和强度，用户和项目空格使用相同提示', async (t) => {
  const h = sandbox(t), c = configure(h); c.agents.second = { ...c.agents.codex };
  c.modules.default.image.generate.push({ agent: 'second' }); h.config(c);
  failed(await h.bridge(planArgs(h, 'generate', 2, ['second'])), M.planMissingRequired('modules.image.generate', 'codex'));
  failed(await h.bridge(planArgs(h, 'generate', 2, ['missing'])), M.agentNotInLevel('missing', 'modules.image.generate', 'codex、second'));
  const entries = c.modules.default.image.generate; c.modules.default.image.generate = null; h.config(c);
  failed(await h.bridge(planArgs(h)), M.planCellClosed('modules.image.generate'));
  c.modules.default.image.generate = entries; h.config(c);
  const project = h.write('.claude/foreman.json', { modules: { default: { image: { generate: null } } } });
  failed(await h.bridge(planArgs(h)), M.planCellClosed('modules.image.generate'));
  fs.unlinkSync(project); noPlans(h); answer(h);
  const p = output(await h.bridge(planArgs(h))), saved = json(p.file);
  write(p.file, { ...saved, route: 4 });
  failed(await h.bridge(launch(p)), M.planRouteCell('④', 'generate', M.routeUses[4]));
  write(p.file, saved);
  for (const entry of [{ ...entries[0], effort: 'high' }, { ...entries[0], model: 'other-model' }]) {
    c.modules.default.image.generate = [entry]; h.config(c);
    failed(await h.bridge(launch(p)), M.planSeatChanged(p.plan_id, 1, 'modules.image.generate'));
  }
  assert.equal(h.records().length, 0); assert.equal(h.calls().length, 0);
});

test('generate 依赖完整出图接口，draw 依赖 run 能力和 tools 执行授权', async (t) => {
  const h = sandbox(t), c = configure(h); c.agents.oc = opencodeAgent(); c.agents.api = apiAgent('http://127.0.0.1:1'); h.config(c);
  const url = (name) => JSON.stringify(pathToFileURL(path.join(scripts, name)).href);
  const script = h.write('capability.mjs', `import assert from 'node:assert/strict';
import { loadConfig, validatePlan, resolveProfile, canGenerate, ROUTE_CELLS } from ${url('config.mjs')};
import { adapters } from ${url('adapters/index.mjs')};
const mode = process.argv[2], codex = adapters['codex cli'];
assert.deepEqual(ROUTE_CELLS, { 1: ['generate'], 2: ['generate', 'draw'], 3: ['generate', 'draw'], 4: ['draw'] });
assert.equal(canGenerate(codex), true);
for (const images of [undefined, { list() {} }, { calls() {} }]) assert.equal(canGenerate({ capabilities: { images: true }, images }), false);
if (mode === 'config') { codex.images.calls = null; loadConfig(null, adapters); }
const cfg = loadConfig(null, adapters);
if (mode === 'generate') { codex.capabilities.modes = []; validatePlan(cfg, { module: 'image', cell: 'generate', route: 1, seats: [{ agent: 'codex' }] }, adapters); }
if (mode === 'plan' || mode === 'resume') {
  codex.images.list = null;
  if (mode === 'plan') validatePlan(cfg, { module: 'image', cell: 'generate', route: 1, seats: [{ agent: 'codex' }] }, adapters);
  else resolveProfile(cfg, { module: 'image', cell: 'generate', plan: 'p', seat: 1 }, {}, adapters, null, 'codex', 'generate');
}
if (mode === 'draw' || mode === 'draw-api') {
  const agent = mode === 'draw' ? 'oc' : 'api'; cfg.modules.image.draw = [{ agent }];
  validatePlan(cfg, { module: 'image', cell: 'draw', route: 4, seats: [{ agent }] }, adapters);
}`);
  failed(await h.start(script, ['config']).done, M.configInvalid('modules.default.image.generate[0].agent', M.imagesNotSupported('codex', 'codex cli')));
  for (const mode of ['plan', 'resume']) failed(await h.start(script, [mode]).done, M.imagesNotSupported('codex', 'codex cli'));
  assert.equal((await h.start(script, ['generate']).done).code, 0);
  failed(await h.start(script, ['draw']).done, M.runAccessRequired('oc', 'opencode cli'));
  failed(await h.start(script, ['draw-api']).done, M.modeNotSupported('api', 'api', 'run', M.list(['discuss', 'review'])));
});

test('图像计划只认当前会话最近一次已回答且明确选中的路线', async (t) => {
  const h = sandbox(t); configure(h);
  failed(await h.bridge(planArgs(h), { env: { CLAUDE_CODE_SESSION_ID: '' } }), M.routeNoSession);
  failed(await h.bridge(planArgs(h)), M.routeNotAsked);
  answer(h, 1);
  failed(await h.bridge(planArgs(h)), M.routeMismatch('①', 2));
  answer(h, 2, { answers: { [question().question]: '我想先看看效果' } });
  failed(await h.bridge(planArgs(h)), M.routeNotChosen('我想先看看效果'));
  answer(h, 2, { answers: { [question().question]: '② 我自己写的选项' } });
  failed(await h.bridge(planArgs(h)), M.routeNotChosen('② 我自己写的选项'));
  answer(h, 2, { questions: [{ ...question(), multiSelect: true }] });
  failed(await h.bridge(planArgs(h)), M.routeNotChosen(labels[1]));
  const older = { event: 'answered', tool_use_id: 'old', questions: [question()], answers: { [question().question]: labels[1] } };
  const asked = { event: 'asked', tool_use_id: 'new', questions: [question()] };
  savedAnswers(h, [older, asked]);
  failed(await h.bridge(planArgs(h)), M.routeNotAnswered);
  savedAnswers(h, [older, asked, { ...asked, event: 'answered', answers: {} }]);
  failed(await h.bridge(planArgs(h)), M.routeNotAnswered);
  noPlans(h);
});

test('一次路线回答支持两格、多交付物和重复计划，无标记弹窗不影响', async (t) => {
  const h = sandbox(t); configure(h); answer(h);
  const generate = output(await h.bridge(planArgs(h))), draw = output(await h.bridge(planArgs(h, 'draw', 2, ['codex=描线'])));
  for (const p of [generate, draw]) {
    assert.equal(p.module, 'image'); assert.equal(p.level, null); assert.equal(p.route, 2);
    assert.deepEqual(p.route_confirmation, { tool_use_id: 'toolu-route', question: question().question, answer: labels[1], answered_at: '2026-10-19T01:02:03.000Z' });
    assert.ok(p.commands[0].includes(' image --plan ')); assert.ok(p.commands[0].endsWith(`--scope "${M.planPlaceholders.outDir}"`));
  }
  assert.equal(generate.seats[0].model, 'fake-codex'); assert.equal(generate.seats[0].effort, 'medium'); assert.equal(draw.seats[0].role, '描线');
  const second = question('第二个交付物：选哪条？'); second.header = 'IMAGE ROUTE';
  savedAnswers(h, [{ event: 'answered', at: 'now', tool_use_id: 'two', questions: [question(), second],
    answers: { [question().question]: labels[0], [second.question]: ` ${labels[3]} ` } },
  { event: 'asked', tool_use_id: 'unrelated', questions: [{ question: '选择字体', header: '字体', options: ['A'] }] }]);
  assert.equal(output(await h.bridge(planArgs(h, 'generate', 1))).route, 1);
  const pure = output(await h.bridge(planArgs(h, 'draw', 4)));
  assert.equal(pure.route, 4); assert.deepEqual(pure.required, []); assert.equal(pure.route_confirmation.question, second.question);
  assert.equal(output(await h.bridge(planArgs(h, 'draw', 4))).route, 4);
});

test('路线按 asked 顺序决定，迟到的回答不覆盖新弹窗，漏记 asked 时仍认 answered', async (t) => {
  const h = sandbox(t); configure(h);
  const a = { event: 'asked', tool_use_id: 'A', questions: [question()] }, b = { ...a, tool_use_id: 'B' };
  const replied = { ...a, event: 'answered', answers: { [question().question]: labels[1] } };
  savedAnswers(h, [a, b, replied]);
  failed(await h.bridge(planArgs(h)), M.routeNotAnswered); noPlans(h);
  savedAnswers(h, [replied]);
  assert.equal(output(await h.bridge(planArgs(h))).route_confirmation.tool_use_id, 'A');
});

test('plan 拒绝非法会话 ID，即使路径外确有有效的路线回答', async (t) => {
  const h = sandbox(t); configure(h); answer(h);
  write(path.join(path.dirname(h.userConfig), 'outside.jsonl'), fs.readFileSync(answersFile(h)));
  failed(await h.bridge(planArgs(h), { env: { CLAUDE_CODE_SESSION_ID: '../outside' } }), M.routeNoSession);
  noPlans(h);
});

test('路线钩子 Pre/Post 输入到建计划端到端，保留必要字段且不保存其他回答', async (t) => {
  const h = sandbox(t); configure(h);
  const pre = hookInput('PreToolUse'), post = hookInput('PostToolUse');
  const other = { question: '你喜欢什么字体？', header: '字体', options: [{ label: 'secret' }], multiSelect: false };
  pre.tool_input.questions.push(other); post.tool_input.questions.push(other);
  post.tool_response = { answers: { [question().question]: labels[1], [other.question]: 'private answer' } };
  post.tool_input.answers[question().question] = labels[0];
  for (const input of [pre, post]) {
    const r = await h.hook('record-answers.mjs', input);
    assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  }
  const records = lines(answersFile(h));
  assert.deepEqual(records.map((r) => r.event), ['asked', 'answered']);
  assert.ok(records.every((r) => r.tool_use_id === 'toolu-route' && Number.isFinite(Date.parse(r.at))));
  assert.deepEqual(records[0].questions, [{ question: question().question, header: '路线', multiSelect: false, options: labels }]);
  assert.deepEqual(records[1].answers, { [question().question]: labels[1] });
  assert.ok(!fs.readFileSync(answersFile(h), 'utf8').includes('private answer'));
  assert.equal(output(await h.bridge(planArgs(h))).route_confirmation.answer, labels[1]);
  const latest = hookInput('PreToolUse'); latest.tool_use_id = 'toolu-cancelled';
  await h.hook('record-answers.mjs', latest);
  failed(await h.bridge(planArgs(h)), M.routeNotAnswered);
});

test('路线钩子忽略无标记、非目标工具及非法会话，坏 JSON 静默退出', async (t) => {
  const h = sandbox(t, { config: false });
  const unmarked = hookInput('PostToolUse'); unmarked.tool_input.questions[0].question = '选择字体';
  for (const input of [unmarked, { ...hookInput('PostToolUse'), tool_name: 'Bash' },
    ...['../escape', '', 'x'.repeat(129)].map((session_id) => ({ ...hookInput('PostToolUse'), session_id }))]) {
    const r = await h.hook('record-answers.mjs', input);
    assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  }
  const bad = await h.start(path.join(ROOT, 'foreman/hooks/record-answers.mjs'), [], { input: '{broken' }).done;
  assert.equal(bad.code, 0); assert.equal(bad.stdout, ''); assert.equal(bad.stderr, '');
  assert.equal(fs.existsSync(path.dirname(h.userConfig)), false);
});

test('路线钩子回退回答、记录取消及自定义目录，清理失败也不丢记录', async (t) => {
  const h = sandbox(t), custom = path.join(h.home, 'custom/config.json'), dir = path.join(path.dirname(custom), 'answers');
  const old = write(path.join(dir, 'old.jsonl'), '{}\n'), keep = write(path.join(dir, 'keep.jsonl'), '{}\n');
  const ignored = write(path.join(dir, 'old.txt'), 'keep'); const age = new Date(Date.now() - 31 * 86400000);
  fs.utimesSync(old, age, age); fs.utimesSync(ignored, age, age);
  const blocked = path.join(dir, 'undeletable.jsonl'); fs.mkdirSync(blocked); fs.utimesSync(blocked, age, age);
  for (const input of [hookInput('PostToolUse'), { ...hookInput('PostToolUse'), tool_input: { questions: hookInput('PreToolUse').tool_input.questions } }]) {
    const r = await h.hook('record-answers.mjs', input, { env: { FOREMAN_CONFIG: custom } }); assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  }
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(keep), true); assert.equal(fs.existsSync(ignored), true);
  assert.equal(fs.statSync(blocked).isDirectory(), true);
  assert.deepEqual(lines(path.join(dir, 'test-session.jsonl')).map((r) => r.answers), [{ [question().question]: labels[1] }, {}]);
  const legacy = path.join(h.home, 'legacy/config.json');
  await h.hook('record-answers.mjs', hookInput('PostToolUse'), { env: { CODEX_BRIDGE_CONFIG: legacy } });
  assert.equal(lines(path.join(path.dirname(legacy), 'answers/test-session.jsonl')).length, 1);
});

test('image 只从计划启动并要求 scope，generate 的元数据、执行结果和显示完整', async (t) => {
  const h = sandbox(t); configure(h); answer(h, 1);
  failed(await h.bridge(['image']), M.imageNeedsPlan);
  const p = output(await h.bridge(planArgs(h, 'generate', 1)));
  for (const [args, message] of [
    [[...launch(p), '--level', 'generate'], M.imageNoLevel], [launch(p), M.imageNeedsScope],
    [[...launch(p), '--agent', 'codex'], M.planAgentFlag],
  ]) failed(await h.bridge(args), message);
  const wrong = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'run', '--cell', 'complex', '--group', 'other', '--seat', 'codex']));
  failed(await h.bridge(launch(wrong)), M.planModuleMismatch(wrong.plan_id, 'run', 'image'));
  const s = h.scenario({ images: ['picture.png'] });
  const execution = await h.bridge(launch(p, ['--scope', 'out', '--title', '合成画面']), { env: s.env }), r = output(execution);
  for (const record of [r, json(path.join(r.run_dir, 'meta.json'))]) {
    assert.deepEqual([record.module, record.cell, record.step, record.route, record.level, record.mode, record.kind], ['image', 'generate', 'generate', 1, null, 'run', 'exec']);
    assert.equal(record.plan, p.plan_id); assert.equal(record.seat, 1);
  }
  assert.equal(r.generated_images.length, 1); assert.equal(path.basename(r.generated_images[0]), 'picture.png');
  assert.ok(!r.warnings.includes(M.imageOutsideModule)); assert.equal(r.changes.available, true);
  assert.ok(execution.stderr.includes(`foreman: image started · fake-codex medium · Codex CLI · generate · route ① · run dir ${r.run_dir}`), execution.stderr);
  assert.ok(!execution.stderr.includes('直接指定推理强度'));
  const list = await h.bridge(['status']);
  assert.match(list.stdout, /\simage\s+✔ done\s+generate\s/); assert.ok(list.stdout.includes(`${D.statusRoute('①')}合成画面`));
  // 时间线的任务行用格子和路线代替等级；详细模式开头照旧
  const watched = await h.bridge(['watch', '--run', r.run_id]);
  assert.ok(watched.stdout.includes(`  ${D.dots(['image', '合成画面', 'generate', 'route ①'])}\n`), watched.stdout);
  const verbose = await h.bridge(['watch', '--run', r.run_id, '--verbose']);
  assert.ok(verbose.stdout.includes(D.watchImageHead('image', '合成画面', 'generate', '①')), verbose.stdout);
  const state = output(await h.bridge(['status', '--plan', p.plan_id]));
  assert.equal(state.state, 'complete'); assert.equal(state.route, 1); assert.equal(state.seats[0].stale, null);
});

test('图像续接沿用格子、路线、计划及席位并排除旧图片，用户和项目空格均拒绝', async (t) => {
  const h = sandbox(t), c = configure(h); answer(h, 2);
  const p = output(await h.bridge(planArgs(h))), firstScenario = h.scenario({ images: ['old.png'] });
  const first = output(await h.bridge(launch(p, ['--scope', 'out']), { env: firstScenario.env }));
  for (const level of ['simple', 'normal', 'complex']) c.modules.default.run[level] = 'claude code'; h.config(c);
  fs.unlinkSync(answersFile(h));
  failed(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--level', 'complex', '--reason', 'rework']), M.imageNoLevel);
  const secondScenario = h.scenario({ images: ['new.png'] }, 'resume');
  const second = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--reason', 'rework', '--track', 'new.svg'], { env: secondScenario.env }));
  assert.equal(json(path.join(second.run_dir, 'meta.json')).resume_reason, 'rework');
  assert.equal(Object.hasOwn(json(path.join(first.run_dir, 'meta.json')), 'resume_reason'), false);
  assert.deepEqual([second.module, second.cell, second.step, second.route, second.level, second.mode, second.plan, second.seat], ['image', 'generate', 'generate', 2, null, 'resume', p.plan_id, 1]);
  assert.deepEqual(second.generated_images.map((p) => path.basename(p)), ['new.png']); assert.equal(second.parent, first.run_id);
  assert.ok((await h.bridge(['status'])).stdout.includes('resume'));
  const watched = await h.bridge(['watch', '--run', second.run_id]);
  // 续接没有记轮次，按续接链数出第 2 轮
  assert.ok(watched.stdout.includes(`  ${D.dots(['image', second.run_id, 'generate', 'route ②', D.watchRound(2)])}\n`), watched.stdout);
  c.agents.second = { ...c.agents.codex }; c.modules.default.image.generate = [{ agent: 'second' }]; h.config(c);
  failed(await h.bridge(['resume', '--run', second.run_id, '--brief', '-', '--reason', 'rework']), M.resumeAgentNotInCell('codex', 'modules.image.generate', 'second'));
  c.modules.default.image.generate = null; h.config(c);
  failed(await h.bridge(['resume', '--run', second.run_id, '--brief', '-', '--reason', 'rework']), M.imageCellClosed('modules.image.generate'));
  c.modules.default.image.generate = [{ agent: 'codex' }]; h.config(c);
  h.write('.claude/foreman.json', { modules: { default: { image: { generate: null } } } });
  failed(await h.bridge(['resume', '--run', second.run_id, '--brief', '-', '--reason', 'rework']), M.imageCellClosed('modules.image.generate'));
});

test('普通执行及其续接出图告警，draw 路线 3/4 检查位图而路线 2 允许混合', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario({ images: ['outside.png'] });
  const run = output(await h.bridge(['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--no-snapshot'], { env: s.env }));
  assert.ok(run.warnings.includes(M.imageOutsideModule));
  const more = h.scenario({ images: ['outside-resume.png'] }, 'more');
  const resumed = output(await h.bridge(['resume', '--run', run.run_id, '--level', 'complex', '--brief', '-', '--reason', 'rework', '--no-snapshot'], { env: more.env }));
  assert.ok(resumed.warnings.includes(M.imageOutsideModule));
  for (const route of [4, 3, 2]) {
    answer(h, route); const p = output(await h.bridge(planArgs(h, 'draw', route)));
    const filename = `out/route-${route}.svg`;
    const draw = h.scenario({ images: [`route-${route}.png`], files: { [filename]: '<svg><image href="data:image/png;base64,A"/></svg>' },
      steps: [{ event: { type: 'item.completed', item: { type: 'file_change', changes: [{ kind: 'add', path: filename }] } } }] }, `draw-${route}`);
    const r = output(await h.bridge(launch(p, ['--scope', 'out']), { env: draw.env }));
    assert.equal(r.warnings.includes(M.vectorRouteImages('④')), route === 4);
    assert.equal(r.warnings.includes(M.vectorEmbedsBitmap('①②③④'[route - 1], filename)), route !== 2);
    assert.ok(!r.warnings.includes(M.imageOutsideModule));
  }
});

test('图像任务沿用执行准入：同组写入范围和协作方并发上限', async (t) => {
  const h = sandbox(t), c = configure(h); answer(h);
  const p = output(await h.bridge(planArgs(h)));
  seedRun(h, '20000101-active', { status: 'running', pid: process.pid, group: p.group, scope: ['out'], agent: 'codex' });
  const overlapping = await h.bridge(launch(p, ['--scope', 'out/parts']));
  assert.equal(overlapping.code, 2); assert.ok(overlapping.stderr.includes('out/parts')); assert.equal(h.calls().length, 0);
  c.agents.codex.max_parallel = 1; h.config(c);
  failed(await h.bridge(launch(p, ['--scope', 'other', '--queue-timeout', '0'])), M.agentFull('codex', 1, 1, '20000101-active'));
});

test('矢量检查排除同组其他席位和范围外的 unknown SVG', async (t) => {
  const h = sandbox(t); configure(h); answer(h, 4);
  const p = output(await h.bridge(planArgs(h, 'draw', 4)));
  seedRun(h, '20000101-peer', { group: p.group, scope: ['peer'], status: 'running', pid: process.pid, ended_at: undefined }); // 和这一席同时在跑
  const s = h.scenario({ files: { 'peer/bitmap.svg': '<svg><image/></svg>', 'outside/bitmap.svg': '<svg><image/></svg>', 'out/own.svg': '<svg><path/></svg>' } });
  const r = output(await h.bridge(launch(p, ['--scope', 'out']), { env: s.env }));
  const peer = r.changes.files.find((f) => f.path === 'peer/bitmap.svg');
  assert.equal(peer.by, 'unknown'); assert.equal(peer.group_run, '20000101-peer');
  assert.ok(!r.warnings.some((w) => w.includes('SVG'))); assert.ok(!r.notes.includes(M.vectorCheckPartial('④')));
});

test('无快照时合并事件和报告的 SVG 并去重，注明部分检查', async (t) => {
  const h = sandbox(t); configure(h); answer(h, 4);
  const p = output(await h.bridge(planArgs(h, 'draw', 4)));
  const s = h.scenario({ files: Object.fromEntries(['event', 'report', 'unlisted'].map((name) => [`out/${name}.svg`, '<svg><image/></svg>'])),
    steps: [{ event: { type: 'item.completed', item: { type: 'file_change', changes: [{ path: path.join(h.cwd, 'out/event.svg'), kind: 'add' }] } } }],
    last_message: { ...report, files_changed: [{ path: 'out/event.svg', change: '重复列出' }, { path: 'out/report.svg', change: '报告列出' }] } });
  const r = output(await h.bridge(launch(p, ['--scope', 'out', '--no-snapshot']), { env: s.env }));
  assert.equal(r.changes.available, false); assert.ok(r.notes.includes(M.vectorCheckPartial('④')));
  assert.deepEqual(r.warnings, [M.vectorEmbedsBitmap('④', M.list(['out/event.svg', 'out/report.svg']))]);
});

test('超过 2 MB 且被 gitignore 忽略的 SVG 仍检查，启动与续接自动跟踪项目内 scope', async (t) => {
  const h = sandbox(t); h.initGit(); configure(h); answer(h, 3); h.write('.gitignore', 'out/\nmore/\n');
  const outside = path.join(h.home, 'external');
  const p = output(await h.bridge(planArgs(h, 'draw', 3)));
  const s = h.scenario({ files: { 'out/large.svg': '<svg>' + ' '.repeat(2 * 1024 * 1024 - 8) + '<ImAgE href="bitmap.png"/></svg>' } });
  const r = output(await h.bridge(launch(p, ['--scope', 'out', '--scope', outside, '--scope', 'out', '--track', 'out']), { env: s.env }));
  assert.equal(fs.statSync(path.join(h.cwd, 'out/large.svg')).size > 2 * 1024 * 1024, true);
  assert.deepEqual(r.track, ['out']); assert.deepEqual(json(path.join(r.run_dir, 'meta.json')).track, ['out']);
  assert.ok(r.changes.files.some((f) => f.path === 'out/large.svg' && f.status === 'A'));
  assert.ok(r.warnings.includes(M.vectorEmbedsBitmap('③', 'out/large.svg')));
  const next = h.scenario({ files: { 'more/resume.svg': '<svg><image/></svg>' } }, 'ignored-resume');
  const resumed = output(await h.bridge(['resume', '--run', r.run_id, '--brief', '-', '--reason', 'rework', '--scope', 'more', '--scope', outside, '--scope', 'more'], { env: next.env }));
  assert.deepEqual(resumed.track, ['out', 'more']);
  assert.ok(resumed.changes.files.some((f) => f.path === 'more/resume.svg'));
  assert.ok(resumed.warnings.includes(M.vectorEmbedsBitmap('③', 'more/resume.svg')));
  assert.deepEqual(h.git(['check-ignore', 'out/large.svg', 'more/resume.svg']).split(/\r?\n/), ['out/large.svg', 'more/resume.svg']);
});

test('漏记提问的旧弹窗再次回答不改顺序，没有 tool_use_id 的记录各算一次，同一弹窗只认最后一条回答', async (t) => {
  const h = sandbox(t); configure(h);
  const replyA = { event: 'answered', tool_use_id: 'A', questions: [question()], answers: { [question().question]: labels[1] } };
  const askB = { event: 'asked', tool_use_id: 'B', questions: [question()] };
  savedAnswers(h, [replyA, askB, replyA]);
  failed(await h.bridge(planArgs(h)), M.routeNotAnswered);
  const { tool_use_id: idA, ...replyNoId } = replyA, { tool_use_id: idB, ...askNoId } = askB;
  savedAnswers(h, [replyNoId]);
  assert.equal(output(await h.bridge(planArgs(h))).route_confirmation.tool_use_id, null);
  savedAnswers(h, [replyNoId, askNoId]);
  failed(await h.bridge(planArgs(h)), M.routeNotAnswered);
  savedAnswers(h, [replyA, { ...replyA, answers: { [question().question]: labels[0] } }]);
  failed(await h.bridge(planArgs(h)), M.routeMismatch('①', 2));
  assert.equal(output(await h.bridge(planArgs(h, 'generate', 1))).route, 1);
  savedAnswers(h, [{ event: 'answered', tool_use_id: 'bad', questions: { question: '图像路线' } }, { event: 'asked', tool_use_id: 'C', questions: [{ ...question(), options: 'none' }] }]);
  failed(await h.bridge(planArgs(h)), M.routeNotAnswered);
});

test('续接沿用 scope 时自己的上一轮不算同组其他任务，脚本写的 SVG 照样检查', async (t) => {
  const h = sandbox(t); configure(h); answer(h, 3);
  const p = output(await h.bridge(planArgs(h, 'draw', 3)));
  const first = output(await h.bridge(launch(p, ['--scope', 'out']), { env: h.scenario({ files: { 'out/first.svg': '<svg><path/></svg>' } }, 'first').env }));
  const next = h.scenario({ files: { 'out/resumed.svg': '<svg><image href="x.png"/></svg>' } }, 'second');
  const r = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--reason', 'rework'], { env: next.env }));
  const file = r.changes.files.find((f) => f.path === 'out/resumed.svg');
  assert.equal(file.by, 'unknown'); assert.equal(file.group_run, undefined);
  assert.ok(r.warnings.includes(M.vectorEmbedsBitmap('③', 'out/resumed.svg')));
  assert.ok(!r.notes.some((n) => n.includes(first.run_id)));
});

test('scope 在工作目录外时注明部分检查，工作目录本身和没被忽略的目录不自动并入改动追踪', async (t) => {
  const h = sandbox(t); h.initGit(); configure(h); answer(h, 4); h.write('.gitignore', 'out/\n');
  const p = output(await h.bridge(planArgs(h, 'draw', 4)));
  const outside = path.join(h.home, 'external');
  const s = h.scenario({ files: { 'web/node_modules/pkg/index.js': 'x', 'out/plain.svg': '<svg><path/></svg>' } });
  const r = output(await h.bridge(launch(p, ['--scope', 'web', '--scope', '.', '--scope', outside, '--scope', 'out']), { env: s.env }));
  assert.deepEqual(r.track, ['out']);
  assert.equal(r.changes.available, true); assert.ok(r.notes.includes(M.vectorCheckPartial('④')));
  assert.ok(!r.changes.files.some((f) => f.path.includes('node_modules')));
});

test('路线钩子在清理时目录读不出来也照样写下这次回答', async (t) => {
  const h = sandbox(t);
  const patch = h.write('fail-readdir.mjs', `import fs from 'node:fs';
const original = fs.readdirSync;
fs.readdirSync = (dir, ...rest) => { if (String(dir).endsWith('answers')) throw Object.assign(new Error('blocked'), { code: 'EACCES' }); return original(dir, ...rest); };
`);
  const r = await h.hook('record-answers.mjs', hookInput('PostToolUse'), { env: { NODE_OPTIONS: `--import=${pathToFileURL(patch).href}` } });
  assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  assert.deepEqual(lines(answersFile(h)).map((x) => x.event), ['answered']);
});

test('会话记录读不出来时 Codex 用量统计返回空，不抛出', async (t) => {
  const h = sandbox(t), d = new Date();
  const dir = path.join(h.env.CODEX_HOME, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  const file = write(path.join(dir, 'rollout-locked-session.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } } }) + '\n');
  const script = h.write('stats.mjs', `import fs from 'node:fs';
import adapter from ${JSON.stringify(pathToFileURL(path.join(scripts, 'adapters/codex-cli.mjs')).href)};
const open = fs.openSync;
fs.openSync = (p, ...rest) => { if (String(p) === process.argv[2]) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return open(p, ...rest); };
process.stdout.write(JSON.stringify(adapter.stats('locked-session', Date.now())));
`);
  const r = await h.start(script, [file]).done;
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, 'null');
});
