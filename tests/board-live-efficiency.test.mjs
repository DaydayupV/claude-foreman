import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createFeed, readLines, newTail } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { createUniverse } from '../foreman/skills/dispatch/scripts/board/universe.mjs';
import { loadPrices } from '../foreman/skills/dispatch/scripts/prices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), base = Date.parse('2026-10-18T13:40:00Z');
const hash = (data) => createHash('sha256').update(JSON.stringify({ cc: data.runs.find((r) => r.id === 'cc'), events: data.events })).digest('hex');
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-live-efficiency-test-')), runs = path.join(root, 'runs'), file = path.join(root, 's.jsonl');
  fs.mkdirSync(runs);
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runs, file };
}
const row = (id, dt, content, usage, cwd = 'C:/demo') => ({ type: 'assistant', timestamp: new Date(base + dt).toISOString(), cwd, sessionId: 's', message: { id, model: 'claude-opus-5-5', content, ...(usage ? { usage } : {}) } });
const write = (file, rows, append = false) => fs[append ? 'appendFileSync' : 'writeFileSync'](file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

test('readLines with a needle parses only the lines containing it and still reads to the end', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-needle-')), file = path.join(dir, 'x.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 多字节字符跨在被跳过的行里，不能影响后面的行
  fs.writeFileSync(file, ['{"a":"跳过的一行 ✓"}', '{"usage":1}', '{"b":"又一行"}', '{"usage":2,"t":"中文"}'].join('\n') + '\n');
  const seen = [], read = readLines(file, newTail(), (row) => seen.push(row), undefined, Buffer.from('"usage"'));
  assert.deepEqual(seen, [{ usage: 1 }, { usage: 2, t: '中文' }]);
  assert.equal(read.tail.offset, fs.statSync(file).size);
});

test('live fixture output matches the original parser including versions and revisions', () => {
  const runs = path.join(here, 'fixtures/board/runs'), transcript = path.join(here, 'fixtures/board/transcript-sample.jsonl');
  const feed = createFeed(runs, { transcript, prices: loadPrices(path.join(here, 'fixtures/board/prices-test.json')) });
  const hashes = [];
  for (const scope of [{ session: 'synthetic-session' }, { group: 'skills-roles-1018' }, { session: 'synthetic-session' }]) {
    const data = feed.read(scope, base); hashes.push(hash(data));
    assert.deepEqual(data.versions, Object.fromEntries(data.runs.map((r) => [r.id, r.id === 'cc' ? `${transcript}:0` : 0])));
    const signature = (file) => { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; };
    assert.deepEqual(data.revisions, Object.fromEntries(data.runs.map((r) => [r.id, r.id === 'cc' ? '' : `${signature(path.join(runs, r.id, 'meta.json'))}:${signature(path.join(runs, r.id, 'result.json'))}`])));
  }
  // 在修改生产实现之前取值；哈希覆盖完整的 cc 消息和全部事件，文件签名单独逐项检查。
  // 命令事件加了 aid、协作方的多行消息连成一行以后更新；去掉 aid 和费用字段后，剩下的差别只来自多行消息
  assert.deepEqual(hashes, ['52ad0eb6d048a7295b85a7a586f9e8f1829bd67610327c94f986ed638efb680a', '3a6a6d0f52d32e6816b64c2c031844e5ef35807fb44150ea8065a88591a0fe5c', '52ad0eb6d048a7295b85a7a586f9e8f1829bd67610327c94f986ed638efb680a']);
});

