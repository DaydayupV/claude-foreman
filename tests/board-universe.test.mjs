import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createUniverse, universeAt, universeChanges, projectRoot, desktopHidden } from '../foreman/skills/dispatch/scripts/board/universe.mjs';
import { createFeed, selectScope, buildReplay } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { loadPrices } from '../foreman/skills/dispatch/scripts/prices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), base = Date.parse('2026-10-22T09:00:00Z'), now = base + 210000;
const prices = loadPrices(path.join(here, 'fixtures/board/prices-test.json')), sentinel = 'UNIVERSE_PRIVATE_SENTINEL_8D4A';
const sample = { runs: path.join(here, 'fixtures/board/universe/runs'), claudeDir: path.join(here, 'fixtures/board/universe/claude'), config: path.join(here, 'fixtures/board/universe/config.json'), prices, now: () => now };
const row = (type, at, content, fields = {}) => ({ type, timestamp: new Date(at).toISOString(), cwd: 'C:/Demo/Project', message: { content, ...fields } });
const answer = (at, fields = {}) => row('assistant', at, [{ type: 'text', text: sentinel }], { id: `msg-${at}`, model: 'claude-opus-5-5', stop_reason: 'end_turn', ...fields });
const tool = (at, name = 'AskUserQuestion', id = 'ask') => row('assistant', at, [{ type: 'tool_use', id, name, input: { questions: [{ header: '确认'.repeat(20), question: sentinel }] } }]);
const result = (at, id = 'ask') => row('user', at, [{ type: 'tool_result', tool_use_id: id, content: sentinel }]);
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-universe-'));
  const options = { runs: path.join(root, 'runs'), claudeDir: path.join(root, 'claude'), config: path.join(root, 'config.json'), prices, now: () => now };
  fs.mkdirSync(options.runs); fs.mkdirSync(options.claudeDir);
  fs.writeFileSync(options.config, '{}');
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const session = (id, rows, folder = 'demo', mtime = now) => {
    const file = path.join(options.claudeDir, folder, `${id}.jsonl`);
    write(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); fs.utimesSync(file, new Date(mtime), new Date(mtime)); return file;
  };
  const run = (id, { report: given, ...fields } = {}, cost = 1, events = []) => {
    const dir = path.join(options.runs, id), meta = { id, claude_session: 's', agent: 'configured', agent_type: 'opencode cli', kind: 'exec', model: 'claude-opus-5-5',
      status: 'done', started_at: now - 10000, ended_at: now - 5000, ...fields };
    write(path.join(dir, 'meta.json'), meta);
    // 正常结束的带一份报告（没交回报告的算失败，见 no_result 的测试）；report 给 null 时不带
    const report = given !== undefined ? given : meta.status === 'done' ? { status: 'completed' } : undefined;
    if (meta.status !== 'running') write(path.join(dir, 'result.json'), { status: meta.status, cost_usd: cost, cost_source: cost == null ? 'unknown' : 'api_price', ...(report ? { report } : {}) });
    write(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n'); return meta;
  };
  return { root, options, write, session, run };
}

test('the star map does not take a <synthetic> reply as the conversation\'s model', (t) => {
  const f = temp(t);
  f.session('only', [row('user', now - 3000, 'go'), answer(now - 2000, { model: '<synthetic>' })]);
  f.session('mixed', [row('user', now - 3000, 'go'), answer(now - 2500), answer(now - 2000, { model: '<synthetic>' })]);
  const s = new Map(createUniverse(f.options).read().sessions.map((x) => [x.id, x]));
  assert.equal(s.get('only').model, null); assert.equal(s.get('mixed').model, 'claude-opus-5-5');
});

test('sample index merges Windows cwd variants, skips deep files, counts older and has no message text', () => {
  const data = createUniverse(sample).read();
  assert.equal(data.sessions.length, 9); assert.equal(data.projects.length, 4);
  assert.equal(data.projects.find((p) => p.key === 'c:/demo-lab/roles').older, 1);
  assert.equal(data.projects.find((p) => p.key === 'd:/work/shop-api').cwd, 'd:\\WORK\\shop-api\\');
  assert.equal(data.sessions.find((s) => s.id === 'demo-star').title, 'board 星图设计');
  assert.equal(data.sessions.find((s) => s.id === 'demo-factor').alert.kind, 'quota_exhausted');
  assert.equal(data.sessions.find((s) => s.id === 'demo-migrate').alert, null);
  assert.ok(!JSON.stringify(data).includes(sentinel));
  assert.deepEqual(data.sessions.find((s) => s.id === 'demo-review').counts, { running: 0, done: 4, failed: 0 }); // 三席加一个补漏席
  assert.equal(data.agents[0].max_parallel, 2);
});

test('index tails partial UTF-8 once, retries transient reads, notices files and expires last_at', (t) => {
  const f = temp(t), file = f.session('s', [row('user', now - 1000, 'first')]);
  const old = f.session('old', [], 'demo', now - 86400001);
  f.session('deep', [row('user', now, 'skip')], 'demo/subagents');
  const open = fs.openSync, reads = [];
  t.mock.method(fs, 'openSync', function (name, ...args) { assert.notEqual(name, old); reads.push(name); return open.call(this, name, ...args); });
  const universe = createUniverse(f.options);
  assert.equal(universe.read().sessions.length, 1);
  const count = reads.filter((name) => name === file).length;
  universe.read(); assert.equal(reads.filter((name) => name === file).length, count);
  const bytes = Buffer.from(JSON.stringify(row('user', now, '中文')) + '\n'), cut = bytes.indexOf(Buffer.from('中文')) + 1;
  fs.appendFileSync(file, bytes.subarray(0, cut)); assert.equal(universe.read().sessions[0].last_at, now - 1000);
  fs.appendFileSync(file, bytes.subarray(cut, -1)); assert.equal(universe.read().sessions[0].last_at, now - 1000);
  fs.appendFileSync(file, '\n'); assert.equal(universe.read().sessions[0].last_at, now);
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    fs.appendFileSync(file, JSON.stringify(answer(now + 1)) + '\n');
    const mock = t.mock.method(fs, 'openSync', function (name, ...args) { if (name === file) throw Object.assign(new Error(code), { code }); return open.call(this, name, ...args); });
    assert.doesNotThrow(() => universe.read()); mock.mock.restore();
    const original = fs.statSync, statMock = t.mock.method(fs, 'statSync', function (name, ...args) { if (name === file) throw Object.assign(new Error(code), { code }); return original.call(this, name, ...args); });
    assert.equal(universe.read().sessions.length, 1); statMock.mock.restore();
  }
  fs.writeFileSync(file, JSON.stringify(row('user', now + 2, 'reset')) + '\n');
  assert.equal(universe.read().sessions[0].title, 'reset');
  const added = f.session('added', [row('user', now + 3, 'added')]);
  const before = universe.read(); assert.equal(before.sessions.length, 2);
  fs.unlinkSync(added); assert.ok(universeChanges(before, universe.read()).some((m) => m.event === 'session_gone' && m.data.id === 'added'));
  fs.utimesSync(file, new Date(now + 86400002), new Date(now + 86400002));
  assert.equal(universe.read(now + 86400003).sessions.length, 0);
});

test('index limit, unknown projects, newest cwd, title fallback and timestamped custom titles', (t) => {
  const f = temp(t);
  for (let i = 0; i < 202; i++) f.session(`s${i}`, [row('user', now - i, `title ${i}`)]);
  let data = createUniverse(f.options).read();
  assert.equal(data.sessions.length, 200); assert.equal(data.sessions[0].id, 's0'); assert.equal(data.sessions.at(-1).id, 's199');
  f.session('s0', [{ ...row('user', now, '<command-name>ignored'), cwd: undefined }]);
  f.session('s1', [row('user', now - 3, 'a'.repeat(80)), { type: 'custom-title', timestamp: new Date(now - 1).toISOString(), customTitle: 'chosen' }]);
  f.session('s2', [row('user', now - 4, 'b'.repeat(80))]);
  data = createUniverse(f.options).read();
  assert.equal(data.sessions.find((s) => s.id === 's0').title, null);
  assert.equal(data.projects.find((p) => p.key === '?').name, '(unknown)');
  assert.equal(data.sessions.find((s) => s.id === 's1').title, 'chosen');
  assert.equal(data.sessions.find((s) => s.id === 's2').title, 'b'.repeat(60));
  const cwd = temp(t);
  cwd.session('one', [row('user', now - 2, 'one'), { ...answer(now), cwd: undefined }]);
  cwd.session('two', [{ ...row('user', now - 1, 'two'), cwd: 'c:\\DEMO\\project\\' }]);
  assert.equal(createUniverse(cwd.options).read().projects[0].cwd, 'c:\\DEMO\\project\\');
});

