import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 收历史数据（01-state.js 的 onEvents）：一批事件整批归并进车道，结果必须和逐条 onEv 一模一样
const source = ['00-text', '01-state'].map((name) => fs.readFileSync(new URL(`../board/web/${name}.js`, import.meta.url), 'utf8')).join('\n');
function page() {
  const context = vm.createContext({ window: { __BOARD_FIXTURE__: true }, location: { search: '' }, URLSearchParams, wake() {}, performance });
  vm.runInContext(`${source}\nglobalThis.api = { B, onHello, onRun, onEv, onEvents, onBacklog };`, context);
  const api = context.api;
  api.onHello({ v: 3, mode: 'live', now: 0, replay: null });
  return api;
}
// 两边比的内容：车道的先后、每条车道的展示事件和统计事件（按序号和内容）、最后一条、计划和评判、用户消息时刻、事件总数
const state = (B) => JSON.parse(JSON.stringify({
  lanes: B.lanes.map((l) => ({ id: l.id, events: l.events.map((e) => [e.id, e.ts, e.k, e.t]), rates: l.rate_events.map((e) => [e.run, e.ts, e.k, e.u?.out ?? null]), last: l.last && l.last.id })),
  life: B.life.map((e) => [e.id, e.k, e.plan]), prompts: B.prompts, total: B.total,
}));

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (list) => list[Math.floor(rand() * list.length)];

test('一批历史事件整批归并的结果和逐条插入完全一样：乱序、同一时刻、指定车道、超出上限、计划和用户消息', () => {
  const runs = ['cc', 'a', 'b', 'c'], kinds = ['msg', 'usage', 'cmd', 'fplan', 'verdict', 'prompt'];
  for (let round = 0; round < 20; round++) {
    const one = page(), batch = page();
    for (const api of [one, batch]) for (const id of runs) api.onRun({ id, lane: id === 'c' ? 'b' : id, started_at: 0 });
    // 先有一些实时事件，再来几批回填；时间只取几十个值，同一时刻的很多
    const live = Array.from({ length: 50 + Math.floor(rand() * 300) }, (_, i) => ({ run: pick(runs), ts: 1000 + Math.floor(rand() * 60) * 10, k: pick(kinds), t: `live${i}` }));
    const batches = Array.from({ length: 4 }, (_, n) => Array.from({ length: 300 + Math.floor(rand() * 900) }, (_, i) => {
      const ev = { run: runs[n], ts: 1000 + Math.floor(rand() * 60) * 10, k: pick(kinds), t: `b${n}-${i}`, u: { out: i } };
      if (ev.k === 'fplan') ev.plan = `p${Math.floor(rand() * 3)}`;
      if (rand() < 0.1) ev.lane = pick(['a', 'b']); // 指定了车道的事件（比如交回）进别的车道
      return ev;
    }));
    const copy = (list) => list.map((ev) => ({ ...ev, u: ev.u && { ...ev.u } }));
    for (const ev of copy(live)) one.onEv(ev);
    for (const ev of copy(live)) batch.onEv(ev);
    for (const list of batches) {
      for (const ev of copy(list)) one.onEv(ev);
      batch.onEvents(copy(list));
    }
    assert.deepEqual(state(batch.B), state(one.B), `round ${round}`);
    assert.ok(batch.B.lanes.some((l) => l.events.length === 600), '至少有一条车道到了展示上限');
  }
});

test('回填带统计历史时不再逐条记统计事件，版本号每批只加一次', () => {
  const api = page();
  api.onRun({ id: 'a', lane: 'a', started_at: 0 });
  const before = api.B.version;
  api.onBacklog({ run: 'a', events: [{ run: 'a', ts: 2, k: 'msg' }, { run: 'a', ts: 1, k: 'msg' }], rate_events: [{ run: 'a', ts: 1, k: 'usage', u: { out: 3 } }] });
  const lane = api.B.laneById.get('a');
  assert.deepEqual(Array.from(lane.events, (e) => e.ts), [1, 2]);
  assert.deepEqual(Array.from(lane.rate_events, (e) => e.k), ['usage']);
  assert.equal(api.B.version - before, 2); // 展示事件一批一次，统计历史一次
});
