'use strict';
// 终端区：接在用量面板下面，整页往下滚就能看到（打开页面时停在星图和用量面板的位置）。和原生终端（foreman watch）用同一套视图规则：
//  - 带组名的派发（讨论、审查各席，或并发拆分的几份）是组任务视图：标题行写 <类型> · <模式> · <标题> · <等级>[ · round N]、
//    右边是各状态的个数；下面每席一块（Claude Code 席在最前）：身份行、分工行、正文、用量。
//    运行中的正文是最近说的话和最近几个动作，结束后是结论；点一席展开它的完整时间线（原生终端里按席位号）
//  - 没有组的单个任务是单任务视图：头部两行加完整时间线
//  - Claude Code 自己的对话流单独一栏，放在最前
// 有新内容时自动滚到底，往上翻看时不打扰。以后做多对话，切换对话就是换一组车道（termUnits）重画，标题跟着换。

const PANEL = { cols: new Map(), open: new Set(), seen: false, numbers: new Map(), fold: new Map(), doneLines: new Map(), allDone: false };
const groupPlans = (group, t) => [...new Map(B.life.filter((p) => p.k === 'fplan' && p.group === group && p.ts <= t).map((p) => [p.plan, p])).values()];
function dispatchQueue(t) {
  const snapshot = B.laneById.get('dispatch_queue')?.events.filter((e) => e.ts <= t).at(-1);
  const tickets = snapshot ? snapshot.tickets : [...B.runs.values()].filter((r) => r.started_at <= t).flatMap((r) => r.dispatch_queue || []);
  return [...new Map(tickets.map((q) => [`${q.agent}:${q.sequence ?? q.position}:${q.queued_at}`, q])).values()]
    .filter((q) => q.queued_at <= Display.recordedTime(t, displayPoints()));
}
// 终端区离可见范围不远时才重画（滚到星图那里时不用一直算）；刚滚进来时马上画一次
const termsNear = () => $('termsec').getBoundingClientRect().top < innerHeight + 200;
addEventListener('scroll', () => {
  const near = termsNear();
  if (near && !PANEL.seen) { B.version++; wake(); }
  PANEL.seen = near;
}, { passive: true });
$('more').addEventListener('click', () => $('termsec').scrollIntoView({ behavior: 'smooth' }));
$('termsec').addEventListener('click', (e) => {
  // 已结束的组：点折起来的那一行展开成栏；点展开的栏头收回成一行
  const line = e.target.closest('#termdone .dline'), head = e.target.closest('#termdone .tcol > header');
  if (line || head) { PANEL.fold.set((line || head.parentNode).dataset.lane, !!line); B.version++; wake(); return; }
  const seat = e.target.closest('.seat');
  if (!seat) return;
  const id = seat.dataset.lane;
  if (!PANEL.open.delete(id)) PANEL.open.add(id);
  B.version++; wake();
});

// 动效离场的席位仍留在终端区，才能和终端组视图一样回看整组。
function termUnits(t, L) {
  const units = [], cc = B.laneById.get('cc');
  if (cc && latest(cc) && latest(cc).started_at <= t) units.push({ id: 'cc', lane: cc });
  const groups = new Map();
  for (const lane of seatLanes(t)) {
    const key = groupKey(lane);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lane);
  }
  // 计划和队列可以先于第一条 run 到达，组面板不再依赖已有车道。
  for (const item of [...B.life.filter((p) => p.k === 'fplan' && p.ts <= t && planAlive(p, t)), ...dispatchQueue(t),
    ...[...B.runs.values()].filter((r) => r.kind === 'answer' && r.started_at <= t)])
    if (item.group && !groups.has(item.group)) groups.set(item.group, []);
  for (const [key, lanes] of groups) {
    if (key.startsWith('lane:')) for (const lane of lanes) units.push({ id: lane.id, lane });
    else units.push({ id: `group:${key}`, group: key, lanes });
  }
  return units;
}

