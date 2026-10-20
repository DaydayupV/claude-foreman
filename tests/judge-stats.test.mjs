import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { sandbox, seedRun, write, json, output, failed, poll, MESSAGES, BRIDGE, CODEX } from './helpers.mjs';

const M = MESSAGES.zh;
const review = { module: 'review', mode: 'review', kind: 'review' };
const report = (...ids) => ({ status: 'done', report: { findings: ids.map((id) => ({ id })) } });
const usage = (input, cached = 0, out = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: out });
const verdict = (dir, items) => write(path.join(dir, 'verdict.json'), { items });

test('judge 写入规定字段、保留未修改条目，第二次调用覆盖去留并补齐 unjudged', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', { ...review, group: 'audit' }, report('F1', 'F2', 'F3'));
  const first = output(await h.bridge(['judge', '--run', 'review-a', '--accept', ' F1, ,F1, ', '--partial', 'F2']));
  assert.equal(Object.hasOwn(first, 'cleared'), false);
  assert.deepEqual(Object.keys(json(first.file)), ['run_id', 'module', 'plan', 'seat', 'group', 'claude_session', 'agent', 'model', 'updated_at', 'items']);
  assert.equal(first.file, path.join(dir, 'verdict.json'));
  assert.deepEqual([first.module, first.plan, first.seat, first.group, first.claude_session, first.agent, first.model], ['review', null, null, 'audit', 'test-session', 'codex', 'fake-codex']);
  assert.deepEqual(first.unjudged, ['F3']);
  assert.deepEqual(first.items.F1, { verdict: 'accept', at: first.updated_at });
  const second = output(await h.bridge(['judge', '--run', 'last', '--reject', 'F2', '--accept', 'F3']));
  assert.deepEqual(second.items.F1, first.items.F1);
  assert.equal(second.items.F2.verdict, 'reject');
  assert.equal(second.items.F3.verdict, 'accept');
  assert.deepEqual(second.unjudged, []);
  const { file, unjudged, ...saved } = second;
  assert.deepEqual(json(file), saved);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('judge 拒绝空调用、不合格或未知编号、冲突、运行中任务和执行任务', async (t) => {
  const h = sandbox(t);
  seedRun(h, 'review-a', review, report('F1', 'F2'));
  seedRun(h, 'review-empty', review, report());
  const running = seedRun(h, 'review-running', { ...review, status: 'running', pid: process.pid, ended_at: undefined });
  const exec = seedRun(h, 'exec-a');
  for (const [args, message] of [
    [[], M.judgeNothing],
    [['--accept', '1F'], M.judgeBadId('1F')],
    [['--accept', 'F'.repeat(33)], M.judgeBadId('F'.repeat(33))],
    [['--accept', 'F3'], M.judgeUnknownId('F3', 'review-a', M.list(['F1', 'F2']))],
    [['--accept', 'F1', '--partial', 'F1'], M.judgeConflict('F1')],
  ]) failed(await h.bridge(['judge', '--run', 'review-a', ...args]), message);
  failed(await h.bridge(['judge', '--run', 'review-empty', '--reject', 'F1']), M.judgeUnknownId('F1', 'review-empty', M.judgeNoIds));
  failed(await h.bridge(['judge', '--run', 'review-running', '--accept', 'F1']), M.judgeRunning('review-running'));
  failed(await h.bridge(['judge', '--run', 'exec-a', '--accept', 'F1']), M.judgeModule('exec-a', 'run'));
  for (const dir of [running, exec]) assert.equal(fs.existsSync(path.join(dir, 'verdict.json')), false);
});

test('judge --same 校验语法、自指、同伴、两端编号、目标存在以及左侧去留', async (t) => {
  const h = sandbox(t);
  seedRun(h, 'review-a', { ...review, plan: 'plan-a' }, report('F1', 'F2'));
  seedRun(h, 'review-b', { ...review, plan: 'plan-a' }, report('F3'));
  seedRun(h, 'review-c', { ...review, plan: 'plan-c' }, report('F3'));
  for (const [same, message] of [
    ['F1=review-b', M.judgeBadSame('F1=review-b')],
    ['F1=review-a:F1', M.judgeSameSelf('F1=review-a:F1')],
    ['F1=review-c:F3', M.judgeSameNotPeer('F1=review-c:F3', 'review-c')],
    ['F1=absent:F3', M.runNotFound('absent')],
    ['F1=review-b:F4', M.judgeUnknownId('F4', 'review-b', 'F3')],
    ['F1=review-b:1F', M.judgeBadId('1F')],
    ['F9=review-b:F3', M.judgeUnknownId('F9', 'review-a', M.list(['F1', 'F2']))],
    ['F1=review-b:F3', M.judgeSameUnjudged('F1')],
  ]) failed(await h.bridge(['judge', '--run', 'review-a', '--same', same]), message);
});

test('judge --same 合并同编号多条链接、去重、整体替换并保留其他编号的链接', async (t) => {
  const h = sandbox(t);
  seedRun(h, 'a', { ...review, plan: 'plan-a', group: 'left' }, report('F1', 'F2'));
  seedRun(h, 'b', { ...review, plan: 'plan-a', group: 'right' }, report('F3', 'F4'));
  seedRun(h, 'c', { ...review, plan: 'plan-a' }, report('F5'));
  const first = output(await h.bridge(['judge', '--run', 'a', '--accept', 'F1,F2', '--same', ' F1=b:F3,F1=c:F5,F1=b:F3,F2=b:F4, ']));
  assert.deepEqual(first.items.F1.same_as, ['b:F3', 'c:F5']);
  assert.deepEqual(Object.keys(first.items.F1), ['verdict', 'same_as', 'at']);
  const second = output(await h.bridge(['judge', '--run', 'a', '--same', 'F1=b:F4']));
  assert.deepEqual(second.items.F1.same_as, ['b:F4']);
  assert.deepEqual(second.items.F2, first.items.F2);
  const third = output(await h.bridge(['judge', '--run', 'a', '--partial', 'F1']));
  assert.equal(third.items.F1.verdict, 'partial');
  assert.deepEqual(third.items.F1.same_as, ['b:F4']);
});

test('judge --same 拒绝运行中同伴且不写文件，运行中任务也不能 clear', async (t) => {
  const h = sandbox(t), peer = h.start('-e', ['setInterval(()=>{},1000)']);
  await once(peer.child, 'spawn');
  const dir = seedRun(h, 'review-a', { ...review, plan: 'plan-a' }, report('F1'));
  const other = seedRun(h, 'review-b', { ...review, plan: 'plan-a', status: 'running', pid: peer.child.pid,
    started_at: new Date().toISOString(), ended_at: undefined });
  const before = [fs.readdirSync(dir), fs.readdirSync(other)], same = 'F1=review-b:F99';
  failed(await h.bridge(['judge', '--run', 'review-a', '--accept', 'F1', '--same', same]), M.judgeSameRunning(same, 'review-b'));
  failed(await h.bridge(['judge', '--run', 'review-b', '--clear', 'F99']), M.judgeRunning('review-b'));
  assert.deepEqual([fs.readdirSync(dir), fs.readdirSync(other)], before);
});

test('judge 只给 --clear 可删除报告外的误记和自身链接，保留其他条目及同伴链接', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'a', { ...review, plan: 'p' }, report('F1'));
  const other = seedRun(h, 'b', { ...review, plan: 'p' }, report('F2'));
  const keep = { verdict: 'partial', same_as: ['b:F2'], at: '2000-01-01T00:00:00Z' };
  verdict(dir, { F99: { verdict: 'accept', same_as: ['b:F2'] }, F1: keep });
  const peerFile = verdict(other, { F2: { verdict: 'accept', same_as: ['a:F99'] } });
  const peerBefore = fs.readFileSync(peerFile, 'utf8');
  const r = output(await h.bridge(['judge', '--run', 'a', '--clear', ' F99, ,F99, ']));
  assert.deepEqual(r.cleared, ['F99']);
  assert.deepEqual(r.items, { F1: keep });
  assert.deepEqual(json(r.file).items, r.items);
  assert.equal(Object.hasOwn(json(r.file), 'cleared'), false);
  assert.equal(fs.readFileSync(peerFile, 'utf8'), peerBefore);
});

