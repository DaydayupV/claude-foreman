import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseTranscriptLines } from '../foreman/skills/dispatch/scripts/board/claude-feed.mjs';
import { createFeed, buildReplay, snapshotAt, laneOf } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { loadPrices, priceFor } from '../foreman/skills/dispatch/scripts/board/prices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, 'fixtures/board/runs');
const transcript = path.join(here, 'fixtures/board/transcript-sample.jsonl'), prices = loadPrices(path.join(here, 'fixtures/board/prices-test.json'));
const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n'), rows = lines.map(JSON.parse);
const runs = fs.readdirSync(root).filter((id) => /^\d{8}-\d{6}-/.test(id)).map((id) => ({ id, dir: path.join(root, id), meta: JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'))) }))
  .filter((r) => r.meta.participant !== 'host'); // 样例补录的 Claude Code 席报告不经派发命令
const ctx = { cwd: 'C:\\demo-lab\\roles', runIds: runs.map((r) => r.id), runsInScope: runs };
const start = Date.parse('2026-10-18T13:40:00Z'), iso = (dt = 0) => new Date(start + dt).toISOString();
const row = (type, content, dt = 0, extra = {}) => ({ type, timestamp: iso(dt), message: { id: `msg_${dt}`, content }, ...extra });
const tool = (name, input, dt = 0) => row('assistant', [{ type: 'tool_use', id: `tool_${dt}`, name, input }], dt);

test('synthetic transcript covers every Claude event, deduplicates message usage and skips wrappers and sidechains', () => {
  const { meta, events, tasks } = parseTranscriptLines(lines, ctx);
  assert.deepEqual(new Set(events.map((e) => e.k)), new Set(['prompt', 'think', 'msg', 'read', 'search', 'web', 'edit', 'cmd', 'cmd_done', 'dispatch', 'collect', 'tool', 'usage', 'returned']));
  assert.equal(events.filter((e) => e.k === 'prompt').length, 1);
  assert.ok(!events.some((e) => /sidechain|system-reminder/.test(e.t)));
  assert.equal(events.find((e) => e.k === 'cmd').t, 'Write-Output demo');
  assert.equal(events.find((e) => e.k === 'cmd_done').ok, false);
  assert.equal(events.find((e) => e.k === 'tool').t, 'inspect');
  assert.equal(events.find((e) => e.k === 'web' && e.t.startsWith('example')).t, 'example.invalid/demo');
  const messages = new Map(rows.filter((r) => r.type === 'assistant' && !r.isSidechain).map((r) => [r.message.id, r]));
  assert.equal(events.filter((e) => e.k === 'usage').length, messages.size);
  assert.deepEqual(meta.usage, { input: 2100, cached: 4200, cache_write: 630, output: 840 });
  const duplicate = [row('assistant', [{ type: 'thinking', thinking: 'one' }]), row('assistant', [{ type: 'text', text: 'two' }], 100)];
  duplicate[0].message.usage = { input_tokens: 999 }; duplicate[1].message = { ...duplicate[1].message, id: 'msg_0', model: 'demo', usage: { input_tokens: 7, output_tokens: 3 } };
  const usage = parseTranscriptLines(duplicate, ctx).events.filter((e) => e.k === 'usage');
  assert.deepEqual(usage.map((e) => [e.ts, e.n, e.u]), [[start + 100, 3, { in: 7, cached: null, cache_write: null, out: 3 }]]);
  assert.equal(Object.keys(tasks).length, 10);
  for (const wrapper of ['<command-name>x', '<local-command-stdout>x', '<system-reminder>x', '<task-notification>x']) assert.deepEqual(parseTranscriptLines([row('user', wrapper)], ctx).events, []);
});

test('tool aliases and path boundaries retain outside paths and the last 120 characters', () => {
  const inputs = [['NotebookRead', { notebook_path: 'C:\\demo-lab\\roles\\a.ipynb' }, 'read', 'a.ipynb'], ['Glob', { pattern: '**/*.mjs' }, 'search', '**/*.mjs'],
    ['MultiEdit', { file_path: 'src/a.mjs' }, 'edit', 'update src/a.mjs'], ['NotebookEdit', { notebook_path: 'C:\\demo-lab\\roles\\a.ipynb' }, 'edit', 'update a.ipynb'],
    ['Write', { file_path: 'C:\\demo-lab\\roles-other\\b' }, 'edit', 'write C:/demo-lab/roles-other/b'], ['Read', { file_path: `D:/${'a'.repeat(140)}/b` }, 'read', `${'a'.repeat(118)}/b`]];
  for (const [name, input, k, t] of inputs) assert.deepEqual(parseTranscriptLines([tool(name, input)], ctx).events.map((e) => [e.k, e.t]), [[k, t]]);
  assert.equal(parseTranscriptLines([tool('Read', { file_path: '/demo/src/a' })], { ...ctx, cwd: '/demo' }).events[0].t, 'src/a');
  assert.equal(parseTranscriptLines([row('user', [{ type: 'text', text: '\nfirst\nsecond' }])], ctx).events[0].t, 'first');
});

test('both rounds link five lanes, background output reads collect them, and notifications return to those lanes', () => {
  const { events, tasks } = parseTranscriptLines(lines, ctx), dispatch = events.filter((e) => e.k === 'dispatch');
  const first = runs.filter((r) => r.meta.round === 1).sort((a, b) => a.id.localeCompare(b.id)), lanes = first.map((r) => r.id);
  assert.deepEqual(dispatch.slice(0, 5).map((e) => e.target), lanes.map((id) => [id]));
  assert.deepEqual(dispatch.slice(5).map((e) => e.target), lanes.map((id) => [id]));
  assert.ok(events.filter((e) => e.k === 'collect').every((e) => JSON.stringify(e.target) === JSON.stringify(lanes)));
  for (let round = 1; round <= 2; round++) for (let i = 0; i < 5; i++) assert.deepEqual(tasks[`demojob${round}${i}`], [lanes[i]]);
  assert.deepEqual(events.filter((e) => e.k === 'returned').map((e) => [e.t, e.target]), [...lanes, ...lanes].map((id) => ['completed', [id]]));
});

test('linking respects agent preference, mode, inclusive windows, plan seats, and unresolved scope ids', () => {
  const make = (id, dt, fields = {}) => ({ id, meta: { started_at: iso(dt), mode: 'discuss', agent: 'other', ...fields } });
  const list = [make('early', 1000), make('preferred', 30000, { agent: 'chosen' }), make('late', 30001, { agent: 'chosen' }), make('seat', 120000, { plan: 'P', seat: 'S', mode: 'run' })];
  const context = { ...ctx, runIds: list.map((r) => r.id), runsInScope: list };
  const cmd = (s, dt = 0) => tool('Bash', { command: `S="C:/demo"; node "C:/demo/cli.mjs" ${s}` }, dt);
  const parsed = parseTranscriptLines([cmd('discuss --agent chosen'), cmd('discuss'), cmd('discuss --agent chosen'), cmd('run --plan P --seat S'), cmd('plan P'), cmd('submit P'), cmd('resume --run missing')], context).events;
  assert.deepEqual(parsed.map((e) => e.target), [['preferred'], ['early'], undefined, ['seat'], undefined, undefined, undefined]);
  assert.equal(parseTranscriptLines([cmd('run --plan P --seat S', -1)], context).events[0].target, undefined);
  const id = runs[0].id, scoped = { ...ctx, runIds: [id], runsInScope: [runs[0]] };
  for (const name of ['status', 'watch', 'judge']) assert.deepEqual(parseTranscriptLines([cmd(`${name} --group skills-roles-1018`)], scoped).events[0].target, [id]);
  assert.equal(parseTranscriptLines([cmd('stats')], scoped).events[0].k, 'collect');
  assert.equal(parseTranscriptLines([cmd('status')], scoped).events[0].target, undefined);
  assert.deepEqual(parseTranscriptLines([tool('other', { nested: [{ value: id }] })], scoped).events[0].target, [id]);
  assert.equal(parseTranscriptLines([tool('Read', { file_path: path.join(root, 'summary.json') })], ctx).events[0].k, 'collect');
  assert.equal(parseTranscriptLines([tool('Read', { file_path: 'C:/demo/runs/summary.json' })], ctx).events[0].k, 'read');
  const bg = [cmd('discuss --agent chosen'), row('user', [{ type: 'tool_result', tool_use_id: 'tool_0', content: [{ type: 'text', text: 'Command running in background with ID: pending1' }] }], 1), tool('Read', { file_path: 'C:/demo/tasks/pending1.output' }, 2)];
  assert.equal(parseTranscriptLines(bg, { ...context, runsInScope: [], runIds: [] }).events[1].target, undefined);
  assert.deepEqual(parseTranscriptLines(bg, context).events[1].target, ['preferred']);
});

test('prices match the first entry after provider stripping, fall back rates, and preserve three cost sources', () => {
  assert.equal(priceFor('provider/CLAUDE-OPUS-5-5', { input: 100, cached: 200, cache_write: 30, output: 40 }, prices), 0.00236);
  assert.equal(priceFor('provider/gpt-6-demo', { input: 1, cached: 2, cache_write: 3, output: 4 }, prices), 0.000044);
  assert.equal(loadPrices(path.join(here, 'fixtures/board/no-such-prices.json')), null);
  assert.equal(priceFor('unpriced', { input: 1 }, prices), null);
  assert.equal(priceFor('claude-opus-5', { input: 1 }, null), null);
  const data = createFeed(root, { prices }).read({ replay: 'skills-roles-1018' }, start), gpt = data.runs.find((r) => r.agent === 'gpt-6-astra-codex-cli');
  assert.equal(gpt.cost_source, 'api_equiv'); assert.equal(data.runs.find((r) => r.agent === 'gemini-4-argon-contributor').cost_source, 'reported');
  assert.equal(createFeed(root).read({ run: gpt.id }, start).runs[0].cost_source, 'unknown');
  assert.deepEqual(gpt.usage, { input: 202237, cached: 509568, cache_write: null, output: 10477 });
  assert.equal(gpt.report_head, JSON.parse(fs.readFileSync(path.join(root, gpt.id, 'result.json'))).report.position.slice(0, 160)); assert.deepEqual(gpt.changed, []);
});

test('Claude and seats share maxgap mapping and replay totals never include future usage', () => {
  const feed = createFeed(root, { transcript, prices }), data = feed.read({ replay: 'skills-roles-1018' }, start);
  const replay = buildReplay(data, { maxgap: 1 }, start), cc = data.runs.find((r) => r.id === 'cc');
  assert.equal(replay.hello.v, 3); assert.equal(cc.usage.input, 2100);
  const mapped = new Map(replay.timeline.filter((m) => m.event === 'ev').map((m) => [`${m.data.run}:${m.data.k}:${m.data.t}`, m.data.ts]));
  assert.equal(mapped.get(`cc:dispatch:${data.events.find((e) => e.k === 'dispatch').t}`), replay.timeline.find((m) => m.data.k === 'dispatch').time);
  assert.ok(replay.timeline.every((m, i) => !i || m.time - replay.timeline[i - 1].time <= 1000));
  const firstUsage = replay.timeline.find((m) => m.event === 'run' && m.data.id === 'cc' && m.data.usage);
  assert.deepEqual(firstUsage.data.usage, { input: 100, cached: 200, cache_write: 30, output: 40 });
  const final = snapshotAt(replay).runs.find((r) => r.id === 'cc');
  assert.equal(final.status, 'idle'); assert.equal(final.ended_at, null); assert.deepEqual(final.usage, cc.usage);
  assert.equal(final.started_at, replay.timeline.find((m) => m.data.id === 'cc').time);
  assert.equal(feed.read({ group: 'skills-roles-1018' }, start + 86400000).runs.find((r) => r.id === 'cc').status, 'idle');
  assert.equal(createFeed(root, { transcript: path.join(here, 'fixtures/board/missing.jsonl') }).read({ run: runs[0].id }, start).runs.some((r) => r.id === 'cc'), false);
});

test('shared tailing keeps partial UTF-8 and lines; discovery, windows and host answers use only synthetic files', (t) => {
  const id = '20261018-214000-demo', temp = fs.mkdtempSync(path.join(here, 'fixtures/board/cc-test-')), dir = path.join(temp, 'runs', id), projects = path.join(temp, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(projects, { recursive: true });
  t.after(() => { assert.equal(path.dirname(temp), path.join(here, 'fixtures/board')); fs.rmSync(temp, { recursive: true, force: true }); });
  const meta = { started_at: iso(), ended_at: iso(1000), status: 'done', kind: 'review', participant: 'host', claude_session: 'synthetic', group: 'demo' };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ cost_usd: 0, report: { verdict: 'pass', findings: [{ title: 'demo' }] }, changes: { files: Array.from({ length: 42 }, () => ({ path: 'a', added: 1, removed: 2 })) } }));
  const file = path.join(projects, 'synthetic.jsonl'), feed = createFeed(path.join(temp, 'runs'), { claudeDir: path.dirname(projects) });
  const bytes = Buffer.from(`${JSON.stringify(row('user', '中文'))}\n`), cut = bytes.indexOf(Buffer.from('中文')) + 1;
  fs.writeFileSync(file, bytes.subarray(0, cut)); assert.equal(feed.read({ group: 'demo' }, start).runs.length, 1);
  fs.appendFileSync(file, bytes.subarray(cut, -1)); assert.equal(feed.read({ group: 'demo' }, start).runs.length, 1);
  fs.appendFileSync(file, '\n'); let data = feed.read({ group: 'demo' }, start);
  assert.equal(data.events.find((e) => e.run === 'cc').t, '中文'); assert.equal(data.runs.find((r) => r.id === id).lane, 'cc');
  const answer = data.runs.find((r) => r.id === id);
  assert.equal(answer.kind, 'answer'); assert.equal(answer.cost_usd, 0); assert.equal(answer.cost_source, 'reported'); assert.equal(answer.report_head, 'pass · 1 findings'); assert.equal(answer.changed.length, 40);
  assert.ok(buildReplay(data, {}, start).timeline.filter((m) => m.event === 'run' && m.data.id === id).every((m) => m.data.status !== 'running'));
  fs.appendFileSync(file, [row('user', 'too early', -600001), row('user', 'too late', 301001)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual(feed.read({ group: 'demo' }, start).events.filter((e) => e.run === 'cc').map((e) => e.t), ['中文']);
  fs.writeFileSync(file, `${JSON.stringify(row('user', 'reset'))}\n`); assert.deepEqual(feed.read({ group: 'demo' }, start).events.filter((e) => e.run === 'cc').map((e) => e.t), ['reset']);
  assert.equal(createFeed(path.join(temp, 'runs'), { claudeDir: path.dirname(projects), session: 'missing' }).read({ group: 'demo' }, start).runs.length, 1);
  assert.equal(laneOf({ id: 'host', meta: { participant: 'host' } }, new Map()), 'cc');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, status: 'running', claude_session: undefined }));
  assert.equal(createFeed(path.join(temp, 'runs')).hasRunning(start), false);
  for (const [kind, report, last_message, expected] of [['exec', { summary: 'x'.repeat(200) }, '', 'x'.repeat(160)], ['image', null, 'first\nsecond', 'first'], ['discuss', {}, 'position\nnext', 'position']]) {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, kind }));
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ report, last_message }));
    assert.equal(createFeed(path.join(temp, 'runs')).read({ group: 'demo' }, start).runs[0].report_head, expected);
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, claude_session: undefined }));
  fs.writeFileSync(file, [row('user', 'old', -1800001), row('user', 'boundary', -1800000), row('user', 'now'), row('user', 'future', 1)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const recent = createFeed(path.join(temp, 'runs'), { claudeDir: path.dirname(projects) });
  assert.deepEqual(recent.read({}, start).events.filter((e) => e.run === 'cc').map((e) => e.t), ['boundary', 'now']);
  fs.appendFileSync(file, `${JSON.stringify(row('user', 'appended', -5000000))}\n`);
  data = recent.read({}, start + 1000); assert.equal(data.events.filter((e) => e.run === 'cc').at(-1).t, 'appended');
  assert.equal(data.runs.find((r) => r.id === 'cc').status, 'running');
  assert.equal(recent.read({}, start + 91000).runs.find((r) => r.id === 'cc').status, 'idle');
});

