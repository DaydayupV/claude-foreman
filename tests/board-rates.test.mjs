import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../board/web/04-rates.js', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('../board/web/01-state.js', import.meta.url), 'utf8');
function board(mode = 'live') {
  const context = vm.createContext({ window: { __BOARD_FIXTURE__: true }, location: { search: '' }, URLSearchParams, wake: () => {} });
  vm.runInContext(`${stateSource}\n${source}\nglobalThis.rates = { B, onRun, onEv, segments, rateAt, sparkline, laneStats, FINAL, FINAL_EV };`, context);
  context.rates.B.clock.mode = mode;
  return context.rates;
}
function lane(b, id, rows, fields = {}) {
  const run = { id, model: 'model-a', status: 'running', started_at: 0, ended_at: null, ...fields };
  b.onRun(run);
  for (const [ts, k, fields] of rows) b.onEv({ run: id, ts, k, ...fields });
  return b.B.lanes.find((l) => l.id === id);
}
const total = (b, l) => b.segments(l).reduce((sum, s) => sum + s.tokens, 0);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const rounds = [[0, 'turn'], [10000, 'usage', { u: { out: 100 } }], [11000, 'turn'],
  [30000, 'usage', { u: { out: 400 } }], [31000, 'turn']];

test('API streaming and usage agree with usage alone for current and average rates', () => {
  const b = board(), usage = [[10000, 'usage', { u: { out: 100 } }], [20000, 'usage', { u: { out: 300 } }]];
  const chars = [[1000, 'think', { n: 40 }], [3000, 'think', { n: 400 }],
    [4000, 'answer', { n: 40 }], [9000, 'answer', { n: 400 }],
    [11000, 'think', { n: 40 }], [13000, 'think', { n: 400 }],
    [14000, 'answer', { n: 40 }], [19000, 'answer', { n: 1200 }]];
  const api = lane(b, 'api', [...chars, ...usage].sort((a, b) => a[0] - b[0]));
  const only = lane(b, 'usage', usage);
  for (const t of [10000, 15000, 20000]) {
    near(b.rateAt(api, t), b.rateAt(only, t));
    near(b.laneStats(api, t).avg, b.laneStats(only, t).avg);
  }
  near(total(b, api), 400); near(b.rateAt(api, 20000), 30);
  near(b.laneStats(api, 20000).output, 400); near(b.laneStats(api, 20000).avg, 20);
});

test('API keeps only character increments after the latest usage and replaces them on arrival', () => {
  const b = board(), l = lane(b, 'api', [[1000, 'answer', { n: 0 }], [4000, 'answer', { n: 4000 }],
    [5000, 'usage', { u: { out: 50 } }], [6000, 'answer', { n: 4400 }], [8000, 'answer', { n: 4480 }]]);
  const cached = b.segments(l);
  near(total(b, l), 70); near(b.laneStats(l, 8000).avg, 10);
  b.onEv({ run: l.id, ts: 9000, k: 'usage', u: { out: 40 } });
  assert.notEqual(b.segments(l), cached);
  near(total(b, l), 90); near(b.laneStats(l, 9000).avg, 10);
});

test('pi character-only output and the segment cache stay unchanged', () => {
  const b = board(), l = lane(b, 'pi', [[1000, 'think', { n: 40 }], [5000, 'think', { n: 200 }],
    [6000, 'answer', { n: 40 }], [10000, 'answer', { n: 200 }]]);
  const segs = b.segments(l);
  assert.equal(b.segments(l), segs); assert.equal(l.segsAt, `4|${l.runs.length}`);
  near(total(b, l), 80); near(b.rateAt(l, 10000), 8);
  near(b.laneStats(l, 10000).output, 80); near(b.laneStats(l, 10000).avg, 10);
});

test('live Codex uses its own previous rounds without adding output or generation time', () => {
  const b = board(), l = lane(b, 'codex', rounds);
  lane(b, 'peer', [[10000, 'usage', { u: { out: 9999 } }]]);
  const cached = b.segments(l), avg = 500 / 30;
  near(b.rateAt(l, 32000), 16 + avg / 10);
  for (const t of [41000, 50000]) {
    const s = b.laneStats(l, t);
    near(s.rate, avg); near(s.avg, avg); near(s.output, 500); assert.equal(s.est, true);
  }
  near(b.sparkline(l, 50000, 10000, 2).at(-1), avg);
  assert.equal(b.segments(l), cached); near(total(b, l), 500);
});

