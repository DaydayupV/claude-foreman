// 组视图：一组任务（讨论、审查的各席，或者并发拆分的几份）排在一个画面里。
// 标题行写 <模块> · <模式> · <标题> · <等级>[ · round N]，右边是各状态的个数；计划只在有缺口时多写一行。
// Claude Code 席排在最前（席位号 0）；每席是身份行、分工行和正文，按席位号打开那一席的完整时间线。
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_ROOT, CLAUDE_SESSION, requestCancel, readMeta, checkRunners, isRunning, runOutcome, groupRuns, queuedRuns as queuedDispatches } from './records.mjs';
import { loadPlan } from './plan.mjs';
import { M, die, sleep, modelOf, textWidth, fitWidth, wrapWidth } from './util.mjs';
import { D, C, termCols, termRows, visibleWidth, shortModel, modelLabel, seatLine, identityLine,
  usageLine, paintPlanWord, replayCommand } from './format.mjs';
import { liveCapable, interactive, listenKeys, stopKeys, liveScreen, readKeys, scroller, LEAVE_SCREEN, kindOf, introWanted, introOf } from './watch-screen.mjs';
import { createTimeline, eventReader, wrapAtDots } from './watch-timeline.mjs';
import { introScene, playIntro } from './watch-intro.mjs';
import { finalLines as displayFinalLines, liveLines as displayLiveLines, groupTask as displayGroupTask, current, planNotes as displayPlanNotes, seatNumbers, roundOf, queuedStarted,
  seatState as displaySeatState, countsText as displayCountsText, collapseLines, dashFooter, queuedLine, seatUsage as displaySeatUsage } from './display.mjs';

const LIVE_MIN = 3;
const DONE_MIN = 2;
const MAX_ROWS = 12;
const isHost = (run) => run.meta.participant === 'host';
const seatState = (run, feed) => displaySeatState(run.meta, feed.outcome?.result, feed.tl.state.api, Date.now(), C, feed.outcome ?? runOutcome(run));
const countsText = (states) => displayCountsText(states).split(' ').map((s) =>
  (s.startsWith('●') ? C.cyan : s.startsWith('✔') ? C.green : /^[?◐⋯]/.test(s) ? C.yellow : C.red)(s)).join(' ');
const finalLines = (run, result, ok, inner) => displayFinalLines(run, result, ok, inner, C);
const liveLines = (state, rows, inner) => displayLiveLines(state, rows, inner, C);

// 一席想写多少行正文：运行中按内容估，结束后是结论的行数
function wantRows(run, feed, inner) {
  if (feed.state.running) {
    const s = feed.tl.state;
    // 还没有内容的也留一行写"进行中"（API 协作方的状态已经写在身份行右边，不留）
    return Math.max(s.api.req ? 0 : 1, Math.min(MAX_ROWS, (s.speech ? Math.min(3, wrapWidth(s.speech.text, inner - 2).length) : 0) + (s.thought ? 1 : 0) + Math.min(s.recent.length, 8)));
  }
  return feed.final(inner).length;
}

// 每席的用量：改动、用量和费用按" · "折行，run_id 靠右写在最后一行，放不下就另起一行。
// 汇总里（keepId）run_id 不截短，要能照着补全回看命令；实时画面里按宽度截
function usageRows(text, id, width, keepId = false) {
  const lines = text ? wrapAtDots(text, width) : [];
  const tail = lines.pop() ?? '';
  const rows = lines.map((l) => C.dim(l));
  const shownId = keepId ? id : fitWidth(id, width);
  if (textWidth(tail) + 2 + textWidth(shownId) <= width) rows.push(C.dim(tail) + ' '.repeat(width - textWidth(tail) - textWidth(shownId)) + C.dim(shownId));
  else rows.push(...(tail ? [C.dim(tail)] : []), ' '.repeat(Math.max(0, width - textWidth(shownId))) + C.dim(shownId));
  return rows;
}

