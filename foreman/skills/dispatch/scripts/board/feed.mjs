import fs from 'node:fs';
import path from 'node:path';
import { parseTranscriptLines, createTranscriptParser, plainCommand } from './claude-feed.mjs';
import { priceFor, costOf } from '../prices.mjs';
import { roundOf, resultOutcome, realErrors, reviewFinding, reviewCounts, current, queuedStarted } from '../display.mjs';
import { queuedRuns, CLAUDE_SESSION } from '../records.mjs';

export const ms = (v) => v == null ? null : typeof v === 'number' ? v : Date.parse(v);
const oneLine = (v) => String(v ?? '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean).join(' ⏎ ');
const clip = (v, n = 160) => v == null ? null : oneLine(v).slice(0, n);
const first = (v) => String(v ?? '').trim().split(/\r?\n/).find((s) => s.trim()) || '';
export const transient = (e) => ['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code);
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function stat(file) { try { return fs.statSync(file); } catch (e) { if (!transient(e)) throw e; return null; } }
export function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (!transient(e) && !(e instanceof SyntaxError)) throw e; return null; } }

const usageOf = (u) => ({ input: u.input_tokens == null ? null : Math.max(0, u.input_tokens - (u.cached_input_tokens ?? 0) - (u.cache_write_input_tokens ?? 0)),
  cached: u.cached_input_tokens ?? null, cache_write: u.cache_write_input_tokens ?? null, output: u.output_tokens ?? null });
