'use strict';
// 宇宙层右上的名额带（只在宇宙层显示）：每个协作方一行，几个并发名额几格；被哪个对话占着就亮成那个对话的标记色，排队等服务的格子闪烁。
// 每个对话有一个按 id 定的标记色，名额格、用量表里同一个对话颜色一样；鼠标移上去时星图里那个星系高亮。
// 底部用量表的顺序（07-uni-table.js）：进行中的对话（等你确认、派发中、思考中）在前，固定按最近一轮用户消息的时间排，新的在上，
// 状态来回切换、有新动静时都不挪位置；空闲的在后，最近活动的在前。

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
const roundAt = (s) => s.prompt_at ?? s.started_at ?? 0; // 旧服务没有 prompt_at 时退回对话开始的时间
const byState = (a, b) => (a.state === 'idle') - (b.state === 'idle')
  || (a.state === 'idle' ? b.last_at - a.last_at : roundAt(b) - roundAt(a)) || (a.id < b.id ? -1 : 1);
// 和桌面版侧栏一样按父子归类：从别的对话里启动的子对话（服务端给的 parent）排在父对话下面、缩进一级。
// 一家的位置按其中排得最前的那个（子对话在干活时整家往上排），同一层的兄弟也这样排；
// 父对话不在列表里（超出时间窗口）的子对话按顶层排。返回 [{ s, depth }]
function familyOrder(list) {
  const ids = new Set(list.map((s) => s.id)), kids = new Map(), lead = new Map();
  const up = (s) => (s.parent && s.parent !== s.id && ids.has(s.parent) ? s.parent : null);
  for (const s of list) { const p = up(s); if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(s); } }
  const leadOf = (s, seen = new Set()) => {
    if (lead.has(s.id)) return lead.get(s.id);
    seen.add(s.id);
    let best = s;
    for (const k of kids.get(s.id) || []) if (!seen.has(k.id)) { const b = leadOf(k, seen); if (byState(b, best) < 0) best = b; }
    lead.set(s.id, best);
    return best;
  };
  const byLead = (a, b) => byState(leadOf(a), leadOf(b)) || byState(a, b);
  const out = [], done = new Set();
  const visit = (s, depth) => {
    if (done.has(s.id)) return;
    done.add(s.id); out.push({ s, depth });
    for (const k of (kids.get(s.id) || []).sort(byLead)) visit(k, depth + 1);
  };
  for (const s of list.filter((x) => !up(x)).sort(byLead)) visit(s, 0);
  // 父子关系成环（不该有，防一手）时剩下的按顶层补上
  for (const s of list.filter((x) => !done.has(x.id)).sort(byState)) visit(s, 0);
  return out;
}
// 在跑的席位数用不截断的计数（runs 摘要最多 16 条，会漏）
const runningOf = (s) => s.counts?.running ?? s.runs.filter((r) => r.status === 'running').length;
// 协作方代号去掉末尾表示接入方式的几段（-codex-cli、-opencode-cli-ocgo、-pi-cli-api 这类），名额带上更短；
// 接入方式按配置里的 type 写（代号后缀是用户自己起的，猜不准：pi 接的 API 模型常以 -api 结尾）
const agentName = (id) => { let s = id, prev; do { prev = s; s = s.replace(/-(codex|opencode|pi|cli|api|ocgo|contributor)$/, ''); } while (s !== prev && s); return s || id; };
const VIA = { 'codex cli': 'codex', 'opencode cli': 'opencode', 'pi cli': 'pi', 'agy cli': 'agy', api: 'api' };
const agentVia = (a) => VIA[a.type] || '';

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
    if (agentVia(a)) { const via = document.createElement('small'); via.textContent = agentVia(a); row.querySelector('.nm').append(' ', via); }
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
