// 详细事件、时间线、组视图和终端实时画面，只读取统一记录。
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_ROOT, requestCancel, listRuns, findRun, readMeta, isRunning, runEnd, runOutcome, groupTally, groupRuns } from './records.mjs';
import { describePlans } from './plan.mjs';
import { M, die, sleep, clip, oneLine, plainCommand, RECONNECT, isReconnect, modelOf, agentTypeOf, needsDecision, charWidth, textWidth, fitWidth, wrapWidth } from './util.mjs';
import { D, TEST_SCREEN, termCols, termRows, C, plain, visibleWidth, shortModel, fullModel, modelLabel, clock, took, outcomeStyle, changedFor,
  usageLine, commandAction, foldText, thoughtLine, paintPlanWord, replayCommand } from './format.mjs';
import { avatarFor, introScene, playIntro } from './watch-intro.mjs';

// 能画实时画面的终端：输出到终端，而且不是 TERM=dumb 这种不认光标控制的终端（测试用 FOREMAN_TEST_SCREEN 模拟）
const liveCapable = () => (process.stdout.isTTY && process.env.TERM !== 'dumb') || !!TEST_SCREEN;
const hhmm = (t) => (t ? new Date(t).toTimeString().slice(0, 5) : '     ');
// 成功的任务不再列出临时的重连提示；旧记录把它记成了错误
const realErrors = (r, ok) => (r?.errors || []).filter((e) => !(ok && isReconnect(e)));
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// 运行中的状态词（运行中、思考中、排队中……）用青色，后面的计数和提示用暗色
const paintLead = (text, word, color = C.cyan) => (word && text.startsWith(word) ? color(word) + C.dim(text.slice(word.length)) : C.dim(text));
// 结束后的状态：记号和状态词上色，后面的用时、改动和审查期间材料变了的提醒用暗色（和组面板标题行右侧一致）
function finishedParts(o, durationS, changed, stale) {
  const { mark, color, word } = outcomeStyle(o);
  const tail = [took(durationS), changed, stale && D.watchStale].filter(Boolean).join(' · ');
  const rest = tail ? C.dim(` · ${tail}`) : '';
  return { mark: color(mark), word: color(word), rest, line: (bold = false) => (bold ? C.bold : plain)(color(`${mark} ${word}`)) + rest };
}
// 结果里没有用时的旧记录，按元数据的开始和结束时间算
const durationOf = (r, m) => r.duration_s ?? (Date.parse(m?.ended_at) - Date.parse(m?.started_at)) / 1000;
// 只有结果文件时的状态（时间线和详细模式的结尾）：和 records.mjs 的 runOutcome 判断一致
function resultOutcome(r) {
  const blocked = r.status === 'needs_input' || r.status === 'done' && (!!r.needs_decision || r.report?.status === 'blocked');
  return { running: false, status: r.status, result: r, blocked, ok: !blocked && r.status === 'done' && (!r.report?.status || r.report.status === 'completed') };
}

// 标题行用原词写模式和等级；图像任务用格子和路线代替等级，时间线和详细模式共用。
function headerLines(meta, id, dir) {
  const lines = D.watchHeaderLines(meta.mode, meta.title || id, meta.level, meta.cwd, dir, fullModel(meta));
  if (meta.module === 'image') lines[0] = D.watchImageHead(meta.mode === 'resume' ? 'resume' : 'image', meta.title || id, meta.cell, '①②③④'[meta.route - 1]);
  return lines;
}

function reviewConclusion(report) {
  if (!D.watchReview[report?.verdict]) return null;
  const findings = report.findings || [];
  const parts = ['high', 'medium', 'low'].map((severity) => {
    const n = findings.filter((f) => f.severity === severity).length;
    return n ? `${D.severityNames[severity]} ${n}` : null;
  }).filter(Boolean).join(' · ');
  return D.watchReview[report.verdict](findings.length, parts);
}

async function pickWatchRun(ref) {
  if (ref) return findRun(ref);
  // 刚派活时任务可能还没登记，等一会儿；仍没有就显示最近一次。
  for (let waited = 0; ; waited += 500) {
    const ids = listRuns();
    const running = ids.find((id) => isRunning(readMeta(path.join(RUNS_ROOT, id))));
    if (running) return findRun(running);
    if (waited >= 15000) {
      if (!ids[0]) die(M.noRuns);
      process.stdout.write(`${D.watchFallback}\n`);
      return findRun(ids[0]);
    }
    if (waited === 0) process.stdout.write(`${D.watchWaiting}\n`);
    await sleep(500);
  }
}

// 详细模式（--verbose）：每个事件一行，带时间戳，包括思考过程、命令输出和 token 用量。
function verboseRenderer(meta, rel) {
  let live = false;
  const commands = new Set();
  const out = (sym, text, ts) => process.stdout.write(`${ts ? new Date(ts).toTimeString().slice(0, 8) : live ? new Date().toTimeString().slice(0, 8) : '        '} ${sym} ${text}\n`);
  const header = (id, dir) => {
    const [first, ...rest] = headerLines(meta, id, dir);
    process.stdout.write(`\n${C.bold(`${modelLabel(meta)} · ${first}`)}\n${C.dim(rest.join('\n'))}\n\n`);
  };
  const show = (ev) => {
    const it = ev.item || {};
    const o = (sym, text) => out(sym, text, ev.ts);
    if (ev.type === 'item.completed' && it.type === 'command_execution' && !commands.has(it.id)) show({ ...ev, type: 'item.started' });
    if (ev.type === 'thread.started') o('●', D.watchSession(ev.thread_id));
    else if (ev.type === 'turn.failed') o('✗', D.watchTurnFailed(ev.error?.message || ''));
    else if (ev.type === 'error') {
      const re = RECONNECT.exec(ev.message || '');
      o('⚠', re ? D.watchReconnect(re[1], re[2]) : clip(oneLine(ev.message), 300));
    } else if (ev.type === 'turn.completed' && ev.usage) {
      o('Σ', D.watchTokens(ev.usage));
    } else if (ev.type === 'image.generated') {
      o('▣', D.watchImage(ev.path));
    } else if (ev.type === 'image.viewed') {
      o('◉', D.watchImageViewed(ev.path));
    } else if (ev.type === 'item.started' && it.type === 'command_execution') {
      commands.add(it.id);
      const action = commandAction(it);
      o(action.kind === 'command' ? '▶' : '·', clip(action.kind === 'command' ? oneLine(plainCommand(it.command)) : action.text, 240));
    } else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message') {
        const t = it.text.trim();
        let report = null;
        if (t.startsWith('{')) try { report = JSON.parse(t); } catch { /* 普通消息 */ }
        if (report?.verdict) o('■', reviewConclusion(report));
        else if (report?.position) o('■', D.watchOpinion(clip(oneLine(report.position), 400)));
        else if (report?.status) o('■', D.watchReport(D.statusName(report.status), clip(oneLine(report.summary), 300)));
        else o('💬', clip(oneLine(t), 600));
      } else if (it.type === 'reasoning') {
        o('…', clip(oneLine(it.text), 200));
      } else if (it.type === 'command_execution') {
        commands.delete(it.id);
        const lines = String(it.aggregated_output || '').replace(/\r/g, '').split('\n').map((x) => x.trimEnd()).filter(Boolean);
        o(it.exit_code === 0 ? '✓' : '✗', D.watchExit(it.exit_code, lines.length ? clip(lines.slice(-3).join(' ⏎ '), 240) : ''));
      } else if (it.type === 'file_change') {
        for (const c of it.changes || []) o('✎', `${D.fileKinds[c.kind] || c.kind} ${rel(c.path)}`);
      } else if (it.type === 'error') {
        if (!/^Under-development features enabled/.test(it.message)) o('⚠', clip(oneLine(it.message), 300));
      } else if (it.type === 'web_search') {
        if (oneLine(it.query)) o('◎', clip(oneLine(it.query), 200));
      } else if (it.type === 'todo_list') {
        o('☐', (it.items || []).map((x) => `${x.completed ? '✔' : '·'} ${x.text}`).join('   '));
      } else if (it.type) {
        o('•', it.type);
      }
    }
  };
  const finish = (r, m) => {
    if (r) {
      const f = finishedParts(resultOutcome(r), durationOf(r, m), changedFor(r, m), r.stale === true);
      out(f.mark, f.word + f.rest, m?.ended_at);
    }
    else out(C.red('✗'), m?.status === 'running' ? D.watchInterrupted : D.watchEnded(m?.status), m?.ended_at);
    const usage = usageLine(r, m);
    if (usage) out('Σ', usage, m?.ended_at);
  };
  return { header, show, finish, goLive: () => { live = true; } };
}

