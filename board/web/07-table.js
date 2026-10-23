'use strict';
// 底部用量表（每个模型一行，Claude Code 在最前，最后一行合计）和顶栏。

const TABLE_HEAD = ['', 'model', 'status', 'now ≈tok/s', 'last 2 min', 'avg tok/s', 'input · cache', 'output', 'cost (API ≈)', 'time'];
function renderTable(t) {
  const table = $('usage');
  if (!table.firstChild) {
    table.innerHTML = '<div class="tr th"></div><div class="tbody"></div><div class="tr total"></div>';
    for (const h of TABLE_HEAD) { const c = document.createElement('span'); c.textContent = h; table.firstChild.append(c); }
  }
  const lanes = [B.laneById.get('cc'), ...seatLanes(t)].filter((l) => l && latest(l) && latest(l).started_at <= t);
  const body = table.querySelector('.tbody');
  const tot = { input: 0, cached: 0, output: 0, cost: 0, rate: 0 };
  lanes.forEach((lane, i) => {
    let tr = UI.tableRows.get(lane.id);
    if (!tr) {
      tr = document.createElement('div');
      tr.className = 'tr';
      tr.innerHTML = '<span class="av"><img alt=""></span>' + '<span></span>'.repeat(TABLE_HEAD.length - 1);
      UI.tableRows.set(lane.id, tr);
    }
    const r = latest(lane), key = avatarFor(r.model, r.agent_type), s = laneStats(lane, t), st = laneStatus(lane, t);
    tr.style.setProperty('--tint', rgba(key));
    tr.classList.toggle('running', st.running);
    const img = tr.querySelector('img');
    if (img.dataset.key !== key) { img.src = avatarSrc(key); img.dataset.key = key; }
    const c = tr.children, inAll = s.input + s.cached + s.cache_write;
    setText(c[1], `${shortModel(r.model) || 'Claude Code'}${lane.id === 'cc' ? ' · Claude Code' : ''}`);
    setText(c[2], st.word);
    setText(c[3], s.rate >= 0.5 ? `≈ ${Math.round(s.rate)}` : '—');
    sparkSvg(c[4], sparkline(lane, t));
    setText(c[5], s.avg != null ? `≈ ${Math.round(s.avg)}` : '—');
    setText(c[6], inAll ? `${fmtTok(inAll)} · ${Math.round((100 * s.cached) / inAll)}%` : '—');
    setText(c[7], s.output ? fmtTok(s.output) : '—');
    setText(c[8], s.cost != null ? `${s.costEquiv ? '≈ ' : ''}$${s.cost.toFixed(2)}` : '—');
    setText(c[9], fmtDur(s.elapsed));
    if (body.children[i] !== tr) body.insertBefore(tr, body.children[i] || null);
    tot.input += inAll; tot.cached += s.cached; tot.output += s.output; tot.rate += s.rate;
    if (s.cost != null) tot.cost += s.cost;
  });
  while (body.children.length > lanes.length) body.lastChild.remove();
  // 面板高度跟着模型数量走：表头、每个模型一行、合计行都放得下；最多占 45% 屏幕高，再多就在面板里滚动
  const h = `min(45vh, max(22vh, ${66 + 19 * lanes.length}px))`;
  if (UI.tableH !== h) { UI.tableH = h; document.documentElement.style.setProperty('--table-h', h); }
  const total = table.querySelector('.total');
  const sig = `${lanes.length}|${Math.round(tot.rate)}|${tot.input}|${tot.output}|${tot.cost.toFixed(2)}`;
  if (total.dataset.sig !== sig) {
    total.dataset.sig = sig;
    total.innerHTML = '';
    const cells = ['', 'total', `${lanes.length} lanes`, `≈ ${Math.round(tot.rate)}`, '', '', tot.input ? `${fmtTok(tot.input)} · ${Math.round((100 * tot.cached) / tot.input)}%` : '—', fmtTok(tot.output), `≈ $${tot.cost.toFixed(2)}`, ''];
    for (const x of cells) { const s = document.createElement('span'); s.textContent = x; total.append(s); }
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
  setText($('clock'), `${new Date(t).toTimeString().slice(0, 8)}${pct != null ? ` · ${pct}% · ${TEXT.replayEstimate}` : ''}`);
  $('progress').style.width = pct != null ? `${pct}%` : '0';
  const st = $('status');
  setText(st, B.error ? `connection ${B.error}` : !B.connected ? 'connecting…' : '');
  st.classList.toggle('bad', !!B.error);
}
