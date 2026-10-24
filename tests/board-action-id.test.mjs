import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalize } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { parseTranscriptLines } from '../foreman/skills/dispatch/scripts/board/claude-feed.mjs';
import * as Display from '../foreman/skills/dispatch/scripts/display.mjs';

const source = readFileSync(new URL('../board/web/03-timeline.js', import.meta.url), 'utf8');
const rates = readFileSync(new URL('../board/web/04-rates.js', import.meta.url), 'utf8');
const run = { id: 'seat' };
const item = (type, id, fields = {}, ts = 0) => ({ type, ts, item: { type: 'command_execution', id, ...fields } });
const cmd = (aid, t, ts = 0) => ({ run: run.id, k: 'cmd', aid, t, ts });
const done = (aid, ok, ts = 2) => ({ run: run.id, k: 'cmd_done', aid, ok, ts });
function page(events, runs = [run]) {
  const lane = { id: runs[0].id, events, runs };
  const context = vm.createContext({ Display, B: { clock: { mode: 'live' } } });
  vm.runInContext(`${source}\n${rates}\nglobalThis.api = { timeline, liveState, commandSpans };`, context);
  return { ...context.api, lane };
}

test('Codex、opencode、pi 的统一 item 编号随开始和结束传递；没有编号时省略 aid', () => {
  for (const id of ['item_1', 'opencode-1', 'pi-1', 0, undefined]) {
    const state = {}, fields = id == null ? {} : { aid: String(id) };
    assert.deepEqual(normalize(item('item.started', id, { command: 'echo demo' }), run, state),
      [{ run: run.id, lane: run.id, ts: 0, k: 'cmd', t: 'echo demo', ...fields }]);
    assert.deepEqual(normalize(item('item.completed', id, { exit_code: 1 }, 1), run, state),
      [{ run: run.id, lane: run.id, ts: 1, k: 'cmd_done', ok: false, ...fields }]);
    assert.deepEqual(normalize(item('item.completed', id, { command: 'echo demo', exit_code: 0 }), run, {}).map((e) => [e.k, e.aid]),
      [['cmd', fields.aid], ['cmd_done', fields.aid]]);
  }
  for (const category of ['read', 'search']) {
    const state = {};
    assert.deepEqual(normalize(item('item.started', category, { category, label: 'src/a' }), run, state), []);
    assert.equal(state.tools.get(category).aid, category);
    assert.equal(normalize(item('item.completed', category), run, state)[0].aid, category);
  }
});

test('并行命令先开始的失败时，时间线和实时状态都标在同一条命令上', () => {
  const state = {}, events = [item('item.started', 'a', { command: 'Get-Location' }),
    item('item.started', 'b', { command: 'node demo.mjs' }, 1), item('item.completed', 'a', { exit_code: 1 }, 2),
    item('item.completed', 'b', { exit_code: 0 }, 3)].flatMap((raw) => normalize(raw, run, state));
  const p = page(events), lines = p.timeline(p.lane, 3, { open: true });
  assert.equal(lines[0].text, '$ Get-Location  ✗ failed'); assert.equal(lines[0].cls, 'act bad');
  assert.equal(lines[1].text, '$ node demo.mjs'); assert.equal(lines[1].cls, 'act');
  assert.deepEqual(Array.from(p.liveState(p.lane, run, 3).recent, (a) => a.tag), ['✗ failed', undefined]);
  assert.ok(p.timeline(p.lane, 1, { open: true }).every((line) => !line.cls.includes('bad')));
});