test('judge --clear 删完移除 verdict，file 为 null 且 stats 不再计为记过去留', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, report('F1', 'F2'));
  const file = verdict(dir, { F1: { verdict: 'accept' }, F2: { verdict: 'reject' } });
  assert.equal(output(await h.bridge(['stats'])).totals.judged_runs, 1);
  const r = output(await h.bridge(['judge', '--run', 'review-a', '--clear', 'F1, F2']));
  assert.equal(r.file, null);
  assert.deepEqual(r.cleared, ['F1', 'F2']);
  assert.deepEqual(r.items, {});
  assert.deepEqual(r.unjudged, ['F1', 'F2']);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('verdict.json')), []);
  const stats = output(await h.bridge(['stats']));
  assert.deepEqual([stats.totals.judged_runs, stats.rows[0].judged_runs, stats.rows[0].judged], [0, 0, 0]);
});

test('judge --clear 删完 no_issues 审查席的误记后恢复自动零条统计', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, { report: { verdict: 'no_issues', findings: [] } });
  verdict(dir, { F99: { verdict: 'accept' } });
  const r = output(await h.bridge(['judge', '--run', 'review-a', '--clear', 'F99']));
  assert.equal(r.file, null);
  assert.equal(fs.existsSync(path.join(dir, 'verdict.json')), false);
  const stats = output(await h.bridge(['stats']));
  assert.deepEqual([stats.totals.judged_runs, stats.rows[0].judged_runs, stats.rows[0].judged], [1, 1, 0]);
});