// API 协作方的详细模式：思考和回答的原文逐段输出
function apiVerboseRenderer(meta, rel) {
  const base = verboseRenderer(meta, rel);
  const show = (ev) => {
    if (!ev.type?.startsWith('api.')) return base.show(ev);
    const out = (text) => process.stdout.write(`${ev.ts ? new Date(ev.ts).toTimeString().slice(0, 8) : '        '} ${text}\n`);
    if (ev.type === 'api.request') out(D.watchApiRequest(ev.model, ev.effort, ev.attempt));
    else if (ev.type === 'api.reasoning' || ev.type === 'api.content') out(ev.text);
    else if (ev.type === 'api.queued') out(D.watchApiQueuedLive(clock(ev.waited_s * 1000)));
    else if (ev.type === 'api.retry') out(D.watchApiRetry(ev.reason, ev.wait_s));
    else if (ev.type === 'api.repair') out(D.watchApiRepair(D.list(ev.errors)));
    else if (ev.type === 'api.error') out(ev.message);
  };
  return { ...base, show };
}

// 实时画面：在终端的备用屏幕里整屏重画。关闭自动换行，超出窗口的部分直接截掉，不会折到下一行把画面挤乱；
// 每行先定位光标再写。窗口大小变化时清屏重画，停下来 0.2 秒后再补画一次：
// Windows 的 ConPTY 调整大小后会自己重绘一遍，可能盖掉刚画好的画面。
function liveScreen(render, { wheel = false } = {}) {
  let active = false;
  let timer = null;
  const draw = () => {
    if (!active) return;
    const rows = termRows();
    const lines = render(termCols(), rows).slice(0, rows);
    let out = '';
    lines.forEach((l, i) => { out += `\x1b[${i + 1};1H\x1b[2K${l}`; });
    if (lines.length < rows) out += `\x1b[${lines.length + 1};1H\x1b[J`;
    process.stdout.write(out);
  };
  const onResize = () => {
    process.stdout.write('\x1b[2J');
    draw();
    clearTimeout(timer);
    timer = setTimeout(draw, 200);
  };
  return {
    draw,
    start() {
      if (active) return;
      active = true;
      // 1049 备用屏幕，25 光标，7 自动换行，1007 让鼠标滚轮在备用屏幕里变成上下方向键
      process.stdout.write(`\x1b[?1049h\x1b[?25l\x1b[?7l${wheel ? '\x1b[?1007h' : ''}\x1b[2J`);
      process.stdout.on('resize', onResize);
      draw();
    },
    stop() {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      process.stdout.off('resize', onResize);
      process.stdout.write(`${wheel ? '\x1b[?1007l' : ''}\x1b[?7h\x1b[?25h\x1b[?1049l`);
    },
  };
}

// 启动动画只在新派出的对话第一次打开时放：输出到能画实时画面的终端、没设 NO_COLOR、
// 配置没关（dispatch.intro）、没加 --no-intro，而且有还在运行的、不是续接出来的任务（讨论第 2 轮、返工都不放）。
const LEAVE_SCREEN = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
const kindOf = (m) => m.kind || (m.mode === 'discuss' ? 'discuss' : m.mode === 'review' ? 'review' : 'exec');
const introWanted = (o, metas, loadCfg) => liveCapable() && !process.env.NO_COLOR && !o['no-intro']
  && metas.some((m) => isRunning(m) && !m.parent) && loadCfg(metas[0].cwd).dispatch.intro !== false;
const introOf = (m) => ({ key: avatarFor(m.model_name ?? m.model, agentTypeOf(m)), model: shortModel(modelOf(m)), who: modelLabel(m) });

// 把一段键盘输入拆成单个按键（方向键、翻页键是 ESC 开头的一串）
const splitKeys = (s) => s.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g) || [];

