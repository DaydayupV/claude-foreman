// 组视图：一组任务（讨论、审查的各席，或者并发拆分的几份）排在一个画面里。
// 标题行写 <模块> · <模式> · <标题> · <等级>[ · round N]，右边是各状态的个数；计划只在有缺口时多写一行。
// Claude Code 席排在最前（席位号 0）；每席是身份行、分工行和正文，按席位号打开那一席的完整时间线。
import path from 'node:path';
import { RUNS_ROOT, requestCancel, readMeta, checkRunners, isRunning, runOutcome, groupRuns } from './records.mjs';
import { describePlans } from './plan.mjs';
import { M, die, sleep, oneLine, needsDecision, modelOf, textWidth, fitWidth, wrapWidth } from './util.mjs';
import { D, C, termCols, termRows, visibleWidth, shortModel, modelLabel, moduleOf, taskLine, seatLine, identityLine, clock, outcomeStyle,
  changedFor, usageLine, foldText, paintPlanWord, replayCommand } from './format.mjs';
import { liveCapable, interactive, liveScreen, splitKeys, scroller, LEAVE_SCREEN, kindOf, introWanted, introOf } from './watch-screen.mjs';
import { createTimeline, reviewConclusion, realErrors, durationOf, liveStatus, eventReader, hhmm } from './watch-timeline.mjs';
import { introScene, playIntro } from './watch-intro.mjs';

const GAP_ROLE = /^(补漏|gap)$/i;
const LIVE_MIN = 3; // 运行中的一席至少留几行正文（有内容时）
const DONE_MIN = 2; // 结束了的一席至少留几行结论
const MAX_ROWS = 12;
const isHost = (run) => run.meta.participant === 'host';

// 一席的状态：记号和颜色、右侧 [状态词, 时钟]、计数用的种类
function seatState(run, feed) {
  if (isHost(run)) return { style: { mark: '✔', color: C.green }, right: [D.statusName('submitted'), hhmm(run.meta.submitted_at)], kind: 'ok' };
  const o = feed.outcome ?? runOutcome(run);
  if (o.running) {
    const live = liveStatus(run.meta, feed.tl.state.api);
    return { style: live, right: live.right, kind: feed.tl.state.api.queued ? 'queued' : 'running', running: true };
  }
  const style = outcomeStyle(o);
  const sec = durationOf(o.result, run.meta);
  return { style, right: [style.word, Number.isFinite(sec) ? clock(sec * 1000) : null], kind: o.ok ? 'ok' : o.blocked ? 'blocked' : 'failed', o };
}
const COUNT_STYLE = { running: ['●', C.cyan], queued: ['⋯', C.yellow], ok: ['✔', C.green], blocked: ['?', C.yellow], failed: ['✗', C.red] };
const countsText = (states) => Object.entries(COUNT_STYLE).map(([kind, [mark, color]]) => {
  const n = states.filter((s) => s.kind === kind).length;
  return n ? color(`${mark}${n}`) : '';
}).filter(Boolean).join(' ');

// 结束后的正文：审查写问题数和各条问题，讨论写立场，执行写报告摘要；再加要人回答的问题、越界写入、材料变了和报错
function finalLines(run, r, ok, inner) {
  const report = r?.report;
  const out = [];
  const wrap = (text) => wrapWidth(String(text).trim(), inner);
  // 带记号的一段：记号上色，续行缩进两格，按缩进后的宽度折行
  const marked = (mark, color, text) => wrapWidth(oneLine(text), Math.max(4, inner - 2)).map((l, i) => (i ? `  ${l}` : `${color(mark)} ${l}`));
  const conclusion = reviewConclusion(report);
  if (conclusion) {
    out.push(...wrap(conclusion));
    for (const f of report.findings || []) out.push(...wrap(D.watchFinding(f, D.severityNames[f.severity])));
  } else if (report?.position || report?.summary) out.push(...wrap(report.position || report.summary));
  for (const q of r?.questions?.filter(needsDecision) ?? report?.decision_requests ?? []) out.push(...marked('?', C.yellow, q.question));
  const changed = run.meta.kind !== 'exec' && changedFor(r, run.meta); // 讨论和审查只有越界写了文件才有
  if (changed) out.push(...marked('⚠', C.yellow, changed));
  if (r?.stale === true) out.push(...marked('⚠', C.yellow, D.watchStale));
  const [mark, color] = r?.status === 'needs_input' ? ['?', C.yellow] : ['✗', C.red];
  for (const e of realErrors(r, ok)) out.push(...marked(mark, color, e));
  return out;
}

