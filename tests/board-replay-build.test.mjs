import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createUniverse, universeAt } from '../foreman/skills/dispatch/scripts/board/universe.mjs';
import { createFeed, buildReplay, snapshotAt } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { loadPrices } from '../foreman/skills/dispatch/scripts/prices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), fixtures = path.join(here, 'fixtures/board');
const now = Date.parse('2026-10-22T09:03:30Z'), prices = loadPrices(path.join(fixtures, 'prices-test.json'));
const options = { runs: path.join(fixtures, 'universe/runs'), claudeDir: path.join(fixtures, 'universe/claude'), config: path.join(fixtures, 'universe/config.json'), prices };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function golden() {
  const universe = createUniverse(options), indexed = universe.read(now), replay = universe.replay({ speed: 2, maxgap: 20 }, now);
  const times = [];
  for (const folder of fs.readdirSync(options.claudeDir)) {
    const dir = path.join(options.claudeDir, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
      for (const line of fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n')) {
        try { times.push(Date.parse(JSON.parse(line).timestamp)); } catch { /* 样例中的坏行也保留原来的跳过语义。 */ }
      }
    }
  }
  const own = indexed.sessions.map(({ id }) => {
    const data = createFeed(options.runs, { ...options, transcript: path.join(options.claudeDir, fs.readdirSync(options.claudeDir).find((dir) => fs.existsSync(path.join(options.claudeDir, dir, `${id}.jsonl`))), `${id}.jsonl`) }).read({ session: id, replay: id }, now);
    return [id, buildReplay(data, { speed: 2, maxgap: 20 }, now)];
  });
  const runs = createFeed(path.join(fixtures, 'runs'), { prices }).read({ replay: 'skills-roles-1018' }, now);
  const built = buildReplay(runs, { speed: 3, maxgap: 0.2 }, now);
  return {
    hello: hash(replay.hello), initial: hash(replay.initial), timeline: hash(replay.timeline),
    clock: hash({ replay: replay.clock.replay, mapped: times.map((t) => [t, replay.clock.map(t)]) }),
    detail: hash(indexed.sessions.map(({ id }) => [id, replay.detail(id)])),
    buildReplay: hash({ own, runs: built }),
    snapshots: hash({ universe: [0, 1, 20, 180, Infinity].map((t) => universeAt(replay, t)), runs: [0, 1, 20, Infinity].map((t) => snapshotAt(built, t)) }),
  };
}

