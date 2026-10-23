import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, baseConfig, write, json, seedRun, poll, apiAgent, ROOT, BRIDGE, MESSAGES } from './helpers.mjs';
import { discussion, review, usage } from './fixtures/reports.mjs';

const M = MESSAGES.zh;
const planArgs = (h, module = 'discuss', seats = ['codex'], extra = []) => ['plan', '--cwd', h.cwd, '--module', module,
  '--cell', 'complex', '--group', 'host-group', ...seats.flatMap((s) => ['--seat', s]), ...extra];
const launch = (p, seat = 1) => [p.module, '--plan', p.plan_id, '--seat', seat, '--brief', '-'];
const submitArgs = (h, p, extra = []) => ['submit', '--plan', p.plan_id, '--report',
  write(path.join(h.home, `${p.module}-answer.json`), p.module === 'discuss' ? discussion : review), ...extra];
const status = async (h, p) => output(await h.bridge(['status', '--plan', p.plan_id]));

for (const module of ['discuss', 'review']) test(`${module} 计划把 Claude Code 放在顶层，先给 submit 命令`, async (t) => {
  const h = sandbox(t), c = baseConfig(); h.config(c);
  const p = output(await h.bridge(planArgs(h, module, ['codex=质疑'], ['--host-role', '方案'])));
  assert.deepEqual(p.host, { seat: 0, role: '方案' });
  assert.deepEqual(json(p.file).host, p.host); assert.equal(p.seats[0].seat, 1);
  assert.equal(p.commands[0], `node "${BRIDGE}" submit --plan ${p.plan_id} --report "<报告.json>"`);
  assert.ok(p.commands[1].includes(`${module} --plan ${p.plan_id} --seat 1`));
  const plain = output(await h.bridge(planArgs(h, module))); assert.equal(plain.host.role, null);
});

test('run 计划没有 host，旧计划只数外部席，其他模块不能带 host-role', async (t) => {
  const h = sandbox(t), c = baseConfig(); h.config(c);
  const p = output(await h.bridge(planArgs(h, 'run')));
  assert.equal(Object.hasOwn(p, 'host'), false); assert.equal(p.commands.length, 1);
  for (const module of ['run', 'image']) failed(await h.bridge(planArgs(h, module, ['codex'], ['--host-role', '方案'])), M.hostRoleOnly);
  const old = { ...p, module: 'discuss', required: [] }; write(p.file, old);
  const s = h.scenario({ last_message: discussion });
  const r = output(await h.bridge(launch(old), { env: s.env })); assert.equal(r.seat, 1);
  assert.equal(Object.hasOwn(await status(h, old), 'host'), false);
  failed(await h.bridge(submitArgs(h, old)), M.submitNoHost(p.plan_id));
});

for (const module of ['discuss', 'review']) test(`${module} 用户关闭的格子可以建格子外计划，项目关闭仍拒绝`, async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules[module].complex = 'claude code'; h.config(c);
  const p = output(await h.bridge(planArgs(h, module)));
  assert.equal(p.outside_cell, true); assert.deepEqual(p.required, []); assert.equal(p.seats[0].effort, 'max');
  output(await h.bridge(submitArgs(h, p)));
  const s = h.scenario({ last_message: module === 'discuss' ? discussion : review });
  const r = output(await h.bridge(launch(p), { env: s.env }));
  assert.equal(r.outside_cell, true); assert.equal(json(path.join(r.run_dir, 'meta.json')).outside_cell, true);
  h.write('.claude/foreman.json', { modules: { [module]: { complex: 'claude code' } } });
  failed(await h.bridge(planArgs(h, module)), M.planCellClosedByProject(`modules.${module}.complex`));
});

