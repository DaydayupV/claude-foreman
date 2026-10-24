'use strict';
// 宇宙层右上的名额带（只在宇宙层显示）：每个协作方一行，几个并发名额几格；被哪个对话占着就亮成那个对话的标记色，排队等服务的格子闪烁。
// 每个对话有一个按 id 定的标记色，名额格、用量表里同一个对话颜色一样；鼠标移上去时星图里那个星系高亮。
// 对话按 等你确认 › 派发中 › 思考中 › 空闲 排，同一档里最近活动的在前（底部用量表的顺序，07-uni-table.js）。

const STATE_ORDER = { waiting: 0, dispatching: 1, thinking: 2, idle: 3 };
const STATE_WORD = TEXT.states;
const SIDE = { slots: new Map(), sigSlots: '' };
// 标记色按对话出现的先后分配：相邻两个隔一个黄金角（约 137.5°），颜色总是拉得开；分到以后这个页面里不再变
const MARKS = new Map();
function markOf(id, a = 1) {
  if (!MARKS.has(id)) {
    // 第一次见到时，同一批里按开始时间排，早的先分
    const fresh = [...U.sessions.values()].filter((s) => !MARKS.has(s.id)).sort((x, y) => x.started_at - y.started_at || (x.id < y.id ? -1 : 1));
    for (const s of fresh.some((s) => s.id === id) ? fresh : [{ id }]) MARKS.set(s.id, Math.round((MARKS.size * 137.508 + 200) % 360));
  }
  return `hsl(${MARKS.get(id)} 72% 66% / ${a})`;
}
const byState = (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.last_at - a.last_at;
// 在跑的席位数用不截断的计数（runs 摘要最多 16 条，会漏）
const runningOf = (s) => s.counts?.running ?? s.runs.filter((r) => r.status === 'running').length;
// 协作方代号去掉接入方式的后缀，名额带上更短
const agentName = (id) => id.replace(/-(codex|opencode|pi)-cli$|-api$|-contributor$/, '');
const agentVia = (id) => (/-(codex|opencode|pi)-cli$/.exec(id) || /-(api)$/.exec(id) || [])[1] || '';

function renderSlots() {
  const el = $('uslots');
  if (!el.firstChild) { el.innerHTML = `<header><b>${TEXT.slotsTitle}</b><span class="n"></span></header><div class="rows"></div>`; el.firstChild.title = TEXT.slotsHint; }
  // 名额带只在占用变了时重画（每次重画要重建格子）
  const sig = JSON.stringify(U.agents.map((a) => [a.id, a.max_parallel, a.running.map((r) => r.session), a.queued.map((r) => r.run)]));
  if (sig === SIDE.sigSlots) return;
  SIDE.sigSlots = sig;
  const rows = el.querySelector('.rows');
  rows.replaceChildren();
  let used = 0, total = 0;
  for (const a of U.agents) {
    const row = document.createElement('div'), queued = new Set(a.queued.map((q) => q.run));
    row.className = a.running.length ? 'row busy' : 'row';
    row.style.setProperty('--tint', rgba(avatarFor(a.id)));
    row.innerHTML = '<i class="dot"></i><span class="nm"></span><span class="cells"></span>';
    row.querySelector('.nm').textContent = agentName(a.id);
    if (agentVia(a.id)) { const via = document.createElement('small'); via.textContent = agentVia(a.id); row.querySelector('.nm').append(' ', via); }
    row.title = `${a.id} · ${a.running.length}/${a.max_parallel}`;
    const cells = row.querySelector('.cells');
    for (let i = 0; i < Math.max(a.max_parallel, a.running.length); i++) {
      const c = document.createElement('i'), r = a.running[i];
      if (r) { c.dataset.session = r.session ?? ''; c.style.setProperty('--mark', r.session ? markOf(r.session) : 'var(--mid)'); c.className = queued.has(r.run) ? 'on q' : 'on'; }
      if (i >= a.max_parallel) c.classList.add('over');
      cells.append(c);
    }
    rows.append(row);
    used += a.running.length; total += a.max_parallel;
  }
  setText(el.querySelector('.n'), `${used}/${total}`);
}

// 名额格：点击飞进去，悬停高亮星系
const pickOf = (e) => e.target.closest('#uslots [data-session]')?.dataset.session || null;
{
  const el = $('uslots');
  el.addEventListener('pointerover', (e) => { UV.pick = pickOf(e); wake(); });
  el.addEventListener('pointerleave', () => { UV.pick = null; wake(); });
  el.addEventListener('click', (e) => { const sid = pickOf(e); if (sid && inUniverse()) flyIn(sid); });
  // 侧栏上的滚轮只滚侧栏，不缩放星图
  el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}