// 每席的信息流：一份时间线（打开这一席时显示，也给正文提供最近说的话和动作），结束时补上结尾。
// feed.run 跟着列表刷新换成最新读到的记录；结果读到以后不再重读。结束了却一时读不到结果的，
// 过几次再补结尾，免得把暂时读不到当成没有结果
const RESULT_RETRIES = 10;
function createSeat(run) {
  const rel = (p) => { const r = path.relative(run.meta.cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
  const tl = createTimeline(run.meta, rel);
  const read = isHost(run) ? () => {} : eventReader(run.dir, tl.show);
  let finished = false;
  let misses = 0;
  const feed = { run, tl, state: { running: true } };
  feed.update = () => {
    if (finished) return;
    read();
    tl.goLive(); // 旧记录的事件没有时间，读完已有的以后用收到的时间
    const o = runOutcome(feed.run);
    feed.state.running = !isHost(feed.run) && o.running;
    feed.outcome = o;
    if (feed.state.running) return;
    if (o.result || ++misses >= RESULT_RETRIES) { finished = true; tl.finish(o.result, feed.run.meta); }
  };
  feed.final = (inner) => finalLines(feed.run, feed.outcome?.result, isHost(feed.run) || feed.outcome?.ok || feed.outcome?.partial, inner);
  return feed;
}

// 结束了的一席在结论下面写一行用量：执行任务先写改动，再写 token 和费用，run_id 靠右；
// Claude Code 席没有用量，写明是它提交的报告。运行中的不写
function seatUsage(run, feed, inner, keepId = false) {
  if (feed.state.running) return [];
  const r = feed.outcome?.result;
  const usage = displaySeatUsage(run.meta, r, usageLine(r, run.meta));
  return usageRows(usage, run.id, inner, keepId);
}

// 一席的几行：身份行、分工行、正文，结束了的再加用量。运行中还没有任何可写的（讨论席常常只在最后交回结果），写一行"进行中"
function seatBlock(run, feed, rows, width, no, split, collapse = false) {
  const st = seatState(run, feed);
  const lead = no != null ? '    ' : '  ';
  const inner = width - lead.length;
  const out = [identityLine(run.meta, st.style, st.right, width, no)];
  const second = seatLine(run.meta, { title: split, width: inner });
  if (second) out.push(lead + second);
  let body = feed.state.running ? liveLines(feed.tl.state, rows, inner) : feed.final(inner);
  if (feed.state.running && !body.length && rows > 0 && !feed.tl.state.api.req) body = [C.dim(D.watchWorking)];
  const shown = collapse ? collapseLines(body, true, `press ${no} to open`) : body.slice(0, rows);
  if (!collapse && body.length > rows && rows > 0) shown[rows - 1] = `${fitWidth(shown[rows - 1].replace(/\x1b\[[0-9;]*m/g, ''), inner - 1)}${C.dim('…')}`;
  return { lines: [...out, ...[...shown, ...seatUsage(run, feed, inner, no == null)].map((l) => lead + l)], state: st };
}

async function watchGroup(group, o, loadCfg) {
  let planRuns = [], lastGrouped = [], pending = [], groupPlans = [];
  const groupTask = (all) => displayGroupTask(all, groupPlans, pending);
  // 编号从完整计划重建，尚未启动的席位也预留；祖先暂时读不到时才沿用上次号码。
  let numbers, numberSession;
  const numberOf = (run) => numbers.runs.get(run.id);
  // 计划文件一时读不到（被占用、写到一半）时沿用上次读到的，不让编号和计划提示跟着变
  const planCache = new Map();
  const planOf = (id) => { const plan = loadPlan(id); if (plan) planCache.set(id, plan); return plan ?? planCache.get(id) ?? null; };
  const recentRuns = () => {
    const grouped = groupRuns(group, Date.now() - 86400000);
    const session = grouped.length ? grouped[0].meta.claude_session ?? null : CLAUDE_SESSION;
    if (session !== numberSession) { numbers = undefined; numberSession = session; }
    pending = queuedDispatches(group).filter((q) => (q.claude_session ?? null) === session);
    // meta.json 正被替换时会暂时读不到，这一席就会从列表里掉出去、下一秒重建：上次见过、文件还在的再读一次，还读不出就沿用上次读到的
    const ids = new Set(grouped.all.map((run) => run.id));
    const missed = lastGrouped.filter((run) => !ids.has(run.id) && fs.existsSync(path.join(run.dir, 'meta.json')))
      .map((run) => ({ ...run, meta: readMeta(run.dir) || run.meta }));
    if (missed.length) {
      const newest = (a, b) => (a.id < b.id ? 1 : -1);
      grouped.push(...missed); grouped.sort(newest);
      grouped.all.push(...missed); grouped.all.sort(newest);
    }
    lastGrouped = [...grouped];
    // 编号、轮次和排队判断只看这个对话的任务（和看板一样），同名组在别的对话里的计划和任务不算；
    // 续接链的前几轮可能在别的对话里，沿 parent 补进来
    // 别的对话接着做的（同一份计划的席位、续接链上的前后几轮）照样算进来，同名组里不相干的计划不算
    const byIdAll = new Map(grouped.all.map((run) => [run.id, run])), children = new Map();
    for (const run of grouped.all) if (run.meta.parent) children.set(run.meta.parent, [...(children.get(run.meta.parent) || []), run]);
    const here = grouped.all.filter((run) => (run.meta.claude_session ?? null) === session);
    const plansHere = new Set(here.map((run) => run.meta.plan).filter(Boolean));
    planRuns = grouped.all.filter((run) => (run.meta.claude_session ?? null) === session || plansHere.has(run.meta.plan));
    const seenIds = new Set(planRuns.map((run) => run.id));
    for (let i = 0; i < planRuns.length; i++) {
      for (const next of [byIdAll.get(planRuns[i].meta.parent), ...(children.get(planRuns[i].id) || [])]) {
        if (next && !seenIds.has(next.id)) { seenIds.add(next.id); planRuns.push(next); }
      }
    }
    pending = pending.filter((q) => !queuedStarted(q, planRuns));
    groupPlans = [...new Set([...planRuns.map((r) => r.meta.plan), ...pending.map((q) => q.plan)].filter(Boolean))].map(planOf).filter(Boolean);
    // 先按最早一轮排位，再换成最新一轮，续接不会把原来的席挪到末尾。
    const runs = current([...grouped].reverse(), planRuns);
    const byId = new Map(planRuns.map((run) => [run.id, run]));
    for (const run of runs) run.meta = { ...run.meta, round: roundOf(run.meta, byId) };
    numbers = seatNumbers(runs, planRuns, numbers, groupPlans);
    runs.sort((a, b) => numberOf(a) - numberOf(b));
    checkRunners(runs.map((run) => run.meta));
    return runs;
  };
  let runs;
  // 等待期间按 q 或 Ctrl+C 也要认：记下来，等完直接写汇总退出，不进画面
  let early = null;
  let keysHandler = (keys) => { for (const k of keys) if (k === 'q' || k === '\x03') early = k === '\x03' ? 130 : 0; };
  const earlyKeys = readKeys((keys) => keysHandler(keys));
  const listenEarly = interactive();
  let settlingShown = false;
  if (listenEarly) listenKeys(earlyKeys);
  for (let waited = 0; ; waited += 500) {
    runs = recentRuns();
    // 找到的一批都已结束时多等几秒：可能是别的会话用过的同名组，新派出的任务还没登记
    if (pending.length || runs.some((run) => isRunning(run.meta)) || (runs.length && (waited >= 5000 || early != null))) break;
    if (early != null) process.exit(early);
    if (waited >= 15000) die(M.groupNotFound(group));
    if (waited === 0 && !runs.length) process.stdout.write(`${D.watchWaiting}\n`);
    // 找到的都已结束、还要多等几秒时，有人在看就说一声，免得以为卡住了
    if (waited === 0 && runs.length && listenEarly) {
      // 窗口窄时截前面的说明，"(q to skip)" 留着
      const key = ` ${D.watchGroupSettlingKey}`, room = termCols() - 1 - textWidth(key);
      process.stdout.write(`${C.dim(room >= 8 ? fitWidth(D.watchGroupSettling, room) + key : fitWidth(D.watchGroupSettlingKey, termCols() - 1))}\n`);
      settlingShown = true;
    }
    await sleep(500);
  }
  // 等完了就把那句提示擦掉（上移一行再清掉），不留在后面的汇总上方
  if (settlingShown) process.stdout.write('\x1b[1A\x1b[2K');
  if (listenEarly) {
    if (early != null) stopKeys(earlyKeys);
    else process.stdin.off('data', earlyKeys);
  }
  // 启动动画：画出组里新派出的各位，播放中后登记的任务也会出场；结束后接着用备用屏幕画实时面板
  let introPlayed = false;
  let handOff = () => {};
  if (early == null && introWanted(o, runs.map((run) => run.meta), loadCfg)) {
    const fresh = (list) => list.filter((run) => !isHost(run) && !run.meta.parent && !run.meta.dismissed_at && isRunning(run.meta)).map((run) => introOf(run.meta));
    const first = runs.find((run) => !isHost(run) && !run.meta.parent && !run.meta.dismissed_at && isRunning(run.meta)).meta;
    const kind = runs.some((run) => kindOf(run.meta) === 'discuss') ? 'discuss' : kindOf(first);
    // meta.json 正被替换时会暂时读不到，组里的任务就会从列表里消失：见过的任务都记着，读不到的不算结束
    const seen = new Map(runs.map((run) => [run.id, run]));
    handOff = await playIntro(introScene({ mode: first.mode, kind, participants: fresh(runs), group: true }), {
      keepScreen: true,
      isOver: () => {
        for (const run of recentRuns()) seen.set(run.id, run);
        const metas = [...seen.values()].map((run) => readMeta(run.dir));
        checkRunners(metas);
        return !pending.length && metas.every((m) => !!m && !isRunning(m));
      },
      refresh: () => { const list = recentRuns(); return list.length ? fresh(list) : null; },
    });
    introPlayed = true;
    const after = recentRuns();
    if (after.length) runs = after;
  }

  const known = new Map(); // run id → run
  const feeds = new Map();
  let lastAdded = Date.now();
  const refresh = () => {
    // 换成了另一批（新会话用同一个组名派出了任务），上一批的不再显示
    const ids = new Set(runs.map((run) => run.id));
    for (const id of [...known.keys()]) if (!ids.has(id)) { known.delete(id); feeds.delete(id); }
    for (const run of runs) {
      if (!feeds.has(run.id)) { lastAdded = Date.now(); feeds.set(run.id, createSeat(run)); }
      feeds.get(run.id).run = run; // 每席只认最新读到的这一份记录
      known.set(run.id, run);
    }
  };
  refresh();
  if (!runs.some((run) => isRunning(run.meta))) lastAdded = 0; // 打开时就全部结束了：不用再等后派出的任务
  const list = () => runs.filter((run) => feeds.has(run.id));
  const update = () => {
    const all = list();
    checkRunners(all.map((run) => run.meta));
    for (const run of all) feeds.get(run.id).update();
    return all;
  };
  const anyRunning = () => update().some((run) => feeds.get(run.id).state.running);
  const settled = () => !anyRunning() && !pending.length && Date.now() - lastAdded >= 5000; // 排队的派发也要等到启动或离队

  // 计划只在有缺口时写一行：缺了必选、补漏席没跑完、材料变了、Claude Code 席还没提交报告
  const groupPlanNotes = () => {
    return displayPlanNotes(groupPlans, planRuns.filter((r) => groupPlans.some((p) => p.plan_id === r.meta.plan)).map((r) => ({ ...r, outcome: runOutcome(r) })));
  };
  const planNotes = (width, wrap) => groupPlanNotes().filter((p) => p.details || p.state === 'incomplete').flatMap((p) => {
    const text = p.line;
    const color = p.state === 'incomplete' ? C.red : C.yellow;
    return (wrap ? wrapWidth(text, width) : [fitWidth(text, width)]).map((l, i) => (i === 0 ? color(l) : l));
  });
  const headLine = (all, states, width) => {
    const counts = countsText([...states, ...pending.map(() => ({ kind: 'queued' }))]);
    const { text } = groupTask(all);
    const room = width - visibleWidth(counts) - 2;
    if (room < 12) return C.bold(fitWidth(text, width));
    const left = fitWidth(text, room);
    return C.bold(left) + ' '.repeat(width - textWidth(left) - visibleWidth(counts)) + counts;
  };

  // 各席的几行：先按状态给最少行数，窗口有富余时轮流分给还有内容没写下的席位；full 时结论写全。
  // 汇总写在普通屏幕里，不写席位号
  const blocks = (all, width, budget, full, numbered = true) => {
    const split = groupTask(all).split;
    const inner = width - (numbered ? 4 : 2);
    const want = all.map((run) => wantRows(run, feeds.get(run.id), inner));
    const rows = all.map((run, i) => (full ? want[i] : Math.min(want[i], feeds.get(run.id).state.running ? LIVE_MIN : DONE_MIN)));
    const total = all.reduce((n, run, i) => n + 2 + (seatLine(run.meta, { title: split }) ? 1 : 0) + want[i] + seatUsage(run, feeds.get(run.id), inner).length, 0);
    const collapse = full && budget > 0 && total > budget;
    if (!full) {
      const fixed = all.reduce((n, run, i) => n + 2 + (seatLine(run.meta, { title: split }) ? 1 : 0) + rows[i] + seatUsage(run, feeds.get(run.id), inner).length, 0);
      let spare = budget - fixed;
      // 窗口不够高时先把正文压到每席一行，还放不下再靠翻看
      while (spare < 0 && rows.some((n) => n > 1)) {
        rows[rows.indexOf(Math.max(...rows))]--;
        spare++;
      }
      for (let grew = true; spare > 0 && grew;) {
        grew = false;
        all.forEach((run, i) => { if (spare > 0 && rows[i] < Math.min(want[i], MAX_ROWS)) { rows[i]++; spare--; grew = true; } });
      }
    }
    return all.map((run, i) => seatBlock(run, feeds.get(run.id), rows[i], width, numbered ? numberOf(run) : null, split, collapse));
  };

  // 打开的那一席：顶部是它的身份行、分工行和组的任务行，下面是它的完整时间线
  let focus = null; // 打开的席位号
  const seatScroll = scroller({ fromBottom: true });
  const groupScroll = scroller({ fromBottom: false });
  let seatTotal = 0;
  let seatWidth = 0;
  const renderSeat = (all, W, H) => {
    const run = all.find((run) => numberOf(run) === focus);
    const feed = feeds.get(run.id);
    const st = seatState(run, feed);
    const width = W - 1;
    const top = [identityLine(run.meta, st.style, st.right, width)];
    const second = seatLine(run.meta, { title: groupTask(all).split, width: width - 2 });
    if (second) top.push(`  ${second}`);
    top.push(`  ${C.bold(fitWidth(groupTask(all).text, width - 2))}`, C.dim('─'.repeat(width)));
    const lines = feed.tl.lines(W);
    // 往回翻着的时候来了新内容，画面停在原处不动
    if (seatScroll.offset && W === seatWidth) seatScroll.offset += lines.length - seatTotal;
    seatTotal = lines.length;
    seatWidth = W;
    const { shown } = seatScroll.view(lines, Math.max(1, H - top.length - 1));
    // 底部：运行中写最近的思考，往回翻时写翻了多少行，右边是按键
    const s = feed.tl.state;
    const note = seatScroll.offset ? D.watchScrolled(seatScroll.offset)
      : feed.state.running && s.thought && (!s.speech || s.thought.seq > s.speech.seq) ? D.watchThinking(s.thought.text) : '';
    const color = seatScroll.offset ? C.yellow : C.dim;
    const room = width - textWidth(D.seatKeys) - 2;
    const left = room >= 8 ? fitWidth(note, room) : '';
    return [...top, ...shown, color(left) + ' '.repeat(Math.max(0, width - textWidth(left) - textWidth(D.seatKeys))) + C.dim(fitWidth(D.seatKeys, width))];
  };

  let confirmCancel = false;
  const cancelSent = new Set();
  const queuedRuns = () => list().filter((run) => feeds.get(run.id).state.running && feeds.get(run.id).tl.state.api.queued && !cancelSent.has(run.id));
  let allDone = false;
  const render = (W, H) => {
    const all = update();
    if (focus != null && all.some((run) => numberOf(run) === focus)) return renderSeat(all, W, H);
    const width = Math.max(20, W - 1);
    const built = blocks(all, width, H - 2 - planNotes(width).length - pending.length, allDone);
    const top = [headLine(all, built.map((b) => b.state), width), ...planNotes(width)];
    const body = [...built.flatMap((b) => [C.dim('─'.repeat(width)), ...b.lines]), ...pending.map((q) => C.dim(fitWidth(queuedLine(q, Date.now()), width)))];
    const { shown, above, below } = groupScroll.view(body, Math.max(1, H - top.length - 1));
    const queued = queuedRuns();
    const seats = all.map(numberOf).sort((a, b) => a - b);
    // 连续的号码合成一段（0–3,5–14），席位多又有缺号时提示不会太长
    const range = seats.reduce((spans, n) => { const last = spans.at(-1); if (last && n === last[1] + 1) last[1] = n; else spans.push([n, n]); return spans; }, [])
      .map(([a, b]) => (a === b ? `${a}` : b === a + 1 ? `${a},${b}` : `${a}–${b}`)).join(',');
    let foot;
    if (confirmCancel && queued.length) foot = C.yellow(fitWidth(D.dashCancelConfirm(D.list(queued.map((run) => shortModel(modelOf(run.meta))))), width));
    else {
      // 左边是"全部结束"和翻看的位置，右边是按键。放不下时先截短左边，留给左边的不到 8 列才去掉按键
      const where = [above && D.dashAbove(above), below && D.dashBelow(below)].filter(Boolean).join(' · ');
      const done = (s) => C.green(s.slice(0, 1)) + C.dim(s.slice(1));
      const left = allDone && where ? { text: `✔ ${D.dots([D.dashAllFinishedShort, where])}`, paint: done }
        : where ? { text: where, paint: C.yellow } : allDone ? { text: `✔ ${D.dashAllFinished}`, paint: done } : null;
      const keys = D.dashKeys(range, queued.length > 0, seats.some((n) => n >= 10));
      const paintKeys = queued.length ? C.yellow : C.dim;
      const parts = dashFooter(left?.text || '', keys, width, allDone);
      foot = (left ? left.paint(parts.left) : '') + parts.gap + paintKeys(parts.keys);
    }
    return [...top, ...shown, foot];
  };

  // 汇总：写在普通屏幕里，排版和画面一致，结论写全，每席的用量和 run_id 和画面里一样。
  // 最后是回看某一席的命令：说明单独一行，命令另起一行、不截断，整行复制换上 run_id 就能运行
  const summary = () => {
    const all = update();
    const width = Math.max(20, termCols() - 1);
    const built = blocks(all, width, 0, true, false);
    const out = ['', headLine(all, built.map((b) => b.state), width), ...planNotes(width, true)];
    for (const b of built) out.push(C.dim('─'.repeat(width)), ...b.lines);
    out.push(...pending.map((q) => C.dim(queuedLine(q, Date.now()))));
    const replay = replayCommand(RUNS_ROOT);
    const label = D.watchReplayOne('').trimEnd();
    out.push(C.dim('─'.repeat(width)), C.dim(label), C.dim(replay.slice(label.length).trim()));
    process.stdout.write(`${out.join('\n')}\n`);
  };

  if (early == null && liveCapable() && (anyRunning() || pending.length || interactive())) {
    // 实时面板：备用屏幕里整屏重画，窗口大小变化时按新尺寸重画。全部结束后有人能按键时停在画面里，按 q 离开；
    // 离开后在原来的屏幕输出汇总，留作记录。有模型在排队时按 x 终止：第一次按要求确认，第二次给排队中的都写终止标记
    const screen = liveScreen(render);
    let quit = null;
    const done = new Promise((resolve) => { quit = resolve; });
    let digits = '', digitTimer = null;
    const openSeat = () => {
      if (digits && list().some((run) => numberOf(run) === Number(digits))) { focus = Number(digits); seatScroll.offset = 0; }
      digits = '';
      clearTimeout(digitTimer);
    };
    // 等待阶段和面板沿用读键状态，跨阶段到达的粘贴内容也不能变成快捷键。
    const onKeys = earlyKeys;
    keysHandler = (keys) => {
      const page = Math.max(1, termRows() - 4);
      for (const k of keys) {
        if (k === '\x03' || k === 'q') { quit(k === '\x03' ? 130 : 0); return; }
        // 除了接着输入的数字，任何键都取消还在等第二位的席位号
        if (!/^[0-9]$/.test(k) || focus != null) { digits = ''; clearTimeout(digitTimer); }
        if ((k === 'x' || k === 'X') && focus == null && queuedRuns().length) {
          if (confirmCancel) for (const run of queuedRuns()) { requestCancel(run.dir, 'watch'); cancelSent.add(run.id); }
          confirmCancel = !confirmCancel;
          continue;
        }
        confirmCancel = false;
        if (/^[0-9]$/.test(k) && focus == null) {
          digits += k;
          clearTimeout(digitTimer);
          // 还有以这几位开头的更长号码时才等第二位，否则立即打开
          if (!list().some((run) => String(numberOf(run)).length > digits.length && String(numberOf(run)).startsWith(digits))) openSeat();
          else digitTimer = setTimeout(() => { openSeat(); screen.draw(); }, 600);
        } else {
          if ((k === '\x1b' || k === '\x7f' || k === '\b') && focus != null) focus = null;
          else (focus != null ? seatScroll : groupScroll).key(k, page);
        }
      }
      screen.draw();
    };
    if (interactive()) listenKeys(onKeys);
    process.on('exit', () => screen.stop());
    process.on('SIGINT', () => quit(130));
    screen.start();
    handOff(); // 实时面板接手了备用屏幕，由它负责退出时恢复终端
    let code = null;
    done.then((c) => { code = c; });
    while (code == null) {
      allDone = settled();
      screen.draw();
      if (allDone && !interactive()) break;
      await sleep(1000);
      // 结束后仍跟着同组的新派发和续接走，不能停在已经过时的汇总上。
      runs = recentRuns();
      refresh();
    }
    clearTimeout(digitTimer);
    if (interactive()) stopKeys(onKeys);
    screen.stop();
    if (code != null && !allDone) { process.stdout.write(`${C.dim(D.watchDetached)}\n`); process.exit(code); }
    if (code === 130) process.exitCode = 130; // 结束后按 Ctrl+C 离开，照样写汇总，退出码和中断一致
  } else if (introPlayed) {
    process.stdout.write(LEAVE_SCREEN); // 动画期间全部结束了：离开备用屏幕，直接输出汇总
    handOff();
  } else if (anyRunning() || pending.length) {
    // 输出被重定向时（比如被别的程序读取），每个任务状态变化时写一行。
    process.stdout.write(`${C.bold(groupTask(list()).text)}\n`);
    const states = new Map();
    for (;;) {
      for (const q of pending) {
        const key = `queue:${q.agent}:${q.sequence}`, text = queuedLine(q, Date.now());
        if (states.get(key) !== text) process.stdout.write(`${text}\n`);
        states.set(key, text);
      }
      for (const run of update()) {
        const st = seatState(run, feeds.get(run.id));
        const shown = D.dots([modelLabel(run.meta), st.right.filter(Boolean)[0]]);
        if (states.get(run.id) !== shown) process.stdout.write(`${shown}\n`);
        states.set(run.id, shown);
      }
      for (const { id, state, details } of groupPlanNotes()) {
        const text = D.dots([D.planStates[state], details]);
        if (states.get(id) !== text) process.stdout.write(`${paintPlanWord(text, state)}\n`);
        states.set(id, text);
      }
      if (settled()) break;
      await sleep(2000);
      runs = recentRuns();
      refresh();
    }
  }
  summary();
  if (early === 130) process.exitCode = 130;
}

export { watchGroup };
