import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { sandbox, seedRun, poll, write, MESSAGES } from './helpers.mjs';
import { readKeys, splitKeys } from '../foreman/skills/dispatch/scripts/watch-screen.mjs';

import { D as displayText } from '../foreman/skills/dispatch/scripts/display.mjs';
const D = { ...MESSAGES.en, ...displayText };
const collect = (t) => {
  const batches = [], read = readKeys((keys) => batches.push(keys));
  t.after(read.stop);
  return { batches, send: (text) => read(Buffer.from(text)), stop: read.stop };
};

test('CSI 私有参数和中间字节不拆成 Esc、数字或其他快捷键', () => {
  for (const key of ['\x1b[<0;10;5M', '\x1b[?25h', '\x1b[>1;2c', '\x1b[=1~', '\x1b[1 q', '\x1bOA']) {
    assert.deepEqual(splitKeys(`${key}12`), [key, '1', '2']);
  }
});

test('三个可打印字符算整块粘贴，控制序列不计数，12 和原有单键保留', (t) => {
  const { batches, send } = collect(t);
  for (const text of ['abq', '1 2', '123', 'q\x03xx', ' !?', '中文q']) send(text);
  assert.deepEqual(batches, []);
  send('\x1b[<0;10;5M12');
  assert.deepEqual(batches.shift(), ['\x1b[<0;10;5M', '1', '2']);
  const keys = ['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB', '\x1b[5~', '\x1b[6~', '\x1b[H', 'j', 'k', 'b', 'g', ' ', '\b', '\x7f', 'n', 'q', '\x03'];
  keys.forEach(send);
  assert.deepEqual(batches.flat(), keys);
});

test('bracketed paste 的起止标记在任意位置拆块，内容仍全部忽略', (t) => {
  const start = '\x1b[200~', end = '\x1b[201~';
  for (let cut = 1; cut < start.length; cut++) {
    const { batches, send } = collect(t);
    send(start.slice(0, cut));
    send(start.slice(cut) + 'q');
    send('\x03');
    send('12xx');
    send(end.slice(0, cut));
    assert.deepEqual(batches, []);
    send(end.slice(cut));
    assert.deepEqual(batches, []);
    send('q');
    assert.deepEqual(batches, [['q']]);
  }
});

test('转义序列跨块拼接，50 ms 未补齐才发出一个 Esc，停止读键会清掉等待', async (t) => {
  const { batches, send, stop } = collect(t);
  send('\x1b[<0;1');
  await pause(10);
  send('0;5M');
  assert.deepEqual(batches, [['\x1b[<0;10;5M']]);
  send('\x1b[');
  await pause(75);
  assert.deepEqual(batches.pop(), ['\x1b']);
  send('\x1b');
  stop();
  await pause(75);
  assert.equal(batches.length, 1);
  send('\x1b[200~q\x1b[201');
  await pause(75);
  send('~');
  send('q');
  assert.deepEqual(batches.at(-1), ['q']);
});

test('同块 xx 或 xX 只算一次，后续块的 x 才能再次触发', (t) => {
  const { batches, send } = collect(t);
  ['xx', 'X', 'xX'].forEach(send);
  assert.deepEqual(batches, [['x'], ['X'], ['x']]);
});