// 运行中的正文：最近说的一段话（◆）、比它新的思考摘要，下面是最近的动作，放不下的折叠成一行计数
function liveLines(state, rows, inner) {
  if (rows <= 0) return [];
  const speech = state.speech ? wrapWidth(state.speech.text, inner - 2).filter((l) => l.trim()) : [];
  const thought = state.thought && (!state.speech || state.thought.seq > state.speech.seq) ? state.thought : null;
  const acting = state.recent.length ? 1 : 0;
  const thinking = thought && Math.min(2, speech.length) + 1 + acting <= rows ? 1 : 0;
  const speechRows = Math.min(speech.length, rows >= 8 ? 3 : 2, Math.max(speech.length ? 1 : 0, rows - thinking - acting));
  const top = speech.slice(0, speechRows).map((l, i) => {
    const last = i === speechRows - 1 && speech.length > speechRows;
    const joint = /[\w,.;:)]$/.test(l) || /^\w/.test(speech[i + 1] || '') ? ' ' : ''; // 在英文单词处折开的，接回去时补上空格
    return `${i ? '  ' : '◆ '}${last ? fitWidth(`${l}${joint}${speech[i + 1]}`, inner - 2) : l}`;
  });
  if (thinking) top.push(C.dim(fitWidth(D.watchThinking(thought.text), inner)));
  const room = rows - top.length;
  if (room <= 0 || !state.recent.length) return top;
  // 一条动作：记号、暗色的文字，行尾是失败或没搜到的标记
  const line = (a, width = inner) => {
    const tag = a.tag ? `  ${a.tag}` : '';
    const head = a.mark ? `${a.mark[1](a.mark[0])} ` : '';
    const text = fitWidth(a.text, Math.max(4, width - visibleWidth(head) - visibleWidth(tag)));
    return head + (a.color || C.dim)(text) + (tag ? ' '.repeat(Math.max(0, width - visibleWidth(head) - textWidth(text) - visibleWidth(tag))) + tag : '');
  };
  const total = Object.values(state.kinds).reduce((n, k) => n + k, 0);
  if (total <= room) return [...top, ...state.recent.slice(-room).map((a) => line(a))];
  const shown = state.recent.slice(state.recent.length - Math.max(1, room - 1));
  const hidden = { ...state.kinds };
  for (const a of shown) hidden[a.kind]--;
  // 只剩一行时，折叠计数和最新一条写在同一行
  const fold = foldText(hidden);
  if (room === 1) return [...top, inner - textWidth(fold) - 3 >= 8 ? `${C.dim(`${fold} · `)}${line(shown[0], inner - textWidth(fold) - 3)}` : C.dim(fitWidth(fold, inner))];
  return [...top, C.dim(fitWidth(fold, inner)), ...shown.map((a) => line(a))];
}

// 一席想写多少行正文：运行中按内容估，结束后是结论的行数
function wantRows(run, feed, inner) {
  if (feed.state.running) {
    const s = feed.tl.state;
    return Math.min(MAX_ROWS, (s.speech ? Math.min(3, wrapWidth(s.speech.text, inner - 2).length) : 0) + (s.thought ? 1 : 0) + Math.min(s.recent.length, 8));
  }
  return feed.final(inner).length;
}

