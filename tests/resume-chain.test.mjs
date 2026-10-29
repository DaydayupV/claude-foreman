import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plannedSandbox as sandbox, plannedArgs, output, failed, seedRun, taskArgs, baseConfig, write, json, poll, ROOT, BRIDGE, MESSAGES } from './helpers.mjs';
import { report, discussion, review } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const url = (file) => JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', file)).href);
const resume = (id, extra = []) => ['resume', '--run', id, '--level', 'complex', '--brief', '-', '--reason', 'rework', '--no-snapshot', ...extra];

test('执行和图像续接缺少或写错 --reason 时说明三个值，且不启动协作方', async (t) => {
  const h = sandbox(t);
  for (const module of ['run', 'image']) {
    seedRun(h, `parent-${module}`, { module });
    const args = ['resume', '--run', `parent-${module}`, '--brief', '-', ...(module === 'run' ? ['--level', 'complex'] : [])];
    for (const flags of [[], ['--reason'], ['--reason', 'invalid']]) {
      const r = await h.bridge([...args, ...flags]);
      failed(r, M.resumeReason(flags[1]));
      for (const value of ['rework', 'answer', 'recover']) assert.ok(r.stderr.includes(`${value}：`), r.stderr);
    }
    failed(await h.bridge(['resume', '--run', `parent-${module}`, '--reason', '--brief', '-']), M.resumeReason());
  }
  assert.equal(h.calls().length, 0); assert.equal(h.records().length, 2);
});

test('讨论续接拒绝 --reason，审查先报原有的不能续接', async (t) => {
  const h = sandbox(t);
  seedRun(h, 'parent-discuss', { module: 'discuss', kind: 'discuss', mode: 'discuss' });
  seedRun(h, 'parent-review', { module: 'review', kind: 'review', mode: 'review' });
  for (const flags of [['--reason', 'answer'], ['--reason']]) {
    failed(await h.bridge(['resume', '--run', 'parent-discuss', '--brief', '-', ...flags]), M.resumeReasonDiscuss);
    failed(await h.bridge(['resume', '--run', 'parent-review', '--brief', '-', ...flags]), M.reviewNoResume);
  }
  assert.equal(h.calls().length, 0); assert.equal(h.records().length, 2);
});

for (const [reason, status, result] of [
  ['answer', 'done', { status: 'done', report }],
  ['recover', 'done', { status: 'done', report }],
  ['rework', 'timeout', { status: 'timeout' }],
]) test(`续接 ${reason} 不一致时只写一条 notes，声明保存在子轮且每轮重填`, async (t) => {
  const h = sandbox(t), parent = seedRun(h, 'parent', { status }, result);
  const before = fs.readFileSync(path.join(parent, 'meta.json'), 'utf8');
  const r = output(await h.bridge(['resume', '--run', 'parent', '--level', 'complex', '--brief', '-', '--reason', reason, '--no-snapshot']));
  assert.deepEqual(r.notes, [M.resumeReasonMismatch(reason, status)]);
  assert.deepEqual(h.result(r.run_id).notes, r.notes);
  assert.equal(json(path.join(r.run_dir, 'meta.json')).resume_reason, reason);
  assert.equal(fs.readFileSync(path.join(parent, 'meta.json'), 'utf8'), before);
  failed(await h.bridge(['resume', '--run', r.run_id, '--level', 'complex', '--brief', '-']), M.resumeReason());
  assert.equal(h.calls().length, 1); assert.equal(h.records().length, 2);
});

