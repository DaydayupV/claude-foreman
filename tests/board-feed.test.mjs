import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalize, laneOf, selectScope, buildReplay, snapshotAt, createFeed } from '../foreman/skills/dispatch/scripts/board/feed.mjs';

const start = Date.parse('2026-10-18T13:40:00Z');
const run = { id: 'one', lane: 'root', meta: { cwd: 'C:\\work' } };
const raw = (type, fields = {}, dt = 0) => ({ type, ts: start + dt, ...fields });
const item = (type, fields, phase = 'item.completed', dt = 0) => raw(phase, { item: { id: 'tool', type, ...fields } }, dt);

test('messages, reports, PowerShell, tools, edits and the remaining protocol events', () => {
  const take = (event) => normalize(event, run, {});
  assert.equal(take(item('agent_message', { text: '\nhello\nsecond' }))[0].t, 'hello');
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
  assert.deepEqual(take(raw('api.repair')), []);
  const long = take(raw('error', { message: `${'x'.repeat(170)}\nsecond` }))[0];
  assert.equal(long.t.length, 160); assert.ok(!long.t.includes('\n'));
  assert.equal(long.run, 'one'); assert.equal(long.lane, 'root');
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