// 续接和同席重启都由最新轮次代替
function current(runs, all = runs.all ?? runs) {
  const children = new Map(), latest = new Map(), seen = new Set();
  const seatOf = (run) => (run.meta.plan && run.meta.seat != null ? `${run.meta.plan}:${run.meta.seat}` : null);
  for (const run of all) {
    const parent = run.meta.parent;
    if (parent && (!children.has(parent) || run.id > children.get(parent).id)) children.set(parent, run);
    const seat = seatOf(run);
    if (seat && (!latest.has(seat) || run.id > latest.get(seat).id)) latest.set(seat, run);
  }
  return runs.flatMap((run) => {
    if (seatOf(run)) run = latest.get(seatOf(run));
    else while (children.has(run.id)) run = children.get(run.id);
    if (seen.has(run.id)) return [];
    seen.add(run.id);
    return [run];
  });
}
// Claude Code 席排在最前，其余按开始先后
const ordered = (runs) => [...runs].sort((a, b) => Number(isHost(b)) - Number(isHost(a)));

// 汇总里每席的用量：改动、用量和费用按" · "折行，run_id 靠右写在最后一行，放不下就另起一行
function usageRows(text, id, width) {
  const lines = [];
  for (const part of text ? text.split(' · ') : []) {
    const last = lines.length - 1;
    if (last >= 0 && textWidth(`${lines[last]} · ${part}`) <= width) lines[last] += ` · ${part}`;
    else lines.push(...wrapWidth(part, width));
  }
  const tail = lines.pop() ?? '';
  const rows = lines.map((l) => C.dim(l));
  const shownId = fitWidth(id, width);
  if (textWidth(tail) + 2 + textWidth(shownId) <= width) rows.push(C.dim(tail) + ' '.repeat(width - textWidth(tail) - textWidth(shownId)) + C.dim(shownId));
  else rows.push(...(tail ? [C.dim(tail)] : []), ' '.repeat(Math.max(0, width - textWidth(shownId))) + C.dim(shownId));
  return rows;
}

// 标题行：<模块> · <模式> · <标题> · <等级>[ · round N]。Claude Code 席的记录没有标题，不参与；
// 拆开的执行任务标题不同，写成"甲 / 乙 / 丙"，各份的标题和等级写在自己的分工行里。
// 讨论和审查的分工行只写角色：标题里带着自己角色的（旧的写法"多角色模式［角色］"），去掉角色再合并
// 只剩"多角色模式"的，和标题行里的模式词重复，不写
const withoutRole = (title, role) => {
  const rest = role ? title.replace(new RegExp(`\\s*[［\\[（(【]\\s*${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[］\\]）)】]\\s*`), '').trim() : title;
  return /^(多角色模式|role mode)$/i.test(rest) ? '' : rest;
};
function groupTask(all) {
  const seats = all.filter((run) => !isHost(run)).map((run) => run.meta);
  const metas = seats.length ? seats : all.map((run) => run.meta);
  const module = moduleOf(metas[0]);
  const roles = all.some((run) => run.meta.role && !GAP_ROLE.test(run.meta.role));
  const mode = module === 'run' ? (metas.length > 1 ? D.groupModes.split : null)
    : module === 'discuss' || module === 'review' ? D.groupModes[roles ? 'roles' : 'panel'] : null;
  const same = (key) => (new Set(metas.map((m) => m[key] ?? null)).size === 1 ? metas[0][key] : null);
  const titles = [...new Set(metas.map((m) => withoutRole(oneLine(m.title || ''), m.role)).filter(Boolean))];
  const round = same('round');
  return { split: module === 'run' && titles.length > 1, text: taskLine({ ...metas[0], level: same('level'), cell: same('cell') }, { mode, title: titles.join(' / '), round }) };
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
  feed.final = (inner) => finalLines(feed.run, feed.outcome?.result, isHost(feed.run) || feed.outcome?.ok, inner);
  return feed;
}

