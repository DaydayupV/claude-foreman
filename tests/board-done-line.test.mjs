import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 已结束组折叠行的文字缓存（07-terms.js 的 doneLine）：任务记录一更新（页面换成新对象）就重算，没变就沿用
const source = fs.readFileSync(new URL('../board/web/07-terms.js', import.meta.url), 'utf8');
function terms() {
  const el = () => ({ addEventListener() {}, getBoundingClientRect: () => ({ top: 0 }) });
  const context = vm.createContext({ B: { runs: new Map(), life: [] }, FINAL: new Map(), $: el, addEventListener() {}, innerHeight: 800 });
  vm.runInContext(`${source}\nglobalThis.api = { doneLine, setText: (f) => { doneText = f; } };`, context);
  return context;
}

test('折叠行的文字在这一组的任务记录换成新对象时重算，没换时沿用', () => {
  const c = terms();
  let computed = 0;
  c.api.setText(() => `line ${++computed}`);
  const first = { id: 'a', group: 'g', started_at: 0, ended_at: 10, status: 'failed' };
  c.B.runs.set('a', first);
  const u = { id: 'group:g', group: 'g', lanes: [] };
  assert.equal(c.api.doneLine(u, 1000), 'line 1');
  assert.equal(c.api.doneLine(u, 2000), 'line 1');
  // 结果迟到：状态、结束时间、费用都没变，只是记录换了
  c.B.runs.set('a', { ...first });
  assert.equal(c.api.doneLine(u, 3000), 'line 2');
  assert.equal(c.api.doneLine(u, 4000), 'line 2');
});