test('格子外计划仍检查协作方存在、模块能力和 visual 看图能力', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.api = apiAgent('http://127.0.0.1:1');
  c.modules.review.complex = 'claude code'; h.config(c); h.write('shot.png', Buffer.from([1, 2]));
  const unknown = await h.bridge(planArgs(h, 'review', ['missing'])); assert.equal(unknown.code, 2); assert.ok(unknown.stderr.includes('missing'));
  failed(await h.bridge(planArgs(h, 'review', ['api'], ['--target', 'visual', '--file', 'shot.png'])), M.readsImagesRequired('api', 'api'));
  const script = h.write('capability.mjs', `import { loadConfig, validatePlan } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs')).href)};
import { adapters } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/adapters/index.mjs')).href)};
const cfg = loadConfig(null, adapters); const custom = { ...adapters, api: { ...adapters.api, capabilities: { ...adapters.api.capabilities, modes: ['discuss'] } } };
validatePlan(cfg, { module: 'review', cell: 'complex', host: { seat: 0 }, seats: [{ agent: 'api' }] }, custom);`);
  failed(await h.start(script).done, M.modeNotSupported('api', 'api', 'review', 'discuss'));
});

test('discuss 和 review 拒绝不带计划，submit 拒绝缺失或非 host 计划', async (t) => {
  const h = sandbox(t);
  for (const lang of ['zh', 'en']) for (const module of ['discuss', 'review']) failed(await h.bridge([module, '--cwd', h.cwd,
    '--level', 'complex', '--brief', '-'], { env: { FOREMAN_LANG: lang } }), MESSAGES[lang].discussReviewNeedsPlan(module));
  failed(await h.bridge(['submit', '--plan', 'missing', '--report', 'missing.json']), M.planNotFound('missing'));
  const p = output(await h.bridge(planArgs(h, 'run')));
  failed(await h.bridge(submitArgs(h, p)), M.submitNoHost(p.plan_id));
  assert.equal(h.records().length, 0);
});

for (const module of ['discuss', 'review']) test(`submit 校验 ${module} schema 后才登记，列出格式问题`, async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h, module))), file = h.write('bad-answer.json', { extra: true });
  const r = await h.bridge(['submit', '--plan', p.plan_id, '--report', file]);
  assert.equal(r.code, 2); assert.ok(r.stderr.includes(M.submitBadReport(file, M.answerKinds[module], '')));
  assert.ok(r.stderr.includes('is required')); assert.ok(r.stderr.includes('extra is not allowed'));
  write(file, '{'); assert.equal((await h.bridge(['submit', '--plan', p.plan_id, '--report', file])).code, 2);
  assert.equal(h.records().length, 0); assert.equal(fs.existsSync(path.join(h.runs, '.start.lock')), false);
});

test('submit 保存原样快照和规定字段，不造用量、进程或事件，status 原样返回', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h, 'discuss', ['codex'], ['--host-role', '方案'])));
  const args = submitArgs(h, p, ['--model', 'Vendor/Claude-X', '--author']), file = args[4];
  write(file, '\uFEFF' + JSON.stringify(discussion, null, 4) + '\n');
  const bytes = fs.readFileSync(file), hash = createHash('sha256').update(bytes).digest('hex');
  const out = output(await h.bridge(args)), m = json(path.join(out.run_dir, 'meta.json')), r = h.result(out.run_id);
  assert.deepEqual(fs.readFileSync(path.join(out.run_dir, 'report.json')), bytes);
  assert.equal(out.report_sha256, hash); assert.equal(m.report_sha256, hash); assert.equal(r.report_sha256, hash);
  assert.deepEqual([m.id, m.mode, m.kind, m.module, m.participant, m.agent, m.agent_type, m.seat, m.role, m.round, m.parent],
    [out.run_id, 'submit', 'discuss', 'discuss', 'host', 'claude-code', 'host', 0, '方案', 1, null]);
  assert.deepEqual([m.model, m.model_source, m.author, m.group, m.cwd, m.level, m.cell, m.title, m.claude_session, m.status, m.pid, m.session_id],
    ['Vendor/Claude-X', 'self_reported', true, p.group, p.cwd, p.level, p.cell, null, 'test-session', 'done', null, null]);
  assert.deepEqual([m.started_at, m.ended_at, r.submitted_at], [out.submitted_at, out.submitted_at, out.submitted_at]);
  assert.deepEqual([r.usage, r.usage_scope, r.duration_s, r.errors, r.notes, r.warnings], [null, null, null, [], [], []]);
  assert.deepEqual(r.report, discussion); assert.equal(fs.existsSync(path.join(out.run_dir, 'events.jsonl')), false);
  assert.deepEqual(output(await h.bridge(['status', '--run', out.run_id])), r);
  assert.deepEqual(out.commands, p.commands.slice(1));
  write(file, '{}'); assert.deepEqual(h.result(out.run_id).report, discussion);
});

