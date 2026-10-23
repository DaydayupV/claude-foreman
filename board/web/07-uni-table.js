'use strict';
// 宇宙层的底部：用量表按对话列（每个对话一行，最后一行合计），终端区提示先选一个对话。
// 飞进某个对话以后，07-table.js / 07-terms.js 换回这个对话的明细（08-uni-fly.js 的 resetBoardView 会清空这里留下的东西）。

const UNI_HEAD = ['', 'conversation', 'project', 'state', 'seats', 'done · failed', 'input · cache', 'output', 'cost (API ≈)', 'last'];
const UNI_ROWS = new Map();
// 记录时间里过去了多久：几秒、几分钟、几小时
function fmtAgo(ms) {
  const s = Math.max(0, ms / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

function renderUniTable() {
  const table = $('usage');
  if (table.dataset.mode !== 'uni') {
    table.replaceChildren(); UNI_ROWS.clear(); table.dataset.mode = 'uni';
    table.innerHTML = '<div class="tr th"></div><div class="tbody"></div><div class="tr total"></div>';
    for (const h of UNI_HEAD) { const c = document.createElement('span'); c.textContent = h; table.firstChild.append(c); }
  }
  const list = [...U.sessions.values()].sort(byState), body = table.querySelector('.tbody'), t = uNow();
  const tot = { running: 0, done: 0, failed: 0, input: 0, cached: 0, output: 0, cost: 0, priced: true };
  list.forEach((s, i) => {
    let tr = UNI_ROWS.get(s.id);
    if (!tr) {
      tr = document.createElement('div');
      tr.className = 'tr';
      tr.innerHTML = '<span class="av"><i class="mk"></i></span>' + '<span></span>'.repeat(UNI_HEAD.length - 1);
      UNI_ROWS.set(s.id, tr);
    }
    const u = s.usage || {}, inAll = (u.input || 0) + (u.cached || 0) + (u.cache_write || 0), n = runningOf(s), c = tr.children;
    tr.style.setProperty('--tint', markOf(s.id));
    const cls = `tr s-${s.state}`;
    if (tr.className !== cls) tr.className = cls;
    setText(c[1], s.title || s.id.slice(0, 8));
    setText(c[2], U.projects.get(s.project)?.name || s.project);
    setText(c[3], STATE_WORD[s.state]);
    setText(c[4], n ? `● ${n}` : '—');
    setText(c[5], `${s.counts.done} · ${s.counts.failed}`);
    setText(c[6], inAll ? `${fmtTok(inAll)} · ${Math.round((100 * (u.cached || 0)) / inAll)}%` : '—');
    setText(c[7], u.output ? fmtTok(u.output) : '—');
    // 有一部分算不出价格时（还在跑、模型不在价格表里）在后面加 +
    setText(c[8], s.cost_usd != null ? `≈ $${s.cost_usd.toFixed(2)}${s.cost_partial ? '+' : ''}` : '—');
    setText(c[9], fmtAgo(t - s.last_at));
    if (body.children[i] !== tr) body.insertBefore(tr, body.children[i] || null);
    tot.running += n; tot.done += s.counts.done; tot.failed += s.counts.failed;
    tot.input += inAll; tot.cached += u.cached || 0; tot.output += u.output || 0;
    if (s.cost_usd != null) tot.cost += s.cost_usd;
    if (s.cost_usd == null || s.cost_partial) tot.priced = false;
  });
  for (const [id, tr] of UNI_ROWS) if (!U.sessions.has(id)) { tr.remove(); UNI_ROWS.delete(id); }
  // 面板高度和看板一样跟着行数走
  const h = `min(45vh, max(22vh, ${66 + 19 * list.length}px))`;
  if (UI.tableH !== h) { UI.tableH = h; document.documentElement.style.setProperty('--table-h', h); }
  const total = table.querySelector('.total');
  const cells = ['', 'total', TEXT.conversations(list.length), '', tot.running ? `● ${tot.running}` : '—', `${tot.done} · ${tot.failed}`,
    tot.input ? `${fmtTok(tot.input)} · ${Math.round((100 * tot.cached) / tot.input)}%` : '—', tot.output ? fmtTok(tot.output) : '—', `≈ $${tot.cost.toFixed(2)}${tot.priced ? '' : '+'}`, ''];
  const sig = cells.join('|');
  if (total.dataset.sig !== sig) {
    total.dataset.sig = sig; total.replaceChildren();
    for (const x of cells) { const s = document.createElement('span'); s.textContent = x; total.append(s); }
  }
}

function renderUniTerms() {
  const box = $('terms');
  setText($('conv'), TEXT.noneSelected(U.sessions.size));
  if (box.dataset.mode === 'uni') return;
  box.replaceChildren(); PANEL.cols.clear(); box.dataset.mode = 'uni';
  const p = document.createElement('p');
  p.className = 'pick';
  p.textContent = TEXT.pickHint;
  box.append(p);
}

// 宇宙层的顶栏：范围、宇宙层自己的时钟和回放进度、连接状态（看板的 renderTop 在宇宙层不跑，不清掉会留着上一个对话的）
function renderUniTop() {
  const c = U.clock, t = uNow(), replay = c.mode === 'replay';
  setText($('scope'), U.demo ? `demo · ×${c.speed}` : replay ? `replay · all · ×${c.speed}` : c.frozenAt != null ? 'snapshot · all' : 'live · all');
  const pct = replay && Number.isFinite(c.end) ? Math.round(((t - c.start) / Math.max(1, c.end - c.start)) * 100) : null;
  setText($('clock'), `${new Date(t).toTimeString().slice(0, 8)}${pct != null ? ` · ${pct}%` : ''}`);
  const w = pct != null ? `${pct}%` : '0';
  if ($('progress').style.width !== w) $('progress').style.width = w;
  const st = $('status');
  setText(st, U.error ? `connection ${U.error}` : !U.hello ? 'connecting…' : '');
  st.classList.toggle('bad', !!U.error);
}

// 宇宙层的面板：数据变了或每半秒刷新一次
let uniPanelsAt = 0, uniPanelsVersion = -1;
function renderUniPanels() {
  const ms = performance.now();
  if (U.version === uniPanelsVersion && ms - uniPanelsAt < 500) return;
  uniPanelsVersion = U.version; uniPanelsAt = ms;
  renderList(); renderSlots(); renderUniTable(); renderUniTerms();
}
