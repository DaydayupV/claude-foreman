// 合成规模数据：node gen.mjs <root> <runs> <sessions> <days> <oldTranscripts> [transcriptMiB]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [root, nRuns = 5000, nSessions = 40, days = 30, nOld = 1000, transcriptMiB = 0] = process.argv.slice(2).map((v, i) => i ? Number(v) : v);
// 开头会清空目标目录：只允许系统临时目录里的路径，免得传错参数删掉真实记录
const inside = root && path.relative(os.tmpdir(), path.resolve(root));
if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
  console.error(`root must be a folder inside ${os.tmpdir()}`); process.exit(2);
}
fs.rmSync(root, { recursive: true, force: true });
const now = Date.now(), pad = (n, w = 2) => String(n).padStart(w, '0');
const idOf = (t, i) => { const d = new Date(t); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${i.toString(36).padStart(4, '0').slice(-4)}`; };
const filler = 'x'.repeat(300);
const sessions = Array.from({ length: nSessions }, (_, i) => ({ id: `sess-${pad(i, 3)}`, cwd: `D:/work/proj-${i % 12}`, rows: [] }));
fs.mkdirSync(path.join(root, 'runs', 'plans'), { recursive: true });
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ agents: { a: { type: 'codex cli', max_parallel: 4 }, b: { type: 'api', max_parallel: 4 } } }));
for (let i = 0; i < nRuns; i++) {
  // 前 10% 落在最近 24 小时，挂在窗口内的对话上；其余均匀铺在 days 天里
  const recent = i < nRuns * 0.1, start = recent ? now - Math.random() * 20 * 3600000 : now - 86400000 - Math.random() * days * 86400000;
  const id = idOf(start, i), dir = path.join(root, 'runs', id), session = recent ? sessions[i % nSessions] : { id: `old-${i % 300}` };
  const end = start + 60000 + Math.random() * 600000, status = i % 25 === 0 ? 'failed' : 'done';
  fs.mkdirSync(dir);
  const meta = { id, mode: 'discuss', kind: 'discuss', module: 'discuss', agent: i % 2 ? 'a' : 'b', agent_type: i % 2 ? 'codex cli' : 'api', model: 'gpt-6.1-sol', model_shown: 'gpt-6.1-sol',
    cwd: session.cwd || 'D:/old', claude_session: session.id, title: `run ${i}`, status, pid: null, group: `g-${Math.floor(i / 7)}`, plan: null, seat: String(i % 7 + 1), round: 1,
    started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString() };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const events = [];
  for (let k = 0; k < 60; k++) events.push(JSON.stringify(k % 3 ? { type: 'item.completed', ts: new Date(start + k * 1000).toISOString(), item: { id: `r${k}`, type: 'reasoning', text: `thinking ${k} ${filler}` } }
    : { type: 'item.started', ts: new Date(start + k * 1000).toISOString(), item: { id: `c${k}`, type: 'command_execution', command: `rg foo src/${k}.mjs`, category: 'search' } }));
  events.push(JSON.stringify({ type: 'turn.completed', ts: new Date(end).toISOString(), usage: { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 3000 } }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ run_id: id, status, duration_s: (end - start) / 1000, usage: { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 3000 },
    model: 'gpt-6.1-sol', last_message: filler.repeat(10), report: { position: `pos ${i}`, options: Array.from({ length: 5 }, () => ({ summary: filler })) } }));
  if (recent) session.rows.push({ at: start, id });
}
// 对话记录：每个窗口内对话约 3000 行（约 2–3 MB），其中按派发插入 Bash tool_use
const folder = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
for (const s of sessions) {
  const dir = path.join(root, 'claude', folder(s.cwd)); fs.mkdirSync(dir, { recursive: true });
  const lines = [], t0 = now - 22 * 3600000;
  let bytes = 0;
  for (let k = 0; transcriptMiB ? bytes < transcriptMiB * 1048576 : k < 3000; k++) {
    const ts = new Date(t0 + k * 25000).toISOString();
    lines.push(JSON.stringify(k % 2 ? { type: 'assistant', timestamp: ts, cwd: s.cwd, sessionId: s.id, message: { id: `${s.id}-m${k}`, model: 'claude-opus-5-5', stop_reason: k % 10 === 1 ? 'end_turn' : null,
      content: [{ type: 'text', text: `answer ${k} ${filler}` }], usage: { input_tokens: 10, cache_read_input_tokens: 90000, cache_creation_input_tokens: 500, output_tokens: 400 } } }
      : { type: 'user', timestamp: ts, cwd: s.cwd, sessionId: s.id, message: { content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: filler.repeat(3) }] } }));
    bytes += Buffer.byteLength(lines.at(-1)) + 1;
  }
  fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), lines.join('\n') + '\n');
}
// 窗口外的旧对话记录：只在列目录时被 stat
for (let i = 0; i < nOld; i++) {
  const dir = path.join(root, 'claude', `old-proj-${i % 20}`); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `old-${i}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(now - 10 * 86400000).toISOString(), cwd: `D:/old/${i % 20}`, message: { content: 'hi' } }) + '\n');
  const old = new Date(now - 10 * 86400000); fs.utimesSync(file, old, old);
}
console.log(`wrote ${nRuns} runs, ${nSessions} sessions, ${nOld} old transcripts under ${root}`);