test('live polling sends ev_link for a late run without repeating dispatch, collect or returned', { timeout: 15000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(here, 'fixtures/board/cc-live-')), runRoot = path.join(temp, 'runs'), file = path.join(temp, 'synthetic.jsonl');
  const seed = '20261018-214001-seed', late = '20261018-214002-late';
  const write = (id, mode) => { const dir = path.join(runRoot, id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ mode, agent: 'demo', group: 'demo', status: 'done', started_at: iso(2000), ended_at: iso(3000) })); };
  write(seed, 'exec');
  const partial = row('assistant', [{ type: 'thinking', thinking: 'demo' }], 10); partial.message = { ...partial.message, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 3 } };
  fs.writeFileSync(file, [...Array.from({ length: 205 }, (_, i) => row('user', `history ${i}`, i - 1000)), tool('Bash', { command: 'node "C:/demo/cli.mjs" discuss --agent demo' }), row('user', [{ type: 'tool_result', tool_use_id: 'tool_0', content: 'Command running in background with ID: taskdemo' }], 1), tool('Read', { file_path: 'C:/demo/tasks/taskdemo.output' }, 2), row('user', '<task-notification><task-id>taskdemo</task-id><status>completed</status></task-notification>', 3), partial].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const child = spawn(process.execPath, [path.join(here, '../foreman/skills/dispatch/scripts/board/server.mjs'), '--runs', runRoot, '--claude-dir', temp, '--config', path.join(temp, 'config.json'), '--transcript', file, '--prices', path.join(here, 'fixtures/board/prices-test.json')], { cwd: here, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode == null) { child.kill(); await once(child, 'exit'); } assert.equal(path.dirname(temp), path.join(here, 'fixtures/board')); fs.rmSync(temp, { recursive: true, force: true }); });
  const [ready] = await once(child.stdout, 'data'), address = String(ready).match(/board: (http:\/\/\S+?)\?/)[1];
  const res = await fetch(`${address}stream?group=demo`, { signal: AbortSignal.timeout(10000) }), reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = '', appeared = false; const links = [], repeated = [];
  try {
    while (links.length < 3) {
      const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1], json = /^data: (.+)$/m.exec(frame)?.[1]; if (!json) continue; const data = JSON.parse(json);
        if (event === 'backlog' && data.run === 'cc') {
          assert.equal(data.events.length, 200); assert.equal(data.events.filter((e) => e.k === 'usage').length, 1); assert.ok(data.events.filter((e) => ['dispatch', 'collect', 'returned'].includes(e.k)).every((e) => !e.target));
          write(late, 'discuss'); fs.appendFileSync(file, `${JSON.stringify({ ...partial, timestamp: iso(20), message: { ...partial.message, content: [{ type: 'text', text: 'done' }] } })}\n`); appeared = true;
        }
        if (event === 'ev_link') links.push(data);
        if (appeared && event === 'ev' && data.run === 'cc' && ['dispatch', 'collect', 'returned', 'usage'].includes(data.k)) repeated.push(data);
      }
    }
  } finally { await reader.cancel(); }
  assert.deepEqual(links.map((e) => [e.k, e.target]), ['dispatch', 'collect', 'returned'].map((k) => [k, [late]])); assert.deepEqual(repeated, []);
});

test('a question popup becomes ask, and its answer becomes ask_done with the same header', () => {
  const ask = tool('AskUserQuestion', { questions: [{ header: '图像路线', question: '这次怎么做？' }] }, 100), plan = tool('ExitPlanMode', { plan: 'x' }, 300);
  const answer = (dt, id) => row('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }], dt);
  const events = parseTranscriptLines([ask, answer(200, 'tool_100'), plan, answer(400, 'tool_300')], ctx).events.filter((e) => e.k.startsWith('ask'));
  assert.deepEqual(events.map((e) => [e.k, e.t, e.ts - start]), [['ask', '图像路线', 100], ['ask_done', '图像路线', 200], ['ask', '计划审批', 300], ['ask_done', '计划审批', 400]]);
  // 还没回答：只有 ask
  assert.deepEqual(parseTranscriptLines([ask], ctx).events.map((e) => e.k), ['ask']);
});