export const usageTotals = (events) => events.reduce((sum, e) => {
  for (const [key, value] of Object.entries(e.u)) if (value != null) { const name = key === 'in' ? 'input' : key === 'out' ? 'output' : key; sum[name] = (sum[name] ?? 0) + value; }
  return sum;
}, { input: null, cached: null, cache_write: null, output: null });
// 能定价的消息照算；有的消息算不出价（模型不在价格表里）时 out.partial 为真，显示时在费用后面加 +。
// 一条都算不出才返回 null
export function hostCost(events, prices, out = {}) {
  const costs = events.map((e) => priceFor(e.t, { input: e.u.in, cached: e.u.cached, cache_write: e.u.cache_write, output: e.u.out }, prices));
  const priced = costs.filter((v) => v != null);
  out.partial = priced.length < costs.length;
  return priced.length ? priced.reduce((a, b) => a + b, 0) : null;
}
export const costFields = (cost, source) => ({ cost_usd: cost, cost_source: source });

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
    // 并行命令的完成顺序不固定，保留动作编号供页面配对。
    const aid = it.id == null ? {} : { aid: String(it.id) };
    const category = tool.category, text = clip(tool.label ?? tool.command) || '';
    const label = tool.label != null ? text : tool.tool && text === tool.tool ? '.' : tool.tool && text.startsWith(`${tool.tool} `) ? text.slice(tool.tool.length + 1) : text;
    if (raw.type === 'item.started') {
      state.commands.set(it.id, tool);
      if (category === 'read' || category === 'search') state.tools.set(it.id, ev(category, { t: label, ...aid }));
      else emit('cmd', { t: plainCommand(tool.command), ...aid });
    } else {
      if (category === 'read' || category === 'search') { state.tools.delete(it.id); emit(category, { t: label, ...aid }); }
      else { if (!previous) emit('cmd', { t: plainCommand(tool.command), ...aid }); emit('cmd_done', { ok: tool.exit_code === 0 || tool.exit_code == null, ...aid }); }
      state.commands.delete(it.id);
    }
  } else if (raw.type === 'item.completed') {
    if (it.type === 'agent_message') {
      const text = String(it.text ?? '').trim();
      let report = false;
      try { const value = JSON.parse(text); report = value !== null && typeof value === 'object' && !Array.isArray(value); } catch { /* 普通消息 */ }
      if (report) emit('report', { n: String(it.text).length });
      else if (text) emit('msg', { t: text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' ') });
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
  else if (raw.type === 'api.usage' || raw.type === 'step.usage' || raw.type === 'turn.completed' && raw.usage) {
    const usage = raw.usage || {}, input = usage.input_tokens || 0, output = usage.output_tokens || 0;
    const u = usageOf(usage);
    emit('usage', { n: input + output, t: `${input}/${output}`, u: { in: u.input, cached: u.cached, cache_write: u.cache_write, out: u.output },
      ...(raw.type === 'turn.completed' ? { tot: 1 } : {}), ...(raw.type === 'step.usage' && raw.final ? { end: 1 } : {}),
      ...(raw.usage_from != null ? { usage_from: ms(raw.usage_from), usage_to: ms(raw.usage_to) } : {}) });
  } else if (['api.error', 'turn.failed', 'error'].includes(raw.type)) emit('error', { t: raw.message ?? raw.error?.message ?? '' });
  else if (raw.type === 'image.generated' || raw.type === 'image.viewed') emit('image', { t: path.win32.basename(raw.path || ''), ...(raw.type === 'image.viewed' ? { viewed: true } : {}) });
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

// 按对话选时，params.sessions 可以给出同一个对话的全部会话 id（桌面版重启、恢复后换过 id，先前的也算），没给就只认 value
export function selectScope(runs, params, now) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  let kind = params.session != null ? 'session' : params.group != null ? 'group' : params.run != null ? 'run' : 'recent';
  const value = params.session ?? params.replay ?? params.group ?? params.run ?? null;
  // 回放可以按组、按任务，也可以按对话（replay 写 Claude Code 会话 id，取这个对话派出的所有任务）
  if (params.replay != null && params.session == null) kind = runs.some((r) => r.meta?.group === value) ? 'group' : runs.some((r) => r.meta?.claude_session === value) ? 'session' : runs.some((r) => r.id === value) ? 'run' : 'session';
  let seeds = runs.filter((r) => r.meta);
  const ids = params.sessions ?? new Set([value]);
  if (kind === 'group') {
    seeds = seeds.filter((r) => r.meta.group === value);
    const newest = seeds.reduce((a, b) => !a || ms(b.meta.started_at) > ms(a.meta.started_at) ? b : a, null);
    seeds = seeds.filter((r) => (r.meta.claude_session ?? null) === (newest?.meta.claude_session ?? null));
  } else if (kind === 'session') seeds = seeds.filter((r) => ids.has(r.meta.claude_session));
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
  return { scope: { kind, value }, runs: runs.filter((r) => r.meta && (params.session == null || ids.has(r.meta.claude_session)) && roots.includes(laneOf(r, byId)) && (laneOf(r, byId) !== 'cc' || seeds.includes(r)))
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

// 整份显示正文设上限，先省选项和附录，保留结论、状态与完整问题计数。
function limitDisplay(display) {
  const size = (v) => Buffer.byteLength(JSON.stringify(v));
  let bytes = size(display);
  const over = () => bytes > 65536, report = display.report;
  if (!over()) return display;
  for (const q of [...(display.questions || []), ...(report?.decision_requests || [])]) { bytes -= size(q.options) - 2; q.options = []; }
  for (const key of ['unverified', 'open_issues', 'open_questions']) if (over() && report) { bytes -= size(report[key]) - 2; report[key] = []; }
  // 有效性已经单独传递，超限时可省去终端区不用的审查材料描述。
  if (over() && display.review_target != null) { delete display.review_target; bytes = size(display); }
  // 先裁审查问题（总数和各严重程度另有 findings_counts），再把问题和报错的长文字截短，最后才去掉问题和报错的条目
  const findings = report?.findings;
  while (over() && findings?.length > 1) bytes -= size(findings.pop()) + 1;
  // 有逐条的 questions 时摘要用它，报告里的 decision_requests 不显示：先去掉它们
  if (display.questions?.length) while (over() && report?.decision_requests?.length) bytes -= size(report.decision_requests.pop()) + 1;
  const cut = (v) => (typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v);
  if (over()) {
    for (const q of [...(display.questions || []), ...(report?.decision_requests || [])]) for (const key of Object.keys(q)) q[key] = cut(q[key]);
    if (display.errors) display.errors = display.errors.map(cut);
    bytes = size(display);
  }
  // 报错保留第一条（超时、取消这类原因写在最前面），问题从后往前去掉
  const lists = [report?.decision_requests, display.questions, display.errors].filter(Boolean).map((xs) => ({ xs, bytes: size(xs) }));
  while (over() && lists.some(({ xs }) => xs.length > 1)) {
    const largest = lists.filter(({ xs }) => xs.length > 1).sort((a, b) => b.bytes - a.bytes)[0];
    const removed = size(largest.xs.pop()) + 1;
    bytes -= removed; largest.bytes -= removed;
  }
  if (over()) {
    const shorten = (v) => typeof v === 'string' ? v.slice(0, 500) : Array.isArray(v) ? v.map(shorten)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)])) : v;
    return shorten(display);
  }
  return display;
}