// 正在跑的组和刚出结果的组在上面一排；全部结束一分钟以后挪到下面的"finished"一段，和刻度带脱钩：
// 结果被 Claude Code 读走、席位离开刻度带以后照样留着。最新结束的在最前。
// 最近一轮（用户最后一条消息之后）结束的组默认展开，样子和上面运行中的栏完全一样；更早轮次的默认折成一行，
// 点一下展开；展开的点栏头收回。用户点过的按点的来（PANEL.fold：栏 id → 是否展开）
const DONE_AFTER = 60000;
const unitLanes = (u) => (u.group ? u.lanes : [u.lane]);
const unitEnd = (u, t) => Math.max(0, ...unitLanes(u).map((l) => currentRun(l, t)?.ended_at ?? 0));
function unitFinished(u, t) {
  if (u.id === 'cc' || !unitLanes(u).length) return false;
  if (unitLanes(u).some((l) => laneStatus(l, t).running)) return false;
  if (u.group && dispatchQueue(t).some((q) => q.group === u.group)) return false;
  const end = unitEnd(u, t);
  return end > 0 && t - end > DONE_AFTER;
}
// 一排终端栏：按 units 的顺序放进 row（已有的栏复用），填好内容
function fillRow(row, units, t, seen) {
  units.forEach((u, i) => {
    let col = PANEL.cols.get(u.id);
    if (!col) { col = u.group ? groupColumn(u.id) : termColumn(u.id); PANEL.cols.set(u.id, col); }
    seen.add(u.id);
    // 先放进页面再填内容，滚到底才量得到高度
    if (row.children[i] !== col) row.insertBefore(col, row.children[i] || null);
    if (u.group) fillGroup(col, u, t); else fillColumn(col, u.lane, t);
  });
}
// 用户最后一条消息的时刻（B.prompts，不随车道事件裁掉）；没有记录时返回 -Infinity（全部算最近一轮）
function lastPromptAt(t) {
  let at = -Infinity;
  for (const ts of B.prompts) if (ts <= t) at = ts;
  return at;
}
const doneOpen = (u, t, since) => PANEL.fold.get(u.id) ?? unitEnd(u, t) >= since;
// 折起来的一行：和展开后的栏头写法一样（标题、各状态个数），再加结束时间和这一组所有轮次的费用
function doneLine(u, t) {
  // 不是今天结束的写上月-日，免得跨天时看着像倒着排
  const at = (ms) => new Date(Display.recordedTime(ms, displayPoints())), end = unitEnd(u, t), e = at(end);
  const date = e.toDateString() === at(t).toDateString() ? '' : `${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')} `;
  const when = `ended ${date}${hhmm(e.getTime())}`;
  let title, counts, runs;
  if (u.group) {
    const g = groupSeats(u, t);
    title = Display.groupTask(g.all, g.plans, g.queue).text; counts = Display.countsText(g.states);
    runs = [...B.runs.values()].filter((r) => r.group === u.group && r.started_at <= t);
  } else {
    const r = currentRun(u.lane, t), st = seatStatus(u.lane, r, t);
    title = Display.taskLine(Display.displayRun(r).meta, { round: roundOf(u.lane, t) }); counts = `${st.style.mark} ${st.style.word}`;
    runs = u.lane.runs.filter((x) => x.started_at <= t);
  }
  const cost = runs.reduce((n, r) => n + (r.cost_usd || 0), 0);
  return `▸ ${[title, counts, when, cost ? `$${fmtUsd(cost)}` : null].filter(Boolean).join(' · ')}`;
}
function renderDone(done, t, seen) {
  const box = $('termdone');
  box.hidden = !done.length;
  if (!done.length) return;
  if (!box.firstChild) {
    const sub = document.createElement('div'), row = document.createElement('div'), lines = document.createElement('div');
    sub.className = 'sub'; row.className = 'row'; lines.className = 'lines';
    box.append(sub, row, lines);
  }
  const [sub, row, lines] = box.children, since = lastPromptAt(t);
  const open = done.filter((u) => doneOpen(u, t, since)), closed = done.filter((u) => !open.includes(u));
  setText(sub, `finished · ${done.length}`);
  fillRow(row, open, t, seen);
  for (const u of open) PANEL.cols.get(u.id).classList.add('done-open');
  // 刚收起的栏移出这一排（栏本身由 renderTerms 最后统一回收）
  const keep = new Set(open.map((u) => PANEL.cols.get(u.id)));
  for (const c of [...row.children]) if (!keep.has(c)) c.remove();
  closed.forEach((u, i) => {
    let el = PANEL.doneLines.get(u.id);
    if (!el) { el = document.createElement('div'); el.className = 'dline'; el.dataset.lane = u.id; PANEL.doneLines.set(u.id, el); }
    if (lines.children[i] !== el) lines.insertBefore(el, lines.children[i] || null);
    setText(el, doneLine(u, t));
  });
  for (const [id, el] of PANEL.doneLines) if (!closed.some((u) => u.id === id)) { el.remove(); PANEL.doneLines.delete(id); }
}