// 简洁模式（默认）：时间线。左边一列是时间，模型说的话是节点（◆），命令、读文件、搜索、改动挂在竖线下面，
// 失败的命令才显示输出。长段文字按宽度折行，接在竖线后面。
// 任务还在运行时，时间线画在备用屏幕里：最后一行是状态行（用时、命令数、改动数、计划进度），有思考摘要时
// 正文末尾跟一行最近一条思考的第一行；窗口大小变化时整屏按新宽度重新排版，可以用方向键和翻页键往回翻；
// 结束或退出查看时，把完整的时间线写进普通屏幕留作记录。任务已经结束时直接按当前宽度输出。
function timelineRenderer(meta, rel, { screen: useScreen = false, dir = null } = {}) {
  const TIME_W = 6; // "00:41 "
  const inner = (W) => Math.max(20, W - 1 - TIME_W - 2);
  const rail = () => `${' '.repeat(TIME_W)}${C.dim('│')} `;
  let live = false;
  const at = (ts) => ts || (live ? Date.now() : null); // 旧记录的事件没有时间，实时跟踪时用收到的时间
  const node = (t, mark) => `${C.dim(hhmm(t))} ${mark} `;

  // 时间线由一条条记录组成，每条按给定宽度生成若干行，同一宽度只排一次版。
  const entries = [];
  let screen = useScreen ? liveScreen(render, { wheel: true }) : null;
  let lastCommand = null; // 紧挨着的上一行是哪条命令，失败时不在它下面就把命令再写一遍
  const linesOf = (e, W) => {
    if (e.width !== W) { e.lines = e.render(W); e.width = W; }
    return e.lines;
  };
  const add = (renderEntry) => {
    const e = { render: renderEntry, width: null, lines: null };
    entries.push(e);
    lastCommand = null;
    if (!screen) for (const l of linesOf(e, termCols())) process.stdout.write(`${l}\n`);
  };

  // 一个节点：第一行带时间和记号，其余行接在竖线后面；篇幅超过 maxLines 行的折叠
  const say = (ts, mark, text, maxLines = 20) => {
    const t = at(ts);
    add((W) => {
      const lines = wrapWidth(String(text).trim(), inner(W));
      const out = lines.slice(0, maxLines).map((l, i) => (i === 0 ? node(t, mark) : rail()) + l);
      if (lines.length > maxLines) out.push(rail() + C.dim(D.watchMoreLines(lines.length - maxLines)));
      return out;
    });
  };
  // 挂在竖线下的一行，超长截断。动作默认用暗色；mark 是行首单独上色的记号，比如失败的 ✗
  const sub = (text, { color = C.dim, mark = null, indent = 2 } = {}) => add((W) => {
    const room = Math.max(4, inner(W) - indent - (mark ? textWidth(mark[0]) + 1 : 0));
    return [`${rail()}${' '.repeat(indent)}${mark ? `${mark[1](mark[0])} ` : ''}${color(fitWidth(text, room))}`];
  });

  // 一段动作（两句话之间的命令、读文件、搜索）只显示前几条，其余折叠成一行，按种类计数；折叠里失败的照样显示。
  // 直接输出时，这一段结束才写折叠行；实时画面里折叠行一出现就占好位置，之后再折叠的跟着更新计数。
  const MAX_ACTIONS = 3;
  let shownActions = 0;
  const actions = new Map(); // item id → { kind, text }
  const folded = new Map(); // 直接输出时这一段折叠起来的 id → 种类，段尾写一行
  const foldedIn = new Map(); // 实时画面里折叠起来的 id → 它所在的折叠行
  let foldLine = null; // 实时画面里正在累计的折叠行
  const countOf = (ids) => {
    const counts = {};
    for (const kind of ids.values()) counts[kind] = (counts[kind] || 0) + 1;
    return counts;
  };
  const fold = (id, kind) => {
    if (!screen) { folded.set(id, kind); return; }
    if (!foldLine) {
      const entry = { width: null, lines: null, ids: new Map() };
      // 里面的都失败了、单独显示了的时候，折叠行不占行
      entry.render = (W) => (entry.ids.size ? [`${rail()}  ${C.dim(fitWidth(foldText(countOf(entry.ids)), inner(W) - 2))}`] : []);
      entries.push(entry);
      foldLine = entry;
    }
    foldLine.ids.set(id, kind);
    foldLine.width = null;
    foldedIn.set(id, foldLine);
    lastCommand = null;
  };
  // 命令失败了要单独显示：从折叠行里拿出来，之后再折叠的另起一行，免得计数写在失败的命令上面
  const unfold = (id) => {
    folded.delete(id);
    const entry = foldedIn.get(id);
    if (entry) { entry.ids.delete(id); entry.width = null; foldedIn.delete(id); }
    foldLine = null;
  };
  const flushFolded = () => {
    if (folded.size) sub(foldText(countOf(folded)));
    folded.clear();
    foldLine = null;
  };
  const newBlock = () => { flushFolded(); shownActions = 0; };
  let lastPlan = '';
  let lastFile = '';

  const header = (id, dir) => {
    if (!screen) process.stdout.write('\n');
    const lines = headerLines(meta, id, dir);
    add((W) => [
      node(meta.started_at, C.dim('┌')) + C.bold(fitWidth(modelLabel(meta), inner(W))),
      ...lines.map((l, i) => rail() + (i ? C.dim : C.bold)(fitWidth(l, inner(W)))),
      rail().trimEnd(),
    ]);
  };

  // ---- 状态行、思考摘要、翻看 ----
  const started = Date.parse(meta.started_at);
  const stats = { commands: 0, reads: 0, searches: 0, files: new Set(), plan: null, latest: '' };
  const api = { req: null, chars: 0, answerChars: 0, answering: false, queued: false };
  let thought = null; // 最近一条思考摘要的第一行，只在实时画面里显示，说话后清掉
  let tick = 0;
  let ticker = null;
  let offset = 0; // 往回翻了多少行，0 表示跟着最新的内容
  // 排队时按 x 终止：第一次按要求确认，第二次才写终止标记
  let confirmCancel = false;
  let cancelSent = false;
  let lastTotal = 0;
  let lastWidth = 0;
  // 状态行：模型名加粗，状态词（运行中、思考中、排队中）青色，其余暗色；先按宽度截断再上色
  function statusLine(W) {
    const room = W - 3;
    const spin = C.cyan(SPIN[tick % SPIN.length]);
    const model = shortModel(modelOf(meta));
    const word = api.queued ? D.apiPhases.queued : api.req ? D.apiPhases[api.answering ? 'answering' : 'thinking'] : D.statusName('running');
    const state = api.queued ? D.watchApiQueuedLive(clock(Date.now() - Date.parse(api.req)))
      : api.req ? D.watchApiLive(api.answering, clock(Date.now() - Date.parse(api.req)), (api.answering ? api.answerChars : api.chars).toLocaleString('en-US'))
      : D.dots([`${word} ${clock(Date.now() - started)}`, ...D.liveCounts({ commands: stats.commands, reads: stats.reads, searches: stats.searches, files: stats.files.size, plan: stats.plan })]);
    const main = D.dots([model, state]);
    if (cancelSent) return `${spin} ${C.yellow(fitWidth(D.dots([main, D.watchCancelSent]), room))}`;
    if (confirmCancel) return `${spin} ${C.yellow(fitWidth(D.watchCancelConfirm(model), room))}`;
    if (offset) return `${spin} ${C.yellow(fitWidth(D.dots([main, D.watchScrolled(offset)]), room))}`;
    const text = D.dots([main, !api.req && stats.latest]);
    const styled = (body) => (body.startsWith(`${model} · `) ? C.bold(model) + C.dim(' · ') + paintLead(body.slice(model.length + 3), word) : C.bold(body));
    const hint = api.queued && dir ? D.watchKeysQueued : D.watchKeys;
    if (textWidth(main) + textWidth(hint) + 2 > room) return `${spin} ${styled(fitWidth(text, room))}`;
    const body = fitWidth(text, room - textWidth(hint) - 2);
    return `${spin} ${styled(body)}${' '.repeat(room - textWidth(body) - textWidth(hint))}${C.dim(hint)}`;
  }
  function render(W, H) {
    const all = entries.flatMap((e) => linesOf(e, W));
    const thinking = thought ? [`${rail()}  ${C.dim(fitWidth(D.watchThinking(thought), inner(W) - 2))}`] : [];
    const room = Math.max(1, H - 1 - thinking.length);
    // 往回翻着的时候来了新内容，画面停在原处不动
    if (offset && W === lastWidth) offset += all.length - lastTotal;
    lastTotal = all.length;
    lastWidth = W;
    offset = Math.max(0, Math.min(offset, all.length - room));
    const end = all.length - offset;
    const body = all.slice(Math.max(0, end - room), end);
    return [...body, ...thinking, ...Array(room - body.length).fill(''), statusLine(W)];
  }
  const onKeys = (d) => {
    const page = Math.max(1, termRows() - 2);
    for (const k of splitKeys(d.toString('utf8'))) {
      if (k === '\x03' || k === 'q') { detach(k === '\x03' ? 130 : 0); return; }
      if ((k === 'x' || k === 'X') && api.queued && dir && !cancelSent) {
        if (confirmCancel) {
          requestCancel(dir, 'watch');
          cancelSent = true;
        }
        confirmCancel = !confirmCancel && !cancelSent;
        continue;
      }
      confirmCancel = false;
      if (k === '\x1b[A' || k === '\x1bOA' || k === 'k') offset += 1;
      else if (k === '\x1b[B' || k === '\x1bOB' || k === 'j') offset = Math.max(0, offset - 1);
      else if (k === '\x1b[5~' || k === 'b') offset += page;
      else if (k === '\x1b[6~' || k === ' ') offset = Math.max(0, offset - page);
      else if (k === '\x1b[H' || k === '\x1b[1~' || k === 'g') offset = Number.MAX_SAFE_INTEGER;
      else if (k === '\x1b[F' || k === '\x1b[4~' || k === 'G') offset = 0;
    }
    screen?.draw();
  };
  // 离开实时画面：恢复终端，把完整的时间线写进普通屏幕
  const stopLive = () => {
    clearInterval(ticker);
    if (!screen) return;
    screen.stop();
    screen = null;
    if (process.stdin.isTTY) { process.stdin.off('data', onKeys); process.stdin.setRawMode(false); process.stdin.pause(); }
    process.stdout.write('\n');
    for (const e of entries) for (const l of linesOf(e, termCols())) process.stdout.write(`${l}\n`);
  };
  // 按 q 或 Ctrl+C 退出查看，任务照常运行
  const detach = (code) => {
    stopLive();
    process.stdout.write(`${C.dim(D.watchDetached)}\n`);
    process.exit(code);
  };

  const showApi = (ev) => {
    if (ev.type === 'api.request') {
      Object.assign(api, { req: ev.ts, begin: null, chars: 0, answerChars: 0, answering: false, queued: false });
      say(ev.ts, '◆', D.watchApiRequest(ev.model, ev.effort, ev.attempt));
    } else if (ev.type === 'api.queued') {
      // 服务繁忙，请求在排队：只在第一次记一笔，状态行显示已经等了多久
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
    } else if (ev.type === 'api.retry') say(ev.ts, C.yellow('⚠'), D.watchApiRetry(ev.reason, ev.wait_s), 3);
    else if (ev.type === 'api.repair') say(ev.ts, C.yellow('⚠'), D.watchApiRepair(D.list(ev.errors)), 3);
    else if (ev.type === 'api.error' && ev.kind === 'cancelled') { /* 用户终止，结尾那行会写明 */ }
    else if (ev.type === 'api.error' && ev.kind === 'busy') say(ev.ts, C.yellow('⚠'), D.watchApiDropped(D.duration(ev.waited_s || 0)), 2);
    else if (ev.type === 'api.error') say(ev.ts, C.red('✗'), oneLine(ev.message), 3);
  };

  const show = (ev) => {
    if (ev.type?.startsWith('api.')) { showApi(ev); return; }
    const it = ev.item || {};
    // 只有完成事件的工具调用，也要补出命令行供时间线显示。
    if (ev.type === 'item.completed' && it.type === 'command_execution' && !actions.has(it.id)) show({ ...ev, type: 'item.started' });
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      newBlock();
      const msg = ev.error?.message || ev.message || '';
      const re = RECONNECT.exec(msg);
      if (re) say(ev.ts, C.yellow('⚠'), D.watchReconnect(re[1], re[2]), 1);
      else say(ev.ts, C.red('✗'), oneLine(msg), 3);
    } else if (ev.type === 'image.generated') {
      flushFolded();
      sub(`▣ ${D.watchImage(path.basename(ev.path))}`);
    } else if (ev.type === 'image.viewed') {
      flushFolded();
      sub(`◉ ${D.watchImageViewed(path.basename(ev.path))}`);
    } else if (ev.type === 'item.started' && it.type === 'command_execution') {
      const action = commandAction(it);
      actions.set(it.id, action);
      if (action.kind === 'command') stats.latest = action.text; // 状态行写最近一条命令；读文件和搜索已经在计数里
      if (shownActions < MAX_ACTIONS) { sub(action.text); lastCommand = it.id; shownActions++; } else fold(it.id, action.kind);
    } else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message') {
        const t = it.text.trim();
        if (t.startsWith('{')) { try { JSON.parse(t); return; } catch { /* 普通消息 */ } } // 最终报告在结束时单独显示
        newBlock();
        stats.latest = '';
        thought = null;
        say(ev.ts, '◆', t);
      } else if (it.type === 'reasoning') {
        thought = thoughtLine(it.text) || thought;
      } else if (it.type === 'command_execution') {
        const action = actions.get(it.id) ?? commandAction(it);
        stats[action.kind === 'read' ? 'reads' : action.kind === 'search' ? 'searches' : 'commands']++;
        if (it.exit_code === 0 || it.exit_code == null) return;
        const lines = String(it.aggregated_output || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean);
        const tail = lines.length ? lines.slice(-2).join(' ⏎ ') : '';
        unfold(it.id);
        if (lastCommand !== it.id) sub(action.text);
        sub(action.kind === 'command' ? D.watchExit(it.exit_code, tail) : D.watchToolFailed(tail), { color: plain, mark: ['✗', C.red], indent: 4 });
      } else if (it.type === 'file_change') {
        flushFolded();
        for (const c of it.changes || []) {
          stats.files.add(c.path);
          const line = `✎ ${D.fileKinds[c.kind] || c.kind} ${rel(c.path)}`;
          if (line === lastFile) continue; // 同一个文件连着改几次只显示一行
          sub(line);
          lastFile = line;
        }
      } else if (it.type === 'todo_list') {
        const items = it.items || [];
        const done = items.filter((x) => x.completed).length;
        stats.plan = `${done}/${items.length}`;
        const plan = items.map((x) => `${x.completed ? '✔' : '○'} ${x.text}`).join('\n');
        if (plan === lastPlan) return;
        lastPlan = plan;
        newBlock();
        const t = at(ev.ts);
        add(() => [node(t, '◇') + D.watchPlan(done, items.length)]);
        for (const x of items) sub(`${x.completed ? '✔' : '○'} ${x.text}`, { color: x.completed ? C.dim : plain });
      } else if (it.type === 'web_search') {
        const q = oneLine(it.query);
        if (!q) return;
        stats.searches++;
        stats.latest = `◎ ${q}`;
        flushFolded();
        sub(`◎ ${q}`);
      } else if (it.type === 'error' && !/^Under-development features enabled/.test(it.message)) {
        newBlock();
        say(ev.ts, C.yellow('⚠'), oneLine(it.message), 3);
      }
    }
  };

  const finish = (r, m) => {
    flushFolded();
    stopLive();
    live = false;
    const W = termCols();
    const write = (s = '') => process.stdout.write(`${s}\n`);
    // 结论按原文换行输出，超长的行交给终端自动折行；篇幅按约 maxLines 屏幕行估算，超出的折叠。
    const paragraph = (text, indent, maxLines) => {
      const lines = String(text).trim().replace(/\r/g, '').split('\n');
      let budget = maxLines * Math.max(40, W - 1 - textWidth(indent));
      let shown = 0;
      for (const l of lines) {
        if (budget <= 0) break;
        write(indent + (textWidth(l) > budget ? fitWidth(l, budget) : l));
        budget -= Math.max(textWidth(l), 1);
        shown++;
      }
      if (shown < lines.length) write(indent + C.dim(D.watchMoreLines(lines.length - shown)));
    };
    write(rail().trimEnd());
    if (!r) {
      write(node(m?.ended_at, C.dim('└')) + (m?.status === 'running' ? `${C.red('✗')} ${D.watchInterrupted}` : D.watchEnded(m?.status)));
      return;
    }
    const o = resultOutcome(r);
    write(node(m?.ended_at, C.dim('└')) + finishedParts(o, durationOf(r, m), changedFor(r, m), r.stale === true).line(true));
    const usage = usageLine(r, m);
    if (usage) write(' '.repeat(TIME_W + 2) + C.dim(usage));
    const summary = r.report?.summary || r.report?.position;
    const conclusion = reviewConclusion(r.report);
    if (conclusion) {
      write(); paragraph(conclusion, '  ', 12);
      for (const f of r.report.findings || []) paragraph(D.watchFinding(f, D.severityNames[f.severity]), '  ', 4);
      if (r.report.unverified?.length) {
        write(); write(C.bold(D.watchUnverified));
        for (const x of r.report.unverified) paragraph(`· ${x}`, '  ', 4);
      }
    }
    if (summary) { write(); paragraph(summary, '  ', 12); }
    const issues = r.report?.open_issues || r.report?.open_questions || [];
    if (issues.length) {
      write();
      write(C.bold(D.watchOpenIssues));
      for (const x of issues) paragraph(`· ${x}`, '  ', 4);
    }
    const asks = r.questions?.filter(needsDecision) ?? r.report?.decision_requests ?? [];
    if (asks.length) {
      write();
      write(C.bold(D.watchDecisions));
      for (const d of asks) {
        const prefix = d.source === 'permission_denied' ? D.watchDeniedPrefix : d.source === 'input_prompt' ? D.watchInputPromptPrefix : '';
        paragraph(`· ${prefix}${d.question}`, '  ', 6);
        for (const opt of d.options || []) paragraph(`- ${opt}`, '    ', 3);
        if (d.recommendation) paragraph(D.watchRecommendation(d.recommendation), '    ', 4);
      }
    }
    const midRun = (r.questions || []).filter((q) => q.source === 'asked_mid_run');
    if (midRun.length) {
      write();
      write(C.bold(D.watchAskedMidRun));
      for (const q of midRun) write(`  · ${fitWidth(oneLine(q.question), W - 5)}`);
    }
    for (const e of realErrors(r, o.ok)) write(r.status === 'needs_input'
      ? `${C.yellow('?')} ${fitWidth(oneLine(e), W - 3)}` : `${C.red('✗')} ${fitWidth(oneLine(e), W - 3)}`);
  };

  const goLive = () => {
    live = true;
    if (!screen) return;
    screen.start();
    ticker = setInterval(() => { tick++; screen?.draw(); }, 250);
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onKeys); }
    process.on('SIGINT', () => detach(130));
    process.on('exit', () => screen?.stop());
  };
  return { header, show, finish, goLive };
}

