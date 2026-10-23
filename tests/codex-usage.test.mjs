import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import codex from '../foreman/skills/dispatch/scripts/adapters/codex-cli.mjs';
import { sandbox, taskArgs, output, poll, write, MESSAGES } from './helpers.mjs';
import { sessionStats, usage } from './fixtures/reports.mjs';

const sessionId = 'usage-session';
const largerUsage = { input_tokens: 240, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 320 };
const tokenCount = (total = usage) => ({
  type: 'event_msg', payload: { type: 'token_count', ...sessionStats, info: { ...sessionStats.info, total_token_usage: total } },
});
const tokenUsageRecord = (total = usage, threadId = sessionId) => ({
  type: 'token_usage_record', payload: {
    thread_id: threadId, thread_token_usage: total,
    usage: { input_tokens: 1, output_tokens: 1 }, turn_token_usage: { input_tokens: 2, output_tokens: 2 },
  },
});

function usageSession(t) {
  const h = sandbox(t), previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = h.env.CODEX_HOME;
  t.after(() => {
    if (previousHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  });
  // 假 codex 跑在 TZ=UTC 的环境里（helpers.mjs），按它的日期找会话目录；用本地日期的话，UTC+8 的 0–8 点会差一天
  const startedAt = Date.now(), day = new Date(startedAt), pad = (n) => String(n).padStart(2, '0');
  const file = path.join(h.env.CODEX_HOME, 'sessions', String(day.getUTCFullYear()), pad(day.getUTCMonth() + 1), pad(day.getUTCDate()), `rollout-${sessionId}.jsonl`);
  return {
    h, file, stats: () => codex.stats(sessionId, startedAt),
    write: (records) => write(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n'),
  };
}

test('运行中增量读请求用量，按 response_id 去重并过滤旧轮次，收尾读完 UTF-8 半行', async (t) => {
  const s = usageSession(t), h = s.h;
  const first = { input_tokens: 25459, cached_input_tokens: 24576, cache_write_input_tokens: 0, output_tokens: 561, reasoning_output_tokens: 282, total_tokens: 26020 };
  const second = { input_tokens: 10, cached_input_tokens: 3, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 30 };
  const third = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 17 };
  const sum = (...usages) => Object.fromEntries(Object.keys(first).map((key) => [key, usages.reduce((n, u) => n + (u[key] || 0), 0)]));
  const record = (response_id, u, total = u, thread_id = sessionId) => ({ type: 'token_usage_record',
    payload: { thread_id, response_id, usage: u, thread_token_usage: total, turn_token_usage: total } });
  const scenario = h.scenario({ hold: true, session_id: sessionId, rollout: [
    { ...record('resp_1', first), timestamp: '2000-01-01T00:00:00.000Z' },
    record('resp_other', first, first, 'other-thread'), record(null, first),
    record('resp_1', first), record('resp_1', first),
  ] });
  const running = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']), { env: scenario.env }), meta = await h.running();
  const steps = () => h.events(meta.id).filter((e) => e.type === 'step.usage');
  await poll(() => steps().length, 'Codex 首次分段用量');
  const { total_tokens, ...expected } = first;
  assert.deepEqual(steps().map((e) => e.usage), [expected]);
  assert.equal(h.records().find((m) => m.id === meta.id).status, 'running');
  const timestamp = new Date().toISOString();
  const tail = Buffer.from(JSON.stringify({ timestamp, ...record('resp_3', third, sum(first, second, third)), note: '合成' }));
  const cut = tail.indexOf(Buffer.from('合')) + 1;
  fs.appendFileSync(s.file, JSON.stringify({ timestamp, ...record('resp_1', first) }) + '\n'
    + JSON.stringify({ timestamp, ...record('resp_2', second, sum(first, second), '') }) + '\n');
  fs.appendFileSync(s.file, tail.subarray(0, cut));
  await poll(() => steps().length === 2, 'Codex 第二次增量扫描');
  fs.appendFileSync(s.file, tail.subarray(cut));
  output(await h.bridge(['cancel', '--run', meta.id]));
  const r = output(await running.done, 1);
  assert.deepEqual(steps().map((e) => e.usage), [first, second, third].map(({ total_tokens, ...u }) => u));
  assert.ok(steps().every((e) => Number.isFinite(Date.parse(e.ts))));
  assert.deepEqual(r.usage, { input_tokens: 25479, cached_input_tokens: 24579, cache_write_input_tokens: 0, output_tokens: 588, reasoning_output_tokens: 289 });
});

test('快速结束时合并同次扫描的请求用量，再写 turn.completed 总量', async (t) => {
  const h = sandbox(t), record = tokenUsageRecord(), next = tokenUsageRecord();
  record.payload.response_id = 'resp_final';
  next.payload.response_id = 'resp_second';
  next.payload.usage = { input_tokens: 2, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1 };
  const scenario = h.scenario({ session_id: sessionId, rollout: [record, next], rollout_no_newline: true, usage });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: scenario.env }));
  const events = h.events(r.run_id), index = events.findIndex((e) => e.type === 'step.usage');
  assert.ok(index >= 0 && index < events.findIndex((e) => e.type === 'turn.completed'));
  assert.deepEqual(events[index].usage, { input_tokens: 3, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 1 });
  assert.equal(events.filter((e) => e.type === 'step.usage').length, 1);
  assert.deepEqual(r.usage, usage);
});