test('projects follow where a conversation started (not later cd) and fold git worktrees into their repository', (t) => {
  const f = temp(t), repo = path.join(f.root, 'repo'), other = path.join(f.root, 'elsewhere', 'wt');
  f.write(path.join(other, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  f.session('cd', [{ ...row('user', now - 5, 'start'), cwd: repo }, { ...answer(now - 4), cwd: path.join(repo, 'board', 'web') }, { ...answer(now - 3), cwd: 'D:/Somewhere/Else' }]);
  f.session('tree', [{ ...row('user', now - 2, 'tree'), cwd: path.join(repo, '.claude', 'worktrees', 'stress-a1') }], 'tree');
  f.session('git', [{ ...row('user', now - 1, 'git'), cwd: other }], 'git');
  f.session('old', [{ ...row('user', now - 2 * 86400000, 'old'), cwd: path.join(repo, '.claude', 'worktrees', 'gone') }], 'gone', now - 2 * 86400000);
  f.session('upper', [{ ...row('user', now - 6, 'upper'), cwd: path.join(repo, '.CLAUDE', 'WORKTREES', 'deleted') }], 'upper');
  const data = createUniverse(f.options).read(), key = repo.replace(/\\/g, '/').toLowerCase();
  assert.deepEqual(data.sessions.map((s) => s.project), [key, key, key, key]);
  assert.deepEqual(data.projects.map((p) => [p.name, p.older]), [['repo', 1]]);
  // 网络路径不读 .git，原样当项目
  assert.equal(projectRoot('\\\\offline-server\\share\\proj'), '\\\\offline-server\\share\\proj');
});

test('states follow waiting, dispatching, thinking, idle priority and injectable 90 s / 10 min limits', (t) => {
  const f = temp(t), file = f.session('s', [row('user', base, 'title'), tool(base + 1)]);
  f.run('work', { status: 'running', started_at: base, ended_at: null });
  const universe = createUniverse(f.options), summary = (at) => universe.read(at).sessions[0];
  assert.equal(summary(base + 10).state, 'waiting'); assert.equal(summary(base + 10).waiting.header.length, 24);
  fs.appendFileSync(file, JSON.stringify(result(base + 20)) + '\n');
  assert.equal(summary(base + 20).state, 'dispatching');
  f.run('work', { started_at: base, ended_at: base + 30 });
  fs.appendFileSync(file, JSON.stringify(answer(base + 30)) + '\n'); assert.equal(summary(base + 30).state, 'idle');
  fs.appendFileSync(file, JSON.stringify(row('user', base + 40, 'new')) + '\n');
  assert.equal(summary(base + 40 + 89999).state, 'thinking'); assert.equal(summary(base + 40 + 90000).state, 'idle');
  fs.appendFileSync(file, JSON.stringify(tool(base + 100000, 'Read', 'read')) + '\n');
  fs.appendFileSync(file, JSON.stringify(answer(base + 100001)) + '\n');
  assert.equal(summary(base + 699999).state, 'thinking'); assert.equal(summary(base + 700000).state, 'idle');
  fs.appendFileSync(file, JSON.stringify(tool(base + 710000, 'ExitPlanMode', 'exit')) + '\n');
  assert.equal(summary(base + 800000).state, 'waiting'); assert.equal(summary(base + 800000).waiting.header, null);
});

test('run summaries cap at 16 / ten minutes, omit host, count the whole conversation (not just the window), deduplicate usage and clear alerts on prompts', (t) => {
  const f = temp(t), file = f.session('s', [row('user', now - 40000, 'title'),
    answer(now - 86400001, { usage: { input_tokens: 999 } }), answer(now - 30000, { id: 'same', usage: { input_tokens: 999 } }),
    answer(now - 29000, { id: 'same', usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 40 } })]);
  for (let i = 0; i < 17; i++) f.run(`done${i}`, { started_at: now - 10000 - i, ended_at: now - 8000 - i });
  f.run('old', { started_at: now - 700000, ended_at: now - 600001 });
  f.run('host', { participant: 'host' });
  f.run('outside', { started_at: now - 86400001, ended_at: now - 86400000 });
  f.run('failed', { status: 'failed', started_at: now - 4000, ended_at: now - 2000 });
  f.run('quota', { status: 'quota_exhausted', started_at: now - 3000, ended_at: now - 1000 });
  const universe = createUniverse(f.options);
  let s = universe.read().sessions[0];
  assert.equal(s.runs.length, 16); assert.equal(s.runs[0].id, 'quota'); assert.ok(!s.runs.some((r) => ['host', 'old'].includes(r.id)));
  // 窗口以外的任务（outside）和 Claude Code 用量（一天多以前那条 999）也算：一行是这个对话的全部，和看板一致
  assert.deepEqual(s.counts, { running: 0, done: 19, failed: 2 });
  assert.deepEqual(s.usage, { input: 1099, cached: 200, cache_write: 30, output: 40 });
  assert.equal(s.cost_usd, 21.01235); // 21 个任务各 $1，加 Claude Code 的 0.00236 和 0.00999 assert.equal(s.alert.kind, 'quota_exhausted');
  assert.equal(Object.hasOwn(s, 'cost_paid_usd'), false); assert.equal(Object.hasOwn(s, 'cost_subscription_usd'), false);
  assert.equal(universe.read(now + 1799000).sessions[0].alert.kind, 'quota_exhausted');
  assert.equal(universe.read(now + 1799001).sessions[0].alert, null);
  fs.appendFileSync(file, JSON.stringify(answer(now - 28000, { id: 'same' })) + '\n');
  assert.equal(universe.read().sessions[0].usage.input, 999);
  fs.appendFileSync(file, JSON.stringify(row('user', now - 500, 'new prompt')) + '\n');
  assert.equal(universe.read().sessions[0].alert, null);
  fs.appendFileSync(file, JSON.stringify(answer(now - 400, { model: 'unpriced', usage: { input_tokens: 1 } })) + '\n');
  s = universe.read().sessions[0]; assert.equal(s.cost_usd, 21.00999); assert.equal(s.cost_partial, true);
  assert.equal(Object.hasOwn(s, 'cost_paid_usd'), false); assert.equal(Object.hasOwn(s, 'cost_subscription_usd'), false);
  assert.equal(s.runs.some((r) => Object.hasOwn(r, 'report_head')), false);
});

test('宇宙标题和最近用户消息使用统一判定，系统注入不清除告警', (t) => {
  const ignored = [
    ['Base directory for this skill: /demo', { isMeta: true }], ['[Image: demo.png]', { isMeta: true }],
    ['<system-reminder>系统事件</system-reminder>', { promptSource: 'sdk', turnOrigin: 'sdk' }],
    ['<task-notification>任务完成</task-notification>', { origin: { kind: 'task-notification' }, turnOrigin: 'task_notification' }],
    ['定时唤醒', { isMeta: true, promptSource: 'system', turnOrigin: 'scheduled' }],
  ];
  for (const [content, fields, title] of [
    ['<system-reminder>提醒</system-reminder>\n用户输入', { origin: { kind: 'human' }, turnOrigin: 'human' }, '用户输入'],
    ['Another Claude session sent a message:\n<cross-session-message from="local_demo" name="demo">协作消息</cross-session-message>\n说明',
      { isMeta: true, origin: { kind: 'peer' }, turnOrigin: 'peer' }, '协作消息'],
    ['<system-reminder>提醒</system-reminder>\n旧版输入', {}, '旧版输入'],
    ['<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>检查</command-args>', { turnOrigin: 'human' }, '/goal 检查'],
  ]) {
    const f = temp(t), file = f.session('s', [...ignored.map(([text, extra], i) => ({ ...row('user', now - 4000 + i, text), ...extra })),
      { ...row('user', now - 2000, content), ...fields }]);
    f.run('failed', { status: 'failed', started_at: now - 1500, ended_at: now - 1000 });
    const universe = createUniverse(f.options);
    assert.equal(universe.read().sessions[0].title, title);
    fs.appendFileSync(file, ignored.map(([text, extra], i) => JSON.stringify({ ...row('user', now + i, text), ...extra })).join('\n') + '\n');
    assert.equal(universe.read(now + 20).sessions[0].alert.run, 'failed');
    fs.appendFileSync(file, JSON.stringify({ ...row('user', now + 10, content), ...fields }) + '\n');
    assert.equal(universe.read(now + 20).sessions[0].alert, null);
  }
});

test('费用摘要只汇总 API 价格，旧来源重新计价，缺基线的累计用量留为未知', (t) => {
  const f = temp(t);
  f.session('s', [answer(now - 30000, { usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 40 } })]);
  f.run('reported', {}, 2);
  f.write(path.join(f.options.runs, 'reported/result.json'), { status: 'done', cost_usd: 2, cost_source: 'reported', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40 } });
  f.run('api', { agent_type: 'api', model: 'gpt-6-demo' }, null);
  f.write(path.join(f.options.runs, 'api/result.json'), { status: 'done', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40 }, usage_scope: 'this_run' });
  f.run('subscription', { agent_type: 'codex cli' }, 5);
  f.write(path.join(f.options.runs, 'subscription/result.json'), { status: 'done', cost_usd: 5, cost_source: 'subscription', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40 } });
  // 续接的父任务已经不在：会话累计量扣不出这一轮的增量，费用算不出（没有父任务的根轮次按零基线换算，见 board-feed 的测试）
  f.run('cumulative', { agent_type: 'codex cli', model: 'gpt-6-demo', parent: 'gone-parent' }, null);
  f.write(path.join(f.options.runs, 'cumulative/result.json'), { status: 'done', usage: { input_tokens: 100, output_tokens: 40 }, usage_scope: 'session_total' });
  f.run('host', { participant: 'host' }, null);
  const summary = createUniverse(f.options).read().sessions[0];
  assert.equal(Object.hasOwn(summary, 'cost_paid_usd'), false);
  assert.equal(Object.hasOwn(summary, 'cost_subscription_usd'), false);
  assert.equal(summary.cost_usd, 0.00162 + 0.00052 + 0.00162 + 0.00236);
  assert.equal(summary.cost_partial, true);
});

test('名额面板只列四个模块里用到的协作方，别的协作方只在正在跑时出现；没有 modules 的老配置照旧全列', (t) => {
  const f = temp(t);
  f.write(f.options.config, { agents: { codex: { type: 'codex cli', max_parallel: 2 }, spare: { type: 'api' }, named: { type: 'opencode cli' } },
    modules: { discuss: { simple: [{ agent: 'codex', required: true }], normal: 'claude code' }, run: { simple: 'claude code' }, review: {}, image: { generate: null, draw: null } } });
  assert.deepEqual(createUniverse(f.options).read().agents.map((a) => a.id), ['codex']);
  f.run('named-run', { agent: 'named', status: 'running', ended_at: null });
  assert.deepEqual(createUniverse(f.options).read().agents.map((a) => a.id), ['codex', 'named']);
  f.write(f.options.config, { agents: { codex: { type: 'codex cli' }, spare: { type: 'api' } } });
  assert.deepEqual(createUniverse(f.options).read().agents.map((a) => a.id), ['codex', 'spare', 'named']);
});

test('agent slots retain config order, include unknown / out-of-window runs and queued since, never config secrets', (t) => {
  const f = temp(t);
  f.write(f.options.config, { api_key: 'SECRET_CONFIG_SENTINEL', agents: { z: { type: 'api', max_parallel: 2, api_key: 'SECRET_AGENT_SENTINEL' }, a: { type: 'cli', max_parallel: 3 } } });
  f.run('unknown-z', { agent: 'unknown-z', status: 'running', ended_at: null });
  f.run('unknown-b', { agent: 'unknown-b', status: 'running', started_at: now - 90000000, ended_at: null, claude_session: 'outside' });
  const meta = f.run('queued', { agent: 'z', status: 'running', ended_at: null }, null, [{ type: 'api.queued', ts: now - 1000 }]);
  const universe = createUniverse(f.options), data = universe.read();
  assert.deepEqual(data.agents.map((a) => a.id), ['z', 'a', 'unknown-b', 'unknown-z']);
  assert.deepEqual(data.agents[0].queued, [{ run: 'queued', session: 's', since: now - 1000 }]);
  assert.deepEqual(data.agents[2], { id: 'unknown-b', type: null, max_parallel: 4, running: [{ run: 'unknown-b', session: 'outside' }], queued: [] });
  assert.ok(!JSON.stringify(data).includes('SECRET')); assert.ok(!JSON.stringify(data).includes('api_key'));
  fs.appendFileSync(path.join(f.options.runs, 'queued/events.jsonl'), JSON.stringify({ type: 'api.request', ts: now, model: meta.model }) + '\n');
  assert.deepEqual(universe.read().agents[0].queued, []);
});