test('appending message chunks preserves original last-row usage, event order and final cwd', (t) => {
  const f = temp(t), feed = createFeed(f.runs, { transcript: f.file, prices: loadPrices(path.join(here, 'fixtures/board/prices-test.json')) });
  write(f.file, [{ type: 'custom-title', customTitle: 'chunks' },
    row('shared', -90, [{ type: 'thinking', thinking: 'first' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'src/a.mjs' } }, { type: 'tool_use', id: 'cmd', name: 'Bash', input: { command: 'echo test' } }], { input_tokens: 1, output_tokens: 1 }),
    row('other', -80, [{ type: 'text', text: 'between' }], { input_tokens: 0, cache_read_input_tokens: 5, output_tokens: 3 })]);
  const first = feed.read({ session: 's' }, base), frozen = JSON.stringify(first), hashes = [hash(first)];
  const additions = [
    [row('shared', -70, [{ type: 'text', text: 'last chunk' }], { input_tokens: 10, output_tokens: 9 }, 'D:/other')],
    [row('shared', -60, [], null)],
    [{ type: 'user', timestamp: new Date(base - 50).toISOString(), cwd: 'E:/final', sessionId: 's', message: { content: [{ type: 'tool_result', tool_use_id: 'cmd', is_error: true }] } }, { type: 'custom-title', customTitle: 'finished' }, row('shared', -40, [], { input_tokens: 0, cache_creation_input_tokens: 0 }, 'E:/final')],
  ];
  additions.forEach((rows, i) => { write(f.file, rows, true); hashes.push(hash(feed.read({ session: 's' }, base + (i + 1) * 1000))); });
  assert.equal(JSON.stringify(first), frozen);
  // Claude Code 的命令事件加了 aid（tool_use.id）、费用加了 cost_partial 以后更新；去掉这两个字段算出的哈希和改前完全一样
  assert.deepEqual(hashes, ['3d3baa52e67c5f936d37a90df56b1abfc23faf7f4709f3e6a93fbbac873d72ed', 'fb76f955e6ee21f133257ee9c79eca1cd043c928f5e1976331bb6c6574dc6337', 'd03bca40df9a9cfbd31caadbe9cb428608201081a4847021a4a833328ec708fb', '4a58c42e2eda859630d01c3c066d9d69fc17275b463c2bbdd49171120748f98a']);
  assert.deepEqual(feed.read({ session: 's' }, base + 4000).versions, { cc: `${f.file}:0` });
  assert.deepEqual(feed.read({ session: 's' }, base + 4000).revisions, { cc: '' });
});

test('running group and run windows reuse unchanged logs and retain the original moving cutoff', (t) => {
  const f = temp(t), dir = path.join(f.runs, 'work'), metaFile = path.join(dir, 'meta.json'); fs.mkdirSync(dir);
  const meta = { status: 'running', pid: process.pid, started_at: new Date(base).toISOString(), claude_session: 's', group: 'g' };
  write(f.file, [row('shared', 0, [{ type: 'text', text: 'present' }], { input_tokens: 1, output_tokens: 1 }),
    row('boundary', 300000, [{ type: 'text', text: 'boundary' }], { input_tokens: 2, output_tokens: 2 }),
    row('shared', 305000, [{ type: 'text', text: 'future' }], { input_tokens: 3, output_tokens: 3 }),
    row('later', 400000, [{ type: 'text', text: 'excluded' }], { input_tokens: 4, output_tokens: 4 })]);
  const open = fs.openSync; let reads = 0; const observed = [];
  t.mock.method(fs, 'openSync', function (file, ...args) { if (file === f.file) reads++; return open.call(this, file, ...args); });
  for (const scope of [{ group: 'g' }, { run: 'work' }]) {
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    const feed = createFeed(f.runs, { transcript: f.file }), counts = [], hashes = []; reads = 0;
    for (const dt of [0, 1000, 2000, 5000, 6000, 7000, 8000]) {
      if (dt === 7000) fs.writeFileSync(metaFile, JSON.stringify({ ...meta, status: 'done', ended_at: new Date(base + 2000).toISOString() }));
      const data = feed.read(scope, base + dt); counts.push(reads); hashes.push(hash(data));
      assert.equal(data.hostEnd, base + (dt >= 7000 ? 2000 : dt) + 300000);
      assert.deepEqual(data.versions, { work: 0, cc: `${f.file}:0` });
      const st = fs.statSync(metaFile); assert.deepEqual(data.revisions, { work: `${st.size}:${st.mtimeMs}:undefined`, cc: '' });
    }
    // 先在返工前实现上取值，覆盖未来行进入窗口和任务结束后排除未来行的输出。
    assert.deepEqual(hashes, ['03ed038e727b378f189cde9482d658da576e4f6203227d6e3331821c20fda313', '03ed038e727b378f189cde9482d658da576e4f6203227d6e3331821c20fda313', '03ed038e727b378f189cde9482d658da576e4f6203227d6e3331821c20fda313', 'a76727369e670ddde7e2387fb08a86076681802e8889085f4fd6ab1cd0616b72', 'a76727369e670ddde7e2387fb08a86076681802e8889085f4fd6ab1cd0616b72', 'ffdbb496d95f8b4ea2c7cf133e183c95d61fa6ae54bf08ebfeafdb145fd8da5c', 'ffdbb496d95f8b4ea2c7cf133e183c95d61fa6ae54bf08ebfeafdb145fd8da5c']);
    observed.push(counts);
  }
  assert.deepEqual(observed, [[1, 1, 1, 2, 2, 3, 3], [1, 1, 1, 2, 2, 3, 3]]);
});

