import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox, taskArgs, output, failed, poll, seedRun, expected, json, read, ROOT, MESSAGES } from './helpers.mjs';
import { command } from './fixtures/reports.mjs';
import { watchRecords, watchText } from './fixtures/watch.mjs';
const M = MESSAGES.zh;
const D = MESSAGES.en; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套

test('status 列表按记录排序并汇总当前会话的组', async (t) => {
  const h = sandbox(t);
  seedRun(h, '20000101-a', { group: 'status-group' }, { status: 'done' });
  seedRun(h, '20000101-b', { group: 'status-group', status: 'failed' }, { status: 'failed' });
  seedRun(h, '20000101-c', { group: 'status-group', claude_session: 'other-session' }, { status: 'done' });
  const list = await h.bridge(['status', '--limit', '2']);
  assert.equal(list.code, 0);
  assert.ok(list.stdout.indexOf('20000101-c') < list.stdout.indexOf('20000101-b'));
  assert.ok(!list.stdout.includes('20000101-a'));
  const group = await h.bridge(['status', '--group', 'status-group']);
  assert.equal(group.code, 0);
  assert.ok(group.stdout.includes('20000101-a'));
  assert.ok(group.stdout.includes('20000101-b'));
  assert.ok(!group.stdout.includes('20000101-c'));
  assert.ok(group.stdout.endsWith(`${D.groupSummary(2, 0, 0, 2)}\n`));
  // 组汇总行和其他行一样用" · "分隔
  assert.ok(group.stdout.endsWith('2 runs: 0 running · 0 done · 2 failed\n'), group.stdout);
  assert.equal(D.groupSummary(5, 1, 1, 1, 1, 1), '5 runs: 1 running · 1 done · 1 resumed · 1 with questions · 1 failed');
  assert.deepEqual(output(await h.bridge(['status', '--run', '20000101-b'])), { status: 'failed' });
});

test('status 对正在运行的任务给出当前命令和活动时间', async (t) => {
  const h = sandbox(t), s = h.scenario({ hold: true, steps: [{ event: command('item.started') }] });
  const running = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env });
  const meta = await h.running();
  await poll(() => h.events(meta.id).some((e) => e.type === 'item.started'), '命令开始事件');
  const status = output(await h.bridge(['status', '--run', meta.id]));
  assert.equal(status.status, 'running');
  assert.equal(status.activity.step, D.stepCommand('node -e "0"'));
  assert.equal(typeof status.activity.idle_min, 'number');
  assert.ok(status.activity.idle_min >= 0);
  output(await h.bridge(['cancel', '--run', meta.id]));
  assert.equal(output(await running.done, 1).status, 'cancelled');
});

test('status 将复用进程号的旧 running 显示为 interrupted，当前 runner 仍为 running', async (t) => {
  const h = sandbox(t), sleeper = h.start('-e', ['setInterval(() => {}, 1000)']);
  await new Promise((resolve) => sleeper.child.once('spawn', resolve));
  const meta = { status: 'running', pid: sleeper.child.pid, ended_at: undefined };
  const dir = seedRun(h, 'reused-status', { ...meta, started_at: new Date(Date.now() - 3600000).toISOString() });
  seedRun(h, 'current-status', { ...meta, started_at: new Date().toISOString() });
  const file = path.join(dir, 'meta.json'), before = read(file);
  const list = await h.bridge(['status']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /reused-status\s+run\s+✗ interrupted/);
  assert.match(list.stdout, /current-status\s+run\s+\S+ running/);
  assert.equal(output(await h.bridge(['status', '--run', 'reused-status'])).status, 'interrupted');
  assert.equal(read(file), before);
  assert.doesNotThrow(() => process.kill(sleeper.child.pid, 0));
});

test('watch 单任务和组视图将复用进程号的旧 running 视为中断并退出', async (t) => {
  const h = sandbox(t), sleeper = h.start('-e', ['setInterval(() => {}, 1000)']);
  await new Promise((resolve) => sleeper.child.once('spawn', resolve));
  seedRun(h, 'reused-watch', { status: 'running', pid: sleeper.child.pid, group: 'reused-watch-group',
    started_at: new Date(Date.now() - 3600000).toISOString(), ended_at: undefined });
  for (const extra of [[], ['--verbose']]) {
    const r = await h.bridge(['watch', '--run', 'reused-watch', ...extra]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(D.watchInterrupted), r.stdout);
  }
  const group = await h.bridge(['watch', '--group', 'reused-watch-group']);
  assert.equal(group.code, 0, group.stderr);
  assert.ok(group.stdout.includes('interrupted'), group.stdout);
  assert.doesNotThrow(() => process.kill(sleeper.child.pid, 0));
});

