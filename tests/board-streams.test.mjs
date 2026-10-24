import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = ['00-text', '01-state', '01-universe', '08-uni-fly', '09-main'].map((name) =>
  fs.readFileSync(new URL(`../board/web/${name}.js`, import.meta.url), 'utf8')).join('\n');
const hello = { mode: 'live', now: 1000, replay: null };
const session = { id: 'conversation', project: 'project', title: 'test', state: 'idle', runs: [] };
const universe = { projects: [{ key: 'project', name: 'test' }], sessions: [session], agents: [] };

// health：卡住提示后再问服务时的结果（refused 是服务已经退出，timeout 是连接被占满）；不给时页面里没有 AbortSignal.timeout，不去问
function board({ search = '', replay = false, lang = 'zh', visibility = 'visible', health, shared = false } = {}) {
  let time = 0, timerId = 0, peak = 0, demoStarts = 0, api, channel = null;
  const timers = new Map(), intervals = new Map(), streams = [], workers = [], notices = [], requests = [], listeners = new Map(), elements = new Map();
  const active = () => streams.filter((es) => es.readyState !== 2);
  class EventSource {
    readyState = 0; listeners = new Map();
    constructor(url) { this.url = url; streams.push(this); peak = Math.max(peak, active().length); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    emit(type, data) {
      if (type === 'open') this.readyState = 1;
      if (type === 'error') this.readyState = 0;
      const event = { data: JSON.stringify(data) };
      for (const fn of this.listeners.get(type) || []) fn(event);
      this[`on${type}`]?.(event);
    }
    close() { this.readyState = 2; }
  }
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, style: {}, addEventListener() {}, replaceChildren() {}, remove() {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      set textContent(value) { if (id === 'notice') notices.push(value); } });
    return elements.get(id);
  };
  const document = { visibilityState: visibility, documentElement: {}, querySelector: () => null,
    addEventListener: (type, fn) => listeners.set(type, fn) };
  const camera = () => ({ k: 1, tx: 0, ty: 0, auto: true });
  const context = vm.createContext({ window: { __LANG__: lang, __BOARD_MODE__: replay ? 'replay' : 'live' },
    location: new URL(`http://localhost/board/${search}`), history: { replaceState() {} }, URL, URLSearchParams, EventSource, document,
    crypto: webcrypto, navigator: {},
    ...(shared ? { SharedWorker: class {
      constructor() {
        this.port = { sent: [], postMessage(message) { this.sent.push(message); }, start() {}, close() {} };
        workers.push(this);
      }
    } } : {}),
    performance: { now: () => time, getEntriesByType: () => [] }, addEventListener() {}, requestAnimationFrame: () => 1,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    // 后台让出连接后每分钟报到一次：测试里只记下有没有在报到
    setInterval: (fn, ms) => { const id = ++timerId; intervals.set(id, { fn, ms }); return id; }, clearInterval: (id) => intervals.delete(id),
    BroadcastChannel: class { constructor() { channel = this; this.sent = []; } postMessage(m) { this.sent.push(m); } },
    fetch: async (url) => {
      requests.push(url);
      if (url === 'health' && health) throw health === 'refused' ? new TypeError('Failed to fetch') : Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return { json: async () => url.startsWith('sessions?') ? universe : { hello, runs: [], events: [] } };
    },
    ...(health ? { AbortSignal: class { static timeout() { return {}; } } } : {}),
    playDemo: () => { demoStarts++; }, $: el, worldEl: el('world'),
    UI: { cards: new Map(), outs: new Map(), heads: new Map(), tableRows: new Map(), open: new Set(), collapsed: new Set() },
    PANEL: { cols: new Map(), fold: new Map(), doneLines: new Map() }, UNI_ROWS: new Map(), REEL: { born: new Map() }, SMOOTH: { vals: new Map() },
    FINAL: new Map(), FINAL_EV: new Map(), SURGE: new Map(), loadFinals() {},
    FX: { layout: null }, UV: camera(), VIEW: camera(),
    viewEl: { getBoundingClientRect: () => ({ width: 1000, height: 800 }) },
    uniLayout: () => ({ galaxies: [...api.U.sessions.values()].map((s) => ({ s, x: 10, y: 20 })) }),
    computeLayout: () => ({ H: 1000, core: { cx: 100, cy: 100 } }), fitGoal: camera, uniFitGoal: camera,
    clamp01: (v) => Math.max(0, Math.min(1, v)), ease: (v) => v,
  });
  vm.runInContext(`${source}\nglobalThis.api = { B, U, FLY, UI, TEXT, connect, disconnect, connectUniverse, disconnectUniverse, flyIn, flyOut, stepFly, uHello, uUniverse };`, context);
  api = context.api;
  return { ...api, streams, workers, active, notices, requests, el, intervals, get channel() { return channel; }, get peak() { return peak; }, get demoStarts() { return demoStarts; },
    seed() {
      api.uHello(replay ? { ...hello, mode: 'replay', replay: { start: 1000, end: 1000000, speed: 2 } } : hello);
      api.uUniverse(universe);
    },
    visibility(value) { document.visibilityState = value; listeners.get('visibilitychange')(); },
    advance(ms) {
      const end = time + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due; timers.delete(id); time = timer.at; timer.fn();
      }
      time = end;
    },
  };
}
const isUniverse = (es) => new URLSearchParams(es.url.split('?')[1]).get('level') === 'all';