test('续接时跳过开工前的会话文件，只读新增请求用量', async (t) => {
  const s = usageSession(t), h = s.h;
  const initial = h.scenario({ session_id: sessionId, rollout: [tokenUsageRecord()] });
  const parent = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: initial.env }));
  const old = tokenUsageRecord();
  old.payload.response_id = 'resp_existing';
  fs.appendFileSync(s.file, JSON.stringify({ timestamp: '2099-01-01T00:00:00.000Z', ...old }) + '\n');
  const next = tokenUsageRecord(largerUsage);
  next.payload.response_id = 'resp_new'; next.payload.usage = usage;
  const scenario = h.scenario({ session_id: sessionId, append_rollout: true, rollout: [next] }, 'resume');
  const r = output(await h.bridge(['resume', '--run', parent.run_id, '--level', 'complex', '--brief', '-'], { env: scenario.env }));
  assert.deepEqual(h.events(r.run_id).filter((e) => e.type === 'step.usage').map((e) => e.usage), [usage]);
  assert.equal(r.usage_scope, 'this_run');
  assert.equal(r.usage.input_tokens, 120); assert.equal(r.usage.output_tokens, 40);
});

test('只有 token_count 时保留最新累计用量、最近请求和额度，没有用量记录时为 null', (t) => {
  const s = usageSession(t);
  s.write([{ type: 'session_meta', payload: { id: sessionId } }]);
  assert.equal(s.stats(), null);
  s.write([tokenCount({ input_tokens: 60, output_tokens: 20 }), tokenCount()]);
  assert.deepEqual(s.stats(), {
    total_token_usage: usage, last_request: { tokens: 60, window: 1000 }, rate_limit: sessionStats.rate_limits.primary,
  });
});

test('只有 token_usage_record 时最近请求和额度为 null，runner 取消后记累计用量并说明', async (t) => {
  const s = usageSession(t), h = s.h;
  const scenario = h.scenario({ hold: true, session_id: sessionId, rollout: [tokenUsageRecord()] });
  const running = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']), { env: scenario.env });
  const meta = await h.running();
  const stats = await poll(() => h.records().some((m) => m.id === meta.id && m.session_id === sessionId) && s.stats(), '会话登记并写入用量');
  assert.deepEqual(stats, { total_token_usage: usage, last_request: null, rate_limit: null });
  output(await h.bridge(['cancel', '--run', meta.id]));
  const r = output(await running.done, 1);
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(r.usage, usage);
  assert.ok(r.notes.includes(MESSAGES.zh.cancelledUsagePartial));
});

