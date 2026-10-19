import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, taskArgs, output, failed, json, read, write, poll, baseConfig, seedRun, MESSAGES } from './helpers.mjs';
import { report, usage, sessionStats, command } from './fixtures/reports.mjs';
const M = MESSAGES.zh;

test('执行成功写报告、补丁、事件归属和会话用量', async (t) => {
  const h = sandbox(t);
  h.initGit();
  const beforeGit = h.git(['rev-parse', 'HEAD']);
  const changed = { ...report, files_changed: [{ path: 'reported.txt', change: '合成新增' }] };
  const s = h.scenario({ last_message: changed, stats: sessionStats, usage: { input_tokens: 999 }, steps: [
    { files: { 'source.txt': 'after\n', 'reported.txt': 'reported\n' }, event: { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'source.txt', kind: 'update' }] } } },
    { event: command() },
  ] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env, input: '请修改合成文件' }));
  assert.equal(r.status, 'done');
  assert.deepEqual(r.report, changed);
  assert.deepEqual(r.usage, usage);
  assert.equal(r.usage_scope, 'this_run');
  assert.deepEqual(r.last_request, { tokens: 60, window: 1000 });
  assert.deepEqual(r.rate_limit, sessionStats.rate_limits.primary);
  assert.equal(r.commands_executed, 1);
  assert.equal(r.changes.available, true);
  assert.equal(r.changes.agent_total, 1);
  assert.equal(r.changes.reported_total, 1);
  assert.equal(r.changes.unknown_total, 0);
  assert.deepEqual(r.changes.files.map(({ path, status, by }) => ({ path, status, by })), [
    { path: 'reported.txt', status: 'A', by: 'reported' }, { path: 'source.txt', status: 'M', by: 'agent' },
  ]);
  assert.match(read(path.join(r.run_dir, 'diff.patch')), /-before\n\+after/);
  assert.deepEqual(json(path.join(r.run_dir, 'result.json')), r);
  const meta = json(path.join(r.run_dir, 'meta.json'));
  assert.equal(meta.status, 'done');
  assert.equal(meta.claude_session, 'test-session');
  assert.equal(meta.session_id, 'synthetic-session');
  assert.ok(h.events(r.run_id).every((e) => Number.isFinite(Date.parse(e.ts))));
  assert.equal(h.git(['rev-parse', 'HEAD']), beforeGit);
  assert.equal(h.git(['diff', '--cached', '--name-only']), '');
  assert.equal(fs.existsSync(path.join(r.run_dir, '.shadow')), false);
  const call = s.calls()[0];
  assert.match(call.stdin, /^请修改合成文件/);
  assert.equal(call.args[call.args.indexOf('-C') + 1], h.cwd);
  assert.deepEqual(call.env, { OPENCODE_CONFIG_CONTENT: null, PWD: null, HOME: h.home, USERPROFILE: h.home, CODEX_HOME: path.join(h.home, '.codex'), APPDATA: h.home });
});

test('没有事件或报告证据的文件变化归属未知', async (t) => {
  const h = sandbox(t), s = h.scenario({ files: { 'unknown.txt': 'synthetic\n' } });
  const r = output(await h.bridge(taskArgs(h), { env: s.env }));
  assert.equal(r.changes.agent_total, 0);
  assert.equal(r.changes.unknown_total, 1);
  assert.deepEqual(r.changes.files, [{ status: 'A', path: 'unknown.txt', by: 'unknown' }]);
  assert.ok(r.notes.includes(M.unattributedChanges(1)));
});

test('非零退出把 stderr 最后五行带入 errors', async (t) => {
  const h = sandbox(t), s = h.scenario({ exit_code: 7, stderr: 'line0\nline1\nline2\nline3\nline4\nline5\n' });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env }), 1);
  assert.equal(r.status, 'failed');
  assert.equal(r.exit_code, 7);
  assert.deepEqual(r.errors, [M.exitCode(7, 'line1\nline2\nline3\nline4\nline5')]);
  assert.equal(read(path.join(r.run_dir, 'stderr.log')), 'line0\nline1\nline2\nline3\nline4\nline5\n');
});

