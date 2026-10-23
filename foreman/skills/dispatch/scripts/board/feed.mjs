import fs from 'node:fs';
import path from 'node:path';
import { parseTranscriptLines, plainCommand } from './claude-feed.mjs';
import { priceFor } from './prices.mjs';

export const ms = (v) => v == null ? null : typeof v === 'number' ? v : Date.parse(v);
const oneLine = (v) => String(v ?? '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean).join(' ⏎ ');
const clip = (v, n = 160) => v == null ? null : oneLine(v).slice(0, n);
const first = (v) => String(v ?? '').trim().split(/\r?\n/).find((s) => s.trim()) || '';
export const transient = (e) => ['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code);
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function stat(file) { try { return fs.statSync(file); } catch (e) { if (!transient(e)) throw e; return null; } }
export function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (!transient(e) && !(e instanceof SyntaxError)) throw e; return null; } }

const usageOf = (u) => ({ input: u.input_tokens == null ? null : u.input_tokens - (u.cached_input_tokens ?? 0), cached: u.cached_input_tokens ?? null, cache_write: null, output: u.output_tokens ?? null });
export const usageTotals = (events) => events.reduce((sum, e) => {
  for (const [key, value] of Object.entries(e.u)) if (value != null) { const name = key === 'in' ? 'input' : key === 'out' ? 'output' : key; sum[name] = (sum[name] ?? 0) + value; }
  return sum;
}, { input: null, cached: null, cache_write: null, output: null });
export function hostCost(events, prices) {
  // 有未定价的消息时，不把部分花费当成会话总花费。
  const costs = events.map((e) => priceFor(e.t, { input: e.u.in, cached: e.u.cached, cache_write: e.u.cache_write, output: e.u.out }, prices));
  return costs.length && costs.every((v) => v != null) ? costs.reduce((a, b) => a + b, 0) : null;
}

function flush(state, at, final = false) {
  const out = [];
  if (state.pending && (final || at >= state.due)) {
    out.push({ ...state.pending, ts: state.due }); state.pending = null;
  }
  if (final) {
    for (const ev of state.tools?.values() || []) out.push(ev);
    state.tools?.clear();
  }
  return out;
}

