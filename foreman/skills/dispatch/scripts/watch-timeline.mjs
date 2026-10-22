// 时间线：左边一列是时间，模型说的话是节点（◆），命令、读文件、搜索、改动挂在竖线下面。
// 实时画面、打开组里的某一席和直接输出共用这一份：条目按宽度排版，窗口变了重新排；
// 还在变的条目（正在跑的命令、折叠行、连着改的文件）直接输出时等它定下来再写。
import fs from 'node:fs';
import path from 'node:path';
import { RECONNECT, oneLine, plainCommand, needsDecision, isReconnect, textWidth, fitWidth, wrapWidth } from './util.mjs';
import { D, C, termCols, visibleWidth, clock, outcomeStyle, changedFor, usageLine, commandAction, foldText, thoughtLine } from './format.mjs';
import { resultValid } from './records.mjs';

const TIME_W = 6; // "00:41 "
const inner = (W) => Math.max(8, W - 1 - TIME_W - 2);
const rail = () => `${' '.repeat(TIME_W)}${C.dim('│')} `;
const hhmm = (t) => (t ? new Date(t).toTimeString().slice(0, 5) : '     ');
const node = (t, mark) => `${C.dim(hhmm(t))} ${mark} `;
// 没搜到时 rg、grep、findstr 也以 1 退出，写成"没搜到"，不算失败
const SEARCH_COMMAND = /^\s*(rg|grep|egrep|fgrep|findstr|git\s+grep|Select-String)\b/i;
const MAX_ACTIONS = 3; // 两句话之间的动作只显示前几条，其余折叠成一行
const FILE_MARKS = { update: '✎', add: '+', delete: '−' };

// 成功的任务不再列出临时的重连提示；旧记录把它记成了错误
const realErrors = (r, ok) => (r?.errors || []).filter((e) => !(ok && isReconnect(e)));
// 结果里没有用时的旧记录，按元数据的开始和结束时间算
const durationOf = (r, m) => r?.duration_s ?? (Date.parse(m?.ended_at) - Date.parse(m?.started_at)) / 1000;

function reviewConclusion(report) {
  if (!D.watchReview[report?.verdict]) return null;
  const findings = report.findings || [];
  const parts = ['high', 'medium', 'low'].map((severity) => {
    const n = findings.filter((f) => f.severity === severity).length;
    return n ? `${D.severityNames[severity]} ${n}` : null;
  }).filter(Boolean).join(' · ');
  return D.watchReview[report.verdict](findings.length, parts);
}

// 结束后的状态：记号和状态词上色，后面的用时（和运行中一样的时钟）、改动、材料变了的提醒用暗色
function finishedParts(o, durationS, changed, stale) {
  const { mark, color, word } = outcomeStyle(o);
  const tail = [Number.isFinite(durationS) ? clock(durationS * 1000) : '', changed, stale && D.watchStale].filter(Boolean);
  const rest = tail.length ? C.dim(` ${D.dots(tail)}`) : '';
  return { mark, color, word, rest, line: () => C.bold(color(`${mark} ${word}`)) + rest };
}

// 运行中的状态：记号、颜色和右侧的 [状态词, 时钟]。API 协作方写思考中、回答中、排队中，从发出请求算起；排队用黄色
function liveStatus(meta, api, now = Date.now()) {
  if (api.queued) return { mark: '⋯', color: C.yellow, right: [D.apiPhases.queued, clock(now - Date.parse(api.req))] };
  if (api.req) return { mark: '●', color: C.cyan, right: [D.apiPhases[api.answering ? 'answering' : 'thinking'], clock(now - Date.parse(api.req))] };
  return { mark: '●', color: C.cyan, right: [D.statusName('running'), clock(now - Date.parse(meta.started_at))] };
}

// 从 events.jsonl 增量读取，每读到一个事件调用一次 onEvent；返回的函数每次调用读新写进来的部分
function eventReader(dir, onEvent) {
  const file = path.join(dir, 'events.jsonl');
  const decoder = new TextDecoder('utf-8');
  let offset = 0;
  let buf = '';
  return () => {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size <= offset) return;
    const chunk = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, chunk, 0, chunk.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; } // 非 JSON 的行
      onEvent(ev);
    }
  };
}

