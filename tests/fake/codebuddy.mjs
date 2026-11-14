import { setup, replay, finish } from './common.mjs';
import { discussion, review } from '../fixtures/reports.mjs';

// 假 CodeBuddy CLI：照 --output-format stream-json 的真实事件形状回放，
// 依次是 system(init)、若干 assistant（每条带 message.usage）、最后一条 result。
const args = process.argv.slice(2);
const operation = args.includes('--version') ? 'version' : args.includes('--help') ? 'help' : 'run';
const { scenario: s, input } = await setup('codebuddy', operation, args);
const emit = (event) => console.log(JSON.stringify({ session_id: s.session_id || 'synthetic-codebuddy-session', ...event }));
const turnUsage = () => ({ input_tokens: s.usage?.input ?? 10, output_tokens: s.usage?.output ?? 5,
  cache_read_input_tokens: s.usage?.cacheRead ?? 3, cache_creation_input_tokens: s.usage?.cacheWrite ?? 0 });
let assistantCount = 0;
const assistant = (content) => {
  assistantCount++;
  emit({ type: 'assistant', message: { role: 'assistant', id: s.assistant_id || `assistant-${assistantCount}`, content, usage: turnUsage() } });
};
const totalUsage = () => s.result_usage === null ? null : s.result_usage || {
  input_tokens: (turnUsage().input_tokens || 0) * assistantCount,
  output_tokens: (turnUsage().output_tokens || 0) * assistantCount,
  cache_read_input_tokens: (turnUsage().cache_read_input_tokens || 0) * assistantCount,
  cache_creation_input_tokens: (turnUsage().cache_creation_input_tokens || 0) * assistantCount,
};

if (operation === 'version') console.log(s.version || '2.180.0');
else if (operation === 'help') {
  const models = s.models || ['fake-1', 'fake-2'];
  console.log(`Usage: codebuddy|cbc [options] [command] [prompt]\n  --model <model>  Model for the current session. Please provide the model ID. Currently supported: (${models.join(', ')})`);
} else if (operation === 'run') {
  if (s.rate_limited) {
    assistant([{ type: 'text', text: '429 synthetic: request reached max organization concurrency: 1' }]);
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '429 synthetic: request reached max organization concurrency: 1',
      usage: turnUsage(), errors: ['429 synthetic: request reached max organization concurrency: 1'], permission_denials: [] });
    process.exitCode = s.exit_code ?? 0;
  } else {
    emit({ type: 'system', subtype: 'init', tools: ['Read', 'Glob', 'Grep'] });
    await replay(s.steps);
    for (const [name, content] of Object.entries(s.files || {})) await replay([{ files: { [name]: content } }]);
    for (const [i, call] of (s.tool_calls || []).entries()) {
      assistant([call]);
      const denied = (s.denied || []).some((item) => item.id === call.id);
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id ?? `call-${i}`, content: s.tool_results?.[i]?.content ?? 'synthetic output',
        ...(s.tool_results?.[i]?.is_error || denied ? { is_error: true } : {}) }] } });
    }
    for (const event of s.usage_updates || []) emit(event);
    // no_reply 模拟没有回复就退出（比如没有 API key 时 codebuddy 只往 stderr 写一行）。
    if (!s.no_reply) {
      // 只有带 --json-schema 才有结构化输出（check 的最小请求不带）；剧本可以显式给 structured 或 no_structured。
      const wanted = args.includes('--json-schema');
      const structured = s.no_structured || !wanted ? null : s.structured ?? (input.includes('"verdict"') ? review : discussion);
      // 结构化输出时正文照常有一条 assistant（模型会先把 JSON 写出来再交给工具），用量要算进这一轮。
      const text = s.last_message ?? (structured ? JSON.stringify(structured) : 'OK');
      assistant([{ type: 'text', text }]);
      emit({ type: 'result', subtype: 'success', is_error: false, result: text, ...(totalUsage() ? { usage: totalUsage() } : {}),
        ...(structured ? { structured_output: structured } : {}),
        permission_denials: (s.denied || []).map((denial, index) => ({ tool_name: denial.tool, tool_use_id: denial.id || `denied-${index}`,
          tool_input: denial.input || {} })) });
    }
    if (s.api_error) {
      const text = 'synthetic CodeBuddy API error';
      assistant([{ type: 'text', text }]);
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text,
        usage: totalUsage(), errors: [text], permission_denials: [] });
    }
    await finish(s);
  }
} else throw new Error(`假 codebuddy 不支持 ${operation}`);