test('all replay shares one mapping with every detail, ordered deltas, source states, queues and mapped now', (t) => {
  const universe = createUniverse(sample), replay = universe.replay({ speed: 2, maxgap: 1 }), { start, speed } = replay.hello.replay;
  const at = (sec) => universeAt(replay, (replay.clock.map(base + sec * 1000) - start) / (1000 * speed));
  assert.equal(universeAt(replay, 0).sessions.length, 0);
  assert.equal(universeAt(replay, 0).projects.length, 0);
  assert.equal(at(30).sessions.find((s) => s.id === 'demo-mascot').state, 'waiting');
  assert.equal(at(35.2).sessions.find((s) => s.id === 'demo-factor').state, 'dispatching');
  assert.deepEqual(at(35.2).sessions.find((s) => s.id === 'demo-factor').counts, { running: 1, done: 0, failed: 0 });
  assert.equal(at(35.2).sessions.find((s) => s.id === 'demo-factor').cost_usd, 0.00944); assert.equal(at(35.2).sessions.find((s) => s.id === 'demo-factor').cost_partial, true);
  assert.equal(Object.hasOwn(at(35.2).sessions.find((s) => s.id === 'demo-factor'), 'cost_paid_usd'), false);
  assert.equal(Object.hasOwn(at(35.2).sessions.find((s) => s.id === 'demo-factor'), 'cost_subscription_usd'), false);
  assert.equal(at(35.2).agents.find((a) => a.id === 'kimi-k2.6').queued[0].since, replay.clock.map(base + 35200));
  assert.equal(at(0.1).sessions.find((s) => s.id === 'demo-factor').state, 'thinking');
  assert.equal(at(100).sessions.find((s) => s.id === 'demo-factor').state, 'idle');
  assert.equal(at(100).sessions.find((s) => s.id === 'demo-factor').alert.kind, 'quota_exhausted');
  assert.equal(at(145).agents.at(-1).id, 'fixture-unconfigured-agent');
  assert.ok(replay.timeline.every((m, i) => !i || m.time >= replay.timeline[i - 1].time));
  assert.ok(!JSON.stringify(replay.timeline).includes(sentinel));
  for (const s of universe.read().sessions) {
    const detail = replay.detail(s.id), raw = createFeed(sample.runs, { ...sample }).read({ session: s.id, replay: s.id }, now);
    assert.deepEqual(detail.hello.replay, replay.hello.replay);
    for (const ev of raw.events) assert.ok(detail.timeline.some((m) => m.event === 'ev' && m.data.k === ev.k && m.data.run === ev.run && m.data.ts === replay.clock.map(ev.ts)));
    assert.ok(detail.timeline.every((m) => Number.isFinite(m.time)));
  }
  const zero = universe.replay({ maxgap: 0 });
  assert.ok(zero.timeline.filter((m) => m.event === 'session' && m.data.id === 'demo-factor').length > 3);
  const f = temp(t);
  const file = f.session('s', [row('user', base, 'first'), row('user', base + 200000, 'again')]);
  const short = createUniverse({ ...f.options, windowH: 0.01 }).replay({ maxgap: 1000 });
  const during = universeAt(short, (base + 36001 - short.hello.replay.start) / 1000);
  assert.equal(during.sessions.length, 0); assert.equal(during.projects[0].older, 1);
  assert.equal(universeAt(short).sessions.length, 1); assert.equal(universeAt(short).projects[0].older, 0);
  fs.appendFileSync(file, JSON.stringify(row('user', base + 150000, 'post-cache')) + '\n');
  f.run('new-run', { started_at: base + 190000, ended_at: now });
  const frozen = short.detail('s');
  assert.ok(frozen.timeline.every((m) => Number.isFinite(m.time)));
  assert.ok(!frozen.timeline.some((m) => m.data.t === 'post-cache' || m.data.id === 'new-run' || m.data.run === 'new-run'));
});

async function collect(url, stop, onFrame = () => {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) }), reader = response.body.getReader(), decoder = new TextDecoder();
  assert.equal(response.status, 200);
  const frames = [], opened = performance.now(); let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!data) continue;
        const message = { event, data: JSON.parse(data), elapsed: performance.now() - opened }; frames.push(message); onFrame(message);
        if (stop(message, frames)) return frames;
      }
    }
  } finally { await reader.cancel(); }
  return frames;
}

async function startServer(t, f, args = [], env = {}) {
  const child = spawn(process.execPath, [path.join(here, '../foreman/skills/dispatch/scripts/board/server.mjs'), '--runs', f.options.runs, '--claude-dir', f.options.claudeDir, '--config', f.options.config,
    '--prices', path.join(here, 'fixtures/board/prices-test.json'), ...args], { cwd: here, env: { ...process.env, FOREMAN_LANG: 'zh', ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'), closed = once(child, 'close');
  t.after(async () => { if (child.exitCode == null && child.signalCode == null) child.kill(); await closed; });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (s) => { buffer += s; if (buffer.includes('\n')) resolve(buffer.split('\n')[0]); });
    child.once('close', () => reject(new Error(stderr || 'no startup response')));
    child.once('error', reject);
  });
  const message = ready.startsWith('{') ? JSON.parse(ready) : { url: ready.match(/board: (http:\/\/\S+)/)[1] };
  const url = message.url ? new URL(message.url) : null;
  return { child, exited, message, url, address: url && `${url.origin}${url.pathname}` };
}

test('无 run 或 Claude Code 记录时，快照和直播仍传递计划及队列，离队后发空快照', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now(), ticket = path.join(f.options.runs, '.state/queue/codex/1.json');
  f.write(ticket, { sequence: 1, pid: process.pid, pid_started_at: new Date(Math.ceil(performance.timeOrigin)).toISOString(),
    expires_at: new Date(at + 60000).toISOString(), queued_at: new Date(at - 1000).toISOString(),
    agent: 'codex', group: 'g', claude_session: 's', plan: 'p', seat: 1, title: 'waiting' });
  f.write(path.join(f.options.runs, 'plans/p.json'), { plan_id: 'p', module: 'run', group: 'g', cell: 'normal', created_at: new Date(at - 2000).toISOString(), seats: [{ seat: 1, agent: 'codex' }] });
  const { address } = await startServer(t, f);
  const snapshot = await (await fetch(`${address}snapshot?session=s`)).json();
  assert.equal(snapshot.runs.length, 0); assert.ok(snapshot.events.some((e) => e.k === 'fplan' && e.plan === 'p'));
  assert.equal(snapshot.events.find((e) => e.k === 'dispatch_queue').tickets.length, 1);
  const frames = await collect(`${address}stream?session=s`, (m) => m.event === 'ev' && m.data.k === 'dispatch_queue' && m.data.tickets.length === 0,
    (m) => { if (m.event === 'ev' && m.data.k === 'dispatch_queue' && m.data.tickets.length) fs.unlinkSync(ticket); });
  assert.equal(frames.filter((m) => m.event === 'ev' && m.data.k === 'fplan').length, 1);
  assert.deepEqual(frames.filter((m) => m.event === 'ev' && m.data.k === 'dispatch_queue').map((m) => m.data.tickets.length), [1, 0]);
});