test('live estimates pause during commands and resume only over available window time', () => {
  const b = board(), l = lane(b, 'codex', [...rounds, [45000, 'cmd', { t: 'node task.mjs' }]]);
  near(b.rateAt(l, 44000), 500 / 30);
  near(b.rateAt(l, 60000), 0); assert.equal(b.laneStats(l, 60000).est, false);
  b.onEv({ run: l.id, ts: 70000, k: 'cmd_done', ok: true });
  near(b.rateAt(l, 60000), 0); near(b.rateAt(l, 71000), (500 / 30) / 10);
  near(b.rateAt(l, 80000), 500 / 30); assert.equal(b.laneStats(l, 80000).est, true);
});

test('the first round borrows only other lanes of the same model', () => {
  const b = board(), l = lane(b, 'new', [[20000, 'turn']], { started_at: 20000 });
  lane(b, 'different', [[10000, 'usage', { u: { out: 9000 } }]], { model: 'model-b' });
  near(b.rateAt(l, 40000), 0); assert.equal(b.laneStats(l, 40000).est, false);
  lane(b, 'peer', [[10000, 'usage', { u: { out: 200 } }]],
    { status: 'done', ended_at: 10000, usage: { output: 200 } });
  const s = b.laneStats(l, 40000);
  near(s.rate, 20); near(s.output, 0); assert.equal(s.avg, null); assert.equal(s.est, true);
});

test('replay, stopped runs, completed rounds and streaming rounds never use live estimates', () => {
  const cases = [
    { mode: 'replay', rows: rounds },
    { rows: rounds, fields: { status: 'done', ended_at: 35000, usage: { output: 500 } } },
    { rows: rounds, fields: { status: 'idle' } },
    { rows: rounds.slice(0, -1) },
    { rows: [...rounds, [40000, 'think', { n: 0 }], [45000, 'think', { n: 40 }]] },
  ];
  for (const { mode, rows, fields } of cases) {
    const b = board(mode), l = lane(b, 'codex', rows, fields);
    near(b.rateAt(l, 60000), 0); assert.equal(b.laneStats(l, 60000).est, false);
  }
});

test('command time is excluded across usage boundaries, paired only within each run', () => {
  const b = board(), l = lane(b, 'codex', [[0, 'turn'], [5000, 'cmd'],
    [10000, 'usage', { u: { out: 100 } }], [15000, 'cmd_done', { ok: false }],
    [20000, 'usage', { u: { out: 100 } }]],
  { status: 'done', ended_at: 20000, usage: { output: 200 } });
  b.onEv({ run: 'unrelated', lane: l.id, ts: 6000, k: 'cmd_done' });
  const segs = b.segments(l);
  assert.ok(segs.every((s) => s.b <= 5000 || s.a >= 15000));
  near(total(b, l), 200); near(b.laneStats(l, 20000).avg, 20);
  near(b.rateAt(l, 15000, 10000), 0);
});

test('fully command-covered intervals retain their tokens using the original spread', () => {
  const b = board(), l = lane(b, 'busy', [[0, 'cmd'], [10000, 'cmd_done'],
    [10000, 'usage', { u: { out: 100 } }]]);
  near(total(b, l), 100); near(b.laneStats(l, 10000).avg, 10);
});

test('replay final-output spreading also excludes commands and avoids API double counting', () => {
  const b = board('replay'), l = lane(b, 'replay', []);
  b.FINAL_EV.set(l.id, [{ run: l.id, ts: 1000, k: 'answer', n: 0 },
    { run: l.id, ts: 2000, k: 'answer', n: 400 }, { run: l.id, ts: 3000, k: 'cmd' },
    { run: l.id, ts: 7000, k: 'cmd_done' }, { run: l.id, ts: 10000, k: 'usage', u: { out: 100 } }]);
  b.FINAL.set(l.id, { ended_at: 10000, usage: { output: 200 } });
  near(total(b, l), 200);
  assert.ok(b.segments(l).every((s) => s.b <= 3000 || s.a >= 7000));
  assert.equal(b.laneStats(l, 10000).est, true);
});