test('unchanged detail reuses events; appends parse only new rows, scope changes and truncation rebuild', (t) => {
  const f = temp(t), id = '20261018-214000-test', dir = path.join(f.runs, id);
  fs.mkdirSync(dir);
  const meta = { status: 'done', started_at: base, ended_at: base + 1000, claude_session: 's', mode: 'exec', group: 'g' };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  write(f.file, [row('old', -700000, [{ type: 'text', text: 'outside group' }]), row('one', 0, [{ type: 'text', text: 'one' }])]);
  const parse = JSON.parse; let parsed = 0;
  t.mock.method(JSON, 'parse', function (text, ...args) { if (text.includes('"sessionId":"s"')) parsed++; return parse.call(this, text, ...args); });
  const feed = createFeed(f.runs, { transcript: f.file }), scope = { session: 's' };
  const first = feed.read(scope, base); assert.equal(parsed, 2);
  const second = feed.read(scope, base + 1000); assert.equal(parsed, 2);
  assert.strictEqual(second.events.find((e) => e.run === 'cc'), first.events.find((e) => e.run === 'cc'));
  write(f.file, [row('two', 1, [{ type: 'text', text: 'two' }])], true);
  feed.read(scope, base + 2000); assert.equal(parsed, 3);
  const open = fs.openSync;
  const busy = t.mock.method(fs, 'openSync', function (file, ...args) { if (file === f.file) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return open.call(this, file, ...args); });
  assert.doesNotThrow(() => feed.read({ group: 'g' }, base)); busy.mock.restore();
  assert.deepEqual(feed.read({ group: 'g' }, base).events.filter((e) => e.run === 'cc').map((e) => e.t), ['one', 'two']); assert.equal(parsed, 6);
  feed.read(scope, base); assert.equal(parsed, 9);
  fs.mkdirSync(path.join(f.runs, 'child'));
  fs.writeFileSync(path.join(f.runs, 'child', 'meta.json'), JSON.stringify({ ...meta, parent: id }));
  feed.read(scope, base); assert.equal(parsed, 12);
  write(f.file, [row('reset', 0, [])]);
  const reset = feed.read(scope, base); assert.equal(parsed, 13); assert.equal(reset.versions.cc, `${f.file}:1`);
  assert.deepEqual(reset.events.filter((e) => e.run === 'cc'), []);
});

test('a window rebuild leaves concurrent appends for the next tail read without duplicates', (t) => {
  const f = temp(t), dir = path.join(f.runs, 'work'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ status: 'done', started_at: base, ended_at: base, claude_session: 's', group: 'g' }));
  write(f.file, [row('one', 0, [{ type: 'text', text: 'one' }])]);
  const feed = createFeed(f.runs, { transcript: f.file }); feed.read({ session: 's' }, base);
  const stat = fs.statSync; let calls = 0;
  t.mock.method(fs, 'statSync', function (file, ...args) {
    if (file === f.file && ++calls === 3) write(f.file, [row('two', 1, [{ type: 'text', text: 'two' }])], true);
    return stat.call(this, file, ...args);
  });
  const messages = () => feed.read({ group: 'g' }, base).events.filter((e) => e.run === 'cc').map((e) => e.t);
  assert.deepEqual(messages(), ['one']);
  assert.deepEqual(messages(), ['one', 'two']);
  assert.deepEqual(messages(), ['one', 'two']);
});

