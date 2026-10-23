import path from 'node:path';

const text = (v) => typeof v === 'string' ? v : (v || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const first = (v) => String(v ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
const strings = (v) => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
const flag = (cmd, key) => new RegExp(`--${key}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s;]+))`).exec(cmd)?.slice(1).find((v) => v !== undefined);
const slash = (v) => String(v).replace(/\\/g, '/');

export function promptOf(row) {
  if (row.isSidechain || row.type !== 'user') return null;
  const value = text(row.message?.content).trim();
  return value && !/^<(?:system-reminder>|command-|local-command|task-notification>)/.test(value) ? first(value) : null;
}

export function toolsOf(row) {
  const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
  return { uses: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, tool: b.name,
    header: b.name === 'AskUserQuestion' ? b.input?.questions?.[0]?.header?.slice(0, 24) ?? null : null })),
  results: blocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) };
}

export function plainCommand(cmd) {
  const args = [], s = String(cmd ?? '');
  let cur = null, valid = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) { if (cur !== null) args.push(cur); cur = null; continue; }
    cur ??= '';
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) { valid = false; break; }
      cur += s.slice(i + 1, j); i = j;
    } else if (ch === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && '"\\$`'.includes(s[i + 1])) i++;
        cur += s[i];
      }
      if (i >= s.length) { valid = false; break; }
    } else if (ch === '\\' && i + 1 < s.length) cur += s[++i];
    else cur += ch;
  }
  if (cur !== null) args.push(cur);
  if (valid && args.length >= 3 && /(?:^|[\\/])(?:powershell|pwsh|bash|sh|zsh|cmd)(?:\.exe)?$/i.test(args[0]) && /^(?:-Command|-l?c|\/c)$/i.test(args.at(-2))) return args.at(-1);
  const m = /^"?[^"]*?(?:powershell|pwsh|bash|cmd)(?:\.exe)?"?\s+(?:-Command|-l?c|\/c)\s+([\s\S]*)$/i.exec(s);
  let inner = m ? m[1] : s;
  if (/^(["'])[\s\S]*\1$/.test(inner)) inner = inner.slice(1, -1);
  return inner.replace(/\\(["\\])/g, '$1');
}

export function parseTranscriptLines(lines, ctx) {
  const parser = createTranscriptParser(ctx);
  for (const line of lines) parser.write(line);
  return parser.finish();
}

export function createTranscriptParser(ctx) {
  // 只保留事件和关联状态；后续块可撤掉同一消息的旧用量，不必保留原始正文。
  let events = [], cwdChanged = false;
  const last = new Map(), removed = new Set(), paths = new Map(), tasks = {}, tools = new Map(), linked = new Set();
  const runs = [...(ctx.runsInScope || [])].sort((a, b) => Date.parse(a.meta.started_at) - Date.parse(b.meta.started_at));
  const byId = new Map(runs.map((r) => [r.id, r])), runIds = new Set(ctx.runIds || byId.keys());
  const lane = (id) => { const seen = new Set(); let r = byId.get(id); while (r?.meta.parent && byId.has(r.meta.parent) && !seen.has(r.id) && r.meta.participant !== 'host') { seen.add(r.id); r = byId.get(r.meta.parent); } return r ? r.meta.participant === 'host' ? 'cc' : r.lane || r.id : null; };
  const targets = (ids) => [...new Set(ids.filter((id) => runIds.has(id)).map(lane).filter(Boolean))];
  const meta = { title: null, model: null, session: null, cwd: ctx.cwd, started_at: null, latest_at: null, usage: { input: null, cached: null, cache_write: null, output: null } };
  const filePath = (file) => {
    const p = /^[A-Za-z]:[\\/]/.test(meta.cwd || file) ? path.win32 : path.posix;
    const absolute = meta.cwd ? p.resolve(meta.cwd, file) : file;
    const relative = meta.cwd && p.relative(meta.cwd, absolute), inside = relative != null && relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative);
    return slash(inside ? relative || '.' : absolute).slice(-120);
  };
  const label = (v) => String(v).replace(/\r/g, '').replace(/\n/g, ' ⏎ ').slice(0, 160);
  return { write(line) {
    let row;
    try { row = typeof line === 'string' ? JSON.parse(line) : line; } catch { return; }
    if (row.isSidechain) return;
    if (row.type === 'custom-title') { meta.title = row.customTitle; return; }
    if (!['assistant', 'user'].includes(row.type) || !Number.isFinite(Date.parse(row.timestamp))) return;
    meta.started_at ??= Date.parse(row.timestamp); meta.latest_at = Date.parse(row.timestamp);
    cwdChanged ||= row.cwd != null && row.cwd !== meta.cwd;
    meta.cwd = row.cwd ?? meta.cwd; meta.session = row.sessionId ?? meta.session;
    if (row.type === 'assistant') {
      meta.model = row.message.model ?? meta.model;
      if (row.message.id) { const old = last.get(row.message.id); if (old) removed.add(old); last.delete(row.message.id); }
    }
    const emit = (k, fields = {}) => { const ev = { run: 'cc', lane: 'cc', ts: Date.parse(row.timestamp), k, ...fields }; if (!ev.target?.length) delete ev.target; if (ev.t != null) ev.t = label(ev.t); events.push(ev); return ev; };
    const emitPath = (k, file, fields = {}, prefix = '') => { const ev = emit(k, { t: `${prefix}${filePath(file)}`, ...fields }); paths.set(ev, { file, prefix }); return ev; };
    const content = row.message.content, blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
    if (row.type === 'user') {
      const value = text(content).trim(), task = /<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>/.exec(value)?.[1];
      if (task && Object.hasOwn(tasks, task)) emit('returned', { t: /<status>([^<]*)<\/status>/.exec(value)?.[1] || '', target: tasks[task] });
      else if (value && !/^<(?:system-reminder>|command-|local-command|task-notification>)/.test(value)) emit('prompt', { t: first(value) });
      for (const block of blocks.filter((b) => b.type === 'tool_result')) {
        const tool = tools.get(block.tool_use_id), taskId = /running in background with ID: (\w+)/.exec(text(block.content))?.[1];
        if (tool?.k === 'dispatch' && taskId) tasks[taskId] = tool.target || [];
        if (tool?.k === 'cmd') emit('cmd_done', { ok: !block.is_error });
        // 弹窗被回答（或被取消）：看板上"等你确认"的光环收掉
        if (tool?.k === 'ask') emit('ask_done', { t: tool.t });
      }
      return;
    }
    for (const b of blocks) {
      if (b.type === 'thinking' && first(b.thinking)) emit('think', { t: first(b.thinking) });
      else if (b.type === 'text' && first(b.text)) emit('msg', { t: first(b.text) });
      else if (b.type === 'tool_use') {
        const input = b.input || {}, command = input.command || '', values = strings(input).join('\n'), file = input.file_path ?? input.notebook_path ?? '';
        const sub = ['Bash', 'PowerShell'].includes(b.name) && /cli\.mjs["']?\s+(run|discuss|review|resume|image|plan|submit)\b/.exec(command)?.[1];
        let ev;
        if (sub) {
          const plan = flag(command, 'plan'), seat = flag(command, 'seat'), id = flag(command, 'run'), agent = flag(command, 'agent');
          let match;
          if (!['plan', 'submit'].includes(sub)) {
            if (plan && seat) match = runs.find((r) => r.meta.plan === plan && r.meta.seat === seat && Date.parse(r.meta.started_at) >= Date.parse(row.timestamp) && Date.parse(r.meta.started_at) <= Date.parse(row.timestamp) + 120000);
            else if (sub === 'resume') match = byId.get(id);
            else {
              const candidates = runs.filter((r) => !linked.has(r.id) && r.meta.mode === sub && Date.parse(r.meta.started_at) >= Date.parse(row.timestamp) && Date.parse(r.meta.started_at) <= Date.parse(row.timestamp) + 30000);
              match = candidates.find((r) => agent && r.meta.agent === agent) || candidates[0];
            }
          }
          if (match) linked.add(match.id);
          ev = emit('dispatch', { t: `${sub} ${flag(command, 'title') || (plan && seat ? `${plan}/${seat}` : id || plan || '')}`.trim(), target: targets(match ? [match.id] : []) });
        } else {
          const ids = values.match(/\d{8}-\d{6}-[a-z0-9]{4}/g) || [], taskIds = Object.keys(tasks).filter((id) => values.includes(id));
          const collect = /cli\.mjs["']?\s+(status|watch|stats|judge)\b/.exec(values), group = flag(values, 'group'), plan = flag(values, 'plan');
          const lanes = [...targets(ids), ...taskIds.flatMap((id) => tasks[id])];
          if (collect && collect[1] !== 'stats' && (group || plan)) lanes.push(...targets(runs.filter((r) => group ? r.meta.group === group : r.meta.plan === plan).map((r) => r.id)));
          const inRuns = b.name === 'Read' && runs.some((r) => r.dir && slash(file).toLowerCase().startsWith(`${slash(path.dirname(r.dir)).toLowerCase()}/`));
          if (lanes.length || taskIds.length || ids.some((id) => runIds.has(id)) || collect || inRuns) ev = !collect && file ? emitPath('collect', file, { target: [...new Set(lanes)] }) : emit('collect', { t: collect ? collect[1] : 'results', target: [...new Set(lanes)] });
          else if (['Read', 'NotebookRead'].includes(b.name)) ev = emitPath('read', file);
          else if (['Grep', 'Glob'].includes(b.name)) ev = emit('search', { t: input.pattern });
          else if (['WebSearch', 'WebFetch'].includes(b.name)) ev = emit('web', { t: input.query ?? input.url?.replace(/^\w+:\/\//, '') });
          else if (['Edit', 'MultiEdit', 'NotebookEdit', 'Write'].includes(b.name)) ev = emitPath('edit', file, {}, `${b.name === 'Write' ? 'write' : 'update'} `);
          else if (['Bash', 'PowerShell'].includes(b.name)) ev = emit('cmd', { t: plainCommand(command) });
          // 向用户弹窗确认（角色分配、图像路线、计划审批）：t 是弹窗标题，没有就写工具名
          else if (['AskUserQuestion', 'ExitPlanMode'].includes(b.name)) ev = emit('ask', { t: input.questions?.[0]?.header || (b.name === 'ExitPlanMode' ? '计划审批' : b.name) });
          else ev = emit('tool', { t: b.name.replace(/^mcp__.*?__/, '') });
        }
        tools.set(b.id, ev);
      }
    }
    if (row.message.id && row.message.usage) {
      const u = row.message.usage, usage = { in: u.input_tokens ?? null, cached: u.cache_read_input_tokens ?? null, cache_write: u.cache_creation_input_tokens ?? null, out: u.output_tokens ?? null };
      // 消息标识只供实时推送去重，不进入协议数据。
      const ev = Object.defineProperty(emit('usage', { n: usage.out, t: row.message.model, u: usage }), 'messageId', { value: row.message.id });
      last.set(row.message.id, ev);
    }
  }, finish() {
    if (removed.size) { events = events.filter((ev) => !removed.has(ev)); removed.clear(); }
    // 旧解析器用全窗最后的 cwd 显示路径；改目录时只重算路径标签，并保留之前快照。
    if (cwdChanged) events = events.map((ev) => {
      const p = paths.get(ev); if (!p) return ev;
      const next = { ...ev, t: label(`${p.prefix}${filePath(p.file)}`) }; paths.delete(ev); paths.set(next, p); return next;
    });
    cwdChanged = false; meta.usage = { input: null, cached: null, cache_write: null, output: null };
    for (const ev of events) if (ev.k === 'usage') for (const [key, value] of Object.entries(ev.u)) if (value != null) {
      const name = key === 'in' ? 'input' : key === 'out' ? 'output' : key; meta.usage[name] = (meta.usage[name] ?? 0) + value;
    }
    return { meta, events, tasks };
  } };
}