export function normalize(raw, run, state) {
  const ts = ms(raw.ts), out = flush(state, ts), it = raw.item || {};
  const ev = (k, fields = {}) => ({ run: run.id, lane: run.lane ?? run.id, ts, k, ...fields,
    ...(fields.t != null ? { t: clip(fields.t) } : {}) });
  const emit = (k, fields) => out.push(ev(k, fields));
  state.commands ??= new Map(); state.tools ??= new Map();
  if (raw.type.startsWith('api.')) state.queued = raw.type === 'api.queued';
  else if (raw.type === 'pi.progress' || raw.type.startsWith('item.')) state.queued = false;
  if (['api.reasoning', 'api.content', 'pi.progress'].includes(raw.type)) {
    const k = raw.type === 'api.reasoning' || raw.type === 'pi.progress' && raw.phase === 'thinking' ? 'think' : 'answer';
    // 窗口结束再发最新计数，避免实时推送后无法收回被合并的事件。
    if (!state.pending) state.due = Math.max(ts, state.due ?? -Infinity) + 400;
    state.pending = ev(k, { n: raw.total_chars });
  } else if (raw.type === 'thread.started' || raw.type === 'turn.started') emit('turn');
  else if (it.type === 'command_execution' && ['item.started', 'item.completed'].includes(raw.type)) {
    const previous = state.commands.get(it.id), tool = { ...previous, ...it };
    const category = tool.category, text = clip(tool.label ?? tool.command) || '';
    const label = tool.label != null ? text : tool.tool && text === tool.tool ? '.' : tool.tool && text.startsWith(`${tool.tool} `) ? text.slice(tool.tool.length + 1) : text;
    if (raw.type === 'item.started') {
      state.commands.set(it.id, tool);
      if (category === 'read' || category === 'search') state.tools.set(it.id, ev(category, { t: label }));
      else emit('cmd', { t: plainCommand(tool.command) });
    } else {
      if (category === 'read' || category === 'search') { state.tools.delete(it.id); emit(category, { t: label }); }
      else { if (!previous) emit('cmd', { t: plainCommand(tool.command) }); emit('cmd_done', { ok: tool.exit_code === 0 || tool.exit_code == null }); }
      state.commands.delete(it.id);
    }
  } else if (raw.type === 'item.completed') {
    if (it.type === 'agent_message') {
      const text = String(it.text ?? '').trim();
      let report = false;
      try { const value = JSON.parse(text); report = value !== null && typeof value === 'object' && !Array.isArray(value); } catch { /* 普通消息 */ }
      if (report) emit('report', { n: String(it.text).length });
      else if (text) emit('msg', { t: first(text) });
    } else if (it.type === 'reasoning') emit('think', { t: first(it.text).replace(/\*\*/g, '') });
    else if (it.type === 'file_change') for (const change of it.changes || []) {
      const file = change.path || '', cwd = run.meta?.cwd;
      const p = /^[A-Za-z]:[\\/]/.test(cwd || file) ? path.win32 : path;
      emit('edit', { t: `${change.kind} ${cwd ? p.relative(cwd, p.resolve(cwd, file)) || file : file}` });
    } else if (it.type === 'web_search') emit('search', { t: it.query });
    else if (it.type === 'todo_list') emit('plan', { t: `${(it.items || []).filter((x) => x.completed).length}/${(it.items || []).length}` });
    else if (it.type === 'error') emit('error', { t: it.message });
  } else if (raw.type === 'api.request') emit('req', { t: raw.model, n: raw.attempt });
  else if (raw.type === 'api.queued') emit('queued');
  else if (raw.type === 'api.retry') emit('retry', { t: raw.reason });
  else if (raw.type === 'api.usage' || raw.type === 'turn.completed' && raw.usage) {
    const usage = raw.usage || {}, input = usage.input_tokens || 0, output = usage.output_tokens || 0;
    const u = usageOf(usage);
    emit('usage', { n: input + output, t: `${input}/${output}`, u: { in: u.input, cached: u.cached, cache_write: u.cache_write, out: u.output } });
  } else if (['api.error', 'turn.failed', 'error'].includes(raw.type)) emit('error', { t: raw.message ?? raw.error?.message ?? '' });
  else if (raw.type === 'image.generated' || raw.type === 'image.viewed') emit('image', { t: path.win32.basename(raw.path || '') });
  return out;
}

export function laneOf(run, byId) {
  const seen = new Set();
  if (run.meta?.participant === 'host') return 'cc';
  while (run.meta?.parent && byId.has(run.meta.parent) && !seen.has(run.id) && run.meta.participant !== 'host') {
    seen.add(run.id); run = byId.get(run.meta.parent);
  }
  return run.meta?.participant === 'host' ? 'cc' : run.id;
}

export function selectScope(runs, params, now) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  let kind = params.session != null ? 'session' : params.group != null ? 'group' : params.run != null ? 'run' : 'recent';
  const value = params.session ?? params.replay ?? params.group ?? params.run ?? null;
  // 回放可以按组、按任务，也可以按对话（replay 写 Claude Code 会话 id，取这个对话派出的所有任务）
  if (params.replay != null && params.session == null) kind = runs.some((r) => r.meta?.group === value) ? 'group' : runs.some((r) => r.meta?.claude_session === value) ? 'session' : runs.some((r) => r.id === value) ? 'run' : 'session';
  let seeds = runs.filter((r) => r.meta);
  if (kind === 'group') {
    seeds = seeds.filter((r) => r.meta.group === value);
    const newest = seeds.reduce((a, b) => !a || ms(b.meta.started_at) > ms(a.meta.started_at) ? b : a, null);
    seeds = seeds.filter((r) => (r.meta.claude_session ?? null) === (newest?.meta.claude_session ?? null));
  } else if (kind === 'session') seeds = seeds.filter((r) => r.meta.claude_session === value);
  else if (kind === 'run') seeds = seeds.filter((r) => r.id === value);
  else seeds = seeds.filter((r) => r.meta.status === 'running' && r.meta.participant !== 'host' || ms(r.meta.ended_at) >= now - 1800000);
  const lanes = new Map();
  for (const r of seeds) {
    const lane = laneOf(r, byId), activity = Math.max(ms(r.meta.ended_at) || ms(r.meta.started_at) || 0, r.activity || 0);
    lanes.set(lane, Math.max(lanes.get(lane) || 0, activity));
  }
  const roots = [...lanes].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => id !== 'cc').slice(0, kind === 'recent' ? 8 : Infinity);
  if (lanes.has('cc')) roots.push('cc');
  // 主持答案共用 cc，但不能把其他范围的答案一同带入。
  return { scope: { kind, value }, runs: runs.filter((r) => r.meta && (params.session == null || r.meta.claude_session === value) && roots.includes(laneOf(r, byId)) && (laneOf(r, byId) !== 'cc' || seeds.includes(r)))
    .sort((a, b) => roots.indexOf(laneOf(a, byId)) - roots.indexOf(laneOf(b, byId)) || ms(a.meta.started_at) - ms(b.meta.started_at)) };
}

