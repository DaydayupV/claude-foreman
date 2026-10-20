import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, taskArgs, output, failed, poll, seedRun, expected, json, read, MESSAGES } from './helpers.mjs';
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
  assert.ok(group.stdout.endsWith(`${D.groupSummary(2, 0, 1, 1)}\n`));
  // 组汇总行和其他行一样用" · "分隔
  assert.ok(group.stdout.endsWith('2 runs: 0 running · 1 done · 1 failed\n'), group.stdout);
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
});
