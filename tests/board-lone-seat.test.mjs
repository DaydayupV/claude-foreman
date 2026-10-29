import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 只有一席的组（07-terms.js 的 loneGroup）：这一席默认展开，和不在组里的单任务栏一样；点身份行收起，点正文不收
const source = fs.readFileSync(new URL('../board/web/07-terms.js', import.meta.url), 'utf8');
function terms() {
  const handlers = {};
  const el = (id) => ({ addEventListener(type, fn) { handlers[`${id}:${type}`] = fn; }, getBoundingClientRect: () => ({ top: 0 }) });
  const context = vm.createContext({ B: { runs: new Map(), life: [] }, FINAL: new Map(), UI: { ver: 0 }, wake() {}, $: el, addEventListener() {}, innerHeight: 800 });
  vm.runInContext(`${source}\nglobalThis.api = { loneGroup, PANEL };`, context);
  return { ...context.api, click: handlers['termsec:click'] };
}
// 点在席位的哪一处：inside 是点中的那一块（'.id' 身份行、'.term' 正文）
function clickSeat(click, { id, open, inside }) {
  const seat = { dataset: { lane: id }, classList: { contains: (c) => c === 'open' && open } };
  click({ target: { closest: (sel) => (sel === '.seat' ? seat : sel.split(',').map((s) => s.trim()).includes(inside) ? {} : null) } });
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

test('席位展开状态：没点过按默认，点身份行切换，展开时点正文不收起', () => {
  const { PANEL, click } = terms();
  assert.equal(PANEL.open.get('a'), undefined);
  // 默认展开的一席：点正文（选文字、拖滚动条）不收起
  clickSeat(click, { id: 'a', open: true, inside: '.term' });
  assert.equal(PANEL.open.get('a'), undefined);
  clickSeat(click, { id: 'a', open: true, inside: '.id' });
  assert.equal(PANEL.open.get('a'), false);
  // 收起的席位点哪里都展开
  clickSeat(click, { id: 'a', open: false, inside: '.term' });
  assert.equal(PANEL.open.get('a'), true);
});
