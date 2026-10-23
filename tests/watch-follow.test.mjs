import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, seedRun, poll, MESSAGES } from './helpers.mjs';
import { report } from './fixtures/reports.mjs';
import { textWidth } from '../foreman/skills/dispatch/scripts/util.mjs';
const D = MESSAGES.en; // 实时查看的显示文字中英两个插件一样
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// 单任务视图跟着续接走：被续接过的一轮在底部上面多一行提示，按 n 换成续接链上最新的一轮
const A = '20000101-000001-aaaa', B = '20000101-000002-bbbb', C = '20000101-000003-cccc';
const said = (text) => ({ type: 'item.completed', ts: new Date().toISOString(), item: { type: 'agent_message', text } });
const done = (h, id, parent, text) => seedRun(h, id, { title: `合成任务 ${id.slice(-4)}`, mode: parent ? 'resume' : 'run', parent },
  { status: 'done', duration_s: 3, report }, [said(text)]);
const running = (h, id, parent, text) => seedRun(h, id, { title: `合成任务 ${id.slice(-4)}`, mode: 'resume', parent, status: 'running', pid: process.pid, ended_at: undefined }, null, [said(text)]);

// 打开实时画面，输入一直开着、当成按键（FOREMAN_TEST_KEYS），结束后也停在画面里等 q
const open = (h, id, size) => h.startBridge(['watch', '--run', id, '--no-intro'], { keepStdin: true, env: { FOREMAN_TEST_SCREEN: size, FOREMAN_TEST_KEYS: '1' } });
// 每帧以 \x1b[1;1H 开头、逐行写成 "\x1b[<行>;1H\x1b[2K<内容>"：等到最新一帧画全了（行数等于窗口高）而且满足条件
const frameWhere = (watch, size, check, description) => {
  const [W, H] = size.split('x').map(Number);
  return poll(() => {
    const parts = watch.stdout.split('\x1b[1;1H');
    if (parts.length < 2) return null;
    const frame = `\x1b[1;1H${parts.at(-1)}`.split(/\x1b\[\d+;1H\x1b\[2K/).slice(1).map((l) => plain(l.replace(/\x1b\[\d+;1H\x1b\[J$/, '')));
    if (frame.length !== H || !check(frame)) return null;
    for (const line of frame) assert.ok(textWidth(line) < W, line);
    return frame;
  }, description);
};
const has = (text) => (frame) => frame.some((l) => l.includes(text));

test('看着的一轮被续接时底部上面多一行提示，按 n 换成新的一轮，从它的第一个事件排起', async (t) => {
  const h = sandbox(t);
  done(h, A, null, '第一轮做完了');
  const watch = open(h, A, '100x30');
  const before = await frameWhere(watch, '100x30', has(D.watchFinishedNote), '结束了的画面');
  assert.ok(!has('continued')(before), before.join('\n'));
  running(h, B, A, '返工的第一句话');
  const line = await frameWhere(watch, '100x30', has(D.watchContinued(B)), '续接的提示');
  // 提示在底部那行上面，底部照旧写结束和按键
  assert.ok(line.at(-2).includes(D.watchContinued(B)) && line.at(-1).includes(D.watchFinishedNote), line.join('\n'));
  watch.child.stdin.write('n');
  const after = await frameWhere(watch, '100x30', has('返工的第一句话'), '换成续接的一轮');
  assert.ok(has('合成任务 bbbb')(after) && !has('第一轮做完了')(after) && !has('continued')(after), after.join('\n'));
  assert.ok(after[0].includes('running'), after.join('\n'));
  watch.stop();
  await watch.done;
});

test('打开时已经续接了两轮：直接写提示，指向最新的一轮，按 n 跳过中间那轮', async (t) => {
  const h = sandbox(t);
  done(h, A, null, '第一轮做完了');
  done(h, B, A, '第二轮做完了');
  done(h, C, B, '第三轮做完了');
  const watch = open(h, A, '100x30');
  const first = await frameWhere(watch, '100x30', has(D.watchFinishedNote), '结束了的画面');
  assert.ok(first.at(-2).includes(D.watchContinued(C)) && !has(B)(first), first.join('\n'));
  watch.child.stdin.write('n');
  const after = await frameWhere(watch, '100x30', has('第三轮做完了'), '换成最新的一轮');
  // 已经是最新的一轮：没有提示，再按 n 不换
  assert.ok(has('合成任务 cccc')(after) && !has('continued')(after), after.join('\n'));
  watch.child.stdin.write('nq');
  const r = await watch.done;
  assert.equal(r.code, 0, r.stderr);
  // 离开画面后留在标签页里的是最新那一轮的记录
  const record = plain(r.stdout.slice(r.stdout.lastIndexOf('\x1b[?1049l')));
  assert.ok(record.includes('第三轮做完了') && !record.includes('第一轮做完了') && !record.includes('continued'), record);
  // 打开中间那一轮也指向最新的
  const middle = open(h, B, '100x30');
  await frameWhere(middle, '100x30', has(D.watchContinued(C)), '中间那一轮的提示');
  middle.stop();
  await middle.done;
});

test('窄窗口先去掉 run_id，再换更短的说法；按 q 离开时记录最后写续接成了哪一轮；直接输出也写', async (t) => {
  const h = sandbox(t);
  done(h, A, null, '第一轮做完了');
  done(h, B, A, '第二轮做完了');
  for (const [size, text] of [['64x20', D.watchContinued(B)], ['40x20', D.watchContinuedShort], ['22x20', D.watchContinuedTiny]]) {
    const watch = open(h, A, size);
    const frame = await frameWhere(watch, size, has(D.watchFinishedNote.slice(0, 5)), `${size} 的画面`);
    assert.equal(frame.at(-2).trim(), text, frame.join('\n'));
    if (size !== '40x20') { watch.stop(); await watch.done; continue; }
    watch.child.stdin.write('q');
    const r = await watch.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(plain(r.stdout).trimEnd().split('\n').at(-1), D.watchContinuedOut(B), r.stdout);
  }
  const direct = await h.bridge(['watch', '--run', A]);
  assert.equal(direct.code, 0, direct.stderr);
  assert.equal(direct.stdout.trimEnd().split('\n').at(-1), D.watchContinuedOut(B), direct.stdout);
  // 最新的一轮没有续接，不写
  const latest = await h.bridge(['watch', '--run', B]);
  assert.ok(!latest.stdout.includes('continued'), latest.stdout);
});