test('续接拒绝运行中和旧轮次，锁内阻止并行分叉，最新结束轮次可续接', async (t) => {
  const h = sandbox(t), id = '20000101-root';
  seedRun(h, id, { status: 'running', pid: process.pid });
  failed(await h.bridge(resume(id)), M.resumeParentRunning(id));
  seedRun(h, id, {}, { status: 'done', report });
  const lock = path.join(h.runs, '.start.lock'), gate = path.join(h.home, 'finish');
  write(lock, { pid: process.pid, token: 'test-lock' });
  const scenario = h.scenario({ steps: [{ wait_for: gate }] });
  const script = h.write('race-resume.mjs', `import fs from 'node:fs';
const read = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (file === ${JSON.stringify(lock)} || String(file).startsWith(${JSON.stringify(path.join(h.runs, '.locks', '.start.lock.'))})) fs.writeFileSync(process.env.WAIT_MARKER, 'waiting');
  return read(file, ...args);
};
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const markers = [1, 2].map((i) => path.join(h.home, `waiting-${i}`));
  const handles = markers.map((marker) => h.start(script, resume(id), { env: { ...scenario.env, WAIT_MARKER: marker } }));
  await poll(() => markers.every((file) => fs.existsSync(file)), '两次续接都等在登记锁外');
  fs.rmSync(lock);
  const child = await h.running((m) => m.parent === id);
  await poll(() => handles.some((handle) => handle.stderr.includes(M.resumeNotLatest(id, child.id))), '锁内拒绝第二个续接');
  write(gate, 'go');
  const results = await Promise.all(handles.map((handle) => handle.done));
  assert.equal(output(results.find((r) => r.code === 0)).run_id, child.id);
  failed(results.find((r) => r.code === 2), M.resumeNotLatest(id, child.id));
  const latest = output(await h.bridge(resume(child.id)));
  failed(await h.bridge(resume(id)), M.resumeNotLatest(id, latest.run_id));
  assert.equal(h.records().length, 3);
  assert.deepEqual(json(path.join(latest.run_dir, 'meta.json')).add_dir, []);
});

test('续接不能改组或给无组任务加组，允许同组重给 scope 并照常查重叠', async (t) => {
  const h = sandbox(t);
  seedRun(h, '20000101-none');
  failed(await h.bridge(resume('20000101-none', ['--group', 'new'])), M.resumeGroupFixed(null));
  seedRun(h, '20000101-group', { group: 'fixed', scope: ['src'] });
  failed(await h.bridge(resume('20000101-group', ['--group', 'other'])), M.resumeGroupFixed('fixed'));
  seedRun(h, '20000101-peer', { group: 'fixed', scope: ['busy'], status: 'running', pid: process.pid });
  failed(await h.bridge(resume('20000101-group', ['--scope', 'busy'])), M.scopeOverlap('fixed', '20000101-peer', ['busy']));
  const r = output(await h.bridge(resume('20000101-group', ['--group', 'fixed', '--scope', 'free'])));
  assert.equal(r.group, 'fixed'); assert.deepEqual(r.scope, ['free']);
});

test('锁内重新检查续接父任务是否仍在运行', async (t) => {
  const h = sandbox(t), id = '20000101-parent';
  const dir = seedRun(h, id, { status: 'running', pid: process.pid });
  const script = h.write('admit-parent.mjs', `import { initializeRecords, newRunDir, saveMeta, checkAdmission } from ${url('records.mjs')};
const cfg = ${JSON.stringify(baseConfig())}; initializeRecords(cfg);
const run = await newRunDir(), meta = { id: run.id, agent: 'codex', parent: ${JSON.stringify(id)}, cwd: ${JSON.stringify(h.cwd)} };
try { saveMeta(run.dir, meta); console.log(JSON.stringify(checkAdmission(meta, cfg))); } finally { run.release(); }`);
  assert.equal(output(await h.start(script).done), M.resumeParentRunning(id));
  assert.equal(json(path.join(dir, 'meta.json')).status, 'running');
});

for (const mode of ['transient-json', 'transient-busy', 'gone', 'unreadable']) test(`准入元数据重读：${mode}`, async (t) => {
  const h = sandbox(t), dir = seedRun(h, '20000101-other'), file = path.join(dir, 'meta.json');
  const lock = path.join(h.runs, '.start.lock'), audit = path.join(h.home, 'reads.json');
  const script = h.write('admission-read.mjs', `import fs from 'node:fs';
const read = fs.readFileSync; let attempts = 0;
fs.readFileSync = (target, ...args) => {
  if (target === ${JSON.stringify(file)} && fs.existsSync(${JSON.stringify(lock)})) {
    fs.writeFileSync(${JSON.stringify(audit)}, JSON.stringify(++attempts));
    if (${JSON.stringify(mode)} === 'gone') { fs.rmSync(target); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }
    if (${JSON.stringify(mode)} === 'unreadable' || attempts <= 3) {
      if (${JSON.stringify(mode)} === 'transient-busy') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return '{';
    }
  }
  return read(target, ...args);
};
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const started = Date.now(), r = await h.start(script, taskArgs(h, 'run', ['--no-snapshot'])).done;
  if (mode === 'unreadable') {
    failed(r, M.admissionUnreadable(M.list([file])));
    assert.ok(Date.now() - started >= 900);
    assert.equal(h.calls().length, 0); assert.equal(h.records().length, 1);
  } else {
    output(r); assert.equal(h.calls().length, 1);
    assert.equal(json(audit), mode === 'gone' ? 1 : 4);
  }
  assert.equal(fs.existsSync(lock), false);
});

for (const permanent of [false, true]) test(`讨论轮数用 findRun 读取祖先，${permanent ? '读不出就报错' : '短暂半写后仍完整计数'}`, async (t) => {
  const h = sandbox(t), root = '20000101-discuss-root';
  const dir = seedRun(h, root, { kind: 'discuss', mode: 'discuss' });
  seedRun(h, '20000101-discuss-next', { kind: 'discuss', mode: 'resume', parent: root });
  const script = h.write('ancestor.mjs', `import fs from 'node:fs';
const read = fs.readFileSync; let reads = 0;
fs.readFileSync = (file, ...args) => file === ${JSON.stringify(path.join(dir, 'meta.json'))} && (${permanent} || ++reads <= 3) ? '{' : read(file, ...args);
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const r = await h.start(script, ['resume', '--run', '20000101-discuss-next', '--level', 'complex', '--brief', '-']).done;
  if (permanent) { assert.equal(r.code, 1); assert.match(r.stderr, /SyntaxError/); }
  else failed(r, M.discussRoundsExceeded(root, 2, 2));
  assert.equal(h.calls().length, 0);
});

test('统一结果有效性：四模块、旧审查、原生审查、incomplete、partial 和交回问题', async (t) => {
  const h = sandbox(t);
  const cases = [
    [{ module: 'run' }, {}, false, false], [{ module: 'image', cell: 'draw', route: 3 }, { report }, true, true],
    [{ kind: 'discuss', mode: 'resume' }, { last_message: '只有文字' }, false, false],
    [{ mode: 'discuss' }, { report: discussion }, true, true],
    [{ kind: 'review' }, { last_message: '旧审查' }, true, true],
    [{ module: 'review' }, { review_target: 'files', last_message: '{}' }, false, false],
    [{ module: 'review' }, { review_target: 'diff', native_review: true, last_message: '原生审查' }, true, true],
    [{ module: 'review' }, { report: { ...review, verdict: 'incomplete' } }, false, false],
    [{ module: 'run' }, { report: { ...report, status: 'partial' } }, true, false],
    [{ module: 'run' }, { needs_decision: true }, false, false],
  ];
  const ids = cases.map(([meta, result], i) => {
    const id = `20000101-valid-${i}`;
    seedRun(h, id, meta, { ...meta, status: 'done', ...result }); return id;
  });
  const script = h.write('valid.mjs', `import { initializeRecords, findRun, resultValid, runOutcome } from ${url('records.mjs')};
import { outcomeStyle } from ${url('format.mjs')};
initializeRecords(${JSON.stringify(baseConfig())});
console.log(JSON.stringify(${JSON.stringify(ids)}.map((id) => {
  const run = findRun(id), outcome = runOutcome(run);
  return [resultValid(run.meta, outcome.result), outcome.ok, outcomeStyle(outcome).word];
})));`);
  const outcomes = output(await h.start(script).done);
  assert.deepEqual(outcomes.map((r) => r.slice(0, 2)), cases.map((r) => r.slice(2)));
  assert.equal(outcomes[0][2], 'no valid result'); assert.equal(outcomes[8][2], 'partly done');
  assert.equal(outcomes[9][2], 'questions returned');
  const listed = await h.bridge(['status', '--limit', '20']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /20000101-valid-0\s+run\s+✗ no valid result/);
  for (const verbose of [[], ['--verbose']]) {
    const watched = await h.bridge(['watch', '--run', ids[7], ...verbose]);
    assert.equal(watched.code, 0, watched.stderr); assert.ok(watched.stdout.includes('✗ no valid result'), watched.stdout);
  }
});

for (const module of ['run', 'image', 'discuss', 'review']) test(`${module} 计划的 missing、必选多席和全部交回规则`, async (t) => {
  const h = sandbox(t), id = `plan-${module}`;
  const plan = { plan_id: id, module, cell: 'complex', group: 'states', required: ['codex'],
    seats: [{ seat: 1, agent: 'codex', required: false }, { seat: 2, agent: 'optional', required: true }, { seat: 3, agent: 'codex', required: false }] };
  const file = path.join(h.runs, 'plans', `${id}.json`); write(file, plan);
  const status = async () => output(await h.bridge(['status', '--plan', id]));
  const seat = (n, status = 'done', valid = true) => seedRun(h, `20000101-seat-${n}`, { plan: id, seat: n, module, group: plan.group, status },
    { status, report: valid ? module === 'review' ? review : module === 'discuss' ? discussion : report : null });
  let r = await status(); assert.equal(r.state, 'pending');
  assert.deepEqual(r.seats.map((s) => s.required), [true, false, true]);
  assert.deepEqual(r.missing_required.map((s) => s.seat), [1, 3]);
  assert.deepEqual(r.missing.map((s) => s.seat), ['run', 'image'].includes(module) ? [1, 2, 3] : [1, 3]);
  seat(1); seat(3);
  r = await status(); assert.equal(r.state, ['run', 'image'].includes(module) ? 'pending' : 'complete');
  seat(2, 'done', false);
  r = await status(); assert.equal(r.state, ['run', 'image'].includes(module) ? 'incomplete' : 'complete');
  assert.deepEqual(r.missing_required, []);
  seat(2); r = await status(); assert.equal(r.state, 'complete'); assert.deepEqual(r.missing, []);
  delete plan.required; write(file, plan);
  r = await status(); assert.deepEqual(r.seats.map((s) => s.required), [false, true, false]);
});

test('跨会话组计划使用同次读取的全部记录，status 和 watch 只展示当前会话', async (t) => {
  const h = sandbox(t), id = 'cross-session', group = 'cross-group';
  write(path.join(h.runs, 'plans', `${id}.json`), { plan_id: id, module: 'run', cell: 'complex', group, required: ['codex'],
    seats: [1, 2].map((seat) => ({ seat, agent: 'codex', required: true })) });
  const old = { plan: id, group, claude_session: 'old-session', started_at: new Date(Date.now() - 2 * 86400000).toISOString() };
  seedRun(h, '20000101-000000-aaaa', { ...old, seat: 1 }, { status: 'failed' });
  seedRun(h, '20000101-000001-aaaa', { ...old, seat: 2 }, { status: 'done', report });
  seedRun(h, '20000101-000002-aaaa', { plan: id, group, seat: 1, parent: '20000101-000000-aaaa' }, { status: 'done', report });
  const count = path.join(h.home, 'scans.json');
  const script = h.write('group-scan.mjs', `import fs from 'node:fs';
const read = fs.readdirSync; let scans = 0;
fs.readdirSync = (dir, ...args) => { if (dir === ${JSON.stringify(h.runs)}) fs.writeFileSync(${JSON.stringify(count)}, JSON.stringify(++scans)); return read(dir, ...args); };
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const status = await h.start(script, ['status', '--group', group]).done;
  assert.equal(status.code, 0, status.stderr); assert.equal(json(count), 1);
  const watched = await h.bridge(['watch', '--group', group]);
  for (const r of [status, watched]) {
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('20000101-000002-aaaa')); assert.ok(!r.stdout.includes('20000101-000001-aaaa'));
  }
  assert.ok(status.stdout.includes(`Plan ${id}: complete`), status.stdout);
  // 组视图只在计划有缺口时写计划行；完整的不写
  assert.ok(!watched.stdout.includes(MESSAGES.en.planStates.incomplete) && !watched.stdout.includes(id), watched.stdout);
});

test('另一个会话重启同席并续接任务链，watch 显示最新轮次且 status 将旧轮算已续接', async (t) => {
  const h = sandbox(t), group = 'replaced-session', plan = 'cross-restart';
  write(path.join(h.runs, 'plans', `${plan}.json`), { plan_id: plan, module: 'run', cell: 'complex', group, required: ['codex'],
    seats: [1, 2].map((seat) => ({ seat, agent: 'codex', required: true })) });
  const [oldSeat, root, middle, peer, newSeat, leaf] = Array.from({ length: 6 }, (_, i) => `20000101-00000${i}-aaaa`);
  seedRun(h, oldSeat, { group, plan, seat: 1, status: 'failed' }, { status: 'failed' });
  seedRun(h, root, { group, status: 'failed' }, { status: 'failed' });
  seedRun(h, middle, { group, mode: 'resume', parent: root, status: 'failed' }, { status: 'failed' });
  seedRun(h, peer, { group, plan, seat: 2 }, { status: 'done', report });
  seedRun(h, newSeat, { group, plan, seat: 1, claude_session: 'another-session' }, { status: 'done', report });
  seedRun(h, leaf, { group, mode: 'resume', parent: middle, claude_session: 'another-session' }, { status: 'done', report });
  const status = await h.bridge(['status', '--group', group]);
  assert.equal(status.code, 0, status.stderr);
  assert.ok(status.stdout.includes(MESSAGES.en.groupSummary(4, 0, 1, 0, 0, 3)), status.stdout);
  for (const id of [oldSeat, root, middle, peer]) assert.ok(status.stdout.includes(id), status.stdout);
  for (const id of [newSeat, leaf]) assert.ok(!status.stdout.includes(id), status.stdout);
  const watched = await h.bridge(['watch', '--group', group]);
  assert.equal(watched.code, 0, watched.stderr);
  for (const id of [oldSeat, root, middle]) assert.ok(!watched.stdout.includes(id), watched.stdout);
  for (const id of [newSeat, leaf, peer]) assert.equal(watched.stdout.split(id).length - 1, 1, watched.stdout);
  // 按席位号排：计划第 1 席（newSeat）、第 2 席（peer），没有计划的续接链取下一个空号排在后面
  assert.ok(watched.stdout.indexOf(newSeat) < watched.stdout.indexOf(peer), watched.stdout);
  assert.ok(watched.stdout.indexOf(peer) < watched.stdout.indexOf(leaf), watched.stdout);
});

test('审查席失败或无有效结果可以重启，有运行轮次或有效审查就拒绝', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.default.review.complex[0].required = true; h.config(c);
  const plan = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'complex', '--group', 'restart', '--seat', 'codex']));
  const args = ['review', '--plan', plan.plan_id, '--seat', '1', '--brief', '-'];
  const dir = seedRun(h, '20000101-review-round', { module: 'review', kind: 'review', parent: '20000101-review-root',
    plan: plan.plan_id, seat: 1, status: 'running', pid: process.pid });
  failed(await h.bridge(args), M.seatRoundRunning(plan.plan_id, 1, '20000101-review-round'));
  write(path.join(dir, 'meta.json'), { ...json(path.join(dir, 'meta.json')), status: 'stalled' });
  const s = h.scenario({ calls: [{ exit_code: 1 }, { last_message: { ...review, verdict: 'incomplete' } }, { last_message: review }] });
  const first = output(await h.bridge(args, { env: s.env }), 1);
  const second = output(await h.bridge(args, { env: s.env }));
  assert.equal(second.report.verdict, 'incomplete');
  const third = output(await h.bridge(args, { env: s.env }));
  const status = output(await h.bridge(['status', '--plan', plan.plan_id]));
  assert.equal(status.state, 'complete'); assert.equal(status.seats[0].run_id, third.run_id);
  assert.ok(status.seats[0].runs.includes(first.run_id));
  failed(await h.bridge(args, { env: s.env }), M.reviewSeatTaken(plan.plan_id, 1, third.run_id));
  assert.equal(s.calls().length, 3);
  // status --group 把重启前的那几轮算成"已续接"，不算失败
  const grouped = await h.bridge(['status', '--group', 'restart']);
  assert.ok(grouped.stdout.includes(MESSAGES.en.groupSummary(4, 0, 1, 0, 0, 2, 1)), grouped.stdout);
});