test('小数分钟超时终止未结束的执行', async (t) => {
  const h = sandbox(t), s = h.scenario({ hold: true });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot', '--timeout', '0.02']), { env: s.env }), 1);
  assert.equal(r.status, 'timeout');
  assert.equal(json(path.join(r.run_dir, 'meta.json')).status, 'timeout');
});

test('卡死检测终止无活动任务，执行中的命令不判卡死', { timeout: 65000 }, async (t) => {
  const busy = sandbox(t), stalled = sandbox(t);
  const gate = path.join(busy.home, 'release');
  const bs = busy.scenario({ steps: [{ event: command('item.started') }, { wait_for: gate }, { event: command() }] });
  const running = busy.startBridge(taskArgs(busy, 'run', ['--no-snapshot', '--stall', '0.001']), { env: bs.env, timeout: 55000 });
  const meta = await busy.running();
  await poll(() => busy.events(meta.id).some((e) => e.type === 'item.started'), '命令已开始');
  const ss = stalled.scenario({ hold: true });
  // 检测周期写死为 30 秒；等另一任务实际被判卡死后再放行长命令。
  const r = output(await stalled.bridge(taskArgs(stalled, 'run', ['--no-snapshot', '--stall', '0.001']), { env: ss.env, timeout: 50000 }), 1);
  assert.equal(r.status, 'stalled');
  assert.ok(r.errors.includes(M.stalled(0.001)));
  assert.equal(output(await busy.bridge(['status', '--run', meta.id])).status, 'running');
  write(gate, 'release');
  const result = output(await running.done);
  assert.equal(result.status, 'done');
  assert.equal(result.commands_executed, 1);
});

test('cancel 终止正在执行的任务并保存取消结果', async (t) => {
  const h = sandbox(t), s = h.scenario({ hold: true });
  const running = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env });
  const meta = await h.running();
  await poll(() => s.calls().length, '假 codex 启动');
  const cancelled = output(await h.bridge(['cancel', '--run', meta.id]));
  assert.deepEqual(cancelled, { run_id: meta.id, ok: true, status: 'cancelled' });
  const result = output(await running.done, 1);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.errors, [M.runCancelled('fake-codex', 'command')]);
  assert.ok(fs.existsSync(path.join(result.run_dir, 'cancel')));
});

test('额度用完保留会话、恢复时间和额度提示', async (t) => {
  const h = sandbox(t), s = h.scenario({ exit_code: 1, stderr: 'usage limit reached\n', stats: sessionStats });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env }), 1);
  assert.equal(r.status, 'quota_exhausted');
  assert.equal(r.session_id, 'synthetic-session');
  assert.equal(r.quota_resets_at, new Date(2000000000 * 1000).toISOString());
  assert.ok(r.errors.includes(M.quotaExhausted('2033-05-18 03:33')));
});

test('断线重连事件只记警告不导致任务失败', async (t) => {
  const h = sandbox(t), message = 'Reconnecting... 1/5 synthetic disconnect';
  const s = h.scenario({ steps: [{ event: { type: 'error', message } }] });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env }));
  assert.equal(r.status, 'done');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [message]);
});

test('组名非法、缺少写入范围和范围重叠均被拒绝', async (t) => {
  const h = sandbox(t);
  failed(await h.bridge(taskArgs(h, 'run', ['--group', '中文组', '--scope', 'src'])), M.badGroupName('中文组'));
  failed(await h.bridge(taskArgs(h, 'run', ['--group', 'group-a'])), M.groupNeedsScope);
  seedRun(h, '20000101-existing', { status: 'running', pid: process.pid, group: 'group-a', scope: ['src'] });
  failed(await h.bridge(taskArgs(h, 'run', ['--group', 'group-a', '--scope', 'src/child'])), M.scopeOverlap('group-a', '20000101-existing', ['src/child']));
  assert.equal(h.calls().length, 0);
  assert.equal(h.records().length, 1);
});

