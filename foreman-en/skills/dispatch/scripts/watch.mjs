// 实时查看的入口：单任务视图和详细模式。组视图在 watch-group.mjs，时间线的排版在 watch-timeline.mjs，
// 屏幕和按键在 watch-screen.mjs；都只读取统一记录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RUNS_ROOT, requestCancel, listRuns, findRun, readMeta, checkRunners, isRunning } from './records.mjs';
import { M, die, sleep, clip, oneLine, plainCommand, RECONNECT, modelOf, agentTypeOf, fitWidth, textWidth } from './util.mjs';
import { D, C, termCols, termRows, shortModel, fullModel, modelLabel, taskLine, identityLine, clock, outcomeStyle, changedFor, outsideCwdText, usageLine, commandAction } from './format.mjs';
import { liveCapable, interactive, listenKeys, stopKeys, liveScreen, readKeys, scroller, LEAVE_SCREEN, kindOf, introWanted, introOf } from './watch-screen.mjs';
import { createTimeline, reviewConclusion, resultOutcome, durationOf, finishedParts, liveStatus, eventReader, hhmm } from './watch-timeline.mjs';
import { introScene, playIntro } from './watch-intro.mjs';
import { watchGroup } from './watch-group.mjs';
import { roundOf as displayRoundOf } from './display.mjs';

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const readResult = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch { return null; } };

// 详细模式开头的信息行：用原词写模式和等级；图像任务用格子和路线代替等级
function headerLines(meta, id, dir) {
  const lines = D.watchHeaderLines(meta.mode, meta.title || id, meta.level, meta.cwd, dir, fullModel(meta));
  if (meta.module === 'image') lines[0] = D.watchImageHead(meta.mode === 'resume' ? 'resume' : 'image', meta.title || id, meta.cell, '①②③④'[meta.route - 1]);
  return lines;
}