test('judge --clear 拒绝未记过或格式错误的编号，报出已记列表且不改文件', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, report('F1', 'F2'));
  const file = verdict(dir, { F1: { verdict: 'accept' }, F2: { verdict: 'reject' } }), before = fs.readFileSync(file, 'utf8');
  for (const [ids, message] of [
    ['F1,F9', M.judgeClearUnknown('F9', 'review-a', M.list(['F1', 'F2']))],
    ['1F', M.judgeBadId('1F')],
    ['F'.repeat(33), M.judgeBadId('F'.repeat(33))],
  ]) failed(await h.bridge(['judge', '--run', 'review-a', '--clear', ids]), message);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('verdict.json.')), []);
  const empty = seedRun(h, 'review-empty', review, report());
  failed(await h.bridge(['judge', '--run', 'review-empty', '--clear', 'F1']), M.judgeClearUnknown('F1', 'review-empty', M.judgeNoIds));
  assert.deepEqual(fs.readdirSync(empty).filter((name) => name.startsWith('verdict.json')), []);
});

test('judge --clear 与 accept partial reject 或 same 左侧冲突时锁外拒绝', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, report('F1'));
  const file = verdict(dir, { F1: { verdict: 'accept' } }), before = fs.readFileSync(file, 'utf8');
  const lock = `${file}.lock`, owner = { pid: process.pid, at: new Date().toISOString() };
  write(lock, owner);
  for (const args of [['--accept', 'F1'], ['--partial', 'F1'], ['--reject', 'F1'], ['--same', 'F1=review-b:F2']]) {
    failed(await h.bridge(['judge', '--run', 'review-a', '--clear', 'F1', ...args]), M.judgeClearConflict('F1'));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(json(lock), owner);
});

test('judge --clear 等到锁后按最新 items 校验并删除', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, report('F1'));
  const keep = { verdict: 'partial' }, file = verdict(dir, { F1: keep }), lock = `${file}.lock`;
  const attempted = path.join(h.cwd, 'attempted');
  write(lock, { pid: process.pid, at: new Date().toISOString() });
  const preload = h.write('judge-clear-gate.mjs', `
import fs from 'node:fs';
const write = fs.writeFileSync;
fs.writeFileSync = function (name, ...args) {
  if (String(name) === ${JSON.stringify(lock)}) write(${JSON.stringify(attempted)}, '');
  return write.call(this, name, ...args);
};
`);
  const pending = h.startBridge(['judge', '--run', 'review-a', '--clear', 'F99'], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  await poll(() => fs.existsSync(attempted) || pending.child.exitCode !== null, 'clear 尝试拿锁或退出');
  verdict(dir, { F1: keep, F99: { verdict: 'reject' } });
  fs.rmSync(lock);
  const r = output(await pending.done);
  assert.deepEqual(r.cleared, ['F99']);
  assert.deepEqual(json(file).items, { F1: keep });
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('verdict.json.')), []);
});

test('judge 支持讨论自由编号、旧续接的根模块和原生审查，旧 verdict 损坏时重新记', async (t) => {
  const h = sandbox(t);
  seedRun(h, 'discuss-root', { module: undefined, kind: 'discuss', mode: 'discuss', group: 'topic' });
  seedRun(h, 'discuss-resume', { module: undefined, kind: undefined, mode: 'resume', parent: 'discuss-root', group: 'topic' });
  const dir = seedRun(h, 'discuss-peer', { module: 'discuss', kind: 'discuss', mode: 'discuss', group: 'topic' });
  verdict(dir, { P1: { verdict: 'invalid' } });
  assert.equal(output(await h.bridge(['judge', '--run', 'discuss-peer', '--accept', 'P1'])).unjudged, null);
  const r = output(await h.bridge(['judge', '--run', 'discuss-resume', '--partial', 'P.2_-', '--same', 'P.2_-=discuss-peer:P1']));
  assert.equal(r.module, 'discuss');
  assert.equal(r.items['P.2_-'].verdict, 'partial');
  for (const [id, extra] of [['other-session', { claude_session: 'elsewhere' }], ['other-module', review], ['no-group', { group: null }]]) {
    seedRun(h, id, { module: 'discuss', kind: 'discuss', mode: 'discuss', group: 'topic', ...extra });
    const same = `P.2_-=${id}:P1`;
    failed(await h.bridge(['judge', '--run', 'discuss-resume', '--same', same]), M.judgeSameNotPeer(same, id));
  }
  const native = seedRun(h, 'native-review', { module: undefined, kind: undefined, mode: 'review' });
  write(path.join(native, 'verdict.json'), '{broken');
  assert.equal(output(await h.bridge(['judge', '--run', 'native-review', '--reject', 'Legacy1'])).items.Legacy1.verdict, 'reject');
});