test('token_usage_record 在后且累计更高时取它，窗口和额度仍取最新 token_count', (t) => {
  const s = usageSession(t);
  const oldCount = tokenCount({ input_tokens: 60, output_tokens: 20 });
  oldCount.payload.info.last_token_usage = { total_tokens: 20 };
  oldCount.payload.rate_limits = { primary: { used_percent: 10, window_minutes: 300, resets_at: 1000000000 } };
  s.write([oldCount, tokenCount(), tokenUsageRecord(largerUsage)]);
  assert.deepEqual(s.stats(), {
    total_token_usage: largerUsage, last_request: { tokens: 60, window: 1000 }, rate_limit: sessionStats.rate_limits.primary,
  });
});

test('token_count 在后但比之前的 token_usage_record 小时仍取 record 的累计用量', (t) => {
  const s = usageSession(t);
  s.write([tokenUsageRecord(), tokenUsageRecord(largerUsage), tokenCount()]);
  assert.deepEqual(s.stats().total_token_usage, largerUsage);
});

test('跳过其他 thread_id 的 record，未写 thread_id 的 record 可以读取', (t) => {
  const s = usageSession(t), record = tokenUsageRecord();
  delete record.payload.thread_id;
  s.write([record, tokenUsageRecord(largerUsage, 'other-thread')]);
  assert.deepEqual(s.stats(), { total_token_usage: usage, last_request: null, rate_limit: null });
});

test('续接基线和结束读数使用同一规则，缺 total_tokens 时按 input 加 output 比较', (t) => {
  const s = usageSession(t);
  const records = [tokenUsageRecord(), tokenCount({ input_tokens: 60, cached_input_tokens: 15, output_tokens: 20, reasoning_output_tokens: 5 })];
  s.write(records);
  const baseline = s.stats().total_token_usage;
  const total = { input_tokens: 240, cached_input_tokens: 60, output_tokens: 80, reasoning_output_tokens: 20 };
  records.push(tokenUsageRecord(total), tokenCount({ input_tokens: 180, cached_input_tokens: 45, output_tokens: 60, reasoning_output_tokens: 15 }));
  s.write(records);
  const final = s.stats().total_token_usage;
  assert.deepEqual(baseline, usage);
  assert.deepEqual(final, total);
  assert.deepEqual(Object.fromEntries(Object.keys(usage).map((key) => [key, final[key] - baseline[key]])), usage);
});

test('1.5 MB 输出挤出 token_usage_record 时扩读，续接相减得到正确的非负用量', (t) => {
  const s = usageSession(t);
  const records = [tokenCount({ input_tokens: 60, output_tokens: 20 }), tokenUsageRecord()];
  s.write(records);
  const baseline = s.stats().total_token_usage;
  records.push(
    tokenCount({ input_tokens: 80, output_tokens: 25 }), tokenUsageRecord(largerUsage),
    { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(1.5 * 1024 * 1024) } },
    tokenCount({ input_tokens: 90, output_tokens: 30 }),
  );
  s.write(records);
  const final = s.stats().total_token_usage;
  assert.deepEqual(baseline, usage);
  assert.deepEqual(final, largerUsage);
  assert.deepEqual(Object.fromEntries(Object.keys(usage).map((key) => [key, final[key] - baseline[key]])), usage);
});

test('最新 token_usage_record 在末尾 4 MB 之外时只使用窗口内的 token_count', (t) => {
  const s = usageSession(t);
  s.write([
    tokenUsageRecord(largerUsage),
    { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(4.5 * 1024 * 1024) } },
    tokenCount(),
  ]);
  assert.deepEqual(s.stats(), {
    total_token_usage: usage, last_request: { tokens: 60, window: 1000 }, rate_limit: sessionStats.rate_limits.primary,
  });
});
