import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, baseConfig, seedRun, liveStart, taskArgs, write, json, opencodeAgent, piAgent, apiAgent, ROOT, BRIDGE, MESSAGES } from './helpers.mjs';
import { discussion } from './fixtures/reports.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;
const planArgs = (h, module = 'discuss', seats = ['codex']) => ['plan', '--cwd', h.cwd, '--module', module, '--cell', 'complex', '--group', 'plan-group', ...seats.flatMap((seat) => ['--seat', seat])];
const launch = (plan, module = plan.module, seat = 1) => [module, '--plan', plan.plan_id, '--seat', seat, '--brief', '-'];

for (const module of ['discuss', 'run', 'review']) test(`单席 ${module} 必须选格子并遵守候选和必选`, async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex }; c.agents.third = { ...c.agents.codex };
  c.modules[module].complex = [{ agent: 'codex', effort: 'medium', required: true }, { agent: 'second' }]; h.config(c);
  const scenario = h.scenario({ last_message: discussion }), opts = module === 'discuss' ? { env: scenario.env } : {};
  const args = taskArgs(h, module, module === 'run' ? ['--no-snapshot'] : []);
  for (const extra of [[], ['--effort', 'high'], ['--agent', 'codex', '--effort', 'high']]) failed(await h.bridge([module, '--cwd', h.cwd, '--brief', '-', ...extra], opts), M.missingLevel('simple / normal / complex'));
  failed(await h.bridge([...args, '--agent', 'third'], opts), M.agentNotInLevel('third', `modules.${module}.complex`, 'codex、second'));
  failed(await h.bridge([...args, '--agent', 'second'], opts), M.otherRequired(`modules.${module}.complex`, 'second', 'codex'));
  const selected = output(await h.bridge(args, opts)); assert.equal(selected.agent, 'codex'); assert.equal(selected.effort, 'medium');
  assert.equal(Object.hasOwn(selected, 'outside_cell'), false); assert.equal(Object.hasOwn(selected, 'model_overridden'), false);
  if (module !== 'review') failed(await h.bridge(['resume', '--run', selected.run_id, '--brief', '-'], opts), M.missingLevel('simple / normal / complex'));
  c.modules[module].complex[0].required = false; h.config(c);
  failed(await h.bridge(args, opts), M.agentRequired(`modules.${module}.complex`, 'codex、second'));
  if (module !== 'run') {
    c.modules[module].complex.forEach((entry) => { entry.required = true; }); h.config(c);
    for (const extra of [[], ['--agent', 'codex'], ['--agent', 'second']]) failed(await h.bridge([...args, ...extra], opts), M.severalRequired(`modules.${module}.complex`, 'codex、second'));
  }
});

test('计划先校验格子、候选、必选、席位上限和参数，失败不落盘', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules.discuss.complex = [{ agent: 'codex', required: true }, { agent: 'second' }]; c.dispatch.max_seats = 2; h.config(c);
  const base = planArgs(h);
  for (const [args, message] of [
    [planArgs(h, 'image'), M.planRouteRequired],
    [base.map((v) => v === 'discuss' ? 'wrong' : v), M.planModuleChoices('discuss、run、review、image')],
    [base.map((v) => v === 'complex' ? 'draw' : v), M.planCellChoices('discuss', 'simple、normal、complex')],
    [base.filter((v, i) => i !== base.indexOf('--group') && i !== base.indexOf('--group') + 1), M.missingOpt('group')],
    [planArgs(h, 'discuss', []), M.planNoSeats],
    [planArgs(h, 'discuss', ['codex=']), M.badSeat('codex=')],
    [planArgs(h, 'discuss', ['codex=a=b']), M.badSeat('codex=a=b')],
    [planArgs(h, 'discuss', ['missing']), M.agentNotInLevel('missing', 'modules.discuss.complex', 'codex、second')],
    [planArgs(h, 'discuss', ['second']), M.planMissingRequired('modules.discuss.complex', 'codex')],
    [planArgs(h, 'discuss', ['codex', 'codex', 'second']), M.planTooManySeats(3, 2)],
    [planArgs(h, 'run').map((v) => v === 'complex' ? 'simple' : v), M.planCellClosed('modules.run.simple')],
    [base.map((v) => v === 'plan-group' ? 'bad group' : v), M.badGroupName('bad group')],
  ]) failed(await h.bridge(args), message);
  assert.equal(fs.existsSync(path.join(h.runs, 'plans')), false);
  assert.equal(h.records().length, 0); assert.equal(h.calls().length, 0);
});