test('a conversation board reads its whole transcript even when a task start is invalid, live and in replay', (t) => {
  const f = temp(t), dir = path.join(f.runs, 'work'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ status: 'done', started_at: 'invalid', ended_at: base, claude_session: 's' }));
  write(f.file, [row('one', 0, [{ type: 'text', text: 'one' }])]);
  const feed = createFeed(f.runs, { transcript: f.file });
  // 选了对话的看板是整个对话：任务的开始时间写坏了也不影响 Claude Code 那一行
  const cc = (params) => feed.read(params, base).events.filter((e) => e.run === 'cc').map((e) => e.t);
  assert.deepEqual(cc({ session: 's' }), ['one']);
  assert.deepEqual(cc({ session: 's', replay: 's' }), ['one']);
  assert.deepEqual(cc({ session: 's' }), ['one']);
});

test('an open group rebuilds when an invalid end becomes a valid cutoff', (t) => {
  const f = temp(t), bad = path.join(f.runs, 'bad'), active = path.join(f.runs, 'active'); fs.mkdirSync(bad); fs.mkdirSync(active);
  const meta = { status: 'running', pid: process.pid, started_at: new Date(base).toISOString(), claude_session: 's', group: 'g' };
  fs.writeFileSync(path.join(bad, 'meta.json'), JSON.stringify({ ...meta, status: 'done', ended_at: 'invalid' }));
  fs.writeFileSync(path.join(active, 'meta.json'), JSON.stringify(meta)); write(f.file, [row('one', 0, [{ type: 'text', text: 'one' }])]);
  const feed = createFeed(f.runs, { transcript: f.file });
  assert.equal(feed.read({ group: 'g' }, base).runs.some((r) => r.id === 'cc'), false);
  fs.writeFileSync(path.join(bad, 'meta.json'), JSON.stringify({ ...meta, status: 'done', ended_at: new Date(base).toISOString() }));
  assert.deepEqual(feed.read({ group: 'g' }, base + 1000).events.filter((e) => e.run === 'cc').map((e) => e.t), ['one']);
});

for (const mode of ['replace same size', 'replace larger', 'truncate regrow same size', 'truncate regrow larger']) {
  test(`tail and universe reset on ${mode}`, (t) => {
    const f = temp(t), project = path.join(f.root, 'project'), config = path.join(f.root, 'config.json'); fs.mkdirSync(project); fs.writeFileSync(config, '{}');
    const file = path.join(project, 's.jsonl'), options = { runs: f.runs, claudeDir: f.root, config, prices: loadPrices(path.join(here, 'fixtures/board/prices-test.json')) };
    const old = row('old', 0, [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [{ header: 'old' }] } }], { input_tokens: 10, output_tokens: 1 }); old.padding = 'x'.repeat(1024);
    write(file, [{ type: 'custom-title', customTitle: 'old' }, old]); fs.utimesSync(file, new Date(base), new Date(base));
    const before = fs.statSync(file), feed = createFeed(f.runs, { ...options, transcript: file }), universe = createUniverse(options);
    let tail = readLines(file, newTail()).tail;
    assert.equal(feed.read({ session: 's' }, base).runs[0].usage.input, 10);
    assert.equal(universe.read(base).sessions[0].waiting.header, 'old');
    const next = row('new', 1000, [{ type: 'text', text: 'replacement' }], { input_tokens: 20, output_tokens: 2 }, 'D:/new'); next.message.stop_reason = 'end_turn'; next.padding = '';
    const rows = [{ type: 'custom-title', customTitle: 'new' }, next], encode = () => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const bytes = before.size + (mode.endsWith('larger') ? 256 : 0); next.padding = 'x'.repeat(bytes - Buffer.byteLength(encode()));
    if (mode.startsWith('replace')) fs.renameSync(file, path.join(f.root, 'previous.log'));
    else fs.truncateSync(file, 0);
    fs.writeFileSync(file, encode()); fs.utimesSync(file, new Date(base + 1000), new Date(base + 1000));
    const after = fs.statSync(file); assert.equal(after.size, bytes);
    if (mode.startsWith('replace')) assert.notEqual(after.ino, before.ino);
    else { assert.equal(after.ino, before.ino); assert.equal(after.birthtimeMs, before.birthtimeMs); }
    const read = fs.readSync; let starts = 0;
    const reads = t.mock.method(fs, 'readSync', function (...args) { if (args[4] === 0) starts++; return read.apply(this, args); });
    const replaced = readLines(file, tail); tail = replaced.tail; reads.mock.restore();
    assert.equal(tail.version, 1); assert.deepEqual(replaced.lines, rows);
    // 换了文件、或者大小没长却改过（只追加的日志不会这样）：直接整份重读一次；变大了才先核对开头和末尾的样本，再重读
    assert.equal(starts, mode === 'truncate regrow larger' ? 2 : 1);
    const detail = feed.read({ session: 's' }, base + 2000);
    assert.equal(detail.versions.cc, `${file}:1`); assert.deepEqual(detail.events.filter((e) => e.k !== 'usage').map((e) => e.t), ['replacement']);
    assert.equal(detail.runs[0].title, 'new'); assert.equal(detail.runs[0].cwd, 'D:/new'); assert.equal(detail.runs[0].usage.input, 20);
    const index = universe.read(base + 2000); assert.deepEqual(index, createUniverse(options).read(base + 2000));
    assert.equal(index.sessions[0].waiting, null); assert.equal(index.sessions[0].started_at, base + 1000); assert.equal(index.sessions[0].usage.input, 20);
    assert.deepEqual(readLines(file, tail).lines, []);
    const parse = JSON.parse; let parsed = 0;
    t.mock.method(JSON, 'parse', function (text, ...args) { if (text.includes('"sessionId":"s"')) parsed++; return parse.call(this, text, ...args); });
    write(file, [row('followup', 2000, [], { input_tokens: 4, output_tokens: 3 })], true);
    const appended = readLines(file, tail); assert.equal(appended.tail.version, 1); assert.equal(appended.lines.length, 1);
    assert.equal(feed.read({ session: 's' }, base + 3000).runs[0].usage.input, 24);
    assert.equal(universe.read(base + 3000).sessions[0].usage.input, 24); assert.equal(parsed, 3);
  });
}