test('judge 和 stats 的 --help/-h 在坏配置下仍输出中英文用法且不创建记录目录', async (t) => {
  const h = sandbox(t);
  write(h.userConfig, '{broken');
  for (const lang of ['zh', 'en']) for (const cmd of ['judge', 'stats']) for (const flag of ['--help', '-h']) {
    const r = await h.bridge([cmd, flag], { env: { FOREMAN_LANG: lang } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, MESSAGES[lang].help[cmd] + '\n');
    assert.equal(r.stderr, '');
  }
  assert.equal(fs.readFileSync(h.userConfig, 'utf8'), '{broken');
  assert.equal(fs.existsSync(h.runs), false);
});

test('stats 合并两种接入的基础模型，保留用量缺失并只对 opencode/pi 计费用缺失', async (t) => {
  const h = sandbox(t);
  seedRun(h, 'oc-1', { ...review, model: 'opencode-go/Deepseek-V4.1-Flash', agent_type: 'opencode cli' }, { ...report('F1', 'F2'), model: 'ignored', duration_s: 2, usage: usage(100, 20, 30), cost_usd: 0.25 });
  seedRun(h, 'oc-2', { ...review, model: 'deepseek-v4.1-flash', agent_type: 'opencode cli' }, { duration_s: 4, usage: null });
  seedRun(h, 'api-1', { ...review, model: null, agent_type: 'api' }, { model: 'deepseek-v4.1-flash', duration_s: 6 });
  seedRun(h, 'pi-1', { ...review, model: 'deepseek/deepseek-flash', agent_type: 'pi cli' }, { duration_s: 3 });
  seedRun(h, 'api-2', { ...review, model: 'deepseek-flash', agent_type: 'api' }, { duration_s: 5 });
  seedRun(h, 'codex-1', { ...review, model: null, model_shown: 'GPT 6 (from Codex config)' });
  seedRun(h, 'codex-2', { ...review, model: null, model_shown: 'GPT 6（来自 Codex 配置）' });
  seedRun(h, 'unknown', { ...review, model: null, started_at: '2026-10-10T00:00:00Z', ended_at: '2026-10-10T00:00:04Z' });
  const r = output(await h.bridge(['stats']));
  assert.deepEqual(r.rows.map((row) => [row.model, row.seats]), [['deepseek-v4.1-flash', 3], ['deepseek-flash', 2], ['gpt-6', 2], ['unknown', 1]]);
  const [flash, pi, codex, unknown] = r.rows;
  assert.deepEqual(flash.tokens, { input: 100, cached_input: 20, output: 30, runs: 1, missing_runs: 2 });
  assert.deepEqual(flash.cost_usd, { total: 0.25, runs: 1, missing_runs: 1 });
  assert.deepEqual(flash.duration_s, { total: 12, median_per_seat: 4, missing_runs: 0 });
  assert.equal(flash.findings_reported, 2);
  assert.deepEqual(pi.cost_usd, { total: null, runs: 0, missing_runs: 1 });
  assert.deepEqual(codex.cost_usd, { total: null, runs: 0, missing_runs: 0 });
  assert.deepEqual(codex.tokens, { input: null, cached_input: null, output: null, runs: 0, missing_runs: 2 });
  assert.equal(unknown.duration_s.total, 4);
});

test('stats 按链扣除累计用量、处理倒退并将升级轮次记在各自模型上', async (t) => {
  const h = sandbox(t);
  const rounds = [
    ['a1', null, 'small', 2, usage(100, 20, 10), undefined],
    ['a2', 'a1', 'large', 3, usage(150, 30, 20), undefined],
    ['a3', 'a2', 'large', 4, usage(25, 5, 5), 'this_run'],
    ['a4', 'a3', 'large', 5, usage(160, 31, 24), 'session_total'],
    ['a5', 'a4', 'large', 6, usage(190, 41, 34), 'session_total'],
    ['b1', null, 'small', 4, usage(0), 'this_run'],
    ['b2', 'b1', 'large', undefined, null, undefined],
  ];
  for (const [i, [id, parent, model, duration_s, tokens, usage_scope]] of rounds.entries()) {
    seedRun(h, id, { parent, model, mode: parent ? 'resume' : 'run', started_at: new Date(1700000000000 + i * 10000).toISOString(), ended_at: undefined, session_id: null },
      { status: 'done', duration_s, usage: tokens, usage_scope });
  }
  const r = output(await h.bridge(['stats'])), [small, large] = r.rows;
  assert.deepEqual([r.totals.seats, r.totals.runs, small.model, small.seats, large.model, large.seats], [2, 7, 'small', 2, 'large', 0]);
  assert.deepEqual(small.tokens, { input: 100, cached_input: 20, output: 10, runs: 2, missing_runs: 0 });
  assert.deepEqual(large.tokens, { input: 105, cached_input: 25, output: 25, runs: 3, missing_runs: 2 });
  assert.deepEqual(small.duration_s, { total: 6, median_per_seat: 20, missing_runs: 0 });
  assert.deepEqual(large.duration_s, { total: 18, median_per_seat: null, missing_runs: 1 });
  assert.deepEqual(large.rework, { seats: 0, reworked: 0, rate: null });
});

test('stats 返工只算正常交回报告后的续接，图像沿根模块统计', async (t) => {
  const h = sandbox(t);
  for (const [i, result] of [
    { status: 'done', report: { status: 'completed' } }, { status: 'done' },
    { status: 'done', needs_decision: true }, { status: 'done', report: { status: 'blocked' } },
    { status: 'failed' }, { status: 'stalled' },
  ].entries()) {
    seedRun(h, `root-${i}`, { status: result.status }, result);
    seedRun(h, `resume-${i}`, { mode: 'resume', parent: `root-${i}` });
  }
  seedRun(h, 'image-root', { module: 'image' }, { status: 'done', report: { status: 'completed' } });
  seedRun(h, 'image-resume', { mode: 'resume', parent: 'image-root' });
  const r = output(await h.bridge(['stats']));
  assert.deepEqual(r.rows.map((row) => [row.module, row.rework]), [
    ['run', { seats: 6, reworked: 2, rate: 0.33 }], ['image', { seats: 1, reworked: 1, rate: 1 }],
  ]);
});

test('stats 同一计划的去留和 --same 无向传递链接按问题计 unique', async (t) => {
  const h = sandbox(t);
  for (const [id, model, ids] of [['a', 'alpha', ['F1', 'F2', 'F3', 'F4', 'F5']], ['b', 'beta', ['F1', 'F2']], ['c', 'alpha', ['F1', 'F2']]]) {
    seedRun(h, id, { ...review, model, plan: 'plan-a' }, report(...ids));
  }
  output(await h.bridge(['judge', '--run', 'a', '--accept', 'F1,F2,F3', '--partial', 'F4', '--reject', 'F5']));
  output(await h.bridge(['judge', '--run', 'b', '--accept', 'F1', '--partial', 'F2', '--same', 'F1=a:F1']));
  output(await h.bridge(['judge', '--run', 'c', '--accept', 'F1,F2', '--same', 'F1=a:F2,F2=b:F1']));
  const r = output(await h.bridge(['stats'])), [alpha, beta] = r.rows;
  assert.equal(r.totals.judged_runs, 3);
  assert.deepEqual([alpha.model, alpha.findings_reported, alpha.judged_runs, alpha.judged, alpha.accepted, alpha.partial, alpha.rejected, alpha.unique, alpha.unique_basis_runs], ['alpha', 7, 2, 7, 5, 1, 1, 3, 2]);
  assert.deepEqual([beta.model, beta.unique, beta.unique_basis_runs], ['beta', 1, 1]);
  assert.equal(alpha.rework, null);
});

test('stats 无计划按组、会话和模块分同伴，单模型和无组记录不参与 unique', async (t) => {
  const h = sandbox(t);
  for (const [id, model, group, session, module, judgment] of [
    ['a1', 'alpha', 'g', 's', 'discuss', 'accept'], ['a2', 'alpha', 'g', 's', 'discuss', 'partial'],
    ['b', 'beta', 'g', 's', 'discuss', 'reject'], ['solo', 'alpha', 'solo', 's', 'discuss', 'accept'],
    ['session', 'beta', 'g', 'other', 'discuss', 'accept'], ['module', 'beta', 'g', 's', 'review', 'accept'],
    ['ungrouped', 'gamma', null, 's', 'discuss', 'accept'],
  ]) {
    const dir = seedRun(h, id, { module, kind: module, mode: module, model, group, claude_session: session });
    verdict(dir, { P1: { verdict: judgment, same_as: ['b:P1', 'absent:P1'] } });
  }
  const r = output(await h.bridge(['stats']));
  assert.deepEqual(r.rows.map((row) => [row.module, row.model, row.unique, row.unique_basis_runs]), [
    ['discuss', 'alpha', 2, 2], ['discuss', 'beta', 0, 1], ['discuss', 'gamma', null, 0], ['review', 'beta', null, 0],
  ]);
  assert.equal(r.rows[0].findings_reported, null);
});

test('stats --module/--since 按根过滤整链，支持小数并拒绝非法值', async (t) => {
  const h = sandbox(t), ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  seedRun(h, 'old-run', { started_at: ago(3) });
  seedRun(h, 'recent-resume', { mode: 'resume', parent: 'old-run', started_at: ago(0.01) });
  seedRun(h, 'old-review', { ...review, started_at: ago(4) });
  seedRun(h, 'fresh-review', { ...review, started_at: ago(0.1) });
  seedRun(h, 'fresh-resume', { ...review, mode: 'resume', parent: 'fresh-review', started_at: ago(0.05) });
  seedRun(h, 'fresh-image', { module: 'image', started_at: ago(0.1) });
  const filtered = output(await h.bridge(['stats', '--module', 'review', '--since', '0.5']));
  assert.deepEqual([filtered.module, filtered.since_days, filtered.totals.runs, filtered.totals.seats], ['review', 0.5, 2, 1]);
  assert.deepEqual(filtered.rows.map((row) => row.module), ['review']);
  assert.equal(output(await h.bridge(['stats', '--module', 'run'])).totals.runs, 2);
  const recent = output(await h.bridge(['stats', '--since', '1']));
  assert.deepEqual([recent.totals.runs, recent.totals.seats], [3, 2]);
  for (const value of ['0', '-1', 'NaN']) failed(await h.bridge(['stats', '--since', value]), M.statsBadSince(value));
  failed(await h.bridge(['stats', '--module', 'foo']), M.statsBadModule('foo', M.list(['discuss', 'review', 'run', 'image'])));
});

test('stats 空记录、坏元数据/结果/verdict 和运行中跳过计数，过滤后只统计保留项', async (t) => {
  const h = sandbox(t);
  const empty = output(await h.bridge(['stats']));
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.totals, { runs: 0, seats: 0, judged_runs: 0, running_skipped: 0, unreadable: 0, unreadable_verdicts: 0 });
  assert.deepEqual(empty.notes, M.statsNotes);
  assert.equal(empty.runs_dir, h.runs);
  seedRun(h, 'bad-meta');
  write(path.join(h.runs, 'bad-meta', 'meta.json'), '{broken');
  seedRun(h, 'running', { status: 'running', pid: process.pid, ended_at: undefined });
  for (const id of ['bad-json', 'bad-shape', 'empty-verdict']) {
    const dir = seedRun(h, id, { ...review, ended_at: undefined, session_id: null });
    if (id === 'bad-json') {
      write(path.join(dir, 'result.json'), '{broken');
      write(path.join(dir, 'verdict.json'), '{broken');
    } else verdict(dir, id === 'bad-shape' ? { F1: { verdict: 'invalid' } } : {});
  }
  const r = output(await h.bridge(['stats']));
  assert.deepEqual(r.totals, { runs: 3, seats: 3, judged_runs: 1, running_skipped: 1, unreadable: 1, unreadable_verdicts: 2 });
  assert.deepEqual(r.rows[0].duration_s, { total: 0, median_per_seat: null, missing_runs: 3 });
  assert.equal(r.rows[0].tokens.missing_runs, 3);
  const filtered = output(await h.bridge(['stats', '--module', 'discuss'], { env: { FOREMAN_LANG: 'en' } }));
  assert.deepEqual(filtered.totals, { runs: 0, seats: 0, judged_runs: 0, running_skipped: 1, unreadable: 1, unreadable_verdicts: 0 });
  assert.deepEqual(filtered.notes, MESSAGES.en.statsNotes);
});