// 组视图里每个任务的信息流：从 events.jsonl 增量读取。最近说的一段话和最近一条思考摘要单独记着，固定显示在每一块的顶上；
// 其余是动作（命令、读文件、搜索、改文件、图片，以及请求、排队、出错这些提示），只留最近的一些，按种类计数，放不下时折叠。
// 同时记下命令、读文件、搜索的次数和 API 的思考进度，放在每块的标题行右侧。API 的思考原文不在面板里显示，
// 用 watch --run <run_id> --verbose 看。
function createFeed(run) {
  const cwd = run.meta.cwd;
  const rel = (p) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
  const file = path.join(run.dir, 'events.jsonl');
  const decoder = new TextDecoder('utf-8');
  const stats = { commands: 0, reads: 0, searches: 0, req: null, chars: 0, answerChars: 0, answering: false, queued: false };
  // actions 的每一条：{ kind, text, mark: [记号, 颜色] | null, color }；kinds 是全部动作按种类的个数，包括已经丢掉的
  const feed = { speech: null, thought: null, actions: [], kinds: {}, stats };
  let offset = 0;
  let buf = '';
  let seq = 0; // 说话和思考的先后
  const byId = new Map(); // 工具调用 id → 动作，失败时补上 ✗
  const warn = (text) => ({ kind: 'other', text, mark: ['⚠', C.yellow], color: plain });
  const push = (entry) => {
    feed.actions.push(entry);
    feed.kinds[entry.kind] = (feed.kinds[entry.kind] || 0) + 1;
    if (feed.actions.length > 60) feed.actions.splice(0, feed.actions.length - 60);
    return entry;
  };
  const take = (ev) => {
    const it = ev.item || {};
    if (ev.type === 'item.completed' && it.type === 'command_execution' && !byId.has(it.id)) take({ ...ev, type: 'item.started' });
    if (ev.type === 'api.request') {
      Object.assign(stats, { req: ev.ts, chars: 0, answerChars: 0, answering: false, queued: false });
      push({ kind: 'other', text: D.watchApiRequest(ev.model, ev.effort, ev.attempt) });
    } else if (ev.type === 'api.queued') {
      if (!stats.queued) push({ kind: 'other', text: D.watchApiQueued, mark: ['⋯', C.yellow], color: plain });
      stats.queued = true;
    } else if (ev.type === 'api.reasoning') {
      stats.queued = false;
      stats.chars = ev.total_chars;
    } else if (ev.type === 'api.content') {
      // 回答是 JSON 报告，不逐字展示，进度在标题行右侧
      stats.queued = false;
      stats.answering = true;
      stats.answerChars = ev.total_chars;
    } else if (ev.type === 'api.retry') push(warn(D.watchApiRetry(ev.reason, ev.wait_s)));
    else if (ev.type === 'api.repair') push(warn(D.watchApiRepair(D.list(ev.errors))));
    else if (ev.type === 'api.error' && ev.kind === 'cancelled') stats.queued = false;
    else if (ev.type === 'api.error' && ev.kind === 'busy') { stats.queued = false; push(warn(D.watchApiDropped(D.duration(ev.waited_s || 0)))); }
    else if (ev.type === 'api.error' || ev.type === 'turn.failed' || ev.type === 'error') {
      const msg = oneLine(ev.message || ev.error?.message || '');
      const re = RECONNECT.exec(msg);
      push(re ? warn(D.watchReconnect(re[1], re[2])) : { kind: 'other', text: msg, mark: ['✗', C.red], color: plain });
    } else if (ev.type === 'image.generated') push({ kind: 'image', text: `▣ ${D.watchImage(path.basename(ev.path))}` });
    else if (ev.type === 'image.viewed') push({ kind: 'image', text: `◉ ${D.watchImageViewed(path.basename(ev.path))}` });
    else if (ev.type === 'item.started' && it.type === 'command_execution') byId.set(it.id, push(commandAction(it)));
    else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message') {
        const t = it.text.trim();
        if (t.startsWith('{')) { try { JSON.parse(t); return; } catch { /* 普通消息 */ } } // 最终报告在任务结束后显示
        if (t) feed.speech = { text: t, seq: ++seq };
      } else if (it.type === 'reasoning') {
        const line = thoughtLine(it.text);
        if (line) feed.thought = { text: line, seq: ++seq };
      } else if (it.type === 'command_execution') {
        const action = byId.get(it.id) ?? commandAction(it);
        stats[action.kind === 'read' ? 'reads' : action.kind === 'search' ? 'searches' : 'commands']++;
        if (it.exit_code !== 0 && it.exit_code != null) action.mark = ['✗', C.red];
      } else if (it.type === 'file_change') for (const c of it.changes || []) push({ kind: 'edit', text: `✎ ${D.fileKinds[c.kind] || c.kind} ${rel(c.path)}` });
      else if (it.type === 'web_search') {
        const q = oneLine(it.query);
        if (q) { stats.searches++; push({ kind: 'search', text: `◎ ${q}` }); }
      } else if (it.type === 'todo_list') push({ kind: 'other', text: `◇ ${D.watchPlan((it.items || []).filter((x) => x.completed).length, (it.items || []).length)}`, color: plain });
      else if (it.type === 'error' && !/^Under-development features enabled/.test(it.message)) push(warn(oneLine(it.message)));
    }
  };
  const read = () => {
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
      take(ev);
    }
  };
  feed.read = read;
  return feed;
}