test('older data without commands keeps the original capped-gap result and public segment fields', () => {
  const b = board(), l = lane(b, 'old', [[10000, 'think', { t: 'thinking' }],
    [130000, 'usage', { u: { out: 700 } }]],
  { status: 'done', ended_at: 130000, usage: { output: 700 } });
  assert.deepEqual(Array.from(b.segments(l), (s) => ({ ...s })), [
    { a: 0, b: 10000, tokens: 100, est: false }, { a: 70000, b: 130000, tokens: 600, est: false },
  ]);
  near(b.rateAt(l, 130000), 10); near(b.laneStats(l, 130000).avg, 10);
});

test('parallel commands keep estimates paused until every command finishes', () => {
  const b = board(), l = lane(b, 'codex', [...rounds, [40000, 'cmd'], [41000, 'cmd'],
    [50000, 'cmd_done'], [70000, 'cmd_done']]);
  near(b.rateAt(l, 60000), 0); assert.equal(b.laneStats(l, 60000).est, false);
  near(b.rateAt(l, 80000), 500 / 30); assert.equal(b.laneStats(l, 80000).est, true);
  b.onEv({ run: l.id, ts: 90000, k: 'usage', u: { out: 600 } });
  assert.ok(b.segments(l).every((s) => s.b <= 40000 || s.a >= 70000));
  near(total(b, l), 1100); near(b.laneStats(l, 90000).avg, 1100 / 60);
});

test('a continued run samples earlier runs of the same model on its own lane first', () => {
  const b = board(), l = lane(b, 'round-1', [[0, 'turn'], [10000, 'usage', { u: { out: 200 } }]],
    { status: 'done', ended_at: 10000, usage: { output: 200 } });
  b.onRun({ id: 'round-2', lane: l.id, model: 'model-a', status: 'running', started_at: 20000, ended_at: null });
  b.onEv({ run: 'round-2', ts: 20000, k: 'turn' });
  b.onRun({ id: 'other-model', lane: l.id, model: 'model-b', status: 'done', started_at: 10000, ended_at: 20000 });
  b.onEv({ run: 'other-model', ts: 20000, k: 'usage', u: { out: 9000 } });
  near(b.rateAt(l, 40000), 20); assert.equal(b.laneStats(l, 40000).est, true);
  lane(b, 'peer', [[10000, 'usage', { u: { out: 9900 } }]]);
  near(b.rateAt(l, 40000), 20);
  b.onEv({ run: 'round-2', ts: 50000, k: 'usage', u: { out: 900 } });
  b.onEv({ run: 'round-2', ts: 51000, k: 'turn' });
  near(b.rateAt(l, 70000), 1100 / 40);
});

test('events beyond the 600-event limit refresh cached rates, output and average', () => {
  const b = board(), l = lane(b, 'pi', []);
  for (let i = 0; i < 600; i++) b.onEv({ run: l.id, ts: i * 1000, k: 'answer', n: i * 4 });
  const cached = b.segments(l), before = b.laneStats(l, 599000);
  near(before.rate, 1); near(before.output, 599); near(before.avg, 1);
  b.onEv({ run: l.id, ts: 600000, k: 'answer', n: (599 + 100) * 4 });
  assert.equal(l.events.length, 600); assert.equal(l.ver, 601); assert.equal(l.events[0].ts, 1000);
  assert.notEqual(b.segments(l), cached); assert.equal(l.segsAt, `${l.ver}|${l.runs.length}`);
  const after = b.laneStats(l, 600000);
  near(after.rate, 10.9); near(after.output, 698); near(after.avg, 698 / 599);
});

test('final replay events continue to cache by length rather than the live event counter', () => {
  const b = board('replay'), l = lane(b, 'replay', []), events = [{ run: l.id, ts: 10000, k: 'usage', u: { out: 100 } }];
  b.FINAL_EV.set(l.id, events);
  const cached = b.segments(l);
  b.onEv({ run: l.id, ts: 1000, k: 'turn' });
  assert.equal(b.segments(l), cached);
  events.push({ run: l.id, ts: 20000, k: 'usage', u: { out: 200 } });
  assert.notEqual(b.segments(l), cached); assert.equal(l.segsAt, `2|${l.runs.length}`);
  near(total(b, l), 300); near(b.rateAt(l, 20000), 20);
});

