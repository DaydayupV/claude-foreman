import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, taskArgs, output, poll, seedRun, expected, json, read, MESSAGES } from './helpers.mjs';
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
    if (['done', 'failed', 'cancelled'].includes(status)) assert.deepEqual(r, { run_id: status, ok: false, status });
    else {
      assert.deepEqual(r, { run_id: status, ok: true, status, dismissed: true });
      assert.ok(Number.isFinite(Date.parse(json(path.join(dir, 'meta.json')).dismissed_at)));
    }
    assert.equal(read(path.join(dir, 'result.json')), original);
    assert.equal(fs.existsSync(path.join(dir, 'cancel')), false);
  }
});

test('组汇总里交回问题后已续接的任务记作已续接，结果看续接的那一轮', async (t) => {
  const h = sandbox(t);
  seedRun(h, '20000101-ask', { group: 'resumed-group' }, { status: 'done', needs_decision: true, report: { status: 'blocked' } });
  seedRun(h, '20000101-answer', { group: 'resumed-group', parent: '20000101-ask' }, { status: 'done', report: { status: 'completed' } });
  const r = await h.bridge(['status', '--group', 'resumed-group']);
  assert.ok(r.stdout.endsWith(`${D.groupSummary(2, 0, 1, 0, 0, 1)}\n`));
});
