import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../board/web/04-rates.js', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('../board/web/01-state.js', import.meta.url), 'utf8');
function board(mode = 'live') {
  const context = vm.createContext({ window: { __BOARD_FIXTURE__: true }, location: { search: '' }, URLSearchParams, wake: () => {} });
  vm.runInContext(`${stateSource}\n${source}\nglobalThis.rates = { B, onRun, onEv, onBacklog, segments, rateSample, liveRate, rateAt, sparkline, laneStats, FINAL, FINAL_EV, commandSpans, overlapsCommand };`, context);
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

test('turn totals defer to steps and reset per turn and run', () => {
  const b = board('replay'), l = lane(b, 'steps', [[0, 'turn'],
    [5000, 'usage', { u: { out: 40 } }], [10000, 'usage', { u: { out: 60 } }],
    [15000, 'usage', { u: { out: 130 }, tot: 1 }], [16000, 'turn'],
    [20000, 'usage', { u: { out: 50 } }], [25000, 'usage', { u: { out: 40 }, tot: 1 }],
    [26000, 'turn'], [30000, 'usage', { u: { out: 70 }, tot: 1 }]]);
  const segs = b.segments(l);
  near(segs.filter((s) => s.a >= 10000 && s.b <= 15000).reduce((sum, s) => sum + s.tokens, 0), 0);
  assert.ok(segs.every((s) => s.b !== 15000 && s.b !== 25000));
  near(total(b, l), 220);
  b.onRun({ id: 'resumed', lane: l.id, model: 'model-a', status: 'running', started_at: 31000 });
  b.onEv({ run: 'resumed', ts: 35000, k: 'usage', u: { out: 100 }, tot: 1 });
  near(total(b, l), 320);
});

test('resumed Codex cumulative totals do not add the parent output to this run', () => {
  const b = board(), l = lane(b, 'parent', [[0, 'turn'], [10000, 'usage', { u: { out: 400 }, tot: 1 }]],
    { status: 'done', ended_at: 10000, usage: { output: 400 } });
  b.onRun({ id: 'resumed', lane: l.id, model: 'model-a', status: 'done', started_at: 20000, ended_at: 31000, usage: { output: 100 } });
  for (const [ts, k, fields] of [[20000, 'turn'], [30000, 'usage', { u: { out: 100 } }], [31000, 'usage', { u: { out: 500 }, tot: 1 }]]) {
    b.onEv({ run: 'resumed', ts, k, ...fields });
  }
  near(total(b, l), 500);
  const sample = b.rateSample(l, l.runs, 40000);
  near(sample.tokens, 500); near(sample.ms, 20000);
});

test('legacy totals use the final output cap and refresh when final usage arrives', () => {
  for (const mode of ['live', 'replay']) {
    const b = board(mode), l = lane(b, 'resumed', [[0, 'turn'],
      [10000, 'usage', { u: { out: 900 }, tot: 1 }], [20000, 'usage', { u: { out: 1000 }, tot: 1 }]]);
    near(total(b, l), 1000);
    const cached = b.segments(l), final = { ended_at: 20000, usage: { output: 100 } };
    if (mode === 'replay') b.FINAL.set(l.id, final);
    else b.onRun({ ...b.B.runs.get(l.id), status: 'done', ...final });
    near(total(b, l), 100); assert.notEqual(b.segments(l), cached);
  }
});

test('a step arriving after a total replaces it without creating a millisecond sample', () => {
  const b = board(), l = lane(b, 'late', [[0, 'turn'], [10000, 'usage', { u: { out: 900 }, tot: 1 }]]);
  near(total(b, l), 900);
  const cached = b.segments(l);
  b.onEv({ run: l.id, ts: 10001, k: 'usage', u: { out: 100 } });
  near(total(b, l), 100); assert.notEqual(b.segments(l), cached);
  const sample = b.rateSample(l, l.runs, 20000);
  near(sample.tokens, 100); near(sample.ms, 10001);
});

test('same-time and earlier usage merges into the preceding generation spans', () => {
  for (const ts of [10000, 9000]) {
    const b = board('replay'), l = lane(b, 'steps', []);
    b.FINAL_EV.set(l.id, [[0, 'turn'], [1000, 'cmd'], [4000, 'cmd_done'],
      [10000, 'usage', { u: { out: 70 } }], [ts, 'usage', { u: { out: 30 } }]]
      .map(([ts, k, fields]) => ({ run: l.id, ts, k, ...fields })));
    near(total(b, l), 100);
    const sample = b.rateSample(l, l.runs, 10000);
    near(sample.tokens, 100); near(sample.ms, 7000);
    assert.ok(b.segments(l).every((s) => s.b <= 1000 || s.a >= 4000));
  }
  const b = board(), l = lane(b, 'empty', [[0, 'turn'],
    [10000, 'usage', { u: { out: 0 } }], [10000, 'usage', { u: { out: 100 } }]]);
  near(total(b, l), 100); near(b.rateSample(l, l.runs, 10000).ms, 10000);
});

test('end and total markers keep live estimates stopped even after late steps', () => {
  for (const marker of ['end', 'tot']) {
    const b = board(), l = lane(b, marker, [[0, 'turn'], [10000, 'usage', { u: { out: 100 } }],
      [15000, 'usage', { u: { out: 100 }, [marker]: 1 }], [16000, 'usage', { u: { out: 20 } }]]);
    assert.ok(b.rateSample(l, l.runs, 30000).tokens > 0);
    near(b.liveRate(l, 30000), 0);
    b.onEv({ run: l.id, ts: 31000, k: 'turn' });
    assert.ok(b.liveRate(l, 50000) > 0);
  }
});

test('live gaps resume after each step without overlapping usage, characters or commands', () => {
  const b = board(), l = lane(b, 'steps', [[0, 'turn'], [1000, 'think', { n: 40 }],
    [10000, 'usage', { u: { out: 100 } }]]);
  near(b.rateAt(l, 15000), 10); assert.equal(b.laneStats(l, 15000).est, true);
  near(total(b, l), 100); near(b.laneStats(l, 15000).output, 100);
  b.onEv({ run: l.id, ts: 20000, k: 'usage', u: { out: 200 } });
  near(b.rateAt(l, 15000), 15);
  near(b.rateAt(l, 20000), 20);
  near(b.rateAt(l, 25000), 17.5); near(total(b, l), 300);
  b.onEv({ run: l.id, ts: 26000, k: 'cmd' });
  near(b.rateAt(l, 40000), 0); assert.equal(b.laneStats(l, 40000).est, false);
  b.onEv({ run: l.id, ts: 40000, k: 'cmd_done' });
  near(b.rateAt(l, 50000), 15);
  b.onEv({ run: l.id, ts: 51000, k: 'think', n: 0 });
  near(b.rateAt(l, 52000), 0); assert.equal(b.laneStats(l, 52000).est, false);
  const api = lane(b, 'api-gap', [[10000, 'usage', { u: { out: 100 } }]]);
  near(b.rateAt(api, 30000), 0);
  const cc = lane(b, 'cc', [[0, 'turn'], [10000, 'usage', { u: { out: 100 } }]]);
  near(b.rateAt(cc, 30000), 0);
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
    // 一轮结束看的是整轮总量（tot）；普通的分段用量之后模型还在生成，照样估
    { rows: rounds.slice(0, -1).map(([ts, k, f]) => (k === 'usage' ? [ts, k, { ...f, tot: 1 }] : [ts, k, f])) },
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

// 推理模型一次请求里可以几分钟不出事件：2 分钟的空档整段算生成时间，超过 5 分钟的才截到 5 分钟（当成中间有空闲）
test('gaps without commands count in full up to five minutes and keep the public segment fields', () => {
  const b = board(), l = lane(b, 'old', [[10000, 'think', { t: 'thinking' }],
    [130000, 'usage', { u: { out: 700 } }]],
  { status: 'done', ended_at: 130000, usage: { output: 700 } });
  const segs = Array.from(b.segments(l), (s) => ({ ...s }));
  assert.deepEqual(segs.map(({ a, b: end, est }) => ({ a, b: end, est })), [{ a: 0, b: 10000, est: false }, { a: 10000, b: 130000, est: false }]);
  near(segs[0].tokens, 700 * 10 / 130); near(segs[1].tokens, 700 * 120 / 130);
  near(b.rateAt(l, 130000), 700 / 130); near(b.laneStats(l, 130000).avg, 700 / 130);
  const c = board(), long = lane(c, 'long', [[10000, 'think', { t: 'thinking' }], [410000, 'usage', { u: { out: 700 } }]],
    { status: 'done', ended_at: 410000, usage: { output: 700 } });
  assert.deepEqual(Array.from(c.segments(long), (s) => [s.a, s.b]), [[0, 10000], [110000, 410000]]);
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
  near(after.rate, 10.9); near(after.output, 699); near(after.avg, 699 / 600);
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

test('costPartial flags runs whose cost is not in yet: still running, or ended unpriced unless usage is all zero', () => {
  const cases = [
    { extra: { status: 'done', ended_at: 20000, cost_usd: 3, cost_source: 'api_price' }, partial: false, cost: 5 },
    { extra: { status: 'done', ended_at: 20000, cost_usd: null }, partial: true, cost: 2 },
    // 和宇宙视图同一条规则：还在跑的任务费用还没算进来
    { extra: { status: 'running', ended_at: null, cost_usd: null }, partial: true, cost: 2 },
    // 一次请求都没完成（用量全是 0）：没有可算的费用
    { extra: { status: 'failed', ended_at: 20000, cost_usd: null, usage: { input: 0, cached: 0, cache_write: null, output: 0 } }, partial: false, cost: 2 },
    // 用量没报（字段是 null）：费用确实不知道
    { extra: { status: 'done', ended_at: 20000, cost_usd: null, usage: { input: null, cached: null, cache_write: null, output: null } }, partial: true, cost: 2 },
  ];
  for (const { extra, partial, cost } of cases) {
    const b = board(), l = lane(b, 'paid', [], { status: 'done', ended_at: 10000, cost_usd: 2 });
    b.onRun({ id: 'extra', lane: l.id, model: 'model-a', started_at: 10000, ...extra });
    b.onRun({ id: 'free', lane: l.id, started_at: 0, ended_at: 10000, status: 'done', cost_usd: 0 });
    const s = b.laneStats(l, 30000);
    assert.equal(s.costPartial, partial); near(s.cost, cost);
    if (partial && extra.ended_at != null) {
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

// 服务端从头重读了某个任务的记录：backlog 带 reset 时，先清掉这个任务以前的事件，别的任务不动
test('a reset backlog drops the run old events before adding the new ones', () => {
  const context = vm.createContext({ window: { __BOARD_FIXTURE__: true }, location: { search: '' }, URLSearchParams, wake: () => {} });
  vm.runInContext(`${stateSource}\nglobalThis.state = { B, onRun, onEv, onBacklog };`, context);
  const { B, onRun, onEv, onBacklog } = context.state;
  onRun({ id: 'a', lane: 'a', started_at: 0 }); onRun({ id: 'b', lane: 'b', started_at: 0 });
  for (const [run, ts, t] of [['a', 1, 'old-1'], ['a', 2, 'old-2'], ['b', 3, 'other']]) onEv({ run, ts, k: 'msg', t });
  onBacklog({ run: 'a', reset: true, events: [{ run: 'a', ts: 5, k: 'msg', t: 'new' }] });
  const texts = (list) => Array.from(list, (e) => e.t); // VM 里的数组和这里不是同一个 realm
  assert.deepEqual(texts(B.laneById.get('a').events), ['new']);
  assert.deepEqual(texts(B.laneById.get('b').events), ['other']);
  assert.equal(B.total, 4); // 收到的事件总数，含被清掉的
  onBacklog({ run: 'b', events: [{ run: 'b', ts: 6, k: 'msg', t: 'more' }] }); // 没有 reset：只是补上
  assert.deepEqual(texts(B.laneById.get('b').events), ['other', 'more']);
});

test('速度曲线画这条车道的全部时长，结束以后停住不再往前走', () => {
  const b = board(), l = lane(b, 'seat', [[0, 'turn'], [40000, 'usage', { u: { out: 400 } }]], { status: 'done', ended_at: 40000 });
  const ended = Array.from(b.sparkline(l, 50000, 4));
  // 4 个点落在 10、20、30、40 秒（开始到结束四等分），每点取前 20 秒的平均：400 个 token 均匀分在 40 秒里
  assert.equal(ended.length, 4);
  near(ended.at(-1), 10); near(ended[1], 10); assert.ok(ended[0] > 0);
  // 结束很久以后再看，曲线一样
  assert.deepEqual(Array.from(b.sparkline(l, 500000, 4)), ended);
  // 还没开始的车道是一条平线
  const idle = board(), later = lane(idle, 'later', [], { started_at: 60000 });
  assert.deepEqual(Array.from(idle.sparkline(later, 30000, 3)), [0, 0, 0]);
});

test('the curve starts where rate data starts, not at a lane start long before it (earlier transcripts have no rate data)', () => {
  const b = board(), l = lane(b, 'cc', [[100000, 'turn'], [140000, 'usage', { u: { out: 400 } }]], { started_at: 0, status: 'done', ended_at: 140000 });
  const points = Array.from(b.sparkline(l, 150000, 4));
  // 从 0 画起的话前两个点（35、70 秒）是 0；现在四个点都落在有数据的 100–140 秒里
  assert.ok(points.every((v) => v > 0), points.join(','));
});

test('命令时段的重叠判断用二分查找，和逐个比较的结果一致', () => {
  const b = board();
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 50; round++) {
    // 随机的命令开始、结束（含嵌套和没结束的），交给 commandSpans 并成互不重叠的时段
    const events = [];
    for (let t = 0, open = 0; t < 2000; t += 1 + rand(20)) {
      if (open && rand(2)) { events.push({ run: 'r', ts: t, k: 'cmd_done' }); open--; } else { events.push({ run: 'r', ts: t, k: 'cmd' }); open++; }
    }
    const spans = b.commandSpans(events).get('r') || [];
    for (let i = 0; i < 40; i++) {
      const from = rand(2100), to = from + 1 + rand(200);
      assert.equal(b.overlapsCommand(spans, from, to), spans.some((c) => c.a < to && c.b > from), `${from}-${to}`);
    }
  }
});

test('结束车道的曲线缓存跟着速度分段走：补发重置换掉等长的统计历史后，曲线随之更新', () => {
  const b = board(), l = lane(b, 'seat', [[0, 'turn'], [10000, 'usage', { u: { out: 100 } }]], { status: 'done', ended_at: 10000 });
  const before = Array.from(b.sparkline(l, 20000, 4));
  // 同样条数的历史整份换掉：用量提前到 5000
  b.onBacklog({ run: 'seat', reset: true, events: [{ run: 'seat', ts: 0, k: 'turn' }, { run: 'seat', ts: 5000, k: 'usage', u: { out: 100 } }],
    rate_events: [{ run: 'seat', ts: 0, k: 'turn' }, { run: 'seat', ts: 5000, k: 'usage', u: { out: 100 } }] });
  const after = Array.from(b.sparkline(l, 20000, 4));
  assert.notDeepEqual(after, before);
  // 和不经缓存、从头算的一样
  const fresh = board(), l2 = lane(fresh, 'seat', [[0, 'turn'], [5000, 'usage', { u: { out: 100 } }]], { status: 'done', ended_at: 10000 });
  assert.deepEqual(after, Array.from(fresh.sparkline(l2, 20000, 4)));
});

test('估速起点的缓存看车道的事件版本：统计历史满了以后中间插进迟到的回合，估速照样更新', () => {
  const b = board(), l = lane(b, 'seat', [], { status: 'running', ended_at: null });
  b.onEv({ run: 'seat', ts: 0, k: 'turn' }); b.onEv({ run: 'seat', ts: 10000, k: 'usage', u: { out: 100 } }); b.onEv({ run: 'seat', ts: 11000, k: 'turn' });
  // 填满 20000 条（用不影响估速的事件），再插一条迟到的回合到中间
  for (let i = 0; l.rate_events.length < 20000; i++) b.onEv({ run: 'seat', ts: 12000 + i, k: 'think' });
  const first = b.liveRate(l, 40000);
  b.onEv({ run: 'seat', ts: 31000, k: 'turn' });
  assert.equal(l.rate_events.length, 20000);
  const again = b.liveRate(l, 40000), fresh = board(), copy = lane(fresh, 'seat', [], { status: 'running', ended_at: null });
  copy.rate_events = [...l.rate_events]; copy.ver = 1;
  assert.notEqual(again, first);
  assert.equal(again, fresh.liveRate(copy, 40000));
});