test('非审查席重启提示最新一轮，而不是最初一轮', async (t) => {
  const h = sandbox(t);
  const p = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'run', '--cell', 'complex', '--group', 'latest-seat', '--seat', 'codex']));
  seedRun(h, '20000101-seat-root', { plan: p.plan_id, seat: 1, started_at: '2000-01-01T00:00:00Z' });
  seedRun(h, '20000102-seat-next', { plan: p.plan_id, seat: 1, parent: '20000101-seat-root', started_at: '2000-01-02T00:00:00Z' });
  failed(await h.bridge(['run', '--plan', p.plan_id, '--seat', '1', '--brief', '-', '--scope', 'src']), M.seatAlreadyStarted(p.plan_id, 1, '20000102-seat-next'));
});

test('快照外自报改动算只读违规，快照内无变化和工作目录自身不算，track 可覆盖忽略规则', async (t) => {
  const h = sandbox(t); h.initGit();
  h.write('.gitignore', 'ignored/\n'); h.write('unchanged.txt', 'before\n');
  h.write('ignored/tracked.txt', 'unchanged\n');
  const paths = ['./', 'unchanged.txt', 'new-but-unwritten.txt', 'ignored/missing.txt', 'ignored/tracked.txt', 'node_modules/missing.js', path.join(h.home, 'outside.txt')];
  const s = h.scenario({ last_message: { ...discussion, files_changed: paths.map((path) => ({ path, change: '自报修改' })) } });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--track', 'ignored/tracked.txt']), { env: s.env }), 1);
  assert.equal(r.changes.available, true); assert.deepEqual(r.changes.files, []);
  assert.deepEqual(r.readonly_violation, ['ignored/missing.txt', 'node_modules/missing.js', '../outside.txt'].map((path) => ({ path, by: 'reported' })));
  assert.ok(r.errors.includes(M.readonlyViolated('discuss', 3)));
});