// display 里加了问题、报错的原条数（questions_total、errors_total、decision_requests_total）以后，buildReplay、detail、snapshots 三个哈希更新；
// 去掉这三个字段算出的哈希和之前完全一样。
// 宇宙对话摘要加了 issues（还在进行的组里出了问题的席位）以后，timeline、snapshots 两个哈希更新；去掉 issues 算出的七个哈希和之前完全一样
// 动作事件增加 aid 后更新 detail、buildReplay、snapshots；递归去掉 aid 算出的七个哈希和改前完全一样。
// 协作方的多行消息连成一行、Claude Code 的费用改成能算的照算（加 cost_partial）以后，buildReplay、snapshots 再更新；
// 去掉 aid、费用字段和 msg 事件的正文后，七个哈希和改前的代码算出的完全一样
// 宇宙对话摘要加了 prompt_at（最近一条用户消息的时间）以后，timeline、snapshots 再更新；递归去掉 prompt_at 算出的七个哈希和改前完全一样
test('replay output matches SHA256 after auditing original-time additions against the fixture baseline', () => {
  // 已与返工前消息逐字段核对：仅显示字段和历史队列载荷变化；开始消息不提前携带结论，时钟及调度不变。
  // 对话摘要加了 models（用过的模型和输出量，星系的配色用）以后 timeline、snapshots 两个哈希更新；去掉 models 后和原来的一模一样。
  assert.deepEqual(golden(), {
    hello: 'dd6d6628b6d0fd85c66d16e1f24a2de8a5dfa93ecaebfcf40fcade0540733508',
    initial: '616a456690c5e135fd70a2b9767f92f7d530100cccdb86e75e9693c1f7b0e236',
    timeline: '44cdbf632a6314bcc0fe93078dbd3a798e64115acdd8a818f9064dd9a68ab80a',
    clock: '09ab08ee5a6cec0f81855ecc0900a233a658523e80cf31681f62870837f2fa49',
    detail: '59f25409291918485abb3af6065893facf4e00af6c5b849ae87510bb2992f119',
    buildReplay: '3be480362a19d718a0560a9c0573da0005d45cce222199207906ae81e26fe799',
    snapshots: 'b616d6f7040d9a57f7b47c1fe79e3af7917668f72ff66ff70a2e13d1a3b22a0f',
  });
});

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-replay-'));
  const options = { runs: path.join(root, 'runs'), claudeDir: path.join(root, 'claude'), config: path.join(root, 'config.json'), prices };
  fs.mkdirSync(options.runs); fs.mkdirSync(options.claudeDir); fs.writeFileSync(options.config, '{}');
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const row = (at, text) => ({ type: 'user', timestamp: new Date(at).toISOString(), cwd: 'D:/demo', message: { content: text } });
  const session = (id, rows = [row(now - 1000, id)], mtime = now) => {
    const file = write(path.join(options.claudeDir, 'demo', `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(file, new Date(mtime), new Date(mtime)); return file;
  };
  const run = (id, session) => {
    const dir = path.join(options.runs, id);
    return [write(path.join(dir, 'meta.json'), { id, claude_session: session, kind: 'exec', agent: 'a', status: 'done', started_at: now - 10000, ended_at: now - 1000 }),
      write(path.join(dir, 'result.json'), { status: 'done', last_message: id }),
      write(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'api.queued', ts: now - 5000 }) + '\n')];
  };
  return { options, session, run, row };
}

test('sessions confines transcript/result/event reads and details reuse the frozen shared data', (t) => {
  const f = temp(t), selected = [f.session('a'), ...f.run('task-a', 'a')], skipped = [f.session('b'), ...f.run('task-b', 'b')];
  const reads = new Map(), read = fs.readFileSync, open = fs.openSync;
  const record = (file) => { assert.ok(![skipped[0], ...skipped.slice(2)].includes(file), `unselected payload ${file}`); reads.set(file, (reads.get(file) || 0) + 1); };
  t.mock.method(fs, 'readFileSync', function (file, ...args) { record(file); return read.call(this, file, ...args); });
  t.mock.method(fs, 'openSync', function (file, ...args) { record(file); return open.call(this, file, ...args); });
  const replay = createUniverse(f.options).replay({ sessions: ['a', 'a', 'missing'] }, now);
  assert.deepEqual(universeAt(replay).sessions.map((s) => s.id), ['a']);
  assert.equal(replay.detail('b'), null); assert.equal(replay.detail('missing'), null);
  for (const file of selected) assert.equal(reads.get(file), 1, file);
  const count = [...reads], detail = replay.detail('a');
  assert.deepEqual([...reads], count);
  assert.ok(detail.timeline.some((m) => m.data.run === 'task-a'));
  fs.appendFileSync(selected[0], JSON.stringify(f.row(now, 'newly appended')) + '\n');
  assert.deepEqual(replay.detail('a'), detail); assert.deepEqual([...reads], count);
});

test('shared replay opens each selected task meta/result/events once across conversations', (t) => {
  const f = temp(t), files = [f.session('a'), f.session('b'), ...f.run('task-a', 'a'), ...f.run('task-b', 'b')];
  const reads = new Map(), read = fs.readFileSync, open = fs.openSync;
  const record = (file) => reads.set(file, (reads.get(file) || 0) + 1);
  t.mock.method(fs, 'readFileSync', function (file, ...args) { record(file); return read.call(this, file, ...args); });
  t.mock.method(fs, 'openSync', function (file, ...args) { record(file); return open.call(this, file, ...args); });
  const replay = createUniverse(f.options).replay({}, now);
  replay.detail('a'); replay.detail('b');
  for (const file of files) assert.equal(reads.get(file), 1, file);
});

test('size preflight includes all selected files and rejects before opening any payload', (t) => {
  const f = temp(t), files = [f.session('a'), ...f.run('task-a', 'a')], bytes = files.reduce((n, file) => n + fs.statSync(file).size, 0);
  f.session('b', [f.row(now, 'x'.repeat(10000))]); f.run('task-b', 'b');
  const read = fs.readFileSync, open = fs.openSync, payloads = new Set([files[0], ...files.slice(2)]);
  const readMock = t.mock.method(fs, 'readFileSync', function (file, ...args) { assert.ok(!payloads.has(file)); return read.call(this, file, ...args); });
  const openMock = t.mock.method(fs, 'openSync', function (file, ...args) { assert.ok(!payloads.has(file)); return open.call(this, file, ...args); });
  assert.throws(() => createUniverse({ ...f.options, replayLimitBytes: bytes - 1 }).replay({ sessions: ['a'] }, now),
    (err) => err.message === 'replay too large' && err.code === 'REPLAY_TOO_LARGE' && err.bytes === bytes && err.limit === bytes - 1);
  readMock.mock.restore(); openMock.mock.restore();
  assert.ok(createUniverse({ ...f.options, replayLimitBytes: bytes }).replay({ sessions: ['a'] }, now).detail('a'));
  const universe = createUniverse({ ...f.options, replayLimitBytes: 1 });
  t.mock.method(fs, 'readFileSync', function (file, ...args) { assert.ok(!payloads.has(file)); return read.call(this, file, ...args); });
  t.mock.method(fs, 'openSync', function (file, ...args) { assert.ok(!payloads.has(file)); return open.call(this, file, ...args); });
  assert.throws(() => universe.replay({ sessions: ['a'] }, now), (err) => err.code === 'REPLAY_TOO_LARGE' && err.bytes === bytes && err.limit === 1);
  const empty = universe.replay({ sessions: [] }, now);
  assert.equal(empty.timeline.length, 0); assert.equal(empty.detail('a'), null);
});

test('explicit sessions can name old files; omitted sessions preserve the live window', (t) => {
  const f = temp(t), at = now - 2 * 86400000;
  f.session('old', [f.row(at, 'old prompt')], at);
  assert.equal(createUniverse(f.options).replay({}, now).detail('old'), null);
  assert.ok(createUniverse(f.options).replay({ sessions: ['old'] }, now).detail('old').timeline.some((m) => m.data.t === 'old prompt'));
});

test('replay keeps message replacement/retraction, unpriced usage, and the whole usage until the conversation leaves the window', (t) => {
  const f = temp(t), base = now - 100000;
  const answer = (dt, id, usage, model = 'claude-opus-5-5') => ({ type: 'assistant', timestamp: new Date(base + dt).toISOString(), cwd: 'D:/demo',
    message: { id, model, content: [], stop_reason: 'end_turn', ...(usage ? { usage: { input_tokens: usage } } : {}) } });
  f.session('s', [f.row(base, 'prompt'), answer(1000, 'same', 2), answer(2000, 'same', 5), answer(3000, 'same'), answer(4000, 'unknown', 1, 'unpriced'),
    { ...answer(5000, 'tool'), message: { content: [{ type: 'tool_use', name: 'Read', id: 'read', input: {} }], stop_reason: 'end_turn' } }]);
  f.session('later', [f.row(base + 2 * 3600000, 'later')]);
  const replay = createUniverse({ ...f.options, windowH: 1 }).replay({ maxgap: Number.MAX_VALUE }, now);
  const at = (dt) => universeAt(replay, (base + dt - replay.hello.replay.start) / 1000);
  const s = (dt) => at(dt).sessions.find((s) => s.id === 's');
  assert.equal(s(1000).usage.input, 2); assert.equal(s(2000).usage.input, 5); assert.equal(s(3000).usage.input, null);
  assert.equal(s(4000).usage.input, 1); assert.equal(s(4000).cost_usd, null); assert.equal(s(4000).cost_partial, true);
  assert.equal(s(604999).state, 'thinking'); assert.equal(s(605000).state, 'idle');
  // 一行是对话的全部：用量不随窗口到期，对话还列着就一直在
  assert.equal(s(3604000).usage.input, 1); assert.equal(s(3604001).usage.input, 1);
  assert.ok(s(3605000)); assert.equal(s(3605001), undefined);
  assert.equal(at(3605001).projects[0].older, 1);
  assert.equal(replay.detail('s').timeline.filter((m) => m.event === 'ev' && m.data.k === 'usage').length, 1);
});

test('fractional clocks expire other sessions at the first existing step past a strict threshold', (t) => {
  const f = temp(t), base = now - 10000;
  f.session('a', [f.row(base, 'a')]);
  f.session('b', [1000, 2000, 3000].map((dt) => f.row(base + dt, 'b')));
  const replay = createUniverse({ ...f.options, windowH: 1 / 3600000 }).replay({ sessions: ['a', 'b'], maxgap: 0.0005 }, now);
  assert.equal(replay.timeline.find((m) => m.event === 'session_gone' && m.data.id === 'a').time, base + 1.5);
});