for (const [id, label] of [['a', 'Codex 执行'], ['b', 'API 讨论'], ['c', 'opencode 讨论'], ['d', '失败任务']]) {
  test(`watch --run 非 TTY 的${label}输出与期望一致`, async (t) => {
    const h = sandbox(t);
    watchRecords(h);
    const r = await h.bridge(['watch', '--run', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    expected(`watch-${id}.txt`, watchText(h, r.stdout));
  });
}

test('watch --group 非 TTY 的四类任务汇总与期望一致', async (t) => {
  const h = sandbox(t);
  watchRecords(h);
  const r = await h.bridge(['watch', '--group', 'watch-group']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  expected('watch-group.txt', watchText(h, r.stdout));
});

test('cancel 对已完成任务不改结果，对未正常结束任务标记已处理', async (t) => {
  const h = sandbox(t);
  for (const status of ['done', 'failed', 'cancelled', 'timeout', 'stalled', 'quota_exhausted', 'interrupted']) {
    const dir = seedRun(h, status, { status }, { status });
    const original = read(path.join(dir, 'result.json'));
    const r = output(await h.bridge(['cancel', '--run', status]));
    if (['done', 'failed', 'cancelled'].includes(status)) assert.deepEqual(r, { run_id: status, ok: false, status, note: M.cancelAlreadyEnded });
    else {
      assert.deepEqual(r, { run_id: status, ok: true, status, dismissed: true });
      assert.ok(Number.isFinite(Date.parse(json(path.join(dir, 'meta.json')).dismissed_at)));
    }
    assert.equal(read(path.join(dir, 'result.json')), original);
    assert.equal(fs.existsSync(path.join(dir, 'cancel')), false);
  }
});

test('status 列出读不了的记录数，单任务退回结果并追加警告，两个文件都读不了仍报原错误', async (t) => {
  const h = sandbox(t), id = 'unreadable-status', written = { status: 'done', warnings: ['已有提示'] };
  const dir = seedRun(h, id, {}, written), file = path.join(dir, 'meta.json');
  const resultFile = path.join(dir, 'result.json'), originalResult = read(resultFile);
  let holder, closed, stdout = '', stderr = '';
  if (process.platform === 'win32') {
    const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $held = [IO.File]::Open('${file.replaceAll("'", "''")}','Open','Read','None'); try { [Console]::WriteLine('已占住'); [Console]::ReadLine() | Out-Null } finally { $held.Dispose() }`;
    holder = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { env: h.env, windowsHide: true });
    holder.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    holder.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    closed = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('close', resolve); });
  } else fs.writeFileSync(file, '{"id":');
  try {
    if (holder) await poll(() => stdout.includes('已占住'), 'PowerShell 独占 meta.json');
    const onlyUnreadable = await h.bridge(['status']);
    assert.equal(onlyUnreadable.code, 0); assert.equal(onlyUnreadable.stdout, D.statusUnreadable(1) + '\n');
    const fallback = output(await h.bridge(['status', '--run', id]));
    assert.deepEqual(fallback, { ...written, warnings: [...written.warnings, M.metaUnreadableUsedResult(file)] });
    assert.equal(read(resultFile), originalResult);
    seedRun(h, 'readable-status', {}, { status: 'done' });
    const mixed = await h.bridge(['status']);
    assert.equal(mixed.code, 0); assert.ok(mixed.stdout.includes('readable-status'));
    assert.ok(mixed.stdout.endsWith(D.statusUnreadable(1) + '\n'), mixed.stdout);
    fs.writeFileSync(resultFile, '{"status":');
    const bothUnreadable = await h.bridge(['status', '--run', id]);
    if (holder) failed(bothUnreadable, M.metaUnreadable(file));
    else { assert.equal(bothUnreadable.code, 1); assert.match(bothUnreadable.stderr, /SyntaxError/); }
  } finally {
    if (holder) { holder.stdin.end(); assert.equal(await closed, 0, stderr); }
  }
});

test('已处理的中断任务按其他文件最后活动时间算用时，排除元数据、残留临时文件、终止标记和目录', async (t) => {
  const h = sandbox(t), start = Date.now() - 14 * 60000;
  for (const empty of [false, true]) {
    const id = empty ? 'dismissed-empty' : 'dismissed-files';
    const dir = seedRun(h, id, { status: 'interrupted', started_at: new Date(start).toISOString(), ended_at: undefined, dismissed_at: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, 'meta.json.49320.tmp'), '{}'); fs.writeFileSync(path.join(dir, 'cancel'), '');
    fs.mkdirSync(path.join(dir, '.shadow'));
    if (empty) fs.rmSync(path.join(dir, 'events.jsonl'));
    else for (const file of ['brief.md', 'events.jsonl', 'stderr.log']) {
      fs.writeFileSync(path.join(dir, file), '最后活动');
      fs.utimesSync(path.join(dir, file), new Date(start + 1000), new Date(start + 1000));
    }
    const late = new Date(start + 13 * 60000);
    for (const file of ['meta.json', 'meta.json.49320.tmp', 'cancel', '.shadow']) fs.utimesSync(path.join(dir, file), late, late);
  }
  const list = await h.bridge(['status']); assert.equal(list.code, 0);
  for (const [id, sec] of [['dismissed-files', 1], ['dismissed-empty', 0]]) {
    const row = list.stdout.split('\n').find((line) => line.startsWith(id));
    assert.ok(row?.includes(D.took(D.duration(sec))), list.stdout);
  }
});

test('组汇总里交回问题后已续接的任务记作已续接，结果看续接的那一轮', async (t) => {
  const h = sandbox(t);
  seedRun(h, '20000101-ask', { group: 'resumed-group' }, { status: 'done', needs_decision: true, report: { status: 'blocked' } });
  seedRun(h, '20000101-answer', { group: 'resumed-group', parent: '20000101-ask' }, { status: 'done', report: { status: 'completed' } });
  const r = await h.bridge(['status', '--group', 'resumed-group']);
  assert.ok(r.stdout.endsWith(`${D.groupSummary(2, 0, 1, 0, 0, 1)}\n`));
  assert.match(r.stdout, /20000101-ask\s+run\s+↪ resumed/);
  assert.ok(!r.stdout.includes('questions returned'), r.stdout);
});

test('正常结束的 partial 单独计数并用不同标记，执行失败和交回问题仍算原来的类别', async (t) => {
  const h = sandbox(t), group = 'partial-group';
  seedRun(h, 'partial', { group }, { status: 'done', report: { status: 'partial' } });
  seedRun(h, 'completed', { group }, { status: 'done', report: { status: 'completed' } });
  seedRun(h, 'failed-partial', { group, status: 'failed' }, { status: 'failed', report: { status: 'partial' } });
  seedRun(h, 'blocked-partial', { group }, { status: 'done', needs_decision: true, report: { status: 'partial' } });
  const records = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/records.mjs')).href;
  const script = h.write('partial-tally.mjs', `import { initializeRecords, groupRuns, groupTally } from ${JSON.stringify(records)};
initializeRecords({ dispatch: { runs_dir: ${JSON.stringify(h.runs)} } });
console.log(JSON.stringify(groupTally(groupRuns(${JSON.stringify(group)}))));`);
  assert.deepEqual(output(await h.start(script).done), { running: 0, ok: 1, blocked: 1, failed: 1, resumed: 0, partial: 1 });
  const r = await h.bridge(['status', '--group', group]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^partial\s+run\s+◐ partly done/m);
  assert.match(r.stdout, /^failed-partial\s+run\s+✗ failed/m);
  assert.match(r.stdout, /^blocked-partial\s+run\s+\? questions returned/m);
  assert.ok(r.stdout.endsWith(`${D.groupSummary(4, 0, 1, 1, 1, 0, 0, 1)}\n`), r.stdout);
  assert.ok(r.stdout.includes('1 partly done'), r.stdout);
});

test('单任务查看的结尾行把部分完成标成 ◐，和组视图、status 一致', async (t) => {
  const h = sandbox(t);
  // 正常结束的部分完成和成功一样，不再把临时的重连提示当成报错列出
  seedRun(h, 'partial-run', {}, { status: 'done', report: { status: 'partial', summary: '只做完一半' }, errors: ['Reconnecting... 1/5 (stream disconnected)'] });
  const r = await h.bridge(['watch', '--run', 'partial-run', '--no-intro']);
  assert.equal(r.code, 0, r.stderr);
  const text = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /◐ partly done/);
  assert.doesNotMatch(text, /✗/);
});
