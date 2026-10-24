import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildReplay, replayClock, snapshotAt } from '../foreman/skills/dispatch/scripts/board/feed.mjs';

const source = ['01-state', '04-rates'].map((name) => readFileSync(new URL(`../board/web/${name}.js`, import.meta.url), 'utf8')).join('\n');
const base = Date.parse('2026-10-24T00:00:00Z'), near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const run = (id, end, output, start = 0) => ({ id, lane: 'seat', kind: 'exec', model: 'model', status: 'done',
  started_at: base + start, ended_at: base + end, usage: { output } });
const ev = (id, at, k, fields = {}) => ({ run: id, lane: 'seat', ts: base + at, k, ...fields });
const data = (runs, events) => ({ scope: { kind: 'session', value: 'synthetic' }, runs, events });
function board(snapshot, final = snapshot) {
  const context = vm.createContext({ window: { __BOARD_FIXTURE__: true }, location: { search: '' }, URLSearchParams, performance: { now: () => 0 }, wake() {} });
  vm.runInContext(`${source}\nglobalThis.api = { B, loadSnapshot, segments, laneStats, rateAt, sparkline, FINAL, FINAL_EV, SEG_RUN };`, context);
  const b = context.api;
  b.loadSnapshot(structuredClone(snapshot));
  if (snapshot.hello.mode === 'replay') {
    for (const r of final.runs) b.FINAL.set(r.id, r);
    for (const e of final.events) {
      const id = e.lane || e.run;
      if (!b.FINAL_EV.has(id)) b.FINAL_EV.set(id, []);
      b.FINAL_EV.get(id).push(e);
    }
  }
  return b;
}
const lane = (b) => b.B.laneById.get('seat');
const sum = (segs, field) => segs.reduce((n, s) => n + (field === 'ms' ? s.b - s.a : s.tokens), 0);

test('maxgap 20/120 and speed 1/4 preserve live rates on own and shared clocks', () => {
  const raw = data([run('r', 120000, 1200)], [ev('r', 0, 'turn'), ev('r', 120000, 'usage', { u: { out: 1200 } })]);
  const live = board({ hello: { mode: 'live', now: base + 120000 }, ...raw });
  near(live.laneStats(lane(live), base + 120000).avg, 10);
  for (const maxgap of [20, 120]) for (const speed of [1, 4]) for (const shared of [false, true]) {
    const options = { maxgap, speed };
    if (shared) options.clock = replayClock([base - 5000, base, base + 40000, base + 120000], options, base);
    const replay = buildReplay(raw, options, base), final = snapshotAt(replay), end = replay.timeline.at(-1).time;
    const b = board(snapshotAt(replay, (end - replay.hello.replay.start) / (1000 * speed)), final);
    const s = b.laneStats(lane(b), end);
    near(s.avg, 10); near(s.avg, live.laneStats(lane(live), base + 120000).avg);
    near(s.rate, 10); near(s.elapsed, 120); near(s.output, 1200);
    assert.deepEqual(Array.from(b.sparkline(lane(b), end)), Array.from(live.sparkline(lane(live), base + 120000)));
    const last = shared ? options.clock.map(base + 40000) : replay.timeline[0].time;
    const mid = (last + end) / 2, original = base + (shared ? 80000 : 60000);
    const during = board(snapshotAt(replay, (mid - replay.hello.replay.start) / (1000 * speed)), final);
    near(during.laneStats(lane(during), mid).avg, 10);
    near(during.laneStats(lane(during), mid).elapsed, (original - base) / 1000);
    near(during.rateAt(lane(during), mid), live.rateAt(lane(live), original));
  }
  const zero = buildReplay(raw, { maxgap: 0 }, base), b = board(snapshotAt(zero));
  near(b.laneStats(lane(b), zero.hello.replay.end).avg, 10);
});

test('replay keeps original usage bounds even when receipt and run completion arrive later', () => {
  const raw = data([run('r', 160000, 1200)], [ev('r', 150000, 'usage', {
    u: { out: 1200 }, end: 1, usage_from: base + 10000, usage_to: base + 130000,
  })]);
  const live = board({ hello: { mode: 'live' }, ...raw });
  for (const maxgap of [20, 120]) for (const speed of [1, 4]) {
    const replay = buildReplay(raw, { maxgap, speed }, base), b = board(snapshotAt(replay));
    const s = b.laneStats(lane(b), replay.hello.replay.end);
    near(s.avg, live.laneStats(lane(live), base + 160000).avg); near(s.avg, 10); near(s.elapsed, 160);
    assert.ok(b.segments(lane(b)).every((s) => s.a >= base + 10000 && s.b <= base + 130000));
  }
});

test('replay supplements conserve tokens and count generation time once for partial, full and overlapping coverage', () => {
  const cases = [
    [ev('r', 79000, 'usage', { u: { out: 790 } })],
    [ev('r', 107000, 'usage', { u: { out: 790 } })],
    [ev('r', 0, 'think', { n: 0 }), ev('r', 0, 'answer', { n: 0 }),
      ev('r', 79000, 'think', { n: 1580 }), ev('r', 79000, 'answer', { n: 1580 })],
  ];
  for (const events of cases) {
    const replay = buildReplay(data([run('r', 107000, 1070)], events), { maxgap: 120 }, base), b = board(snapshotAt(replay));
    const segs = b.segments(lane(b)), s = b.laneStats(lane(b), replay.hello.replay.end);
    near(sum(segs, 'tokens'), 1070); near(s.output, 1070); near(s.avg, 10); near(s.elapsed, 107);
    near(s.output / s.avg, 107); assert.ok(s.output / s.avg <= s.elapsed); assert.equal(s.est, true);
    if (events.length === 1) near(sum(segs, 'ms'), 107000);
    if (events[0].ts === base + 107000) assert.equal(segs.length, 1);
  }
});

test('parallel runs supplement only their own uncovered intervals, including on the same lane', () => {
  const raw = data([run('a', 107000, 1070), run('b', 90000, 700, 20000)],
    [ev('a', 79000, 'usage', { u: { out: 790 } }), ev('b', 90000, 'usage', { u: { out: 700 } })]);
  const replay = buildReplay(raw, { maxgap: 120 }, base), b = board(snapshotAt(replay)), segs = b.segments(lane(b));
  const own = (id) => segs.filter((s) => b.SEG_RUN.get(s) === id), extra = own('a').filter((s) => s.est);
  near(sum(own('a'), 'tokens'), 1070); near(sum(own('a'), 'ms'), 107000);
  near(sum(own('b'), 'tokens'), 700); near(sum(own('b'), 'ms'), 70000);
  assert.deepEqual(Array.from(extra, (s) => [s.a - base, s.b - base]), [[79000, 107000]]);
  assert.ok(own('b').every((s) => !s.est && s.a >= base + 20000 && s.b <= base + 90000));
  const s = b.laneStats(lane(b), replay.hello.replay.end);
  near(s.output, 1770); near(s.avg, 10); near(s.output / s.avg, 177);
  const at = replay.timeline.find((m) => m.event === 'run' && m.data.id === 'b' && m.data.status === 'done').time;
  const during = board(snapshotAt(replay, (at - replay.hello.replay.start) / 1000), snapshotAt(replay));
  near(during.laneStats(lane(during), at).output, 1600); near(during.laneStats(lane(during), at).avg, 10);
});