// 组视图一块的标题：第一行左边是状态记号和模型标签，右边是状态词和用时（结束后加上改动、运行中加上计数）。
// 模型标签尽量写全：右侧放不下时先截短右侧；最终汇总（wrap）里改成把右侧写到下一行。窗口太窄时只留左侧。
// 同组标题各不相同时（比如角色讨论、拆开的执行任务），再写一行这一块的标题，续接的讨论后面写上第几轮
function panelHead(run, stats, width, withTitle, { wrap = false } = {}) {
  const o = runOutcome(run);
  const { running, result: r } = o;
  const m = run.meta;
  const elapsed = runEnd(run.dir, m) - Date.parse(m.started_at);
  const { mark, color, word: status } = outcomeStyle(o);
  const s = stats;
  // 右侧先拼成纯文字，截短之后再上色：开头的状态词上色，其余暗色
  const [word, right] = !running ? [status, D.dots([status, took(r?.duration_s ?? elapsed / 1000), changedFor(r, m), r?.stale === true && D.watchStale])]
    : s.queued ? [D.apiPhases.queued, D.watchApiQueuedLive(clock(Date.now() - Date.parse(s.req)))]
    : s.req ? [D.apiPhases[s.answering ? 'answering' : 'thinking'], D.watchApiLive(s.answering, clock(Date.now() - Date.parse(s.req)), (s.answering ? s.answerChars : s.chars).toLocaleString('en-US'))]
    : [status, D.dots([`${status} ${clock(elapsed)}`, ...D.liveCounts({ commands: s.commands, reads: s.reads, searches: s.searches })])];
  const paintRight = (text) => paintLead(text, word, running ? C.cyan : color);
  const label = modelLabel(m);
  const room = width - 2 - textWidth(label) - 2; // 模型标签写全时右侧还剩的宽度
  const line = (l, text) => `${color(mark)} ${C.bold(l)}${' '.repeat(Math.max(1, width - 2 - textWidth(l) - textWidth(text)))}${paintRight(text)}`;
  const lines = [];
  if (textWidth(right) <= room) lines.push(line(label, right));
  else if (wrap) lines.push(`${color(mark)} ${C.bold(fitWidth(label, width - 2))}`, `  ${paintRight(fitWidth(right, width - 2))}`);
  else if (room >= textWidth(word) + 8) lines.push(line(label, fitWidth(right, room)));
  else if (textWidth(right) + 16 <= width) lines.push(line(fitWidth(label, width - textWidth(right) - 4), right));
  else lines.push(`${color(mark)} ${C.bold(fitWidth(label, width - 2))}`);
  if (!withTitle || !m.title) return lines;
  const title = oneLine(m.title);
  const round = m.round > 1 && !title.includes(D.watchRound(m.round)) ? D.watchRound(m.round) : '';
  return [...lines, `  ${C.bold(fitWidth(D.dots([title, round]), width - 2))}`];
}