// 结束了的一席在结论下面写一行用量：执行任务先写改动，再写 token 和费用，run_id 靠右；
// Claude Code 席没有用量，写明是它提交的报告。运行中的不写
function seatUsage(run, feed, inner) {
  if (feed.state.running) return [];
  const r = feed.outcome?.result;
  const usage = isHost(run) ? D.watchHostNoUsage : D.dots([run.meta.kind === 'exec' && changedFor(r, run.meta), usageLine(r, run.meta)]);
  return usageRows(usage, run.id, inner);
}

// 一席的几行：身份行、分工行、正文，结束了的再加用量。运行中还没有任何可写的（讨论席常常只在最后交回结果），写一行"进行中"
function seatBlock(run, feed, rows, width, no, split) {
  const st = seatState(run, feed);
  const lead = no != null ? '    ' : '  ';
  const inner = width - lead.length;
  const out = [identityLine(run.meta, st.style, st.right, width, no)];
  const second = seatLine(run.meta, { title: split, width: inner });
  if (second) out.push(lead + second);
  let body = feed.state.running ? liveLines(feed.tl.state, rows, inner) : feed.final(inner);
  if (feed.state.running && !body.length && rows > 0 && !feed.tl.state.api.req) body = [C.dim(D.watchWorking)];
  const shown = body.slice(0, rows);
  if (body.length > rows && rows > 0) shown[rows - 1] = `${fitWidth(shown[rows - 1].replace(/\x1b\[[0-9;]*m/g, ''), inner - 1)}${C.dim('…')}`;
  return { lines: [...out, ...[...shown, ...seatUsage(run, feed, inner)].map((l) => lead + l)], state: st };
}