test('runEnd 已处理分支排除 verdict、锁和各进程的临时文件', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'dismissed', { ...review, ended_at: undefined, dismissed_at: new Date().toISOString() });
  const events = path.join(dir, 'events.jsonl'), old = new Date(Date.now() - 86400000);
  fs.utimesSync(events, old, old);
  const end = fs.statSync(events).mtimeMs;
  output(await h.bridge(['judge', '--run', 'dismissed', '--accept', 'F1']));
  write(path.join(dir, 'verdict.json.tmp'), '{}');
  write(path.join(dir, 'verdict.json.lock'), '{}');
  write(path.join(dir, `verdict.json.${process.pid}.tmp`), '{}');
  const records = pathToFileURL(path.join(path.dirname(BRIDGE), 'records.mjs')).href;
  const script = h.write('run-end.mjs', `import { runEnd, readMeta } from ${JSON.stringify(records)};\nconst dir = ${JSON.stringify(dir)};\nprocess.stdout.write(JSON.stringify(runEnd(dir, readMeta(dir))));\n`);
  assert.equal(output(await h.start(script).done), end);
});

test('stats 完整席位链阻止向运行中续接补读，排除中位用时并跳过运行中的根', async (t) => {
  const h = sandbox(t), scenario = h.scenario({ stats: { info: { total_token_usage: usage(900, 100, 200) } } });
  const generated = await h.start(CODEX, ['exec'], { env: scenario.env }).done;
  assert.equal(generated.code, 0, generated.stderr);
  seedRun(h, 'finished-root', { model: 'alpha', started_at: new Date(Date.now() - 60000).toISOString() }, { status: 'done', duration_s: 2, usage: null });
  seedRun(h, 'running-resume', { parent: 'finished-root', mode: 'resume', status: 'running', pid: process.pid, ended_at: undefined, started_at: new Date().toISOString() });
  seedRun(h, 'running-root', { module: 'image', model: 'skipped', status: 'running', pid: process.pid, ended_at: undefined });
  seedRun(h, 'finished-resume', { parent: 'running-root', mode: 'resume', model: 'skipped' }, { status: 'done', duration_s: 3 });
  const r = output(await h.bridge(['stats']));
  assert.deepEqual(r.rows[0].tokens, { input: null, cached_input: null, output: null, runs: 0, missing_runs: 1 });
  assert.deepEqual(r.rows[0].duration_s, { total: 2, median_per_seat: null, missing_runs: 0 });
  assert.deepEqual(r.totals, { runs: 1, seats: 1, judged_runs: 0, running_skipped: 2, unreadable: 0, unreadable_verdicts: 0 });
  assert.deepEqual(r.rows.map((row) => row.model), ['alpha']);
});