// 出图任务产出的图片：结果里的 generated_images（绝对路径）加上改动清单里的图片文件（相对工作目录）。
// 看板只按序号取（/image?run=&n=），路径从不经页面传进来；只认这几种图片扩展名
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
export function imagesOf(meta, result) {
  const out = [];
  for (const p of result?.generated_images || []) if (typeof p === 'string' && IMAGE_EXT.test(p) && path.isAbsolute(p)) out.push(path.resolve(p));
  for (const f of result?.changes?.files || []) if (typeof f?.path === 'string' && IMAGE_EXT.test(f.path) && f.status !== 'D' && meta?.cwd) out.push(path.resolve(meta.cwd, f.path));
  return [...new Set(out)].slice(0, 12);
}

export function runMessage(run, lane, prices) {
  const m = run.meta, r = run.result, kind = m.module === 'image' ? 'image' : m.kind || (['discuss', 'review'].includes(m.mode) ? m.mode : 'exec');
  const message = { id: clip(run.id), lane: clip(lane), parent: clip(m.parent), kind, model: clip(m.model_shown || m.model) };
  for (const key of ['mode', 'agent', 'agent_type', 'level', 'effort', 'group', 'round', 'plan', 'seat', 'role', 'title', 'status']) message[key] = typeof m[key] === 'string' ? clip(m[key]) : m[key] ?? null;
  if (m.participant === 'host') { message.kind = 'answer'; if (message.status === 'running') message.status = 'idle'; }
  const usage = r?.usage ? usageOf(r.usage) : null, cost = r?.cost_usd ?? priceFor(message.model, usage, prices);
  const head = kind === 'discuss' ? r?.report?.position ?? first(r?.last_message) : kind === 'review' ? r?.report && `${r.report.verdict} · ${(r.report.findings || []).length} findings` : ['exec', 'image'].includes(kind) ? r?.report?.summary ?? first(r?.last_message) : null;
  return { ...message, started_at: ms(m.started_at), ended_at: ms(m.ended_at), duration_s: r?.duration_s ?? null,
    usage, cost_usd: cost, cost_source: r?.cost_usd != null ? 'reported' : cost != null ? 'api_equiv' : 'unknown', report_head: head ? String(head).slice(0, 160) : null,
    changed: (r?.changes?.files || []).slice(0, 40).map((f) => Object.fromEntries(['path', 'kind', 'added', 'removed'].filter((k) => k in f).map((k) => [k, f[k]]))),
    review: kind === 'review' && r?.report ? { verdict: clip(r.report.verdict, 120),
      // 审查报告的字段名见 foreman 的 review.schema.json：位置是 location，问题是 issue
      findings: (r.report.findings || []).slice(0, 8).map((f) => ({ severity: clip(f.severity, 120), where: clip(f.location ?? f.where, 120), title: clip(f.issue ?? f.title, 120) })) } : null,
    files: (r?.files || []).slice(0, 12).map((f) => ({ path: clip(f.path), chars: f.chars ?? null })), queued: !!run.tail.state.queued,
    // 执行任务允许改动的路径（并发拆分时各份互不重叠），看板在席位卡下面标出来
    scope: Array.isArray(m.scope) ? m.scope.slice(0, 8).map((p) => clip(p, 120)) : [], images: imagesOf(m, r).length };
}

export function replayClock(times, { speed = 1, maxgap = 20 } = {}, now) {
  times = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
  const mapped = new Map();
  let previous = times[0], clock = previous;
  for (const time of times) { clock += Math.min(time - previous, maxgap * 1000); mapped.set(time, clock); previous = time; }
  return { map: (time) => mapped.get(time), replay: { start: (mapped.get(times[0]) ?? now) - 2000, end: (clock ?? now) + 2000, speed, maxgap } };
}

