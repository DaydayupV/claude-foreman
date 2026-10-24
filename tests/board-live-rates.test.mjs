import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createFeed } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { createUniverse } from '../foreman/skills/dispatch/scripts/board/universe.mjs';
import * as Display from '../foreman/skills/dispatch/scripts/display.mjs';

const source = ['00-text', '01-state', '03-timeline', '04-rates', '06-cards', '07-table'].map((name) =>
  fs.readFileSync(new URL(`../board/web/${name}.js`, import.meta.url), 'utf8')).join('\n');
class Element {
  children = []; dataset = {}; style = { setProperty() {} }; classList = { toggle() {} }; nodes = new Map();
  get firstChild() { return this.children[0]; }
  get textContent() { return this.text || this.children.map((c) => c.textContent).join(''); }
  set textContent(value) { this.text = value; this.children = []; }
  set innerHTML(value) {
    this.text = ''; this.children = [];
    if (value.startsWith('<div class="tr th"')) this.children = [new Element(), new Element(), new Element()];
    if (value.startsWith('<span class="av"')) this.children = Array.from({ length: 10 }, () => new Element());
  }
  append(...items) { this.children.push(...items.map((x) => typeof x === 'string' ? Object.assign(new Element(), { text: x }) : x)); }
  insertBefore(item, before) { this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, item); }
  querySelector(key) {
    if (key === '.tbody') return this.children[1];
    if (key === '.total') return this.children[2];
    if (!this.nodes.has(key)) this.nodes.set(key, new Element());
    return this.nodes.get(key);
  }
  addEventListener() {}
}
function board(lang = 'zh') {
  const table = new Element(), card = new Element();
  let api;
  const context = vm.createContext({ Display, window: { __BOARD_FIXTURE__: true, __LANG__: lang }, location: { search: '' },
    URLSearchParams, performance: { now: () => 0 }, wake() {}, worldEl: { dataset: { lod: 0 } },
    document: { createElement: () => new Element(), documentElement: {}, querySelector: () => null },
    latest: (l) => l.runs.at(-1), avatarFor: () => 'model', rgba: () => '', avatarSrc: () => '', look: () => ({ name: 'model' }),
    laneStatus: () => ({ running: false, word: 'done' }), shortModel: (m) => m, verdictCounts: () => null,
    setText: (e, text) => { e.textContent = text; }, thinkingLine: () => '', decorateCard() {},
    $: () => table, UI: { tableRows: new Map() }, seatLanes: () => api.B.lanes.filter((l) => l.id !== 'cc'),
    termUnits: () => api.B.lanes.filter((l) => l.id !== 'cc').map((lane) => ({ id: lane.id, lane })), unitLanes: (u) => [u.lane], unitEnd: () => 0, dispatchQueue: () => [] });
  vm.runInContext(`${source}\nglobalThis.api = { B, TEXT, onRun, onEv, onHello, onBacklog, loadSnapshot, segments, laneStats, fillCard, renderTable };`, context);
  api = context.api;
  return Object.assign(api, { table, card });
}
const run = (fields = {}) => ({ id: 'seat', model: 'model', kind: 'exec', status: 'running', started_at: 0, ended_at: null, ...fields });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('missing final step covers the last generation interval and average stays stable across completion', () => {
  const b = board(); b.onRun(run());
  b.onEv({ run: 'seat', ts: 10000, k: 'usage', u: { out: 100 } });
  const lane = b.B.lanes[0]; near(b.laneStats(lane, 20000).avg, 10);
  b.onEv({ run: 'seat', ts: 35000, k: 'usage', end: 1, u: { out: 200 }, usage_from: 10000, usage_to: 30000 });
  near(b.laneStats(lane, 35000).avg, 10);
  b.onRun(run({ status: 'done', ended_at: 36000, usage: { output: 300 } }));
  near(b.segments(lane).reduce((n, s) => n + s.tokens, 0), 300);
  near(b.laneStats(lane, 36000).avg, 10);
  assert.ok(b.segments(lane).every((s) => s.b <= 30000));
  const single = board(); single.onRun(run());
  single.onEv({ run: 'seat', ts: 20000, k: 'usage', end: 1, u: { out: 100 }, usage_from: 5000, usage_to: 15000 });
  near(single.laneStats(single.B.lanes[0], 20000).avg, 10);
});