test('直播从飞入开始只留看板流，飞出开始就只留宇宙流，沿用缓存画动画', () => {
  const b = board(); b.seed();
  const first = b.U.es; first.emit('open'); first.emit('error');
  assert.equal(b.U.lostAt, 0);
  assert.equal(b.flyIn(session.id), true);
  assert.equal(b.FLY.mode, 'in'); assert.deepEqual(b.active(), [b.B.es]);
  assert.equal(first.readyState, 2); assert.equal(b.U.lostAt, null); assert.equal(b.U.error, null);
  b.B.es.emit('open');
  b.advance(21000); b.stepFly();
  assert.equal(b.FLY.mode, 'board'); assert.equal(b.U.lostAt, null); assert.deepEqual(b.notices, []);
  const detail = b.B.es;
  b.flyOut();
  assert.equal(b.FLY.mode, 'out'); assert.equal(detail.readyState, 2);
  assert.deepEqual(b.active(), [b.U.es]); assert.notEqual(b.U.es, first);
  assert.equal(b.U.sessions.get(session.id).title, session.title);
  b.U.es.emit('open'); b.U.es.emit('hello', hello); b.U.es.emit('universe', universe);
  const restored = b.U.es;
  b.advance(1400); b.stepFly();
  assert.equal(b.FLY.mode, 'universe'); assert.deepEqual(b.active(), [restored]); assert.equal(b.peak, 1);
});

test('飞入中途退回也立即切回一条宇宙流', () => {
  const b = board(); b.seed(); b.flyIn(session.id); b.advance(400); b.flyOut();
  assert.deepEqual(b.active(), [b.U.es]); assert.equal(b.peak, 1);
  b.advance(1400); b.stepFly(); assert.equal(b.FLY.mode, 'universe'); assert.equal(b.active().length, 1);
});

test('回放飞入保留两条流，后台不关闭、不重置共用时钟', () => {
  const b = board({ search: '?replay=all&speed=2', replay: true }); b.seed();
  const first = b.U.es, perf0 = b.U.clock.perf0;
  b.flyIn(session.id);
  const detail = b.B.es; first.emit('open'); detail.emit('open');
  assert.deepEqual(b.active(), [first, detail]); assert.equal(b.B.params.replay, 'all');
  b.visibility('hidden'); b.advance(601000); b.visibility('visible');
  assert.deepEqual(b.active(), [first, detail]); assert.equal(b.streams.length, 2); assert.equal(b.U.clock.perf0, perf0);
  b.stepFly(); b.flyOut(); assert.deepEqual(b.active(), [first, detail]);
  b.advance(1400); b.stepFly(); assert.deepEqual(b.active(), [first]);
});

for (const mode of ['universe', 'in', 'board', 'out']) test(`后台释放和恢复按 ${mode} 模式选一条流，10 分钟内回来不重连`, () => {
  const b = board(); b.seed();
  if (mode !== 'universe') b.flyIn(session.id, mode !== 'in');
  if (mode === 'out') b.flyOut();
  const first = b.active()[0]; first.emit('open');
  const count = b.streams.length;
  b.visibility('hidden'); b.advance(599000); b.visibility('visible'); b.advance(2000);
  assert.deepEqual(b.active(), [first]); assert.equal(b.streams.length, count);
  b.visibility('hidden'); b.advance(601000);
  assert.equal(b.active().length, 0); assert.equal(first.readyState, 2); assert.equal(b.U.lostAt, null);
  b.connect(); b.connectUniverse(); assert.equal(b.active().length, 0);
  b.visibility('visible');
  assert.equal(b.active().length, 1); assert.equal(b.streams.length, count + 1);
  assert.equal(isUniverse(b.active()[0]), mode === 'universe' || mode === 'out');
  b.visibility('visible'); assert.equal(b.streams.length, count + 1); assert.equal(b.peak, 1);
});