test('zero inode retains size-based truncation detection and incremental appends', (t) => {
  const f = temp(t), stat = fs.statSync;
  t.mock.method(fs, 'statSync', function (...args) { const st = stat.apply(this, args); st.ino = 0; return st; });
  write(f.file, [row('first', 0, [{ type: 'text', text: 'x'.repeat(128) }])]);
  let tail = readLines(f.file, newTail()).tail;
  write(f.file, [row('next', 1, [])], true);
  let read = readLines(f.file, tail); tail = read.tail; assert.equal(tail.version, 0); assert.equal(read.lines.length, 1);
  write(f.file, [row('reset', 2, [])]);
  read = readLines(f.file, tail); assert.equal(read.tail.version, 1); assert.equal(read.lines[0].message.id, 'reset');
});

test('watch notifications have a ten-second directory rescan fallback', (t) => {
  const f = temp(t), watcher = new EventEmitter(); watcher.close = () => {};
  t.mock.method(fs, 'watch', () => watcher);
  const readdir = fs.readdirSync; let lists = 0;
  t.mock.method(fs, 'readdirSync', function (dir, ...args) { if (dir === f.runs) lists++; return readdir.call(this, dir, ...args); });
  const feed = createFeed(f.runs); feed.watch(true); t.after(() => feed.watch(false));
  feed.read({ session: 's' }, base); assert.equal(lists, 1);
  const dir = path.join(f.runs, 'new'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ status: 'done', started_at: base, ended_at: base, claude_session: 's' }));
  assert.equal(feed.read({ session: 's' }, base + 9999).runs.length, 0); assert.equal(lists, 1);
  assert.equal(feed.read({ session: 's' }, base + 10000).runs[0].id, 'new'); assert.equal(lists, 2);
  feed.read({ session: 's' }, base + 19999); assert.equal(lists, 2);
  feed.read({ session: 's' }, base + 20000); assert.equal(lists, 3);
});