export function buildReplay(data, { speed = 1, maxgap = 20, clock } = {}, now) {
  const timeline = [];
  const invalid = new Set(data.runs.filter((run) => !Number.isFinite(run.started_at)).map((run) => run.id));
  for (const run of data.runs) {
    if (invalid.has(run.id)) continue;
    timeline.push({ time: run.started_at, event: 'run', data: { ...run, status: run.kind === 'answer' ? run.status : 'running', ended_at: null, duration_s: null, usage: null, cost_usd: null, cost_source: 'unknown', report_head: null, changed: [], review: null, files: [], queued: false } });
    if (run.kind === 'host') {
      const usage = [];
      for (const ev of data.events.filter((e) => e.run === 'cc' && e.k === 'usage' && Number.isFinite(e.ts))) {
        usage.push(ev); const cost = hostCost(usage, data.prices);
        timeline.push({ time: ev.ts, event: 'run', data: { ...run, model: ev.t, status: 'running', usage: usageTotals(usage), cost_usd: cost, cost_source: cost == null ? 'unknown' : 'api_equiv' } });
      }
      timeline.push({ time: data.hostEnd, event: 'run', data: { ...run, status: 'idle' } });
    } else if (run.ended_at != null) timeline.push({ time: run.ended_at, event: 'run', data: run });
  }
  for (const ev of data.events) if (!invalid.has(ev.run)) timeline.push({ time: ev.ts, event: 'ev', data: ev });
  const valid = timeline.filter((message) => Number.isFinite(message.time));
  valid.sort((a, b) => a.time - b.time);
  clock ??= replayClock(valid.map((m) => m.time), { speed, maxgap }, now);
  // 全局回放的时钟固定后，后来追加的记录留给下一次回放。
  const scheduled = valid.filter((message) => Number.isFinite(clock.map(message.time)));
  for (const message of scheduled) {
    message.time = clock.map(message.time); message.data = { ...message.data };
    for (const key of ['ts', 'started_at', 'ended_at']) if (message.data[key] != null) message.data[key] = clock.map(message.data[key]);
  }
  return { hello: { v: 3, mode: 'replay', scope: data.scope, now, replay: clock.replay }, timeline: scheduled };
}

export function snapshotAt(replay, t = Infinity) {
  const cutoff = replay.hello.replay.start + t * 1000 * replay.hello.replay.speed, runs = new Map(), events = [];
  for (const message of replay.timeline) {
    if (message.time > cutoff) break;
    if (message.event === 'run') runs.set(message.data.id, message.data);
    else events.push(message.data);
  }
  return { hello: replay.hello, runs: [...runs.values()], events };
}

export function newTail(version = 0) { return { offset: 0, parts: [], decoder: new TextDecoder(), state: {}, events: [], signature: '', version }; }
// 分块读（每块 1 MB），按字节找换行，每次只把完整的一行交给解码器：
// 整块先解码成大字符串、再和上一块的半行拼接，是首次读大文件时内存峰值的主要来源。
// 沿用同一个流式解码器（文件开头的 BOM 照旧只去掉一次）；没读完的半行按字节片段留着，一行再长也不反复拼接。
// 给了 onLine 就每解析出一行交出去一行，不攒成数组（宇宙层只要累计值）；没给照旧返回 lines。
const CHUNK = 1024 * 1024;
export function readLines(file, tail, onLine) {
  const lines = [], st = stat(file);
  if (!st) return { tail, lines };
  if (tail.offset > st.size) tail = newTail(tail.version + 1);
  const signature = `${st.size}:${st.mtimeMs}`;
  if (tail.signature !== signature) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const bytes = Buffer.alloc(Math.min(CHUNK, Math.max(1, st.size - tail.offset)));
      let complete = true;
      while (tail.offset < st.size) {
        const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, st.size - tail.offset), tail.offset);
        if (count <= 0) { complete = false; break; }
        tail.offset += count;
        const buf = bytes.subarray(0, count);
        let start = 0, i;
        while ((i = buf.indexOf(10, start)) >= 0) {
          let piece = buf.subarray(start, i + 1);
          start = i + 1;
          if (tail.parts.length) { piece = Buffer.concat([...tail.parts, piece]); tail.parts = []; }
          let raw;
          try { raw = JSON.parse(tail.decoder.decode(piece, { stream: true })); } catch { continue; }
          if (onLine) onLine(raw); else lines.push(raw);
          tail.activity = st.mtimeMs;
        }
        // 读缓冲下一块要复用，半行拷贝出来
        if (start < buf.length) tail.parts.push(Buffer.from(buf.subarray(start)));
      }
      tail.signature = complete ? signature : '';
    } catch (e) { if (!transient(e)) throw e; return { tail, lines }; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return { tail, lines };
}
function readTail(run, now) {
  const read = readLines(path.join(run.dir, 'events.jsonl'), run.tail); run.tail = read.tail;
  for (const raw of read.lines) if (typeof raw?.type === 'string' && Number.isFinite(ms(raw.ts))) {
    run.tail.events.push(...normalize(raw, run, run.tail.state)); run.activity = run.tail.activity;
  }
  run.tail.events.push(...flush(run.tail.state, now, run.meta.status !== 'running'));
}