const size = '120x40';
const live = { status: 'running', pid: process.pid, ended_at: undefined };
const open = (h, kind, id) => h.startBridge(['watch', `--${kind}`, id, '--no-intro'], {
  keepStdin: true, env: { FOREMAN_TEST_SCREEN: size, FOREMAN_TEST_KEYS: '1' },
});
const frameWhere = (watch, check = () => true) => poll(() => {
  const last = watch.stdout.split('\x1b[1;1H').at(-1);
  const frame = `\x1b[1;1H${last}`.split(/\x1b\[\d+;1H\x1b\[2K/).slice(1)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  return frame.length === 40 && check(frame) ? frame : null;
}, '按键后的完整画面');
const afterInput = async (watch, text) => {
  const offset = watch.stdout.length;
  watch.child.stdin.write(text);
  await poll(() => watch.stdout.slice(offset).includes('\x1b[1;1H') || watch.stdout.includes('\x1b[?1049l'), '输入后重画或退出');
  assert.ok(!watch.stdout.includes('\x1b[?1049l'), '输入不能退出查看');
  return frameWhere(watch);
};

test('组视图忽略粘贴，整块 12 打开第 12 席，鼠标序列不会返回或开席位', async (t) => {
  const h = sandbox(t), group = 'keys-group', plan = 'keys-plan';
  const seats = Array.from({ length: 12 }, (_, i) => i + 1);
  write(path.join(h.runs, 'plans', `${plan}.json`), { plan_id: plan, module: 'run', cell: 'complex', group, cwd: h.cwd,
    seats: seats.map((seat) => ({ seat, agent: 'codex' })), required: [] });
  seats.forEach((seat) => seedRun(h, `20000101-${String(seat).padStart(6, '0')}-keys`, { ...live, group, plan, seat, model: `model-${seat}` }));
  const watch = open(h, 'group', group);
  await frameWhere(watch, (frame) => frame.some((line) => line.includes('12 ● model-12')));
  for (const text of ['abq', '1 2', '123', '\x1b[200~q12xx\x03\x1b[201~', '\x1b[<0;10;5M']) {
    const frame = await afterInput(watch, text);
    assert.ok(frame.some((line) => line.includes('12 ● model-12')) && !frame.at(-1).includes(D.seatKeys), frame.join('\n'));
  }
  const isTwelfth = (frame) => frame[0].includes('model-12') && frame.at(-1).includes(D.seatKeys);
  assert.ok(isTwelfth(await afterInput(watch, '12')));
  assert.ok(isTwelfth(await afterInput(watch, '\x1b[<0;10;5M')));
  watch.child.stdin.write('\x1b[<0;1');
  await pause(10);
  assert.ok(isTwelfth(await afterInput(watch, '0;5M')));
  await afterInput(watch, '\x1b');
  await afterInput(watch, '1');
  watch.child.stdin.write('abq');
  await pause(30);
  assert.ok(isTwelfth(await afterInput(watch, '2')), '粘贴不能取消等第二位的席位号');
  watch.child.stdin.write('q');
  assert.equal((await watch.done).code, 0);
});

test('组视图等待期间忽略粘贴；粘贴一直没收到结束标记时，进入面板后照常读键', async (t) => {
  const h = sandbox(t), group = 'keys-waiting', watch = open(h, 'group', group);
  await poll(() => watch.stdout.includes(D.watchWaiting), '等待任务登记');
  watch.child.stdin.write('abq');
  await pause(80);
  watch.child.stdin.write('\x1b[20');
  await pause(10);
  watch.child.stdin.write('0~q');
  await pause(80);
  assert.equal(watch.child.exitCode, null);
  // 结束标记一直不来：等待阶段和面板共用同一个读键状态，1 秒没有输入后粘贴算结束，q 照常退出
  seedRun(h, '20000101-000001-waiting', { ...live, group, model: 'waiting-model' });
  await frameWhere(watch, (frame) => frame.some((line) => line.includes('waiting-model')));
  await pause(1100);
  watch.child.stdin.write('q');
  assert.equal((await watch.done).code, 0);
});

for (const kind of ['group', 'run']) test(`${kind} 排队时同块 xx 只确认，分块两次 x 才写入全部目标的终止标记`, async (t) => {
  const h = sandbox(t), group = `keys-queued-${kind}`, models = kind === 'group' ? ['queue-one', 'queue-two'] : ['queue-one'];
  const dirs = models.map((model, i) => seedRun(h, `20000101-00000${i + 1}-queued`, { ...live, group, model, agent_type: 'api' }, null,
    [{ type: 'api.request', ts: new Date().toISOString(), model, attempt: 1 }, { type: 'api.queued', ts: new Date().toISOString() }]));
  const watch = open(h, kind, kind === 'group' ? group : '20000101-000001-queued');
  await frameWhere(watch, (frame) => frame.some((line) => line.includes(D.apiPhases.queued)));
  for (const text of ['abq', '\x1b[200~qxx\x03\x1b[201~']) await afterInput(watch, text);
  const confirm = kind === 'group' ? D.dashCancelConfirm(D.list(models)) : D.watchCancelConfirm(models[0]);
  assert.ok((await afterInput(watch, 'xx')).at(-1).includes(confirm));
  const cancelled = () => dirs.map((dir) => fs.existsSync(path.join(dir, 'cancel')));
  assert.deepEqual(cancelled(), models.map(() => false));
  await afterInput(watch, 'j');
  assert.ok((await afterInput(watch, 'x')).at(-1).includes(confirm));
  assert.deepEqual(cancelled(), models.map(() => false));
  await afterInput(watch, 'x');
  assert.deepEqual(cancelled(), models.map(() => true));
  watch.child.stdin.write(kind === 'group' ? 'q' : '\x03');
  assert.equal((await watch.done).code, kind === 'group' ? 0 : 130);
});

test('只收到粘贴开始标记、结束标记一直不来时，1 秒后恢复读键', async (t) => {
  const { batches, send } = collect(t);
  send('\x1b[200~abc');
  send('q');
  assert.deepEqual(batches, []);
  await pause(1100);
  send('q');
  assert.deepEqual(batches, [['q']]);
});