test('live routes preserve guards and updates, reject replay/from; debug replay shares its clock and from scheduling', { timeout: 15000 }, async (t) => {
  const f = temp(t), liveNow = Date.now();
  f.session('s', [row('user', liveNow - 20000, 'first'), answer(liveNow - 10000)], 'demo', liveNow);
  f.session('other', [row('user', liveNow - 15000, 'other'), answer(liveNow - 5000)], 'demo', liveNow);
  f.run('work', { started_at: liveNow - 18000, ended_at: liveNow - 8000 });
  const child = spawn(process.execPath, [path.join(here, '../foreman/skills/dispatch/scripts/board/server.mjs'), '--runs', f.options.runs, '--claude-dir', f.options.claudeDir, '--config', f.options.config,
    '--window-h', '1', '--prices', path.join(here, 'fixtures/board/prices-test.json')], { cwd: here, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode == null) { child.kill(); await once(child, 'exit'); } });
  const [ready] = await once(child.stdout, 'data'), address = String(ready).match(/board: (http:\/\/\S+?)\?/)[1];
  const response = await fetch(`${address}sessions`); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).sessions.length, 2);
  assert.equal((await fetch(`${address}sessions`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${address}sessions`, { method: 'POST' })).status, 405);
  const badHost = await new Promise((resolve, reject) => http.get(`${address}sessions`, { headers: { Host: 'invalid' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${new URL(address).origin}/wrong/sessions`)).status, 404);
  let added;
  const live = await collect(`${address}stream?level=all`, (m) => m.event === 'session_gone', (m) => {
    if (m.event === 'universe') added = f.session('added', [{ ...row('user', liveNow, 'added'), cwd: 'D:/New' }], 'new', liveNow);
    if (m.event === 'session' && m.data.id === 'added') fs.unlinkSync(added);
  });
  assert.deepEqual(live.slice(0, 2).map((m) => m.event), ['hello', 'universe']);
  assert.ok(live.findIndex((m) => m.event === 'project') < live.findIndex((m) => m.event === 'session'));
  const snapshot = await (await fetch(`${address}snapshot?session=s`)).json();
  assert.deepEqual(snapshot.hello.scope, { kind: 'session', value: 's' });
  assert.ok(snapshot.events.some((e) => e.k === 'prompt' && e.t === 'first')); assert.ok(!snapshot.events.some((e) => e.t === 'other'));
  for (const route of ['stream', 'snapshot', 'sessions']) for (const query of ['replay=all', 'replay=', 'from=0', 'from=']) for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${address}${route}?${query}`, { method });
    assert.equal(response.status, 400, `${method} ${route}?${query}`); assert.equal(await response.text(), '');
  }
  const debug = await startServer(t, f, ['--replay', 'all', '--maxgap', '0.2']), replayAddress = debug.address;
  const replay = await collect(`${replayAddress}stream?level=all&replay=all`, (m) => m.event === 'done');
  assert.deepEqual(replay.slice(0, 2).map((m) => m.event), ['hello', 'universe']);
  const clock = replay[0].data.replay, all = await (await fetch(`${replayAddress}snapshot?session=s&replay=all`)).json();
  assert.deepEqual(all.hello.replay, clock);
  const everything = await collect(`${replayAddress}stream?session=s&replay=all&from=${clock.end}`, (m) => m.event === 'done');
  const messages = everything.filter((m) => ['run', 'ev'].includes(m.event));
  const expected = createUniverse(f.options).replay({ maxgap: 0.2 }, replay[0].data.now).detail('s').timeline;
  assert.deepEqual(messages.map(({ event, data }) => ({ event, data })), expected.map(({ event, data }) => ({ event, data })));
  const from = expected.at(-1).time - 150;
  const detail = await collect(`${replayAddress}stream?session=s&replay=all&from=${from}`, (m) => m.event === 'done');
  assert.deepEqual(detail[0].data.replay, clock);
  assert.deepEqual(detail.filter((m) => ['run', 'ev'].includes(m.event)).map(({ event, data }) => ({ event, data })), messages.map(({ event, data }) => ({ event, data })));
  const timed = detail.filter((m) => ['run', 'ev'].includes(m.event));
  assert.ok(timed.filter((_, i) => expected[i].time <= from).every((m) => m.elapsed < 100));
  assert.ok(timed.find((_, i) => expected[i].time > from).elapsed >= 100);
  const startState = await (await fetch(`${replayAddress}sessions?replay=all&t=0`)).json(); assert.equal(startState.sessions.length, 0);
});

test('review 1: session rejects empty and traversal requests and transcript lookup stays in its project', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now(), outside = path.join(f.root, 'outside.jsonl');
  f.write(outside, JSON.stringify(row('user', at, 'OUTSIDE_CANARY')) + '\n');
  f.session('safe-1.x_y', [row('user', at, 'safe')], 'demo', at);
  const { address } = await startServer(t, f);
  for (const session of ['', '../../outside', '..', 'a..b', '/absolute', '_bad', 'a/b', 'a\\b']) {
    for (const route of ['stream', 'snapshot']) for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${address}${route}?${new URLSearchParams({ session })}`, { method });
      assert.equal(response.status, 400, `${method} ${route} ${session}`); assert.equal(await response.text(), '');
    }
  }
  const safe = await (await fetch(`${address}snapshot?session=safe-1.x_y`)).json();
  assert.ok(safe.events.some((e) => e.t === 'safe'));
  const original = fs.statSync;
  t.mock.method(fs, 'statSync', function (file, ...args) { assert.notEqual(path.resolve(file), outside); return original.call(this, file, ...args); });
  assert.deepEqual(createFeed(f.options.runs, f.options).read({ session: '../../outside' }, at).events, []);
});

test('review 2: live addresses carry group/run; debug JSON addresses carry replay=all and only a single resolved session flies in', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now(), id = '20261023-120000-rep1';
  f.session('s', [row('user', at - 1000, 's')], 'demo', at);
  f.session('other', [row('user', at - 500, 'other')], 'demo', at);
  f.run(id, { group: 'g', started_at: at - 1000, ended_at: at - 500 });
  f.run('other', { claude_session: 'other', group: 'g', started_at: at - 500, ended_at: at });
  const cases = [
    [[], { level: 'all' }],
    [['--replay', 'all', '--speed', '9', '--maxgap', '2'], { level: 'all', replay: 'all', lang: 'zh', speed: '9', maxgap: '2' }],
    [['--group', 'g'], { level: 'all', group: 'g' }], [['--run', 'r'], { level: 'all', run: 'r' }],
    [['--replay', 's'], { level: 'all', replay: 'all', lang: 'zh', s: 's' }],
    [['--replay', id], { level: 'all', replay: 'all', lang: 'zh', s: 's' }],
    [['--replay', 'g'], { level: 'all', replay: 'all', lang: 'zh' }],
  ];
  for (const [args, expected] of cases) assert.deepEqual(Object.fromEntries((await startServer(t, f, args)).url.searchParams), expected);
});

test('debug replay has no live lock/error files, injects its mode and enforces replay-only routes and security guards', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now();
  f.session('s', [row('user', at - 1000, 's')], 'demo', at);
  const { address, message, url } = await startServer(t, f, ['--replay', 's', '--speed', '1000']);
  assert.deepEqual(Object.keys(message), ['url']);
  assert.match(url.pathname, /^\/[a-f0-9]{32}\/$/);
  for (const name of ['board.lock.json', 'board.err']) assert.equal(fs.existsSync(path.join(f.options.runs, name)), false);
  const page = await fetch(`${address}?lang=en`), html = await page.text();
  assert.ok(page.headers.get('content-security-policy').includes("connect-src 'self'"));
  assert.ok(html.includes("window.__BOARD_MODE__ = 'replay';"));
  assert.ok(!html.includes("window.__BOARD_MODE__ = 'live';"));
  assert.ok(html.includes("window.__LANG__ = 'en';"));
  assert.ok(html.includes('<div id="notice" role="status"></div>'));
  for (const route of ['sessions', 'stream?level=all', 'snapshot?session=s']) for (const replay of ['', 'replay=s', 'replay=']) for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${address}${route}${route.includes('?') ? '&' : '?'}${replay}`, { method });
    assert.equal(response.status, 400, `${method} ${route} ${replay}`);
  }
  for (const route of ['stream', 'snapshot']) for (const method of ['GET', 'HEAD']) {
    assert.equal((await fetch(`${address}${route}?session=missing&replay=all`, { method })).status, 404);
    assert.equal((await fetch(`${address}${route}?replay=all`, { method })).status, 400);
  }
  assert.equal((await fetch(`${address}sessions?replay=all`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${new URL(address).origin}/wrong/health`)).status, 404);
  const badHost = await new Promise((resolve, reject) => http.get(`${address}health`, { headers: { Host: 'invalid' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${address}health`)).status, 200);
  const stream = await collect(`${address}stream?level=all&replay=all`, (m) => m.event === 'done');
  assert.deepEqual(stream.slice(0, 2).map((m) => m.event), ['hello', 'universe']);
  for (const name of ['board.lock.json', 'board.err']) f.write(path.join(f.options.runs, name), `live ${name}`);
  await startServer(t, f, ['--replay', 's']);
  for (const name of ['board.lock.json', 'board.err']) assert.equal(fs.readFileSync(path.join(f.options.runs, name), 'utf8'), `live ${name}`);
});

for (const [target, expected] of [['s', ['s']], ['20261023-120000-pick', ['s']], ['picked', ['other', 's']]]) {
  test(`debug replay passes the resolved sessions to universe.replay (${target})`, { timeout: 10000 }, async (t) => {
    const f = temp(t), at = Date.now();
    for (const id of ['s', 'other', 'unrelated']) f.session(id, [row('user', at - 1000, id)], 'demo', at);
    f.run('20261023-120000-pick', { group: 'picked', started_at: at - 1000, ended_at: at });
    f.run('duplicate', { group: 'picked', started_at: at - 1000, ended_at: at });
    f.run('other', { group: 'picked', claude_session: 'other', started_at: at - 1000, ended_at: at });
    const { address } = await startServer(t, f, ['--replay', target]);
    const data = await (await fetch(`${address}sessions?replay=all`)).json();
    assert.deepEqual(data.sessions.map((s) => s.id).sort(), expected);
    assert.equal((await fetch(`${address}snapshot?session=unrelated&replay=all`)).status, 404);
  });
}

test('debug replay reports a missing target as one error JSON and exit code 1 without touching live files', { timeout: 10000 }, async (t) => {
  const f = temp(t), { message, exited } = await startServer(t, f, ['--replay', 'missing']);
  assert.equal((await exited)[0], 1);
  assert.equal(message.code, 'NOT_FOUND'); assert.ok(message.error.includes('missing')); assert.equal(message.url, undefined);
  for (const name of ['board.lock.json', 'board.err']) assert.equal(fs.existsSync(path.join(f.options.runs, name)), false);
});

// 演示页的明细按组回放：回放服务第一次请求时构建；范围里没有任务的 404；对话记录都删掉了的组算找不到
test('debug replay serves a single group or run replay for the demo page, and skips conversations whose transcript is gone', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now();
  f.session('s', [row('user', at - 1000, 's')], 'demo', at);
  f.run('20261023-120000-grp1', { group: 'g', started_at: at - 1000, ended_at: at - 500 });
  f.run('20261023-120000-gone', { group: 'orphans', claude_session: 'deleted', started_at: at - 1000, ended_at: at - 500 });
  const { address } = await startServer(t, f, ['--replay', 'all', '--speed', '1000']);
  const group = await collect(`${address}stream?replay=g&speed=1000`, (m) => m.event === 'done'); // 单个范围的回放按请求自己的速度放
  assert.equal(group[0].event, 'hello'); assert.equal(group[0].data.mode, 'replay');
  assert.ok(group.some((m) => m.event === 'run' && m.data.id === '20261023-120000-grp1'));
  assert.equal((await fetch(`${address}snapshot?replay=g&t=0`)).status, 200);
  assert.equal((await fetch(`${address}stream?replay=nothing-here`)).status, 404);
  const gone = await startServer(t, f, ['--replay', 'orphans']);
  assert.equal((await gone.exited)[0], 1); assert.equal(gone.message.code, 'NOT_FOUND');
});

test('debug replay forwards the test build limit to createUniverse and reports REPLAY_TOO_LARGE before listening', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now();
  f.session('s', [row('user', at - 1000, 'large'.repeat(1000))], 'demo', at);
  const { message, exited } = await startServer(t, f, ['--replay', 's', '--idle-min', '0.001'], { FOREMAN_TEST_REPLAY_LIMIT_BYTES: '100' });
  assert.equal((await exited)[0], 1);
  assert.equal(message.code, 'REPLAY_TOO_LARGE'); assert.equal(typeof message.error, 'string');
  assert.ok(message.bytes > message.limit); assert.equal(message.limit, 100); assert.equal(message.url, undefined);
  for (const name of ['board.lock.json', 'board.err']) assert.equal(fs.existsSync(path.join(f.options.runs, name)), false);
});

test('debug replay exits on idle even if nobody ever connected and an active run exists', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now();
  f.session('s', [row('user', at - 1000, 's')], 'demo', at);
  f.run('running', { status: 'running', started_at: at - 1000, ended_at: null });
  const { exited } = await startServer(t, f, ['--replay', 's', '--idle-min', '0.02']);
  const opened = performance.now();
  assert.equal((await exited)[0], 0);
  assert.ok(performance.now() - opened >= 1000);
  assert.ok(performance.now() - opened < 4000);
});

test('page mode strips live replay/from before connecting, retains legacy fly-in, notice, demo and fixture behavior', async () => {
  const fixture = { hello: { v: 3, mode: 'replay', now: 0, scope: { kind: 'run', value: 'r' }, replay: { start: 0, end: 1000, speed: 1, maxgap: 20 } },
    runs: [{ id: 'r', lane: 'r', kind: 'exec', status: 'done', started_at: 0, ended_at: 1000 }], events: [] };
  const sources = ['00-text.js', '01-state.js', '01-universe.js', '08-uni-fly.js'].map((name) => fs.readFileSync(path.join(here, '../board/web', name), 'utf8')).join('\n');
  const main = fs.readFileSync(path.join(here, '../board/web/09-main.js'), 'utf8').split("history.scrollRestoration = 'manual';")[1];
  for (const [query, mode, runSession, pending, route] of [
    ['replay=20261023-120000-pick&from=123&lang=zh', 'live', 'assigned', 'assigned', 'snapshot?run=20261023-120000-pick'],
    ['replay=group&from=0&s=&focus=here', 'live', 'assigned', 'assigned', 'snapshot?group=group'],
    // 查不到的组名不再当成对话 id 飞进去，改为提示找不到
    ['replay=orphan', 'live', null, null, 'snapshot?group=orphan'],
    ['replay=all&from=0', 'live', null, null, null],
    ['from=1&s=chosen', 'live', null, 'chosen', null],
    ['replay=all&s=chosen', 'replay', null, 'chosen', null],
    ['demo=universe&replay=all&from=0', 'live', null, null, null],
    ['fixture=1&replay=all&from=0', 'live', null, null, null],
  ]) {
    const requests = [], streams = [], timers = [], classes = [], replacements = [], notice = { textContent: '', classList: { add: (name) => classes.push(name), remove() {} }, addEventListener() {} };
    const exempt = query.includes('demo=') || query.includes('fixture='), showNotice = mode === 'live' && !exempt;
    const context = vm.createContext({
      URL, URLSearchParams, location: { search: `?${query}`, href: `http://127.0.0.1/token/?${query}` },
      window: { __LANG__: 'zh', __BOARD_MODE__: mode, __BOARD_FIXTURE__: query.includes('fixture=') ? fixture : undefined },
      history: { replaceState: (_a, _b, url) => replacements.push(String(url)) }, performance: { getEntriesByType: () => [], now: () => 0 },
      $: () => notice, addEventListener() {}, wake() {}, playDemo() {},
      setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {},
      fetch: async (url) => { requests.push(url); return { ok: true, json: async () => ({ runs: runSession ? [{ session: runSession }] : [] }) }; },
      EventSource: class { constructor(url) { streams.push(url); } addEventListener() {} },
      document: { visibilityState: 'visible', addEventListener() {} },
    });
    vm.runInContext(sources + '\n' + main, context);
    await new Promise(setImmediate);
    assert.equal(vm.runInContext('FLY.pending', context), pending, query);
    assert.deepEqual(requests, route ? [route] : [], query);
    const expectedNotice = query === 'replay=orphan' ? '记录里找不到这个地址里的组：orphan'
      : showNotice ? '回放是调试功能，这里显示的是实时画面。要回放，请运行 board --replay <对话、任务或组>' : '';
    assert.equal(notice.textContent, expectedNotice, query);
    // 查不到的组先后有两条提示（回放链接的说明、找不到），各自一个淡出计时
    assert.equal(timers.length, showNotice ? (query === 'replay=orphan' ? 2 : 1) : 0, query);
    if (showNotice) {
      assert.equal(timers[0].ms, 12000); timers[0].fn(); assert.deepEqual(classes, ['faded']);
      const cleaned = new URL(replacements[0]); assert.equal(cleaned.searchParams.has('replay'), false); assert.equal(cleaned.searchParams.has('from'), false);
      for (const [key, value] of new URLSearchParams(query)) if (!['replay', 'from'].includes(key)) assert.equal(cleaned.searchParams.get(key), value);
      assert.deepEqual(streams, ['stream?level=all']);
    } else if (query.includes('fixture=')) {
      // 内嵌快照直接显示看板：不连任何服务，快照里的任务已经读进来
      assert.deepEqual(streams, []); assert.equal(vm.runInContext('FLY.mode', context), 'board');
      assert.equal(vm.runInContext('B.runs.size', context), 1);
    } else if (!query.includes('demo=')) assert.deepEqual(streams, ['stream?level=all&replay=all']);
  }
});