// 运行中的一块正文：顶上是最近说的一段话（◆，最多 2 行）和比它新的思考摘要，下面是最近的动作，最新的在最下面；
// 放不下的动作折叠成第一行的"… 另有 N 条命令"，只剩一行时折叠计数和最新一条写在同一行。
// 行数不够时先省掉思考摘要，再把说的话压成 1 行。
function liveBody(feed, rows, inner) {
  if (rows <= 0) return [];
  const speech = feed.speech ? wrapWidth(feed.speech.text, inner - 2).filter((l) => l.trim()) : [];
  const acting = feed.actions.length ? 1 : 0;
  const thinking = feed.thought && (!feed.speech || feed.thought.seq > feed.speech.seq) && Math.min(2, speech.length) + 1 + acting <= rows ? 1 : 0;
  const speechRows = Math.min(speech.length, 2, Math.max(speech.length ? 1 : 0, rows - thinking - acting));
  const top = [];
  if (speechRows) {
    const more = speech.length > speechRows;
    top.push(`◆ ${speechRows === 1 && more ? fitWidth(`${speech[0]} ${speech[1]}`, inner - 2) : speech[0]}`);
    if (speechRows === 2) top.push(`  ${more ? fitWidth(`${speech[1]} ${speech[2]}`, inner - 2) : speech[1]}`);
  }
  if (thinking) top.push(C.dim(fitWidth(D.watchThinking(feed.thought.text), inner)));
  const room = rows - top.length;
  if (room <= 0 || !feed.actions.length) return top;
  // lead 是写在同一行前面的折叠计数（只剩一行时用）
  const line = (a, lead = '') => {
    const head = `${lead ? C.dim(`${lead} · `) : ''}${a.mark ? `${a.mark[1](a.mark[0])} ` : ''}`;
    return head + (a.color || C.dim)(fitWidth(a.text, Math.max(4, inner - visibleWidth(head))));
  };
  const total = Object.values(feed.kinds).reduce((n, k) => n + k, 0);
  if (total <= room) return [...top, ...feed.actions.slice(-room).map((a) => line(a))];
  const shown = feed.actions.slice(feed.actions.length - Math.max(1, room - 1));
  const hidden = { ...feed.kinds };
  for (const a of shown) hidden[a.kind]--;
  if (room === 1) return [...top, line(shown[0], foldText(hidden, false))];
  return [...top, C.dim(fitWidth(foldText(hidden, false), inner)), ...shown.map((a) => line(a))];
}