function renderTerms(t, L) {
  const cc = B.laneById.get('cc'), title = cc && latest(cc) ? latest(cc).title : null;
  setText($('conv'), Display.D.conversation(title));
  if (!termsNear()) return;
  const box = $('terms'), seen = new Set(), units = termUnits(t, L);
  const done = units.filter((u) => unitFinished(u, t)).sort((a, b) => unitEnd(b, t) - unitEnd(a, t));
  const live = units.filter((u) => !done.includes(u));
  fillRow(box, live, t, seen);
  // 回到上面一排的栏（又续接了）去掉"可收起"的样子
  for (const u of live) PANEL.cols.get(u.id)?.classList.remove('done-open');
  renderDone(done, t, seen);
  for (const [id, col] of PANEL.cols) if (!seen.has(id)) { col.remove(); PANEL.cols.delete(id); }
}

// 填一段对话流，默认跟着贴在底部；往上翻看时不再跟随，翻回底部又恢复。
// 每次重画都按这个状态重新贴底（栏的高度变了、刚放进页面时量错了，下一次也能纠正）
function fillFlow(ol, lines) {
  if (ol.stick == null) {
    ol.stick = true;
    // 只认人滚的：在这一栏上刚用过滚轮、按过鼠标（含拖滚动条）或按键之后一秒内的滚动才算；
    // 程序贴底、栏变窄内容变高这些引起的滚动事件不算，免得被当成往上翻了
    ol.userAt = 0;
    for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart']) ol.addEventListener(type, () => { ol.userAt = performance.now(); }, { passive: true });
    ol.addEventListener('scroll', () => {
      if (performance.now() - ol.userAt > 1000) return;
      ol.stick = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 8;
    }, { passive: true });
  }
  fillTerm(ol, lines);
  if (ol.stick) ol.scrollTop = ol.scrollHeight;
}
const setAvatar = (img, key) => { if (img.dataset.key !== key) { img.src = avatarSrc(key); img.alt = look(key).name; img.dataset.key = key; } };


// ---- 单任务视图（Claude Code 和没有组的任务）：身份行、任务行、完整时间线 ----
function termColumn(id) {
  const col = document.createElement('div');
  col.className = 'tcol';
  col.dataset.lane = id;
  col.innerHTML = '<header><img alt=""><b></b><span class="st"></span></header><div class="task"></div><ol class="term"></ol>';
  return col;
}

function fillColumn(col, lane, t) {
  const r = currentRun(lane, t) || latest(lane), key = avatarFor(r.model, r.agent_type), st = laneStatus(lane, t), isCC = lane.id === 'cc', round = roundOf(lane, t);
  col.style.setProperty('--tint', rgba(key));
  col.classList.toggle('running', st.running && !isCC);
  col.classList.toggle('cc', isCC);
  setAvatar(col.querySelector('img'), key);
  setText(col.querySelector('b'), isCC ? 'Claude Code' : Display.modelLabel(Display.displayRun(r).meta));
  setText(col.querySelector('.st'), `${st.mark} ${st.word} ${Display.clock(laneElapsed(lane, t) * 1000)}`);
  col.querySelector('.st').dataset.tone = st.tone;
  setText(col.querySelector('.task'), isCC ? [shortModel(r.model), r.title].filter(Boolean).join(' · ')
    : Display.taskLine(Display.displayRun(r).meta, { round }));
  fillFlow(col.querySelector('.term'), timeline(lane, t, { open: true }).slice(-400));
}

// ---- 组任务视图 ----
function groupColumn(id) {
  const col = document.createElement('div');
  col.className = 'tcol tgroup';
  col.dataset.lane = id;
  col.innerHTML = '<header><b></b><span class="cnt"></span></header><div class="seats"></div>';
  col.seats = new Map();
  return col;
}

