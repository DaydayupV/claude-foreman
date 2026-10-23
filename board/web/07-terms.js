'use strict';
// 终端区：接在用量面板下面，整页往下滚就能看到（打开页面时停在星图和用量面板的位置）。和原生终端（foreman watch）用同一套视图规则：
//  - 带组名的派发（讨论、审查各席，或并发拆分的几份）是组任务视图：标题行写 <类型> · <模式> · <标题> · <等级>[ · round N]、
//    右边是各状态的个数；下面每席一块（Claude Code 席在最前）：身份行、分工行、正文、用量。
//    运行中的正文是最近说的话和最近几个动作，结束后是结论；点一席展开它的完整时间线（原生终端里按席位号）
//  - 没有组的单个任务是单任务视图：头部两行加完整时间线
//  - Claude Code 自己的对话流单独一栏，放在最前
// 有新内容时自动滚到底，往上翻看时不打扰。以后做多对话，切换对话就是换一组车道（termUnits）重画，标题跟着换。

const PANEL = { cols: new Map(), open: new Set(), seen: false };
// 终端区离可见范围不远时才重画（滚到星图那里时不用一直算）；刚滚进来时马上画一次
const termsNear = () => $('termsec').getBoundingClientRect().top < innerHeight + 200;
addEventListener('scroll', () => {
  const near = termsNear();
  if (near && !PANEL.seen) { B.version++; wake(); }
  PANEL.seen = near;
}, { passive: true });
$('more').addEventListener('click', () => $('termsec').scrollIntoView({ behavior: 'smooth' }));
$('termsec').addEventListener('click', (e) => {
  const seat = e.target.closest('.seat');
  if (!seat) return;
  const id = seat.dataset.lane;
  if (!PANEL.open.delete(id)) PANEL.open.add(id);
  B.version++; wake();
});

// 终端页的几栏：Claude Code，然后刻度带里的每一组（有组名的是组面板，没有的每个任务一栏单任务视图）
function termUnits(t, L) {
  const units = [], cc = B.laneById.get('cc');
  if (cc && latest(cc) && latest(cc).started_at <= t) units.push({ id: 'cc', lane: cc });
  for (const g of L ? L.groups : []) {
    const lanes = g.lanes.filter((l) => !l.ghost && latest(l).started_at <= t);
    if (!lanes.length) continue;
    if (g.key.startsWith('lane:')) for (const lane of lanes) units.push({ id: lane.id, lane });
    else units.push({ id: `group:${g.key}`, group: g.key, lanes });
  }
  return units;
}