test('stats 祖先不可读时跳过后代并计 unreadable，父目录不存在时才另算根', async (t) => {
  const h = sandbox(t), broken = seedRun(h, 'broken-root', { module: 'discuss' });
  write(path.join(broken, 'meta.json'), '{broken');
  seedRun(h, 'middle', { parent: 'broken-root', mode: 'resume' });
  seedRun(h, 'leaf', { parent: 'middle', mode: 'resume' });
  fs.mkdirSync(path.join(h.runs, 'missing-meta'));
  seedRun(h, 'missing-meta-child', { parent: 'missing-meta', mode: 'resume' });
  seedRun(h, 'orphan', { module: 'image', model: 'orphan', parent: 'removed-parent', mode: 'resume' });
  const r = output(await h.bridge(['stats']));
  assert.deepEqual(r.totals, { runs: 1, seats: 1, judged_runs: 0, running_skipped: 0, unreadable: 4, unreadable_verdicts: 0 });
  assert.deepEqual(r.rows.map((row) => [row.model, row.module]), [['orphan', 'image']]);
});

test('stats no_issues 空报告自动计入去留和 unique 基数，incomplete 或坏 verdict 不替代', async (t) => {
  const h = sandbox(t), a = seedRun(h, 'a', { ...review, plan: 'p', model: 'alpha' }, report('F1'));
  verdict(a, { F1: { verdict: 'accept' } });
  for (const [id, model, status] of [['b', 'beta', 'no_issues'], ['c', 'gamma', 'incomplete'], ['d', 'delta', 'no_issues']]) {
    const dir = seedRun(h, id, { ...review, plan: 'p', model }, { report: { verdict: status, findings: [] } });
    if (id === 'd') write(path.join(dir, 'verdict.json'), '{broken');
  }
  const r = output(await h.bridge(['stats'])), rows = Object.fromEntries(r.rows.map((row) => [row.model, row]));
  assert.equal(r.totals.judged_runs, 2);
  assert.equal(r.totals.unreadable_verdicts, 1);
  assert.deepEqual([rows.alpha.unique, rows.alpha.unique_basis_runs, rows.beta.unique, rows.beta.unique_basis_runs], [1, 1, 0, 1]);
  assert.deepEqual([rows.beta.judged_runs, rows.beta.judged, rows.gamma.judged_runs, rows.delta.judged_runs], [1, 0, 0, 0]);
  assert.deepEqual([rows.gamma.unique, rows.delta.unique], [null, null]);
});

