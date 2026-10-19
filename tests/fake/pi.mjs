import fs from 'node:fs';
import { setup, replay, finish } from './common.mjs';
import { discussion, review } from '../fixtures/reports.mjs';

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : null;
const operation = args.includes('--version') ? 'version' : args[0] === '--list-models' ? 'list-models' : mode === 'rpc' ? 'catalog' : mode === 'json' ? 'run' : args[0];
const { scenario: s, input } = await setup('pi', operation, args);
const emit = (event) => console.log(JSON.stringify(event));
const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'synthetic thinking' }, { type: 'text', text }],
  provider: 'fake', model: 'model', usage: s.pi_usage || { input: 10, output: 5, cacheRead: 3, cacheWrite: 4, reasoning: 2, totalTokens: 24, cost: { total: 0.25 } },
  stopReason: 'stop', thinkingLevel: s.thinking_level ?? (args.includes('--thinking') ? args[args.indexOf('--thinking') + 1] : null), ...extra });

if (operation === 'version') console.log(s.version || '1.3.0');
else if (operation === 'list-models') {
  console.log('provider  model  context  max-out  thinking  images');
  for (const m of s.pi_catalog || []) console.log(`${m.provider}  ${m.id}  1M  1M  yes  no`);
} else if (operation === 'catalog') {
  // RPC：剧本没给 pi_catalog 时当作读不到清单
  const request = JSON.parse(input.split('\n')[0]);
  if (s.pi_catalog) emit({ id: request.id, type: 'response', command: request.type, success: true, data: { models: s.pi_catalog } });
  else { process.stderr.write('synthetic: no model catalog\n'); process.exitCode = 1; }
} else if (operation === 'run') {
  if (s.guard_file) fs.appendFileSync(s.guard_file, `${process.env.FOREMAN_PI_GUARD}\n`);
  const sessionId = args.includes('--session') ? args[args.indexOf('--session') + 1] : s.session_id || 'synthetic-pi-session';
  if (!args.includes('--no-session')) emit({ type: 'session', version: 3, id: sessionId, cwd: process.cwd() });
  emit({ type: 'agent_start' });
  if (s.retry_first) {
    // 先出错一次，pi 自动重试后成功
    emit({ type: 'message_end', message: assistant('', { stopReason: 'error', errorMessage: 'synthetic overloaded', content: [] }) });
    emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: 'synthetic overloaded' });
    emit({ type: 'auto_retry_end', success: true, attempt: 2 });
  }
  await replay(s.steps);
  if (s.rate_limited) {
    emit({ type: 'message_end', message: assistant('', { stopReason: 'error', errorMessage: '429 synthetic: request reached max organization concurrency: 1', content: [], usage: {} }) });
  } else if (s.stop_reason) {
    emit({ type: 'message_end', message: assistant(s.last_message ?? '', { stopReason: s.stop_reason, errorMessage: s.error_message }) });
  } else if (!s.hold && !s.no_reply) {
    const last = s.last_message ?? (input.includes('"verdict"') ? review : discussion);
    emit({ type: 'message_end', message: assistant(typeof last === 'string' ? last : JSON.stringify(last)) });
  }
  emit({ type: 'agent_settled', aborted: false });
  await finish(s);
} else throw new Error(`假 pi 不支持 ${operation}`);