// 老地址找对话：任务取它自己的对话，组取最近派出的那一份；group=all 是合法组名；结果回来前用户动过页面就不飞；
// 飞进去以后地址只记 s，老范围参数去掉（回放服务保留 replay=all）
test('legacy links pick the right conversation, honour a touch before the answer and leave only s in the address', async () => {
  const sources = ['00-text.js', '01-state.js', '01-universe.js', '08-uni-fly.js'].map((name) => fs.readFileSync(path.join(here, '../board/web', name), 'utf8')).join('\n');
  const main = fs.readFileSync(path.join(here, '../board/web/09-main.js'), 'utf8').split("history.scrollRestoration = 'manual';")[1];
  const runs = [{ id: '20261023-120000-root', session: 'first', started_at: 1 }, { id: '20261023-130000-next', session: 'second', started_at: 2 }];
  const page = async (query, { mode = 'live', touch = false } = {}) => {
    const requests = [], replacements = [], listeners = [];
    const context = vm.createContext({
      URL, URLSearchParams, location: { search: `?${query}`, href: `http://127.0.0.1/token/?${query}` },
      window: { __LANG__: 'zh', __BOARD_MODE__: mode }, history: { replaceState: (_a, _b, url) => replacements.push(String(url)) },
      performance: { getEntriesByType: () => [] }, $: () => ({ textContent: '', classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {} }),
      addEventListener: (type, fn) => listeners.push([type, fn]), wake() {}, playDemo() {}, setTimeout() {}, clearTimeout() {},
      fetch: async (url) => { requests.push(url); if (touch) for (const [type, fn] of listeners) if (type === 'pointerdown') fn(); return { ok: true, json: async () => ({ runs }) }; },
      EventSource: class { addEventListener() {} },
      document: { visibilityState: 'visible', addEventListener() {} },
    });
    vm.runInContext(sources + '\n' + main, context);
    await new Promise(setImmediate);
    return { pending: vm.runInContext('FLY.pending', context), requests, replacements, context };
  };
  assert.equal((await page('run=20261023-120000-root')).pending, 'first'); // 不是车道里最新的 second
  assert.equal((await page('group=g')).pending, 'second');
  assert.deepEqual((await page('group=all')).requests, ['snapshot?group=all']);
  assert.equal((await page('run=20261023-120000-root', { touch: true })).pending, null);
  for (const [mode, kept] of [['live', null], ['replay', 'all']]) {
    const p = await page('level=all&replay=all&group=g&run=r&session=x', { mode });
    vm.runInContext("setUrl('chosen')", p.context);
    const url = new URL(p.replacements.at(-1));
    assert.equal(url.searchParams.get('s'), 'chosen'); assert.equal(url.searchParams.get('replay'), kept);
    for (const key of ['group', 'run', 'session']) assert.equal(url.searchParams.has(key), false);
  }
});

test('review 3: live session keeps current and appended activity beyond the run tail without changing group/run', (t) => {
  const f = temp(t), file = f.session('s', [row('user', base - 700000, 'before'), row('user', now, 'current')]);
  f.run('work', { group: 'g', started_at: base - 700000, ended_at: base - 600000 });
  const feed = createFeed(f.options.runs, f.options), prompts = (scope) => feed.read(scope, now).events.filter((e) => e.k === 'prompt').map((e) => e.t);
  assert.deepEqual(prompts({ group: 'g' }), ['before']); assert.deepEqual(prompts({ run: 'work' }), ['before']);
  assert.deepEqual(prompts({ session: 's' }), ['before', 'current']);
  fs.appendFileSync(file, JSON.stringify(row('user', now + 600000, 'appended')) + '\n');
  assert.deepEqual(prompts({ session: 's' }), ['before', 'current', 'appended']);
  assert.deepEqual(prompts({ group: 'g' }), ['before']); assert.deepEqual(prompts({ run: 'work' }), ['before']);
  // 没有任务的对话也是整个对话（半小时窗口只给没选对话的"最近动静"视图）
  f.session('no-runs', [row('user', now - 1800001, 'early'), row('user', now + 1, 'open end')]);
  assert.deepEqual(prompts({ session: 'no-runs' }), ['early', 'open end']);
});

test('review 4: session replay includes the entire transcript with a finite idle time, with or without runs', (t) => {
  const f = temp(t);
  f.session('s', [row('user', now - 10800000, 'old'), answer(now - 7200000)]);
  const check = () => {
    const data = createFeed(f.options.runs, f.options).read({ session: 's', replay: 's' }, now);
    assert.ok(data.events.some((e) => e.t === 'old')); assert.equal(data.hostEnd, now - 7200000);
    const own = buildReplay(data, {}, now); assert.ok(own.timeline.every((m) => Number.isFinite(m.time)));
    const all = createUniverse(f.options).replay(), detail = all.detail('s');
    assert.ok(detail.timeline.some((m) => m.data.t === 'old'));
    assert.equal(detail.timeline.find((m) => m.event === 'run' && m.data.id === 'cc' && m.data.status === 'idle').time, all.clock.map(data.hostEnd));
  };
  check(); f.run('work', { started_at: now - 10000, ended_at: now - 5000 }); check();
  const sampleReplay = createUniverse(sample).replay();
  assert.ok(sampleReplay.detail('demo-readme').timeline.some((m) => m.event === 'ev' && m.data.k === 'prompt'));
});

