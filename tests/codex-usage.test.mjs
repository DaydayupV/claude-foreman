import test from 'node:test';
import assert from 'node:assert/strict';
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
  const startedAt = Date.now(), day = new Date(startedAt), pad = (n) => String(n).padStart(2, '0');
  const file = path.join(h.env.CODEX_HOME, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()), `rollout-${sessionId}.jsonl`);
  return {
    h, stats: () => codex.stats(sessionId, startedAt),
    write: (records) => write(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n'),
  };
}

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