test('1200 seconds at 10 tok/s survive display truncation, refresh, reconnect and backlog replacement', () => {
  const b = board(), events = [{ run: 'seat', ts: 0, k: 'turn' }, ...Array.from({ length: 1200 }, (_, i) =>
    ({ run: 'seat', ts: (i + 1) * 1000, k: 'usage', u: { out: 10 } }))];
  b.onRun(run()); events.forEach(b.onEv);
  const lane = b.B.lanes[0];
  assert.equal(lane.events.length, 600); assert.equal(lane.rate_events.length, 1201);
  near(b.laneStats(lane, 1200000).output, 12000); near(b.laneStats(lane, 1200000).avg, 10);
  const final = run({ status: 'done', ended_at: 1200000, usage: { output: 12000 } }); b.onRun(final);
  near(b.laneStats(lane, 1200000).avg, 10);
  const snapshot = { hello: { mode: 'live', now: 1200000 }, runs: [final], events };
  const fresh = board(); fresh.loadSnapshot(snapshot);
  near(fresh.laneStats(fresh.B.lanes[0], 1200000).avg, 10);
  b.onHello(snapshot.hello); b.onRun(final); b.onBacklog({ run: 'seat', events });
  near(b.laneStats(b.B.lanes[0], 1200000).output, 12000); near(b.laneStats(b.B.lanes[0], 1200000).avg, 10);
  b.onBacklog({ run: 'seat', reset: true, events: [{ run: 'seat', ts: 10000, k: 'usage', u: { out: 100 } }] });
  assert.equal(b.B.lanes[0].rate_events.length, 1);
  assert.equal(b.laneStats(b.B.lanes[0], 1200000).avg, null);
});

test('live averages require complete final-output coverage and keep closed runs out of resumed live output', () => {
  const b = board(); b.onRun(run({ status: 'done', ended_at: 10000, usage: { output: 100 } }));
  b.onEv({ run: 'seat', ts: 10000, k: 'usage', u: { out: 60 } });
  assert.equal(b.laneStats(b.B.lanes[0], 10000).avg, null);
  b.onRun(run({ status: 'done', ended_at: 10000, usage: null }));
  assert.equal(b.laneStats(b.B.lanes[0], 10000).avg, null);
  b.onRun(run({ status: 'done', ended_at: 10000, usage: { output: 100 } }));
  b.onEv({ run: 'seat', ts: 10000, k: 'usage', u: { out: 40 } });
  b.onRun(run({ id: 'next', lane: 'seat', started_at: 20000 }));
  b.onEv({ run: 'next', lane: 'seat', ts: 30000, k: 'usage', u: { out: 60 } });
  near(b.laneStats(b.B.lanes[0], 30000).output, 160); near(b.laneStats(b.B.lanes[0], 30000).avg, 8);
});

test('segment rebuilding scans per-run intervals instead of rescanning all events for each usage', () => {
  const b = board(); b.onRun(run()); b.onRun(run({ id: 'other', lane: 'seat' }));
  for (let i = 1; i <= 500; i++) b.onEv({ run: 'seat', ts: i * 1000, k: 'usage', u: { out: 10 } });
  for (let i = 1; i <= 4500; i++) b.onEv({ run: 'other', lane: 'seat', ts: i * 100, k: 'msg' });
  const lane = b.B.lanes[0]; let reads = 0;
  for (const ev of lane.rate_events) {
    const id = ev.run; Object.defineProperty(ev, 'run', { get() { reads++; return id; } });
  }
  near(b.segments(lane).reduce((n, s) => n + s.tokens, 0), 5000);
  assert.ok(reads < lane.rate_events.length * 20, `run reads: ${reads}`);
});

test('many large-output segments use relative coverage tolerance without accepting missing output', () => {
  const b = board(), output = 1e12; b.onRun(run({ status: 'done', ended_at: 4001000, usage: { output } }));
  for (let i = 1; i <= 4000; i++) b.onEv({ run: 'seat', ts: i * 1000, k: 'think' });
  b.onEv({ run: 'seat', ts: 4001000, k: 'usage', u: { out: output } });
  const lane = b.B.lanes[0], counted = b.segments(lane).reduce((n, s) => n + s.tokens, 0);
  assert.ok(Math.abs(output - counted) > 1e-6); near(b.laneStats(lane, 4001000).avg, output / 4001);
  b.onRun(run({ status: 'done', ended_at: 4001000, usage: { output: output * 1.01 } }));
  assert.equal(b.laneStats(lane, 4001000).avg, null);
});