test('讨论报告在锁内按轮登记，parent 连上一份，执行轮数上限', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.dispatch.discuss_max_rounds = 2; h.config(c);
  const p = output(await h.bridge(planArgs(h))), args = submitArgs(h, p);
  seedRun(h, '20000101-no-session', { module: 'discuss', kind: 'discuss', mode: 'discuss', plan: p.plan_id, seat: 1, status: 'failed', session_id: null });
  const answers = (await Promise.all([h.bridge(args), h.bridge(args)])).map((r) => output(r)).sort((a, b) => a.round - b.round);
  assert.deepEqual(answers.map((a) => a.round), [1, 2]);
  assert.equal(h.result(answers[0].run_id).parent, null); assert.equal(h.result(answers[1].run_id).parent, answers[0].run_id);
  assert.deepEqual(answers[1].commands, []);
  assert.deepEqual([h.result(answers[0].run_id).model, h.result(answers[0].run_id).model_source, h.result(answers[0].run_id).author], [null, null, false]);
  failed(await h.bridge(args), M.hostRoundsExceeded(p.plan_id, 2, 2));
  assert.equal(h.records().length, 3); assert.equal(h.records().filter((m) => m.participant === 'host').length, 2);
  assert.equal(fs.existsSync(path.join(h.runs, '.start.lock')), false);
});

test('审查只能交一次，材料指纹变动拒绝，外部失败后重启沿用已提交报告', async (t) => {
  const h = sandbox(t); h.write('source.txt', 'before\n');
  const p = output(await h.bridge(planArgs(h, 'review', ['codex'], ['--target', 'files', '--file', 'source.txt']))), args = submitArgs(h, p);
  h.write('source.txt', 'changed\n'); failed(await h.bridge(args), M.planMaterialChanged(p.plan_id)); assert.equal(h.records().length, 0);
  h.write('source.txt', 'before\n');
  const results = await Promise.all([h.bridge(args), h.bridge(args)]), done = output(results.find((r) => r.code === 0));
  failed(results.find((r) => r.code === 2), M.hostReviewAlreadySubmitted(p.plan_id, done.run_id));
  assert.equal(json(path.join(done.run_dir, 'meta.json')).review_fingerprint, p.review.fingerprint);
  const bad = h.scenario({ exit_code: 1 });
  const first = output(await h.bridge(launch(p), { env: bad.env }), 1); assert.equal(first.status, 'failed');
  const good = h.scenario({ last_message: review });
  const second = output(await h.bridge(launch(p), { env: good.env })); assert.equal(second.status, 'done');
  assert.equal(h.records().filter((m) => m.participant === 'host').length, 1);
  h.write('source.txt', 'changed again\n'); failed(await h.bridge(launch(p)), M.planMaterialChanged(p.plan_id));
});

for (const module of ['discuss', 'review']) test(`${module} 首轮准入拒绝未提交报告的计划，提交后启动`, async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h, module))), s = h.scenario({ last_message: module === 'discuss' ? discussion : review });
  failed(await h.bridge(launch(p), { env: s.env }), M.hostAnswerRequired(p.plan_id, 1));
  assert.equal(h.calls().length, 0); assert.equal(h.records().length, 0);
  const answer = output(await h.bridge(submitArgs(h, p)));
  const r = output(await h.bridge(launch(p), { env: s.env })); assert.equal(r.seat, 1);
  const state = await status(h, p); assert.equal(state.host.before_external_start, true); assert.equal(state.state, 'complete');
  assert.deepEqual(state.host.rounds.map((r) => r.run_id), [answer.run_id]);
});