// 组视图的一块：标题行加固定行数的正文。运行中显示最近说的话和动作，结束后显示结论。
function panelLines(run, feed, rows, width, withTitle) {
  const { running, result: r, ok } = runOutcome(run);
  const head = panelHead(run, feed.stats, width, withTitle);
  const inner = width - 2;
  let body = [];
  const conclusion = reviewConclusion(r?.report);
  const final = conclusion || r?.report?.position || r?.report?.summary;
  const errors = realErrors(r, ok);
  if (!running && (final || errors.length)) {
    if (final) body = wrapWidth(conclusion || D.watchOpinion(final.trim()), inner);
    for (const e of errors) body.push(`${r.status === 'needs_input' ? C.yellow('?') : C.red('✗')} ${fitWidth(oneLine(e), inner - 2)}`);
    body = body.slice(0, rows);
  } else {
    body = liveBody(feed, rows, inner);
    if (!body.length && running && rows > 0) body.push(C.dim(D.noEvents));
  }
  while (body.length < rows) body.push('');
  return [...head, ...body.map((l) => (l ? `  ${l}` : ''))];
}

// 组的标题行右侧：运行中、完成、失败各几个，为 0 的不写
function groupCounts(all) {
  const { running, ok, blocked, failed, resumed } = groupTally(all);
  return [running && C.cyan(D.groupCount.running(running)), ok && C.green(D.groupCount.ok(ok)), resumed && C.dim(D.groupCount.resumed(resumed)), blocked && C.yellow(D.groupCount.blocked(blocked)), failed && C.red(D.groupCount.failed(failed))].filter(Boolean).join(C.dim(' · '));
}

// 组里属于派发计划的任务：每份计划一行，写明完整、进行中还是不完整、缺了哪个必选，只给状态词上色。
// 实时面板截成一行，最终汇总折行写全。
function planLines(all, width, wrap = false) {
  return describePlans(all).flatMap(({ state, text }) => (wrap ? wrapWidth(text, width) : [fitWidth(text, width)])
    .map((line, i) => (i === 0 ? paintPlanWord(line, state) : line)));
}

// 组的标题行：左边是组名和标题（默认色加粗），右边是各状态的个数，放不下右侧时只留左侧
function groupHeadLine(group, title, all, width) {
  const counts = groupCounts(all);
  const countsW = visibleWidth(counts);
  if (countsW + 14 > width) return C.bold(fitWidth(D.groupHeader(group, title, all.length), width));
  const left = fitWidth(D.groupHeader(group, title, all.length), width - countsW - 2);
  return C.bold(left) + ' '.repeat(width - textWidth(left) - countsW) + counts;
}