// 一组的席位块（Claude Code 席在前）和席位号，按号排好；终端栏和用量表的组共用，号码和顺序两边一样
function groupSeats(u, t) {
  const history = [...B.runs.values()].filter((r) => r.group === u.group && r.started_at <= t).map(Display.displayRun);
  const chosen = new Set(Display.current(history).map((r) => r.id));
  const hosts = history.filter((r) => r.meta.participant === 'host' && chosen.has(r.id));
  const blocks = [...hosts.map((r) => ({ id: `host:${r.id}`, host: B.runs.get(r.id) })), ...u.lanes.map((lane) => ({ id: lane.id, lane }))]
    .filter((b) => chosen.has((b.host || currentRun(b.lane, t)).id));
  const all = blocks.map((b) => Display.displayRun(b.host || currentRun(b.lane, t)));
  const numberKey = `${all[0]?.meta.session || ''}:${u.group}`;
  const plans = groupPlans(u.group, t);
  const numbers = Display.seatNumbers(all, history, PANEL.numbers.get(numberKey), plans);
  PANEL.numbers.set(numberKey, numbers);
  blocks.sort((a, b) => numbers.runs.get((a.host || currentRun(a.lane, t)).id) - numbers.runs.get((b.host || currentRun(b.lane, t)).id));
  all.sort((a, b) => numbers.runs.get(a.id) - numbers.runs.get(b.id));
  const queue = dispatchQueue(t).filter((q) => q.group === u.group || q.group == null && all.some((r) => r.meta.plan === q.plan))
    .filter((q) => !Display.queuedStarted(q, history));
  // 各席此刻的状态（Claude Code 席算交过了）：组头计数和用量表组行的计数共用
  const states = blocks.map((b) => b.host ? { kind: 'ok' } : seatStatus(b.lane, currentRun(b.lane, t), t));
  return { history, blocks, all, plans, numbers, queue, states };
}

function fillGroup(col, u, t) {
  const { history, blocks, all, plans, numbers, queue, states } = groupSeats(u, t);
  for (const run of all) { const b = blocks.find((b) => (b.host || currentRun(b.lane, t)).id === run.id); if (b.lane) run.meta.round = roundOf(b.lane, t); }
  const head = Display.groupTask(all, plans, queue);
  setText(col.querySelector('header b'), head.text);
  const notes = Display.planNotes(plans, history.map((r) => ({ ...r,
    outcome: Display.resultOutcome(r.meta.ended_at != null && r.meta.ended_at <= t || r.meta.participant === 'host' ? r.result : { status: 'running' }, r.meta) })));
  let noteBox = col.querySelector('.plan-notes');
  if (!noteBox) { noteBox = document.createElement('div'); noteBox.className = 'plan-notes'; col.insertBefore(noteBox, col.querySelector('.seats')); }
  noteBox.replaceChildren();
  for (const p of notes.filter((p) => p.details || p.state === 'incomplete')) { const line = document.createElement('div'); line.textContent = p.line; noteBox.append(line); }
  const count = col.querySelector('.cnt'); count.replaceChildren();
  for (const p of Display.countParts([...states, ...queue.map(() => ({ kind: 'queued' }))])) {
    if (count.children.length) count.append(' ');
    const part = document.createElement('i'); part.className = p.kind; part.dataset.tone = Display.toneOf(p.kind); part.textContent = p.text; count.append(part);
  }
  col.classList.toggle('running', states.some((s) => s.running) || queue.length > 0);
  const box = col.querySelector('.seats'), seen = new Set();
  blocks.forEach((b, i) => {
    let el = col.seats.get(b.id);
    if (!el) { el = seatShell(b.id); col.seats.set(b.id, el); }
    seen.add(b.id);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    if (b.host) fillHostSeat(el, b.host, numbers.runs.get(b.host.id)); else fillSeat(el, b.lane, t, numbers.runs.get(currentRun(b.lane, t).id), head.split);
  });
  for (const [id, el] of col.seats) if (!seen.has(id)) { el.remove(); col.seats.delete(id); }
  // 先量全文实际高度，再决定是否每席保留四行，展开的席始终显示全文。
  const collapse = !queue.length && !states.some((s) => s.running) && box.clientHeight > 0 && box.scrollHeight > box.clientHeight;
  if (collapse) for (const b of blocks) {
    const el = col.seats.get(b.id);
    if (!PANEL.open.has(b.id)) fillFlow(el.querySelector('.term'), Display.collapseLines(el.fullLines, true, 'click to open').map((line) => typeof line === 'string' ? { cls: 'plain', text: line } : line));
  }
  let finished = col.querySelector('.all-done');
  if (!finished) { finished = document.createElement('div'); finished.className = 'all-done'; col.append(finished); }
  setText(finished, states.length && !queue.length && !states.some((s) => s.running) ? `✔ ${Display.D.dashAllFinishedShort}` : '');
  let pending = col.querySelector('.dispatch-queue');
  if (!pending) { pending = document.createElement('div'); pending.className = 'dispatch-queue'; col.append(pending); }
  pending.replaceChildren();
  for (const q of queue) { const line = document.createElement('div'); line.textContent = Display.queuedLine(q, Display.recordedTime(t, displayPoints())); pending.append(line); }
  // 服务端最多发 30 张票据，多出来的写一行条数
  const snapshot = B.laneById.get('dispatch_queue')?.events.filter((e) => e.ts <= t).at(-1);
  if (snapshot && snapshot.total > (snapshot.tickets || []).length) { const line = document.createElement('div'); line.textContent = Display.D.watchMoreQueued(snapshot.total - snapshot.tickets.length); pending.append(line); }
}

