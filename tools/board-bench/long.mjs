// 合成一个长对话给网页看板量飞入：node long.mjs <root> [hours=10] [groups=35] [seats=3]
// 规模对齐真实的长对话：Claude Code 对话记录每 2 秒一条，几十组任务在这段时间里交错开始、互相重叠，
// 每席每 2–6 秒一条动作、隔一条一次用量，最后一组还在跑；另有 3 个短对话，宇宙里不止一个星系。
// 内容用固定种子生成，同样的参数每次结构相同（时刻按当前时间往前排，直播看板只显示最近的对话）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [root, hours = 10, groups = 35, seats = 3] = process.argv.slice(2).map((v, i) => i ? Number(v) : v);
// 开头会清空目标目录：只允许系统临时目录里的路径
const inside = root && path.relative(os.tmpdir(), path.resolve(root));
if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
  console.error(`root must be a folder inside ${os.tmpdir()}`); process.exit(2);
}
fs.rmSync(root, { recursive: true, force: true });
let seed = 1;
const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const now = Date.now(), T0 = now - hours * 3600000, iso = (t) => new Date(t).toISOString(), pad = (n, w = 2) => String(n).padStart(w, '0');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const agent = 'gpt-6.1-sol-codex-cli';
write(path.join(root, 'config.json'), JSON.stringify({ agents: { [agent]: { type: 'codex cli', max_parallel: 4 } } }));

// Claude Code 对话记录：每 2 秒一条（文字、思考、命令轮流），15 分钟一条用户消息
function transcript(session, cwd, from, to, title) {
  const rows = [{ type: 'custom-title', timestamp: iso(from), customTitle: title }];
  const usage = { input_tokens: 1200, cache_read_input_tokens: 90000, cache_creation_input_tokens: 400, output_tokens: 160 };
  for (let t = from, n = 0; t < to; t += 2000, n++) {
    if ((t - from) % 900000 < 2000) rows.push({ type: 'user', timestamp: iso(t), cwd, sessionId: session, isSidechain: false, origin: { kind: 'human' }, turnOrigin: 'human', message: { content: `round ${n} prompt` } });
    const kind = n % 3, id = `${session}-${n}`;
    const content = kind === 0 ? [{ type: 'text', text: `step ${n}: checking the next part of the change and what is left` }]
      : kind === 1 ? [{ type: 'thinking', thinking: `thinking about step ${n}` }]
        : [{ type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command: `git diff --stat -- src/file-${n % 40}.mjs` } }];
    rows.push({ type: 'assistant', timestamp: iso(t + 500), cwd, sessionId: session, isSidechain: false, message: { content, id, model: 'claude-opus-5-5', stop_reason: kind === 0 ? 'end_turn' : null, usage } });
    if (kind === 2) rows.push({ type: 'user', timestamp: iso(t + 900), cwd, sessionId: session, isSidechain: false, message: { content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: 'ok' }] } });
  }
  write(path.join(root, 'claude', cwd.replace(/[:/]/g, '-'), `${session}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}

// 一席任务：meta、events（每 2–6 秒一条动作，隔一条一次用量），结束了的再写 result
let seq = 0;
function run(session, cwd, group, seat, start, end) {
  const id = `${new Date(start).toISOString().slice(0, 10).replace(/-/g, '')}-${pad(seq % 24)}${pad(seq % 60)}${pad(seat)}-l${String(seq++).padStart(3, '0')}`;
  const meta = { id, mode: 'run', kind: 'exec', module: 'run', agent, agent_type: 'codex cli', model: 'gpt-6.1-sol', model_shown: 'gpt-6.1-sol', effort: 'max', cwd,
    claude_session: session, title: `${group} part ${seat}`, status: end ? 'done' : 'running', pid: null, parent: null, group, plan: null, seat: null, round: 1,
    scope: [`src/${group}-${seat}`], started_at: iso(start), ...(end ? { ended_at: iso(end) } : {}) };
  write(path.join(root, 'runs', id, 'meta.json'), JSON.stringify(meta, null, 2));
  const events = [{ type: 'api.request', ts: iso(start), model: 'gpt-6.1-sol', attempt: 1 }];
  let inTok = 0, outTok = 0, i = 0;
  for (let t = start + 1000; t < (end ?? now - 2000); t += 2000 + Math.floor(rand() * 4000), i++) {
    const item = i % 4 === 0 ? { id: `m${i}`, type: 'agent_message', text: `progress note ${i}` }
      : i % 4 === 1 ? { id: `r${i}`, type: 'reasoning', text: `**Thinking** about item ${i}` }
        : { id: `c${i}`, type: 'command_execution', command: `node --test tests/part-${i % 9}.test.mjs`, exit_code: i % 37 === 0 ? 1 : 0 };
    events.push({ type: 'item.completed', ts: iso(t), item });
    if (i % 2 === 0) {
      const step = { input_tokens: 20000, cached_input_tokens: 18000, output_tokens: 60 + (i % 7) * 20 };
      inTok += step.input_tokens; outTok += step.output_tokens;
      events.push({ type: 'step.usage', ts: iso(t + 500), usage: step });
    }
  }
  const usage = { input_tokens: inTok, cached_input_tokens: Math.round(inTok * 0.9), output_tokens: outTok };
  if (end) events.push({ type: 'turn.completed', ts: iso(end), usage });
  write(path.join(root, 'runs', id, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (end) write(path.join(root, 'runs', id, 'result.json'), JSON.stringify({ status: 'done', duration_s: Math.round((end - start) / 1000), usage, usage_scope: 'this_run',
    cost_usd: 1.23, cost_source: 'api_price', report: { status: 'completed', summary: `${group} part ${seat} done` }, changes: { files: [{ path: `src/${group}-${seat}/a.mjs`, by: 'agent' }] } }, null, 2));
  return events.length;
}

// 长对话：各组在整段时间里交错开始，每组 6–20 分钟，后一组常在前一组结束前开始；最后一组还在跑
const long = 'long', cwd = 'C:/demo-lab/long';
const rows = transcript(long, cwd, T0, now - 5000, 'long conversation for fly-in timing');
let events = 0;
for (let g = 0; g < groups; g++) {
  const start = T0 + 60000 + (g / groups) * (hours * 3600000 - 30 * 60000) + Math.floor(rand() * 300000), last = g === groups - 1;
  for (let s = 1; s <= seats; s++) {
    const begin = start + Math.floor(rand() * 60000), end = last ? null : begin + 360000 + Math.floor(rand() * 840000);
    events += run(long, cwd, `long-${pad(g)}`, s, begin, end);
  }
}
// 3 个短对话：半小时，每个一组两席
for (let k = 0; k < 3; k++) {
  const session = `short-${k}`, scwd = `C:/demo-lab/short-${k}`, from = now - (2 + k) * 3600000;
  transcript(session, scwd, from, from + 1800000, `short conversation ${k}`);
  for (let s = 1; s <= 2; s++) run(session, scwd, `short-${k}`, s, from + 300000, from + 900000 + s * 60000);
}
console.log(`long conversation: ${rows} transcript rows, ${groups * seats} runs, ${events} run events; ${seq} runs in all`);
