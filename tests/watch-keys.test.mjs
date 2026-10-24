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
const clock = (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return (ms) => t.mock.timers.tick(ms);
};

test('CSI 私有参数和中间字节不拆成 Esc、数字或其他快捷键', () => {
  for (const key of ['\x1b[<0;10;5M', '\x1b[?25h', '\x1b[>1;2c', '\x1b[=1~', '\x1b[1 q', '\x1bOA']) {
    assert.deepEqual(splitKeys(`${key}12`), [key, '1', '2']);
  }
});

test('三个可打印字符算整块粘贴，控制序列不计数，12 和原有单键保留', (t) => {
  const tick = clock(t);
  const { batches, send } = collect(t);
  for (const text of ['abq', '1 2', '123', 'q\x03xx', ' !?', '中文q']) send(text);
  assert.deepEqual(batches, []);
  tick(30);
  send('\x1b[<0;10;5M12');
  assert.deepEqual(batches.shift(), ['\x1b[<0;10;5M', '1', '2']);
  const keys = ['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB', '\x1b[5~', '\x1b[6~', '\x1b[H', 'j', 'k', 'b', 'g', ' ', '\b', '\x7f', 'n', 'q', '\x03'];
  keys.forEach(send);
  assert.deepEqual(batches.flat(), keys);
});

test('bracketed paste 的起止标记在任意位置拆块，内容仍全部忽略', (t) => {
  const tick = clock(t);
  const start = '\x1b[200~', end = '\x1b[201~';
  for (let cut = 1; cut < start.length; cut++) {
    const { batches, send } = collect(t);
    send(start.slice(0, cut));
    tick(80);
    send(start.slice(cut) + 'q');
    send('\x03');
    send('12xx');
    send(end.slice(0, cut));
    tick(80);
    assert.deepEqual(batches, []);
    send(end.slice(cut));
    assert.deepEqual(batches, []);
    send('q');
    assert.deepEqual(batches, [['q']]);
  }
});

test('转义序列跨块拼接，150 ms 未补齐才发出一个 Esc，停止读键会清掉等待', (t) => {
  const tick = clock(t);
  const { batches, send, stop } = collect(t);
  send('\x1b[<0;1');
  tick(80);
  send('0;5M');
  assert.deepEqual(batches, [['\x1b[<0;10;5M']]);
  send('\x1b[');
  tick(149);
  assert.equal(batches.length, 1);
  tick(1);
  assert.deepEqual(batches.pop(), ['\x1b']);
  send('\x1b');
  tick(150);
  assert.deepEqual(batches.pop(), ['\x1b']);
  send('\x1b');
  stop();
  tick(150);
  assert.equal(batches.length, 1);
  send('\x1b[200~q\x1b[201');
  tick(80);
  send('~');
  send('q');
  assert.deepEqual(batches.at(-1), ['q']);
});

test('同块 xx 或 xX 只算一次，后续块的 x 才能再次触发', (t) => {
  const { batches, send } = collect(t);
  ['xx', 'X', 'xX', 'x', 'x'].forEach(send);
  assert.deepEqual(batches, [['x'], ['X'], ['x'], ['x'], ['x']]);
});

test('无标记粘贴在 30 ms 内的短尾块整块忽略，窗口随连续拆块延长', (t) => {
  const tick = clock(t);
  for (const text of ['abc', 'a'.repeat(1024)]) {
    const { batches, send, stop } = collect(t);
    send(text);
    tick(29);
    send('q');
    tick(29);
    send('x\x03');
    assert.deepEqual(batches, []);
    tick(30);
    send('q');
    assert.deepEqual(batches, [['q']]);
    stop();
  }
});

test('Esc 已发出后，下一块开头的粘贴标记仍整体识别', (t) => {
  const tick = clock(t);
  for (const marker of ['[200~', '[201~']) {
    const { batches, send, stop } = collect(t);
    send('\x1b');
    tick(160);
    send(marker + 'q');
    assert.deepEqual(batches, [['\x1b']]);
    stop();
  }
});

