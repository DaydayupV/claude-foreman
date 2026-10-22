// 实时查看的入口：单任务视图和详细模式。组视图在 watch-group.mjs，时间线的排版在 watch-timeline.mjs，
// 屏幕和按键在 watch-screen.mjs；都只读取统一记录。
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_ROOT, requestCancel, listRuns, findRun, readMeta, checkRunners, isRunning } from './records.mjs';
import { M, die, sleep, clip, oneLine, plainCommand, RECONNECT, modelOf, agentTypeOf, fitWidth, textWidth } from './util.mjs';
import { D, C, termCols, termRows, shortModel, fullModel, modelLabel, taskLine, identityLine, clock, outcomeStyle, changedFor, usageLine, commandAction } from './format.mjs';
import { liveCapable, interactive, liveScreen, splitKeys, scroller, LEAVE_SCREEN, kindOf, introWanted, introOf } from './watch-screen.mjs';
import { createTimeline, reviewConclusion, resultOutcome, durationOf, finishedParts, liveStatus, eventReader, hhmm } from './watch-timeline.mjs';
import { introScene, playIntro } from './watch-intro.mjs';
import { watchGroup } from './watch-group.mjs';

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
      out(f.color(f.mark), f.color(f.word) + f.rest, m?.ended_at);
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
// 底部一行：左边写提示，右边写按键，放不下时只留左边
function footLine(lead, left, keys, W) {
  const room = W - 1 - textWidth(lead.replace(/\x1b\[[0-9;]*m/g, ''));
  if (!keys || textWidth(left.text) + textWidth(keys) + 2 > room) return lead + left.color(fitWidth(left.text, room));
  return lead + left.color(left.text) + ' '.repeat(room - textWidth(left.text) - textWidth(keys)) + C.dim(keys);
}

// 单任务视图：顶部固定身份行和任务行，中间是时间线（方向键、翻页键、滚轮往回翻），底部一行是最近的思考和按键。
// 结束后有人能按键时停在画面里，按 q 离开，再把完整的记录写进普通屏幕留在标签页里；没人能按键时直接写。
function singleView(meta, tl, dir) {
  const sc = scroller({ fromBottom: true });
  const api = tl.state.api;
  let ended = null; // 结束后：{ o, durationS }
  let tick = 0;
  let ticker = null;
  let confirmCancel = false;
  let cancelSent = false;
  let lastTotal = 0;
  let lastWidth = 0;
  let onQuit = null;
  const footer = (W) => {
    const lead = ended ? '' : `${C.cyan(SPIN[tick % SPIN.length])} `;
    if (cancelSent) return footLine(lead, { text: D.watchCancelSent, color: C.yellow }, '', W);
    if (confirmCancel) return footLine(lead, { text: D.watchCancelConfirm(shortModel(modelOf(meta))), color: C.yellow }, '', W);
    if (sc.offset) return footLine(lead, { text: D.watchScrolled(sc.offset), color: C.yellow }, '', W);
    if (ended) {
      const style = outcomeStyle(ended.o);
      return footLine(`${style.color(style.mark)} `, { text: D.watchFinishedNote, color: C.dim }, D.watchFinishedKeys, W);
    }
    const { speech, thought } = tl.state;
    const text = thought && (!speech || thought.seq > speech.seq) ? D.watchThinking(thought.text) : '';
    return footLine(lead, { text, color: C.dim }, api.queued ? D.watchKeysQueued : D.watchKeys, W);
  };
  const render = (W, H) => {
    const top = runHead(meta, ended, api, W);
    const all = tl.lines(W);
    // 往回翻着的时候来了新内容，画面停在原处不动
    if (sc.offset && W === lastWidth) sc.offset += all.length - lastTotal;
    lastTotal = all.length;
    lastWidth = W;
    const { shown } = sc.view(all, Math.max(1, H - top.length - 1));
    return [...top, ...shown, footer(W)];
  };
  const screen = liveScreen(render);
  // 离开画面：恢复终端，把完整的记录写进普通屏幕
  const leave = () => {
    clearInterval(ticker);
    if (!screen.active) return;
    screen.stop();
    if (process.stdin.isTTY) { process.stdin.off('data', onKeys); process.stdin.setRawMode(false); process.stdin.pause(); }
    const W = termCols();
    process.stdout.write(`\n${[...runHead(meta, ended, api, W), ...tl.lines(W)].join('\n')}\n`);
  };
  // 按 q 或 Ctrl+C：运行中是退出查看（任务照常运行），结束后是离开画面
  const quit = (code) => {
    leave();
    if (ended && onQuit) { onQuit(code); return; }
    process.stdout.write(`${C.dim(D.watchDetached)}\n`);
    process.exit(code);
  };
  function onKeys(d) {
    const page = Math.max(1, termRows() - 5);
    for (const k of splitKeys(d.toString('utf8'))) {
      if (k === '\x03' || k === 'q') { quit(k === '\x03' ? 130 : 0); return; }
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
  }
  return {
    start() {
      screen.start();
      ticker = setInterval(() => { tick++; screen.draw(); }, 250);
      if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onKeys); }
      process.on('SIGINT', () => quit(130));
      process.on('exit', () => screen.stop());
    },
    // 任务结束：停在画面里等 q；没人能按键时直接离开
    finished(r, m, o) {
      ended = { o: o ?? { running: false, status: m?.status ?? 'interrupted', ok: false, blocked: false }, durationS: durationOf(r, m) };
      clearInterval(ticker);
      cancelSent = false;
      confirmCancel = false;
      if (!interactive()) { leave(); return Promise.resolve(0); }
      screen.draw();
      return new Promise((resolve) => { onQuit = resolve; });
    },
  };
}

// 执行和图像的续接不记轮次，按续接链往回数
function roundOf(meta) {
  if (meta.round != null || !meta.parent) return meta.round;
  let n = 1;
  for (let id = meta.parent; id && n < 100; n++) id = readMeta(path.join(RUNS_ROOT, id))?.parent;
  return n;
}

async function watchRun(o, loadCfg) {
  const { id, dir, meta } = await pickWatchRun(o.run);
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
  const cwd = meta.cwd;
  const rel = (p) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
  const running = isRunning(meta);
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
    if (screenMode) view = singleView(meta, tl, dir);
    else {
      // 直接输出：先写顶部两行（已经结束的写结果），再随事件写时间线
      const r = running ? null : readResult(dir);
      const ended = r ? { o: resultOutcome(r), durationS: durationOf(r, meta) } : null;
      process.stdout.write(`\n${runHead(meta, ended, tl.state.api, termCols()).join('\n')}\n`);
    }
  }

  const read = eventReader(dir, show);
  read();
  goLive();
  if (view) { view.start(); handOff?.(); } // 实时画面接手了备用屏幕，由它负责退出时恢复终端
  let m = readMeta(dir);
  while (isRunning(m)) {
    await sleep(500);
    read();
    m = readMeta(dir);
  }
  read();
  const r = readResult(dir);
  const outcome = finish(r, m ?? meta);
  // 结束后按 Ctrl+C 离开的，退出码和中断一致
  if (view && await view.finished(r, m ?? meta, outcome) === 130) process.exitCode = 130;
}

async function cmdWatch(o, loadCfg) {
  if (o.group != null) return watchGroup(o.group, o, loadCfg);
  return watchRun(o, loadCfg);
}

export { cmdWatch };