test('ended runs without results settle after five minutes; full rescans recover late results', (t) => {
  const f = temp(t), claudeDir = path.join(f.root, 'claude'), config = path.join(f.root, 'config.json');
  fs.mkdirSync(claudeDir); fs.writeFileSync(config, '{}');
  const dir = path.join(f.runs, 'ended'); fs.mkdirSync(dir);
  const metaFile = path.join(dir, 'meta.json'), resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(metaFile, JSON.stringify({ status: 'failed', started_at: base - 1000, ended_at: base, claude_session: 's', model: 'claude-opus-5-5', agent_type: 'api' }));
  const project = path.join(claudeDir, 'demo'); fs.mkdirSync(project);
  write(path.join(project, 's.jsonl'), [{ type: 'user', timestamp: new Date(base - 2000).toISOString(), message: { content: 'before failure' } }]);
  const stat = fs.statSync; let stats = 0;
  t.mock.method(fs, 'statSync', function (file, ...args) { if (file === metaFile || file === resultFile) stats++; return stat.call(this, file, ...args); });
  const universe = createUniverse({ runs: f.runs, claudeDir, config, prices: loadPrices(path.join(here, 'fixtures/board/prices-test.json')) });
  const initial = universe.read(base + 300000); assert.equal(stats, 2); assert.equal(initial.sessions[0].cost_usd, null);
  universe.read(base + 300001); assert.equal(stats, 4);
  universe.read(base + 301000); assert.equal(stats, 4);
  fs.writeFileSync(resultFile, JSON.stringify({ status: 'failed', duration_s: 12, usage: { input_tokens: 100, output_tokens: 20 } }));
  universe.read(base + 329999); assert.equal(stats, 4);
  assert.ok(universe.read(base + 330000).sessions[0].cost_usd > 0); assert.equal(stats, 6);
  assert.equal(initial.sessions[0].cost_usd, null);
  universe.read(base + 360000); assert.equal(stats, 6);
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) { assert.notEqual(file, resultFile); return original.call(this, file, ...args); });
  universe.read(base + 390000);
});

test('interrupted runs settle without a result and directory changes recover a late result', (t) => {
  const f = temp(t), claudeDir = path.join(f.root, 'claude'), config = path.join(f.root, 'config.json');
  fs.mkdirSync(claudeDir); fs.writeFileSync(config, '{}');
  const dir = path.join(f.runs, 'interrupted'); fs.mkdirSync(dir);
  const metaFile = path.join(dir, 'meta.json'), eventFile = path.join(dir, 'events.jsonl'), resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(eventFile, ''); fs.utimesSync(eventFile, new Date(base - 300001), new Date(base - 300001));
  const project = path.join(claudeDir, 'demo'); fs.mkdirSync(project);
  write(path.join(project, 's.jsonl'), [{ type: 'user', timestamp: new Date(base - 500000).toISOString(), message: { content: 'before interruption' } }]);
  fs.writeFileSync(metaFile, JSON.stringify({ status: 'running', pid: 123456789, started_at: base - 600000, claude_session: 's' }));
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  const stat = fs.statSync; let stats = 0, results = 0;
  t.mock.method(fs, 'statSync', function (file, ...args) { if (file === metaFile || file === resultFile || file === eventFile) stats++; return stat.call(this, file, ...args); });
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) { if (file === resultFile) results++; return read.call(this, file, ...args); });
  const universe = createUniverse({ runs: f.runs, claudeDir, config });
  assert.equal(universe.read(base).sessions[0].alert.kind, 'interrupted'); assert.equal(stats, 3);
  universe.read(base + 1000); assert.equal(stats, 3);
  fs.writeFileSync(resultFile, JSON.stringify({ status: 'failed', duration_s: 12 }));
  fs.mkdirSync(path.join(f.runs, 'added'));
  universe.read(base + 2000); assert.equal(results, 1);
  universe.read(base + 3000); assert.equal(stats, 5);
});

// 大小没长、只改了中间（开头和末尾 4 KB 都没变）的原地改写：也要整份重读
test('a same-size rewrite that only changes the middle is read again from the start', (t) => {
  const f = temp(t), file = path.join(f.root, 'middle.jsonl');
  const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: 'user', n: i, pad: 'x'.repeat(40) }));
  fs.writeFileSync(file, lines.join('\n') + '\n'); fs.utimesSync(file, new Date(base), new Date(base));
  const first = readLines(file, newTail()); assert.equal(first.lines.length, 300);
  const changed = [...lines]; changed[150] = changed[150].replace('"n":150', '"n":999');
  assert.equal(Buffer.byteLength(changed.join('\n')), Buffer.byteLength(lines.join('\n')));
  fs.writeFileSync(file, changed.join('\n') + '\n'); fs.utimesSync(file, new Date(base + 1000), new Date(base + 1000));
  const again = readLines(file, first.tail);
  assert.equal(again.tail.version, 1); assert.equal(again.lines.length, 300); assert.equal(again.lines[150].n, 999);
});