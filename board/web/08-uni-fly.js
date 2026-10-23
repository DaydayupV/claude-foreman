'use strict';
// 宇宙层 ↔ 看板的切换：
//  飞入：镜头朝星系推近（缩放按对数插值，星系从原位滑到屏幕中心），推到一半看板淡入、宇宙淡出；
//        同时关掉旧的明细流、清空看板，按这个对话打开新的（同一时刻只挂一个完整看板）。
//  飞出：看板先淡出，镜头从星系近处拉回飞入前的位置。
//  Esc、顶栏路径里的"宇宙"、看板缩到最小后继续往外滚，都是飞出。地址栏记 ?s=<对话 id>，刷新后直接回到这个对话。

const FLY = { mode: 'universe', id: null, t0: 0, from: null, to: null, back: null, out: 0, crumb: '', pending: Q.get('s') };
const FLY_IN = 1.1, FLY_OUT = 0.9;
const flyU = () => clamp01((performance.now() - FLY.t0) / 1000 / (FLY.mode === 'in' ? FLY_IN : FLY_OUT));

// 宇宙和看板各占多少（0–1），画面按它淡入淡出
function flyShare() {
  const u = flyU();
  if (FLY.mode === 'in') return { uni: 1 - clamp01((u - 0.55) / 0.45), board: clamp01((u - 0.45) / 0.5) };
  if (FLY.mode === 'out') return { uni: clamp01(u / 0.35), board: 1 - clamp01(u / 0.4) };
  return FLY.mode === 'board' ? { uni: 0, board: 1 } : { uni: 1, board: 0 };
}
function applyShare(share) {
  const set = (el, a) => { const v = a >= 0.999 ? '' : a.toFixed(3); if (el.style.opacity !== v) el.style.opacity = v; };
  set(UFX.cv, share.uni); set(FX.cv, share.board); set(worldEl, share.board);
  // 完全看不见的那一层不参与合成
  const vis = (el, on) => { const v = on ? '' : 'hidden'; if (el.style.visibility !== v) el.style.visibility = v; };
  vis(UFX.cv, share.uni > 0); vis(FX.cv, share.board > 0);
  document.body.classList.toggle('u-on', true);
  document.body.classList.toggle('uni', FLY.mode === 'universe');
}

// 换一个对话：清掉上一个看板留下的卡片、表格行、终端栏和平滑值（宇宙层的 u 开头的不动）
function resetBoardView() {
  worldEl.replaceChildren();
  for (const m of [UI.cards, UI.outs, UI.heads, UI.tableRows]) m.clear();
  UI.open.clear(); UI.collapsed.clear();
  for (const id of ['usage', 'terms']) { $(id).replaceChildren(); delete $(id).dataset.mode; }
  PANEL.cols.clear(); UNI_ROWS.clear();
  Object.assign(REEL, { s: 0, off: 0, anchor: null }); REEL.born.clear();
  for (const key of [...SMOOTH.vals.keys()]) if (!key.startsWith('u')) SMOOTH.vals.delete(key);
  FX.layout = null;
  // 回放估算的总量缓存按对话分：每个对话的 Claude Code 车道 id 都是 cc，不清掉就会拿上一个对话的数
  FINAL.clear(); FINAL_EV.clear(); loadFinals.started = false; loadFinals.gen = (loadFinals.gen || 0) + 1;
}
function openBoardFor(s) {
  disconnect(); reset(); resetBoardView();
  const pg = U.page, p = { group: null, run: null, replay: null, session: null, from: null, speed: pg.speed, maxgap: pg.maxgap, t: null };
  // 演示里的对话带着现成的组回放；真实数据按对话打开，宇宙层在回放时从当时的时刻接上（共用一个时钟）
  if (s.detail) for (const [k, v] of new URLSearchParams(s.detail)) p[k] = v;
  else {
    p.session = s.id;
    // 宇宙层定格（?t=）时看板定格在同一时刻：回放用同一个 t，直播取当时的快照
    if (pg.t != null) { p.t = pg.t; if (pg.replay === 'all') p.replay = 'all'; }
    else if (U.clock.mode === 'replay') { p.replay = 'all'; p.from = String(Math.round(uNow())); }
  }
  B.params = p;
  started = false; drawnVersion = -1;
  connect();
}

function setUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('s', id); else url.searchParams.delete('s');
  history.replaceState(null, '', url);
}