test('validatePlan 独立检查执行能力与 tools 的 run_access', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.api = apiAgent('http://127.0.0.1:1'); c.agents.oc = opencodeAgent(); h.config(c);
  const url = (name) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', name)).href;
  const script = h.write('validate-plan.mjs', `import { loadConfig, validatePlan } from ${JSON.stringify(url('config.mjs'))};
import { adapters } from ${JSON.stringify(url('adapters/index.mjs'))};
const cfg = loadConfig(null, adapters), agent = process.argv[2]; cfg.modules.run.complex = [{ agent }];
validatePlan(cfg, { module: 'run', cell: 'complex', seats: [{ agent }] }, adapters);`);
  failed(await h.start(script, ['api']).done, M.modeNotSupported('api', 'api', 'run', 'discuss'));
  failed(await h.start(script, ['oc']).done, M.runAccessRequired('oc', 'opencode cli'));
});

test('计划保存同方多席、角色、理由、默认模型和启动命令，不占任务名额', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.codex.max_parallel = 1; h.config(c);
  seedRun(h, '20000101-active', { status: 'running', pid: process.pid });
  const p = output(await h.bridge([...planArgs(h, 'run', ['codex=实现', 'codex=复核']), '--why', '合成理由']));
  assert.match(p.plan_id, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
  assert.equal(p.cwd, h.cwd); assert.equal(p.level, 'complex'); assert.equal(p.claude_session, 'test-session'); assert.equal(p.why, '合成理由');
  assert.deepEqual(p.seats, ['实现', '复核'].map((role, i) => ({ seat: i + 1, agent: 'codex', role, model: 'fake-codex', effort: 'max', required: false })));
  const { file, commands, ...saved } = p; assert.deepEqual(json(file), saved);
  assert.ok(commands.every((cmd) => cmd.includes(`"${BRIDGE}" run --plan ${p.plan_id}`) && cmd.includes(`--scope "${M.planPlaceholders.scope}"`)));
  assert.equal(h.records().length, 1); assert.equal(fs.existsSync(path.join(h.runs, '.start.lock')), false);
  const status = await h.bridge(['status']); assert.ok(!status.stdout.includes(p.plan_id));
  seedRun(h, '20000101-active', {}, { report: { summary: '合成结果' } });
  const watch = await h.bridge(['watch', '--run', 'last', '--verbose']);
  assert.equal(watch.code, 0);
  assert.ok(watch.stdout.includes('20000101-active')); assert.ok(!watch.stdout.includes(p.plan_id));
});

test('计划启动参数取自计划，配对、席位及不一致参数均拒绝', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h, 'run'))), start = launch(p);
  for (const [args, message] of [
    [['run', '--plan', p.plan_id], M.planNeedsSeat], [['run', '--seat', '1'], M.seatNeedsPlan],
    [['run', '--plan', 'missing', '--seat', '1'], M.planNotFound('missing')],
    [launch(p, 'run', 0), M.planSeatChoices(p.plan_id, 1)], [launch(p, 'run', 2), M.planSeatChoices(p.plan_id, 1)],
    [launch(p, 'run', '1.5'), M.planSeatChoices(p.plan_id, 1)],
    [launch(p, 'review'), M.planModuleMismatch(p.plan_id, 'run', 'review')],
    [[...start, '--agent', 'codex'], M.planAgentFlag], [[...start, '--level', 'simple'], M.planLevelMismatch(p.plan_id, 'complex', 'simple')],
    [[...start, '--cwd', h.home], M.planCwdMismatch(p.plan_id, h.cwd)],
    [[...start, '--group', 'other'], M.planGroupMismatch(p.plan_id, 'plan-group')], [start, M.groupNeedsScope],
  ]) failed(await h.bridge(args), message);
  const r = output(await h.bridge([...start, '--scope', 'src', '--no-snapshot', '--level', 'complex', '--cwd', h.cwd, '--group', 'plan-group', '--effort', 'low', '--model', 'any-model']));
  assert.deepEqual([r.module, r.cell, r.plan, r.seat, r.role, r.group, r.effort, r.model, r.model_overridden], ['run', 'complex', p.plan_id, 1, null, 'plan-group', 'low', 'any-model', true]);
});