test('judge 拒绝解析后为空的去留和 same，不写 verdict 或锁', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, report('F1'));
  for (const args of [['--accept', ''], ['--reject', ','], ['--same', ' , '], ['--clear', ' , '], ['--partial', ' ', '--same', ',']]) {
    failed(await h.bridge(['judge', '--run', 'review-a', ...args]), M.judgeNothing);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('verdict.json')), []);
  }
});

test('stats 同席多轮的同编号只计一条，same 指向续接时连接到同一根', async (t) => {
  const h = sandbox(t), discuss = { module: 'discuss', kind: 'discuss', mode: 'discuss', plan: 'p', model: 'alpha' };
  const a = seedRun(h, 'a', discuss), a2 = seedRun(h, 'a2', { ...discuss, mode: 'resume', parent: 'a' });
  const b = seedRun(h, 'b', { ...discuss, model: 'beta' });
  verdict(a, { P1: { verdict: 'accept' } });
  verdict(a2, { P1: { verdict: 'accept' } });
  verdict(b, { P2: { verdict: 'accept' } });
  const before = output(await h.bridge(['stats']));
  assert.deepEqual(before.rows.map((row) => [row.model, row.unique, row.unique_basis_runs]), [['alpha', 1, 2], ['beta', 1, 1]]);
  output(await h.bridge(['judge', '--run', 'b', '--same', 'P2=a2:P1']));
  assert.deepEqual(output(await h.bridge(['stats'])).rows.map((row) => row.unique), [0, 0]);
});