test('UTF-8 多字节字符拆块后按完整字符解码，不产生 U+FFFD', (t) => {
  const { batches, send } = collect(t);
  const bytes = Buffer.from('中');
  send(bytes.subarray(0, 1));
  assert.deepEqual(batches, []);
  send(bytes.subarray(1));
  assert.deepEqual(batches, [['中']]);
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
  await pause(80);
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
  // 结束标记一直不来：等待阶段和面板共用同一个读键状态，3 秒没有输入后粘贴算结束，q 照常退出
  seedRun(h, '20000101-000001-waiting', { ...live, group, model: 'waiting-model' });
  await frameWhere(watch, (frame) => frame.some((line) => line.includes('waiting-model')));
  await pause(3100);
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

test('粘贴中停 1.1 秒仍忽略内容，结束标记一直不来时空闲 3 秒才恢复读键', (t) => {
  const tick = clock(t);
  const { batches, send } = collect(t);
  send('\x1b[200~abc');
  tick(1100);
  send('q');
  assert.deepEqual(batches, []);
  tick(2999);
  assert.deepEqual(batches, []);
  tick(1);
  send('q');
  assert.deepEqual(batches, [['q']]);
});

for (const kind of ['run', 'group', 'waiting']) test(`${kind} 的括号粘贴模式在退出、异常和信号时恢复，重定向时不写`, async (t) => {
  const h = sandbox(t), id = '20000101-000001-tty';
  seedRun(h, id, { ...live, group: 'tty' });
  const scripts = new URL('../foreman/skills/dispatch/scripts/', import.meta.url);
  const options = { [kind === 'run' ? 'run' : 'group']: kind === 'run' ? id : kind === 'group' ? 'tty' : 'tty-waiting', 'no-intro': true };
  // 用临时 HOME 和模拟 TTY 覆盖退出钩子，Windows 上直接发信号会强杀子进程，无法验证恢复逻辑。
  const file = h.write('watch-tty.mjs', `
    import { initializeRecords } from ${JSON.stringify(new URL('records.mjs', scripts).href)};
    import { cmdWatch } from ${JSON.stringify(new URL('watch.mjs', scripts).href)};
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    process.stdin.setRawMode = () => {};
    Object.defineProperty(process.stdout, 'isTTY', { value: process.env.TEST_OUTPUT_TTY === '1' });
    process.stdin.on('data', (data) => {
      if (data.toString() === '!') throw new Error('synthetic watch failure');
      if (data.toString() === 'I') process.emit('SIGINT');
      if (data.toString() === 'T') process.emit('SIGTERM');
    });
    initializeRecords({ dispatch: { runs_dir: ${JSON.stringify(h.runs)} } });
    await cmdWatch(${JSON.stringify(options)}, () => ({ dispatch: { intro: false } }));
  `);
  for (const [key, code, tty] of [['q', 0, '1'], ['\x03', 130, '1'], ['!', 1, '1'], ['I', 130, '1'], ['T', 143, '1'], ['q', 0, '0']]) {
    const watch = h.start(file, [], { keepStdin: true, env: { FOREMAN_TEST_SCREEN: size, TEST_OUTPUT_TTY: tty } });
    await poll(() => watch.stdout.includes(kind === 'waiting' ? D.watchWaiting : '\x1b[1;1H'), '模拟终端开始交互');
    watch.child.stdin.write(key);
    const r = await watch.done;
    assert.equal(r.code, code, `${kind} ${JSON.stringify(key)}: ${r.stderr}`);
    if (tty === '1') {
      const start = r.stdout.indexOf('\x1b[?2004h'), end = r.stdout.lastIndexOf('\x1b[?2004l');
      assert.ok(start >= 0 && end > start, JSON.stringify(r.stdout));
    } else assert.doesNotMatch(r.stdout, /\x1b\[\?2004[hl]/);
  }
});
