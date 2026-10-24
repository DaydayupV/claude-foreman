import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 每帧要不要刷新面板（09-main.js 的 domStep、domDrawn）：只取这一段源码，B、UI 用最小的替身
const main = fs.readFileSync(new URL('../board/web/09-main.js', import.meta.url), 'utf8');
const block = main.slice(main.indexOf('const DOM = '), main.indexOf('\n}\n', main.indexOf('function domDrawn(')) + 2);
function stepper() {
  const context = vm.createContext({ B: { version: 0 }, UI: { ver: 0 } });
  vm.runInContext(`${block}\nglobalThis.domStep = domStep; globalThis.domDrawn = domDrawn;`, context);
  return context;
}

test('数据一直在变时最快每 250 毫秒刷新一次，界面操作马上刷新，没变也每半秒刷新一次', () => {
  const c = stepper();
  let d;
  d = c.domStep(1000, false); assert.deepEqual({ ...d }, { table: true, terms: true }); c.domDrawn(d, true, true);
  c.B.version++; assert.equal(c.domStep(1100, false), null);
  c.B.version++; assert.equal(c.domStep(1249, false), null);
  d = c.domStep(1250, false); assert.deepEqual({ ...d }, { table: true, terms: true }); c.domDrawn(d, true, true);
  c.UI.ver++; d = c.domStep(1260, false); assert.deepEqual({ ...d }, { table: true, terms: true }); c.domDrawn(d, true, true);
  assert.equal(c.domStep(1700, false), null);
  assert.deepEqual({ ...c.domStep(1761, false) }, { table: true, terms: true });
});

test('飞入时只刷新卡片，落地后先搭用量表、搭完再搭终端区，没搭完的下一帧接着搭', () => {
  const c = stepper();
  let d;
  d = c.domStep(1000, true); assert.deepEqual({ ...d }, { table: false, terms: false }); c.domDrawn(d, true, true);
  c.B.version++; assert.equal(c.domStep(1100, true), null);
  // 用量表这一帧没建完：下一帧还是只建用量表
  d = c.domStep(1116, false); assert.deepEqual({ ...d }, { table: true, terms: false }); c.domDrawn(d, false, true);
  d = c.domStep(1132, false); assert.deepEqual({ ...d }, { table: true, terms: false }); c.domDrawn(d, true, true);
  d = c.domStep(1148, false); assert.deepEqual({ ...d }, { table: false, terms: true }); c.domDrawn(d, true, false);
  d = c.domStep(1164, false); assert.deepEqual({ ...d }, { table: false, terms: true }); c.domDrawn(d, true, true);
  assert.equal(c.domStep(1180, false), null);
});

test('平时没画完的下一帧接着画，不等 250 毫秒', () => {
  const c = stepper();
  let d;
  d = c.domStep(1000, false); c.domDrawn(d, true, false);
  d = c.domStep(1016, false); assert.deepEqual({ ...d }, { table: true, terms: true }); c.domDrawn(d, true, true);
  assert.equal(c.domStep(1032, false), null);
});
