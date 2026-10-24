'use strict';
// 底部用量表（每个模型一行，Claude Code 在最前，最后一行合计）和顶栏。

const TABLE_HEAD = ['', 'model', 'status', 'now ≈tok/s', 'last 2 min', 'gen avg ≈tok/s', 'input · cache', 'output', 'cost', 'time'];
// 费用：一律按模型官方 API 价格算（插件自带的价格表），悬停在表头和单元格上有说明；+ 表示有的模型不在价格表里
// 不到 1 美分的按两位有效数字写（便宜的 API 模型一次常常只有零点零几美分），免得显示成 $0.00
const fmtUsd = (n) => (n > 0 && n < 0.01 ? n.toPrecision(2) : n.toFixed(2));
const fmtCost = (cost, partial = false) => (cost == null ? '—' : `$${fmtUsd(cost)}${partial ? '+' : ''}`);
// 面板里下面还有没露出来的行时，最后一行淡出
const markMore = (body) => body.classList.toggle('more', body.scrollHeight - body.scrollTop - body.clientHeight > 2);
// 速度的估算窗口不同，和费用一样把口径放在表头悬停说明里。
function costHeadTitle(head) {
  const titles = { cost: TEXT.costTitle, 'now ≈tok/s': TEXT.nowTitle, 'last 2 min': TEXT.recentTitle, 'gen avg ≈tok/s': TEXT.genAvgTitle };
  for (const c of head.children) if (titles[c.textContent]) c.title = titles[c.textContent];
}
function renderTable(t) {
  const table = $('usage');
  if (!table.firstChild) {
    table.innerHTML = '<div class="tr th"></div><div class="tbody"></div><div class="tr total"></div>';
    const body = table.querySelector('.tbody');
    body.addEventListener('scroll', (e) => markMore(e.target), { passive: true });
    // 鼠标停在某一行时突出画面上的这条车道（和宇宙表悬停星系一样），单击不做任何事
    const hover = (id) => { if (UI.hot !== id) { UI.hot = id; B.version++; wake(); } };
    body.addEventListener('pointerover', (e) => { if (table.dataset.mode !== 'uni') hover(e.target.closest('.tr[data-lane]')?.dataset.lane || null); });
    body.addEventListener('pointerleave', () => hover(null));
    for (const h of TABLE_HEAD) { const c = document.createElement('span'); c.textContent = h; table.firstChild.append(c); }
    costHeadTitle(table.firstChild);
  }
  const lanes = [B.laneById.get('cc'), ...seatLanes(t)].filter((l) => l && latest(l) && latest(l).started_at <= t);
  const body = table.querySelector('.tbody');
  const tot = { input: 0, cached: 0, output: 0, usage_unattributed: false, cost: null, partial: false, rate: 0 };
  lanes.forEach((lane, i) => {
    let tr = UI.tableRows.get(lane.id);
    if (!tr) {
      tr = document.createElement('div');
      tr.className = 'tr';
      tr.innerHTML = '<span class="av"><img alt=""></span>' + '<span></span>'.repeat(TABLE_HEAD.length - 1);
      tr.dataset.lane = lane.id;
      UI.tableRows.set(lane.id, tr);
    }
    tr.classList.toggle('hot', UI.hot === lane.id);
    const r = currentRun(lane, t) || latest(lane), key = avatarFor(r.model, r.agent_type), s = laneStats(lane, t), st = laneStatus(lane, t);
    tr.style.setProperty('--tint', rgba(key));
    tr.classList.toggle('running', st.running);
    const img = tr.querySelector('img');
    if (img.dataset.key !== key) { img.src = avatarSrc(key); img.dataset.key = key; }
    const c = tr.children, inAll = s.input + s.cached + s.cache_write;
    // 同一个模型常有好几条车道：写上接入方式，悬停看这条车道的任务标题
    setText(c[1], Display.modelLabel({ ...Display.displayRun(r).meta, ...(lane.id === 'cc' ? { agent_type: 'host' } : {}) }));
    c[1].title = lane.id === 'cc' ? '' : [r.title, r.group, r.id].filter(Boolean).join(' · ');
    setText(c[2], st.word);
    setText(c[3], s.rate >= 0.5 ? `≈ ${Math.round(s.rate)}` : '—');
    sparkSvg(c[4], sparkline(lane, t));
    setText(c[5], s.avg != null ? `≈ ${Math.round(s.avg)}` : '—');
    setText(c[6], !s.usage_unattributed && inAll ? `${fmtTok(inAll)} · ${Math.round((100 * s.cached) / inAll)}%` : '—');
    c[6].title = s.usage_unattributed ? TEXT.usageUnattributed : '';
    setText(c[7], s.output ? fmtTok(s.output) : '—');
    c[7].title = s.usage_unattributed ? TEXT.usageUnattributed : '';
    setText(c[8], fmtCost(s.cost, s.costPartial)); c[8].title = TEXT.costTitle;
    setText(c[9], Display.clock(laneElapsed(lane, t, true) * 1000));
    if (body.children[i] !== tr) body.insertBefore(tr, body.children[i] || null);
    tot.input += inAll; tot.cached += s.cached; tot.output += s.output; tot.rate += s.rate;
    tot.usage_unattributed ||= s.usage_unattributed;
    if (s.cost != null) tot.cost = (tot.cost ?? 0) + s.cost;
    if (s.costPartial) tot.partial = true;
  });
  while (body.children.length > lanes.length) body.lastChild.remove();
  markMore(body);
  const total = table.querySelector('.total');
  const sig = `${lanes.length}|${Math.round(tot.rate)}|${tot.input}|${tot.output}|${tot.usage_unattributed}|${fmtCost(tot.cost, tot.partial)}`;
  if (total.dataset.sig !== sig) {
    total.dataset.sig = sig;
    total.innerHTML = '';
    const cells = ['', 'total', `${lanes.length} lanes`, `≈ ${Math.round(tot.rate)}`, '', '', !tot.usage_unattributed && tot.input ? `${fmtTok(tot.input)} · ${Math.round((100 * tot.cached) / tot.input)}%` : '—', tot.usage_unattributed ? '—' : fmtTok(tot.output), fmtCost(tot.cost, tot.partial), ''];
    for (const x of cells) { const s = document.createElement('span'); s.textContent = x; total.append(s); }
    total.children[8].title = TEXT.costTitle;
    total.children[7].title = tot.usage_unattributed ? TEXT.usageUnattributed : '';
    total.children[6].title = tot.usage_unattributed ? TEXT.usageUnattributed : '';
  }
}

