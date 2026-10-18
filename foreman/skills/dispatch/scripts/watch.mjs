// 详细事件、时间线、组视图和终端实时画面，只读取统一记录。
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_ROOT, CANCEL_FILE, listRuns, findRun, readMeta, isRunning, runEnd, runOutcome, groupTally, groupRuns } from './records.mjs';
import { M, die, sleep, clip, oneLine, plainCommand, RECONNECT, isReconnect, modelOf, whoOf, agentTypeOf, needsDecision, charWidth, textWidth, fitWidth, wrapWidth } from './util.mjs';
import { avatarFor, introScene, playIntro } from './watch-intro.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
// 能画实时画面的终端：输出到终端，而且不是 TERM=dumb 这种不认光标控制的终端
const liveCapable = () => process.stdout.isTTY && process.env.TERM !== 'dumb';
// 结果里的改动数只算有证据是 Codex 改的；旧记录没有归属信息，按全部改动算。
// 改名前的记录里，归属到协作方的改动数叫 codex_total。
// 改动数包括有证据的和协作方自报的；改名前的记录里叫 codex_total。
const agentTotal = (c) => (c?.agent_total == null && c?.codex_total == null ? undefined : (c.agent_total ?? c.codex_total) + (c.reported_total || 0));
const changedText = (c) => (c?.available ? M.watchChanged(agentTotal(c) ?? c.files_total, agentTotal(c) == null ? 0 : c.unknown_total) : M.watchNotTracked);
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
// 讨论和审查本来只读，只有真的改了文件才显示改动数（那是越界，要提醒）。
const changedFor = (r, m) => (m?.kind === 'exec' || agentTotal(r?.changes) ? changedText(r?.changes) : null);
const C = { dim: paint('2'), bold: paint('1'), red: paint('31'), green: paint('32'), yellow: paint('33'), cyan: paint('36') };
// 实时画面里的用时写成 12:03，结束后的用时由 M.duration 写成「19 分 18 秒」
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};
const hhmm = (t) => (t ? new Date(t).toTimeString().slice(0, 5) : '     ');
// 执行顺利结束时以报告里的状态为准（完成、部分完成、等待决定……）
const shownStatus = (status, r) => (status === 'done' ? r?.needs_decision ? 'blocked' : r?.report?.status || status : status);
// 成功的任务不再列出临时的重连提示；旧记录把它记成了错误
const realErrors = (r, ok) => (r?.errors || []).filter((e) => !(ok && isReconnect(e)));
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

async function pickWatchRun(ref) {
  if (ref) return findRun(ref);
  // 刚派活时任务可能还没登记，等一会儿；仍没有就显示最近一次。
  for (let waited = 0; ; waited += 500) {
    const ids = listRuns();
    const running = ids.find((id) => isRunning(readMeta(path.join(RUNS_ROOT, id))));
    if (running) return findRun(running);
    if (waited >= 15000) {
      if (!ids[0]) die(M.noRuns);
      process.stdout.write(`${M.watchFallback}\n`);
      return findRun(ids[0]);
    }
    if (waited === 0) process.stdout.write(`${M.watchWaiting}\n`);
    await sleep(500);
  }
}