test('judge 两个进程并发合并同一任务的不同编号，均成功且不丢条目', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, report('F1', 'F2'));
  const file = path.join(dir, 'verdict.json'), ready = path.join(h.cwd, 'ready'), release = path.join(h.cwd, 'release'), attempted = path.join(h.cwd, 'attempted');
  // 第一进程读旧值时暂停，等第二进程尝试拿锁；旧实现无锁时等它写完，稳定复现丢条目。
  const preload = h.write('judge-gate.mjs', `
import fs from 'node:fs';
const read = fs.readFileSync, write = fs.writeFileSync;
const file = ${JSON.stringify(file)}, ready = ${JSON.stringify(ready)}, release = ${JSON.stringify(release)}, attempted = ${JSON.stringify(attempted)};
fs.readFileSync = function (name, ...args) {
  if (String(name) !== file || process.env.JUDGE_ROLE !== 'first') return read.call(this, name, ...args);
  try { return read.call(this, name, ...args); }
  finally {
    write(ready, '');
    while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
};
fs.writeFileSync = function (name, ...args) {
  if (String(name) === file + '.lock' && process.env.JUDGE_ROLE === 'second') write(attempted, '');
  return write.call(this, name, ...args);
};
`);
  const env = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const first = h.startBridge(['judge', '--run', 'review-a', '--accept', 'F1'], { env: { ...env, JUDGE_ROLE: 'first' } });
  await poll(() => fs.existsSync(ready), '第一进程读去留');
  const second = h.startBridge(['judge', '--run', 'review-a', '--partial', 'F2'], { env: { ...env, JUDGE_ROLE: 'second' } });
  await poll(() => fs.existsSync(attempted) || second.child.exitCode !== null, '第二进程抢锁或写完');
  write(release, '');
  for (const r of await Promise.all([first.done, second.done])) output(r);
  const saved = json(file);
  assert.deepEqual([saved.items.F1?.verdict, saved.items.F2?.verdict], ['accept', 'partial']);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('verdict.json.')), []);
});

test('judge 回收超过 30 秒的死进程锁，写完清理锁和临时文件', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, report('F1'));
  const lock = path.join(dir, 'verdict.json.lock'), old = new Date(Date.now() - 31000);
  write(lock, { pid: 2147483647, at: old.toISOString() });
  fs.utimesSync(lock, old, old);
  assert.equal(output(await h.bridge(['judge', '--run', 'review-a', '--accept', 'F1'])).items.F1.verdict, 'accept');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('verdict.json.')), []);
});

test('judge 新锁等待 5 秒报 judgeBusy，保留别人的锁且不写去留', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'review-a', review, report('F1'));
  const file = path.join(dir, 'verdict.json'), owner = { pid: process.pid, at: new Date().toISOString() };
  write(`${file}.lock`, owner);
  failed(await h.bridge(['judge', '--run', 'review-a', '--accept', 'F1']), M.judgeBusy(file));
  assert.deepEqual(json(`${file}.lock`), owner);
  assert.equal(fs.existsSync(file), false);
});
