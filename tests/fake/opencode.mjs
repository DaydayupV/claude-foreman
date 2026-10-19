import { setup, replay, finish } from './common.mjs';
import { discussion, review } from '../fixtures/reports.mjs';

const args = process.argv.slice(2);
const operation = args[0] === '--version' ? 'version' : args[0] === 'session' ? 'export' : args[0] === 'api' ? 'catalog' : args[0];
const { scenario: s, input } = await setup('opencode', operation, args);
if (operation === 'version') console.log(s.version || 'synthetic-opencode-1.0');
else if (operation === 'models') {
  if (s.models_delay_ms) await replay([{ delay_ms: s.models_delay_ms }]);
  console.log((s.models || ['fake/model']).join('\n'));
}
else if (operation === 'catalog') {
  // opencode api GET /api/model：剧本没给 opencode_catalog 时当作读不到清单
  if (s.opencode_catalog) console.log(JSON.stringify({ data: s.opencode_catalog }));
  else { process.stderr.write('synthetic: no model catalog\n'); process.exitCode = 1; }
}
else if (operation === 'export') {
  if (s.export_error) { process.stderr.write(s.export_error); process.exitCode = 1; }
  else console.log(JSON.stringify({ messages: (s.export_messages || []).map((m) => ({
    ...m, time: { created: m.created === 'old' ? 1 : Date.now() },
  })) }));
} else if (operation === 'run') {
  const model = args[args.indexOf('-m') + 1];
  if (s.rate_limited) {
    console.log(JSON.stringify({ type: 'error', error: { type: 'provider.rate-limit', message: 'synthetic: request reached max organization concurrency: 1', status: 429 } }));
    process.exit(1);
  }
  const rejected = s.reject_variants?.find((variant) => model.endsWith(`#${variant}`));
  if (rejected) {
    console.log(JSON.stringify({ type: 'error', error: { type: 'provider.no-route', message: `Variant unavailable for ${model.slice(0, -(rejected.length + 1))}: ${rejected}` } }));
    process.exit(1);
  }
  if (!['--standalone', '--format', '--agent', '-m'].every((flag) => args.includes(flag))) throw new Error('假 opencode 缺少运行参数');
  if (s.expected_agent && args[args.indexOf('--agent') + 1] !== s.expected_agent) throw new Error('假 opencode 收到错误的代理');
  const sessionID = args.includes('--session') ? args[args.indexOf('--session') + 1] : s.session_id || 'synthetic-opencode-session';
  console.log(JSON.stringify({ type: 'step_start', sessionID }));
  await replay(s.steps);
  for (const [name, content] of Object.entries(s.files || {})) {
    await replay([{ files: { [name]: content } }]);
  }
  if (!s.hold) {
    const last = s.last_message ?? (input.includes('"verdict"') ? review : discussion);
    console.log(JSON.stringify({ type: 'text', sessionID, part: { text: typeof last === 'string' ? last : JSON.stringify(last) } }));
    if (s.step_finish) console.log(JSON.stringify({ type: 'step_finish', sessionID, part: s.step_finish }));
  }
  await finish(s);
} else throw new Error(`假 opencode 不支持 ${operation}`);