test('讨论失败首轮可重启，第二轮须先交第二份报告，submit 给各席最新续接命令', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h, 'discuss', ['codex', 'codex'], ['--count-why', '同方两席验证轮次准入'])));
  output(await h.bridge(submitArgs(h, p)));
  seedRun(h, '20000101-failed-first', { module: 'discuss', kind: 'discuss', mode: 'discuss', plan: p.plan_id, seat: 1, status: 'failed', session_id: null }, null);
  const s = h.scenario({ last_message: discussion });
  const a = output(await h.bridge(launch(p), { env: s.env })), b = output(await h.bridge(launch(p, 2), { env: s.env }));
  const resume = ['resume', '--run', a.run_id, '--level', 'complex', '--brief', '-'];
  failed(await h.bridge(resume, { env: s.env }), M.hostAnswerRequired(p.plan_id, 2));
  const answer = output(await h.bridge(submitArgs(h, p)));
  assert.deepEqual(answer.commands, [a, b].map((r) => `node "${BRIDGE}" resume --run ${r.run_id} --level complex --brief "<续接说明.md>"`));
  // 后面几轮另列能续接的席位和模型，并写明广度席不续接（脚本不知道档位，由 Claude 挑）
  assert.deepEqual(answer.resumable.map((s) => [s.seat, s.agent, s.run_id]), [[1, 'codex', a.run_id], [2, 'codex', b.run_id]]);
  assert.equal(answer.note, M.submitResumeNote);
  const next = output(await h.bridge(resume, { env: s.env })); assert.equal(next.round, 2); assert.equal(next.parent, a.run_id);
});

test('resume 和 cancel 明确拒绝 host，last 也拒绝；旧的无计划讨论仍可续接', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h))), answer = output(await h.bridge(submitArgs(h, p)));
  for (const ref of [answer.run_id, 'last']) {
    failed(await h.bridge(['resume', '--run', ref, '--level', 'complex', '--brief', '-']), M.hostNoResume(answer.run_id));
    failed(await h.bridge(['cancel', '--run', ref]), M.hostNoCancel(answer.run_id));
  }
  seedRun(h, '20000101-old-discussion', { kind: 'discuss', mode: 'discuss', level: 'complex' }, { report: discussion });
  const s = h.scenario({ last_message: discussion });
  const r = output(await h.bridge(['resume', '--run', '20000101-old-discussion', '--level', 'complex', '--brief', '-'], { env: s.env }));
  assert.equal(r.plan, null); assert.equal(r.round, 2);
});

test('planStatus 缺报告不能 complete，host 不进入 missing_required，早于外部启动分别为 null/false', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.discuss.complex[0].required = true; h.config(c);
  const p = output(await h.bridge(planArgs(h)));
  let state = await status(h, p);
  assert.deepEqual(state.host, { seat: 0, role: null, status: 'missing', rounds: [], before_external_start: null });
  assert.deepEqual(state.missing[0], { seat: 0, agent: 'claude-code', status: 'not_submitted', label: MESSAGES.en.hostNotSubmitted });
  assert.deepEqual(state.missing_required, [{ seat: 1, agent: 'codex', status: 'not_started' }]);
  seedRun(h, '20000101-external', { module: 'discuss', kind: 'discuss', plan: p.plan_id, seat: 1, group: p.group }, { report: discussion });
  state = await status(h, p); assert.equal(state.state, 'pending'); assert.deepEqual(state.missing_required, []);
  assert.equal(state.host.before_external_start, false);
  const list = await h.bridge(['status', '--group', p.group]); assert.ok(list.stdout.includes(MESSAGES.en.hostNotSubmitted));
  const answer = output(await h.bridge(submitArgs(h, p, ['--model', 'host-model', '--author'])));
  state = await status(h, p); assert.equal(state.state, 'complete'); assert.deepEqual(state.missing, []);
  assert.deepEqual(state.host.rounds, [{ round: 1, run_id: answer.run_id, submitted_at: answer.submitted_at, report_sha256: answer.report_sha256, model: 'host-model', author: true }]);
  assert.equal(state.host.before_external_start, false);
});