async function watchGroup(group, o, loadCfg) {
  let planRuns = [];
  const recentRuns = () => {
    const grouped = groupRuns(group, Date.now() - 86400000);
    planRuns = grouped.all;
    const runs = ordered(current(grouped).reverse());
    checkRunners(runs.map((run) => run.meta));
    return runs;
  };
  let runs;
  // 等待期间按 q 或 Ctrl+C 也要认：记下来，等完直接写汇总退出，不进画面
  let early = null;
  const earlyKeys = (d) => { for (const k of splitKeys(d.toString('utf8'))) if (k === 'q' || k === '\x03') early = k === '\x03' ? 130 : 0; };
  const listenEarly = interactive();
  if (listenEarly) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', earlyKeys); }
  for (let waited = 0; ; waited += 500) {
    runs = recentRuns();
    // 找到的一批都已结束时多等几秒：可能是别的会话用过的同名组，新派出的任务还没登记
    if (runs.some((run) => isRunning(run.meta)) || (runs.length && (waited >= 5000 || early != null))) break;
    if (early != null) process.exit(early);
    if (waited >= 15000) die(M.groupNotFound(group));
    if (waited === 0 && !runs.length) process.stdout.write(`${D.watchWaiting}\n`);
    await sleep(500);
  }
  if (listenEarly) {
    process.stdin.off('data', earlyKeys);
    if (early != null) { process.stdin.setRawMode(false); process.stdin.pause(); }
  }
  // 启动动画：画出组里新派出的各位，播放中后登记的任务也会出场；结束后接着用备用屏幕画实时面板
  let introPlayed = false;
  let handOff = () => {};
  if (early == null && introWanted(o, runs.map((run) => run.meta), loadCfg)) {
    const fresh = (list) => list.filter((run) => !isHost(run) && !run.meta.parent).map((run) => introOf(run.meta));
    const first = runs.find((run) => !isHost(run) && !run.meta.parent).meta;
    const kind = runs.some((run) => kindOf(run.meta) === 'discuss') ? 'discuss' : kindOf(first);
    // meta.json 正被替换时会暂时读不到，组里的任务就会从列表里消失：见过的任务都记着，读不到的不算结束
    const seen = new Map(runs.map((run) => [run.id, run]));
    handOff = await playIntro(introScene({ mode: first.mode, kind, participants: fresh(runs), group: true }), {
      keepScreen: true,
      isOver: () => {
        for (const run of recentRuns()) seen.set(run.id, run);
        const metas = [...seen.values()].map((run) => readMeta(run.dir));
        checkRunners(metas);
        return metas.every((m) => !!m && !isRunning(m));
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
  const settled = () => !anyRunning() && Date.now() - lastAdded >= 5000; // 等几秒，同组后派出的任务也能收进来
  const hasHost = () => list().some(isHost);
  const numberOf = (i) => (hasHost() ? i : i + 1);

  // 计划只在有缺口时写一行：缺了必选、补漏席没跑完、材料变了、Claude Code 席还没提交报告
  const planNotes = (width, wrap) => describePlans(list(), planRuns).filter((p) => p.details || p.state === 'incomplete').flatMap((p) => {
    const text = `${p.state === 'incomplete' ? '✗' : '⚠'} ${D.dots([D.planStates[p.state], p.details])}`;
    const color = p.state === 'incomplete' ? C.red : C.yellow;
    return (wrap ? wrapWidth(text, width) : [fitWidth(text, width)]).map((l, i) => (i === 0 ? color(l) : l));
  });
  const headLine = (all, states, width) => {
    const counts = countsText(states);
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
    return all.map((run, i) => seatBlock(run, feeds.get(run.id), rows[i], width, numbered ? numberOf(i) : null, split));
  };

  // 打开的那一席：顶部是它的身份行、分工行和组的任务行，下面是它的完整时间线
  let focus = null; // 打开的席位号
  const seatScroll = scroller({ fromBottom: true });
  const groupScroll = scroller({ fromBottom: false });
  let seatTotal = 0;
  let seatWidth = 0;
  const renderSeat = (all, W, H) => {
    const i = all.findIndex((_, k) => numberOf(k) === focus);
    const run = all[i];
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
    if (focus != null && all.some((_, k) => numberOf(k) === focus)) return renderSeat(all, W, H);
    const width = Math.max(20, W - 1);
    const built = blocks(all, width, H - 2 - planNotes(width).length, allDone);
    const top = [headLine(all, built.map((b) => b.state), width), ...planNotes(width)];
    const body = built.flatMap((b) => [C.dim('─'.repeat(width)), ...b.lines]);
    const { shown, above, below } = groupScroll.view(body, Math.max(1, H - top.length - 1));
    const queued = queuedRuns();
    // 按键只认一位数字，提示里的范围到 9 为止
    const last = Math.min(all.length - 1, hasHost() ? 9 : 8);
    const range = all.length ? (last > 0 ? `${numberOf(0)}–${numberOf(last)}` : `${numberOf(0)}`) : '';
    let foot;
    if (confirmCancel && queued.length) foot = C.yellow(fitWidth(D.dashCancelConfirm(D.list(queued.map((run) => shortModel(modelOf(run.meta))))), width));
    else {
      // 左边是"全部结束"和翻看的位置，右边是按键。放不下时先截短左边，留给左边的不到 8 列才去掉按键
      const where = [above && D.dashAbove(above), below && D.dashBelow(below)].filter(Boolean).join(' · ');
      const done = (s) => C.green(s.slice(0, 1)) + C.dim(s.slice(1));
      const left = allDone && where ? { text: `✔ ${D.dots([D.dashAllFinishedShort, where])}`, paint: done }
        : where ? { text: where, paint: C.yellow } : allDone ? { text: `✔ ${D.dashAllFinished}`, paint: done } : null;
      const keys = D.dashKeys(range, queued.length > 0);
      const paintKeys = queued.length ? C.yellow : C.dim;
      const space = width - textWidth(keys) - 2;
      if (!left) foot = ' '.repeat(Math.max(0, width - textWidth(keys))) + paintKeys(fitWidth(keys, width));
      else if (space < 8) foot = left.paint(fitWidth(left.text, width));
      else {
        const text = fitWidth(left.text, space);
        foot = left.paint(text) + ' '.repeat(width - textWidth(text) - textWidth(keys)) + paintKeys(keys);
      }
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
    const replay = replayCommand(RUNS_ROOT);
    const label = D.watchReplayOne('').trimEnd();
    out.push(C.dim('─'.repeat(width)), C.dim(label), C.dim(replay.slice(label.length).trim()));
    process.stdout.write(`${out.join('\n')}\n`);
  };

  if (early == null && liveCapable() && (anyRunning() || interactive())) {
    // 实时面板：备用屏幕里整屏重画，窗口大小变化时按新尺寸重画。全部结束后有人能按键时停在画面里，按 q 离开；
    // 离开后在原来的屏幕输出汇总，留作记录。有模型在排队时按 x 终止：第一次按要求确认，第二次给排队中的都写终止标记
    const screen = liveScreen(render);
    let quit = null;
    const done = new Promise((resolve) => { quit = resolve; });
    const onKeys = (d) => {
      const page = Math.max(1, termRows() - 4);
      for (const k of splitKeys(d.toString('utf8'))) {
        if (k === '\x03' || k === 'q') { quit(k === '\x03' ? 130 : 0); return; }
        if ((k === 'x' || k === 'X') && focus == null && queuedRuns().length) {
          if (confirmCancel) for (const run of queuedRuns()) { requestCancel(run.dir, 'watch'); cancelSent.add(run.id); }
          confirmCancel = !confirmCancel;
          continue;
        }
        confirmCancel = false;
        if (/^[0-9]$/.test(k) && focus == null && list().some((_, i) => numberOf(i) === Number(k))) { focus = Number(k); seatScroll.offset = 0; }
        else if ((k === '\x1b' || k === '\x7f' || k === '\b') && focus != null) focus = null;
        else (focus != null ? seatScroll : groupScroll).key(k, page);
      }
      screen.draw();
    };
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onKeys); }
    process.on('exit', () => screen.stop());
    process.on('SIGINT', () => quit(130));
    screen.start();
    handOff(); // 实时面板接手了备用屏幕，由它负责退出时恢复终端
    let code = null;
    done.then((c) => { code = c; });
    for (let tick = 0; code == null && !allDone; tick++) {
      screen.draw();
      if (settled()) { allDone = true; break; }
      await sleep(1000);
      for (const run of known.values()) run.meta = readMeta(run.dir) || run.meta;
      if (tick % 2 === 1) { runs = recentRuns(); refresh(); }
    }
    // 全部结束：有人能按键时停在画面里，之后只在按键和窗口变化时重画
    if (allDone && code == null && interactive()) {
      screen.draw();
      code = await done;
    }
    if (process.stdin.isTTY) { process.stdin.off('data', onKeys); process.stdin.setRawMode(false); process.stdin.pause(); }
    screen.stop();
    if (code != null && !allDone) { process.stdout.write(`${C.dim(D.watchDetached)}\n`); process.exit(code); }
    if (code === 130) process.exitCode = 130; // 结束后按 Ctrl+C 离开，照样写汇总，退出码和中断一致
  } else if (introPlayed) {
    process.stdout.write(LEAVE_SCREEN); // 动画期间全部结束了：离开备用屏幕，直接输出汇总
    handOff();
  } else if (anyRunning()) {
    // 输出被重定向时（比如被别的程序读取），每个任务状态变化时写一行。
    process.stdout.write(`${C.bold(groupTask(list()).text)}\n`);
    const states = new Map();
    for (;;) {
      for (const run of update()) {
        const st = seatState(run, feeds.get(run.id));
        const shown = D.dots([modelLabel(run.meta), st.right.filter(Boolean)[0]]);
        if (states.get(run.id) !== shown) process.stdout.write(`${shown}\n`);
        states.set(run.id, shown);
      }
      for (const { id, state, details } of describePlans(list(), planRuns)) {
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