test('frozen live snapshots never estimate, including a frozen timestamp of zero', () => {
  const b = board(), l = lane(b, 'codex', rounds);
  for (const frozenAt of [0, 60000]) {
    b.B.clock.frozenAt = frozenAt;
    near(b.rateAt(l, 60000), 0); assert.equal(b.laneStats(l, 60000).est, false);
  }
  b.B.clock.frozenAt = null;
  near(b.rateAt(l, 60000), 500 / 30); assert.equal(b.laneStats(l, 60000).est, true);
});

test('costPartial flags only ended runs with unknown resolved costs', () => {
  const cases = [
    { extra: { status: 'done', ended_at: 20000, cost_usd: 3, cost_source: 'api_price' }, partial: false, cost: 5 },
    { extra: { status: 'done', ended_at: 20000, cost_usd: null }, partial: true, cost: 2 },
    { extra: { status: 'running', ended_at: null, cost_usd: null }, partial: false, cost: 2 },
  ];
  for (const { extra, partial, cost } of cases) {
    const b = board(), l = lane(b, 'paid', [], { status: 'done', ended_at: 10000, cost_usd: 2 });
    b.onRun({ id: 'extra', lane: l.id, model: 'model-a', started_at: 10000, ...extra });
    b.onRun({ id: 'free', lane: l.id, started_at: 0, ended_at: 10000, status: 'done', cost_usd: 0 });
    const s = b.laneStats(l, 30000);
    assert.equal(s.costPartial, partial); near(s.cost, cost);
    if (partial) {
      b.FINAL.set('extra', { cost_usd: 4 });
      assert.equal(b.laneStats(l, 30000).costPartial, false); near(b.laneStats(l, 30000).cost, 6);
    }
  }
});

test('replay segments refresh when a resumed run joins the lane later', () => {
  const b = board('replay'), l = lane(b, 'seat', [], { status: 'done', ended_at: 10000, usage: { input: 0, cached: 0, cache_write: 0, output: 100 } });
  b.FINAL_EV.set(l.id, [{ run: 'seat', ts: 0, k: 'turn' }, { run: 'seat', ts: 10000, k: 'usage', u: { out: 100 } },
    { run: 'seat-2', ts: 20000, k: 'turn' }, { run: 'seat-2', ts: 30000, k: 'usage', u: { out: 200 } }]);
  const cached = b.segments(l);
  b.onRun({ id: 'seat-2', lane: l.id, model: 'model-a', status: 'done', started_at: 20000, ended_at: 30000, parent: 'seat', usage: { input: 0, cached: 0, cache_write: 0, output: 200 } });
  assert.notEqual(b.segments(l), cached);
  near(b.rateAt(l, 30000), 20); near(b.laneStats(l, 30000).avg, 15);
});

test('Claude Code seat reports, which are never priced, do not mark the cost as partial', () => {
  const b = board(), l = lane(b, 'cc', [], { kind: 'host', status: 'done', ended_at: 10000, cost_usd: 1, cost_source: 'api_price' });
  b.onRun({ id: 'report', lane: l.id, kind: 'answer', started_at: 5000, ended_at: 6000, status: 'done', cost_usd: null, cost_source: 'unknown' });
  const s = b.laneStats(l, 20000);
  assert.equal(s.costPartial, false); near(s.cost, 1);
});

test('a Claude Code lane with usage but no price marks the cost as partial; without usage it does not', () => {
  for (const [usage, partial] of [[{ input: 10, cached: 0, cache_write: 0, output: 5 }, true], [null, false]]) {
    const b = board(), l = lane(b, 'cc', [], { kind: 'host', status: 'running', ended_at: null, usage, cost_usd: null, cost_source: 'unknown' });
    b.onRun({ id: 'seat', lane: 'seat', model: 'model-a', status: 'done', started_at: 0, ended_at: 1000, cost_usd: 2, cost_source: 'api_price' });
    assert.equal(b.laneStats(l, 2000).costPartial, partial);
  }
});

test('a Claude Code lane whose usage fields are all still empty does not mark the cost as partial', () => {
  const b = board(), l = lane(b, 'cc', [], { kind: 'host', status: 'running', ended_at: null, usage: { input: null, cached: null, cache_write: null, output: null }, cost_usd: null, cost_source: 'unknown' });
  assert.equal(b.laneStats(l, 2000).costPartial, false);
});
