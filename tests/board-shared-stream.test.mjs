import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workerSource = fs.readFileSync(new URL('../foreman/skills/dispatch/scripts/board/stream-worker.js', import.meta.url), 'utf8');
const pageSource = fs.readFileSync(new URL('../board/web/01-state.js', import.meta.url), 'utf8');
const flush = () => new Promise(setImmediate);
const plain = (value) => JSON.parse(JSON.stringify(value));
async function until(check, message) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startBoard(t, { replay = false, idle = '30' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-shared-stream-'));
  const runs = path.join(home, 'runs'), projects = path.join(home, 'projects'), folder = path.join(projects, 'project');
  fs.mkdirSync(runs); fs.mkdirSync(folder, { recursive: true });
  const transcript = path.join(folder, 'conversation.jsonl'), config = path.join(home, 'config.json');
  const append = (text) => {
    const at = Date.now();
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), cwd: home,
      sessionId: 'conversation', message: { content: text } }) + '\n');
    return at;
  };
  append('first prompt'); fs.writeFileSync(config, '{}');
  const child = spawn(process.execPath, [path.join(root, 'foreman/skills/dispatch/scripts/board/server.mjs'),
    '--runs', runs, '--claude-dir', projects, '--transcript', transcript, '--config', config, '--idle-min', idle,
    ...(replay ? ['--replay', 'all'] : [])], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, USERPROFILE: home,
      APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, FOREMAN_TEST_BOARD_TICK_MS: '100' },
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) { child.kill(); await exited; }
    assert.equal(path.dirname(home), os.tmpdir()); fs.rmSync(home, { recursive: true, force: true });
  });
  const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  const address = replay ? JSON.parse(String(output)).url : String(output).match(/board: (http:\/\/\S+)/)?.[1];
  assert.ok(address, stderr || String(output));
  const base = new URL('.', address).href;
  return { base, append, child, exited, runs, get stderr() { return stderr; } };
}
const post = (base, route, body) => fetch(base + route, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
async function stream(t, base, c) {
  const response = await fetch(base + 'mux?c=' + c, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader(), decoder = new TextDecoder(), frames = [];
  let buffer = '', error;
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!raw.startsWith('data: ')) continue;
          assert.equal(raw.includes('\nevent:'), false);
          const [, id, event, data] = /^data: (\S+) (\S+) (.*)$/.exec(raw);
          frames.push({ id, event, data: JSON.parse(data) });
        }
      }
    } catch (e) { error = e; }
  })();
  const close = async () => { await reader.cancel(); await done; if (error) throw error; };
  t.after(async () => { await reader.cancel().catch(() => {}); await done; });
  return { frames, done, close, wait: (check) => until(() => { if (error) throw error; return check(frames); }, '等待 mux 消息') };
}

test('一个 mux 上的宇宙和对话各自首发，取消订阅后只有宇宙继续更新', { timeout: 15000 }, async (t) => {
  const b = await startBoard(t), c = 'connection_first', es = await stream(t, b.base, c);
  for (const [s, q] of [['universe', 'level=all'], ['detail', 'session=conversation']]) {
    const response = await post(b.base, 'sub', { c, s, q });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  }
  await es.wait((frames) => frames.some((m) => m.id === 'detail' && m.event === 'backlog'));
  const universe = es.frames.filter((m) => m.id === 'universe'), detail = es.frames.filter((m) => m.id === 'detail');
  assert.deepEqual(universe.slice(0, 3).map((m) => m.event), ['open', 'hello', 'universe']);
  assert.deepEqual(detail.slice(0, 4).map((m) => m.event), ['open', 'hello', 'run', 'backlog']);
  assert.deepEqual(universe[0].data, {}); assert.deepEqual(detail[0].data, {});
  assert.equal(universe[1].data.level, 'all'); assert.deepEqual(detail[1].data.scope, { kind: 'session', value: 'conversation' });
  assert.equal(detail[2].data.id, 'cc'); assert.equal(detail[3].data.events.some((e) => e.t === 'first prompt'), true);
  b.append('next prompt');
  await es.wait((frames) => frames.some((m) => m.id === 'detail' && m.event === 'ev' && m.data.t === 'next prompt'));
  assert.equal((await post(b.base, 'unsub', { c, s: 'detail' })).status, 200);
  assert.equal((await post(b.base, 'unsub', { c, s: 'detail' })).status, 200);
  const count = es.frames.filter((m) => m.id === 'detail').length, at = b.append('after unsubscribe');
  await es.wait((frames) => frames.some((m) => m.id === 'universe' && m.event === 'session' && m.data.last_at === at));
  assert.equal(es.frames.filter((m) => m.id === 'detail').length, count);
});