test('路线三手画出位图告警，SVG 带命名空间并跨块仍识别，imageset 不误判', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.default.image.draw = [{ agent: 'codex' }]; h.config(c);
  const question = '图像路线', answer = '③ 纯矢量';
  write(path.join(path.dirname(h.userConfig), 'answers/test-session.jsonl'), JSON.stringify({ event: 'answered', tool_use_id: 'route',
    questions: [{ question, options: [answer] }], answers: { [question]: answer } }) + '\n');
  const p = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'image', '--cell', 'draw', '--route', '3', '--group', 'vector', '--seat', 'codex']));
  const prefix = 'longNamespacePrefix', opening = `<svg xmlns:${prefix}="http://www.w3.org/2000/svg">`;
  const svg = opening + ' '.repeat(1024 * 1024 - opening.length - prefix.length - 3) + `<${prefix}:image href="data:image/png;base64,a"/></svg>`;
  const s = h.scenario({ images: ['unexpected.png'], files: { 'art/embedded.svg': svg, 'art/clean.svg': '<svg><imageset/></svg>' },
    last_message: { ...report, files_changed: ['art/embedded.svg', 'art/clean.svg'].map((path) => ({ path, change: '画图' })) } });
  const r = output(await h.bridge(['image', '--plan', p.plan_id, '--seat', '1', '--scope', 'art', '--brief', '-'], { env: s.env }));
  assert.ok(r.warnings.includes(M.drawStepImages('③')));
  assert.ok(r.warnings.includes(M.vectorEmbedsBitmap('③', M.list(['art/embedded.svg']))), r.warnings.join('\n'));
  assert.ok(!r.warnings.some((warning) => warning.includes('clean.svg')));
});