test('Claude Code 的 Bash 失败按 tool_use.id 配对；没有 id 时不添加 aid', () => {
  const row = (type, content, ts) => ({ type, timestamp: new Date(ts).toISOString(), message: { content } });
  const use = (id, command) => ({ type: 'tool_use', name: 'Bash', id, input: { command } });
  const result = (id, is_error) => ({ type: 'tool_result', tool_use_id: id, is_error, content: '' });
  const { events } = parseTranscriptLines([row('assistant', [use('bash-a', 'exit 1'), use('bash-b', 'node demo.mjs')], 0),
    row('user', [result('bash-a', true)], 1), row('user', [result('bash-b', false)], 2)], {});
  assert.deepEqual(events.map((e) => [e.k, e.aid]), [['cmd', 'bash-a'], ['cmd', 'bash-b'], ['cmd_done', 'bash-a'], ['cmd_done', 'bash-b']]);
  const cc = { id: 'cc' }, p = page(events, [cc]);
  assert.deepEqual(Array.from(p.timeline(p.lane, 2, { open: true }), (line) => line.text), ['$ exit 1  ✗ failed', '$ node demo.mjs']);
  assert.deepEqual(Array.from(p.liveState(p.lane, cc, 2).recent, (a) => a.tag), ['✗ failed', undefined]);
  assert.ok(parseTranscriptLines([row('assistant', [use(undefined, 'exit 1')], 0), row('user', [result(undefined, true)], 1)], {})
    .events.every((e) => !Object.hasOwn(e, 'aid')));
});

test('没有 aid 的旧记录仍把失败挂到最近一条命令', () => {
  const events = [cmd('a', 'first'), cmd('b', 'second', 1), done('a', false)].map(({ aid, ...e }) => e);
  const p = page(events);
  assert.deepEqual(Array.from(p.timeline(p.lane, 2, { open: true }), (line) => line.text), ['$ first', '$ second  ✗ failed']);
  assert.deepEqual(Array.from(p.liveState(p.lane, run, 2).recent, (a) => a.tag), [undefined, '✗ failed']);
});

test('带 aid 的结束没有对应开始时，不误标最近一条命令', () => {
  const p = page([cmd('a', 'first'), done('missing', false)]);
  assert.equal(p.timeline(p.lane, 2, { open: true })[0].text, '$ first');
  assert.equal(p.liveState(p.lane, run, 2).recent[0].tag, undefined);
});

test('同一车道续接的轮次复用 aid 时，失败仍归属原来的轮次', () => {
  const p = page([cmd('a', 'first'), { ...cmd('a', 'second', 1), run: 'resumed' }, done('a', false)], [run, { id: 'resumed' }]);
  assert.deepEqual(Array.from(p.timeline(p.lane, 2, { open: true }), (line) => line.text), ['$ first  ✗ failed', '$ second']);
});

test('当前段及已折叠段里迟到的失败都单独显示，并从折叠计数中扣除', () => {
  for (const closed of [false, true]) {
    const failed = closed ? 4 : 1, events = Array.from({ length: 7 }, (_, i) => cmd(String(i), `command-${i}`, i));
    if (closed) events.push({ run: run.id, k: 'msg', t: 'next block', ts: 7 });
    events.push(done(String(failed), false, 8));
    const p = page(events), lines = p.timeline(p.lane, 8, { open: true });
    const failedLine = lines.find((line) => line.cls === 'act bad');
    assert.equal(failedLine?.text, `$ command-${failed}  ✗ failed`);
    assert.equal(lines.filter((line) => line.cmd).length, 4);
    assert.deepEqual(Array.from(lines.filter((line) => line.cls === 'act fold'), (line) => line.text),
      [Display.foldText({ command: 1 }), Display.foldText({ command: 2 })]);
    assert.ok(p.timeline(p.lane, 8).some((line) => line.text === failedLine.text));
  }
});

test('增加 aid 不改变 commandSpans 对并行命令区间的计算', () => {
  const events = [cmd('a', 'first'), cmd('b', 'second', 1), done('a', false, 2), done('b', true, 3)];
  const p = page(events), spans = (rows) => JSON.parse(JSON.stringify([...p.commandSpans(rows)]));
  assert.deepEqual(spans(events), [[run.id, [{ a: 0, b: 3 }]]]);
  assert.deepEqual(spans(events), spans(events.map(({ aid, ...e }) => e)));
});