async function pickWatchRun(ref) {
  if (ref) return findRun(ref);
  // 刚派活时任务可能还没登记，等一会儿；仍没有就显示最近一次。
  for (let waited = 0; ; waited += 500) {
    const ids = listRuns();
    const runs = ids.map((id) => ({ id, meta: readMeta(path.join(RUNS_ROOT, id)) }));
    checkRunners(runs.map((run) => run.meta));
    const running = runs.find((run) => isRunning(run.meta))?.id;
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
      // Codex 续接的那一轮报的是整个会话的累计用量，不是这一轮的：不显示，结尾的用量行按这一轮算
      if (!meta.parent) o('Σ', D.watchTokens(ev.usage));
    } else if (ev.type === 'foreman.snapshot') {
      o('⋯', ev.phase === 'start' ? D.watchSnapshotStart : D.watchSnapshotDone(D.duration(ev.seconds ?? 0)));
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
      out(f.color(f.mark), f.color(f.word) + f.rest, m?.ended_at);
      const outside = outsideCwdText(r, m);
      if (outside) out(C.yellow('⚠'), C.yellow(outside), m?.ended_at);
    } else out(C.red('✗'), m?.status === 'running' ? D.watchInterrupted : D.watchEnded(m?.status), m?.ended_at);
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

// 单任务顶部的身份行：运行中按实时状态，结束后按结果，Claude Code 席写提交时间
function runIdentity(meta, ended, api, width) {
  if (meta.participant === 'host') return identityLine(meta, { mark: '✔', color: C.green }, [D.statusName('submitted'), hhmm(meta.submitted_at)], width);
  if (ended) {
    const style = outcomeStyle(ended.o);
    return identityLine(meta, style, [style.word, Number.isFinite(ended.durationS) ? clock(ended.durationS * 1000) : null], width);
  }
  const live = liveStatus(meta, api);
  return identityLine(meta, live, live.right, width);
}
// 顶部两行加分隔线：身份行和任务行（整行加粗）
const runHead = (meta, ended, api, W) => [runIdentity(meta, ended, api, W - 1), `  ${C.bold(fitWidth(taskLine(meta, { title: meta.title || meta.id }), W - 3))}`, C.dim('─'.repeat(W - 1))];
// 底部一行：左边写提示，右边写按键。放不下时先截短左边，留给左边的不到 8 列才去掉按键（没有左边就截短按键）
function footLine(lead, left, keys, W) {
  const room = W - 1 - textWidth(lead.replace(/\x1b\[[0-9;]*m/g, ''));
  const space = room - textWidth(keys) - 2;
  if (!keys || (left.text && space < 8)) return lead + left.color(fitWidth(left.text, room));
  if (space < 0) return lead + C.dim(fitWidth(keys, room));
  const text = fitWidth(left.text, space);
  return lead + left.color(text) + ' '.repeat(room - textWidth(text) - textWidth(keys)) + C.dim(keys);
}

// 续接出来的最新一轮：顺着 meta.parent 往下找（续接只能接在最新一轮后面，每轮最多一个后继）。
// 后继登记得晚，run_id 排在后面（登记时保证递增），只读排在后面的记录；读到的 parent 记着，不再重读
function descendants() {
  const parents = new Map();
  return (id) => {
    let names;
    try { names = fs.readdirSync(RUNS_ROOT); } catch { return null; }
    const children = new Map();
    for (const x of names) {
      if (x <= id) continue;
      if (!parents.has(x)) {
        const m = readMeta(path.join(RUNS_ROOT, x), { settle: false });
        if (!m) continue; // 还没写好 meta.json 的（或者不是任务目录），下次再读
        parents.set(x, m.parent ?? null);
      }
      const p = parents.get(x);
      if (p && (!children.has(p) || x > children.get(p))) children.set(p, x);
    }
    let latest = null;
    const seen = new Set([id]);
    for (let next = children.get(id); next && !seen.has(next); next = children.get(next)) { latest = next; seen.add(next); }
    return latest;
  };
}
// 续接的提示：放不下整句时先去掉 run_id，再换更短的说法，最后才截断
const continuedLine = (id, W) => C.dim(fitWidth([D.watchContinued(id), D.watchContinuedShort].find((s) => textWidth(s) <= W - 1) ?? D.watchContinuedTiny, W - 1));

// 单任务视图：顶部固定身份行和任务行，中间是时间线（方向键、翻页键、滚轮往回翻），底部一行是最近的思考和按键。
// 结束后有人能按键时停在画面里，按 q 离开，再把完整的记录写进普通屏幕留在标签页里；没人能按键时直接写。
// 这一轮被续接了（latest 找得到后继）时，底部上面多一行提示，按 n 换成最新的一轮
function singleView(meta, tl, dir, latest) {
  const sc = scroller({ fromBottom: true });
  let api = tl.state.api;
  let ended = null; // 结束后：{ o, durationS }
  let tick = 0;
  let ticker = null;
  let watcher = null; // 结束后每秒看一次有没有续接
  let started = false;
  let next = null; // 续接出来的最新一轮
  let following = null; // 按了 n 要跟过去的那一轮
  let confirmCancel = false;
  let cancelSent = false;
  let lastTotal = 0;
  let lastWidth = 0;
  let onQuit = null;
  const check = () => { const id = latest(meta.id); if (id === next) return false; next = id; return true; };
  const tickOn = () => { ticker = setInterval(() => { if (++tick % 4 === 0) check(); screen.draw(); }, 250); };
  const footer = (W) => {
    const lead = ended ? '' : `${C.cyan(SPIN[tick % SPIN.length])} `;
    if (cancelSent) return footLine(lead, { text: D.watchCancelSent, color: C.yellow }, '', W);
    if (confirmCancel) return footLine(lead, { text: D.watchCancelConfirm(shortModel(modelOf(meta))), color: C.yellow }, '', W);
    if (sc.offset) return footLine(lead, { text: D.watchScrolled(sc.offset), color: C.yellow }, '', W);
    if (ended) {
      const style = outcomeStyle(ended.o);
      return footLine(`${style.color(style.mark)} `, { text: D.watchFinishedNote, color: C.dim }, D.watchFinishedKeys, W);
    }
    const { speech, thought, snapshotting } = tl.state;
    const keys = api.queued ? D.watchKeysQueued : D.watchKeys;
    // 拍快照的提示放不下整句时换成短的说法，不在单词中间截断
    const room = W - 1 - textWidth(lead.replace(/\x1b\[[0-9;]*m/g, '')) - textWidth(keys) - 2;
    const snapshot = [D.watchSnapshotStart, D.watchSnapshotShort, D.watchSnapshotTiny].find((s) => textWidth(s) <= room) ?? D.watchSnapshotMini;
    const text = snapshotting ? snapshot : thought && (!speech || thought.seq > speech.seq) ? D.watchThinking(thought.text) : '';
    return footLine(lead, { text, color: C.dim }, keys, W);
  };
  const render = (W, H) => {
    const top = runHead(meta, ended, api, W);
    const all = tl.lines(W);
    // 往回翻着的时候来了新内容，画面停在原处不动
    if (sc.offset && W === lastWidth) sc.offset += all.length - lastTotal;
    lastTotal = all.length;
    lastWidth = W;
    const tail = next ? [continuedLine(next, W)] : [];
    const { shown } = sc.view(all, Math.max(1, H - top.length - 1 - tail.length));
    return [...top, ...shown, ...tail, footer(W)];
  };
  const screen = liveScreen(render);
  // 离开画面：恢复终端，把完整的记录写进普通屏幕；续接过的在最后写一句续接成了哪一轮
  const leave = () => {
    clearInterval(ticker);
    clearInterval(watcher);
    if (!screen.active) return;
    screen.stop();
    if (interactive()) stopKeys(onKeys);
    const W = termCols();
    const after = next ? ['', C.dim(D.watchContinuedOut(next))] : [];
    process.stdout.write(`\n${[...runHead(meta, ended, api, W), ...tl.lines(W), ...after].join('\n')}\n`);
  };
  // 按 n：结束后等着按键的直接交回 watchRun，运行中的由它在下次读取时换过去
  const follow = () => {
    following = next;
    clearInterval(watcher);
    const done = onQuit;
    onQuit = null;
    done?.({ follow: following });
  };
  // 按 q 或 Ctrl+C：运行中是退出查看（任务照常运行），结束后是离开画面
  const quit = (code) => {
    leave();
    if (ended && onQuit) { onQuit(code); return; }
    process.stdout.write(`${C.dim(D.watchDetached)}\n`);
    process.exit(code);
  };
  const onKeys = readKeys((keys) => {
    const page = Math.max(1, termRows() - 5);
    for (const k of keys) {
      if (k === '\x03' || k === 'q') { quit(k === '\x03' ? 130 : 0); return; }
      if ((k === 'n' || k === 'N') && next && !following) { follow(); return; }
      // 排队时按 x 终止：第一次按要求确认，第二次才写终止标记
      if ((k === 'x' || k === 'X') && api.queued && !ended && !cancelSent) {
        if (confirmCancel) { requestCancel(dir, 'watch'); cancelSent = true; }
        confirmCancel = !confirmCancel && !cancelSent;
        continue;
      }
      confirmCancel = false;
      sc.key(k, page);
    }
    screen.draw();
  });
  const start = () => {
    if (started) return;
    started = true;
    check();
    process.on('SIGINT', () => quit(130));
    process.on('SIGTERM', () => process.exit(143));
    process.on('exit', () => { screen.stop(); if (interactive()) stopKeys(onKeys); });
    screen.start();
    if (!ended) tickOn();
    if (interactive()) listenKeys(onKeys);
  };
  return {
    start,
    get following() { return following; },
    // 任务结束：停在画面里等 q；没人能按键时直接离开。打开时就已经结束的，到这里才进画面，第一帧就是结束的样子
    finished(r, m, o, onStart) {
      ended = { o: o ?? { running: false, status: m?.status ?? 'interrupted', ok: false, blocked: false }, durationS: durationOf(r, m) };
      clearInterval(ticker);
      cancelSent = false;
      confirmCancel = false;
      if (!screen.active) { start(); onStart?.(); }
      if (!interactive()) { leave(); return Promise.resolve(0); }
      check();
      watcher = setInterval(() => { if (check()) screen.draw(); }, 1000);
      screen.draw();
      return new Promise((resolve) => { onQuit = resolve; });
    },
    // 跟到续接的一轮：同一个画面换成它的时间线，从第一个事件排起，停在最新处。
    // 这里不画：读完它的事件后，运行中的由计时器画，已经结束的由 finished 画，免得先闪一下"运行中"
    load(m, t, d) {
      clearInterval(ticker);
      clearInterval(watcher);
      [meta, tl, dir, api] = [m, t, d, t.state.api];
      ended = null; next = null; following = null; onQuit = null;
      confirmCancel = false; cancelSent = false;
      sc.offset = 0; lastTotal = 0;
      check();
      tickOn();
    },
  };
}

// 执行和图像的续接不记轮次，按续接链往回数
function roundOf(meta) {
  const byId = new Map();
  // 记录写坏了、续接链绕成环时也要停下：按步数封顶，遇到读过的 id 就不再往回走
  for (let id = meta.parent, n = 0; id && n < 100 && !byId.has(id); n++) {
    const parent = readMeta(path.join(RUNS_ROOT, id));
    byId.set(id, parent); id = parent?.parent;
  }
  return displayRoundOf(meta, byId);
}

async function watchRun(o, loadCfg) {
  let { id, dir, meta } = await pickWatchRun(o.run);
  meta.id ??= id;
  meta.round = roundOf(meta);
  const host = meta.participant === 'host';
  let handOff = null;
  if (!host && introWanted(o, [meta], loadCfg)) {
    // 时间线也画在备用屏幕里，动画结束后不用退出；--verbose 逐行输出在普通屏幕里，要先退出
    handOff = await playIntro(introScene({ mode: meta.mode, kind: kindOf(meta), participants: [introOf(meta)] }), {
      keepScreen: !o.verbose,
      isOver: () => { const m = readMeta(dir); return !!m && !isRunning(m); },
    });
  }
  const relOf = (cwd) => (p) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
  const rel = relOf(meta.cwd);
  const running = isRunning(meta);
  const latest = descendants();
  // 任务还在运行、或者有人能按键时，画在可以随窗口重排、能翻看的画面里；否则直接输出
  const screenMode = !o.verbose && liveCapable() && (running || interactive());
  // 动画期间任务就结束了：时间线不进实时画面，先离开动画留下的备用屏幕（--verbose 时动画已经自己离开过，不再离开一次）
  if (handOff && !screenMode) {
    if (!o.verbose) process.stdout.write(LEAVE_SCREEN);
    handOff();
    handOff = null;
  }

  let show;
  let finish;
  let goLive;
  let view = null;
  if (o.verbose && !host) {
    const v = (agentTypeOf(meta) === 'api' ? apiVerboseRenderer : verboseRenderer)(meta, rel);
    v.header(id, dir);
    ({ show, finish, goLive } = v);
  } else {
    const tl = createTimeline(meta, rel, { stream: !screenMode });
    ({ show, finish, goLive } = tl);
    if (screenMode) view = singleView(meta, tl, dir, latest);
    else {
      // 直接输出：先写顶部两行（已经结束的写结果），再随事件写时间线
      const r = running ? null : readResult(dir);
      const ended = r ? { o: resultOutcome(r), durationS: durationOf(r, meta) } : null;
      process.stdout.write(`\n${runHead(meta, ended, tl.state.api, termCols()).join('\n')}\n`);
    }
  }

  // 实时画面里按 n 跟到续接的一轮时，换成它的记录再走一遍
  for (;;) {
    const read = eventReader(dir, show);
    read();
    goLive();
    if (view && running) { view.start(); handOff?.(); } // 实时画面接手了备用屏幕，由它负责退出时恢复终端
    let m = readMeta(dir);
    while (isRunning(m) && !view?.following) {
      await sleep(500);
      read();
      m = readMeta(dir);
    }
    if (!view?.following) {
      read();
      const r = readResult(dir);
      const outcome = finish(r, m ?? meta);
      if (!view) {
        // 直接输出的，已经被续接了就在最后写一句
        const next = latest(id);
        if (next) process.stdout.write(`\n${C.dim(D.watchContinuedOut(next))}\n`);
        return;
      }
      const code = await view.finished(r, m ?? meta, outcome, () => handOff?.());
      if (code === 130) process.exitCode = 130; // 结束后按 Ctrl+C 离开的，退出码和中断一致
      if (typeof code === 'number') return;
    }
    ({ id, dir, meta } = findRun(view.following));
    meta.id ??= id;
    meta.round = roundOf(meta);
    const tl = createTimeline(meta, relOf(meta.cwd));
    ({ show, finish, goLive } = tl);
    view.load(meta, tl, dir);
  }
}

async function cmdWatch(o, loadCfg) {
  if (o.group != null) return watchGroup(o.group, o, loadCfg);
  return watchRun(o, loadCfg);
}

// 这个文件只给 cli.mjs 引用；有人照着文件名直接运行它时，不能一声不响地退出
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 直接运行时记录模块还没初始化（RUNS_ROOT 为空），按默认记录目录给路径
  process.stderr.write(`${M.watchDirect(path.join(RUNS_ROOT ?? path.join(os.homedir(), '.claude', 'foreman', 'runs'), 'watch.mjs'))}\n`);
  process.exitCode = 2;
}

export { cmdWatch };