test('add-dir 元数据存绝对路径，续接合并去重并用 Codex TOML writable_roots 传递', async (t) => {
  const h = sandbox(t), dirs = ['extra one', 'extra-二'].map((name) => path.join(h.home, name));
  dirs.forEach((dir) => fs.mkdirSync(dir));
  const first = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot', '--add-dir', dirs[0]])));
  assert.deepEqual(json(path.join(first.run_dir, 'meta.json')).add_dir, [dirs[0]]);
  const next = output(await h.bridge(resume(first.run_id, ['--add-dir', dirs[0], '--add-dir', path.relative(h.cwd, dirs[1])])));
  assert.deepEqual(json(path.join(next.run_dir, 'meta.json')).add_dir, dirs);
  const args = h.calls().at(-1).args;
  assert.ok(!args.includes('--add-dir'));
  const option = `sandbox_workspace_write.writable_roots=[${dirs.map((dir) => JSON.stringify(dir)).join(',')}]`;
  assert.equal(args[args.indexOf(option) - 1], '-c');
  assert.deepEqual(args.slice(-2), [first.session_id, '-']);
});

test('findRun 拒绝相对路径、绝对路径和点目录，last 仍可读取', async (t) => {
  const h = sandbox(t), dir = seedRun(h, '20000101-safe');
  for (const ref of ['../runs/20000101-safe', './20000101-safe', dir, '.', '..']) {
    failed(await h.bridge(['status', '--run', ref]), M.runNotFound(ref));
  }
  assert.equal(output(await h.bridge(['status', '--run', 'last'])).id, '20000101-safe');
});

test('时钟回拨直接取最新时间加一秒，跨年也不会卡住登记锁', async (t) => {
  const h = sandbox(t); seedRun(h, '20991231-235959-zzzz');
  const script = h.write('clock-back.mjs', `import { initializeRecords, newRunDir } from ${url('records.mjs')};
initializeRecords(${JSON.stringify(baseConfig())});
const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2020-01-01T00:00:00Z'])); } };
const run = await newRunDir(); run.release(); console.log(JSON.stringify(run.id));`);
  assert.match(output(await h.start(script, [], { timeout: 5000 }).done), /^21000101-000000-[a-z0-9]{4}$/);
  assert.equal(fs.existsSync(path.join(h.runs, '.start.lock')), false);
});

test('出图参数只信最后一次展开之后明确写出的属性', async (t) => {
  const h = sandbox(t), values = [
    "{referenced_image_paths:['a.png'],num_last_images_to_include:1,transparent_background:true,...extra}",
    "{...extra,referenced_image_paths:['a.png'],num_last_images_to_include:1,transparent_background:true}",
    "{referenced_image_paths:['a.png'],...extra,num_last_images_to_include:null,transparent_background:false}",
  ];
  const script = h.write('spread.mjs', `import { parseImageArgs } from ${url('image-calls.mjs')};
console.log(JSON.stringify(${JSON.stringify(values)}.map(parseImageArgs)));`);
  assert.deepEqual(output(await h.start(script).done), [
    { referenced_image_paths: 'unknown', num_last_images_to_include: 'unknown', transparent_background: null },
    { referenced_image_paths: ['a.png'], num_last_images_to_include: 1, transparent_background: true },
    { referenced_image_paths: 'unknown', num_last_images_to_include: null, transparent_background: false },
  ]);
});

test('讨论缺失用量时 usage 和 usage_scope 都写 null', async (t) => {
  const h = sandbox(t);
  const script = h.write('missing-usage.mjs', `import { initializeRecords, newRunDir } from ${url('records.mjs')};
import { startRun, finishDiscussion } from ${url('runner.mjs')};
const cfg = ${JSON.stringify(baseConfig())}; initializeRecords(cfg);
const ctx = { ...await newRunDir(), cfg, cwd: ${JSON.stringify(h.cwd)}, mode: 'discuss', kind: 'discuss', module: 'discuss',
  agentName: 'codex', agent: { type: 'api' }, opts: { scope: [] } };
const run = startRun(ctx); run.meta.status = 'done';
finishDiscussion(run, { errors: [], notes: [], warnings: [], report: ${JSON.stringify(discussion)}, files: [] });`);
  const r = output(await h.start(script).done);
  assert.equal(r.usage, null); assert.equal(r.usage_scope, null);
});

