'use strict';
// 世界里的 DOM：Claude Code 卡片、席位卡片、产出框、组头。按车道 id 复用元素，只改变了的文字和位置。

const CHANNEL = { 'codex cli': 'Codex CLI', 'opencode cli': 'opencode', 'pi cli': 'pi', api: 'API', host: 'Claude Code' };
// 用量表悬停时其余车道压暗的程度（卡片、产出框、光线共用）
const dimOf = (id) => (UI.hot && id !== UI.hot ? 0.32 : 1);
const place = (el, b) => { const s = el.style, x = `${b.x}px`, y = `${b.y}px`; if (s.left !== x) s.left = x; if (s.top !== y) s.top = y; };

function cardShell(id) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.lane = id;
  el.innerHTML = '<img class="av" alt=""><div class="hd"><div class="model"></div><div class="st"></div><div class="tl"></div><div class="rate"></div></div><ol class="term"></ol><div class="think"></div>';
  worldEl.append(el);
  return el;
}

function fillCard(el, lane, t) {
  const r = currentRun(lane, t) || latest(lane), key = avatarFor(r.model, r.agent_type), st = laneStatus(lane, t), s = laneStats(lane, t), isCC = lane.id === 'cc';
  el.style.setProperty('--tint', rgba(key));
  el.classList.toggle('hot', UI.hot === lane.id); el.classList.toggle('dim', dimOf(lane.id) < 1);
  el.classList.toggle('running', st.running);
  const img = el.querySelector('.av');
  if (img.dataset.key !== key) { img.src = avatarSrc(key); img.alt = look(key).name; img.dataset.key = key; }
  setText(el.querySelector('.model'), isCC ? 'Claude Code' : `${shortModel(r.model) || look(key).name}${r.effort ? ` ${r.effort}` : ''}`);
  el.querySelector('.model').title = Display.modelLabel(Display.displayRun(r).meta);
  const stEl = el.querySelector('.st');
  setText(stEl, `${st.mark} ${st.word} ${Display.clock(laneElapsed(lane, t) * 1000)}`);
  stEl.classList.toggle('bad', st.kind === 'failed');
  const round = roundOf(lane, t);
  setText(el.querySelector('.tl'), isCC ? [shortModel(r.model), r.title].filter(Boolean).join(' · ')
    : [r.kind, r.role ? `[${r.role}]` : null, r.title, r.level, round > 1 ? `round ${round}` : null].filter(Boolean).join(' · '));
  const rate = el.querySelector('.rate'), sig = `${Math.round(s.rate)}|${s.avg == null ? '—' : Math.round(s.avg)}|${s.output}`;
  rate.title = s.usage_unattributed ? TEXT.usageUnattributed : '';
  if (rate.dataset.sig !== sig) {
    rate.dataset.sig = sig;
    rate.innerHTML = '';
    const now = document.createElement('span');
    now.className = 'now';
    now.textContent = `now ≈ ${Math.round(s.rate)} tok/s`;
    rate.append(now, ` · gen avg ≈ ${s.avg != null ? Math.round(s.avg) : '—'} · out ${s.output == null ? '—' : fmtTok(s.output)}`);
  }
  // 详情档位给完整的对话流（最近 40 行），摘要档位给最后几行
  const lod = VIEW_LOD();
  if (lod === 2) fillTerm(el.querySelector('.term'), timeline(lane, t, { open: true }).slice(-40));
  else if (lod === 1) fillTerm(el.querySelector('.term'), timeline(lane, t, { limit: 6 }));
  setText(el.querySelector('.think'), thinkingLine(lane, t));
  decorateCard(el, lane, t);
}
const VIEW_LOD = () => Number(worldEl.dataset.lod || 0);

function fillTerm(ol, lines) {
  const sig = lines.map((l) => `${l.ts}${l.text}${l.cls}`).join('\n');
  if (ol.dataset.sig === sig) return;
  ol.dataset.sig = sig;
  ol.innerHTML = '';
  let lastMin = '';
  for (const l of lines) {
    const li = document.createElement('li'), ts = document.createElement('span'), mk = document.createElement('span');
    li.className = l.cls;
    ts.className = 'ts';
    const m = hhmm(l.ts), act = l.cls.startsWith('act');
    ts.textContent = l.cls === 'plain' || act || m === lastMin ? '' : m;
    if (!act) lastMin = m;
    mk.className = 'mk';
    mk.textContent = l.cls === 'plain' ? '' : act ? '│ ' : l.cls.startsWith('user') ? '▌ ' : '◆ ';
    li.append(ts, mk, l.text);
    ol.append(li);
  }
}