function flyIn(id, instant = false) {
  const g = uniLayout().galaxies.find((x) => x.s.id === id);
  if (!g) return false;
  const r = viewEl.getBoundingClientRect();
  FLY.back = { k: UV.k, tx: UV.tx, ty: UV.ty, auto: UV.auto };
  FLY.from = { k: UV.k, sx: g.x * UV.k + UV.tx, sy: g.y * UV.k + UV.ty };
  Object.assign(FLY, { id, mode: instant ? 'board' : 'in', t0: performance.now(), out: 0, pending: null });
  UV.goal = null; UV.auto = false;
  openBoardFor(g.s);
  // 星系的亮核最后落在看板 Claude Code 卡片出现的位置：看上去就是亮核变成了那张卡片
  const L = computeLayout(now());
  VIEW.H = L.H;
  const fit = fitGoal(), cx = fit.tx + (L.cc.x + L.cc.w / 2) * fit.k, cy = fit.ty + (L.cc.y + L.cc.h / 2) * fit.k;
  FLY.to = { k: uniFitGoal().k * 14, sx: Number.isFinite(cx) ? cx : r.width / 2, sy: Number.isFinite(cy) ? cy : r.height / 2 };
  setUrl(id);
  wake();
  return true;
}
function flyOut() {
  if (FLY.mode !== 'board' && FLY.mode !== 'in') return;
  // 直接打开到看板（刷新进来）时没有飞入前的镜头，退回去就复位到全貌
  if (!FLY.back || FLY.back.auto) { const g = uniFitGoal(); FLY.back = { ...g, auto: true }; }
  Object.assign(FLY, { mode: 'out', t0: performance.now() });
  setUrl(null);
  wake();
}

// 每帧推进切换中的镜头；切换结束时落到看板或宇宙
function stepFly() {
  if (FLY.mode !== 'in' && FLY.mode !== 'out') return;
  const u = flyU(), e = ease(u), g = uniLayout().galaxies.find((x) => x.s.id === FLY.id);
  if (g) {
    const near = FLY.to, far = FLY.mode === 'in' ? FLY.from : { k: FLY.back.k, sx: g.x * FLY.back.k + FLY.back.tx, sy: g.y * FLY.back.k + FLY.back.ty };
    const v = FLY.mode === 'in' ? e : 1 - e;   // 0 在远处，1 贴近星系
    const k = far.k * Math.pow(near.k / far.k, v), sx = far.sx + (near.sx - far.sx) * v, sy = far.sy + (near.sy - far.sy) * v;
    Object.assign(UV, { k, tx: sx - g.x * k, ty: sy - g.y * k, goal: null });
  }
  if (u < 1) return;
  if (FLY.mode === 'in') FLY.mode = 'board';
  else {
    FLY.mode = 'universe';
    Object.assign(UV, { k: FLY.back.k, tx: FLY.back.tx, ty: FLY.back.ty, auto: FLY.back.auto, goal: null });
    disconnect();
  }
}

// 看板已经缩到最小还继续往外滚：攒够一段就退回宇宙（往里滚清零）
function boardWheelOut(e) {
  if (!U.on || FLY.mode !== 'board') return false;
  if (e.deltaY < 0) { FLY.out = 0; return false; }
  if (VIEW.k > kFit() * 0.62) return false;
  FLY.out += e.deltaY;
  if (FLY.out > 260) flyOut();
  return true;
}

// 顶栏路径：宇宙 › 项目 › 对话
function renderCrumb() {
  const s = FLY.id && U.sessions.get(FLY.id), inside = FLY.mode !== 'universe' && s;
  const proj = inside && (U.projects.get(s.project)?.name || s.project);
  const html = inside ? `<a data-go="uni">${TEXT.universe}</a><i>›</i><span></span><i>›</i><b></b>` : `<b>${TEXT.universe}</b><i>·</i><span></span>`;
  const key = inside ? `${html}|${proj}|${s.title}` : `${html}|${U.sessions.size}`;
  if (key === FLY.crumb) return;
  FLY.crumb = key;
  const el = $('crumb');
  el.innerHTML = html;
  if (inside) { el.querySelector('span').textContent = proj; el.querySelector('b').textContent = s.title || s.id.slice(0, 8); }
  else el.querySelector('span').textContent = TEXT.conversations(U.sessions.size);
}
$('crumb').addEventListener('click', (e) => { if (e.target.closest('[data-go="uni"]')) flyOut(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && U.on && (FLY.mode === 'board' || FLY.mode === 'in')) { flyOut(); e.preventDefault(); } });
