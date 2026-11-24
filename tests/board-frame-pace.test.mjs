import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../board/web/09-main.js', import.meta.url), 'utf8');
const block = main.slice(main.indexOf('const FRAME_BUSY = '), main.indexOf('const PACE = '));
const paceWait = vm.runInNewContext(`${block}\npaceWait`);
const wait = (overrides) => paceWait({
  nowMs: 2000, lastFrame: 2000, changedAt: 0, moving: false, live: false, quiet: false, pending: false,
  ...overrides,
});

test('正在操作或移动镜头时约 16 毫秒一帧，留 3 毫秒余量', () => {
  assert.equal(wait({ moving: true, live: true }), 13);
  assert.equal(wait({ moving: true, nowMs: 2012 }), 1);
  assert.equal(wait({ moving: true, nowMs: 2013 }), 0);
});

test('有任务在跑时约 33 毫秒一帧', () => {
  assert.equal(wait({ live: true }), 30);
});

test('空闲时约 100 毫秒一帧', () => {
  assert.equal(wait(), 97);
});

test('减少动态效果时，有任务在跑也按约 100 毫秒画过渡', () => {
  assert.equal(wait({ quiet: true, live: true, changedAt: 1990 }), 97);
});

test('减少动态效果时，内容变化后的一秒内按约 100 毫秒画', () => {
  assert.equal(wait({ quiet: true, changedAt: 1001 }), 97);
});

test('减少动态效果时，内容安静后等到离上一帧满一秒', () => {
  assert.equal(wait({ quiet: true, changedAt: 1000, lastFrame: 1300 }), 300);
  assert.equal(wait({ quiet: true, nowMs: 2299, lastFrame: 1300 }), 1);
  assert.equal(wait({ quiet: true, nowMs: 2300, lastFrame: 1300 }), 0);
});

test('减少动态效果时，还有分帧工作就按约 100 毫秒画', () => {
  assert.equal(wait({ quiet: true, pending: true }), 97);
});

test('减少动态效果时，镜头在动仍按约 16 毫秒画', () => {
  assert.equal(wait({ quiet: true, moving: true }), 13);
});

test('空闲用单个定时器提前唤醒，窗口缩放立即请求下一帧', () => {
  const timers = new Map(), listeners = new Map(), frames = [];
  let timerId = 0;
  const scheduler = main.slice(main.indexOf('let raf = '), main.indexOf('function step() {'));
  const wakeIn = vm.runInNewContext(`${scheduler}\nwakeIn`, {
    addEventListener: (type, fn) => listeners.set(type, fn),
    performance: { now: () => 2000 },
    requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    step() {},
  });

  wakeIn(wait());
  assert.deepEqual([...timers.values()].map((timer) => timer.ms), [81]);
  assert.equal(frames.length, 0);
  wakeIn(wait({ quiet: true }));
  assert.deepEqual([...timers.values()].map((timer) => timer.ms), [84]);
  const [[id, timer]] = timers;
  timers.delete(id);
  timer.fn();
  assert.equal(frames.length, 1);
  frames.shift()();

  wakeIn(wait());
  listeners.get('resize')();
  listeners.get('resize')();
  assert.equal(timers.size, 0);
  assert.equal(frames.length, 1);
});