test('初始在后台打开的页面也会让出连接', () => {
  const b = board({ visibility: 'hidden' });
  b.advance(601000); assert.equal(b.active().length, 0);
  b.visibility('visible'); assert.deepEqual(b.active(), [b.U.es]); assert.equal(b.peak, 1);
});

test('看板后台重连沿用对话参数，hello 后重发 run/backlog 不重复车道和事件', () => {
  const b = board(); b.seed(); b.flyIn(session.id, true);
  const params = b.B.params, url = b.B.es.url;
  const fill = (es) => {
    es.emit('open'); es.emit('hello', hello);
    for (const id of ['first', 'next']) {
      es.emit('run', { id, lane: 'seat', session: session.id, started_at: 1000 });
      es.emit('backlog', { run: id, events: [{ run: id, ts: 2000, k: 'usage', u: { out: 10 } }],
        rate_events: [{ run: id, ts: 2000, k: 'usage', u: { out: 10 } }] });
    }
  };
  fill(b.B.es); b.UI.open.add('seat');
  b.visibility('hidden'); b.advance(601000);
  assert.equal(b.B.lanes.length, 1); assert.equal(b.B.feed.length, 2);
  b.visibility('visible');
  assert.equal(b.B.params, params); assert.equal(b.B.es.url, url); assert.equal(b.FLY.id, session.id);
  fill(b.B.es);
  assert.equal(b.B.runs.size, 2); assert.equal(b.B.lanes.length, 1); assert.equal(b.B.laneById.size, 1);
  assert.equal(b.B.lanes[0].runs.length, 2); assert.equal(b.B.lanes[0].events.length, 2);
  assert.equal(b.B.lanes[0].rate_events.length, 2); assert.equal(b.B.feed.length, 2); assert.equal(b.B.total, 2);
  assert.equal(b.UI.open.has('seat'), true); assert.equal(b.FLY.mode, 'board');
});

test('定格只取快照，演示不打开宇宙流，后台切换不重复取数或重播', async () => {
  const frozen = board({ search: '?t=5' });
  await new Promise(setImmediate); frozen.flyIn(session.id, true); await new Promise(setImmediate);
  assert.equal(frozen.streams.length, 0); assert.equal(frozen.requests.length, 2);
  frozen.visibility('hidden'); frozen.advance(601000); frozen.visibility('visible'); frozen.flyOut();
  assert.equal(frozen.streams.length, 0); assert.equal(frozen.requests.length, 2);
  const demo = board({ search: '?demo=universe' });
  demo.visibility('hidden'); demo.advance(601000); demo.visibility('visible');
  assert.equal(demo.streams.length, 0); assert.equal(demo.demoStarts, 1);
});

for (const lang of ['zh', 'en']) for (const mode of ['universe', 'board']) test(`${lang} ${mode} 流等满 8 秒提示一次，open 后再次卡住还能提示`, () => {
  const b = board({ lang }); b.seed();
  if (mode === 'board') b.flyIn(session.id, true);
  const es = b.active()[0];
  b.advance(3000); es.emit('error'); b.advance(3000); es.emit('error'); b.advance(1999);
  assert.deepEqual(b.notices, []);
  b.advance(1);
  const text = b.TEXT.streamStuck;
  assert.deepEqual(b.notices, [text]);
  es.emit('error'); b.advance(16000); assert.deepEqual(b.notices, [text]);
  es.emit('open'); b.advance(8000); assert.deepEqual(b.notices, [text]);
  es.emit('error'); b.advance(7999); assert.equal(b.notices.length, 1);
  b.advance(1); assert.deepEqual(b.notices, [text, text]);
  es.emit('open'); es.emit('error');
  if (mode === 'board') b.disconnect(); else b.disconnectUniverse();
  b.advance(8000); assert.equal(b.notices.length, 2);
});

