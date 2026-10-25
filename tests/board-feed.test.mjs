import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalize, laneOf, selectScope, buildReplay, snapshotAt, createFeed, runMessage, hostCost, usageTotals } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { sandbox, seedRun, write } from './helpers.mjs';

const start = Date.parse('2026-10-18T13:40:00Z');
const run = { id: 'one', lane: 'root', meta: { cwd: 'C:\\work' } };
const raw = (type, fields = {}, dt = 0) => ({ type, ts: start + dt, ...fields });
const item = (type, fields, phase = 'item.completed', dt = 0) => raw(phase, { item: { id: 'tool', type, ...fields } }, dt);

test('feed 每轮只读一次排队目录及票据，保留不可读票据的位次；历史轮次不重复携带队列', (t) => {
  const h = sandbox(t), group = 'queue-batch', dir = path.join(h.runs, '.state/queue/codex'), at = Date.now();
  const ticket = { pid: process.pid, pid_started_at: new Date(Math.ceil(performance.timeOrigin)).toISOString(), expires_at: new Date(at + 60000).toISOString(),
    queued_at: new Date(at - 1000).toISOString(), agent: 'codex', claude_session: 'test-session', group, plan: 'p', seat: 1, title: 'restart ' + 'x'.repeat(300) };
  write(path.join(dir, '1.json'), ticket); write(path.join(dir, '2.json'), ticket);
  write(path.join(dir, '3.json'), { ...ticket, expires_at: new Date(at - 1000).toISOString() });
  write(path.join(dir, '4.json'), { ...ticket, pid: 99999999 });
  for (let i = 1; i <= 8; i++) seedRun(h, `20000101-00000${i}-seat`, { group, plan: 'p', seat: 1, started_at: new Date(at - 60000).toISOString() });
  seedRun(h, '20000101-000009-other', { group: 'other-group', plan: 'other', seat: 1 });
  seedRun(h, '20000101-000010-other-session', { group, claude_session: 'other', plan: 'other-session', seat: 1 });
  const readdir = fs.readdirSync, read = fs.readFileSync, listed = new Map(), reads = new Map();
  t.mock.method(fs, 'readdirSync', function (file, ...args) { if (String(file).includes(`${path.sep}queue`)) listed.set(file, (listed.get(file) || 0) + 1); return readdir.call(this, file, ...args); });
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (path.dirname(String(file)) === dir) { reads.set(file, (reads.get(file) || 0) + 1); if (path.basename(file) === '1.json') throw Object.assign(new Error('unreadable'), { code: 'EIO' }); }
    return read.call(this, file, ...args);
  });
  const feed = createFeed(h.runs);
  for (let round = 1; round <= 2; round++) {
    const data = feed.read({ session: 'test-session' }, at + round);
    assert.equal(listed.get(path.dirname(dir)), round); assert.equal(listed.get(dir), round);
    for (const n of [1, 2, 3, 4]) assert.equal(reads.get(path.join(dir, `${n}.json`)), round);
    const carrying = data.runs.filter((r) => r.dispatch_queue?.length);
    assert.deepEqual(carrying.map((r) => r.id), ['20000101-000008-seat']);
    assert.equal(carrying[0].dispatch_queue[0].position, 2);
    assert.equal(carrying[0].dispatch_queue[0].title, ticket.title.slice(0, 160));
    assert.ok(data.runs.filter((r) => r.id !== '20000101-000008-seat').every((r) => !r.dispatch_queue?.length));
    assert.equal(data.events.find((e) => e.k === 'dispatch_queue').tickets.length, 1);
  }
  const before = [...listed]; runMessage({ id: 'standalone', dir: path.join(h.runs, 'x'), meta: { group }, tail: { state: {} } }, 'standalone');
  assert.deepEqual([...listed], before);
});