function renderTerms(t, L) {
  const cc = B.laneById.get('cc'), title = cc && latest(cc) ? latest(cc).title : null;
  setText($('conv'), TEXT.conversation(title));
  if (!termsNear()) return;
  const box = $('terms'), seen = new Set();
  termUnits(t, L).forEach((u, i) => {
    let col = PANEL.cols.get(u.id);
    if (!col) { col = u.group ? groupColumn(u.id) : termColumn(u.id); PANEL.cols.set(u.id, col); }
    seen.add(u.id);
    // 先放进页面再填内容，滚到底才量得到高度
    if (box.children[i] !== col) box.insertBefore(col, box.children[i] || null);
    if (u.group) fillGroup(col, u, t); else fillColumn(col, u.lane, t);
  });
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
const roundOf = (lane, t) => Math.max(1, ...lane.runs.filter((x) => x.started_at <= t).map((x) => x.round || 1));

// ---- 单任务视图（Claude Code 和没有组的任务）：身份行、任务行、完整时间线 ----
function termColumn(id) {
  const col = document.createElement('div');
  col.className = 'tcol';
  col.dataset.lane = id;
  col.innerHTML = '<header><img alt=""><b></b><span class="st"></span></header><div class="task"></div><ol class="term"></ol>';
  return col;
}

function fillColumn(col, lane, t) {
  const r = latest(lane), key = avatarFor(r.model, r.agent_type), st = laneStatus(lane, t), isCC = lane.id === 'cc', round = roundOf(lane, t);
  col.style.setProperty('--tint', rgba(key));
  col.classList.toggle('running', st.running && !isCC);
  col.classList.toggle('cc', isCC);
  setAvatar(col.querySelector('img'), key);
  setText(col.querySelector('b'), isCC ? 'Claude Code' : `${shortModel(r.model) || look(key).name}${r.effort ? ` ${r.effort}` : ''}`);
  setText(col.querySelector('.st'), `● ${st.word} ${fmtDur(laneStats(lane, t).elapsed)}${isCC ? '' : ` · ${CHANNEL[r.agent_type] || r.agent_type || ''}`}`);
  setText(col.querySelector('.task'), isCC ? [shortModel(r.model), r.title].filter(Boolean).join(' · ')
    : [r.kind, r.title, r.level, round > 1 ? `round ${round}` : null].filter(Boolean).join(' · '));
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

const COUNT_MARKS = [['running', '●'], ['ok', '✔'], ['failed', '✗']];
function fillGroup(col, u, t) {
  const head = groupHead(u.lanes, t), counts = { running: 0, ok: 0, failed: 0 };
  for (const lane of u.lanes) { const st = laneStatus(lane, t); counts[st.running ? 'running' : st.word === 'done' ? 'ok' : 'failed']++; }
  setText(col.querySelector('header b'), head.title);
  const cnt = col.querySelector('.cnt'), sig = COUNT_MARKS.map(([k]) => counts[k]).join('|');
  if (cnt.dataset.sig !== sig) {
    cnt.dataset.sig = sig; cnt.innerHTML = '';
    for (const [k, mark] of COUNT_MARKS) if (counts[k]) { const s = document.createElement('i'); s.className = k; s.textContent = `${mark}${counts[k]}`; cnt.append(s); }
  }
  col.classList.toggle('running', counts.running > 0);
  // Claude Code 席（交过报告的）在最前，其余按席位顺序
  const cc = B.laneById.get('cc'), host = cc ? cc.runs.filter((r) => r.kind === 'answer' && r.group === u.group && r.started_at <= t).pop() : null;
  const blocks = [...(host ? [{ id: `host:${u.group}`, host }] : []), ...u.lanes.map((lane) => ({ id: lane.id, lane }))];
  const box = col.querySelector('.seats'), seen = new Set();
  blocks.forEach((b, i) => {
    let el = col.seats.get(b.id);
    if (!el) { el = seatShell(b.id); col.seats.set(b.id, el); }
    seen.add(b.id);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    if (b.host) fillHostSeat(el, b.host); else fillSeat(el, b.lane, t, i + (host ? 0 : 1));
  });
  for (const [id, el] of col.seats) if (!seen.has(id)) { el.remove(); col.seats.delete(id); }
}

function seatShell(id) {
  const el = document.createElement('section');
  el.className = 'seat';
  el.dataset.lane = id;
  el.innerHTML = '<div class="id"><span class="no"></span><img alt=""><b></b><span class="st"></span></div><div class="role"></div><ol class="term"></ol><div class="use"><span></span><span class="rid"></span></div>';
  return el;
}

// 一席：身份行（席位号、模型、状态和用时）、分工行（角色或这一份的标题）、正文、结束后的用量
function fillSeat(el, lane, t, no) {
  const r = lane.runs.filter((x) => x.started_at <= t).pop() || latest(lane), key = avatarFor(r.model, r.agent_type), st = laneStatus(lane, t);
  const open = PANEL.open.has(lane.id), round = roundOf(lane, t);
  el.style.setProperty('--tint', rgba(key));
  el.classList.toggle('running', st.running);
  el.classList.toggle('open', open);
  el.classList.toggle('bad', !st.running && st.word !== 'done');
  setAvatar(el.querySelector('img'), key);
  setText(el.querySelector('.no'), String(r.seat ?? no));
  setText(el.querySelector('b'), `${shortModel(r.model) || look(key).name}${r.effort ? ` ${r.effort}` : ''}`);
  // 用时和用量只算这一轮的任务（和原生组视图一样），不把上一轮加进来
  const ended = r.ended_at != null && r.ended_at <= t, took = (ended ? r.ended_at : t) - r.started_at;
  setText(el.querySelector('.st'), `${st.running ? '●' : st.word === 'done' ? '✔' : '✗'} ${st.word} ${fmtDur(took / 1000)}${round > 1 ? ` · round ${round}` : ''}`);
  // 分工行：角色；拆开的执行任务每份标题不同，再写这一份的标题和等级（组标题里放不下）
  const exec = r.kind === 'exec' || r.kind === 'image';
  setText(el.querySelector('.role'), [r.role ? `[${r.role}]` : null, exec ? r.title : null, exec ? r.level : null, CHANNEL[r.agent_type] || r.agent_type].filter(Boolean).join(' · '));
  let lines;
  if (open) lines = timeline(lane, t, { open: true }).slice(-400);
  else if (!ended) lines = timeline(lane, t, { limit: 5 });
  else lines = conclusion(r);
  if (!lines.length) lines = [{ ts: r.started_at, cls: 'act fold', text: st.running ? 'working…' : '(no report)' }];
  fillFlow(el.querySelector('.term'), lines);
  const use = el.querySelector('.use');
  use.hidden = !ended;
  if (ended) {
    const v = verdictCounts(lane.id, t);
    const u = r.usage || {}, inAll = (u.input || 0) + (u.cached || 0) + (u.cache_write || 0);
    setText(use.firstChild, [inAll ? `${fmtTok(inAll)} in` : null, u.output ? `${fmtTok(u.output)} out` : null,
      r.cost_usd != null ? `$${fmtUsd(r.cost_usd)}` : null, v ? `✓${v.a} ◐${v.p} ✗${v.r}` : null].filter(Boolean).join(' · '));
    setText(use.lastChild, r.id);
  }
}

// 结束后的正文：讨论写立场，执行写报告摘要，审查写结论和各条问题
function conclusion(r) {
  const at = r.ended_at, out = [];
  if (r.review) {
    out.push({ ts: at, cls: 'node', text: `${r.review.verdict} · ${r.review.findings.length} findings` });
    for (const f of r.review.findings) out.push({ ts: at, cls: 'act', text: [f.severity, f.where, f.title].filter(Boolean).join(' · ') });
  } else if (r.report_head) out.push({ ts: at, cls: 'node', text: r.report_head });
  return out;
}

// Claude Code 席：交过的报告（没有用量）
function fillHostSeat(el, h) {
  el.style.setProperty('--tint', rgba('claude'));
  el.classList.add('host');
  setAvatar(el.querySelector('img'), 'claude');
  setText(el.querySelector('.no'), '0');
  setText(el.querySelector('b'), `Claude Code${h.model ? ` · ${shortModel(h.model)}` : ''}`);
  setText(el.querySelector('.st'), `✔ submitted ${hhmm(h.started_at)}${(h.round || 1) > 1 ? ` · round ${h.round}` : ''}`);
  setText(el.querySelector('.role'), [h.role ? `[${h.role}]` : null, TEXT.hostSeat].filter(Boolean).join(' · '));
  fillFlow(el.querySelector('.term'), h.report_head ? [{ ts: h.started_at, cls: 'node', text: h.report_head }] : []);
  const use = el.querySelector('.use');
  use.hidden = false;
  setText(use.firstChild, TEXT.hostSeatNote);
  setText(use.lastChild, h.id);
}
