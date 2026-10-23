import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, seedRun, poll, write, json, MESSAGES } from './helpers.mjs';
import { report } from './fixtures/reports.mjs';
import { textWidth } from '../foreman/skills/dispatch/scripts/util.mjs';

const D = MESSAGES.en;
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const said = (text) => ({ type: 'item.completed', ts: new Date().toISOString(), item: { type: 'agent_message', text } });
const live = { status: 'running', pid: process.pid, ended_at: undefined };
const open = (h, group, size = '120x40', intro = false) => h.startBridge(['watch', '--group', group, ...(intro ? [] : ['--no-intro'])], {
  keepStdin: true, env: { FOREMAN_TEST_SCREEN: size, FOREMAN_TEST_KEYS: '1', ...(intro ? { NO_COLOR: '' } : {}) },
});
const frameWhere = (watch, size, check) => poll(() => {
  const parts = watch.stdout.split('\x1b[1;1H');
  const frame = `\x1b[1;1H${parts.at(-1)}`.split(/\x1b\[\d+;1H\x1b\[2K/).slice(1)
    .map((l) => plain(l.replace(/\x1b\[\d+;1H\x1b\[J$/, '')));
  const [width, height] = size.split('x').map(Number);
  if (frame.length !== height || !check(frame)) return null;
  for (const line of frame) assert.ok(textWidth(line) < width, line);
  return frame;
}, '组视图画出预期的一帧');
const has = (text) => (frame) => frame.some((line) => line.includes(text));
const planFor = (h, group, seats) => {
  const plan = `${group}-plan`;
  write(path.join(h.runs, 'plans', `${plan}.json`), { plan_id: plan, module: 'run', cell: 'complex', group, cwd: h.cwd,
    seats: seats.map((seat) => ({ seat, agent: 'codex' })), required: [] });
  return plan;
};

test('12 席按计划编号，1、0 打开第 10 席，单按 1 等 600 ms 后打开第 1 席', async (t) => {
  const h = sandbox(t), group = 'twelve', size = '120x70';
  const seats = [3, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 2], plan = planFor(h, group, seats);
  seedRun(h, '20000101-000000-host', { group, plan, participant: 'host', seat: 0, model: 'host-model', submitted_at: new Date().toISOString() }, { status: 'done', report });
  seats.forEach((seat, i) => seedRun(h, `20000101-${String(i + 1).padStart(6, '0')}-seat`, { ...live, group, plan, seat, model: `model-${seat}` }, null, [said(`第 ${seat} 席的正文`)]));
  const watch = open(h, group, size);
  const before = await frameWhere(watch, size, has('12 ● model-12'));
  assert.ok(before.some((line) => line.startsWith('0 ✔ host-model')), before.join('\n'));
  assert.ok(before.some((line) => line.startsWith('2 ● model-2')), before.join('\n'));
  assert.ok(before.at(-1).includes(D.dashKeys('0–12', false, true)), before.at(-1));
  const offset = watch.stdout.length;
  watch.child.stdin.write('1');
  await poll(() => watch.stdout.length > offset, '第一位数字后仍画组视图');
  assert.ok((await frameWhere(watch, size, has('12 ● model-12'))).at(-1).includes('600ms'));
  watch.child.stdin.write('0');
  const tenth = await frameWhere(watch, size, (frame) => frame[0].includes('model-10') && frame.at(-1).includes(D.seatKeys));
  assert.ok(has('第 10 席的正文')(tenth), tenth.join('\n'));
  assert.ok(!has('第 1 席的正文')(tenth), tenth.join('\n'));
  watch.child.stdin.write('\x1b');
  await frameWhere(watch, size, has('12 ● model-12'));
  watch.child.stdin.write('1');
  await frameWhere(watch, size, (frame) => frame[0].includes('model-1 ') && frame.at(-1).includes(D.seatKeys));
  watch.stop();
  await watch.done;
});

test('计划第 2 席续接后仍是 2，缺号时提示只列实际席位，个位数直接打开最新一轮', async (t) => {
  const h = sandbox(t), group = 'planned', plan = planFor(h, group, [2, 7]), size = '120x40';
  const root = '20000101-000002-root', next = '20000101-000003-next';
  seedRun(h, '20000101-000001-peer', { ...live, group, plan, seat: 7, model: 'peer' });
  seedRun(h, root, { group, plan, seat: 2, model: 'seat-two' }, { status: 'done', report: { ...report, summary: '第 2 席第一轮' } });
  const watch = open(h, group, size);
  const before = await frameWhere(watch, size, has('2 ✔ seat-two'));
  assert.ok(before.at(-1).includes(D.dashKeys('2,7', false)), before.at(-1));
  seedRun(h, next, { ...live, group, plan, seat: 2, parent: root, model: 'seat-two' }, null, [said('第 2 席续接后的正文')]);
  const after = await frameWhere(watch, size, has('第 2 席续接后的正文'));
  assert.ok(has('2 ● seat-two')(after), after.join('\n'));
  assert.equal(after.filter((line) => /^2 [✔●] /.test(line)).length, 1);
  assert.ok(!has('第 2 席第一轮')(after), after.join('\n'));
  watch.child.stdin.write('2');
  await frameWhere(watch, size, (frame) => has('第 2 席续接后的正文')(frame) && frame.at(-1).includes(D.seatKeys));
  watch.stop();
  await watch.done;
});

test('all finished 后自动纳入续接和新派发，无计划的续接仍在原位、沿用原号码', async (t) => {
  const h = sandbox(t), group = 'finished', size = '120x40';
  const root = '20000101-000001-root', next = '20000101-000003-next';
  seedRun(h, root, { group, model: 'first' }, { status: 'done', report });
  seedRun(h, '20000101-000002-peer', { group, model: 'second' }, { status: 'done', report });
  const watch = open(h, group, size);
  await frameWhere(watch, size, has(D.dashAllFinishedShort));
  seedRun(h, next, { ...live, group, parent: root, model: 'first' }, null, [said('全部结束后续接的正文')]);
  seedRun(h, '20000101-000004-new', { ...live, group, model: 'third' }, null, [said('同组新派发的正文')]);
  const after = await frameWhere(watch, size, (frame) => has('全部结束后续接的正文')(frame) && has('同组新派发的正文')(frame));
  const heads = after.filter((line) => /^\d+ [✔●] /.test(line));
  assert.match(heads[0], /^1 ● first /);
  assert.match(heads[1], /^2 ✔ second /);
  assert.match(heads[2], /^3 ● third /);
  assert.ok(!has(D.dashAllFinishedShort)(after), after.join('\n'));
  assert.ok(after.at(-1).includes(D.dashKeys('1–3', false)), after.at(-1));
  watch.child.stdin.write('1');
  await frameWhere(watch, size, (frame) => has('全部结束后续接的正文')(frame) && frame.at(-1).includes(D.seatKeys));
  watch.stop();
  await watch.done;
});

test('开头动画只数仍要运行的任务，不含 dismissed、已结束和续接的任务', async (t) => {
  const h = sandbox(t), group = 'intro-group';
  seedRun(h, '20000101-000001-dismissed', { group, status: 'interrupted', dismissed_at: new Date().toISOString(), ended_at: undefined });
  seedRun(h, '20000101-000002-done', { group }, { status: 'done', report });
  seedRun(h, '20000101-000003-live', { ...live, group, model: 'live-model' });
  seedRun(h, '20000101-000004-root', { group }, { status: 'done', report });
  seedRun(h, '20000101-000005-resume', { ...live, group, parent: '20000101-000004-root' });
  const watch = open(h, group, '120x40', true);
  await poll(() => plain(watch.stdout).includes(MESSAGES.zh.introDispatching(1, ['live-model'])), '动画只派出一个任务');
  assert.ok(!plain(watch.stdout).includes(MESSAGES.zh.introDispatching(2, null)), plain(watch.stdout));
  watch.stop();
  await watch.done;
  // 已交回的空任务即使残留 running，也不能单独触发动画。
  const dir = seedRun(h, '20000101-000006-dismissed-live', { ...live, group: 'dismissed-only', dismissed_at: new Date().toISOString() });
  const only = open(h, 'dismissed-only', '120x40', true);
  await frameWhere(only, '120x40', has('1 ●'));
  assert.ok(!plain(only.stdout).includes(MESSAGES.zh.introDispatching(1, null)), only.stdout);
  write(path.join(dir, 'meta.json'), { ...json(path.join(dir, 'meta.json')), status: 'interrupted' });
  only.stop();
  await only.done;
});

test('一组里有两份计划、席位号相撞时顺延到空号，号码不随刷新改变', async (t) => {
  const h = sandbox(t), group = 'two-plans', size = '120x40';
  const first = planFor(h, group, [1, 2]), second = 'two-plans-second';
  write(path.join(h.runs, 'plans', `${second}.json`), { plan_id: second, module: 'run', cell: 'normal', group, cwd: h.cwd,
    seats: [{ seat: 1, agent: 'codex' }], required: [] });
  seedRun(h, '20000101-000001-a1', { ...live, group, plan: first, seat: 1, model: 'alpha' }, null, [said('第一份计划第 1 席')]);
  seedRun(h, '20000101-000002-a2', { ...live, group, plan: first, seat: 2, model: 'beta' });
  seedRun(h, '20000101-000003-b1', { ...live, group, plan: second, seat: 1, model: 'gamma' }, null, [said('第二份计划第 1 席')]);
  const watch = open(h, group, size);
  const frame = await frameWhere(watch, size, has('gamma'));
  const heads = frame.filter((line) => /^\d+ ● /.test(line));
  assert.deepEqual(heads.map((line) => line.split(' ').slice(0, 3).join(' ')), ['1 ● alpha', '2 ● beta', '3 ● gamma']);
  assert.ok(frame.at(-1).includes(D.dashKeys('1–3', false)), frame.at(-1));
  watch.child.stdin.write('3');
  await frameWhere(watch, size, (f) => has('第二份计划第 1 席')(f) && f.at(-1).includes(D.seatKeys));
  watch.stop();
  await watch.done;
});

test('meta.json 暂时读不出时这一席留在画面上，all finished 也不消失', async (t) => {
  const h = sandbox(t), group = 'unreadable', size = '120x40';
  seedRun(h, '20000101-000001-first', { group, model: 'first' }, { status: 'done', report });
  const dir = seedRun(h, '20000101-000002-second', { group, model: 'second' }, { status: 'done', report });
  const watch = open(h, group, size);
  await frameWhere(watch, size, (frame) => has('2 ✔ second')(frame) && has(D.dashAllFinishedShort)(frame));
  const meta = path.join(dir, 'meta.json'), saved = fs.readFileSync(meta, 'utf8');
  fs.writeFileSync(meta, saved.slice(0, 10)); // 模拟替换到一半
  const offset = watch.stdout.length;
  await poll(() => watch.stdout.slice(offset).split('\x1b[1;1H').length > 3, '读不出以后又画了两帧');
  const frame = await frameWhere(watch, size, () => true);
  assert.ok(has('2 ✔ second')(frame) && has(D.dashAllFinishedShort)(frame), frame.join('\n'));
  fs.writeFileSync(meta, saved);
  watch.stop();
  await watch.done;
});

test('祖先第一次显示时读不出、后来恢复，再续接仍沿用原来的号码', async (t) => {
  const h = sandbox(t), group = 'late-root', size = '120x40';
  const rootDir = seedRun(h, '20000101-000001-root', { group, model: 'chain' }, { status: 'done', report });
  seedRun(h, '20000101-000002-peer', { group, model: 'peer' }, { status: 'done', report });
  seedRun(h, '20000101-000003-next', { group, parent: '20000101-000001-root', model: 'chain' }, { status: 'done', report });
  const meta = path.join(rootDir, 'meta.json'), saved = fs.readFileSync(meta, 'utf8');
  fs.writeFileSync(meta, saved.slice(0, 10));
  const watch = open(h, group, size);
  await frameWhere(watch, size, (frame) => has('1 ✔ peer')(frame) && has('2 ✔ chain')(frame));
  fs.writeFileSync(meta, saved);
  const offset = watch.stdout.length;
  await poll(() => watch.stdout.slice(offset).split('\x1b[1;1H').length > 3, '祖先恢复后又画了两帧');
  seedRun(h, '20000101-000004-last', { ...live, group, parent: '20000101-000003-next', model: 'chain' }, null, [said('再续接的正文')]);
  const after = await frameWhere(watch, size, has('再续接的正文'));
  assert.ok(has('2 ● chain')(after) && has('1 ✔ peer')(after), after.join('\n'));
  assert.ok(!after.some((line) => /^3 /.test(line)), after.join('\n'));
  watch.stop();
  await watch.done;
});