test('启动重新校验整份计划，新增必选、移除候选和项目关闭均拒绝', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex }; h.config(c);
  const p = output(await h.bridge(planArgs(h))), args = launch(p);
  c.modules.discuss.complex.push({ agent: 'second', required: true }); h.config(c);
  failed(await h.bridge(args), M.planMissingRequired('modules.discuss.complex', 'second'));
  c.modules.discuss.complex = [{ agent: 'codex', effort: 'max', required: true }]; h.config(c);
  failed(await h.bridge(args), M.planRequiredChanged(p.plan_id, 'modules.discuss.complex'));
  c.modules.discuss.complex = [{ agent: 'second' }]; h.config(c);
  failed(await h.bridge(args), M.agentNotInLevel('codex', 'modules.discuss.complex', 'second'));
  h.config(baseConfig()); h.write('.claude/foreman.json', { modules: { discuss: { complex: 'claude code' } } });
  failed(await h.bridge(args), M.planCellClosedByProject('modules.discuss.complex'));
  assert.equal(h.records().length, 0);
});

test('同一席并发只启动一次，续接沿用计划席位角色且不查其他必选', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules.discuss.complex = [{ agent: 'codex', required: true }, { agent: 'second', required: true }]; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'discuss', ['codex=方案', 'second=质疑']))), scenario = h.scenario({ last_message: discussion });
  const results = await Promise.all([h.bridge(launch(p), { env: scenario.env }), h.bridge(launch(p), { env: scenario.env })]);
  const first = output(results.find((r) => r.code === 0));
  failed(results.find((r) => r.code === 2), M.seatAlreadyStarted(p.plan_id, 1, first.run_id));
  const r = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-'], { env: scenario.env }));
  for (const record of [r, json(path.join(h.runs, r.run_id, 'meta.json'))]) assert.deepEqual([record.module, record.cell, record.plan, record.seat, record.role], ['discuss', 'complex', p.plan_id, 1, '方案']);
  assert.equal(r.parent, first.run_id);
  const status = output(await h.bridge(['status', '--plan', p.plan_id]));
  assert.deepEqual(status.seats[0].runs, [first.run_id, r.run_id]);
  c.modules.discuss.normal = [{ agent: 'codex' }]; h.config(c);
  failed(await h.bridge(['resume', '--run', first.run_id, '--level', 'normal', '--brief', '-']), M.resumePlanCellChanged(p.plan_id, 'complex', 'normal'));
  c.modules.discuss.simple = 'claude code'; h.config(c);
  failed(await h.bridge(['resume', '--run', first.run_id, '--level', 'simple', '--agent', 'codex', '--brief', '-']), M.resumePlanCellChanged(p.plan_id, 'complex', 'simple'));
});

test('无计划续接换格子重验必选，同格返工保留豁免且兼容旧 level', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules.discuss.complex = [{ agent: 'codex' }, { agent: 'second', required: true }]; h.config(c);
  seedRun(h, '20000101-plain', { kind: 'discuss', mode: 'discuss', level: 'simple', status: 'timeout' });
  const args = ['resume', '--run', '20000101-plain', '--level', 'complex', '--brief', '-'];
  failed(await h.bridge(args), M.resumeOtherRequired('modules.discuss.complex', 'codex', 'second'));
  c.modules.discuss.complex[0].required = true; h.config(c);
  failed(await h.bridge(args), M.severalRequired('modules.discuss.complex', 'codex、second'));
  c.modules.discuss.complex = [{ agent: 'codex', required: true }, { agent: 'second' }]; h.config(c);
  const scenario = h.scenario({ last_message: discussion });
  const changed = output(await h.bridge(args, { env: scenario.env }));
  assert.equal(changed.cell, 'complex'); assert.equal(changed.agent, 'codex');
  c.modules.discuss.complex[1].required = true; h.config(c);
  const same = output(await h.bridge(['resume', '--run', changed.run_id, '--level', 'complex', '--brief', '-'], { env: scenario.env }));
  assert.equal(same.parent, changed.run_id);
  c.modules.discuss.simple = [{ agent: 'second' }]; h.config(c);
  failed(await h.bridge(['resume', '--run', '20000101-plain', '--level', 'simple', '--brief', '-']), M.resumeAgentNotInCell('codex', 'modules.discuss.simple', 'second'));
});