test('feed and universe resolve 100 → session total 160, including a late parent baseline', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-live-rates-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const runs = path.join(root, 'runs'), claudeDir = path.join(root, 'claude'), config = path.join(root, 'config.json');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const base = Date.parse('2026-10-24T00:00:00Z'), now = base + 50000, prices = { models: [{ match: ['model'], input: 1, output: 1 }] };
  const transcript = path.join(claudeDir, 'project', 's.jsonl');
  write(config, {}); write(transcript, { type: 'user', timestamp: new Date(base).toISOString(), cwd: root, message: { content: 'synthetic' } });
  fs.appendFileSync(transcript, '\n');
  for (const [id, parent, dt] of [['first', null, 0], ['next', 'first', 20000]]) {
    write(path.join(runs, id, 'meta.json'), { id, parent, claude_session: 's', session_id: 'chain', model: 'model', agent_type: 'codex cli',
      mode: parent ? 'resume' : 'exec', status: 'done', started_at: base + dt, ended_at: base + dt + 10000 });
  }
  const result = (n, usage_scope) => ({ usage_scope, usage: { input_tokens: n, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: n } });
  write(path.join(runs, 'next', 'result.json'), result(160, 'session_total'));
  const feed = createFeed(runs, { transcript, prices }), universe = createUniverse({ runs, claudeDir, config, prices });
  const before = feed.read({ session: 's' }, now), b = board(); before.runs.forEach(b.onRun);
  const missing = before.runs.find((r) => r.id === 'next');
  assert.equal(missing.usage, null); assert.equal(missing.usage_unattributed, true); assert.equal(missing.usage_scope, 'session_total');
  assert.equal(b.laneStats(b.B.laneById.get('first'), now).output, null);
  assert.equal(universe.read(now).sessions[0].cost_usd, null);
  write(path.join(runs, 'first', 'result.json'), result(100, 'this_run'));
  const after = feed.read({ session: 's' }, now + 1000); after.runs.forEach(b.onRun);
  assert.equal(after.runs.find((r) => r.id === 'next').usage.output, 60);
  assert.equal(after.runs.find((r) => r.id === 'next').usage_scope, 'this_run');
  near(b.laneStats(b.B.laneById.get('first'), now + 1000).output, 160);
  near(universe.read(now + 1000).sessions[0].cost_usd, 0.00032);
  assert.equal(missing.usage_unattributed, true);
});

for (const lang of ['zh', 'en']) test(`${lang} cards, headers and tooltips show generation averages and unattributed output`, () => {
  const b = board(lang); b.onRun(run({ status: 'done', ended_at: 10000, usage: { input: 80, cached: 20, cache_write: 0, output: 100 } }));
  b.onEv({ run: 'seat', ts: 10000, k: 'usage', u: { out: 100 } });
  b.fillCard(b.card, b.B.lanes[0], 10000); b.renderTable(10000);
  assert.equal(b.card.querySelector('.rate').textContent, 'now ≈ 10 tok/s · gen avg ≈ 10 · out 100');
  assert.equal(b.table.children[1].children[0].children[6].textContent, '100 · 20%');
  assert.deepEqual(b.table.firstChild.children.slice(3, 6).map((c) => c.textContent), ['now ≈tok/s', 'tok/s over time', 'gen avg ≈tok/s']);
  const titles = lang === 'zh' ? ['近 10 秒的估算，可能借用同一模型之前的样本',
    '这条车道全部时长的速度曲线（估算）：从第一轮开始画到最后一轮结束，结束后停住；40 个点，每个点是它之前约两格时长内的输出 token 除以这段时间；运行中可能借用实时估速',
    '本席各轮累计输出 ÷ 估算的生成时长；已扣掉能识别的跑命令时段，仍可能含等待和读文件的时间'] :
    ['Estimate over the last 10 seconds; may borrow earlier samples of the same model',
      "Speed over this lane's whole time (estimated): drawn from its first round's start to its last round's end, then it stays put; 40 points, each the output tokens in about two points' worth of time before it divided by that time; while running it may use the live estimate",
      "This seat's total output ÷ estimated generation time; command time that can be recognised is excluded, waiting and file reads may remain"];
  assert.deepEqual(b.table.firstChild.children.slice(3, 6).map((c) => c.title), titles);
  b.onRun(run({ id: 'missing', lane: 'seat', status: 'done', ended_at: 10000, usage: null, usage_unattributed: true }));
  b.fillCard(b.card, b.B.lanes[0], 10000); b.renderTable(10000);
  assert.match(b.card.querySelector('.rate').textContent, /gen avg ≈ — · out —$/);
  assert.equal(b.card.querySelector('.rate').title, b.TEXT.usageUnattributed);
  assert.equal(b.table.children[1].children[0].children[7].textContent, '—');
  assert.equal(b.table.children[1].children[0].children[7].title, b.TEXT.usageUnattributed);
  assert.equal(b.table.children[2].children[7].textContent, '—');
  assert.equal(b.table.children[1].children[0].children[6].textContent, '—');
  assert.equal(b.table.children[1].children[0].children[6].title, b.TEXT.usageUnattributed);
  assert.equal(b.table.children[2].children[6].textContent, '—');
  assert.equal(b.table.children[2].children[6].title, b.TEXT.usageUnattributed);
});
