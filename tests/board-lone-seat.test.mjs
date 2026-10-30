import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 只有一席的组（07-terms.js 的 loneGroup）：这一席默认展开，和不在组里的单任务栏一样。
// 展开的席位点身份行马上收起；在正文里单击等 250 ms 后收起，拖动、按在滚动条上、双击、选中了文字时不收
const source = fs.readFileSync(new URL('../board/web/07-terms.js', import.meta.url), 'utf8');
function terms() {
  const handlers = {}, timers = [], selection = { text: '' };
  const el = (id) => ({ addEventListener(type, fn) { handlers[`${id}:${type}`] = fn; }, getBoundingClientRect: () => ({ top: 0 }) });
  const context = vm.createContext({ B: { runs: new Map(), life: [] }, FINAL: new Map(), UI: { ver: 0 }, wake() {}, $: el, addEventListener() {}, innerHeight: 800,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: (n) => { if (n) timers[n - 1] = null; },
    getSelection: () => ({ isCollapsed: !selection.text, toString: () => selection.text, anchorNode: 'inside' }) });
  vm.runInContext(`${source}
globalThis.api = { loneGroup, PANEL };`, context);
  // 跑完到期的定时器（测试里不真等 250 ms）
  const flush = () => { while (timers.some(Boolean)) { const i = timers.findIndex(Boolean), fn = timers[i]; timers[i] = null; fn(); } };
  return { ...context.api, click: handlers['termsec:click'], down: handlers['termsec:pointerdown'], flush, selection };
}
// 点在席位的哪一处：inside 是点中的那一块（'.id' 身份行、'.term' 正文）；at 是松开的位置，detail 是第几下
function clickSeat(click, { id, open, inside, at = [10, 10], detail = 1 }) {
  const seat = { dataset: { lane: id }, classList: { contains: (c) => c === 'open' && open }, contains: (n) => n === 'inside' };
  click({ detail, clientX: at[0], clientY: at[1], target: { closest: (sel) => (sel === '.seat' ? seat : sel.split(',').map((s) => s.trim()).includes(inside) ? {} : null) } });
}
// 按下：bar 为真时按在正文框的滚动条上（正文框 0–100 px 宽，滚动条在 100 px 以外）
function press(down, { at = [10, 10], bar = false } = {}) {
  const ol = { getBoundingClientRect: () => ({ left: 0 }), clientLeft: 0, clientWidth: 100 };
  down({ clientX: bar ? 105 : at[0], clientY: at[1], target: { closest: (sel) => (sel === '.term' ? ol : null) } });
}

test('组里只有一席、没有 Claude Code 席、没有排队、计划也只有这一席时才算一席', () => {
  const { loneGroup } = terms();
  const lane = { id: 'a', lane: {} }, other = { id: 'b', lane: {} }, host = { id: 'host:h', host: {} };
  assert.equal(loneGroup([lane], [], []), true);
  assert.equal(loneGroup([lane], [], [{ host: null, seats: [{ seat: 1 }] }]), true);
  assert.equal(loneGroup([lane, other], [], []), false);
  assert.equal(loneGroup([host], [], []), false);
  assert.equal(loneGroup([lane], [{ group: 'g' }], []), false);
  // 计划里还有没启动的席位、或者有 Claude Code 席：之后会有第二席，不按一席展开
  assert.equal(loneGroup([lane], [], [{ host: null, seats: [{ seat: 1 }, { seat: 2 }] }]), false);
  assert.equal(loneGroup([lane], [], [{ host: { role: 'r' }, seats: [{ seat: 1 }] }]), false);
});

test('席位展开状态：没点过按默认，点身份行切换，正文单击延后收起', () => {
  const { PANEL, click, down, flush } = terms();
  assert.equal(PANEL.open.get('a'), undefined);
  // 默认展开的一席：正文单击，250 ms 后收起
  press(down); clickSeat(click, { id: 'a', open: true, inside: '.term' });
  assert.equal(PANEL.open.get('a'), undefined);
  flush();
  assert.equal(PANEL.open.get('a'), false);
  // 收起的席位点哪里都马上展开
  press(down); clickSeat(click, { id: 'a', open: false, inside: '.term' });
  assert.equal(PANEL.open.get('a'), true);
  // 身份行马上收起
  press(down); clickSeat(click, { id: 'a', open: true, inside: '.id' });
  assert.equal(PANEL.open.get('a'), false);
});

test('展开的席位：拖动、按在滚动条上、双击、选中了文字时，正文里的点击不收起', () => {
  const { PANEL, click, down, flush, selection } = terms();
  PANEL.open.set('a', true);
  // 按下后拖了 20 px 再松开（拖选文字）
  press(down, { at: [10, 10] }); clickSeat(click, { id: 'a', open: true, inside: '.term', at: [30, 10] }); flush();
  assert.equal(PANEL.open.get('a'), true);
  // 按在滚动条上
  press(down, { bar: true }); clickSeat(click, { id: 'a', open: true, inside: '.term', at: [105, 10] }); flush();
  assert.equal(PANEL.open.get('a'), true);
  // 双击选词：第一下排上的收起被第二下取消
  press(down); clickSeat(click, { id: 'a', open: true, inside: '.term' });
  press(down); clickSeat(click, { id: 'a', open: true, inside: '.term', detail: 2 }); flush();
  assert.equal(PANEL.open.get('a'), true);
  // 单击时已经选中了席位里的文字
  selection.text = 'run 20261030';
  press(down); clickSeat(click, { id: 'a', open: true, inside: '.term' }); flush();
  assert.equal(PANEL.open.get('a'), true);
  // 等待期间选中了文字（三击选段）也不收
  selection.text = '';
  press(down); clickSeat(click, { id: 'a', open: true, inside: '.term' });
  selection.text = 'line'; flush();
  assert.equal(PANEL.open.get('a'), true);
});