test('计划保存的模型和强度必须匹配当前格子，覆盖参数不能绕过重验', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.pi = piAgent();
  c.modules.discuss.complex = [{ agent: 'pi', effort: 'high' }]; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'discuss', ['pi'])));
  const mismatch = M.planSeatChanged(p.plan_id, 1, 'modules.discuss.complex');
  c.agents.pi.model = 'newvendor/model'; h.config(c);
  failed(await h.bridge([...launch(p), '--model', 'fake/other']), mismatch);
  c.agents.pi.model = 'fake/model'; c.modules.discuss.complex[0].model = 'entry/model'; h.config(c);
  failed(await h.bridge(launch(p)), mismatch);
  delete c.modules.discuss.complex[0].model; h.config(c);
  h.write('.claude/foreman.json', { modules: { discuss: { complex: [{ agent: 'pi', effort: 'low' }] } } });
  failed(await h.bridge([...launch(p), '--effort', 'high']), mismatch);
  assert.equal(h.records().length, 0); assert.equal(h.calls().length, 0);
  c.agents.pi.model = 'newvendor/model'; h.config(c);
  const fresh = output(await h.bridge(planArgs(h, 'discuss', ['pi'])));
  assert.deepEqual([fresh.seats[0].model, fresh.seats[0].effort], ['newvendor/model', 'low']);
  failed(await h.bridge([...launch(fresh), '--model', 'fake/other']), M.modelVendorChanged('pi', 'fake/other', 'newvendor/model'));
  const scenario = h.scenario({ last_message: discussion });
  const r = output(await h.bridge([...launch(fresh), '--model', 'newvendor/other'], { env: scenario.env }));
  assert.equal(r.model, 'newvendor/other'); assert.equal(r.model_overridden, true);
});

test('准入拒绝不消耗席位，旧代号的席位按当前代号启动', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.codex.max_parallel = 1; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'run')));
  p.seats[0].agent = 'old'; write(p.file, p); write(path.join(path.dirname(h.userConfig), 'agent-aliases.json'), { old: 'codex' });
  const dir = seedRun(h, '20000101-full', { status: 'running', pid: process.pid });
  const args = [...launch(p), '--scope', 'src', '--no-snapshot'];
  failed(await h.bridge(args), M.agentFull('codex', 1, 1, '20000101-full'));
  assert.equal(h.records().filter((m) => m.plan).length, 0);
  write(path.join(dir, 'meta.json'), { ...json(path.join(dir, 'meta.json')), status: 'done' });
  assert.equal(output(await h.bridge(args)).agent, 'codex');
});

for (const type of ['codex cli', 'opencode cli', 'pi cli', 'api']) test(`模型覆盖规则及标记 ${type}`, async (t) => {
  const h = sandbox(t), c = baseConfig(), api = type === 'api' ? await apiServer(t, [{ answer: discussion }]) : null;
  const agent = type === 'opencode cli' ? opencodeAgent() : type === 'pi cli' ? piAgent() : type === 'api' ? apiAgent(api.url) : c.agents.codex;
  c.agents.selected = agent;
  const restricted = ['opencode cli', 'pi cli'].includes(type), base = restricted ? 'entry/original' : agent.model;
  c.modules.discuss.complex = [{ agent: 'selected', model: base }]; h.config(c);
  if (restricted) failed(await h.bridge(taskArgs(h, 'discuss', ['--model', 'different/model'])), M.modelVendorChanged('selected', 'different/model', base));
  const scenario = h.scenario({ last_message: discussion }), model = restricted ? 'entry/other' : 'different/model';
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--model', model]), { env: scenario.env }));
  assert.equal(r.model, model); assert.equal(r.model_overridden, true);
  assert.equal(json(path.join(h.runs, r.run_id, 'meta.json')).model_overridden, true);
});

test('必选计划的 pending complete incomplete 与最新续接的结果有效性', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.discuss.complex[0].required = true; h.config(c);
  const p = output(await h.bridge(planArgs(h))), status = async () => output(await h.bridge(['status', '--plan', p.plan_id]));
  let out = await status(); assert.equal(out.state, 'pending');
  assert.deepEqual(out.missing_required, [{ seat: 1, agent: 'codex', status: 'not_started' }]);
  assert.deepEqual([out.seats[0].run_id, out.seats[0].ok], [null, null]);
  const meta = { plan: p.plan_id, seat: 1, kind: 'discuss', mode: 'discuss' };
  seedRun(h, '20000101-first', { ...meta, started_at: '2000-01-01T00:00:00Z' }, { report: discussion });
  out = await status(); assert.equal(out.state, 'complete'); assert.deepEqual(out.missing_required, []);
  for (const [statusName, result] of [['failed', {}], ['cancelled', {}], ['quota_exhausted', {}], ['stalled', {}], ['timeout', {}], ['needs_input', {}], ['done', {}], ['done', { report: { status: 'partial' } }], ['done', { report: discussion, needs_decision: true }]]) {
    seedRun(h, '20000101-latest', { ...meta, parent: '20000101-first', status: statusName, started_at: '2000-01-02T00:00:00Z' }, result);
    out = await status(); assert.equal(out.state, 'incomplete'); assert.equal(out.seats[0].ok, false);
    assert.deepEqual(out.missing_required, [{ seat: 1, agent: 'codex', status: statusName }]);
  }
  seedRun(h, '20000101-latest', { ...meta, status: 'running', pid: process.pid, started_at: liveStart(Date.now()) }); // 用测试进程充当活着的 runner，开始时间不能早于它启动
  out = await status(); assert.equal(out.state, 'pending'); assert.equal(out.seats[0].ok, null);
  seedRun(h, '20000101-latest', { ...meta, status: 'running', pid: 2147483647, started_at: '2000-01-02T00:00:00Z' });
  out = await status(); assert.equal(out.state, 'incomplete'); assert.equal(out.seats[0].status, 'interrupted');
});

