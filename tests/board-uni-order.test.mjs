import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 宇宙视图用量表的排序（07-uni-side.js 的 byState）：只加载文字和这一个文件
const source = ['00-text', '07-uni-side'].map((name) => fs.readFileSync(new URL(`../board/web/${name}.js`, import.meta.url), 'utf8')).join('\n');
const el = () => ({ addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} }, dataset: {}, style: {}, querySelector: () => null });
const context = vm.createContext({ window: { __LANG__: 'zh' }, location: { search: '' }, URLSearchParams, $: el, document: { createElement: el } });
vm.runInContext(`${source}\nglobalThis.byState = byState;`, context);
const order = (list) => [...list].sort(context.byState).map((s) => s.id);

test('进行中的对话按最近一轮用户消息的时间排（新的在上），状态和动静变了也不挪；空闲的在后面按最后活动排', () => {
  const a = { id: 'a', state: 'thinking', prompt_at: 3000, last_at: 9000 };
  const b = { id: 'b', state: 'dispatching', prompt_at: 5000, last_at: 6000 };
  const c = { id: 'c', state: 'waiting', prompt_at: 1000, last_at: 9500 };
  const idleOld = { id: 'old', state: 'idle', prompt_at: 8000, last_at: 7000 }, idleNew = { id: 'new', state: 'idle', prompt_at: 100, last_at: 8000 };
  assert.deepEqual(order([a, idleOld, c, b, idleNew]), ['b', 'a', 'c', 'new', 'old']);
  // a 有了新动静、从思考变成等确认，位置不变
  assert.deepEqual(order([{ ...a, state: 'waiting', last_at: 99999 }, b, c]), ['b', 'a', 'c']);
  // 没有 prompt_at 时按对话开始的时间
  assert.deepEqual(order([{ id: 'x', state: 'thinking', started_at: 10 }, { id: 'y', state: 'thinking', started_at: 20 }]), ['y', 'x']);
});