export function settleRun(run) {
  if (run.meta?.status === 'running' && run.result?.status && run.result.status !== 'running') {
    run.meta = { ...run.meta, status: run.result.status };
    if (!run.meta.ended_at && Number.isFinite(run.result.duration_s)) run.meta.ended_at = ms(run.meta.started_at) + run.result.duration_s * 1000;
  } else if (run.meta?.status === 'running' && run.meta.participant !== 'host' && !pidAlive(run.meta.pid)) {
    // 和 foreman 的 status 一样：结束时间取最后一次写事件的时刻。
    const last = stat(path.join(run.dir, 'events.jsonl')) || stat(path.join(run.dir, 'meta.json'));
    run.meta = { ...run.meta, status: 'interrupted', ended_at: run.meta.ended_at ?? (last ? last.mtimeMs : ms(run.meta.started_at)) };
  }
}

export function createFeed(root, options = {}) {
  const cache = new Map(), changed = new Set();
  const transcripts = new Map(), recentWindows = new Map();
  const findTranscript = (runs, recent, session) => {
    if (options.transcript) return stat(options.transcript)?.isFile() ? path.resolve(options.transcript) : null;
    if (!options.claudeDir) return null;
    const newest = [...runs].sort((a, b) => ms(b.meta.started_at) - ms(a.meta.started_at))[0];
    session ??= options.session ?? newest?.meta.claude_session;
    let dirs;
    try { dirs = fs.readdirSync(options.claudeDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(options.claudeDir, d.name)); }
    catch (e) { if (!transient(e)) throw e; return null; }
    // 直播每秒都要找一次：逐个目录直接看这个文件在不在，不列目录（Windows 的文件名本来就不分大小写）
    if (session != null) {
      for (const dir of dirs) {
        const file = path.resolve(dir, `${session}.jsonl`);
        if (path.dirname(file) === path.resolve(dir) && stat(file)?.isFile()) return file;
      }
      return null;
    }
    if (!recent) return null;
    let latest = null, modified = -Infinity;
    for (const dir of dirs) {
      let files;
      try { files = fs.readdirSync(dir); } catch (e) { if (!transient(e)) throw e; continue; }
      for (const name of files) if (name.endsWith('.jsonl')) {
        const file = path.join(dir, name), st = stat(file);
        if (st?.isFile() && st.mtimeMs > modified) { latest = file; modified = st.mtimeMs; }
      }
    }
    return latest;
  };
  const addClaude = (data, runs, params, now) => {
    const session = data.scope.kind === 'session', recent = data.scope.kind === 'recent' || session && !runs.length;
    const file = findTranscript(runs, recent, session ? data.scope.value : undefined);
    if (!file || !recent && !session && !runs.length) return data;
    const previous = transcripts.get(file), read = readLines(file, previous || newTail()), tail = read.tail;
    if (previous && read.lines.some((r) => !r.isSidechain && ['user', 'assistant'].includes(r.type))) tail.appendedAt = now;
    tail.records ??= []; tail.records.push(...read.lines);
    transcripts.delete(file); transcripts.set(file, tail);
    if (transcripts.size > 3) { const old = transcripts.keys().next().value; transcripts.delete(old); recentWindows.delete(old); }
    let window = recentWindows.get(file);
    // 首次取最近半小时，此后保留追加记录，不让窗口滑动丢掉会话用量。
    if (recent && (!window || window.version !== tail.version)) { window = { from: now - 1800000, to: now, initial: tail.records.length, version: tail.version }; recentWindows.set(file, window); }
    const replay = session && params.replay != null;
    const from = replay ? -Infinity : recent ? window.from : Math.min(...runs.map((r) => ms(r.meta.started_at))) - (options.lead ?? 10) * 60000;
    const end = session ? Infinity : recent ? window.to : Math.max(...runs.map((r) => ms(r.meta.ended_at) ?? now)) + (options.tail ?? 5) * 60000;
    const lines = tail.records.filter((r, i) => r.type === 'custom-title' || recent && i >= window.initial || ms(r.timestamp) >= from && ms(r.timestamp) <= end);
    const parsed = parseTranscriptLines(lines, { cwd: null, runIds: runs.map((r) => r.id), runsInScope: runs });
    const m = parsed.meta;
    if (m.started_at == null) return data;
    const cost = hostCost(parsed.events.filter((e) => e.k === 'usage'), options.prices);
    data.runs.push({ id: 'cc', lane: 'cc', kind: 'host', agent: 'claude code', agent_type: 'host', model: m.model, session: m.session || path.basename(file, '.jsonl'), title: m.title, cwd: m.cwd,
      status: params.replay != null || now - Math.max(m.latest_at, tail.appendedAt ?? -Infinity) < 90000 ? 'running' : 'idle', started_at: m.started_at, ended_at: null, usage: m.usage, cost_usd: cost, cost_source: cost == null ? 'unknown' : 'api_equiv' });
    data.events.push(...parsed.events); data.versions.cc = `${file}:${tail.version}`; data.revisions.cc = '';
    data.hostEnd = session ? m.latest_at : end; return data;
  };
  let names = [], dirty = true, watcher = null;
  const scan = () => {
    if (!dirty) return;
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse(); dirty = false; }
    catch (e) { if (!transient(e)) throw e; }
  };
  const update = (id, details = true) => {
    const run = cache.get(id) || { id, dir: path.join(root, id), meta: null, result: null, signatures: {}, tail: newTail() };
    cache.set(id, run);
    for (const name of ['meta', 'result', 'verdict']) {
      if (name === 'result' && !details && run.meta?.status !== 'running' || name === 'verdict' && !details) continue;
      const file = path.join(run.dir, `${name}.json`), st = stat(file);
      if (!st) continue;
      const signature = `${st.size}:${st.mtimeMs}`;
      if (run.signatures[name] === signature) continue;
      const value = json(file);
      if (value) { run[name] = value; run.signatures[name] = signature; }
    }
    settleRun(run);
    return run;
  };
  // 派发计划：建计划那一刻在 Claude Code 车道上记一件事，带上各席的模型和角色，画面据此先拉出席位
  const plans = new Map();
  const planEvent = (id) => {
    const file = path.join(root, 'plans', `${id}.json`), st = stat(file);
    if (!st) return null;
    let entry = plans.get(id);
    if (entry?.signature !== `${st.size}:${st.mtimeMs}`) { entry = { signature: `${st.size}:${st.mtimeMs}`, value: json(file) }; plans.set(id, entry); }
    const p = entry.value;
    if (!p || !Number.isFinite(ms(p.created_at))) return null;
    return { run: 'cc', lane: 'cc', ts: ms(p.created_at), k: 'fplan', plan: clip(id), group: clip(p.group), t: clip(p.why), module: clip(p.module), cell: clip(p.cell ?? p.level),
      host: p.host ? { role: clip(p.host.role) } : null, seats: (p.seats || []).map((s) => ({ seat: s.seat, model: clip(s.model), agent: clip(s.agent), role: clip(s.role), required: !!s.required })) };
  };
  // 裁决：verdict.json 里同一时刻记下的几条算一次，数出接受、部分接受、拒绝各几条
  const verdictEvents = (run) => {
    const items = Object.entries(run.verdict?.items || {}), at = new Map();
    for (const [id, item] of items) {
      const time = ms(item.at ?? run.verdict.updated_at);
      if (!Number.isFinite(time)) continue;
      if (!at.has(time)) at.set(time, { a: [], p: [], r: [] });
      const bucket = at.get(time)[item.verdict === 'accept' ? 'a' : item.verdict === 'partial' ? 'p' : 'r'];
      bucket.push(clip(id, 12));
    }
    return [...at].map(([ts, v]) => ({ run: run.id, lane: run.lane, ts, k: 'verdict', plan: clip(run.meta.plan), round: run.meta.round ?? 1, ...v }));
  };
  const recentNames = (now, hours) => names.filter((id) => {
    const p = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
    return p && new Date(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +p[6]).getTime() >= now - hours * 3600000;
  });
  return {
    watch(enabled) {
      if (enabled && !watcher) {
        dirty = true;
        try {
          watcher = fs.watch(root, { recursive: true }, (_, filename) => {
            const file = String(filename ?? '');
            changed.add(file.split(/[\\/]/)[0]);
            if (!/[\\/]/.test(file)) dirty = true;
          });
          watcher.on('error', () => { watcher?.close(); watcher = null; dirty = true; });
        } catch { watcher = null; } // 不支持递归监听时由 read 每秒重扫。
      }
      if (!enabled) { watcher?.close(); watcher = null; dirty = true; }
    },
    hasRunning(now) {
      dirty = true; scan();
      return recentNames(now, 24).map((id) => update(id, false)).some((r) => r.meta?.status === 'running' && r.meta.participant !== 'host' && ms(r.meta.started_at) >= now - 86400000);
    },
    read(params, now = options.now?.() ?? Date.now()) {
      if (!watcher) dirty = true;
      scan();
      const recent = params.session == null && params.group == null && params.run == null && params.replay == null;
      const candidates = recent ? recentNames(now, 48) : names;
      for (const id of candidates) {
        let run = cache.get(id);
        // 未入前八的车道有活动时也要参与排序；只补查 watch 指出的目录。
        const refresh = recent && (!watcher || !run?.recentSeen || changed.has(id));
        if (!run?.meta || refresh) run = update(id, false);
        if (refresh) {
          if (run.meta?.status === 'running' || ms(run.meta?.ended_at) >= now - 1800000) run.activity = stat(path.join(run.dir, 'events.jsonl'))?.mtimeMs || 0;
          run.recentSeen = true; changed.delete(id);
        }
      }
      let available = () => [...cache.values()].filter((r) => names.includes(r.id) && (!recent || candidates.includes(r.id)));
      let selected = selectScope(available(), params, now);
      const updated = new Set();
      for (const run of selected.runs) {
        update(run.id);
        updated.add(run.id);
        let parent = run.meta.parent;
        const seen = new Set([run.id]);
        while (parent && names.includes(parent) && !seen.has(parent)) {
          seen.add(parent); const ancestor = update(parent, false); parent = ancestor.meta?.parent;
        }
      }
      // 最近范围的扫描限于 48 小时，已选车道的祖先按 parent 定点补读。
      const roots = new Set(selected.runs.map((r) => laneOf(r, cache)));
      if (recent) available = () => [...cache.values()].filter((r) => names.includes(r.id) && (candidates.includes(r.id) || roots.has(laneOf(r, cache))));
      selected = selectScope(available(), params, now);
      const runs = [], events = [], versions = {}, revisions = {};
      for (const run of selected.runs) {
        if (!updated.has(run.id)) update(run.id);
        run.lane = laneOf(run, cache); readTail(run, now);
        const message = runMessage(run, run.lane, options.prices); runs.push(message); versions[run.id] = run.tail.version;
        revisions[run.id] = `${run.signatures.meta}:${run.signatures.result}`;
        const history = [{ run: run.id, lane: run.lane, ts: message.started_at, k: 'start', t: clip(message.kind) }, ...run.tail.events.map((e) => ({ ...e, lane: run.lane }))];
        if (message.ended_at != null) history.push({ run: run.id, lane: run.lane, ts: message.ended_at, k: 'end', t: clip(message.status) });
        history.push(...verdictEvents(run));
        events.push(...history);
      }
      for (const id of new Set(selected.runs.map((r) => r.meta.plan).filter(Boolean))) { const ev = planEvent(id); if (ev) events.push(ev); }
      return addClaude({ scope: selected.scope, runs, events, versions, revisions, prices: options.prices }, selected.runs, params, now);
    },
  };
}