test('前台页面连不上 2 秒就广播，后台的看板页收到后马上让出连接，并每分钟向服务报到', () => {
  const b = board(); b.seed();
  assert.equal(b.active().length, 1);
  b.visibility('hidden');
  b.channel.onmessage({ data: 'release' });
  assert.equal(b.active().length, 0); assert.equal(b.intervals.size, 1); assert.equal([...b.intervals.values()][0].ms, 60000);
  b.visibility('visible'); assert.equal(b.active().length, 1); assert.equal(b.intervals.size, 0);
  // 前台页面自己连不上：2 秒后请别的标签页让出连接
  const front = board(); front.seed(); front.advance(2000);
  assert.deepEqual(front.channel.sent, ['release']);
});

test('后台放了 30 分钟以后不再报到，回到前台照常重连', () => {
  const b = board(); b.seed();
  b.visibility('hidden'); b.advance(600000);
  assert.equal(b.active().length, 0); assert.equal(b.intervals.size, 1);
  const ping = () => [...b.intervals.values()][0]?.fn();
  const pings = () => b.requests.filter((url) => url === 'health?watching=1').length;
  b.advance(1199000); ping(); assert.equal(pings(), 1);
  // 隐藏满 30 分钟：这一次不报，计时也停掉
  b.advance(1000); ping(); assert.equal(pings(), 1); assert.equal(b.intervals.size, 0);
  b.visibility('visible'); assert.equal(b.active().length, 1);
  // 再隐藏从头算
  b.visibility('hidden'); b.advance(600000); assert.equal(b.intervals.size, 1);
  b.advance(60000); ping(); assert.equal(pings(), 2);
});

for (const lang of ['zh', 'en']) test(`${lang} 卡住时问一下服务：已经退出就换成一直留着的提示，超时照旧`, async () => {
  for (const [health, last] of [['refused', 'boardGone'], ['timeout', 'streamStuck']]) {
    const b = board({ lang, health }); b.seed();
    b.U.es.emit('error'); b.advance(8000);
    assert.deepEqual(b.notices, [b.TEXT.streamStuck]);
    await new Promise(setImmediate);
    assert.equal(b.notices.at(-1), b.TEXT[last]); assert.equal(b.requests.filter((url) => url === 'health').length, 1);
  }
});

test('在后台时没连上的页面回到前台，马上请其他看板标签页让出，不用等它们隐藏满 10 分钟', () => {
  const b = board({ visibility: 'hidden' }); b.seed();
  assert.equal(b.U.es.readyState, 0); assert.deepEqual(b.channel.sent, []);
  b.visibility('visible');
  assert.deepEqual(b.channel.sent, ['release']);
  // 已经连上的页面回到前台不打扰别人
  const ok = board(); ok.seed(); ok.U.es.emit('open'); ok.visibility('hidden'); ok.visibility('visible');
  assert.deepEqual(ok.channel.sent, []);
});

test('共享流忽略广播让出，后台满 10 分钟仍取消订阅，worker 失败转直连后重新参与让出', async () => {
  const b = board({ shared: true }); b.seed(); await new Promise(setImmediate);
  const first = b.U.es, worker = b.workers[0], sent = worker.port.sent;
  worker.port.onmessage({ data: { id: first.id, state: 'open' } });
  b.visibility('hidden'); b.channel.onmessage({ data: 'release' });
  assert.equal(b.U.es, first); assert.equal(first.readyState, 1);
  b.advance(600000); assert.equal(b.U.es, null); assert.equal(first.readyState, 2);
  assert.equal(sent.at(-1).op, 'unsub'); assert.equal(sent.at(-1).id, first.id);
  b.visibility('visible'); await new Promise(setImmediate);
  assert.notEqual(b.U.es, first); assert.equal(sent.at(-1).op, 'sub'); assert.equal(b.workers.length, 1);
  worker.onerror(); assert.equal(b.active().length, 1);
  b.visibility('hidden'); b.channel.onmessage({ data: 'release' }); assert.equal(b.active().length, 0);
});

test('共享流同样在 2 秒广播、8 秒提示，open 后清掉等待计时器', async () => {
  const b = board({ shared: true }); b.seed(); await new Promise(setImmediate);
  b.advance(2000); assert.deepEqual(b.channel.sent, ['release']);
  b.advance(6000); assert.deepEqual(b.notices, [b.TEXT.streamStuck]);
  b.workers[0].port.onmessage({ data: { id: b.U.es.id, state: 'open' } });
  b.advance(8000); assert.deepEqual(b.notices, [b.TEXT.streamStuck]);
});