async function watchGroup(group, o, loadCfg) {
  // 被续接过的任务（讨论的上一轮、返工前的那次）由续接的新任务代替，不再单独显示
  const current = (runs) => {
    const replaced = new Set(runs.map((run) => run.meta.parent).filter(Boolean));
    return runs.filter((run) => !replaced.has(run.id));
  };
  const recentRuns = () => current(groupRuns(group, Date.now() - 86400000)).reverse();
  let runs;
  for (let waited = 0; ; waited += 500) {
    runs = recentRuns();
    // 找到的一批都已结束时多等几秒：可能是别的会话用过的同名组，新派出的任务还没登记
    if (runs.some((run) => isRunning(run.meta)) || (runs.length && waited >= 5000)) break;
    if (waited >= 15000) die(M.groupNotFound(group));
    if (waited === 0 && !runs.length) process.stdout.write(`${D.watchWaiting}\n`);
    await sleep(500);
  }
  // 启动动画：画出组里新派出的各位，播放中后登记的任务也会出场；结束后接着用备用屏幕画实时面板
  let introPlayed = false;
  let handOff = () => {};
  if (introWanted(o, runs.map((run) => run.meta), loadCfg)) {
    const fresh = (list) => list.filter((run) => !run.meta.parent).map((run) => introOf(run.meta));
    const first = runs.find((run) => !run.meta.parent).meta;
    const kind = runs.some((run) => kindOf(run.meta) === 'discuss') ? 'discuss' : kindOf(first);
    // meta.json 正被替换时会暂时读不到，组里的任务就会从列表里消失：见过的任务都记着，读不到的不算结束
    const seen = new Map(runs.map((run) => [run.id, run]));
    handOff = await playIntro(introScene({ mode: first.mode, kind, participants: fresh(runs), group: true }), {
      keepScreen: true,
      isOver: () => {
        for (const run of recentRuns()) seen.set(run.id, run);
        return [...seen.values()].every((run) => { const m = readMeta(run.dir); return !!m && !isRunning(m); });
      },
      refresh: () => { const list = recentRuns(); return list.length ? fresh(list) : null; },
    });
    introPlayed = true;
    const after = recentRuns();
    if (after.length) runs = after;
  }
  const known = new Map();
  const feeds = new Map();
  let lastAdded = Date.now();
  const refresh = () => {
    // 换成了另一批（新会话用同一个组名派出了任务），上一批的不再显示
    const ids = new Set(runs.map((run) => run.id));
    for (const id of [...known.keys()]) if (!ids.has(id)) { known.delete(id); feeds.delete(id); }
    for (const run of runs) {
      if (!known.has(run.id)) { lastAdded = Date.now(); feeds.set(run.id, createFeed(run)); }
      known.set(run.id, run);
    }
  };
  refresh();
  const anyRunning = () => [...known.values()].some((run) => isRunning(run.meta));
  const settled = () => !anyRunning() && Date.now() - lastAdded >= 5000; // 等几秒，同组后派出的任务也能收进来
  // 同组任务标题相同时（比如一场讨论）标题只在顶上写一次；不同时（拆开的执行任务）写在每块面板上。
  // 讨论的第 2 轮起，标题后面写上第几轮
  const sharedTitle = () => {
    const all = [...known.values()];
    const titles = new Set(all.map((run) => run.meta.title || ''));
    if (titles.size !== 1) return '';
    const rounds = new Set(all.map((run) => run.meta.round ?? null));
    const round = rounds.size === 1 ? [...rounds][0] : null;
    return [[...titles][0], round > 1 ? D.watchRound(round) : ''].filter(Boolean).join(' · ');
  };

  if (liveCapable() && anyRunning()) {
    // 实时面板：用 liveScreen 在备用屏幕里整屏重画，窗口大小变化时按新尺寸重画。
    // 结束后回到原来的屏幕，再输出最终汇总，留作记录。
    // 有模型在排队时按 x 终止：第一次按要求确认，第二次给所有排队中的任务写终止标记
    let confirmCancel = false;
    const cancelSent = new Set();
    const queuedRuns = () => [...known.values()].filter((run) => isRunning(run.meta) && feeds.get(run.id).stats.queued && !cancelSent.has(run.id));
    const render = (W, H) => {
      const all = [...known.values()];
      const width = Math.max(20, W - 1);
      for (const run of all) feeds.get(run.id).read();
      // 顶部标题一行、底部提示一行，每块有分隔线和标题（没有公共标题时多一行写各自的标题）；正文行数按窗口高度平均分，最多 8 行。
      // 窗口不够高时正文可以一行都不留；连各块的标题都放不下时，最后一行写还有几个任务没显示
      const title = sharedTitle();
      const headRows = title ? 2 : 3;
      const plans = planLines(all, width);
      const rows = Math.max(0, Math.min(8, Math.floor((H - 2 - plans.length - all.length * headRows) / all.length)));
      const out = [groupHeadLine(group, title, all, width), ...plans];
      const heads = []; // 每块标题行在 out 里的位置
      for (const run of all) {
        out.push(C.dim('─'.repeat(width)));
        heads.push(out.length);
        out.push(...panelLines(run, feeds.get(run.id), rows, width, !title));
      }
      const hidden = heads.filter((i) => i >= H - 2).length;
      const lines = out.length <= H - 1 ? out : hidden ? [...out.slice(0, H - 2), C.dim(fitWidth(D.dashHidden(hidden), width))] : out.slice(0, H - 1);
      while (lines.length < H - 1) lines.push('');
      const queued = queuedRuns();
      if (confirmCancel && queued.length) lines.push(C.yellow(fitWidth(D.dashCancelConfirm(D.list(queued.map((run) => shortModel(modelOf(run.meta))))), width)));
      else lines.push((queued.length ? C.yellow : C.dim)(fitWidth(queued.length ? D.dashHintQueued : D.dashHint, width)));
      return lines;
    };
    const screen = liveScreen(render);
    const onKeys = (d) => {
      for (const k of splitKeys(d.toString('utf8'))) {
        if (k === '\x03' || k === 'q') { screen.stop(); process.exit(k === '\x03' ? 130 : 0); }
        if ((k === 'x' || k === 'X') && queuedRuns().length) {
          if (confirmCancel) {
            for (const run of queuedRuns()) { requestCancel(run.dir, 'watch'); cancelSent.add(run.id); }
          }
          confirmCancel = !confirmCancel;
        } else confirmCancel = false;
      }
      screen.draw();
    };
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onKeys); }
    process.on('exit', () => screen.stop());
    process.on('SIGINT', () => { screen.stop(); process.exit(130); });
    screen.start();
    handOff(); // 实时面板接手了备用屏幕，由它负责退出时恢复终端
    for (let tick = 0; ; tick++) {
      screen.draw();
      if (settled()) break;
      await sleep(1000);
      for (const run of known.values()) run.meta = readMeta(run.dir) || run.meta;
      if (tick % 2 === 1) { runs = recentRuns(); refresh(); }
    }
    if (process.stdin.isTTY) { process.stdin.off('data', onKeys); process.stdin.setRawMode(false); process.stdin.pause(); }
    screen.stop();
  } else if (introPlayed) {
    process.stdout.write(LEAVE_SCREEN); // 动画期间全部结束了：离开备用屏幕，直接输出汇总
    handOff();
  } else if (anyRunning()) {
    // 输出被重定向时（比如被别的程序读取），每个任务状态变化时写一行。
    process.stdout.write(`${D.groupHeader(group, sharedTitle(), known.size)}\n`);
    const states = new Map();
    for (;;) {
      for (const run of known.values()) {
        const shown = outcomeStyle(runOutcome(run)).word;
        if (states.get(run.id) !== shown) process.stdout.write(`${D.dots([modelLabel(run.meta), shown])}\n`);
        states.set(run.id, shown);
      }
      for (const { id, text } of describePlans([...known.values()])) {
        if (states.get(id) !== text) process.stdout.write(`${text}\n`);
        states.set(id, text);
      }
      if (settled()) break;
      await sleep(2000);
      runs = recentRuns();
      refresh();
    }
  }

  // 最终汇总：写在正常屏幕里，排版和实时面板一致（标题行、分隔线、每块的标题行），正文不限行数；
  // 每一块最后一行是回看这一席时间线的命令，不截断，方便整行复制。
  const all = [...known.values()];
  const title = sharedTitle();
  const width = Math.max(20, termCols() - 1);
  const inner = width - 2;
  const out = ['', groupHeadLine(group, title, all, width), ...planLines(all, width, true)];
  for (const run of all) {
    const { result: r, ok } = runOutcome(run);
    out.push(C.dim('─'.repeat(width)), ...panelHead(run, feeds.get(run.id).stats, width, !title, { wrap: true }));
    const usage = usageLine(r, run.meta);
    if (usage) out.push(`  ${C.dim(fitWidth(usage, inner))}`);
    const conclusion = reviewConclusion(r?.report);
    const final = conclusion || r?.report?.position || r?.report?.summary;
    if (final) for (const l of wrapWidth(conclusion || D.watchOpinion(final.trim()), inner)) out.push(`  ${l}`);
    const [mark, color] = r?.status === 'needs_input' ? ['?', C.yellow] : ['✗', C.red];
    for (const e of realErrors(r, ok)) out.push(...wrapWidth(`${mark} ${oneLine(e)}`, inner).map((l, i) => `  ${i ? l : color(mark) + l.slice(mark.length)}`));
    out.push(`  ${C.dim(replayCommand(RUNS_ROOT, run.id))}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

async function cmdWatch(o, loadCfg) {
  if (o.group != null) return watchGroup(o.group, o, loadCfg);
  const { id, dir, meta } = await pickWatchRun(o.run);
  let handOff = null;
  if (introWanted(o, [meta], loadCfg)) {
    // 时间线也画在备用屏幕里，动画结束后不用退出；--verbose 逐行输出在普通屏幕里，要先退出
    handOff = await playIntro(introScene({ mode: meta.mode, kind: kindOf(meta), participants: [introOf(meta)] }), {
      keepScreen: !o.verbose,
      isOver: () => { const m = readMeta(dir); return !!m && !isRunning(m); },
    });
  }
  const cwd = meta.cwd;
  const rel = (p) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
  // 任务还在运行、输出到终端时，时间线画在可以随窗口重排的实时画面里
  const live = liveCapable() && isRunning(meta);
  // 动画期间任务就结束了：时间线不进实时画面，先离开动画留下的备用屏幕
  if (handOff && !o.verbose && !live) { process.stdout.write(LEAVE_SCREEN); handOff(); }
  const view = !o.verbose ? timelineRenderer(meta, rel, { screen: live, dir })
    : (agentTypeOf(meta) === 'api' ? apiVerboseRenderer : verboseRenderer)(meta, rel);
  view.header(id, dir);

  const file = path.join(dir, 'events.jsonl');
  const decoder = new TextDecoder('utf-8');
  let offset = 0;
  let buf = '';
  const drain = () => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
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
      view.show(ev);
    }
  };

  drain();
  view.goLive();
  handOff?.(); // 实时时间线接手了备用屏幕，由它负责退出时恢复终端
  let m = readMeta(dir);
  while (isRunning(m)) {
    await sleep(500);
    drain();
    m = readMeta(dir);
  }
  drain();

  const resFile = path.join(dir, 'result.json');
  view.finish(fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : null, m);
}

export { cmdWatch };