function sparkSvg(cell, pts) {
  const max = Math.max(20, ...pts);
  const d = pts.map((v, i) => `${(i * 100) / (pts.length - 1)},${(16 - (v / max) * 14).toFixed(1)}`).join(' ');
  if (cell.dataset.d === d) return;
  cell.dataset.d = d;
  cell.innerHTML = `<svg viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true"><polyline points="${d}"/></svg>`;
}

function renderTop(t) {
  const c = B.clock, p = B.params;
  setText($('scope'), c.mode === 'replay' ? `replay · ${p.replay} · ×${c.speed}` : p.group ? `group · ${p.group}` : p.run ? `run · ${p.run}` : 'live · recent');
  const pct = c.mode === 'replay' ? Math.round(((t - c.start) / Math.max(1, c.end - c.start)) * 100) : null;
  setText($('clock'), `${new Date(Display.recordedTime(t, displayPoints())).toTimeString().slice(0, 8)}${pct != null ? ` · ${pct}% · ${TEXT.replayEstimate}` : ''}`);
  $('progress').style.width = pct != null ? `${pct}%` : '0';
  const st = $('status');
  setText(st, B.error ? `connection ${B.error}` : !B.connected ? 'connecting…' : '');
  st.classList.toggle('bad', !!B.error);
}