export function runMessage(run, lane, prices, byId, { display: includeDisplay = true } = {}) {
  const m = run.meta, r = run.result, kind = m.module === 'image' ? 'image' : m.kind || (['discuss', 'review'].includes(m.mode) ? m.mode : 'exec');
  const message = { id: clip(run.id), lane: clip(lane), parent: clip(m.parent), kind, model: clip(m.model_shown || m.model) };
  for (const key of ['mode', 'agent', 'agent_type', 'level', 'effort', 'group', 'round', 'plan', 'seat', 'role', 'title', 'status']) message[key] = typeof m[key] === 'string' ? clip(m[key]) : m[key] ?? null;
  // 派出它的 Claude Code 对话：页面拿老格式的地址（只给组或任务）找到要飞进去的对话
  message.session = typeof m.claude_session === 'string' ? clip(m.claude_session) : null;
  if (m.participant === 'host') { message.kind = 'answer'; if (message.status === 'running') message.status = 'idle'; }
  let rawUsage = r?.usage, usage_scope = r?.usage_scope, usage_unattributed = false;
  const cumulative = usage_scope === 'session_total';
  if (rawUsage && cumulative) {
    const baseline = {}, seen = new Set([run.id]);
    let parent = m.parent, known = !parent;
    // 只沿续接链还原累计基线；中间缺轮次时不能把会话总量冒充本轮增量。
    while (parent && byId?.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      const previous = byId.get(parent), u = previous.result?.usage;
      if (u?.output_tokens == null || (m.session_id && previous.meta.session_id && m.session_id !== previous.meta.session_id)) break;
      for (const [key, value] of Object.entries(u)) baseline[key] = (baseline[key] || 0) + (value || 0);
      const scope = previous.result.usage_scope;
      if (scope === 'session_total' || !previous.meta.parent) { known = true; break; }
      if (scope !== 'this_run') break;
      parent = previous.meta.parent;
    }
    const delta = Object.fromEntries(Object.entries(rawUsage).map(([key, value]) => [key, value == null ? null : value - (baseline[key] || 0)]));
    usage_unattributed = !known || rawUsage.output_tokens == null || Object.values(delta).some((n) => n < 0);
    rawUsage = usage_unattributed ? null : delta;
    if (!usage_unattributed) usage_scope = 'this_run';
  }
  const usage = rawUsage ? usageOf(rawUsage) : null;
  const cost = costOf({ ...m, ...r, usage: rawUsage, usage_scope,
    ...(cumulative ? { cost_source: undefined } : {}) }, prices);
  const head = kind === 'discuss' ? r?.report?.position ?? first(r?.last_message) : kind === 'review' ? r?.report && `${r.report.verdict} · ${(r.report.findings || []).length} findings` : ['exec', 'image'].includes(kind) ? r?.report?.summary ?? first(r?.last_message) : null;
  // 终端原始用量和表格的本轮增量分开传，避免续接累计量改变既有统计含义。
  const text = (v) => v == null ? v : String(v).slice(0, 4000);
  const list = (xs, fn = text) => (xs || []).slice(0, 30).map(fn);
  const fields = (value, keys) => Object.fromEntries(keys.filter((k) => value?.[k] != null).map((k) => [k, text(value[k])]));
  const question = (q) => ({ ...fields(q, ['source', 'question', 'why_it_matters', 'recommendation']), options: (q.options || []).slice(0, 10).map((v) => String(v).slice(0, 500)) });
  const finding = (f) => fields(reviewFinding(f), ['id', 'severity', 'location', 'issue']);
  const values = (value, keys) => value == null ? null : Object.fromEntries(keys.filter((k) => value[k] != null).map((k) => [k, value[k]]));
  const o = resultOutcome(r, { ...m, kind });
  const report = r?.report ? { ...fields(r.report, ['status', 'position', 'summary', 'verdict']),
    findings: list(r.report.findings, finding), findings_counts: reviewCounts(r.report.findings),
    decision_requests: list(r.report.decision_requests, question), decision_requests_total: (r.report.decision_requests || []).length, open_issues: list(r.report.open_issues),
    open_questions: list(r.report.open_questions), unverified: list(r.report.unverified) } : null;
  const changes = r?.changes;
  const display = includeDisplay && r ? { status: r.status, valid: o.valid, needs_decision: !!r.needs_decision, report,
    // 原来的条数：列表最多带 30 条，大小超限时还会再裁，摘要按原数写"还有 N 条"
    questions: r.questions == null ? null : list(r.questions, question), questions_total: r.questions?.length ?? 0,
    errors: list(realErrors(r, o.ok || o.partial)), errors_total: realErrors(r, o.ok || o.partial).length,
    stale: r.stale === true, duration_s: r.duration_s, usage: values(r.usage, ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens']), usage_scope: r.usage_scope,
    last_request: values(r.last_request ?? r.context, ['tokens', 'window']), output_tokens_per_s: r.output_tokens_per_s,
    ...costOf({ ...m, ...r }, prices), last_message: text(r.last_message), native_review: r.native_review, review_target: r.review_target,
    changes: changes ? { ...Object.fromEntries(['available', 'files_total', 'agent_total', 'codex_total', 'reported_total', 'unknown_total'].map((k) => [k, changes[k]])),
      group_total: changes.group_total ?? [...(changes.files || []), ...(changes.large_files_changed || [])].filter((f) => f?.group_run).length,
      ...(changes.outside_cwd ? { outside_cwd: changes.outside_cwd.slice(0, 30).map((f) => ({ path: clip(f.path, 500), by: f.by, in_scope: f.in_scope })), outside_cwd_total: changes.outside_cwd_total } : {}) } : null,
    ...(changes?.outside_cwd ? { cwd: m.cwd } : {}) } : null;
  return { ...message, started_at: ms(m.started_at), ended_at: ms(m.ended_at), duration_s: r?.duration_s ?? null,
    ...(includeDisplay ? { display: display && limitDisplay(JSON.parse(JSON.stringify(display))) } : {}), display_round: roundOf(m, byId ?? new Map()), module: m.module ?? (kind === 'exec' ? 'run' : kind),
    participant: m.participant ?? null, submitted_at: ms(m.submitted_at), author: !!m.author,
    model_name: clip(m.model_name), display_model: clip(m.model || m.model_name || m.model_shown), cell: clip(m.cell), route: m.route ?? null,
    usage, ...(r?.usage_scope != null ? { usage_scope } : {}), ...(usage_unattributed ? { usage_unattributed: true } : {}),
    ...costFields(cost.cost_usd, cost.cost_source), report_head: head ? String(head).slice(0, 160) : null,
    // 同组别的任务改的文件（group_run）不算这一席的，卡片的产出框不列
    changed: (r?.changes?.files || []).filter((f) => !f.group_run).slice(0, 40).map((f) => Object.fromEntries(['path', 'kind', 'added', 'removed'].filter((k) => k in f).map((k) => [k, f[k]]))),
    review: kind === 'review' && r?.report ? { verdict: clip(r.report.verdict, 120),
      // 审查报告的字段名见 foreman 的 review.schema.json：位置是 location，问题是 issue
      findings: (r.report.findings || []).slice(0, 8).map((f) => { const value = finding(f); return { severity: clip(value.severity, 120), where: clip(value.location, 120), title: clip(value.issue, 120) }; }) } : null,
    files: (r?.files || []).slice(0, 12).map((f) => ({ path: clip(f.path), chars: f.chars ?? null })), queued: !!run.tail.state.queued,
    // 执行任务允许改动的路径（并发拆分时各份互不重叠），看板在席位卡下面标出来
    scope: Array.isArray(m.scope) ? m.scope.slice(0, 8).map((p) => clip(p, 120)) : [], images: imagesOf(m, r).length };
}

export function replayClock(times, { speed = 1, maxgap = 20 } = {}, now) {
  times = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
  const mapped = new Map(), time_map = times.length ? [[times[0], times[0]]] : [];
  let previous = times[0], clock = previous;
  for (const time of times) {
    const gap = Math.min(time - previous, maxgap * 1000);
    if (gap < time - previous) {
      if (time_map.at(-1)[0] !== clock) time_map.push([clock, previous]);
      time_map.push([clock + gap, time]);
    }
    clock += gap; mapped.set(time, clock); previous = time;
  }
  // 中间帧也要还原记录时间，统计窗口不能随播放空档一起压缩。
  return { map: (time) => mapped.get(time), replay: { start: (mapped.get(times[0]) ?? now) - 2000, end: (clock ?? now) + 2000, speed, maxgap,
    time_map } };
}

export function buildReplay(data, { speed = 1, maxgap = 20, clock } = {}, now) {
  const timeline = [];
  const invalid = new Set(data.runs.filter((run) => !Number.isFinite(run.started_at)).map((run) => run.id));
  for (const run of data.runs) {
    if (invalid.has(run.id)) continue;
    // 回放从头开始：不带最终的 cost_partial（Claude Code 的费用标记按播到的消息重新算）
    const { display, cost_partial: _final, ...initial } = run;
    timeline.push({ time: run.started_at, event: 'run', data: { ...initial, ...(run.kind === 'answer' ? { display } : {}), status: run.kind === 'answer' ? run.status : 'running', ended_at: null, duration_s: null, usage: null, ...costFields(null, 'unknown'), report_head: null, changed: [], review: null, files: [], queued: false } });
    if (run.kind === 'host') {
      let usage = usageTotals([]), cost = 0, unknown = false, priced = false;
      for (const ev of data.events.filter((e) => e.run === 'cc' && e.k === 'usage' && Number.isFinite(e.ts))) {
        // 解析器已经按消息末行去重；按原顺序累加，保留浮点求和。和直播一样：能定价的照加，有算不出价的标 cost_partial
        usage = usageTotals([{ u: usage }, ev]);
        const value = hostCost([ev], data.prices); unknown ||= value == null; priced ||= value != null; cost += value ?? 0;
        timeline.push({ time: ev.ts, event: 'run', data: { ...initial, model: ev.t, status: 'running', usage, ...costFields(priced ? cost : null, priced ? 'api_price' : 'unknown'),
          ...(priced && unknown ? { cost_partial: true } : {}) } });
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
    // maxgap 可以为零，压到同一刻的事件仍须保留各自的原始统计边界。
    for (const key of ['ts', 'started_at', 'ended_at']) if (message.data[key] != null) {
      message.data[`original_${key}`] = message.data[key]; message.data[key] = clock.map(message.data[key]);
    }
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

// 逐条追加：push(...很长的数组) 会把每一项当成函数参数，几万行的对话记录就会栈溢出
export function append(list, items) {
  for (const item of items) list.push(item);
  return list;
}

export function newTail(version = 0) { return { offset: 0, parts: [], decoder: new TextDecoder(), state: {}, events: [], signature: '', version }; }
// 分块读（每块 1 MB），按字节找换行，每次只把完整的一行交给解码器：
// 整块先解码成大字符串、再和上一块的半行拼接，是首次读大文件时内存峰值的主要来源。
// 沿用同一个流式解码器（文件开头的 BOM 照旧只去掉一次）；没读完的半行按字节片段留着，一行再长也不反复拼接。
// 给了 onLine 就每解析出一行交出去一行，不攒成数组（宇宙层只要累计值）；没给照旧返回 lines。
const CHUNK = 1024 * 1024, SAMPLE = 4096;
export function readLines(file, tail, onLine, onReset) {
  const lines = [], st = stat(file);
  if (!st) return { tail, lines };
  const reset = () => { tail = newTail(tail.version + 1); onReset?.(tail); };
  const identity = st.ino ? `${st.dev}:${st.ino}:${st.birthtimeMs}` : null;
  if (tail.offset > st.size || identity && tail.identity && identity !== tail.identity) reset();
  const signature = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  // 上次读完整了、这次大小没长但修改时间变了：只追加的日志不会这样，是被原地改写了，整份重读
  if (tail.signature && tail.signature !== signature && tail.offset > 0 && st.size === tail.offset) reset();
  if (tail.signature !== signature) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const bytes = Buffer.alloc(Math.min(CHUNK, Math.max(1, st.size)));
      // 同 inode 截短再长回时身份不变：文件变了就核对已读部分的开头和末尾各 4 KB 还在不在原处。
      // 只读这两小段，不重读整个已读前缀：一百多 MB 的对话每秒都在追加，整段重算会把增量解析的收益全吃掉
      if (identity && tail.identity && tail.offset && tail.head) {
        const same = (sample, at) => {
          const buf = Buffer.alloc(sample.length);
          return fs.readSync(fd, buf, 0, sample.length, at) === sample.length && buf.equals(sample);
        };
        if (!same(tail.head, 0) || !same(tail.last, tail.offset - tail.last.length)) reset();
      }
      tail.identity = identity;
      let complete = true;
      while (tail.offset < st.size) {
        const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, st.size - tail.offset), tail.offset);
        if (count <= 0) { complete = false; break; }
        tail.offset += count;
        const buf = bytes.subarray(0, count);
        if (!tail.head || tail.head.length < SAMPLE) tail.head = Buffer.concat([tail.head ?? Buffer.alloc(0), buf.subarray(0, SAMPLE - (tail.head?.length ?? 0))]);
        tail.last = Buffer.concat([tail.last ?? Buffer.alloc(0), buf.subarray(-SAMPLE)]).subarray(-SAMPLE);
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
function readTail(run, now, onRaw) {
  const read = readLines(path.join(run.dir, 'events.jsonl'), run.tail); run.tail = read.tail;
  for (const raw of read.lines) {
    onRaw?.(raw);
    if (typeof raw?.type === 'string' && Number.isFinite(ms(raw.ts))) {
      append(run.tail.events, normalize(raw, run, run.tail.state)); run.activity = run.tail.activity;
    }
  }
  append(run.tail.events, flush(run.tail.state, now, run.meta.status !== 'running'));
}

export function settleRun(run) {
  if (run.meta?.status === 'running' && run.result?.status && run.result.status !== 'running') {
    run.meta = { ...run.meta, status: run.result.status };
    if (!run.meta.ended_at && Number.isFinite(run.result.duration_s)) run.meta.ended_at = ms(run.meta.started_at) + run.result.duration_s * 1000;
  } else if (run.meta?.status === 'running' && run.meta.participant !== 'host' && !pidAlive(run.meta.pid)) {
    // 和 foreman 的 status 一样：结束时间取最后一次写事件的时刻。
    const last = stat(path.join(run.dir, 'events.jsonl')) || stat(path.join(run.dir, 'meta.json'));
    run.meta = { ...run.meta, status: 'interrupted', ended_at: run.meta.ended_at ?? (last ? last.mtimeMs : ms(run.meta.started_at)) };
  } else if (run.meta && run.meta.status !== 'running' && run.meta.participant !== 'host' && !run.meta.ended_at) {
    // 已经结束却没写结束时间的（调度进程被强行结束后用 cancel 标成已处理的旧记录）：取最后一次写事件的时刻，
    // 不看 meta.json（cancel 补写它的时间会晚很多），否则页面会一直当它在跑
    const last = stat(path.join(run.dir, 'events.jsonl'));
    run.meta = { ...run.meta, ended_at: last ? last.mtimeMs : ms(run.meta.started_at) };
  }
}

export function createFeed(root, options = {}) {
  const cache = new Map(), changed = new Set();
  const transcripts = new Map(), recentWindows = new Map(), queueScopes = new Set();
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
  const addClaude = (data, runs, params, now, transcript) => {
    const session = data.scope.kind === 'session', recent = data.scope.kind === 'recent' || session && !runs.length;
    const file = transcript?.file ?? findTranscript(runs, recent, session ? data.scope.value : undefined);
    if (!file || !recent && !session && !runs.length) return data;
    const previous = transcript ? null : transcripts.get(file), read = transcript ? { tail: newTail(), lines: transcript.records } : readLines(file, previous || newTail()), tail = read.tail;
    if (previous && read.lines.some((r) => !r.isSidechain && ['user', 'assistant'].includes(r.type))) tail.appendedAt = now;
    const initial = tail.count ?? 0; tail.count = initial + read.lines.length;
    let window = recentWindows.get(file);
    // 首次取最近半小时，此后保留追加记录，不让窗口滑动丢掉会话用量。
    if (recent && (!window || window.version !== tail.version)) { window = { from: now - 1800000, to: now, initial: tail.count, version: tail.version }; recentWindows.set(file, window); }
    const replay = session && params.replay != null;
    let firstAt = Infinity, lastAt = -Infinity, openEnd = false;
    for (const run of runs) { const ended = ms(run.meta.ended_at); firstAt = Math.min(firstAt, ms(run.meta.started_at)); lastAt = Math.max(lastAt, ended ?? now); openEnd ||= ended == null; }
    const from = replay ? -Infinity : recent ? window.from : firstAt - (options.lead ?? 10) * 60000;
    const end = session ? Infinity : recent ? window.to : lastAt + (options.tail ?? 5) * 60000;
    const accepts = (r, i) => r.type === 'custom-title' || recent && i >= window.initial || ms(r.timestamp) >= from && ms(r.timestamp) <= end;
    const ctx = { cwd: null, runIds: runs.map((r) => r.id), runsInScope: runs };
    let parsed, cost, costPartial = false;
    if (transcript) {
      parsed = parseTranscriptLines(read.lines.filter(accepts), ctx);
      const priced = {};
      cost = hostCost(parsed.events.filter((e) => e.k === 'usage'), options.prices, priced); costPartial = priced.partial;
    } else {
      const key = JSON.stringify([String(from), String(!session && !recent && openEnd && Number.isFinite(end) ? Infinity : end), recent ? window.initial : null, [...runs].sort((a, b) => Date.parse(a.meta.started_at) - Date.parse(b.meta.started_at)).map((r) => [r.id, r.dir, r.lane, ...['started_at', 'parent', 'participant', 'mode', 'plan', 'seat', 'agent', 'group'].map((k) => r.meta[k])])]);
      let changed = false;
      const add = (row, i) => {
        if (accepts(row, i)) { tail.parser.write(row); changed = true; }
        else if (!row.isSidechain && ['assistant', 'user'].includes(row.type) && ms(row.timestamp) >= from && ms(row.timestamp) > end) tail.futureAt = Math.min(tail.futureAt ?? Infinity, ms(row.timestamp));
      };
      // 开放窗口的键保持稳定；未来行进入实际截止时间或窗口收缩时才重新筛选。
      if (tail.key !== key || end < tail.end || Number.isFinite(tail.futureAt) && tail.futureAt <= end) {
        const before = { parser: tail.parser, futureAt: tail.futureAt };
        tail.parser = createTranscriptParser(ctx); tail.key = key; tail.futureAt = Infinity;
        // 不留原始行；换窗口或任务集合时从文件重建，保留尾读版本和活跃时间。
        let complete = true;
        if (initial) {
          let i = 0;
          // 只重建本轮尾读已确认的行，并发追加的行留给下一轮，避免重复计入。
          const rebuilt = readLines(file, newTail(), (row) => { if (i < tail.count) add(row, i); i++; });
          complete = !!rebuilt.tail.signature;
        } else read.lines.forEach(add);
        // 重建这一轮没读全（文件一时被占用）：接着用上一份结果，下一轮再重建，不能把空结果发出去让对话从看板上消失
        if (complete) changed = true;
        else Object.assign(tail, { parser: before.parser, key: null, futureAt: before.futureAt });
      } else read.lines.forEach((row, i) => add(row, initial + i));
      if (changed) {
        tail.parsed = tail.parser.finish();
        const priced = {};
        tail.cost = hostCost(tail.parsed.events.filter((e) => e.k === 'usage'), options.prices, priced); tail.costPartial = priced.partial;
      }
      tail.end = end;
      parsed = tail.parsed; cost = tail.cost; costPartial = !!tail.costPartial;
      transcripts.delete(file); transcripts.set(file, tail);
      if (transcripts.size > 3) { const old = transcripts.keys().next().value; transcripts.delete(old); recentWindows.delete(old); }
    }
    const m = parsed.meta;
    if (m.started_at == null) return data;
    // 同一个对话先前的对话记录（桌面版重启、恢复前）里 Claude Code 的用量也算进来，和星图那一行一致；新记录开头抄过来的消息按 id 去重
    let usage = m.usage;
    if (session && params.replay == null && options.priorUsage) {
      const seen = new Set(parsed.events.filter((e) => e.k === 'usage' && e.messageId).map((e) => e.messageId));
      const extra = options.priorUsage(data.scope.value).filter((e) => !seen.has(e.id));
      if (extra.length) {
        const priced = {}, more = hostCost(extra, options.prices, priced);
        usage = { ...m.usage };
        for (const e of extra) for (const [key, name] of [['in', 'input'], ['cached', 'cached'], ['cache_write', 'cache_write'], ['out', 'output']]) if (e.u[key] != null) usage[name] = (usage[name] ?? 0) + e.u[key];
        cost = cost == null && more == null ? null : (cost ?? 0) + (more ?? 0); costPartial ||= !!priced.partial || more == null;
      }
    }
    data.runs.push({ id: 'cc', lane: 'cc', kind: 'host', agent: 'claude code', agent_type: 'host', model: m.model, session: m.session || path.basename(file, '.jsonl'), title: m.title, cwd: m.cwd,
      status: params.replay != null || now - Math.max(m.latest_at, tail.appendedAt ?? -Infinity) < 90000 ? 'running' : 'idle', started_at: m.started_at, ended_at: null, usage, ...costFields(cost, cost == null ? 'unknown' : 'api_price'), ...(costPartial && cost != null ? { cost_partial: true } : {}) });
    append(data.events, parsed.events); data.versions.cc = `${file}:${tail.version}`; data.revisions.cc = '';
    data.hostEnd = session ? m.latest_at : end; return data;
  };
  let names = [], nameSet = new Set(), dirty = true, watcher = null, scannedAt = -Infinity;
  const scan = (now = options.now?.() ?? Date.now()) => {
    if (!dirty) return;
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse(); nameSet = new Set(names); dirty = false; scannedAt = now; }
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
    // 只有读成功才记下签名：一时读不到（被占用、写到一半）时沿用上一份，下次再读，不把"读不到"缓存下来
    if (entry?.signature !== `${st.size}:${st.mtimeMs}`) {
      const value = json(file);
      if (value) { entry = { signature: `${st.size}:${st.mtimeMs}`, value }; plans.set(id, entry); }
    }
    const p = entry?.value;
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
  const dataOf = (selected, now, onEvent) => {
    const runs = [], events = [], versions = {}, revisions = {};
    for (const run of selected.runs) {
      run.lane = laneOf(run, cache); readTail(run, now, onEvent && ((raw) => onEvent(run, raw)));
      const message = runMessage(run, run.lane, options.prices, cache); runs.push(message); versions[run.id] = run.tail.version;
      revisions[run.id] = `${run.signatures.meta}:${run.signatures.result}`;
      const history = [{ run: run.id, lane: run.lane, ts: message.started_at, k: 'start', t: clip(message.kind) }, ...run.tail.events.map((e) => ({ ...e, lane: run.lane }))];
      if (message.ended_at != null) history.push({ run: run.id, lane: run.lane, ts: message.ended_at, k: 'end', t: clip(message.status) });
      append(history, verdictEvents(run)); append(events, history);
    }
    for (const id of new Set([...selected.runs.map((r) => r.meta.plan), ...(selected.queued || []).map((q) => q.plan)].filter(Boolean))) { const ev = planEvent(id); if (ev) events.push(ev); }
    return { scope: selected.scope, runs, events, versions, revisions, prices: options.prices };
  };
  return {
    replay(files, now, beforeRead, onTranscript, onEvent) {
      if (!files.size) { beforeRead([]); return new Map(); }
      scan();
      // 先只读归属元数据，体积检查通过后才打开正文、结果和事件流。
      for (const id of names) {
        const dir = path.join(root, id), file = path.join(dir, 'meta.json'), st = stat(file), meta = st && json(file);
        if (meta) cache.set(id, { id, dir, meta, signatures: { meta: `${st.size}:${st.mtimeMs}` }, tail: newTail() });
      }
      const selected = [...cache.values()].filter((r) => files.has(r.meta.claude_session));
      beforeRead(selected);
      const bySession = new Map();
      for (const run of selected) {
        update(run.id);
        const id = run.meta.claude_session;
        if (!bySession.has(id)) bySession.set(id, []);
        bySession.get(id).push(run);
      }
      const data = new Map();
      for (const [id, file] of files) {
        const records = readLines(file, newTail()).lines;
        if (!onTranscript(id, file, records)) continue;
        const available = [...(bySession.get(id) || [])], seen = new Set(available.map((r) => r.id));
        // 祖先只为保持原来的车道归属补入，不为每个对话再遍历全部任务。
        for (const run of available) {
          const parent = cache.get(run.meta.parent);
          if (parent && !seen.has(parent.id)) { seen.add(parent.id); available.push(parent); }
        }
        const params = { session: id, replay: id }, scope = selectScope(available, params, now);
        data.set(id, addClaude(dataOf(scope, now, onEvent), scope.runs, params, now, { file, records }));
        for (const run of scope.runs) delete run.activity;
      }
      return data;
    },
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
      dirty = true; scan(now);
      return recentNames(now, 24).map((id) => update(id, false)).some((r) => r.meta?.status === 'running' && r.meta.participant !== 'host' && ms(r.meta.started_at) >= now - 86400000);
    },
    read(params, now = options.now?.() ?? Date.now()) {
      // 同一个对话先前的会话 id 派出的任务也算这个对话的（options.conversation 由服务端按桌面版的元数据给出）
      if (params.session != null && params.replay == null && options.conversation) params = { ...params, sessions: options.conversation(params.session) };
      // watch 可能漏掉根目录通知；有客户端时也至多十秒重列一次。
      if (!watcher || now - scannedAt >= 10000) dirty = true;
      scan(now);
      const recent = params.session == null && params.group == null && params.run == null && params.replay == null;
      const candidates = recent ? recentNames(now, 48) : names;
      const candidateSet = recent ? new Set(candidates) : nameSet;
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
      let available = () => [...cache.values()].filter((r) => nameSet.has(r.id) && (!recent || candidateSet.has(r.id)));
      let selected = selectScope(available(), params, now);
      const updated = new Set();
      for (const run of selected.runs) {
        update(run.id);
        updated.add(run.id);
        let parent = run.meta.parent;
        const seen = new Set([run.id]);
        while (parent && nameSet.has(parent) && !seen.has(parent)) {
          seen.add(parent); const ancestor = update(parent, false); parent = ancestor.meta?.parent;
        }
      }
      // 最近范围的扫描限于 48 小时，已选车道的祖先按 parent 定点补读。
      const roots = new Set(selected.runs.map((r) => laneOf(r, cache)));
      if (recent) available = () => [...cache.values()].filter((r) => nameSet.has(r.id) && (candidateSet.has(r.id) || roots.has(laneOf(r, cache))));
      selected = selectScope(available(), params, now);
      for (const run of selected.runs) if (!updated.has(run.id)) update(run.id);
      // 一个记录根目录每轮只扫一次票据、批量核验一次进程，再按组和会话分配。
      const waiting = params.replay != null ? [] : queuedRuns(null, root);
      const newestTicket = [...waiting].filter((q) => params.group == null || q.group === params.group).sort((a, b) => ms(b.queued_at) - ms(a.queued_at))[0];
      const session = params.session ?? options.session ?? (selected.runs.length ? selected.runs[0].meta.claude_session
        : newestTicket ? newestTicket.claude_session : CLAUDE_SESSION);
      selected.queued = waiting.filter((q) => selected.scope.kind === 'session' ? (params.sessions ?? new Set([selected.scope.value])).has(q.claude_session)
        : selected.scope.kind === 'group' ? q.group === selected.scope.value && (q.claude_session ?? null) === (session ?? null)
          : selected.scope.kind === 'run' ? selected.runs.some((r) => r.meta.group === q.group && (r.meta.claude_session ?? null) === (q.claude_session ?? null)) : true)
        .filter((q) => !queuedStarted(q, selected.runs)).map((q) => ({ agent: clip(q.agent), model: clip(q.model), title: clip(q.title),
          group: clip(q.group), session: clip(q.claude_session), plan: clip(q.plan), seat: q.seat, queued_at: ms(q.queued_at), position: q.position, sequence: q.sequence }));
      // 协议说最多 30 条：多出来的只报条数（页面写"还有 N 个在排队"），不把整条队列推给每个页面
      const queuedTotal = selected.queued.length;
      selected.queued = selected.queued.slice(0, 30);
      const data = addClaude(dataOf(selected, now), selected.runs, params, now);
      const active = new Set(current(selected.runs).map((r) => r.id));
      for (const run of data.runs) if (active.has(run.id) && run.group != null) run.dispatch_queue = selected.queued.filter((q) => q.group === run.group && (q.session ?? null) === (run.session ?? null));
      // 无席位启动时也有组面板；快照走现有 ev 通道，网页不必伪造一条 run。
      const queueKey = JSON.stringify(selected.scope);
      if (selected.queued.length) queueScopes.add(queueKey);
      if (params.replay == null && queueScopes.has(queueKey)) data.events.push({ run: 'dispatch_queue', lane: 'dispatch_queue', ts: now, k: 'dispatch_queue', tickets: selected.queued, total: queuedTotal });
      return data;
    },
  };
}
