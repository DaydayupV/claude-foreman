import path from 'node:path';
import { baseConfig, seedRun, normalize } from '../helpers.mjs';
import { report, discussion, usage, command } from './reports.mjs';

export function watchRecords(h) {
  h.runs = path.join(h.home, 'r');
  const c = baseConfig();
  c.dispatch.runs_dir = h.runs;
  h.config(c);
  const start = Date.now() - 60000;
  const at = (seconds) => new Date(start + seconds * 1000).toISOString();
  const event = (e, seconds = 1) => ({ ...e, ts: at(seconds) });
  const specs = [
    { id: 'a', name: 'codex', type: 'codex cli', kind: 'exec', model: 'fake-codex', report,
      events: [event({ type: 'thread.started', thread_id: 'synthetic' }), event(command()),
        event({ type: 'item.completed', item: { type: 'file_change', changes: [{ kind: 'update', path: path.join(h.cwd, 'source.txt') }] } }),
        event({ type: 'item.completed', item: { type: 'agent_message', text: '完成合成修改' } })] },
    { id: 'b', name: 'api', type: 'api', kind: 'discuss', model: 'fake-api', report: discussion,
      events: [event({ type: 'api.request', attempt: 1, model: 'fake-api', effort: 'high' }, 0),
        event({ type: 'api.queued', waited_s: 0 }, 0), event({ type: 'api.reasoning', text: '合成推理', total_chars: 4 }),
        event({ type: 'api.content', text: JSON.stringify(discussion), total_chars: 100 }, 2)] },
    // opencode 的读文件、搜索工具事件和适配器翻译出来的一样，带 tool 和 category
    { id: 'c', name: 'oc', type: 'opencode cli', kind: 'discuss', model: 'fake/model', report: discussion,
      events: [event({ type: 'thread.started', thread_id: 'synthetic-opencode' }),
        event({ type: 'item.completed', item: { id: 'opencode-1', tool: 'read', category: 'read', type: 'command_execution', command: 'read source.txt', exit_code: 0 } }),
        event({ type: 'item.completed', item: { id: 'opencode-2', tool: 'grep', category: 'search', type: 'command_execution', command: 'grep TODO src', exit_code: 0 } })] },
    { id: 'd', name: 'codex', type: 'codex cli', kind: 'exec', model: 'fake-codex', report: null,
      events: [event({ type: 'error', message: '合成失败原因' })], status: 'failed' },
  ];
  for (const spec of specs) {
    const status = spec.status || 'done';
    const result = { run_id: spec.id, status, duration_s: 3, usage, usage_scope: 'this_run', report: spec.report,
      changes: { available: true, files_total: 1, agent_total: 1, unknown_total: 0 }, errors: spec.status ? ['合成失败原因'] : [] };
    if (spec.kind === 'discuss') result.changes = { available: false, agent_total: 0 };
    // 另有两个文件没有证据：一个归属未知，一个落在同组另一个任务的写入范围里（只标在 files 上，旧记录没有 group_total）
    if (spec.id === 'a') Object.assign(result.changes, { files_total: 3, unknown_total: 2, files: [{ status: 'M', path: 'source.txt', by: 'agent' },
      { status: 'A', path: 'other.txt', by: 'unknown' }, { status: 'A', path: 'out/b.txt', by: 'unknown', group_run: 'b' }] });
    // 失败的执行任务没有改动：执行任务即使改动为 0 也要显示改动数
    if (spec.status === 'failed') result.changes = { available: true, files_total: 0, agent_total: 0, unknown_total: 0 };
    seedRun(h, spec.id, { agent: spec.name, agent_type: spec.type, model: spec.model, kind: spec.kind,
      mode: spec.kind === 'exec' ? 'run' : 'discuss', title: `合成${spec.id}`, status, group: 'watch-group',
      started_at: at(0), ended_at: at(3) }, result, spec.events);
  }
  return specs;
}

export function watchText(h, text) {
  return normalize(text, { [h.cwd]: '<CWD>', [h.home]: '<HOME>' }).replace(/^\d{2}:\d{2}(?= )/gm, '<TIME>');
}