test('达到协作方并发上限时拒绝新任务', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.codex.max_parallel = 1;
  h.config(c);
  seedRun(h, '20000101-active', { status: 'running', pid: process.pid, group: 'other-group', claude_session: 'other-session' });
  failed(await h.bridge(taskArgs(h)), M.agentFull('codex', 1, 1, '20000101-active'));
  assert.equal(h.calls().length, 0);
  assert.equal(h.records().length, 1);
});

test('会话图片收集到 generated_images 和事件文件', async (t) => {
  const h = sandbox(t), s = h.scenario({ images: ['synthetic.png'] });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env }));
  const image = path.join(h.env.CODEX_HOME, 'generated_images/synthetic-session/synthetic.png');
  assert.deepEqual(r.generated_images, [image]);
  assert.equal(fs.readFileSync(image).subarray(1, 4).toString(), 'PNG');
  assert.ok(h.events(r.run_id).some((e) => e.type === 'image.generated' && e.path === image));
});

test('交回问题的执行任务提示 Claude 决定，watch 用问号列出问题和推荐', async (t) => {
  const h = sandbox(t);
  const ask = { question: '合成问题', why_it_matters: '影响后续', options: ['选项甲', '选项乙'], recommendation: '选项甲，已按它做了' };
  const s = h.scenario({ last_message: { ...report, status: 'blocked', decision_requests: [ask] } });
  const r = output(await h.bridge(taskArgs(h), { env: s.env }));
  assert.equal(r.status, 'done');
  assert.ok(r.notes.includes(M.needsDecisionNote(1)));
  const w = await h.bridge(['watch', '--run', r.run_id]);
  assert.equal(w.code, 0, w.stderr);
  assert.ok(w.stdout.includes(`? ${M.watchFinished(M.statusName('blocked'), M.duration(r.duration_s), null).split(' · ')[0]}`));
  for (const text of [M.watchDecisions, '· 合成问题', '- 选项甲', '- 选项乙', M.watchRecommendation('选项甲，已按它做了')]) assert.ok(w.stdout.includes(text), text);
});

test('来源不明的改动落在同组其他任务的范围里时，标出是哪个任务', async (t) => {
  const h = sandbox(t), s = h.scenario({ files: { 'other/x.txt': 'sibling\n', 'loose.txt': 'synthetic\n' } });
  seedRun(h, '20000101-sibling', { group: 'owner-group', scope: ['other'] }, { status: 'done' });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--group', 'owner-group', '--scope', 'mine']), { env: s.env }));
  assert.equal(r.changes.files.find((f) => f.path === 'other/x.txt').group_run, '20000101-sibling');
  assert.equal(r.changes.files.find((f) => f.path === 'loose.txt').group_run, undefined);
  assert.ok(r.notes.includes(M.groupScopeChanges(1, '20000101-sibling')));
  assert.ok(r.notes.includes(M.unattributedChanges(1)));
});

test('Codex 的命令因为沙箱起不来时，notes 里说明这不是任务本身的问题', async (t) => {
  const h = sandbox(t);
  const error = 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors';
  const s = h.scenario({ steps: [{ event: { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'node --version', exit_code: -1, aggregated_output: error } } }] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env }));
  assert.ok(r.notes.includes(M.codexSandboxFailed(error)));
  const ok = h.scenario({ steps: [{ event: { type: 'item.completed', item: { id: 'cmd-2', type: 'command_execution', command: 'grep sandbox', exit_code: 0, aggregated_output: 'sandbox failed in docs' } } }] });
  const r2 = output(await h.bridge(taskArgs(h), { env: ok.env }));
  assert.ok(!r2.notes.some((n) => n.startsWith(M.codexSandboxFailed('').slice(0, 10))));
});