test('diff 审查结束复核也包含附件指纹', async (t) => {
  const h = sandbox(t); h.initGit(); h.write('evidence.txt', 'before\n');
  const gate = path.join(h.home, 'review-finish'), s = h.scenario({ steps: [{ wait_for: gate }] });
  const handle = h.startBridge(taskArgs(h, 'review', ['--commit', 'HEAD', '--file', 'evidence.txt']), { env: s.env });
  await poll(() => s.calls().length, '审查已经取得原材料');
  h.write('evidence.txt', 'after\n'); write(gate, 'go');
  const r = output(await handle.done);
  assert.equal(r.stale, true); assert.ok(r.warnings.includes(M.reviewScopeChanged));
});

test('目录自报包含忽略文件和子目录时算快照外，track 覆盖的部分可以排除', async (t) => {
  const h = sandbox(t); h.initGit();
  h.write('.gitignore', 'src/private/\nsrc/*.secret\nsrc/empty/\n');
  h.write('src/visible.txt', 'visible\n'); h.write('src/private/data.txt', 'private\n');
  h.write('src/key.secret', 'before\n'); fs.mkdirSync(path.join(h.cwd, 'src/empty'));
  const s = h.scenario({ files: { 'src/key.secret': 'after\n' },
    last_message: { ...discussion, files_changed: [{ path: 'src/', change: '修改目录里的文件' }] } });
  const r = output(await h.bridge(taskArgs(h, 'discuss'), { env: s.env }), 1);
  assert.equal(r.changes.available, true); assert.deepEqual(r.changes.files, []);
  assert.deepEqual(r.readonly_violation, [{ path: 'src', by: 'reported' }]);
  const tracked = output(await h.bridge(taskArgs(h, 'discuss', ['--track', 'src/private', '--track', 'src/key.secret', '--track', 'src/empty']), { env: s.env }));
  assert.equal(tracked.changes.available, true); assert.deepEqual(tracked.readonly_violation, []);
});

test('目录里被忽略的文件在任务中被删掉也算快照外；--track 的文件在被忽略目录里时不把整个目录算成盲区', async (t) => {
  const h = sandbox(t); h.initGit();
  h.write('.gitignore', 'src/*.secret\ndist/\n');
  h.write('src/visible.txt', 'visible\n'); h.write('src/key.secret', 'before\n'); h.write('dist/app.zip', 'zip\n');
  const deleted = h.scenario({ files: { 'src/key.secret': null }, last_message: { ...discussion, files_changed: [{ path: 'src/', change: '删掉目录里的文件' }] } });
  const r = output(await h.bridge(taskArgs(h, 'discuss'), { env: deleted.env }), 1);
  assert.equal(fs.existsSync(path.join(h.cwd, 'src/key.secret')), false);
  assert.deepEqual(r.readonly_violation, [{ path: 'src', by: 'reported' }]);
  const covered = h.scenario({ last_message: { ...discussion, files_changed: [{ path: 'dist/', change: '只看了打包结果' }] } });
  assert.deepEqual(output(await h.bridge(taskArgs(h, 'discuss', ['--track', 'dist/app.zip']), { env: covered.env })).readonly_violation, []);
  // dist/ 里多出一个没被 --track 的被忽略文件，就又是盲区
  h.write('dist/other.bin', 'other\n');
  assert.deepEqual(output(await h.bridge(taskArgs(h, 'discuss', ['--track', 'dist/app.zip']), { env: covered.env }), 1).readonly_violation, [{ path: 'dist', by: 'reported' }]);
});