function dedupeFiles(list) { const seen = new Map(); for (const f of list) seen.set(f.path, f); return [...seen.values()]; }

// lead：标题下面先写的几行（派发计划、Claude Code 席报告、裁决这些流程上的事），排在文件和报告前面
// thumbs：出图任务的缩略图地址（/image?run=&n=），放在输出框右侧
function fillOut(box, title, files, report, lead = [], thumbs = []) {
  const sig = `${title}|${lead.join('|')}|${files.map((f) => f.kind + f.path).join(',')}|${report}|${thumbs.join(',')}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = '';
  // 有缩略图时给文字让出右边（每张约 39 像素宽）
  box.style.paddingRight = thumbs.length ? `${thumbs.length * 39 + 8}px` : '';
  const h = document.createElement('h4');
  h.textContent = title;
  box.append(h);
  if (thumbs.length) {
    const strip = document.createElement('div');
    strip.className = 'thumbs';
    for (const src of thumbs) { const img = document.createElement('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; img.onerror = () => img.remove(); strip.append(img); }
    box.append(strip);
  }
  for (const line of lead) { const d = document.createElement('div'); d.className = 'lead'; d.textContent = line; box.append(d); }
  for (const f of files.slice(-6)) {
    const d = document.createElement('div'), i = document.createElement('i');
    d.className = 'f';
    i.textContent = EDIT_MARKS[f.kind] || '✎';
    d.append(i, baseName(f.path));
    d.title = f.path;
    box.append(d);
  }
  if (files.length > 6) { const d = document.createElement('div'); d.className = 'f empty'; d.textContent = `… +${files.length - 6} files`; box.append(d); }
  if (report) { const d = document.createElement('div'); d.className = 'rep'; d.textContent = report; box.append(d); }
  if (!files.length && !report && !lead.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'nothing yet'; box.append(d); }
}

// 席位产出框只写最近一次任务的产出（上一轮的已经被 Claude Code 读走了）
function fillLaneOut(box, lane, t) {
  const live = lane.runs.filter((x) => x.started_at <= t), r = live[live.length - 1] || latest(lane);
  box.classList.toggle('dim', dimOf(lane.id) < 1);
  box.style.setProperty('--tint', rgba(avatarFor(r.model, r.agent_type)));
  const ended = r.ended_at != null && r.ended_at <= t, files = [];
  if (ended) for (const c of r.changed || []) files.push({ kind: c.kind || 'update', path: c.path });
  for (const e of lane.events) if (e.run === r.id && e.k === 'edit' && e.ts <= t) files.push(editParts(e.t));
  let report = ended ? r.report_head || '' : '';
  // 问题总数用完整计数（review.findings 只带前 8 条），老消息没有计数时用 report_head 里写的原数
  const total = r.display?.report?.findings_counts?.total;
  if (ended && r.review) report = total != null ? `${r.review.verdict} · ${total} findings` : r.report_head || `${r.review.verdict} · ${r.review.findings.length} findings`;
  const thumbs = ended && r.kind === 'image' && r.images ? Array.from({ length: Math.min(3, r.images) }, (_, i) => `image?run=${encodeURIComponent(r.id)}&n=${i}`) : [];
  fillOut(box, `OUTPUT · round ${roundOf(lane, t)}`, dedupeFiles(files), report, scopeLead(lane, t), thumbs);
}

function renderWorld(t, L) {
  const seen = new Set(['cc']);
  // Claude Code
  let cc = UI.cards.get('cc');
  if (!cc) { cc = cardShell('cc'); UI.cards.set('cc', cc); }
  place(cc, L.cc);
  const ccLane = B.laneById.get('cc');
  if (ccLane && latest(ccLane)) fillCard(cc, ccLane, t);
  else {
    cc.style.setProperty('--tint', rgba('claude'));
    const img = cc.querySelector('.av');
    if (!img.dataset.key) { img.src = avatarSrc('claude'); img.dataset.key = 'claude'; }
    setText(cc.querySelector('.model'), 'Claude Code');
    setText(cc.querySelector('.st'), 'no transcript yet');
  }
  let ccOut = UI.outs.get('cc');
  if (!ccOut) { ccOut = document.createElement('div'); ccOut.className = 'outbox cc'; worldEl.append(ccOut); UI.outs.set('cc', ccOut); }
  place(ccOut, L.ccOut);
  ccOut.style.setProperty('--tint', rgba('claude'));
  const span = ccLife(t), from = span.from ?? -Infinity, to = span.to ?? t;
  const ccFiles = ccLane ? ccLane.events.filter((e) => e.k === 'edit' && e.ts > from && e.ts <= to).map((e) => editParts(e.t)) : [];
  fillOut(ccOut, 'CLAUDE CODE · OUTPUT', dedupeFiles(ccFiles), '', ccLead(t, from, to));

  // 刻度带上的各组标题
  const headSeen = new Set();
  for (const g of L.groups) {
    headSeen.add(g.key);
    let h = UI.heads.get(g.key);
    if (!h) { h = document.createElement('div'); h.className = 'ghead'; h.dataset.key = g.key; h.innerHTML = '<b></b>'; worldEl.append(h); UI.heads.set(g.key, h); }
    place(h, g.head);
    h.classList.toggle('old', g.old);
    h.classList.toggle('collapsed', g.collapsed);
    const head = groupHead(g.lanes, t);
    setText(h.querySelector('b'), `${g.collapsed ? '▸' : '▾'} ${head.title}`);
    h.title = `${head.title} · ${head.counts}`;
    for (const lane of g.lanes) {
      const row = L.rows.get(lane.id);
      let card = UI.cards.get(lane.id), out = UI.outs.get(lane.id);
      if (!row) { if (card) card.hidden = true; if (out) out.hidden = true; continue; }
      seen.add(lane.id);
      if (!card) { card = cardShell(lane.id); UI.cards.set(lane.id, card); }
      if (!out) { out = document.createElement('div'); out.className = 'outbox'; worldEl.append(out); UI.outs.set(lane.id, out); }
      card.hidden = out.hidden = false;
      place(card, row.card); place(out, row.out);
      card.classList.toggle('ghost', !!lane.ghost); out.classList.toggle('ghost', !!lane.ghost);
      if (lane.ghost) { fillGhost(card, lane, t); continue; }
      fillCard(card, lane, t);
      fillLaneOut(out, lane, t);
    }
  }
  // 不在版面上的卡片和产出框藏起来；虚影卡被真卡片接替后整个删掉（不然它的产出框会和真的叠在一起）
  for (const map of [UI.cards, UI.outs]) for (const [id, el] of map) {
    if (seen.has(id)) continue;
    if (id.startsWith('ghost:')) { el.remove(); map.delete(id); } else el.hidden = true;
  }
  for (const [id, el] of UI.heads) el.hidden = !headSeen.has(id);
}

function groupHead(all, t) {
  const lanes = all.filter((l) => !l.ghost), planned = all.length - lanes.length;
  if (!lanes.length) {
    const p = plansAt(t).find((x) => x.id === all[0].plan);
    return { title: [p && p.module, 'planned', p && p.ev.cell].filter(Boolean).join(' · '), counts: `${planned} planned` };
  }
  // 和原生终端的组视图一样：执行拆成几份的写 split，标题是各份标题用" / "连起来；讨论和审查带角色的写 roles，否则 panel；
  // 各份等级不同时不写等级（写在各自的分工行里）
  const runs = lanes.map((l) => { const run = Display.displayRun(currentRun(l, t)); run.meta.round = roundOf(l, t); return run; });
  const st = lanes.map((l) => laneStatus(l, t)), running = st.filter((s) => s.running).length;
  return { title: Display.groupTask(runs).text,
    counts: `${planned ? `${planned} planned · ` : ''}${running ? `${running} running · ` : ''}${st.length - running} finished` };
}

// 计划里还没启动的席位：头像和模型先显示出来（虚线框），状态写 planned
function fillGhost(el, lane, t) {
  const s = lane.seat, key = avatarFor(s.model, null);
  el.style.setProperty('--tint', rgba(key));
  el.classList.remove('running');
  const img = el.querySelector('.av');
  if (img.dataset.key !== key) { img.src = avatarSrc(key); img.alt = look(key).name; img.dataset.key = key; }
  setText(el.querySelector('.model'), shortModel(s.model) || look(key).name);
  // 审查的补漏席：其他席都结束（去重以后）才启动，先写清楚在等什么；其他席都结束了就轻轻发光
  const gap = gapState(lane, t);
  el.classList.toggle('gap-ready', gap === 'ready');
  const state = Display.outcomeStyle({ status: 'not_started' });
  setText(el.querySelector('.st'), `${state.mark} ${state.word} · seat ${s.seat}${s.required ? ' · required' : ''}`);
  setText(el.querySelector('.tl'), gap === 'ready' ? TEXT.gapReady : gap ? TEXT.gapWaiting : [s.role ? `[${s.role}]` : null, 'waiting to launch'].filter(Boolean).join(' · '));
  const rate = el.querySelector('.rate');
  if (rate.dataset.sig !== '') { rate.dataset.sig = ''; rate.innerHTML = ''; }
  fillTerm(el.querySelector('.term'), []);
  setText(el.querySelector('.think'), '');
}

// Claude Code 产出框的流程行：最近一份计划的决策记录、Claude Code 席报告、派发计划（新的在上）
function ccLead(t, from = -Infinity, to = t) {
  // 在等你回答弹窗时，第一行写出来（不管有没有派发计划）
  const ask = askAt(B.laneById.get('cc'), t), p = plansAt(t).pop();
  if (!p) return ask ? [TEXT.asking(ask.t)] : [];
  const lines = ask ? [TEXT.asking(ask.t)] : [];
  if (p.record != null && p.record > from && p.record <= to) {
    const round = Math.max(...p.verdicts.map((v) => v.round || 1)), c = { a: 0, p: 0, r: 0 };
    for (const v of p.verdicts) if ((v.round || 1) === round) { c.a += v.a.length; c.p += v.p.length; c.r += v.r.length; }
    lines.push(TEXT.decision(round, c));
  }
  const h = p.hosts.filter((x) => x.started_at > from && x.started_at <= to).pop();
  if (h) lines.push(TEXT.hostReport(h.round || 1, h.report_head));
  return lines;
}

// 每帧：卡片、产出框、组头跟着刻度带滚动挪位置；透明度 = 滚到两头的渐隐 × 刚被计划拉出来时的淡入
const setOpacity = (el, a) => {
  const s = a >= 0.999 ? '' : a.toFixed(3), v = a < 0.01 ? 'hidden' : '';
  if (el.style.opacity !== s) el.style.opacity = s;
  if (el.style.visibility !== v) el.style.visibility = v;
};
function placeWorld(L, t) {
  const arrive = arrivals(t);
  for (const g of L.groups) {
    const h = UI.heads.get(g.key);
    if (h) { place(h, g.head); setOpacity(h, g.vis * (g.old ? 0.45 : 1) * (1 - (g.leave || 0))); }
    for (const lane of g.lanes) {
      const row = L.rows.get(lane.id), a = arrive.get(lane.id) || { card: 1, out: 1 };
      if (!row) continue;
      const card = UI.cards.get(lane.id), out = UI.outs.get(lane.id);
      // 正在离开的组：卡片缩一点、淡出（光点在 08-life.js 的 drawLeave 里画）
      const stay = 1 - (row.leave || 0);
      if (card) { place(card, row.card); setOpacity(card, row.vis * a.card * stay); setScale(card, 1 - 0.12 * (row.leave || 0)); }
      if (out) { const k = outLook(lane.ghost ? { phase: 'none' } : outLife(lane, t)); place(out, row.out); setOpacity(out, row.vis * a.out * k.a * stay); setScale(out, k.s); }
    }
  }
  const bh = UI.heads.get('#band');
  if (bh) setOpacity(bh, bandReveal(L, t));
  const cc = UI.outs.get('cc');
  if (cc) { const k = outLook(ccLife(t)); place(cc, L.ccOut); setOpacity(cc, k.a * L.ccDim); setScale(cc, k.s); }
}
const setScale = (el, s) => { const v = s >= 0.999 ? '' : `scale(${s.toFixed(3)})`; if (el.style.transform !== v) el.style.transform = v; };