test('mux 重连替换旧连接和全部订阅，同号订阅也能替换', { timeout: 15000 }, async (t) => {
  const b = await startBoard(t), c = 'connection_replace', old = await stream(t, b.base, c);
  assert.equal((await post(b.base, 'sub', { c, s: 'old', q: 'session=conversation' })).status, 200);
  await old.wait((frames) => frames.some((m) => m.event === 'backlog'));
  const next = await stream(t, b.base, c); await old.done;
  assert.equal((await post(b.base, 'sub', { c, s: 'new', q: 'level=all' })).status, 200);
  await next.wait((frames) => frames.some((m) => m.event === 'universe'));
  assert.ok(next.frames.every((m) => m.id === 'new'));
  const offset = next.frames.length;
  assert.equal((await post(b.base, 'sub', { c, s: 'new', q: 'session=conversation' })).status, 200);
  await next.wait((frames) => frames.slice(offset).some((m) => m.event === 'backlog'));
  assert.deepEqual(next.frames.slice(offset, offset + 4).map((m) => m.event), ['open', 'hello', 'run', 'backlog']);
  b.append('replacement prompt');
  await next.wait((frames) => frames.some((m) => m.event === 'ev' && m.data.t === 'replacement prompt'));
  assert.equal(next.frames.slice(offset).some((m) => ['session', 'universe'].includes(m.event)), false);
});

test('mux 断开清掉所有 client，空闲服务正常退出并移除锁', { timeout: 10000 }, async (t) => {
  const b = await startBoard(t, { idle: '0.015' }), c = 'connection_cleanup', es = await stream(t, b.base, c);
  for (const [s, q] of [['u', 'level=all'], ['d', 'session=conversation']])
    assert.equal((await post(b.base, 'sub', { c, s, q })).status, 200);
  await es.wait((frames) => frames.some((m) => m.id === 'd' && m.event === 'backlog'));
  await es.close();
  await until(() => b.child.exitCode != null, 'mux 关闭后服务空闲退出');
  assert.equal((await b.exited).code, 0, b.stderr);
  assert.equal(fs.existsSync(path.join(b.runs, 'board.lock.json')), false);
});