test('judge 双向连接 host 与外部，stats 单列 host、原样模型、按计划席位算一席且不计资源缺失', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h)));
  seedRun(h, '20000101-external', { module: 'discuss', kind: 'discuss', plan: p.plan_id, seat: 1 },
    { report: discussion, usage, duration_s: 5 });
  output(await h.bridge(['judge', '--run', '20000101-external', '--accept', 'P1,P2']));
  const before = output(await h.bridge(['stats'])).rows[0];
  const a = output(await h.bridge(submitArgs(h, p, ['--model', 'fake-codex'])));
  output(await h.bridge(submitArgs(h, p, ['--model', 'fake-codex'])));
  let stats = output(await h.bridge(['stats']));
  assert.deepEqual(stats.rows.find((r) => !r.participant), before);
  const host = stats.rows.find((r) => r.participant === 'host');
  assert.equal(host.self_judged, true); assert.equal(host.model, 'fake-codex'); assert.equal(host.seats, 1); assert.equal(host.runs, 2);
  assert.deepEqual(host.tokens, { input: null, cached_input: null, output: null, runs: 0, missing_runs: 0 });
  assert.deepEqual(host.cost_usd, { total: null, runs: 0, missing_runs: 0 });
  assert.deepEqual(host.duration_s, { total: 0, median_per_seat: null, missing_runs: 0 });
  assert.ok(stats.notes.includes(M.statsNotes.find((n) => n.startsWith('Claude Code'))));
  output(await h.bridge(['judge', '--run', a.run_id, '--accept', 'H1', '--same', 'H1=20000101-external:P1']));
  output(await h.bridge(['judge', '--run', '20000101-external', '--same', `P1=${a.run_id}:H1`]));
  stats = output(await h.bridge(['stats']));
  assert.equal(stats.rows.find((r) => !r.participant).unique, 1); assert.equal(stats.rows.find((r) => r.participant).unique, 0);
  const other = output(await h.bridge(planArgs(h))); output(await h.bridge(submitArgs(h, other, ['--model', 'Vendor/CLAUDE-X'])));
  assert.ok(output(await h.bridge(['stats'])).rows.some((r) => r.participant === 'host' && r.model === 'Vendor/CLAUDE-X'));
});

test('组 tally/status/await-busy 和会话提醒不把 host 当成外部完成或未完成任务', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h))), answer = output(await h.bridge(submitArgs(h, p)));
  const listing = await h.bridge(['status', '--group', p.group]);
  assert.equal(listing.code, 0); assert.ok(listing.stdout.includes('1 submitted')); assert.ok(listing.stdout.includes('0 done'));
  assert.deepEqual(output(await h.bridge(['await-busy', '--group', p.group, '--after', '0.001'])), { busy: [], running: [], done: true });
  const reminder = output(await h.hook('session-reminder.mjs')).hookSpecificOutput.additionalContext;
  assert.ok(!reminder.includes(answer.run_id));
  const records = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/records.mjs')).href;
  const config = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs')).href;
  const adapters = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/adapters/index.mjs')).href;
  const script = h.write('host-tally.mjs', `import { initializeRecords, groupRuns, groupTally, isRunning, groupScopeOwner } from ${JSON.stringify(records)};
import { loadConfig } from ${JSON.stringify(config)}; import { adapters } from ${JSON.stringify(adapters)};
initializeRecords(loadConfig(null, adapters)); const runs = groupRuns('host-group');
console.log(JSON.stringify({ tally: groupTally(runs), running: isRunning(runs[0].meta), owner: groupScopeOwner({ ...runs[0].meta, id: 'other', kind: 'exec', scope: ['src'] })('src/a') }));`);
  assert.deepEqual(output(await h.start(script).done), { tally: { running: 0, ok: 0, blocked: 0, failed: 0, resumed: 0, submitted: 1 }, running: false, owner: null });
});