test('covers 命令出错时保留快照，所有非 root 自报从严计违规', async (t) => {
  const h = sandbox(t); h.write('unchanged.txt', 'before\n'); h.write('src/visible.txt', 'before\n');
  const s = h.scenario({ last_message: { ...discussion, files_changed: ['./', 'unchanged.txt', 'src/'].map((path) => ({ path, change: '自报修改' })) } });
  const script = h.write('covers-failed.mjs', `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync;
childProcess.spawnSync = (file, args, options) => file === 'git' && args.includes('check-ignore')
  ? { status: 128, stdout: '', stderr: 'synthetic coverage failure' } : spawn(file, args, options);
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const r = output(await h.start(script, plannedArgs(h, taskArgs(h, 'discuss')), { env: s.env }).done, 1);
  assert.equal(r.changes.available, true); assert.deepEqual(r.changes.files, []);
  assert.deepEqual(r.readonly_violation, ['unchanged.txt', 'src'].map((path) => ({ path, by: 'reported' })));
  assert.ok(r.warnings.includes(M.trackingFailed(M.gitFailed('check-ignore', 'synthetic coverage failure'))));
});

test('Codex 续接合并用户 TOML 可写目录，支持跨行注释、单双引号、点号键和带引号的表头，读不懂时不覆盖', async (t) => {
  const h = sandbox(t), roots = ['user # ] root', 'literal root', '二'].map((name) => path.join(h.home, name));
  const extra = path.join(h.home, 'extra'); [...roots, extra].forEach((dir) => fs.mkdirSync(dir));
  const config = path.join(h.env.CODEX_HOME, 'config.toml');
  write(config, `[sandbox_workspace_write] # 用户的表
writable_roots = [
  ${JSON.stringify(roots[0])}, # 双引号里的井号和括号不是分隔符
  '${roots[1]}',
  ${JSON.stringify(roots[2]).replace('二', '\\U00004E8C')},
]
[profiles.ignored.sandbox_workspace_write]
writable_roots = ['profile-only']
`.replace(/\n/g, '\r\n'));
  const first = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot', '--add-dir', roots[0]])));
  const next = output(await h.bridge(resume(first.run_id, ['--add-dir', extra])));
  const writable = () => {
    const value = h.calls().at(-1).args.find((arg) => arg.startsWith('sandbox_workspace_write.writable_roots='));
    assert.ok(value); return JSON.parse(value.slice(value.indexOf('=') + 1));
  };
  assert.deepEqual(writable(), [...roots, extra]);
  assert.deepEqual(json(path.join(next.run_dir, 'meta.json')).add_dir, [roots[0], extra]);
  // 读不懂时不传 -c，免得覆盖掉用户的数组，并提示额外目录这次没生效
  write(config, '[sandbox_workspace_write]\nwritable_roots = ["keep-user-value", 7]\n');
  const unread = await h.bridge(resume(next.run_id));
  const third = output(unread);
  assert.ok(unread.stderr.includes(M.codexWritableRootsUnread(config)), unread.stderr);
  assert.equal(h.calls().at(-1).args.some((arg) => arg.startsWith('sandbox_workspace_write.writable_roots=')), false);
  // 顶层的点号键和带引号的表头都认得
  write(config, `model = "x"\nsandbox_workspace_write.writable_roots = [${JSON.stringify(roots[1])}]\n[other]\nwritable_roots = ["not-this"]\n`);
  const fourth = output(await h.bridge(resume(third.run_id)));
  assert.deepEqual(writable(), [roots[1], roots[0], extra]);
  write(config, `["sandbox_workspace_write"]\n"writable_roots" = [${JSON.stringify(roots[2])}]\n`);
  output(await h.bridge(resume(fourth.run_id)));
  assert.deepEqual(writable(), [roots[2], roots[0], extra]);
});

test('计划轮次、准入提示和无当前会话的组视图都按 run id 选最新', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'run', '--cell', 'complex', '--group', 'clock-order', '--seat', 'codex']));
  const first = '20000101-000000-aaaa', latest = '20000101-000001-aaaa';
  seedRun(h, first, { plan: p.plan_id, seat: 1, group: p.group, claude_session: 'ahead', started_at: new Date().toISOString() }, { status: 'done', report });
  seedRun(h, latest, { plan: p.plan_id, seat: 1, group: p.group, claude_session: 'backward', status: 'failed',
    started_at: new Date(Date.now() - 60000).toISOString() }, { status: 'failed', report: null });
  const state = output(await h.bridge(['status', '--plan', p.plan_id]));
  assert.equal(state.state, 'incomplete'); assert.equal(state.seats[0].run_id, latest);
  assert.deepEqual(state.seats[0].runs, [first, latest]);
  failed(await h.bridge(['run', '--plan', p.plan_id, '--seat', '1', '--brief', '-', '--scope', 'src', '--no-snapshot']), M.seatAlreadyStarted(p.plan_id, 1, latest));
  const group = await h.bridge(['status', '--group', p.group], { env: { CLAUDE_CODE_SESSION_ID: 'unrelated' } });
  assert.equal(group.code, 0, group.stderr); assert.ok(group.stdout.includes(latest)); assert.ok(!group.stdout.includes(first));
});

test('生成 run id 忽略 backup、zzz 等非格式目录并释放登记锁', async (t) => {
  const h = sandbox(t); for (const id of ['backup', 'zzz', '20991231-235959-aaaa']) seedRun(h, id);
  const script = h.write('id-with-backups.mjs', `import { initializeRecords, newRunDir } from ${url('records.mjs')};
initializeRecords(${JSON.stringify(baseConfig())});
const run = await newRunDir(); run.release(); console.log(JSON.stringify(run.id));`);
  assert.match(output(await h.start(script, [], { timeout: 5000 }).done), /^21000101-000000-[a-z0-9]{4}$/);
  assert.equal(fs.existsSync(path.join(h.runs, '.start.lock')), false);
});

test('多条坏元数据共享约一秒的准入重读预算，仍列出所有坏路径', async (t) => {
  const h = sandbox(t), files = Array.from({ length: 6 }, (_, i) => {
    const dir = seedRun(h, `20000101-00000${i}-aaaa`), file = path.join(dir, 'meta.json'); write(file, '{'); return file;
  }).reverse();
  const script = h.write('admission-budget.mjs', `import { initializeRecords, newRunDir, saveMeta, checkAdmission } from ${url('records.mjs')};
const cfg = ${JSON.stringify(baseConfig())}; initializeRecords(cfg);
const run = await newRunDir(), meta = { id: run.id, cwd: ${JSON.stringify(h.cwd)}, agent: 'codex' };
try {
  saveMeta(run.dir, meta); const started = performance.now(), error = checkAdmission(meta, cfg);
  console.log(JSON.stringify({ error, elapsed: performance.now() - started }));
} finally { run.release(); }`);
  const r = output(await h.start(script).done);
  assert.equal(r.error, M.admissionUnreadable(M.list(files)));
  assert.ok(r.elapsed >= 900 && r.elapsed < 2500, `准入耗时 ${r.elapsed} ms`);
  assert.equal(h.calls().length, 0); assert.equal(fs.existsSync(path.join(h.runs, '.start.lock')), false);
});

test('非审查席没有续接材料时可重启，有有效结果、会话或 API 消息时仍拒绝', async (t) => {
  const h = sandbox(t), p = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'run', '--cell', 'complex', '--group', 'restart-exec', '--seat', 'codex']));
  const args = ['run', '--plan', p.plan_id, '--seat', '1', '--brief', '-', '--scope', 'src', '--no-snapshot'];
  seedRun(h, '20000101-000000-aaaa', { plan: p.plan_id, seat: 1, status: 'failed', session_id: null });
  const r = output(await h.bridge(args));
  assert.equal(r.parent, null); assert.equal(r.plan, p.plan_id);
  const file = path.join(r.run_dir, 'meta.json'), meta = json(file);
  write(file, { ...meta, session_id: null });
  failed(await h.bridge(args), M.seatAlreadyStarted(p.plan_id, 1, r.run_id));
  write(file, { ...meta, status: 'failed' }); write(path.join(r.run_dir, 'result.json'), { status: 'failed', report: null });
  failed(await h.bridge(args), M.seatAlreadyStarted(p.plan_id, 1, r.run_id));
  write(file, { ...meta, status: 'failed', session_id: null }); write(path.join(r.run_dir, 'messages.json'), []);
  failed(await h.bridge(args), M.seatAlreadyStarted(p.plan_id, 1, r.run_id));
  fs.rmSync(path.join(r.run_dir, 'messages.json'));
  const restarted = output(await h.bridge(args));
  assert.equal(restarted.parent, null); assert.notEqual(restarted.run_id, r.run_id);
});

test('旧续接缺 kind 和 module 时沿祖先识别讨论并继续计轮数', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.dispatch.discuss_max_rounds = 3; c.modules.default.run.complex = 'claude code'; h.config(c);
  const root = '20000101-000000-aaaa', middle = '20000101-000001-aaaa', latest = '20000101-000002-aaaa';
  const legacy = { kind: undefined, module: undefined, group: 'legacy-discussion' };
  seedRun(h, root, { ...legacy, mode: 'discuss' });
  seedRun(h, middle, { ...legacy, mode: 'resume', parent: root, status: 'timeout' });
  seedRun(h, latest, { ...legacy, mode: 'resume', parent: middle });
  const s = h.scenario({ last_message: discussion });
  const r = output(await h.bridge(['resume', '--run', latest, '--level', 'complex', '--brief', '-'], { env: s.env }));
  assert.equal(r.kind, 'discuss'); assert.equal(r.module, 'discuss'); assert.equal(r.round, 3);
  assert.ok(s.calls()[0].stdin.includes(M.discussResumeFooter));
  failed(await h.bridge(['resume', '--run', r.run_id, '--level', 'complex', '--brief', '-']), M.discussRoundsExceeded(root, 3, 3));
});

test('missing.label 和计划行沿用面板状态词，blocked 和 partial 不写成无结果', async (t) => {
  const h = sandbox(t), id = 'plan-labels', run = '20000101-000000-aaaa';
  write(path.join(h.runs, 'plans', `${id}.json`), { plan_id: id, module: 'run', group: 'labels', required: ['codex'],
    seats: [{ seat: 1, agent: 'codex', role: 'gap', required: true }] });
  for (const [result, label] of [[{ report: { ...report, status: 'blocked' } }, 'questions returned'],
    [{ report: { ...report, status: 'partial' } }, 'partly done'], [{ report: null }, 'no valid result']]) {
    seedRun(h, run, { plan: id, seat: 1, group: 'labels' }, { status: 'done', ...result });
    const state = output(await h.bridge(['status', '--plan', id]));
    assert.deepEqual(state.missing, [{ seat: 1, agent: 'codex', status: 'done', label }]);
    assert.deepEqual(state.missing_required, [{ seat: 1, agent: 'codex', status: 'done' }]);
    const listed = await h.bridge(['status', '--group', 'labels']);
    assert.equal(listed.code, 0, listed.stderr);
    const line = listed.stdout.split('\n').find((line) => line.startsWith(`Plan ${id}:`));
    assert.ok(line?.includes(`codex (seat 1, ${label})`), listed.stdout);
    assert.ok(listed.stdout.split('\n').find((line) => line.startsWith(run))?.includes(label));
    if (label !== 'no valid result') assert.ok(!line.includes('no valid result'), line);
  }
});

test('watch 组视图同计划同席只显示 run id 最大的重启轮次，计划仍保留完整历史', async (t) => {
  const h = sandbox(t), plan = 'restart-watch', group = 'restart-watch-group';
  write(path.join(h.runs, 'plans', `${plan}.json`), { plan_id: plan, module: 'run', group, required: ['codex'],
    seats: [1, 2].map((seat) => ({ seat, agent: 'codex', required: true })) });
  const old = '20000101-000000-aaaa', latest = '20000101-000001-aaaa', other = '20000101-000002-aaaa';
  seedRun(h, old, { plan, group, seat: 1, status: 'failed', title: '旧的失败轮次', started_at: new Date().toISOString() }, { status: 'failed' });
  seedRun(h, latest, { plan, group, seat: 1, title: '新的轮次' }, { status: 'done', report });
  seedRun(h, other, { plan, group, seat: 2 }, { status: 'done', report });
  const watched = await h.bridge(['watch', '--group', group]);
  assert.equal(watched.code, 0, watched.stderr);
  assert.ok(watched.stdout.includes(latest)); assert.ok(watched.stdout.includes(other));
  assert.ok(!watched.stdout.includes(old)); assert.ok(!watched.stdout.includes('旧的失败轮次'));
  assert.equal(watched.stdout.match(/^✔ /gm)?.length, 2, watched.stdout);
  const status = output(await h.bridge(['status', '--plan', plan]));
  assert.equal(status.state, 'complete'); assert.deepEqual(status.seats[0].runs, [old, latest]);
});

test('出图参数的展开前允许块注释和行注释，注释里的逗号与括号不干扰解析', async (t) => {
  const h = sandbox(t), values = [
    "{referenced_image_paths:['a.png'],num_last_images_to_include:1,transparent_background:true,/* comma, } [ */ ...extra}",
    "{referenced_image_paths:['a.png'],num_last_images_to_include:1,transparent_background:true,// comma, } [\n/* again */ ...extra}",
    "{/* before */ ...extra, // field, }\n referenced_image_paths:['a.png'],/* field */ num_last_images_to_include:1,transparent_background:true}",
  ];
  const script = h.write('commented-spread.mjs', `import { parseImageArgs } from ${url('image-calls.mjs')};
console.log(JSON.stringify(${JSON.stringify(values)}.map(parseImageArgs)));`);
  const unknown = { referenced_image_paths: 'unknown', num_last_images_to_include: 'unknown', transparent_background: null };
  assert.deepEqual(output(await h.start(script).done), [unknown, unknown,
    { referenced_image_paths: ['a.png'], num_last_images_to_include: 1, transparent_background: true }]);
});