test('messages, reports, PowerShell, tools, edits and the remaining protocol events', () => {
  const take = (event) => normalize(event, run, {});
  // 多行的消息连成一行：网页时间线只显示一行，只留第一行时常常只剩一个 "{"
  assert.equal(take(item('agent_message', { text: '\nhello\nsecond' }))[0].t, 'hello second');
  assert.equal(take(item('agent_message', { text: '{"status":"done"}' }))[0].k, 'report');
  assert.equal(take(item('agent_message', { text: '[1,2]' }))[0].k, 'msg');
  assert.equal(take(item('reasoning', { text: '\n**Thinking**\nnext' }))[0].t, 'Thinking');
  assert.equal(take(item('command_execution', { command: 'echo one\r\necho two' }, 'item.started'))[0].t, 'echo one ⏎ echo two');
  const command = String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "rg -n \"hello\" ."`;
  const state = {};
  assert.equal(normalize(item('command_execution', { command }, 'item.started'), run, state)[0].t, 'rg -n "hello" .');
  assert.deepEqual(normalize(item('command_execution', { exit_code: 2 }), run, state).map((e) => [e.k, e.ok]), [['cmd_done', false]]);
  assert.deepEqual(take(item('command_execution', { command: 'echo ok', exit_code: null })).map((e) => e.k), ['cmd', 'cmd_done']);
  for (const category of ['read', 'search']) {
    const progress = {};
    assert.deepEqual(normalize(item('command_execution', { category, tool: 'Read', command: 'Read src/a' }, 'item.started'), run, progress), []);
    const events = normalize(item('command_execution', { category, label: 'src/a' }), run, progress);
    assert.deepEqual(events.map((e) => [e.k, e.t]), [[category, 'src/a']]);
    assert.equal(take(item('command_execution', { category, tool: 'Read', command: 'Read src/b' }))[0].t, 'src/b');
  }
  assert.deepEqual(take(item('file_change', { changes: [{ kind: 'update', path: 'C:\\work\\a.mjs' }, { kind: 'add', path: 'C:\\work\\b.mjs' }] })).map((e) => e.t), ['update a.mjs', 'add b.mjs']);
  assert.equal(take(item('todo_list', { items: [{ completed: true }, {}] }))[0].t, '1/2');
  assert.equal(take(item('web_search', { query: 'query' }))[0].k, 'search');
  const usage = take(raw('api.usage', { usage: { input_tokens: 10, cached_input_tokens: 7, output_tokens: 3 } }))[0];
  assert.equal(usage.n, 13); assert.deepEqual(usage.u, { in: 3, cached: 7, cache_write: null, out: 3 });
  for (const [type, k] of [['thread.started', 'turn'], ['turn.started', 'turn'], ['api.request', 'req'], ['api.queued', 'queued'], ['api.retry', 'retry'], ['api.error', 'error'], ['turn.failed', 'error'], ['error', 'error'], ['image.generated', 'image'], ['image.viewed', 'image']]) assert.equal(take(raw(type))[0].k, k);
  assert.equal(take(raw('image.viewed'))[0].viewed, true); assert.ok(!take(raw('image.generated'))[0].viewed);
  assert.deepEqual(take(raw('api.repair')), []);
  const long = take(raw('error', { message: `${'x'.repeat(170)}\nsecond` }))[0];
  assert.equal(long.t.length, 160); assert.ok(!long.t.includes('\n'));
  assert.equal(long.run, 'one'); assert.equal(long.lane, 'root');
});

test('结果和用量事件分开显示普通输入、缓存命中及写入，合计等于原始输入', () => {
  const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 40 };
  const prices = { models: [{ match: ['model'], input: 2, cached: 0.1, cache_write: 2.5, output: 10 }] };
  const message = runMessage({ ...run, meta: { ...run.meta, agent_type: 'api', model: 'provider/model' },
    result: { usage, usage_scope: 'this_run' }, tail: { state: {} } }, run.id, prices);
  assert.deepEqual(message.usage, { input: 50, cached: 20, cache_write: 30, output: 40 });
  assert.equal(message.usage.input + message.usage.cached + message.usage.cache_write, usage.input_tokens);
  assert.equal(message.cost_usd, 0.000577); assert.equal(message.cost_source, 'api_price');
  for (const type of ['api.usage', 'turn.completed']) {
    const event = normalize(raw(type, { usage }), run, {})[0];
    assert.deepEqual(event.u, { in: 50, cached: 20, cache_write: 30, out: 40 });
    assert.equal(event.u.in + event.u.cached + event.u.cache_write, usage.input_tokens);
    assert.equal(event.n, 140); assert.equal(event.t, '100/40');
    const excess = { input_tokens: 10, cached_input_tokens: 20, cache_write_input_tokens: 30 };
    assert.equal(normalize(raw(type, { usage: excess }), run, {})[0].u.in, 0);
    assert.equal(runMessage({ ...run, result: { usage: excess }, tail: { state: {} } }, run.id).usage.input, 0);
  }
});

test('续接累计量沿链还原基线，遇到缺轮次、不同会话或累计倒退时不归属', () => {
  const record = (id, n, usage_scope, parent = null, session_id = 'same') => ({ id, tail: { state: {} },
    meta: { parent, session_id, mode: parent ? 'resume' : 'exec' },
    result: { usage_scope, usage: { input_tokens: n * 3, cached_input_tokens: n, cache_write_input_tokens: 0, output_tokens: n } } });
  const first = record('first', 100, 'this_run'), middle = record('middle', 60, 'this_run', 'first');
  const next = record('next', 230, 'session_total', 'middle');
  const byId = new Map([first, middle, next].map((r) => [r.id, r]));
  const message = () => runMessage(next, 'first', undefined, byId);
  assert.deepEqual(message().usage, { input: 140, cached: 70, cache_write: 0, output: 70 });
  assert.equal(message().usage_scope, 'this_run'); assert.equal(message().usage_unattributed, undefined);
  byId.delete('first');
  assert.equal(message().usage, null); assert.equal(message().usage_unattributed, true);
  middle.result = record('middle', 160, 'session_total').result;
  assert.equal(message().usage.output, 70);
  middle.meta.session_id = 'different';
  assert.equal(message().usage, null); assert.equal(message().usage_unattributed, true);
  middle.meta.session_id = 'same'; next.result.usage.output_tokens = 150;
  assert.equal(message().usage, null); assert.equal(message().usage_unattributed, true);
});

test('没有 parent 的 session_total 根轮次按零基线归属，有 parent 却缺祖先时仍不归属', () => {
  const record = { id: 'root', meta: { model: 'model', agent_type: 'codex cli' }, tail: { state: {} },
    result: { usage_scope: 'session_total', usage: { input_tokens: 300, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 100 } } };
  const root = runMessage(record, 'root');
  assert.equal(root.usage_scope, 'this_run'); assert.equal(root.usage_unattributed, undefined);
  assert.deepEqual(root.usage, { input: 200, cached: 100, cache_write: 0, output: 100 });
  const missing = runMessage({ ...record, meta: { ...record.meta, parent: 'missing' } }, 'root', undefined, new Map());
  assert.equal(missing.usage_scope, 'session_total'); assert.equal(missing.usage_unattributed, true); assert.equal(missing.usage, null);
});

test('streaming sources keep the latest count in each 400 ms window', () => {
  const state = {}, events = [];
  for (const [type, dt, n, phase] of [['api.reasoning', 0, 1], ['api.reasoning', 100, 20], ['api.reasoning', 399, 30], ['api.reasoning', 400, 40], ['api.content', 650, 50], ['pi.progress', 800, 60, 'thinking'], ['pi.progress', 900, 70, 'answer']]) {
    events.push(...normalize(raw(type, { total_chars: n, phase }, dt), run, state));
  }
  events.push(...normalize(raw('ignored', {}, 1200), run, state));
  assert.deepEqual(events.map((e) => [e.k, e.n, e.ts - start]), [['think', 30, 400], ['answer', 50, 800], ['answer', 70, 1200]]);
  assert.ok(events.every((e, i) => !i || e.ts - events[i - 1].ts >= 400));
});

test('step usage matches API segments and only turn totals carry tot', () => {
  const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 10 };
  const api = normalize(raw('api.usage', { usage }), run, {})[0];
  assert.deepEqual(normalize(raw('step.usage', { usage }), run, {}), [api]);
  assert.deepEqual(normalize(raw('step.usage', { usage, final: true }), run, {}), [{ ...api, end: 1 }]);
  assert.deepEqual(normalize(raw('turn.completed', { usage }), run, {}), [{ ...api, tot: 1 }]);
});

test('two discussion rounds share five root lanes; newest session and recent limits apply', () => {
  const root = new URL('./fixtures/board/runs/', import.meta.url);
  const runs = fs.readdirSync(root).filter((id) => /^\d{8}-\d{6}-/.test(id)).map((id) => ({ id, meta: JSON.parse(fs.readFileSync(new URL(`${id}/meta.json`, root), 'utf8')) }));
  const byId = new Map(runs.map((r) => [r.id, r]));
  // 10 个外部席任务，加上样例补录的两份 Claude Code 席报告（它们落在 cc 车道）
  assert.equal(runs.length, 12); assert.equal(new Set(runs.map((r) => laneOf(r, byId))).size, 6);
  for (const r of runs.filter((r) => r.meta.round === 2 && r.meta.participant !== 'host')) assert.equal(laneOf(r, byId), r.meta.parent);
  const group = selectScope(runs, { replay: 'skills-roles-1018' }, start);
  assert.equal(group.scope.kind, 'group'); assert.equal(group.runs.length, 12);
  const seat = runs.find((r) => r.meta.participant !== 'host');
  assert.equal(selectScope(runs, { run: seat.id }, start).runs.length, 2);
  const other = { id: 'old-session', meta: { ...seat.meta, started_at: start - 1, claude_session: 'old', parent: null } };
  assert.equal(selectScope([...runs, other], { group: 'skills-roles-1018' }, start).runs.length, 12);
  const recent = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, meta: { status: 'running', started_at: start + i } }));
  assert.deepEqual(selectScope(recent, {}, start).runs.map((r) => r.id), ['r9', 'r8', 'r7', 'r6', 'r5', 'r4', 'r3', 'r2']);
  recent[0].activity = start + 100;
  assert.equal(selectScope(recent, {}, start).runs[0].id, 'r0');
  // 按对话选：同一个对话先前的会话 id（桌面版重启、恢复后换过 id）派出的任务也算这个对话的，别的对话不算
  const sessionRuns = [['a', 'new'], ['b', 'old'], ['c', 'other']].map(([id, session], i) => ({ id, meta: { claude_session: session, status: 'done', started_at: start + i, ended_at: start + i + 1 } }));
  assert.deepEqual(selectScope(sessionRuns, { session: 'new' }, start).runs.map((r) => r.id), ['a']);
  assert.deepEqual(selectScope(sessionRuns, { session: 'new', sessions: new Set(['new', 'old']) }, start).runs.map((r) => r.id).sort(), ['a', 'b']);
});

test('maxgap maps every clock and snapshotAt returns the state at elapsed replay seconds', () => {
  const data = { scope: { kind: 'run', value: 'r' }, runs: [{ id: 'r', started_at: start, ended_at: start + 105000, status: 'done', usage: { input: 2 }, files: [{ path: 'a' }], review: { verdict: 'pass' } }],
    events: [{ run: 'r', ts: start, k: 'start' }, { run: 'r', ts: start + 5000, k: 'msg' }, { run: 'r', ts: start + 105000, k: 'end' }] };
  const replay = buildReplay(data, { speed: 2, maxgap: 20 }, start + 999999);
  assert.equal(replay.hello.replay.start, start - 2000); assert.equal(replay.hello.replay.end, start + 27000);
  assert.deepEqual(replay.timeline.filter((m) => m.event === 'ev').map((m) => m.data.ts), [start, start + 5000, start + 25000]);
  assert.equal(snapshotAt(replay, 0).runs.length, 0);
  const during = snapshotAt(replay, 5);
  assert.equal(during.runs[0].status, 'running'); assert.equal(during.runs[0].usage, null); assert.deepEqual(during.runs[0].files, []);
  assert.ok(during.events.every((e) => e.ts <= start + 8000));
  assert.equal(snapshotAt(replay, 14).runs[0].ended_at, start + 25000);
  assert.equal(snapshotAt(replay).runs[0].status, 'done'); assert.equal(data.runs[0].ended_at, start + 105000);
});

test('host replay usage prefixes retain nulls, zeroes, price changes and unknown pricing without mutating earlier frames', () => {
  const prices = { models: [{ match: ['priced'], input: 2, cached: 0.1, cache_write: 2.5, output: 10 }] };
  const events = [
    { t: 'priced', u: { in: 1, cached: null, cache_write: 0, out: 2 } },
    { t: 'priced', u: { in: null, cached: 5, cache_write: 3, out: 0 } },
    { t: 'unknown', u: { in: 4, cached: 0, cache_write: null, out: null } },
    { t: 'priced', u: { in: 0, cached: null, cache_write: 1, out: 3 } },
  ].map((event, i) => ({ run: 'cc', lane: 'cc', ts: start + i * 1000, k: 'usage', ...event }));
  const data = { scope: { kind: 'session', value: 's' }, prices, runs: [{ id: 'cc', kind: 'host', started_at: start, cost_partial: true }], events, hostEnd: start + 5000 };
  const updates = buildReplay(data, {}, start).timeline.filter((m) => m.event === 'run' && m.data.usage).map((m) => m.data);
  assert.equal(updates.length, 4);
  updates.forEach((update, i) => {
    const prefix = events.slice(0, i + 1), cost = hostCost(prefix, prices);
    assert.deepEqual(update.usage, usageTotals(prefix)); assert.equal(update.cost_usd, cost);
    assert.equal(update.cost_source, cost == null ? 'unknown' : 'api_price');
    // 有的消息算不出价时能算的照算，另外标 cost_partial（显示时费用后面带 +）
    assert.equal(!!update.cost_partial, i >= 2);
    // 最终的 run 带着 cost_partial，回放早期（还没播到算不出价的消息）不能继承它
  });
});

test('tailing retries partial JSON and busy reads, retains split UTF-8 and resets on truncation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-feed-')), id = '20261018-214000-test', dir = path.join(root, id);
  fs.mkdirSync(dir);
  const meta = { id, status: 'running', mode: 'exec', started_at: new Date(start).toISOString() };
  // 每次改写都把修改时间往后推：Windows 的文件时间按十几毫秒的刻度走，'EPERM' 和 'EBUSY' 一样长，不推的话大小和时间都相同，会被当成没变
  let stamp = start;
  const writeMeta = (text) => { const f = path.join(dir, 'meta.json'); fs.writeFileSync(f, text); stamp += 1000; fs.utimesSync(f, new Date(stamp), new Date(stamp)); };
  const file = path.join(dir, 'events.jsonl'), feed = createFeed(root), scope = { run: id };
  try {
    writeMeta('{'); assert.equal(feed.read(scope, start).runs.length, 0);
    writeMeta(JSON.stringify(meta));
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      writeMeta(JSON.stringify({ ...meta, title: code }));
      const original = fs.readFileSync;
      const mock = t.mock.method(fs, 'readFileSync', function (file, ...args) {
        if (file === path.join(dir, 'meta.json')) throw Object.assign(new Error(code), { code });
        return original.call(this, file, ...args);
      });
      assert.doesNotThrow(() => feed.read(scope, start)); mock.mock.restore();
      assert.equal(feed.read(scope, start).runs[0].title, code);
    }
    const bytes = Buffer.from(`${JSON.stringify(item('agent_message', { text: '中文' }))}\n`), cut = bytes.indexOf(Buffer.from('中文')) + 1;
    fs.writeFileSync(file, bytes.subarray(0, cut));
    assert.equal(feed.read(scope, start).events.length, 1);
    fs.appendFileSync(file, bytes.subarray(cut, bytes.length - 1));
    assert.equal(feed.read(scope, start).events.length, 1);
    fs.appendFileSync(file, '\n'); assert.equal(feed.read(scope, start).events[1].t, '中文');
    writeMeta('{'); assert.equal(feed.read(scope, start).runs[0].status, 'running');
    writeMeta(JSON.stringify(meta));
    fs.writeFileSync(file, `${JSON.stringify(raw('api.queued'))}\n`);
    assert.deepEqual(feed.read(scope, start).events.map((e) => e.k), ['start', 'queued']);
    fs.appendFileSync(file, `${JSON.stringify(item('command_execution', { category: 'read', tool: 'Read', command: 'Read a' }, 'item.started'))}\n`);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'done', duration_s: 1, usage: { input_tokens: 5, output_tokens: 2 } }));
    const final = feed.read(scope, start + 2000);
    assert.equal(final.runs[0].status, 'done'); assert.equal(final.runs[0].ended_at, start + 1000);
    assert.deepEqual(final.runs[0].usage, { input: 5, cached: null, cache_write: null, output: 2 });
    assert.equal(final.events.find((e) => e.k === 'read').t, 'a');
    assert.equal(final.runs[0].seat, null); assert.equal(final.runs[0].role, null);
  } finally {
    feed.watch(false); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plan records become one fplan event on the Claude Code lane; verdicts are counted per recorded moment', () => {
  const feed = createFeed(fileURLToPath(new URL('./fixtures/board/runs/', import.meta.url)), {});
  const data = feed.read({ replay: 'skills-roles-1018' }, Date.parse('2026-10-19T00:00:00Z'));
  const plans = data.events.filter((e) => e.k === 'fplan');
  assert.equal(plans.length, 1); assert.equal(plans[0].lane, 'cc'); assert.equal(plans[0].seats.length, 5);
  assert.equal(plans[0].ts, Date.parse('2026-10-18T13:40:20.500Z'));
  const verdicts = data.events.filter((e) => e.k === 'verdict');
  assert.equal(verdicts.length, 12); assert.equal(verdicts.filter((e) => e.lane === 'cc').length, 2);
  const first = verdicts.find((e) => e.run === '20261018-214057-66bi');
  assert.deepEqual([first.a.length, first.p.length, first.r.length, first.round], [3, 0, 1, 1]);
});

test('replay can name a Claude Code session: every run that conversation dispatched is in scope', () => {
  const runs = [
    { id: 'a', meta: { group: 'g1', claude_session: 's1', started_at: '2026-10-18T13:40:00Z' } },
    { id: 'b', meta: { group: 'g2', claude_session: 's1', started_at: '2026-10-18T13:50:00Z' } },
    { id: 'c', meta: { group: null, claude_session: 's1', started_at: '2026-10-18T13:55:00Z' } },
    { id: 'd', meta: { group: 'g3', claude_session: 's2', started_at: '2026-10-18T13:56:00Z' } },
  ];
  const picked = selectScope(runs, { replay: 's1' }, Date.parse('2026-10-18T14:00:00Z'));
  assert.equal(picked.scope.kind, 'session'); assert.deepEqual(picked.runs.map((r) => r.id).sort(), ['a', 'b', 'c']);
  assert.equal(selectScope(runs, { replay: 'g2' }, 0).scope.kind, 'group');
});

test('explicit session isolates runs and selects its transcript without runs, retaining live appends', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-session-')), projects = path.join(root, 'claude', 'demo'), runs = path.join(root, 'runs');
  fs.mkdirSync(projects, { recursive: true }); fs.mkdirSync(runs);
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const make = (at, content) => ({ type: 'user', timestamp: new Date(at).toISOString(), message: { content } });
  const file = path.join(projects, 's.jsonl');
  fs.writeFileSync(file, [make(start - 1800001, 'old'), make(start - 1800000, 'boundary'), make(start, 'now')].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(projects, 'other.jsonl'), JSON.stringify(make(start, 'other')) + '\n');
  const feed = createFeed(runs, { claudeDir: path.dirname(projects), now: () => start });
  assert.deepEqual(feed.read({ session: 's' }).events.map((e) => e.t), ['boundary', 'now']);
  fs.appendFileSync(file, JSON.stringify(make(start - 2000000, 'appended')) + '\n');
  assert.equal(feed.read({ session: 's' }, start + 1000).events.at(-1).t, 'appended');
  assert.deepEqual(feed.read({ session: 's', replay: 's' }).scope, { kind: 'session', value: 's' });
  const list = [{ id: 'a', meta: { claude_session: 's' } }, { id: 'b', meta: { claude_session: 'other', parent: 'a' } }];
  assert.deepEqual(selectScope(list, { session: 's' }, start).runs.map((r) => r.id), ['a']);
});

test('a resumed conversation counts the Claude Code usage of its earlier transcripts once (messages copied into the new one are not counted twice)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-prior-')), projects = path.join(root, 'claude', 'demo'), runs = path.join(root, 'runs');
  fs.mkdirSync(projects, { recursive: true }); fs.mkdirSync(runs);
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const answer = (id, at, out) => ({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: id }], usage: { input_tokens: 10, output_tokens: out } } });
  fs.writeFileSync(path.join(projects, 'new.jsonl'), [{ type: 'user', timestamp: new Date(start - 5000).toISOString(), message: { content: 'go' } }, answer('m1', start - 4000, 100), answer('m2', start - 3000, 40)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  // 先前那份记录里的两条：m1 已经抄进新记录，只有 m0 是新增的
  const prior = [{ id: 'm0', ts: start - 90000, t: 'claude-opus-5-5', u: { in: 5, cached: null, cache_write: null, out: 300 } }, { id: 'm1', ts: start - 4000, t: 'claude-opus-5-5', u: { in: 10, cached: null, cache_write: null, out: 100 } }];
  const read = (options) => createFeed(runs, { claudeDir: path.dirname(projects), now: () => start, ...options }).read({ session: 'new' }).runs.find((r) => r.id === 'cc');
  assert.equal(read({}).usage.output, 140);
  assert.equal(read({ priorUsage: (id) => (id === 'new' ? prior : []) }).usage.output, 440);
});

test('a conversation of 200k lines opens without overflowing the stack (no push(...lines))', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-long-')), projects = path.join(root, 'claude', 'demo'), runs = path.join(root, 'runs');
  fs.mkdirSync(projects, { recursive: true }); fs.mkdirSync(runs);
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const lines = [];
  for (let i = 0; i < 200000; i++) lines.push(JSON.stringify({ type: 'user', timestamp: new Date(start - 200000 + i).toISOString(), message: { content: 'x' } }));
  fs.writeFileSync(path.join(projects, 'long.jsonl'), lines.join('\n') + '\n');
  const data = createFeed(runs, { claudeDir: path.dirname(projects), now: () => start }).read({ session: 'long' });
  assert.equal(data.runs[0].id, 'cc'); assert.equal(data.events.length, 200000);
});

test('run messages carry the Claude Code conversation that dispatched them, so an old group or run link can fly into it', () => {
  const feed = createFeed(fileURLToPath(new URL('./fixtures/board/runs/', import.meta.url)), {});
  const runs = feed.read({ group: 'skills-roles-1018' }, Date.parse('2026-10-19T00:00:00Z')).runs.filter((r) => r.id !== 'cc');
  assert.ok(runs.length > 0);
  assert.ok(runs.every((r) => r.session === '00000000-0000-4000-8000-0000000d3e40'), JSON.stringify(runs.map((r) => r.session)));
});

test('已结束却没写结束时间的旧记录，按最后一次写事件的时刻算结束，不再一直显示在跑', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-ended-')), dir = path.join(root, '20000101-000000-gone');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(dir);
  const startedAt = Date.parse('2026-10-23T15:14:10Z'), lastEvent = Date.parse('2026-10-23T15:14:40Z');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ kind: 'exec', mode: 'run', group: 'gone', status: 'interrupted', pid: 999999,
    started_at: new Date(startedAt).toISOString(), dismissed_at: '2026-10-23T15:20:00Z', title: 't', model: 'm' }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'turn.started', ts: new Date(startedAt + 1000).toISOString() }) + '\n');
  fs.utimesSync(path.join(dir, 'events.jsonl'), lastEvent / 1000, lastEvent / 1000);
  const data = createFeed(root).read({ group: 'gone' }, Date.parse('2026-10-24T03:00:00Z'));
  const run = data.runs.find((r) => r.id === '20000101-000000-gone');
  assert.equal(run.status, 'interrupted');
  assert.equal(run.ended_at, lastEvent);
});

test('排队最多带 30 张票据并报总数，标题按 160 字截', (t) => {
  const h = sandbox(t), group = 'queue-many', dir = path.join(h.runs, '.state/queue/codex'), at = Date.now();
  for (let i = 1; i <= 35; i++) write(path.join(dir, `${i}.json`), { pid: process.pid, pid_started_at: new Date(Math.ceil(performance.timeOrigin)).toISOString(),
    expires_at: new Date(at + 60000).toISOString(), queued_at: new Date(at - 1000 + i).toISOString(), agent: 'codex', claude_session: 'test-session', group,
    plan: 'p', seat: i, title: 'x'.repeat(500), sequence: i });
  seedRun(h, '20000101-000001-seat', { group, plan: 'p', seat: 99, started_at: new Date(at - 60000).toISOString() });
  const queue = createFeed(h.runs).read({ session: 'test-session' }, at).events.find((e) => e.k === 'dispatch_queue');
  assert.equal(queue.tickets.length, 30); assert.equal(queue.total, 35);
  assert.ok(queue.tickets.every((q) => q.title.length <= 160));
});

test('卡片产出框的改动清单不含同组别的任务改的文件', () => {
  const run = { id: 'r', dir: 'x', meta: { kind: 'exec', status: 'done', started_at: '2026-10-24T10:00:00Z', ended_at: '2026-10-24T10:01:00Z' }, tail: { state: {} },
    result: { status: 'done', changes: { files: [{ path: 'mine.mjs', by: 'agent' }, { path: 'theirs.mjs', by: 'unknown', group_run: 'other' }, { path: 'seen.mjs', by: 'unknown' }] } } };
  assert.deepEqual(runMessage(run, 'r').changed.map((f) => f.path), ['mine.mjs', 'seen.mjs']);
});