test('review 5: transcript LRU retains three files across session/recent/group/run and evicts only the least used', (t) => {
  const f = temp(t), files = ['a', 'b', 'c', 'd'].map((id) => f.session(id, [row('user', now - 1000, id)]));
  const ids = files.map((_, i) => `20261022-09000${i}-lru${i}`);
  ids.forEach((id, i) => f.run(id, { claude_session: ['a', 'b', 'c', 'd'][i], group: `g${i}`, started_at: now - (i + 1) * 1000, ended_at: now - 500 }));
  const original = fs.openSync, reads = new Map(files.map((file) => [file, 0]));
  t.mock.method(fs, 'openSync', function (file, ...args) { if (reads.has(file)) reads.set(file, reads.get(file) + 1); return original.call(this, file, ...args); });
  const feed = createFeed(f.options.runs, f.options);
  const scopes = [{ session: 'a' }, { group: 'g1' }, { run: ids[2] }, {}, { session: 'd' }, { session: 'c' }, { session: 'a' }];
  for (const [i, scope] of scopes.entries()) {
    const data = feed.read(scope, now);
    assert.ok(data.runs.some((r) => r.id === 'cc'));
    assert.deepEqual(data.events.filter((e) => e.run === 'cc' && e.k === 'prompt').map((e) => e.t), [['a'], ['b'], ['c'], ['a'], ['d'], ['c'], ['a']][i]);
  }
  // 不再缓存原始行，a/c 换窗口需要重读；同一窗口仍复用，b 被三文件 LRU 淘汰后才重新打开。
  assert.deepEqual([...reads.values()], [3, 1, 2, 1]);
  feed.read({ session: 'a' }, now); feed.read({ session: 'c' }, now);
  assert.deepEqual([...reads.values()], [3, 1, 2, 1]);
  feed.read({ group: 'g1' }, now); assert.deepEqual([...reads.values()], [3, 2, 2, 1]);
});

test('review 6: debug replay freezes universe and detail once before listening and reuses them across streams and queries', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now();
  f.session('s', [row('user', at - 20000, 'first')], 'demo', at);
  const { address } = await startServer(t, f, ['--replay', 'all', '--speed', '1000', '--maxgap', '1']);
  const snapshot = async (maxgap) => (await (await fetch(`${address}sessions?replay=all&speed=1000&maxgap=${maxgap}`)).json()).sessions.map((s) => s.id).sort();
  assert.deepEqual(await snapshot(1), ['s']);
  f.session('second', [row('user', at - 10000, 'second')], 'demo', at);
  assert.deepEqual(await snapshot(1), ['s']);
  f.session('s', [row('user', at - 20000, 'changed after startup')], 'demo', at);
  const stream = await collect(`${address}stream?level=all&replay=all&speed=1000&maxgap=1`, (m) => m.event === 'done');
  assert.ok(stream.some((m) => m.event === 'session' && m.data.id === 's'));
  assert.ok(!stream.some((m) => m.event === 'session' && m.data.id === 'second'));
  assert.deepEqual(await snapshot(1), ['s']);
  const detail = await collect(`${address}stream?session=s&replay=all&from=${stream[0].data.replay.end}`, (m) => m.event === 'done');
  assert.deepEqual(detail[0].data.replay, stream[0].data.replay); assert.ok(detail.some((m) => m.event === 'ev' && m.data.t === 'first'));
  assert.ok(!JSON.stringify(detail).includes('changed after startup'));
  assert.deepEqual(await snapshot(2), ['s']);
  f.session('third', [row('user', at - 5000, 'third')], 'demo', at);
  assert.deepEqual(await snapshot(1), ['s']);
  assert.deepEqual(await snapshot(3), ['s']);
  assert.deepEqual(await snapshot(1), ['s']);
  assert.deepEqual(await snapshot(2), ['s']);
});

test('review 7: older-only projects read just the newest file header up to 64 KB and cache by file/mtime', (t) => {
  const f = temp(t), older = f.session('older', [row('user', now - 4 * 86400000, 'older')], 'old', now - 4 * 86400000);
  const file = f.session('latest', [row('user', now - 2 * 86400000, 'latest')], 'old', now - 2 * 86400000);
  fs.appendFileSync(file, 'x'.repeat(70000)); fs.utimesSync(file, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
  const hidden = path.join(f.options.claudeDir, 'hidden', 'old.jsonl');
  f.write(hidden, JSON.stringify({ padding: 'x'.repeat(65536) }) + '\n' + JSON.stringify(row('user', now - 86400001, 'hidden')) + '\n');
  fs.utimesSync(hidden, new Date(now - 86400001), new Date(now - 86400001));
  const open = fs.openSync, read = fs.readSync, descriptors = new Map(), reads = [];
  t.mock.method(fs, 'openSync', function (name, ...args) { assert.notEqual(name, older); const fd = open.call(this, name, ...args); descriptors.set(fd, name); return fd; });
  t.mock.method(fs, 'readSync', function (fd, buffer, offset, length, position) { reads.push({ file: descriptors.get(fd), length, position }); return read.call(this, fd, buffer, offset, length, position); });
  const universe = createUniverse(f.options), first = universe.read();
  assert.equal(first.sessions.length, 0); assert.equal(first.projects.find((p) => p.key === 'c:/demo/project').older, 2);
  assert.equal(first.projects.find((p) => p.key === '?').older, 1);
  universe.read(now + 1000); assert.equal(reads.filter((r) => r.file === file).length, 1);
  assert.ok(reads.every((r) => r.length <= 65536 && r.position === 0));
  f.session('latest', [{ ...row('user', now - 1.5 * 86400000, 'updated'), cwd: 'D:/Older' }], 'old', now - 1.5 * 86400000);
  assert.equal(universe.read(now + 30001).projects.find((p) => p.key === 'd:/older').older, 2);
  assert.equal(reads.filter((r) => r.file === file).length, 2);
});

test('review 8: index scans top folders every 2 s, projects on mtime/30 s and stats only active known files', (t) => {
  const f = temp(t), active = f.session('s', [row('user', now, 'active')]);
  const old = [f.session('old1', [row('user', now - 40000, 'old1')], 'demo', now - 40000), f.session('old2', [row('user', now - 50000, 'old2')], 'demo', now - 50000)];
  const dir = path.dirname(active); fs.utimesSync(dir, new Date(now), new Date(now));
  const readdir = fs.readdirSync, stat = fs.statSync, lists = new Map(), stats = new Map();
  let busy = false;
  t.mock.method(fs, 'readdirSync', function (name, ...args) { lists.set(name, (lists.get(name) || 0) + 1); return readdir.call(this, name, ...args); });
  t.mock.method(fs, 'statSync', function (name, ...args) { stats.set(name, (stats.get(name) || 0) + 1); if (busy && name === active) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return stat.call(this, name, ...args); });
  const universe = createUniverse({ ...f.options, windowH: 0.01 });
  assert.equal(universe.read(now).projects[0].older, 2);
  universe.read(now + 1000); universe.read(now + 1999);
  assert.equal(lists.get(f.options.claudeDir), 1); assert.equal(lists.get(dir), 1);
  assert.deepEqual(old.map((file) => stats.get(file)), [1, 1]); assert.ok(stats.get(active) > 1);
  f.session('new', [row('user', now + 2000, 'new')], 'demo', now + 2000); fs.utimesSync(dir, new Date(now + 2000), new Date(now + 2000));
  assert.ok(universe.read(now + 2000).sessions.some((s) => s.id === 'new')); assert.equal(lists.get(dir), 2);
  f.session('new-project', [row('user', now + 2001, 'new project')], 'second', now + 2001);
  assert.ok(!universe.read(now + 3999).sessions.some((s) => s.id === 'new-project'));
  assert.ok(universe.read(now + 4000).sessions.some((s) => s.id === 'new-project'));
  assert.equal(lists.get(f.options.claudeDir), 3); assert.equal(lists.get(dir), 2);
  universe.read(now + 31999); assert.equal(lists.get(dir), 2);
  busy = true; const before = universe.read(now + 32000); busy = false;
  assert.ok(before.sessions.some((s) => s.id === 's')); assert.equal(lists.get(dir), 3); assert.deepEqual(old.map((file) => stats.get(file)), [3, 3]);
  const after = universe.read(now + 36001);
  assert.ok(universeChanges(before, after).some((m) => m.event === 'session_gone' && m.data.id === 's'));
  assert.equal(after.projects.find((p) => p.key === 'c:/demo/project').older, 3);
});

test('review 9: replay ids without runs resolve to a full session while group/run selection stays intact', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now();
  f.session('orphan', [row('user', at - 14400000, 'old orphan')], 'demo', at);
  const data = createFeed(f.options.runs, f.options).read({ replay: 'orphan' }, at);
  assert.deepEqual(data.scope, { kind: 'session', value: 'orphan' }); assert.ok(data.events.some((e) => e.t === 'old orphan'));
  const runs = [{ id: 'r', meta: { group: 'g', claude_session: 'assigned' } }];
  for (const [value, kind] of [['g', 'group'], ['r', 'run'], ['assigned', 'session'], ['orphan', 'session']]) assert.equal(selectScope(runs, { replay: value }, at).scope.kind, kind);
  const { address } = await startServer(t, f, ['--replay', 'orphan']);
  const snapshot = await (await fetch(`${address}snapshot?session=orphan&replay=all`)).json();
  assert.deepEqual(snapshot.hello.scope, data.scope); assert.ok(snapshot.events.some((e) => e.t === 'old orphan'));
});