function createTimeline(meta, rel, { stream = false, write = (l) => process.stdout.write(`${l}\n`) } = {}) {
  let live = false;
  const at = (ts) => ts || (live ? Date.now() : null); // 旧记录的事件没有时间，实时跟踪时用收到的时间
  const entries = [];
  let written = 0;
  const linesOf = (e, W) => {
    if (e.width !== W) { e.lines = e.render(W, e); e.width = W; }
    return e.lines;
  };
  const flush = () => {
    if (!stream) return;
    while (written < entries.length && !entries[written].open) {
      for (const l of linesOf(entries[written], termCols())) write(l);
      written++;
    }
  };
  const add = (render, extra = {}) => {
    const e = { render, open: false, width: null, lines: null, ...extra };
    entries.push(e);
    flush();
    return e;
  };
  const close = (e) => { if (e?.open) { e.open = false; e.width = null; flush(); } };

  // 一个节点：第一行带时间和记号，其余行接在竖线后面；篇幅超过 maxLines 行的折叠
  const say = (ts, mark, text, maxLines = 20) => {
    closeFiles();
    const t = at(ts);
    return add((W) => {
      const lines = wrapWidth(String(text).trim(), inner(W));
      const out = lines.slice(0, maxLines).map((l, i) => (i === 0 ? node(t, mark) : rail()) + l);
      if (lines.length > maxLines) out.push(rail() + C.dim(D.watchMoreLines(lines.length - maxLines)));
      return out;
    });
  };
  // 挂在竖线下的一行：动作默认用暗色，超长截断；行尾可以带一个短标记（失败、没搜到），条目定下来以后才写
  const subLine = (W, e) => {
    const markW = e.mark ? textWidth(e.mark[0]) + 1 : 0;
    // 窗口太窄、放不下文字和行尾标记时，只留文字
    const tag = e.tag && inner(W) - 2 - markW - visibleWidth(e.tag) - 2 >= 4 ? `  ${e.tag}` : '';
    const room = Math.max(4, inner(W) - 2 - visibleWidth(tag) - markW);
    const text = fitWidth(e.text, room);
    const gap = tag ? ' '.repeat(Math.max(0, room - textWidth(text))) : '';
    return [`${rail()}  ${e.mark ? `${e.mark[1](e.mark[0])} ` : ''}${(e.color || C.dim)(text)}${gap}${tag}`];
  };
  const sub = (text, extra = {}) => { closeFiles(); return add(subLine, { text, ...extra }); };

  // 折叠：一段动作只显示前几条，其余并成一行按种类计数；失败的拿出来单独显示，之后再折叠的另起一行
  let shownActions = 0;
  let foldLine = null;
  const actions = new Map(); // 工具调用 id → { action, entry }
  const fold = (id, kind) => {
    closeFiles();
    if (!foldLine) {
      foldLine = add((W, e) => (e.ids.size ? [`${rail()}  ${C.dim(fitWidth(foldText(countOf(e.ids)), inner(W) - 2))}`] : []), { open: true, ids: new Map() });
    }
    foldLine.ids.set(id, kind);
    foldLine.width = null;
    actions.get(id).fold = foldLine;
  };
  const countOf = (ids) => {
    const counts = {};
    for (const kind of ids.values()) counts[kind] = (counts[kind] || 0) + 1;
    return counts;
  };
  const flushFolded = () => { close(foldLine); foldLine = null; };

  // 连着改的文件并成一条：按改动种类各一行，一个文件写路径，几个文件写个数和文件名
  let files = null;
  const closeFiles = () => { close(files); files = null; };
  const addFile = (kind, file) => {
    if (!files) {
      flushFolded();
      files = add((W, e) => Object.entries(e.byKind).map(([k, list]) => {
        const mark = FILE_MARKS[k] || '✎';
        const text = list.length === 1 ? `${mark} ${list[0]}` : `${mark} ${D.watchFiles(list.length, list.map((f) => path.basename(f)).join(' '))}`;
        return `${rail()}  ${C.dim(fitWidth(text, inner(W) - 2))}`;
      }), { open: true, byKind: {} });
    }
    const list = (files.byKind[kind] ||= []);
    if (!list.includes(file)) list.push(file);
    files.width = null;
  };
  // 新的一段开始时，还没完成的命令也定下来：直接输出时不让它一直压着后面的内容，晚到的失败另写一行
  const running = new Set();
  const newBlock = () => {
    flushFolded();
    closeFiles();
    for (const e of running) close(e);
    running.clear();
    shownActions = 0;
  };

  // 实时画面和组视图要用的状态：最近说的一段话和最近一条思考摘要（seq 记先后），最近的动作和按种类的计数，
  // API 的请求、排队和回答进度
  const api = { req: null, begin: null, chars: 0, answerChars: 0, answering: false, queued: false };
  const state = { speech: null, thought: null, recent: [], kinds: {}, api };
  let seq = 0;
  const recent = (kind, text, extra = {}) => {
    const a = { kind, text, ...extra };
    state.recent.push(a);
    state.kinds[kind] = (state.kinds[kind] || 0) + 1;
    if (state.recent.length > 60) state.recent.splice(0, state.recent.length - 60);
    return a;
  };
  let lastPlan = '';

  const showApi = (ev) => {
    if (ev.type === 'api.request') {
      Object.assign(api, { req: ev.ts, begin: null, chars: 0, answerChars: 0, answering: false, queued: false });
      say(ev.ts, '◆', D.watchApiRequest(ev.model, ev.effort, ev.attempt));
    } else if (ev.type === 'api.queued') {
      // 服务繁忙，请求在排队：只在第一次记一笔，顶上的状态写已经等了多久
      if (!api.queued) say(ev.ts, C.yellow('⋯'), D.watchApiQueued, 1);
      api.queued = true;
    } else if ((ev.type === 'api.reasoning' || ev.type === 'api.content') && api.queued) {
      api.queued = false;
      api.begin = ev.ts;
      say(ev.ts, '◆', D.watchApiDequeued(D.duration((Date.parse(ev.ts) - Date.parse(api.req)) / 1000)));
      showApi(ev);
    } else if (ev.type === 'api.reasoning') {
      api.chars = ev.total_chars;
    } else if (ev.type === 'api.content') {
      // 回答是 JSON 报告，不逐字显示；开始回答时记一笔思考了多久
      if (!api.answering) {
        api.answering = true;
        const thought = (Date.parse(ev.ts) - Date.parse(api.begin || api.req)) / 1000; // 排过队的从开始处理算起
        say(ev.ts, '◆', api.chars ? D.watchApiThought(D.duration(thought), api.chars.toLocaleString('en-US')) : D.watchApiAnswering);
      }
      api.answerChars = ev.total_chars;
    } else if (ev.type === 'api.retry') say(ev.ts, C.yellow('⚠'), recent('other', D.watchApiRetry(ev.reason, ev.wait_s), { mark: ['⚠', C.yellow] }).text, 3);
    else if (ev.type === 'api.repair') say(ev.ts, C.yellow('⚠'), recent('other', D.watchApiRepair(D.list(ev.errors)), { mark: ['⚠', C.yellow] }).text, 3);
    else if (ev.type === 'api.error' && ev.kind === 'cancelled') { api.queued = false; /* 用户终止，结尾那行会写明 */ }
    else if (ev.type === 'api.error' && ev.kind === 'busy') { api.queued = false; say(ev.ts, C.yellow('⚠'), D.watchApiDropped(D.duration(ev.waited_s || 0)), 2); }
    else if (ev.type === 'api.error') say(ev.ts, C.red('✗'), oneLine(ev.message), 3);
  };

  const show = (ev) => {
    if (ev.type?.startsWith('api.')) { showApi(ev); return; }
    // 开工前拍快照：大目录要几分钟，写出来免得画面一片空白
    if (ev.type === 'foreman.snapshot') {
      state.snapshotting = ev.phase === 'start';
      const text = ev.phase === 'start' ? D.watchSnapshotStart : D.watchSnapshotDone(D.duration(ev.seconds ?? 0));
      recent('other', text);
      say(ev.ts, C.dim('⋯'), text, 2);
      return;
    }
    state.snapshotting = false;
    const it = ev.item || {};
    // 只有完成事件的工具调用，也要补出命令行供时间线显示。
    if (ev.type === 'item.completed' && it.type === 'command_execution' && !actions.has(it.id)) show({ ...ev, type: 'item.started' });
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      const msg = ev.error?.message || ev.message || '';
      const re = RECONNECT.exec(msg);
      const mark = re ? ['⚠', C.yellow] : ['✗', C.red];
      recent('other', re ? D.watchReconnect(re[1], re[2]) : oneLine(msg), { mark });
      if (re) sub(D.watchReconnect(re[1], re[2]), { mark });
      else { newBlock(); say(ev.ts, C.red('✗'), oneLine(msg), 3); }
    } else if (ev.type === 'image.generated') {
      flushFolded();
      sub(recent('image', `▣ ${D.watchImage(path.basename(ev.path))}`).text);
    } else if (ev.type === 'image.viewed') {
      flushFolded();
      sub(recent('image', `◉ ${D.watchImageViewed(path.basename(ev.path))}`).text);
    } else if (ev.type === 'item.started' && it.type === 'command_execution') {
      const action = commandAction(it);
      actions.set(it.id, { action, recent: recent(action.kind, action.text) });
      if (shownActions < MAX_ACTIONS) {
        const entry = sub(action.text, { open: true });
        actions.get(it.id).entry = entry;
        running.add(entry);
        shownActions++;
      } else fold(it.id, action.kind);
    } else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message') {
        const t = it.text.trim();
        if (t.startsWith('{')) { try { JSON.parse(t); return; } catch { /* 普通消息 */ } } // 最终报告在结束时单独显示
        newBlock();
        state.speech = { text: t, seq: ++seq };
        say(ev.ts, '◆', t);
      } else if (it.type === 'reasoning') {
        const line = thoughtLine(it.text);
        if (line) state.thought = { text: line, seq: ++seq };
      } else if (it.type === 'command_execution') {
        const rec = actions.get(it.id);
        const failed = it.exit_code !== 0 && it.exit_code != null;
        const noMatch = failed && it.exit_code === 1 && rec.action.kind === 'command' && SEARCH_COMMAND.test(plainCommand(it.command))
          && !String(it.aggregated_output || '').trim();
        const tag = noMatch ? C.dim(D.watchNoMatch) : failed ? C.red(`✗ ${rec.action.kind === 'command' ? D.watchExitTag(it.exit_code) : D.statusName('failed')}`) : null;
        rec.recent.tag = tag;
        // 还没定下来的命令（直接输出时还没写出去）把标记写在行尾；已经写出去的，失败时另写一行
        if (rec.entry && (rec.entry.open || !stream)) {
          rec.entry.tag = tag;
          rec.entry.width = null;
          running.delete(rec.entry);
          close(rec.entry);
          return;
        }
        if (!failed || noMatch) return;
        // 折叠里的命令失败了：折叠行还没定下来就从里面拿出来；已经定下来的不改计数，免得直接输出和画面上的数不一样
        if (rec.fold?.open) {
          rec.fold.ids.delete(it.id);
          rec.fold.width = null;
          flushFolded();
        }
        sub(rec.action.text, { tag });
      } else if (it.type === 'file_change') {
        for (const c of it.changes || []) {
          addFile(c.kind, rel(c.path));
          recent('edit', `${FILE_MARKS[c.kind] || '✎'} ${rel(c.path)}`);
        }
      } else if (it.type === 'todo_list') {
        const items = it.items || [];
        const done = items.filter((x) => x.completed).length;
        const text = D.watchPlan(done, items.length, items.find((x) => !x.completed)?.text);
        if (text === lastPlan) return;
        lastPlan = text;
        recent('other', `◇ ${text}`, { color: (x) => x });
        newBlock();
        say(ev.ts, '◇', text, 2);
      } else if (it.type === 'web_search') {
        const q = oneLine(it.query);
        if (!q) return;
        flushFolded();
        sub(recent('search', `◎ ${q}`).text);
      } else if (it.type === 'error' && !/^Under-development features enabled/.test(it.message)) {
        recent('other', oneLine(it.message), { mark: ['⚠', C.yellow] });
        newBlock();
        say(ev.ts, C.yellow('⚠'), oneLine(it.message), 3);
      }
    }
  };

  // 结束：结论按宽度折行写全，不限篇幅（画面里能翻看，直接输出时留在终端里）
  const finish = (r, m) => {
    newBlock();
    for (const e of entries) close(e);
    const para = (text, indent) => add((W) => wrapWidth(String(text).trim(), Math.max(8, W - 1 - textWidth(indent))).map((l) => indent + l));
    const line = (text) => add(() => [text]);
    // 结尾那一行：└ 记号 状态词 时钟 · 改动 · 提醒。记号和状态词上色，其余暗色；放不下时在" · "处折到下一行
    const ending = (t, mark, color, head, rest = []) => add((W) => {
      const room = Math.max(8, W - 1 - TIME_W - 2);
      const first = fitWidth(`${mark} ${head}`, room);
      const lines = [first];
      rest.forEach((part, i) => {
        const sep = i === 0 ? ' ' : ' · ';
        if (textWidth(lines.at(-1) + sep + part) <= room) lines[lines.length - 1] += sep + part;
        else lines.push(...wrapWidth(part, room));
      });
      return lines.map((l, i) => (i ? ' '.repeat(TIME_W + 2) + C.dim(l) : node(t, C.dim('└')) + C.bold(color(first)) + C.dim(l.slice(first.length))));
    });
    line(rail().trimEnd());
    if (!r) {
      ending(m?.ended_at, '✗', C.red, m?.status === 'running' ? D.watchInterrupted : D.watchEnded(m?.status));
      return null;
    }
    const o = resultOutcome(r);
    if (m?.participant === 'host') ending(m.submitted_at, '✔', C.green, D.watchAnswerSubmitted(m.round ?? 1));
    else {
      const { mark, color, word } = outcomeStyle(o);
      const sec = durationOf(r, m);
      ending(m?.ended_at, mark, color, word, [Number.isFinite(sec) ? clock(sec * 1000) : '', changedFor(r, m), r.stale === true && D.watchStale].filter(Boolean));
    }
    const usage = usageLine(r, m);
    if (usage) add((W) => wrapWidth(usage, Math.max(8, W - 1 - TIME_W - 2)).map((l) => ' '.repeat(TIME_W + 2) + C.dim(l)));
    const conclusion = reviewConclusion(r.report);
    if (conclusion) {
      line(''); para(conclusion, '  ');
      for (const f of r.report.findings || []) para(D.watchFinding(f, D.severityNames[f.severity]), '  ');
      if (r.report.unverified?.length) {
        line(''); line(`  ${C.bold(D.watchUnverified)}`);
        for (const x of r.report.unverified) para(`· ${x}`, '  ');
      }
    }
    const summary = r.report?.summary || r.report?.position;
    if (summary) { line(''); para(summary, '  '); }
    const issues = r.report?.open_issues || r.report?.open_questions || [];
    if (issues.length) {
      line(''); line(`  ${C.bold(D.watchOpenIssues)}`);
      for (const x of issues) para(`· ${x}`, '  ');
    }
    const asks = r.questions?.filter(needsDecision) ?? r.report?.decision_requests ?? [];
    if (asks.length) {
      line(''); line(`  ${C.bold(D.watchDecisions)}`);
      for (const d of asks) {
        const prefix = d.source === 'permission_denied' ? D.watchDeniedPrefix : d.source === 'input_prompt' ? D.watchInputPromptPrefix : '';
        para(`· ${prefix}${d.question}`, '  ');
        for (const opt of d.options || []) para(`- ${opt}`, '    ');
        if (d.recommendation) para(D.watchRecommendation(d.recommendation), '    ');
      }
    }
    const midRun = (r.questions || []).filter((q) => q.source === 'asked_mid_run');
    if (midRun.length) {
      line(''); line(`  ${C.bold(D.watchAskedMidRun)}`);
      for (const q of midRun) para(`· ${oneLine(q.question)}`, '  ');
    }
    // 报错：先按纯文字折行，再给行首的记号上色，免得颜色码算进宽度
    const [mark, color] = r.status === 'needs_input' ? ['?', C.yellow] : ['✗', C.red];
    for (const e of realErrors(r, o.ok)) {
      add((W) => wrapWidth(`${mark} ${oneLine(e)}`, Math.max(8, W - 5)).map((l, i) => `  ${i ? `  ${l}` : color(mark) + l.slice(mark.length)}`));
    }
    return o;
  };

  return {
    show, finish, state,
    goLive: () => { live = true; },
    lines: (W) => entries.flatMap((e) => linesOf(e, W)),
  };
}

// 只有结果文件时的状态（时间线结尾和组视图）：和 records.mjs 的 runOutcome 判断一致
function resultOutcome(r) {
  const blocked = r.status === 'needs_input' || r.status === 'done' && (!!r.needs_decision || r.report?.status === 'blocked');
  const valid = resultValid(r, r);
  return { running: false, status: r.status, result: r, blocked, valid, ok: !blocked && valid && r.status === 'done' && (!r.report?.status || r.report.status === 'completed') };
}

export { createTimeline, reviewConclusion, resultOutcome, realErrors, durationOf, finishedParts, liveStatus, eventReader, hhmm };