function seatShell(id) {
  const el = document.createElement('section');
  el.className = 'seat';
  el.dataset.lane = id;
  el.innerHTML = '<div class="id"><span class="no"></span><img alt=""><i class="mk"></i><b></b><span class="st"></span></div><div class="role"></div><ol class="term"></ol><div class="use"><span></span><span class="rid"></span></div>';
  return el;
}

// 一席：身份行（席位号、模型、状态和用时）、分工行（角色或这一份的标题）、正文、结束后的用量
function fillSeat(el, lane, t, no, split = false) {
  const r = currentRun(lane, t), run = Display.displayRun(r), key = avatarFor(r.model, r.agent_type), st = seatStatus(lane, r, t);
  const open = PANEL.open.has(lane.id), ended = r.ended_at != null && r.ended_at <= t;
  el.style.setProperty('--tint', rgba(key));
  el.classList.toggle('running', !!st.running); el.classList.toggle('open', open);
  el.classList.toggle('bad', st.kind === 'failed');
  el.dataset.kind = st.kind || '';
  el.dataset.tone = Display.toneOf(st.kind); // 状态记号和状态词按色调上色，和终端一致
  setAvatar(el.querySelector('img'), key);
  setText(el.querySelector('.no'), String(no));
  setText(el.querySelector('.mk'), st.style.mark);
  setText(el.querySelector('b'), Display.modelLabel(run.meta));
  setText(el.querySelector('.st'), st.right.filter(Boolean).join(' '));
  setText(el.querySelector('.role'), Display.seatLine(run.meta, { title: split }));
  const ol = el.querySelector('.term'), width = Math.max(20, Math.floor((ol.clientWidth || 560) / 6.6) - 4);
  let lines = open ? timeline(lane, t, { open: true }) : ended ? conclusion(r, width)
    : Display.liveLines(liveState(lane, r, t), 8, width).map((text) => ({ cls: 'plain', text }));
  if (!lines.length && st.running && !liveState(lane, r, t).api.req) lines = [{ cls: 'plain', text: Display.D.watchWorking }];
  el.fullLines = lines;
  fillFlow(ol, lines);
  const use = el.querySelector('.use'); use.hidden = !ended;
  if (ended) { setText(use.firstChild, Display.seatUsage(run.meta, run.result)); setText(use.lastChild, r.id); }
}

function fillHostSeat(el, h, no = 0) {
  const run = Display.displayRun(h), open = PANEL.open.has(el.dataset.lane);
  const st = Display.seatState(run.meta, run.result, {}, 0);
  el.style.setProperty('--tint', rgba('claude')); el.classList.add('host'); el.classList.toggle('open', open);
  el.dataset.tone = Display.toneOf(st.kind);
  setAvatar(el.querySelector('img'), 'claude');
  setText(el.querySelector('.no'), String(no));
  setText(el.querySelector('.mk'), st.style.mark);
  setText(el.querySelector('b'), Display.modelLabel(run.meta));
  setText(el.querySelector('.st'), st.right.filter(Boolean).join(' '));
  setText(el.querySelector('.role'), Display.seatLine(run.meta));
  const ol = el.querySelector('.term'), width = Math.max(20, Math.floor((ol.clientWidth || 560) / 6.6) - 4);
  el.fullLines = conclusion(h, width); fillFlow(ol, el.fullLines);
  const use = el.querySelector('.use'); use.hidden = false;
  setText(use.firstChild, Display.seatUsage(run.meta, run.result)); setText(use.lastChild, h.id);
}