// 详细模式（--verbose）：每个事件一行，带时间戳，包括思考过程、命令输出和 token 用量。
function verboseRenderer(meta, rel) {
  let live = false;
  const commands = new Set();
  const out = (sym, text, ts) => process.stdout.write(`${ts ? new Date(ts).toTimeString().slice(0, 8) : live ? new Date().toTimeString().slice(0, 8) : '        '} ${sym} ${text}\n`);
  const header = (id, dir) => {
    const [first, ...rest] = M.watchHeaderLines(M.modeNames[meta.mode] || meta.mode, meta.title || id, meta.level, meta.cwd, dir);
    process.stdout.write(`\n${C.bold(`${whoOf(meta)} · ${first}`)}\n${C.dim(rest.join('\n'))}\n\n`);
  };
  const show = (ev) => {
    const it = ev.item || {};
    const o = (sym, text) => out(sym, text, ev.ts);
    if (ev.type === 'item.completed' && it.type === 'command_execution' && !commands.has(it.id)) show({ ...ev, type: 'item.started' });
    if (ev.type === 'thread.started') o('●', M.watchSession(ev.thread_id));
    else if (ev.type === 'turn.failed') o('✗', M.watchTurnFailed(ev.error?.message || ''));
    else if (ev.type === 'error') {
      const re = RECONNECT.exec(ev.message || '');
      o('⚠', re ? M.watchReconnect(re[1], re[2]) : clip(oneLine(ev.message), 300));
    } else if (ev.type === 'turn.completed' && ev.usage) {
      o('Σ', M.watchTokens(ev.usage));
    } else if (ev.type === 'image.generated') {
      o('▣', M.watchImage(ev.path));
    } else if (ev.type === 'item.started' && it.type === 'command_execution') {
      commands.add(it.id);
      o('▶', clip(oneLine(plainCommand(it.command)), 240));
    } else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message') {
        const t = it.text.trim();
        let report = null;
        if (t.startsWith('{')) try { report = JSON.parse(t); } catch { /* 普通消息 */ }
        if (report?.position) o('■', M.watchOpinion(clip(oneLine(report.position), 400)));
        else if (report?.status) o('■', M.watchReport(report.status, clip(oneLine(report.summary), 300)));
        else o('💬', clip(oneLine(t), 600));
      } else if (it.type === 'reasoning') {
        o('…', clip(oneLine(it.text), 200));
      } else if (it.type === 'command_execution') {
        commands.delete(it.id);
        const lines = String(it.aggregated_output || '').replace(/\r/g, '').split('\n').map((x) => x.trimEnd()).filter(Boolean);
        o(it.exit_code === 0 ? '✓' : '✗', M.watchExit(it.exit_code, lines.length ? clip(lines.slice(-3).join(' ⏎ '), 240) : ''));
      } else if (it.type === 'file_change') {
        for (const c of it.changes || []) o('✎', `${M.fileKinds[c.kind] || c.kind} ${rel(c.path)}`);
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
      const blocked = r.status === 'needs_input' || shownStatus(r.status, r) === 'blocked';
      const text = M.watchFinished(M.statusName(shownStatus(r.status, r)), M.duration(r.duration_s), changedFor(r, m));
      out(blocked ? C.yellow('?') : '■', blocked ? C.yellow(text) : text, m?.ended_at);
    }
    else out('■', m?.status === 'running' ? M.watchInterrupted : M.watchEnded(m?.status), m?.ended_at);
    if (r?.usage) out('Σ', M.tokenSummary(r.usage, r.last_request ?? r.context, M.tokenCount, (r.usage_scope ?? (m?.mode === 'resume' ? 'session_total' : 'this_run')) === 'session_total'), m?.ended_at);
  };
  return { header, show, finish, goLive: () => { live = true; } };
}