test('mux 路由校验、请求体限制和 worker/page CSP', { timeout: 15000 }, async (t) => {
  const b = await startBoard(t), c = 'connection_routes';
  for (const id of ['short', 'invalid!connection']) assert.equal((await fetch(b.base + 'mux?c=' + id)).status, 400);
  const head = await fetch(b.base + 'mux?c=' + c, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'text/event-stream');
  for (const route of ['sub', 'unsub']) {
    assert.equal((await post(b.base, route, { c, s: 's', q: 'level=all' })).status, 404);
    assert.equal((await fetch(b.base + route)).status, 405);
  }
  const es = await stream(t, b.base, c);
  for (const body of ['not json', 'null', { c, s: 'invalid space', q: '' }, { c, s: 's', q: null }])
    assert.equal((await post(b.base, 'sub', body)).status, 400);
  for (const q of ['replay=all', 'from=0', 'group=g&run=r', 'session=../bad', 'speed=0'])
    assert.equal((await post(b.base, 'sub', { c, s: 's', q })).status, 400);
  assert.equal((await post(b.base, 'sub', { c, s: 's', q: 'x'.repeat(16384) })).status, 413);
  assert.equal(es.frames.length, 0);
  const worker = await fetch(b.base + 'stream-worker.js');
  assert.equal(worker.status, 200); assert.equal(worker.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(worker.headers.get('content-security-policy'), "default-src 'none'; connect-src 'self'");
  assert.equal(await worker.text(), workerSource);
  assert.match((await fetch(b.base)).headers.get('content-security-policy'), /worker-src 'self'/);
});

test('回放服务不接受 mux/sub/unsub，仍提供 worker 文件', { timeout: 10000 }, async (t) => {
  const b = await startBoard(t, { replay: true });
  assert.equal((await fetch(b.base + 'mux?c=connection_replay')).status, 404);
  for (const route of ['sub', 'unsub']) assert.equal((await post(b.base, route, { c: 'connection_replay', s: 's', q: '' })).status, 404);
  assert.equal((await fetch(b.base + 'stream-worker.js')).status, 200);
});

function worker({ locks = false, manual = false } = {}) {
  const sources = [], posts = [], lockRequests = new Map(), timers = [], replies = []; let status = 200;
  class EventSource { readyState = 0; constructor(url) { this.url = url; sources.push(this); } }
  const context = vm.createContext({ EventSource, crypto: webcrypto, Uint8Array, onconnect: null,
    navigator: locks ? { locks: { request: (name, fn) => { lockRequests.set(name, fn); } } } : {},
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    fetch: (route, options) => {
      posts.push({ route, ...JSON.parse(options.body) });
      // manual：请求挂着，等测试用 reply 一个个放行（status 为 0 表示网络错误）
      if (manual) return new Promise((resolve, reject) => replies.push((code) => (code === 0 ? reject(new TypeError('Failed to fetch')) : resolve({ status: code }))));
      return Promise.resolve({ status });
    },
  });
  vm.runInContext(workerSource, context);
  return { sources, posts, lockRequests, timers, get mux() { return sources[0]; }, set status(value) { status = value; },
    async reply(code) { replies.shift()(code); await flush(); },
    open() { sources[0].readyState = 1; sources[0].onopen(); },
    message(data) { sources[0].onmessage({ data }); },
    port() {
      const port = { sent: [], start() {}, postMessage(message) { this.sent.push(plain(message)); } };
      context.onconnect({ ports: [port] });
      return { sent: port.sent, send: (data) => port.onmessage({ data }) };
    },
  };
}

test('worker 只建一个 mux，按订阅号原样转发，open/error/closed 和重连订阅正确', async () => {
  const w = worker(), a = w.port(), b = w.port();
  assert.match(w.mux.url, /^mux\?c=[a-f0-9]{32}$/); assert.equal(w.sources.length, 1);
  a.send({ op: 'sub', id: 'a', q: 'level=all', tab: 'tab_a' });
  b.send({ op: 'sub', id: 'b', q: 'session=conversation', tab: 'tab_b' });
  assert.equal(w.posts.length, 0); w.open(); await flush();
  assert.deepEqual(w.posts.map(({ route, s, q }) => [route, s, q]), [['sub', 'a', 'level=all'], ['sub', 'b', 'session=conversation']]);
  assert.ok(w.posts.every((p) => p.c === w.mux.url.slice(6)));
  w.message('a open {}'); assert.deepEqual(a.sent, [{ id: 'a', state: 'open' }]); assert.deepEqual(b.sent, []);
  const raw = '{ "text": "' + 'with spaces '.repeat(3000) + '" }';
  w.message('b backlog ' + raw); assert.deepEqual(b.sent, [{ id: 'b', event: 'backlog', data: raw }]);
  w.message('missing ev {}'); assert.equal(a.sent.length, 1); assert.equal(b.sent.length, 1);
  w.mux.readyState = 0; w.mux.onerror(); assert.deepEqual(a.sent.at(-1), { id: 'a', state: 'error', opened: true });
  w.open(); await flush(); assert.deepEqual(w.posts.slice(2).map((p) => p.s), ['a', 'b']);
  w.mux.readyState = 2; w.mux.onerror(); assert.deepEqual(b.sent.at(-1), { id: 'b', state: 'closed', opened: true });
  assert.equal(w.sources.length, 1);
});

test('worker 的长连接一次都没连上就报错时带 opened: false', () => {
  const w = worker(), port = w.port();
  port.send({ op: 'sub', id: 'a', q: 'level=all', tab: 'tab' });
  w.mux.onerror(); assert.deepEqual(port.sent, [{ id: 'a', state: 'error', opened: false }]);
  // 报错以后才订阅的页面马上收到同样的状态
  const late = w.port(); late.send({ op: 'sub', id: 'b', q: 'level=all', tab: 'late' });
  assert.deepEqual(late.sent, [{ id: 'b', state: 'error', opened: false }]);
  // 连上过以后再订阅就等 open
  w.open(); const after = w.port(); w.mux.readyState = 0; after.send({ op: 'sub', id: 'c', q: 'level=all', tab: 'after' });
  assert.deepEqual(after.sent, []);
});

test('worker 的 sub 404 等下次 open，其他失败关闭并删除订阅', async () => {
  const w = worker(), port = w.port(); w.status = 404;
  port.send({ op: 'sub', id: 'retry', q: 'level=all', tab: 'tab' }); w.open(); await flush();
  assert.deepEqual(port.sent, []); assert.equal(w.posts.length, 1);
  w.status = 200; w.open(); await flush(); assert.equal(w.posts.length, 2);
  w.status = 400; port.send({ op: 'sub', id: 'bad', q: 'replay=all', tab: 'tab' }); await flush();
  assert.deepEqual(port.sent, [{ id: 'bad', state: 'closed' }]);
  w.status = 200; w.open(); await flush(); assert.equal(w.posts.at(-1).s, 'retry');
  assert.equal(w.posts.filter((p) => p.s === 'bad').length, 1);
});

test('worker 里同一订阅号的 sub、unsub 按顺序发：在途的订阅回来以后才退订', async () => {
  const w = worker({ manual: true }), port = w.port(); w.open();
  port.send({ op: 'sub', id: 'a', q: 'session=conversation', tab: 'tab' }); await flush();
  port.send({ op: 'unsub', id: 'a' }); await flush();
  // 订阅还没回来：退订排在它后面，还没发出去
  assert.deepEqual(w.posts.map((p) => [p.route, p.s]), [['sub', 'a']]);
  await w.reply(200); assert.deepEqual(w.posts.map((p) => [p.route, p.s]), [['sub', 'a'], ['unsub', 'a']]);
  // 退订时还没发过订阅（长连接没连上）就不发退订
  const quiet = worker(), other = quiet.port();
  other.send({ op: 'sub', id: 'b', q: 'level=all', tab: 'tab' }); other.send({ op: 'unsub', id: 'b' }); await flush();
  quiet.open(); await flush(); assert.deepEqual(quiet.posts, []);
});

test('worker 的 sub 网络错误或服务出错时退避重试，退订以后停', async () => {
  const w = worker({ manual: true }), port = w.port(); w.open();
  port.send({ op: 'sub', id: 'a', q: 'level=all', tab: 'tab' }); await flush();
  await w.reply(0); assert.deepEqual(w.timers.map((x) => x.ms), [1000]); assert.deepEqual(port.sent, []);
  w.timers.shift().fn(); await flush(); assert.equal(w.posts.length, 2);
  await w.reply(503); assert.deepEqual(w.timers.map((x) => x.ms), [2000]);
  w.timers.shift().fn(); await flush(); await w.reply(200); assert.equal(w.posts.length, 3); assert.deepEqual(w.timers, []);
  // 退订以后到点也不再重发；长连接断着时也不发，等它重新连上时统一重订阅
  port.send({ op: 'sub', id: 'b', q: 'level=all', tab: 'tab' }); await flush(); await w.reply(0);
  port.send({ op: 'unsub', id: 'b' }); await flush(); await w.reply(200);
  const count = w.posts.length; w.timers.shift().fn(); await flush(); assert.equal(w.posts.length, count);
  port.send({ op: 'sub', id: 'c', q: 'level=all', tab: 'tab' }); await flush(); await w.reply(0);
  w.mux.readyState = 0; w.timers.shift().fn(); await flush(); assert.equal(w.posts.length, count + 1);
});

test('worker 的 unsub、bye 和页面锁释放只删除对应订阅', async () => {
  const w = worker({ locks: true }), a = w.port(), b = w.port();
  for (const id of ['a1', 'a2']) a.send({ op: 'sub', id, q: 'level=all', tab: 'a' });
  for (const id of ['b1', 'b2']) b.send({ op: 'sub', id, q: 'level=all', tab: 'b' });
  assert.deepEqual([...w.lockRequests.keys()], ['foreman-board-tab-a', 'foreman-board-tab-b']);
  w.open(); await flush();
  a.send({ op: 'unsub', id: 'a1' }); a.send({ op: 'bye', tab: 'a' });
  w.message('a1 ev {}'); w.message('a2 ev {}'); assert.deepEqual(a.sent, []);
  const before = w.posts.length; w.open(); await flush();
  assert.deepEqual(w.posts.slice(before).filter((p) => p.route === 'sub').map((p) => p.s), ['b1', 'b2']);
  w.lockRequests.get('foreman-board-tab-b')(); await flush();
  w.message('b1 ev {}'); w.message('b2 ev {}'); assert.deepEqual(b.sent, []);
  assert.deepEqual(w.posts.filter((p) => p.route === 'unsub').map((p) => p.s), ['a1', 'a2', 'b1', 'b2']);
  const count = w.posts.length; w.open(); await flush(); assert.equal(w.posts.length, count);
  const withoutLocks = worker(), port = withoutLocks.port();
  port.send({ op: 'sub', id: 's', q: '', tab: 'tab' }); port.send({ op: 'bye', tab: 'tab' });
  withoutLocks.open(); assert.deepEqual(withoutLocks.posts, []);
});

function page({ mode = 'live', shared = true, throws = false, search = '', fixture = false, health = async () => ({ ok: true }) } = {}) {
  const workers = [], sources = [], events = new Map(), locks = [], checks = []; let attempts = 0;
  class EventSource {
    readyState = 0; listeners = new Map();
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
    emit(name, data, state) {
      if (name === 'open') this.readyState = 1;
      if (name === 'error') this.readyState = state ?? 0;
      const event = ['open', 'error'].includes(name) ? { type: name } : { data };
      for (const fn of this.listeners.get(name) || []) fn(event);
    }
    close() { this.readyState = 2; }
  }
  class SharedWorker {
    constructor(url, options) {
      attempts++; if (throws) throw new Error('worker rejected');
      this.url = url; this.options = plain(options);
      this.port = { sent: [], closed: false, postMessage(message) { this.sent.push(plain(message)); }, start() {}, close() { this.closed = true; } };
      workers.push(this);
    }
  }
  const context = vm.createContext({ window: { __BOARD_MODE__: mode, __BOARD_FIXTURE__: fixture },
    location: new URL('http://localhost/token/' + search), history: { replaceState() {} }, URL, URLSearchParams, EventSource,
    ...(shared ? { SharedWorker } : {}), crypto: webcrypto, navigator: { locks: { request(name, fn) { locks.push({ name, held: fn() }); } } },
    addEventListener: (name, fn) => events.set(name, fn), fetch: (route) => { checks.push(route); return health(); },
  });
  vm.runInContext(pageSource + '\nglobalThis.api = { SharedStream, openStream, B };', context);
  return { ...context.api, workers, sources, events, locks, checks, get attempts() { return attempts; },
    receive(message) { workers[0].port.onmessage({ data: message }); },
  };
}

test('SharedStream 复用页面 worker，提供状态、原文事件和 close/unsub', async () => {
  const p = page(); assert.equal(p.workers.length, 0);
  const a = p.openStream(new URLSearchParams({ level: 'all' })), b = p.openStream('session=conversation');
  assert.ok(a instanceof p.SharedStream); assert.equal(a.readyState, 0); await flush();
  assert.equal(p.workers.length, 1); assert.equal(p.workers[0].url, 'stream-worker.js');
  assert.deepEqual(p.workers[0].options, { name: 'foreman-board-streams' });
  const messages = p.workers[0].port.sent;
  assert.deepEqual(messages.map((m) => [m.op, m.q]), [['sub', 'level=all'], ['sub', 'session=conversation']]);
  assert.equal(messages[0].tab, messages[1].tab); assert.notEqual(a.id, b.id);
  assert.equal(p.locks.length, 1); assert.equal(p.locks[0].name, 'foreman-board-tab-' + messages[0].tab);
  let released = false; p.locks[0].held.then(() => { released = true; }); await flush(); assert.equal(released, false);
  const seen = []; a.addEventListener('open', (e) => seen.push(e.type)); a.onopen = (e) => seen.push('on' + e.type);
  a.addEventListener('error', (e) => seen.push(e.type)); a.onerror = (e) => seen.push('on' + e.type);
  a.addEventListener('hello', (e) => seen.push(e.data));
  p.receive({ id: a.id, state: 'open' }); assert.equal(a.readyState, 1);
  p.receive({ id: a.id, event: 'hello', data: '{ "now": 1 }' });
  p.receive({ id: a.id, state: 'error' }); assert.equal(a.readyState, 0);
  p.receive({ id: a.id, state: 'closed' }); assert.equal(a.readyState, 2);
  assert.deepEqual(seen, ['open', 'onopen', '{ "now": 1 }', 'error', 'onerror', 'error', 'onerror']);
  b.close(); assert.equal(b.readyState, 2); assert.deepEqual(messages.at(-1), { op: 'unsub', id: b.id });
  const count = seen.length; a.close(); p.receive({ id: a.id, state: 'open' }); p.receive({ id: a.id, event: 'hello', data: '{}' });
  assert.equal(seen.length, count); assert.equal(a.readyState, 2);
});

test('worker 加载失败时已有 SharedStream 内部接回直连，新流直接用 EventSource', async () => {
  const p = page(), a = p.openStream('level=all'), b = p.openStream('session=conversation'), seen = [];
  a.addEventListener('hello', (e) => seen.push(e.data)); a.onopen = (e) => seen.push(e.type);
  a.onerror = (e) => seen.push(e.type); await flush(); p.receive({ id: a.id, state: 'open' });
  p.workers[0].onerror();
  assert.deepEqual(p.sources.map((es) => es.url), ['stream?level=all', 'stream?session=conversation']);
  assert.equal(a.readyState, 0); assert.equal(p.workers[0].port.closed, true);
  a.addEventListener('backlog', (e) => seen.push(e.data));
  p.sources[0].emit('open'); assert.equal(a.readyState, 1);
  p.sources[0].emit('hello', '{ "live": true }'); p.sources[0].emit('backlog', '{}');
  p.sources[0].emit('error', undefined, 2); assert.equal(a.readyState, 2);
  assert.deepEqual(seen, ['open', 'open', '{ "live": true }', '{}', 'error']);
  const direct = p.openStream('run=next'); assert.equal(direct, p.sources[2]); assert.equal(p.attempts, 1);
  b.close(); assert.equal(p.sources[1].readyState, 2);
  const count = seen.length; a.close(); p.sources[0].emit('hello', '{}'); assert.equal(seen.length, count);
});

test('openStream 在不支持 worker、回放、截图和构造失败时保留直连', () => {
  for (const options of [{ shared: false }, { mode: 'replay', search: '?replay=all' }, { search: '?t=5' }, { fixture: true }, { throws: true }]) {
    const p = page(options), es = p.openStream('level=all');
    assert.equal(es, p.sources[0]); assert.equal(es.url, 'stream?level=all');
    if (options.throws) { p.openStream('session=conversation'); assert.equal(p.attempts, 1); }
    else assert.equal(p.attempts, 0);
  }
  const p = page(); p.B.params.replay = 'all'; assert.equal(p.openStream('replay=all'), p.sources[0]);
});

test('pagehide 发 bye，往返缓存回来仅重订阅仍打开的 SharedStream', async () => {
  const p = page(), a = p.openStream('level=all'), b = p.openStream('session=conversation'); await flush();
  const messages = p.workers[0].port.sent, tab = messages[0].tab;
  b.close(); p.events.get('pagehide')(); assert.deepEqual(messages.at(-1), { op: 'bye', tab });
  const count = messages.length; p.events.get('pageshow')({ persisted: false }); await flush(); assert.equal(messages.length, count);
  p.events.get('pageshow')({ persisted: true }); await flush();
  assert.deepEqual(messages.slice(count), [{ op: 'sub', id: a.id, q: 'level=all', tab }]);
});

test('worker 的长连接从没连上、服务却能访问时改走直连；服务也访问不了就继续等', async () => {
  // Claude 桌面版的内置浏览器里 worker 能加载，但它发的请求一律失败
  const p = page(), a = p.openStream('level=all'), seen = []; await flush();
  a.addEventListener('hello', (e) => seen.push(e.data));
  p.receive({ id: a.id, state: 'error' }); await flush(); assert.deepEqual(p.checks, []);
  p.receive({ id: a.id, state: 'error', opened: false }); p.receive({ id: a.id, state: 'error', opened: false }); await flush(); await flush();
  assert.deepEqual(p.checks, ['health']);
  assert.deepEqual(p.sources.map((es) => es.url), ['stream?level=all']);
  const messages = p.workers[0].port.sent; assert.deepEqual(messages.at(-1), { op: 'bye', tab: messages[0].tab });
  p.sources[0].emit('hello', '{ "direct": true }'); assert.deepEqual(seen, ['{ "direct": true }']);
  assert.equal(p.openStream('session=conversation'), p.sources[1]);
  for (const health of [async () => ({ ok: false }), async () => { throw new TypeError('Failed to fetch'); }]) {
    const down = page({ health }), b = down.openStream('level=all'); await flush();
    down.receive({ id: b.id, state: 'error', opened: false }); await flush(); await flush();
    assert.deepEqual(down.checks, ['health']); assert.deepEqual(down.sources, []); assert.equal(b.readyState, 0);
  }
});

test('查 health 的这一会儿 worker 连上了，回来时不切直连', async () => {
  let answer; const p = page({ health: () => new Promise((resolve) => { answer = resolve; }) });
  const a = p.openStream('level=all'); await flush();
  p.receive({ id: a.id, state: 'error', opened: false }); assert.deepEqual(p.checks, ['health']);
  p.receive({ id: a.id, state: 'open' }); answer({ ok: true }); await flush(); await flush();
  assert.equal(a.readyState, 1); assert.equal(a.direct, null); assert.deepEqual(p.sources, []);
  // 连上过以后再收到从没连上的报错也不再查
  p.receive({ id: a.id, state: 'error', opened: false }); assert.deepEqual(p.checks, ['health']);
});