test('watch 组视图里 Claude Code 席排在最前、和外部席一样写身份行和结论，单席查看照样显示报告，无 events 也不报错', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h))), a = output(await h.bridge(submitArgs(h, p, ['--model', 'host-model'])));
  const gate = path.join(h.home, 'release'), s = h.scenario({ last_message: discussion, steps: [{ wait_for: gate }] });
  const task = h.startBridge(launch(p), { env: s.env }); await h.running();
  const watch = h.startBridge(['watch', '--group', p.group], { env: { FOREMAN_TEST_SCREEN: '160x30' } });
  const submitted = `${MESSAGES.en.statusName('submitted')} ${a.submitted_at.slice(11, 16)}`;
  await poll(() => watch.stdout.includes('0 ✔ host-model · Claude Code') && watch.stdout.includes(submitted), 'Claude Code 席的实时身份行');
  write(gate, 'go'); output(await task.done);
  const out = await watch.done; assert.equal(out.code, 0, out.stderr);
  const summary = out.stdout.slice(out.stdout.lastIndexOf('\x1b[?1049l')); // 离开实时画面之后写的汇总
  assert.ok(summary.includes(`✔ host-model · Claude Code`) && summary.includes(discussion.position), summary);
  assert.ok(summary.indexOf('Claude Code') < summary.indexOf('fake-codex'), summary);
  assert.ok(!fs.existsSync(path.join(a.run_dir, 'cancel')), 'cancel'); assert.equal(fs.existsSync(path.join(a.run_dir, 'events.jsonl')), false);
  for (const lang of ['zh', 'en']) {
    for (const flags of [[], ['--verbose']]) {
      const single = await h.bridge(['watch', '--run', a.run_id, ...flags], { env: { FOREMAN_LANG: lang } });
      assert.equal(single.code, 0, single.stderr); assert.match(single.stdout, new RegExp(`✔ host-model · Claude Code +${submitted}\\n`));
      assert.ok(single.stdout.includes(MESSAGES.en.watchAnswerSubmitted(1)) && single.stdout.includes(discussion.position), single.stdout);
      assert.ok(!single.stdout.includes('Codex CLI'), single.stdout);
    }
  }
});

test('计划文件被删或损坏时准入照样检查报告，同一轮多出来的报告不能顶替下一轮', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h))), s = h.scenario({ last_message: discussion });
  output(await h.bridge(submitArgs(h, p)));
  const a = output(await h.bridge(launch(p), { env: s.env }));
  const resume = ['resume', '--run', a.run_id, '--level', 'complex', '--brief', '-'];
  seedRun(h, '20000101-extra-host', { module: 'discuss', kind: 'discuss', mode: 'submit', participant: 'host', agent: 'claude-code',
    agent_type: 'host', plan: p.plan_id, seat: 0, round: 1, pid: null, session_id: null });
  failed(await h.bridge(resume, { env: s.env }), M.hostAnswerRequired(p.plan_id, 2));
  fs.rmSync(p.file);
  failed(await h.bridge(resume, { env: s.env }), M.hostAnswerRequired(p.plan_id, 2));
  fs.writeFileSync(p.file, '{ broken');
  const before = h.records().length;
  failed(await h.bridge(resume, { env: s.env }), M.planUnreadable(p.file));
  assert.equal(h.records().length, before); assert.equal(h.records().filter((m) => m.status === 'running').length, 0);
});

test('submit 遇到读不出的记录时拒绝登记，不留下空目录', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(planArgs(h)));
  const dir = seedRun(h, '20000101-host-unreadable', { module: 'discuss', kind: 'discuss', mode: 'submit', participant: 'host', plan: p.plan_id, seat: 0, round: 1 });
  const runDirs = () => fs.readdirSync(h.runs).filter((name) => /^\d{8}-/.test(name));
  for (const content of ['{ broken', 'null']) {
    fs.writeFileSync(path.join(dir, 'meta.json'), content);
    const before = runDirs();
    const r = await h.bridge(submitArgs(h, p));
    assert.equal(r.code, 2, content); assert.ok(r.stderr.includes(path.join(dir, 'meta.json')), r.stderr);
    assert.deepEqual(runDirs(), before);
  }
});