// API 协作方的详细模式：思考和回答的原文逐段输出
function apiVerboseRenderer(meta, rel) {
  const base = verboseRenderer(meta, rel);
  const show = (ev) => {
    if (!ev.type?.startsWith('api.')) return base.show(ev);
    const out = (text) => process.stdout.write(`${ev.ts ? new Date(ev.ts).toTimeString().slice(0, 8) : '        '} ${text}\n`);
    if (ev.type === 'api.request') out(M.watchApiRequest(ev.model, ev.effort, ev.attempt));
    else if (ev.type === 'api.reasoning' || ev.type === 'api.content') out(ev.text);
    else if (ev.type === 'api.queued') out(M.watchApiQueuedLive(clock(ev.waited_s * 1000)));
    else if (ev.type === 'api.retry') out(M.watchApiRetry(ev.reason, ev.wait_s));
    else if (ev.type === 'api.repair') out(M.watchApiRepair(M.list(ev.errors)));
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
    const rows = process.stdout.rows || 30;
    const lines = render(process.stdout.columns || 100, rows).slice(0, rows);
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
const introOf = (m) => ({ key: avatarFor(m.model_name ?? m.model, agentTypeOf(m)), model: modelOf(m), who: whoOf(m) });

// 把一段键盘输入拆成单个按键（方向键、翻页键是 ESC 开头的一串）
const splitKeys = (s) => s.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g) || [];

// 简洁模式（默认）：时间线。左边一列是时间，模型说的话是节点（◆），命令、搜索、改动挂在竖线下面，
// 失败的命令才显示输出。长段文字按宽度折行，接在竖线后面。
// 任务还在运行时，时间线画在备用屏幕里：最后一行是状态行（用时、命令数、改动数、计划进度），
// 窗口大小变化时整屏按新宽度重新排版，可以用方向键和翻页键往回翻；结束或退出查看时，
// 把完整的时间线写进普通屏幕留作记录。任务已经结束时直接按当前宽度输出。
function timelineRenderer(meta, rel, { screen: useScreen = false, dir = null } = {}) {
  const cols = () => process.stdout.columns || 100;
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
    if (!screen) for (const l of linesOf(e, cols())) process.stdout.write(`${l}\n`);
  };

  // 一个节点：第一行带时间和符号，其余行接在竖线后面；篇幅超过 maxLines 行的折叠
  const say = (ts, mark, text, color = (s) => s, maxLines = 20) => {
    const t = at(ts);
    add((W) => {
      const lines = wrapWidth(String(text).trim(), inner(W));
      const out = lines.slice(0, maxLines).map((l, i) => (i === 0 ? node(t, mark) : rail()) + color(l));
      if (lines.length > maxLines) out.push(rail() + C.dim(M.watchMoreLines(lines.length - maxLines)));
      return out;
    });
  };
  // 挂在竖线下的一行，超长截断
  const sub = (text, color = C.dim) => add((W) => [rail() + color(fitWidth(text, inner(W)))]);

  // 连续的命令只显示前几条，其余折叠成一行；折叠里的命令失败了照样显示。
  const MAX_COMMANDS = 3;
  let shownCommands = 0;
  const commands = new Map(); // item id → 命令文字
  const folded = new Set(); // 折叠起来的命令 id
  const flushFolded = () => {
    if (folded.size) sub(`  ${M.watchFoldedCommands(folded.size)}`);
    folded.clear();
  };
  const newBlock = () => { flushFolded(); shownCommands = 0; };
  let lastPlan = '';
  let lastFile = '';

  const header = (id, dir) => {
    if (!screen) process.stdout.write('\n');
    const lines = M.watchHeaderLines(M.modeNames[meta.mode] || meta.mode, meta.title || id, meta.level, meta.cwd, dir);
    add((W) => [
      node(meta.started_at, C.cyan('┌')) + C.bold(fitWidth(whoOf(meta), inner(W))),
      ...lines.map((l, i) => rail() + (i ? C.dim(fitWidth(l, inner(W))) : fitWidth(l, inner(W)))),
      rail().trimEnd(),
    ]);
  };

  // ---- 状态行、翻看 ----
  const started = Date.parse(meta.started_at);
  const stats = { commands: 0, searches: 0, files: new Set(), plan: null, latest: '' };
  const api = { req: null, chars: 0, answerChars: 0, answering: false, queued: false };
  let tick = 0;
  let ticker = null;
  let offset = 0; // 往回翻了多少行，0 表示跟着最新的内容
  // 排队时按 x 终止：第一次按要求确认，第二次才写终止标记
  let confirmCancel = false;
  let cancelSent = false;
  let lastTotal = 0;
  let lastWidth = 0;
  function statusLine(W) {
    const room = W - 3;
    const spin = C.cyan(SPIN[tick % SPIN.length]);
    const main = `${modelOf(meta)} · ${api.queued
      ? M.watchApiQueuedLive(clock(Date.now() - Date.parse(api.req)))
      : api.req
      ? M.watchApiLive(api.answering, clock(Date.now() - Date.parse(api.req)), (api.answering ? api.answerChars : api.chars).toLocaleString('en-US'))
      : M.watchLive({ time: clock(Date.now() - started), commands: stats.commands, searches: stats.searches, files: stats.files.size, plan: stats.plan })}`;
    if (cancelSent) return `${spin} ${C.yellow(fitWidth(`${main} · ${M.watchCancelSent}`, room))}`;
    if (confirmCancel) return `${spin} ${C.yellow(fitWidth(M.watchCancelConfirm(modelOf(meta)), room))}`;
    if (offset) return `${spin} ${C.yellow(fitWidth(`${main} · ${M.watchScrolled(offset)}`, room))}`;
    const text = main + (stats.latest && !api.req ? ` · ${stats.latest}` : '');
    const hint = api.queued && dir ? M.watchKeysQueued : M.watchKeys;
    if (textWidth(main) + textWidth(hint) + 2 > room) return `${spin} ${C.dim(fitWidth(text, room))}`;
    const body = fitWidth(text, room - textWidth(hint) - 2);
    return `${spin} ${C.dim(body)}${' '.repeat(room - textWidth(body) - textWidth(hint))}${C.dim(hint)}`;
  }
  function render(W, H) {
    const all = entries.flatMap((e) => linesOf(e, W));
    const room = Math.max(1, H - 1);
    // 往回翻着的时候来了新内容，画面停在原处不动
    if (offset && W === lastWidth) offset += all.length - lastTotal;
    lastTotal = all.length;
    lastWidth = W;
    offset = Math.max(0, Math.min(offset, all.length - room));
    const end = all.length - offset;
    const body = all.slice(Math.max(0, end - room), end);
    return [...body, ...Array(room - body.length).fill(''), statusLine(W)];
  }
  const onKeys = (d) => {
    const page = Math.max(1, (process.stdout.rows || 30) - 2);
    for (const k of splitKeys(d.toString('utf8'))) {
      if (k === '\x03' || k === 'q') { detach(k === '\x03' ? 130 : 0); return; }
      if ((k === 'x' || k === 'X') && api.queued && dir && !cancelSent) {
        if (confirmCancel) {
          fs.writeFileSync(path.join(dir, CANCEL_FILE), new Date().toISOString());
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
    for (const e of entries) for (const l of linesOf(e, cols())) process.stdout.write(`${l}\n`);
  };
  // 按 q 或 Ctrl+C 退出查看，任务照常运行
  const detach = (code) => {
    stopLive();
    process.stdout.write(`${C.dim(M.watchDetached)}\n`);
    process.exit(code);
  };

  const showApi = (ev) => {
    if (ev.type === 'api.request') {
      Object.assign(api, { req: ev.ts, begin: null, chars: 0, answerChars: 0, answering: false, queued: false });
      say(ev.ts, C.cyan('◆'), M.watchApiRequest(ev.model, ev.effort, ev.attempt));
    } else if (ev.type === 'api.queued') {
      // 服务繁忙，请求在排队：只在第一次记一笔，状态行显示已经等了多久
      if (!api.queued) say(ev.ts, C.yellow('⋯'), M.watchApiQueued, C.yellow, 1);
      api.queued = true;
    } else if ((ev.type === 'api.reasoning' || ev.type === 'api.content') && api.queued) {
      api.queued = false;
      api.begin = ev.ts;
      say(ev.ts, C.cyan('◆'), M.watchApiDequeued(M.duration((Date.parse(ev.ts) - Date.parse(api.req)) / 1000)));
      showApi(ev);
    } else if (ev.type === 'api.reasoning') {
      api.chars = ev.total_chars;
    } else if (ev.type === 'api.content') {
      // 回答是 JSON 报告，不逐字显示；开始回答时记一笔思考了多久
      if (!api.answering) {
        api.answering = true;
        const thought = (Date.parse(ev.ts) - Date.parse(api.begin || api.req)) / 1000; // 排过队的从开始处理算起
        say(ev.ts, C.cyan('◆'), api.chars ? M.watchApiThought(M.duration(thought), api.chars.toLocaleString('en-US')) : M.watchApiAnswering);
      }
      api.answerChars = ev.total_chars;
    } else if (ev.type === 'api.retry') say(ev.ts, C.yellow('⚠'), M.watchApiRetry(ev.reason, ev.wait_s), C.yellow, 3);
    else if (ev.type === 'api.repair') say(ev.ts, C.yellow('⚠'), M.watchApiRepair(M.list(ev.errors)), C.yellow, 3);
    else if (ev.type === 'api.error' && ev.kind === 'cancelled') { /* 用户终止，结尾那行会写明 */ }
    else if (ev.type === 'api.error' && ev.kind === 'busy') say(ev.ts, C.yellow('⚠'), M.watchApiDropped(M.duration(ev.waited_s || 0)), C.yellow, 2);
    else if (ev.type === 'api.error') say(ev.ts, C.red('✗'), oneLine(ev.message), C.red, 3);
  };

  const show = (ev) => {
    if (ev.type?.startsWith('api.')) { showApi(ev); return; }
    const it = ev.item || {};
    // 只有完成事件的工具调用，也要补出命令行供时间线显示。
    if (ev.type === 'item.completed' && it.type === 'command_execution' && !commands.has(it.id)) show({ ...ev, type: 'item.started' });
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      newBlock();
      const msg = ev.error?.message || ev.message || '';
      const re = RECONNECT.exec(msg);
      if (re) say(ev.ts, C.yellow('⚠'), M.watchReconnect(re[1], re[2]), C.yellow, 1);
      else say(ev.ts, C.red('✗'), oneLine(msg), C.red, 3);
    } else if (ev.type === 'image.generated') {
      flushFolded();
      sub(`  ▣ ${M.watchImage(path.basename(ev.path))}`, C.green);
    } else if (ev.type === 'item.started' && it.type === 'command_execution') {
      const text = oneLine(plainCommand(it.command));
      commands.set(it.id, text);
      stats.latest = `$ ${text}`;
      if (shownCommands < MAX_COMMANDS) { sub(`  $ ${text}`); lastCommand = it.id; shownCommands++; } else folded.add(it.id);
    } else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message') {
        const t = it.text.trim();
        if (t.startsWith('{')) { try { JSON.parse(t); return; } catch { /* 普通消息 */ } } // 最终报告在结束时单独显示
        newBlock();
        stats.latest = '';
        say(ev.ts, C.cyan('◆'), t);
      } else if (it.type === 'command_execution') {
        stats.commands++;
        if (it.exit_code === 0 || it.exit_code == null) return;
        const lines = String(it.aggregated_output || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean);
        folded.delete(it.id);
        if (lastCommand !== it.id && commands.has(it.id)) sub(`  $ ${commands.get(it.id)}`);
        sub(`    ✗ ${M.watchExit(it.exit_code, lines.length ? lines.slice(-2).join(' ⏎ ') : '')}`, C.red);
      } else if (it.type === 'file_change') {
        flushFolded();
        for (const c of it.changes || []) {
          stats.files.add(c.path);
          const line = `  ✎ ${M.fileKinds[c.kind] || c.kind} ${rel(c.path)}`;
          if (line === lastFile) continue; // 同一个文件连着改几次只显示一行
          sub(line, C.green);
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
        add(() => [node(t, C.yellow('◇')) + C.yellow(M.watchPlan(done, items.length))]);
        for (const x of items) sub(`  ${x.completed ? '✔' : '○'} ${x.text}`, x.completed ? C.dim : (s) => s);
      } else if (it.type === 'web_search') {
        const q = oneLine(it.query);
        if (!q) return;
        stats.searches++;
        stats.latest = `◎ ${q}`;
        flushFolded();
        sub(`  ◎ ${q}`);
      } else if (it.type === 'error' && !/^Under-development features enabled/.test(it.message)) {
        newBlock();
        say(ev.ts, C.yellow('⚠'), oneLine(it.message), C.yellow, 3);
      }
    }
  };

  const finish = (r, m) => {
    flushFolded();
    stopLive();
    live = false;
    const W = cols();
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
      if (shown < lines.length) write(indent + C.dim(M.watchMoreLines(lines.length - shown)));
    };
    write(rail().trimEnd());
    if (!r) {
      write(node(m?.ended_at, C.red('└')) + (m?.status === 'running' ? C.red(M.watchInterrupted) : M.watchEnded(m?.status)));
      return;
    }
    const blocked = r.status === 'needs_input' || r.status === 'done' && (r.needs_decision || r.report?.status === 'blocked');
    const ok = !blocked && r.status === 'done' && (!r.report?.status || r.report.status === 'completed');
    const color = ok ? C.green : blocked ? C.yellow : C.red;
    write(node(m?.ended_at, color('└')) + color(C.bold(`${ok ? '✔' : blocked ? '?' : '✗'} ${M.watchFinished(M.statusName(shownStatus(r.status, r)), M.duration(r.duration_s), changedFor(r, m))}`)));
    if (r.usage) write(' '.repeat(TIME_W + 2) + C.dim(M.tokenSummary(r.usage, r.last_request ?? r.context, M.tokenCount, (r.usage_scope ?? (m?.mode === 'resume' ? 'session_total' : 'this_run')) === 'session_total')));
    const summary = r.report?.summary || r.report?.position;
    if (summary) { write(); paragraph(summary, '  ', 12); }
    const issues = r.report?.open_issues || r.report?.open_questions || [];
    if (issues.length) {
      write();
      write(C.yellow(M.watchOpenIssues));
      for (const x of issues) paragraph(`· ${x}`, '  ', 4);
    }
    const asks = r.questions?.filter(needsDecision) ?? r.report?.decision_requests ?? [];
    if (asks.length) {
      write();
      write(C.yellow(M.watchDecisions));
      for (const d of asks) {
        const prefix = d.source === 'permission_denied' ? M.watchDeniedPrefix : d.source === 'input_prompt' ? M.watchInputPromptPrefix : '';
        paragraph(`· ${prefix}${d.question}`, '  ', 6);
        for (const o of d.options || []) paragraph(`- ${o}`, '    ', 3);
        if (d.recommendation) paragraph(M.watchRecommendation(d.recommendation), '    ', 4);
      }
    }
    const midRun = (r.questions || []).filter((q) => q.source === 'asked_mid_run');
    if (midRun.length) {
      write();
      write(C.yellow(M.watchAskedMidRun));
      for (const q of midRun) write(`  · ${fitWidth(oneLine(q.question), W - 5)}`);
    }
    for (const e of realErrors(r, ok)) write(r.status === 'needs_input'
      ? C.yellow(`? ${fitWidth(oneLine(e), W - 3)}`) : C.red(`✗ ${fitWidth(oneLine(e), W - 3)}`));
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

// 组视图里每个任务的信息流：从 events.jsonl 增量读取，整理成简短的条目，只留最近的一些；
// 同时记下命令数和 API 的思考进度，放在每块的标题行右侧。
function createFeed(run) {
  const cwd = run.meta.cwd;
  const rel = (p) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
  const file = path.join(run.dir, 'events.jsonl');
  const decoder = new TextDecoder('utf-8');
  const items = []; // { text, style, clip }：clip 的条目只占一行，超出截断；其余按面板宽度折行
  const stats = { commands: 0, api: false, req: null, chars: 0, answerChars: 0, answering: false, queued: false };
  let offset = 0;
  let buf = '';
  let thinking = null; // API 的思考内容一直追加在同一条里
  const commands = new Set();
  const push = (text, style, clip = true) => {
    items.push({ text, style, clip });
    if (items.length > 40) items.splice(0, items.length - 40);
  };
  const take = (ev) => {
    const it = ev.item || {};
    if (ev.type === 'item.completed' && it.type === 'command_execution' && !commands.has(it.id)) take({ ...ev, type: 'item.started' });
    if (ev.type === 'api.request') {
      Object.assign(stats, { api: true, req: ev.ts, chars: 0, answerChars: 0, answering: false, queued: false });
      thinking = null;
      push(M.watchApiRequest(ev.model, ev.effort, ev.attempt), 'dim');
    } else if (ev.type === 'api.queued') {
      if (!stats.queued) push(`⋯ ${M.watchApiQueued}`, 'yellow');
      stats.queued = true;
    } else if (ev.type === 'api.reasoning') {
      stats.queued = false;
      stats.chars = ev.total_chars;
      if (!thinking) { thinking = { text: '', style: 'dim', clip: false }; items.push(thinking); }
      thinking.text = (thinking.text + ev.text).slice(-3000);
    } else if (ev.type === 'api.content') {
      // 回答是 JSON 报告，不逐字展示，进度在标题行右侧
      stats.queued = false;
      stats.answering = true;
      stats.answerChars = ev.total_chars;
    } else if (ev.type === 'api.retry') push(M.watchApiRetry(ev.reason, ev.wait_s), 'yellow');
    else if (ev.type === 'api.repair') push(M.watchApiRepair(M.list(ev.errors)), 'yellow');
    else if (ev.type === 'api.error' && ev.kind === 'cancelled') stats.queued = false;
    else if (ev.type === 'api.error' && ev.kind === 'busy') { stats.queued = false; push(`⚠ ${M.watchApiDropped(M.duration(ev.waited_s || 0))}`, 'yellow'); }
    else if (ev.type === 'api.error' || ev.type === 'turn.failed' || ev.type === 'error') {
      const msg = oneLine(ev.message || ev.error?.message || '');
      const re = RECONNECT.exec(msg);
      push(re ? `⚠ ${M.watchReconnect(re[1], re[2])}` : `✗ ${msg}`, re ? 'yellow' : 'red');
    } else if (ev.type === 'image.generated') push(`▣ ${M.watchImage(path.basename(ev.path))}`, 'green');
    else if (ev.type === 'item.started' && it.type === 'command_execution') { commands.add(it.id); push(`$ ${oneLine(plainCommand(it.command))}`, 'dim'); }
    else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message') {
        const t = it.text.trim();
        if (t.startsWith('{')) { try { JSON.parse(t); return; } catch { /* 普通消息 */ } } // 最终报告在任务结束后显示
        push(t, null, false);
      } else if (it.type === 'command_execution') {
        commands.delete(it.id);
        stats.commands++;
        if (it.exit_code !== 0 && it.exit_code != null) push(`  ${M.watchExit(it.exit_code, '')}`, 'red');
      } else if (it.type === 'file_change') for (const c of it.changes || []) push(`✎ ${M.fileKinds[c.kind] || c.kind} ${rel(c.path)}`, 'green');
      else if (it.type === 'web_search') { if (oneLine(it.query)) push(`◎ ${oneLine(it.query)}`, 'dim'); }
      else if (it.type === 'todo_list') push(M.watchPlan((it.items || []).filter((x) => x.completed).length, (it.items || []).length), 'yellow');
      else if (it.type === 'error' && !/^Under-development features enabled/.test(it.message)) push(`⚠ ${oneLine(it.message)}`, 'yellow');
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
  return { read, items, stats };
}

// 组视图一块的标题：第一行左边是模型，右边是状态和用时（结束后加上改动），放不下右侧时只留左侧。
// 同组标题各不相同时（比如角色讨论、拆开的执行任务），第二行写这一块的标题，续接的讨论后面写上第几轮
function panelHead(run, stats, width, withTitle) {
  const { running, status, result: r, ok, blocked } = runOutcome(run);
  const m = run.meta;
  const elapsed = runEnd(run.dir, m) - Date.parse(m.started_at);
  const color = running ? C.cyan : ok ? C.green : blocked ? C.yellow : C.red;
  const left = `${running ? '●' : ok ? '✔' : blocked ? '?' : '✗'} ${whoOf(m)}`;
  const s = stats;
  const right = !running ? [M.statusName(shownStatus(status, r)), M.duration(r?.duration_s ?? elapsed / 1000), changedFor(r, m)].filter(Boolean).join(' · ')
    : s.queued ? M.watchApiQueuedLive(clock(Date.now() - Date.parse(s.req)))
    : s.req ? M.watchApiLive(s.answering, clock(elapsed), (s.answering ? s.answerChars : s.chars).toLocaleString('en-US'))
    : [M.statusName('running'), clock(elapsed), s.commands ? M.panelCommands(s.commands) : ''].filter(Boolean).join(' · ');
  let first;
  if (textWidth(right) + 16 > width) first = color(C.bold(fitWidth(left, width)));
  else {
    const l = fitWidth(left, width - textWidth(right) - 2);
    first = color(C.bold(l)) + ' '.repeat(width - textWidth(l) - textWidth(right)) + C.dim(right);
  }
  if (!withTitle || !m.title) return [first];
  const title = oneLine(m.title);
  // 标题以全角右括号结尾时（比如"多角色模式［边界清单员］"），括号本身带留白，"·"前不再加空格
  const gap = /[）］】》〉」』]$/.test(title) ? '' : ' ';
  const round = m.round > 1 && !title.includes(M.watchRound(m.round)) ? `${gap}· ${M.watchRound(m.round)}` : '';
  return [first, color(fitWidth(`  ${title}${round}`, width))];
}

// 组视图的一块：标题行加固定行数的正文。运行中显示最新的信息流，结束后显示结论。
function panelLines(run, feed, rows, width, withTitle) {
  const { running, result: r, ok } = runOutcome(run);
  const head = panelHead(run, feed.stats, width, withTitle);
  const inner = width - 2;
  let body = [];
  const final = r?.report?.position || r?.report?.summary;
  const errors = realErrors(r, ok);
  if (!running && (final || errors.length)) {
    if (final) body = wrapWidth(M.watchOpinion(final.trim()), inner).map((l) => ({ l }));
    for (const e of errors) body.push({ l: fitWidth(`${r.status === 'needs_input' ? '?' : '✗'} ${oneLine(e)}`, inner), style: r.status === 'needs_input' ? 'yellow' : 'red' });
    body = body.slice(0, rows);
  } else {
    for (const item of feed.items) {
      const lines = item.clip ? [fitWidth(item.text, inner)] : wrapWidth(item.text.trim(), inner);
      for (const l of lines) body.push({ l, style: item.style });
    }
    body = body.slice(-rows);
    if (!body.length && running) body.push({ l: M.noEvents, style: 'dim' });
  }
  while (body.length < rows) body.push({ l: '' });
  return [...head, ...body.map(({ l, style }) => `  ${style ? C[style](l) : l}`)];
}

// 组的标题行右侧：运行中、完成、失败各几个，为 0 的不写
function groupCounts(all) {
  const { running, ok, blocked, failed, resumed } = groupTally(all);
  return [running && C.cyan(M.groupCount.running(running)), ok && C.green(M.groupCount.ok(ok)), resumed && C.dim(M.groupCount.resumed(resumed)), blocked && C.yellow(M.groupCount.blocked(blocked)), failed && C.red(M.groupCount.failed(failed))].filter(Boolean).join(C.dim(' · '));
}

// 组的标题行：左边是组名和标题，右边是各状态的个数，放不下右侧时只留左侧
function groupHeadLine(group, title, all, width) {
  const counts = groupCounts(all);
  const countsW = textWidth(counts.replace(/\x1b\[[0-9;]*m/g, ''));
  if (countsW + 14 > width) return C.bold(fitWidth(M.groupHeader(group, title, all.length), width));
  const left = fitWidth(M.groupHeader(group, title, all.length), width - countsW - 2);
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
    if (waited === 0 && !runs.length) process.stdout.write(`${M.watchWaiting}\n`);
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
    return [[...titles][0], round > 1 ? M.watchRound(round) : ''].filter(Boolean).join(' · ');
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
      // 顶部标题一行、底部提示一行，每块有分隔线和标题（没有公共标题时多一行写各自的标题）；正文行数按窗口高度平均分，最多 8 行
      const title = sharedTitle();
      const headRows = title ? 2 : 3;
      const rows = Math.max(2, Math.min(8, Math.floor((H - 2 - all.length * headRows) / all.length)));
      const out = [groupHeadLine(group, title, all, width)];
      for (const run of all) out.push(C.dim('─'.repeat(width)), ...panelLines(run, feeds.get(run.id), rows, width, !title));
      const lines = out.slice(0, H - 1);
      while (lines.length < H - 1) lines.push('');
      const queued = queuedRuns();
      if (confirmCancel && queued.length) lines.push(C.yellow(fitWidth(M.dashCancelConfirm(M.list(queued.map((run) => modelOf(run.meta)))), width)));
      else lines.push((queued.length ? C.yellow : C.dim)(fitWidth(queued.length ? M.dashHintQueued : M.dashHint, width)));
      return lines;
    };
    const screen = liveScreen(render);
    const onKeys = (d) => {
      for (const k of splitKeys(d.toString('utf8'))) {
        if (k === '\x03' || k === 'q') { screen.stop(); process.exit(k === '\x03' ? 130 : 0); }
        if ((k === 'x' || k === 'X') && queuedRuns().length) {
          if (confirmCancel) {
            for (const run of queuedRuns()) { fs.writeFileSync(path.join(run.dir, CANCEL_FILE), new Date().toISOString()); cancelSent.add(run.id); }
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
    process.stdout.write(`${M.groupHeader(group, sharedTitle(), known.size)}\n`);
    const states = new Map();
    for (;;) {
      for (const run of known.values()) {
        const { status, result } = runOutcome(run);
        const shown = M.statusName(shownStatus(status, result));
        if (states.get(run.id) !== shown) process.stdout.write(`${whoOf(run.meta)}  ${shown}\n`);
        states.set(run.id, shown);
      }
      if (settled()) break;
      await sleep(2000);
      runs = recentRuns();
      refresh();
    }
  }

  // 最终汇总：写在正常屏幕里，排版和实时面板一致（标题行、分隔线、每块的标题行），正文不限行数。
  const all = [...known.values()];
  const title = sharedTitle();
  const width = Math.max(20, (process.stdout.columns || 100) - 1);
  const inner = width - 2;
  const out = ['', groupHeadLine(group, title, all, width)];
  for (const run of all) {
    const { result: r, ok } = runOutcome(run);
    out.push(C.dim('─'.repeat(width)), ...panelHead(run, feeds.get(run.id).stats, width, !title));
    if (r?.usage) out.push(`  ${C.dim(fitWidth(M.tokenSummary(r.usage, r.last_request ?? r.context, M.tokenCount, (r.usage_scope ?? (run.meta.mode === 'resume' ? 'session_total' : 'this_run')) === 'session_total'), inner))}`);
    const final = r?.report?.position || r?.report?.summary;
    if (final) for (const l of wrapWidth(M.watchOpinion(final.trim()), inner)) out.push(`  ${l}`);
    for (const e of realErrors(r, ok)) for (const l of wrapWidth(`${r.status === 'needs_input' ? '?' : '✗'} ${oneLine(e)}`, inner)) {
      out.push(`  ${(r.status === 'needs_input' ? C.yellow : C.red)(l)}`);
    }
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