test('无必选计划要每席结束且至少一席有效，review 允许非空正文', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h, 'review', ['codex', 'codex'])));
  const status = async () => output(await h.bridge(['status', '--plan', p.plan_id]));
  seedRun(h, '20000101-one', { plan: p.plan_id, seat: 1, kind: 'review', mode: 'review' }, { last_message: '有效审查正文' });
  assert.equal((await status()).state, 'pending');
  seedRun(h, '20000101-two', { plan: p.plan_id, seat: 2, kind: 'review', status: 'failed' }, {});
  assert.equal((await status()).state, 'complete');
  write(path.join(h.runs, '20000101-one', 'result.json'), { last_message: '  ' });
  const out = await status(); assert.equal(out.state, 'incomplete'); assert.deepEqual(out.missing_required, []);
});

test('status --plan 列出未启动的补漏和 gap 席，跑完后清空且不改变 state 算法', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules.discuss.complex = [{ agent: 'codex', required: true }, { agent: 'second' }]; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'discuss', ['codex', 'second=补漏', 'second=gap', 'second=复核'])));
  const saved = json(p.file); saved.seats[1].role = ' 补漏 '; saved.seats[2].role = ' GaP '; write(p.file, saved);
  const meta = { plan: p.plan_id, kind: 'discuss', mode: 'discuss' };
  seedRun(h, '20000101-main', { ...meta, seat: 1 }, { report: discussion });
  const status = async () => output(await h.bridge(['status', '--plan', p.plan_id]));
  const before = await status();
  assert.equal(before.state, 'complete');
  assert.deepEqual(before.missing_required, []);
  assert.deepEqual(before.gap_unfinished, [2, 3].map((seat) => ({ seat, agent: 'second', status: 'not_started' })));
  // 跑过但失败、或者结束了却没有有效结果的补漏席，也算没跑完
  seedRun(h, '20000101-gap-2', { ...meta, seat: 2, status: 'failed' }, {});
  seedRun(h, '20000101-gap-3', { ...meta, seat: 3 }, {});
  const ended = await status();
  assert.equal(ended.state, 'complete');
  assert.deepEqual(ended.gap_unfinished, [{ seat: 2, agent: 'second', status: 'failed' }, { seat: 3, agent: 'second', status: 'done' }]);
  for (const seat of [2, 3]) seedRun(h, `20000101-gap-${seat}`, { ...meta, seat }, { report: discussion });
  const after = await status();
  assert.equal(after.state, 'complete');
  assert.deepEqual(after.gap_unfinished, []);
});

test('status --group 计划行显示未启动及运行中的 gap seat not finished', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules.discuss.complex = [{ agent: 'codex', required: true }, { agent: 'second' }]; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'discuss', ['codex', 'second=补漏', 'second=gap'])));
  const meta = { plan: p.plan_id, group: 'plan-group', kind: 'discuss', mode: 'discuss' };
  seedRun(h, '20000101-main', { ...meta, seat: 1 }, { report: discussion });
  const peer = h.start('-e', ['setInterval(()=>{},1000)']);
  await once(peer.child, 'spawn');
  seedRun(h, '20000101-gap', { ...meta, seat: 3, status: 'running', pid: peer.child.pid,
    started_at: new Date().toISOString(), ended_at: undefined });
  const status = output(await h.bridge(['status', '--plan', p.plan_id]));
  assert.equal(status.state, 'complete');
  assert.deepEqual(status.gap_unfinished, [
    { seat: 2, agent: 'second', status: 'not_started' }, { seat: 3, agent: 'second', status: 'running' },
  ]);
  const line = `Plan ${p.plan_id}: complete; gap seat not finished: second (seat 2, not started), second (seat 3, running)`;
  for (const lang of ['zh', 'en']) {
    const r = await h.bridge(['status', '--group', 'plan-group'], { env: { FOREMAN_LANG: lang } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.split(/\r?\n/).includes(line), r.stdout);
  }
});