test('review 10: universe snapshots reject level all on snapshot and use sessions instead', { timeout: 10000 }, async (t) => {
  const f = temp(t), { address } = await startServer(t, f);
  for (const query of ['level=all', 'level=all&replay=all']) for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${address}snapshot?${query}`, { method }); assert.equal(response.status, 400); assert.equal(await response.text(), '');
  }
  const response = await fetch(`${address}sessions`); assert.equal(response.status, 200); assert.equal((await response.json()).v, 3);
  const debug = await startServer(t, f, ['--replay', 'all']);
  const replay = await fetch(`${debug.address}sessions?replay=all&t=0`); assert.equal(replay.status, 200); assert.equal((await replay.json()).v, 3);
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(`${debug.address}snapshot?level=all&replay=all`, { method })).status, 400);
});

test('review 11: invalid dates never enter replay clocks and nonfinite playback deadlines finish without spinning', { timeout: 10000 }, async (t) => {
  const f = temp(t), at = Date.now();
  f.session('s', [row('user', at - 1000, 'safe'), { type: 'custom-title', timestamp: 'invalid-date', customTitle: 'invalid time' }], 'demo', at);
  f.run('bad-start', { started_at: 'invalid-date', ended_at: at - 100 });
  f.run('bad-end', { started_at: at - 500, ended_at: 'invalid-date' });
  const data = createFeed(f.options.runs, f.options).read({ session: 's', replay: 's' }, at);
  data.events.push({ run: 'bad-end', lane: 'bad-end', ts: NaN, k: 'msg' });
  const own = buildReplay(data, {}, at), all = createUniverse(f.options).replay({}, at);
  for (const replay of [own, all, all.detail('s')]) {
    assert.ok(Number.isFinite(replay.hello.replay.start) && Number.isFinite(replay.hello.replay.end));
    assert.ok(replay.timeline.every((m) => Number.isFinite(m.time)));
    assert.ok(!replay.timeline.some((m) => m.data.id === 'bad-start' || m.data.run === 'bad-start' || m.data.runs?.some((r) => r.id === 'bad-start')));
  }
  const { address } = await startServer(t, f, ['--replay', 's', '--speed', '1e-320']);
  const frames = await collect(`${address}stream?session=s&replay=all`, (m) => m.event === 'done');
  assert.deepEqual(frames.map((m) => m.event), ['hello', 'done']);
});

test('image route serves only the image files a run recorded, by index', { timeout: 15000 }, async (t) => {
  const f = temp(t), id = '20261023-120000-img1', png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const bytes = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }; // f.write 会把非字符串转成 JSON
  bytes(path.join(f.root, 'gen', 'a.png'), png); bytes(path.join(f.root, 'work', 'art', 'b.png'), png); bytes(path.join(f.root, 'work', '.env'), 'SECRET=1');
  f.write(path.join(f.options.runs, id, 'meta.json'), { id, module: 'image', kind: 'image', cwd: path.join(f.root, 'work'), status: 'done', started_at: now - 9000, ended_at: now - 1000 });
  f.write(path.join(f.options.runs, id, 'result.json'), { status: 'done', generated_images: [path.join(f.root, 'gen', 'a.png')],
    changes: { files: [{ path: 'art/b.png', status: 'A' }, { path: '.env', status: 'A' }, { path: 'art/gone.png', status: 'D' }] } });
  const { address } = await startServer(t, f);
  const a = await fetch(`${address}image?run=${id}&n=0`);
  assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await a.arrayBuffer()), png);
  assert.equal((await fetch(`${address}image?run=${id}&n=1`)).status, 200);
  // .env 不是图片、art/gone.png 已删除：都不在列表里，序号 2 就没有了
  assert.equal((await fetch(`${address}image?run=${id}&n=2`)).status, 404);
  for (const bad of ['..%2F..%2Fx', '20261023-120000-img1%2F..', 'x']) assert.equal((await fetch(`${address}image?run=${bad}&n=0`)).status, 400);
  assert.equal((await fetch(`${address}image?run=${id}&n=-1`)).status, 400);
});

test('state column lists failed seats of groups that are still running, skips resumed lanes and clears when the group ends', (t) => {
  const f = temp(t); f.session('s', [row('user', now - 40000, 'title')]);
  f.run('a1', { group: 'g', status: 'running', ended_at: null });
  f.run('a2', { group: 'g', status: 'timed_out', started_at: now - 9000, ended_at: now - 4000 });
  f.run('a3', { group: 'g', status: 'timed_out', started_at: now - 9000, ended_at: now - 3000 });
  // 被停下以后又续接了：车道上有更晚的一轮，不算
  f.run('a4', { group: 'g', status: 'cancelled', started_at: now - 9000, ended_at: now - 3500 });
  f.run('a5', { group: 'g', status: 'running', parent: 'a4', started_at: now - 2000, ended_at: null });
  // 别的组已经全部结束：它的失败不再列
  f.run('b1', { group: 'h', status: 'failed', started_at: now - 9000, ended_at: now - 2000 });
  const s = createUniverse(f.options).read().sessions[0];
  assert.deepEqual(s.issues.map((x) => [x.run, x.status]), [['a2', 'timed_out'], ['a3', 'timed_out']]);
  f.run('a1', { group: 'g', status: 'done' }); f.run('a5', { group: 'g', status: 'done', parent: 'a4', started_at: now - 2000 });
  assert.deepEqual(createUniverse(f.options).read().sessions[0].issues, []);
});

test('排队票按对话保持组的问题点和派发状态，每次扫描只读一次票据', (t) => {
  const f = temp(t), dir = path.join(f.options.runs, '.state', 'queue', 'configured'), at = Date.now();
  for (const id of ['other', 'queue-only', 'reused']) f.session(id, [row('user', now - 50000, id), answer(now - 40000)]);
  // reused 的失败结束在排队票之前 11 分多钟（同一个组名隔了很久又用），不算这一批，不再亮
  f.session('s', [row('user', now - 900000, 's'), answer(now - 40000)]);
  f.session('waiting', [row('user', now - 50000, 'waiting'), tool(now - 40000)]);
  // 排队票在样例时间 now - 1000 排上；group-failed 结束得早（不在近期任务列表里），但同组的 group-done 一直跑到 now - 200000，
  // 前后接得上，算同一批
  f.run('group-failed', { group: 'g', plan: 'shared', status: 'timed_out', started_at: now - 800000, ended_at: now - 650000 });
  f.run('group-done', { group: 'g', plan: 'shared', status: 'done', started_at: now - 700000, ended_at: now - 200000 });
  f.run('other-group', { group: 'h', plan: 'shared', status: 'failed', ended_at: now - 1000 });
  f.run('plan-failed', { group: 'j', plan: 'fallback', status: 'failed', ended_at: now - 3000 });
  f.run('ungrouped-failed', { plan: 'ungrouped', status: 'failed', ended_at: now - 2000 });
  f.run('other-session', { claude_session: 'other', group: 'g', status: 'failed' });
  f.run('old-failed', { claude_session: 'reused', group: 'g2', status: 'failed', started_at: now - 800000, ended_at: now - 700000 });
  const ticket = { pid: process.pid, pid_started_at: new Date(Math.ceil(performance.timeOrigin)).toISOString(),
    queued_at: new Date(now - 1000).toISOString(), expires_at: new Date(at + 60000).toISOString(), agent: 'configured' };
  const files = [
    { claude_session: 's', group: 'g', plan: 'shared' }, { claude_session: 's', plan: 'fallback' },
    { claude_session: 's', plan: 'ungrouped' }, { claude_session: 'queue-only', group: 'new' },
    { claude_session: 'waiting', group: 'g' }, { claude_session: 'missing', group: 'h' }, { claude_session: 'reused', group: 'g2' },
  ].map((fields, i) => { const file = path.join(dir, `${i + 1}.json`); f.write(file, { ...ticket, ...fields }); return file; });
  const readdir = fs.readdirSync, read = fs.readFileSync, listed = new Map(), reads = new Map();
  t.mock.method(fs, 'readdirSync', function (file, ...args) {
    if (file === dir || file === path.dirname(dir)) listed.set(file, (listed.get(file) || 0) + 1);
    return readdir.call(this, file, ...args);
  });
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (files.includes(file)) reads.set(file, (reads.get(file) || 0) + 1);
    return read.call(this, file, ...args);
  });
  const universe = createUniverse(f.options);
  for (let round = 1; round <= 2; round++) {
    const sessions = new Map(universe.read(now + round).sessions.map((s) => [s.id, s]));
    assert.equal(sessions.get('s').state, 'dispatching');
    assert.deepEqual(sessions.get('s').issues.map((r) => r.run), ['group-failed', 'plan-failed', 'ungrouped-failed']);
    assert.ok(!sessions.get('s').runs.some((r) => r.id === 'group-failed'));
    assert.equal(sessions.get('queue-only').state, 'dispatching'); assert.deepEqual(sessions.get('queue-only').runs, []);
    assert.equal(sessions.get('other').state, 'idle'); assert.deepEqual(sessions.get('other').issues, []);
    assert.equal(sessions.get('waiting').state, 'waiting');
    assert.equal(sessions.get('reused').state, 'dispatching'); assert.deepEqual(sessions.get('reused').issues, []);
    assert.equal(listed.get(dir), round); assert.equal(listed.get(path.dirname(dir)), round);
    for (const file of files) assert.equal(reads.get(file), round);
  }
  for (const file of files) fs.unlinkSync(file);
  const sessions = new Map(universe.read(now + 3).sessions.map((s) => [s.id, s]));
  assert.equal(sessions.get('s').state, 'idle'); assert.deepEqual(sessions.get('s').issues, []);
  assert.equal(sessions.get('queue-only').state, 'idle'); assert.equal(sessions.get('waiting').state, 'waiting');
});

test('conversations archived or deleted in the desktop app are left out of the universe, other ones stay', (t) => {
  const f = temp(t);
  for (const id of ['keep', 'archived', 'deleted', 'cli-only']) f.session(id, [row('user', now - 40000, id)]);
  const roots = [path.join(f.root, 'desktop', 'claude-code-sessions')], account = path.join(roots[0], 'org', 'account');
  f.write(path.join(account, 'local_1.json'), { cliSessionId: 'keep', isArchived: false });
  f.write(path.join(account, 'local_2.json'), { cliSessionId: 'archived', isArchived: true, title: sentinel });
  f.write(path.join(account, 'deleted_deleted'), '1792231326911');
  f.write(path.join(account, 'local_3.json'), '{"cliSessionId": "keep", "isArch');
  const ids = (options) => createUniverse(options).read().sessions.map((s) => s.id).sort();
  assert.deepEqual(ids({ ...f.options, desktopRoots: roots }), ['cli-only', 'keep']);
  // 找不到桌面版的数据目录时全部照列
  assert.deepEqual(ids(f.options), ['archived', 'cli-only', 'deleted', 'keep']);
  // 在桌面版里取消归档：下一次重列时回来；元数据没变的文件不重读，5 秒内不重列
  let clock = 0;
  const hidden = desktopHidden(roots, () => clock);
  assert.deepEqual([...hidden()].sort(), ['archived', 'deleted']);
  f.write(path.join(account, 'local_2.json'), { cliSessionId: 'archived', isArchived: false });
  clock = 4999; assert.deepEqual([...hidden()].sort(), ['archived', 'deleted']);
  clock = 5000; assert.deepEqual([...hidden()].sort(), ['deleted']);
  // 正在写、读出来是坏的：沿用上次读到的
  f.write(path.join(account, 'local_2.json'), '{"cliSessionId": "archived", "isArchived": tr');
  clock = 10000; assert.deepEqual([...hidden()].sort(), ['deleted']);
  assert.deepEqual([...desktopHidden([])()], []);
});

test('a seat restarted in the same plan without a parent replaces its failed round, and archived conversations hold no slots', (t) => {
  const f = temp(t); f.session('s', [row('user', now - 40000, 'title')]); f.session('gone', [row('user', now - 40000, 'gone')]);
  f.run('r1', { group: 'g', plan: 'p', seat: 1, status: 'timed_out', started_at: now - 9000, ended_at: now - 6000 });
  f.run('r2', { group: 'g', plan: 'p', seat: 1, status: 'running', started_at: now - 5000, ended_at: null });
  f.run('r3', { group: 'g', plan: 'p', seat: 2, status: 'failed', started_at: now - 9000, ended_at: now - 4000 });
  f.run('x1', { claude_session: 'gone', agent: 'configured', status: 'running', started_at: now - 3000, ended_at: null });
  f.write(f.options.config, { agents: { configured: { type: 'opencode cli', max_parallel: 2 } } });
  const account = path.join(f.root, 'desktop', 'claude-code-sessions', 'org', 'account');
  f.write(path.join(account, 'local_1.json'), { cliSessionId: 'gone', isArchived: true });
  const data = createUniverse({ ...f.options, desktopRoots: [path.join(f.root, 'desktop', 'claude-code-sessions')] }).read();
  assert.deepEqual(data.sessions.map((s) => s.id), ['s']);
  assert.deepEqual(data.sessions[0].issues.map((x) => x.run), ['r3']);
  // 归档对话 gone 的 x1 还在跑，但不占格子；s 的 r2 占一格
  assert.deepEqual(data.agents.find((a) => a.id === 'configured').running.map((r) => r.run).sort(), ['r2']);
});

test('问题点按这一批算：进行中用户又发了消息，这一批还没处理的失败照样亮', (t) => {
  const f = temp(t);
  f.session('mid', [row('user', now - 300000, 'mid'), answer(now - 290000), row('user', now - 50000, 'more'), answer(now - 40000)]);
  f.run('mid-failed', { claude_session: 'mid', group: 'm', status: 'failed', started_at: now - 200000, ended_at: now - 100000 });
  f.run('mid-running', { claude_session: 'mid', group: 'm', status: 'running', started_at: now - 200000, ended_at: null });
  const s = createUniverse(f.options).read(now).sessions.find((x) => x.id === 'mid');
  assert.equal(s.state, 'dispatching'); assert.deepEqual(s.issues.map((r) => r.run), ['mid-failed']);
});

test('取消以后又续接成功的那一轮不算失败，也不再提醒；没续接的失败照算', (t) => {
  const f = temp(t);
  f.session('s', [row('user', now - 300000, 'go'), answer(now - 290000)]);
  f.run('cut', { status: 'cancelled', started_at: now - 200000, ended_at: now - 190000 });
  f.run('cut-2', { parent: 'cut', status: 'done', started_at: now - 180000, ended_at: now - 100000 });
  let s = createUniverse(f.options).read(now).sessions.find((x) => x.id === 's');
  assert.deepEqual(s.counts, { running: 0, done: 1, failed: 0 }); assert.equal(s.alert, null);
  f.run('lost', { status: 'failed', started_at: now - 90000, ended_at: now - 80000 });
  s = createUniverse(f.options).read(now).sessions.find((x) => x.id === 's');
  assert.deepEqual(s.counts, { running: 0, done: 1, failed: 1 }); assert.equal(s.alert.run, 'lost');
});

test('a run that ended normally without a valid report counts as failed, like the board, and the star map keeps no report text', (t) => {
  const f = temp(t);
  f.session('s', [row('user', now - 300000, 'go'), answer(now - 290000)]);
  f.run('live', { group: 'g', status: 'running', ended_at: null });
  f.run('ok', { group: 'g', started_at: now - 9000, ended_at: now - 6000, report: { status: 'completed', summary: sentinel } });
  f.run('empty', { group: 'g', started_at: now - 9000, ended_at: now - 4000, report: null });
  const s = createUniverse(f.options).read(now).sessions.find((x) => x.id === 's');
  assert.deepEqual(s.counts, { running: 1, done: 1, failed: 1 });
  assert.deepEqual(s.issues.map((x) => [x.run, x.status]), [['empty', 'no_result']]);
  assert.deepEqual([s.alert.run, s.alert.kind], ['empty', 'no_result']);
  assert.ok(!JSON.stringify(createUniverse(f.options).read(now)).includes(sentinel));
});

test('each conversation lists every model it used with their output, for the galaxy colours', (t) => {
  const f = temp(t);
  f.session('s', [row('user', now - 40000, 'title')]);
  const run = (id, model, agent, out, fields = {}) => {
    const meta = f.run(id, { model, agent, ...fields });
    if (out != null) f.write(path.join(f.options.runs, id, 'result.json'), { status: meta.status, cost_usd: 1, cost_source: 'api_price', usage: { input_tokens: 10, output_tokens: out } });
  };
  run('q1', 'opencode-go/qwen3.8-flash', 'qwen-oc', 300);
  // 十分钟以前、时间窗口以外的也算（星系按这个对话的全部任务上色，和看板一致）
  run('q2', 'opencode-go/qwen3.8-flash', 'qwen-oc', 200, { started_at: now - 700000, ended_at: now - 650000 });
  run('d1', 'deepseek/deepseek-flash', 'ds-pi', 900);
  run('r1', 'opencode-go/minimax-m3', 'mm-oc', null, { status: 'running', ended_at: null });
  run('host', 'claude-opus-5-5', 'claude code', 50, { participant: 'host' });
  run('outside', 'google/gemini-4-argon', 'gem', 70, { started_at: now - 86400001, ended_at: now - 86400000 });
  const s = createUniverse(f.options).read().sessions[0];
  assert.deepEqual(s.models, [
    { agent: 'ds-pi', model: 'deepseek/deepseek-flash', out: 900, running: false },
    { agent: 'qwen-oc', model: 'opencode-go/qwen3.8-flash', out: 500, running: false },
    { agent: 'gem', model: 'google/gemini-4-argon', out: 70, running: false },
    { agent: 'mm-oc', model: 'opencode-go/minimax-m3', out: 0, running: true },
  ]);
});

test('a resumed conversation counts earlier transcripts older than the window: their usage once each (a zero-usage copy made on resume does not replace the real one) and the runs they dispatched', (t) => {
  const f = temp(t), day = 86400000;
  // 两份先前的记录都在时间窗口以外；m0 从最早那份抄进了中间那份，只算一次
  f.session('oldest', [row('user', now - 3 * day, 'title'), answer(now - 3 * day + 1000, { id: 'm0', usage: { input_tokens: 10, output_tokens: 500 } })], 'demo', now - 3 * day);
  f.session('old', [answer(now - 3 * day + 1000, { id: 'm0', usage: { input_tokens: 10, output_tokens: 500 } }),
    answer(now - 2 * day, { id: 'm1', usage: { input_tokens: 10, output_tokens: 200 } })], 'demo', now - 2 * day);
  // 恢复时新记录抄了上一份正在进行的那条消息 m1，用量全写成 0：不顶掉原来那份
  f.session('new', [answer(now - 2 * day, { id: 'm1', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    row('user', now - 30000, 'title'), answer(now - 20000, { id: 'm2', usage: { input_tokens: 5, output_tokens: 40 } })]);
  f.run('r-oldest', { claude_session: 'oldest', started_at: now - 3 * day, ended_at: now - 3 * day + 5000 });
  f.run('r-new', { claude_session: 'new' });
  const roots = [path.join(f.root, 'desktop', 'claude-code-sessions')];
  f.write(path.join(roots[0], 'org', 'account', 'local_1.json'), { cliSessionId: 'new', priorCliSessionIds: ['oldest', 'old'], isArchived: false });
  const s = createUniverse({ ...f.options, desktopRoots: roots }).read().sessions;
  assert.deepEqual(s.map((x) => x.id), ['new']);
  assert.equal(s[0].usage.output, 740);
  assert.deepEqual(s[0].counts, { running: 0, done: 2, failed: 0 });
  assert.equal(s[0].started_at, now - 3 * day + 1000);
});

test('a conversation resumed under a new session id shows once, with the runs and usage of its earlier transcript; archiving hides both', (t) => {
  const f = temp(t);
  // 新记录开头抄了旧记录的最后一段（同一条消息 m1），用量只算一次
  f.session('old', [row('user', now - 90000, 'title'), answer(now - 80000, { id: 'm1', usage: { input_tokens: 10, output_tokens: 100 } })]);
  f.session('new', [row('user', now - 30000, 'title'), answer(now - 80000, { id: 'm1', usage: { input_tokens: 10, output_tokens: 100 } }),
    answer(now - 20000, { id: 'm2', usage: { input_tokens: 5, output_tokens: 40 } })]);
  f.run('r-old', { claude_session: 'old' }); f.run('r-new', { claude_session: 'new' });
  const roots = [path.join(f.root, 'desktop', 'claude-code-sessions')], meta = path.join(roots[0], 'org', 'account', 'local_1.json');
  const read = () => createUniverse({ ...f.options, desktopRoots: roots }).read();
  f.write(meta, { cliSessionId: 'new', priorCliSessionIds: ['old'], isArchived: false });
  let data = read();
  assert.deepEqual(data.sessions.map((s) => s.id), ['new']);
  assert.deepEqual(data.sessions[0].counts, { running: 0, done: 2, failed: 0 });
  assert.equal(data.sessions[0].usage.output, 140);
  // 现在那一份还没有记录时，旧记录照常单独列
  f.write(meta, { cliSessionId: 'newer', priorCliSessionIds: ['old', 'new'], isArchived: false });
  assert.deepEqual(read().sessions.map((s) => s.id).sort(), ['new', 'old']);
  // 归档：先前的记录一起不列
  f.write(meta, { cliSessionId: 'new', priorCliSessionIds: ['old'], isArchived: true });
  assert.deepEqual(read().sessions, []);
});
