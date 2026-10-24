'use strict';
// "世界"坐标和视图：版面按上一版的 1200 宽逻辑画布排（左边核心网、竖直刻度带、放射线区、右边产出列），
// 再整体缩放平移到屏幕上。卡片（DOM）和画布用同一套变换；缩放到不同大小时卡片换显示档位。

const $ = (id) => document.getElementById(id);
// Claude Code 车道上还有 Claude Code 席交的报告（kind answer），卡片和状态只看会话本身那一条
const latest = (lane) => (lane.id === 'cc' && lane.runs.find((r) => r.kind === 'host')) || lane.runs[lane.runs.length - 1];
const seatLanes = (t) => B.lanes.filter((l) => l.id !== 'cc' && l.runs.some((r) => r.started_at <= t));
const setText = (el, s) => { s = s ?? ''; if (el.textContent !== s) el.textContent = s; };

// 世界宽 1420：最左是 Claude Code 卡片，右边紧挨着核心网（不压在卡片上），再右是竖直刻度带、光束区、产出列
const WL = { W: 1420, cardW: 154, cardH: 96, outW: 184, outH: 44, gap: 14, margin: 30, headH: 22, bandX: 650, bandW: 172, outX: 1220, ccX: 14, coreGap: 34, minH: 600, maxH: Number(Q.get('maxh')) || 690, loopGap: 70 }; // ?maxh= 调低封顶，样例卡片少时也能看滚动
const clamp01 = (x) => Math.max(0, Math.min(1, x));
// 刻度带滚动：卡片放不下时各组从下往上循环慢慢滚（s 是滚过的世界距离）；鼠标停在刻度带上时停下，滚轮在那里是快速滚动
const REEL = { s: 0, off: 0, speed: 14, last: 0, hover: false, overflow: false, anchor: null, born: new Map() };
// 手机竖屏时整张 1420 宽的版面缩下来卡片太小：只适配左边（Claude Code 卡片、核心网、刻度带），产出列往右拖着看
const fitWidth = (w, h) => (w < 600 && h > w ? WL.bandX + WL.bandW + WL.margin : WL.W);
// 100% 比例下屏幕能看到的世界 y 范围
function fitRange(H) {
  const w = viewEl.clientWidth || 1, h = viewEl.clientHeight || 1, k = Math.min(w / fitWidth(w, h), h / H) * 0.97, ty = (h - H * k) / 2;
  return { top: -ty / k, bot: (h - ty) / k };
}
function stepReel(nowMs) {
  const dt = Math.min(0.1, (nowMs - (REEL.last || nowMs)) / 1000);
  REEL.last = nowMs;
  if (REEL.overflow && !REEL.hover && !drag.on && VIEW.k <= kFit() * 1.25) REEL.s += REEL.speed * dt;
  // 放得下时：滚出去的卡片在鼠标移开后自动回到竖直居中
  if (!REEL.overflow && !REEL.hover && !drag.on) { REEL.off *= Math.exp(-dt / 0.45); if (Math.abs(REEL.off) < 0.3) REEL.off = 0; }
}
// 鼠标在不在刻度带上（不论放大到多少，在刻度带上滚轮都是滚动卡片）
function reelZone(sx) {
  const wx = (sx - VIEW.tx) / VIEW.k;
  return wx >= WL.bandX - 12 && wx <= WL.bandX + WL.bandW + 12;
}
// hot：鼠标停在用量表哪一行（车道 id），画面上突出这条车道、其余的压暗；只是看得清楚，不触发任何操作
const UI = { open: new Set(), collapsed: new Set(), cards: new Map(), outs: new Map(), heads: new Map(), tableRows: new Map(), hot: null };

function laneStatus(lane, t) {
  const r = currentRun(lane, t);
  if (lane.id === 'cc' && r) return { mark: r.status === 'idle' ? '○' : '●', word: r.status === 'idle' ? 'idle' : 'active', running: r.status !== 'idle', tone: r.status === 'idle' ? 'dim' : 'run' };
  const st = seatStatus(lane, r, t);
  return { ...st, mark: st.style.mark, word: st.style.word, running: !!st.running, tone: Display.toneOf(st.kind) };
}

// 对话是否正在活跃进行（光束只在这时有基础流动）：席位看任务是否在运行；Claude Code 看最近 60 秒（记录时间）里有没有新动作
function laneActive(lane, t) {
  if (!lane) return false;
  if (lane.id !== 'cc') return laneStatus(lane, t).running;
  for (let i = lane.events.length - 1; i >= 0; i--) if (lane.events[i].ts <= t) return t - lane.events[i].ts < 60000;
  return false;
}

function groupKey(lane) { if (lane.ghost) return lane.group || `plan:${lane.plan}`; const r = latest(lane); return r.group || `lane:${lane.id}`; }

// 版面：刻度带里各组（组头 + 席位卡片）从上到下排、整体竖直居中；每张卡片的产出框在右边、对着卡片中线，比卡片矮。
// Claude Code 卡片在最左边竖直居中，它的产出框在产出列最上面。
function computeLayout(t) {
  const groups = new Map();
  for (const lane of [...seatLanes(t), ...ghostLanes(t)]) {
    const k = groupKey(lane);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(lane);
  }
  // 组的先后按第一次派发的时间（新的在上），续接时不挪位置；已经离开的组（见 04-life.js 的 groupLeave）不排
  const order = [...groups.entries()].sort((a, b) => Math.max(...b[1].map(laneT0)) - Math.max(...a[1].map(laneT0)));
  const L = { groups: [], rows: new Map() };
  const plan = [];
  for (const [key, all] of order) {
    // 上一批之后没再续接、已经离开的席位不再显示（见 04-life.js 的 bandLanes）
    const lanes = bandLanes(all, t);
    const leave = groupLeave(lanes, t);
    if (leave >= 1) continue;
    lanes.sort((a, b) => seatOrder(a) - seatOrder(b) || laneT0(a) - laneT0(b));
    const running = lanes.some((l) => laneStatus(l, t).running);
    plan.push({ key, lanes, leave, old: plan.length > 0 && !running, collapsed: UI.collapsed.has(key) });
  }
  const content = plan.reduce((s, g) => s + WL.headH + (g.collapsed ? 0 : g.lanes.length * (WL.cardH + WL.gap)), 0);
  // 版面高度封顶：卡片多到放不下时不再缩小整体，改成在刻度带里循环滚动
  L.H = Math.max(WL.minH, Math.min(WL.maxH, content + 2 * WL.margin));
  const vis = fitRange(L.H);
  REEL.overflow = content > L.H - 2 * WL.margin;
  L.vis = vis;
  // 每一项（组头、卡片行）在内容里的起点 b。放不下时按滚动量 s 绕圈：从屏幕上方（再往上一张卡）开始排，
  // 一圈的长度至少盖住整个可见范围，所以同一项不会同时出现两次。放得下时整体居中，再加上滚轮滚出去的偏移 off
  const top0 = vis.top - WL.cardH - 10, cycle = Math.max(content + WL.loopGap, vis.bot - top0 + 10);
  const fade = (vis.bot - vis.top) * 0.14, center = (L.H - content) / 2;
  const items = [];
  let b = 0;
  for (const g of plan) {
    items.push({ key: `h|${g.key}`, b, h: WL.headH });
    b += WL.headH;
    if (!g.collapsed) for (const lane of g.lanes) { items.push({ key: `r|${lane.id}`, b, h: WL.cardH }); b += WL.cardH + WL.gap; }
  }
  // 刚点过组头折叠或展开：让那个组头停在点之前的位置
  if (REEL.anchor) {
    const it = items.find((i) => i.key === `h|${REEL.anchor.key}`);
    if (it) { if (REEL.overflow) REEL.s = it.b - (REEL.anchor.y - top0); else REEL.off = REEL.anchor.y - (center + it.b); }
    REEL.anchor = null;
  }
  if (REEL.overflow) REEL.off = 0;
  else REEL.off = Math.max(vis.top - center - content + WL.cardH, Math.min(vis.bot - center - WL.cardH, REEL.off));
  // 位置也走平滑（别的组进出、折叠展开时其余卡片滑过去）；绕圈时一下跨过整圈的不平滑
  const pos = new Map(), now = performance.now();
  for (const it of items) {
    let y = REEL.overflow ? top0 + ((((it.b - REEL.s) % cycle) + cycle) % cycle) : center + it.b + REEL.off;
    y = smoothY(it.key, y, REEL.overflow ? cycle * 0.7 : Infinity);
    // 滚到屏幕两头的渐隐；放得下时只在被滚轮滚出去、快出屏幕时才淡
    const v = REEL.overflow ? clamp01((y - vis.top) / fade) * clamp01((vis.bot - (y + it.h)) / fade)
      : clamp01((y + it.h * 0.5 - vis.top) / (it.h * 0.6)) * clamp01((vis.bot - y - it.h * 0.5) / (it.h * 0.6));
    // 刚出现的项（展开、新进来的组）淡入
    if (!REEL.born.has(it.key)) REEL.born.set(it.key, now);
    pos.set(it.key, { y, vis: v * clamp01((now - REEL.born.get(it.key)) / 300) });
  }
  for (const key of REEL.born.keys()) if (!pos.has(key)) REEL.born.delete(key);
  for (const g of plan) {
    const hp = pos.get(`h|${g.key}`);
    L.groups.push({ ...g, head: { x: WL.bandX + 9, y: hp.y }, vis: hp.vis });
    if (g.collapsed) continue;
    for (const lane of g.lanes) {
      const p = pos.get(`r|${lane.id}`), y = p.y;
      const out = { x: WL.outX, y: y + (WL.cardH - WL.outH) / 2, w: WL.outW, h: WL.outH };
      L.rows.set(lane.id, { card: { x: WL.bandX + 9, y, w: WL.cardW, h: WL.cardH }, out, vis: p.vis, leave: g.leave });
    }
  }
  // Claude Code 的产出框固定在产出列最上面不动；席位的产出框滚到它附近时，它自己变暗让出位置
  L.ccOut = { x: WL.outX, y: 16, w: WL.outW, h: WL.outH };
  let near = 0;
  // 间隔小于 8 像素开始变暗，压上去 10 像素时最暗；静止排布时第一个席位框离它还有十几像素，不受影响
  for (const row of L.rows.values()) near = Math.max(near, row.vis * (1 - clamp01((Math.abs(row.out.y - L.ccOut.y) - (WL.outH - 10)) / 18)));
  L.ccDim = 1 - 0.8 * near;
  // 刻度带上下伸出屏幕，两头渐隐（drawBand 里画渐隐）
  L.band = { x: WL.bandX, y: vis.top - 40, w: WL.bandW, h: vis.bot - vis.top + 80 };
  L.cc = { x: WL.ccX, y: L.H / 2 - WL.cardH / 2, w: WL.cardW, h: WL.cardH };
  const R = Math.max(300, L.H * 0.48);
  L.core = { cx: WL.ccX + WL.cardW + WL.coreGap + R, cy: L.H / 2, R, clipX: WL.bandX - 10 };
  return L;
}

// ---- 视图：k 缩放、tx/ty 平移（屏幕像素）；目标值缓动过去 ----
const VIEW = { k: 1, tx: 0, ty: 0, goal: null, auto: true, w: 0, h: 0, H: 600 };
const viewEl = $('view'), worldEl = $('world');

function fitGoal() {
  const r = viewEl.getBoundingClientRect();
  // 视图还没有大小（面板刚打开、窗口最小化）时不重新适配，留着原来的镜头：按 0 适配会让缩放变成 0、线宽变成无穷大
  if (!(r.width > 0 && r.height > 0 && VIEW.H > 0)) return { k: VIEW.k > 0 ? VIEW.k : 1, tx: VIEW.tx, ty: VIEW.ty };
  const W = fitWidth(r.width, r.height), k = Math.min(r.width / W, r.height / VIEW.H) * 0.97;
  return { k, tx: (r.width - W * k) / 2, ty: (r.height - VIEW.H * k) / 2 };
}
function fitView(now = false) { VIEW.auto = true; VIEW.goal = fitGoal(); if (now) Object.assign(VIEW, VIEW.goal); }
const kFit = () => fitGoal().k;

function zoomAt(sx, sy, factor) {
  const g = VIEW.goal || { k: VIEW.k, tx: VIEW.tx, ty: VIEW.ty }, kf = kFit();
  const k = Math.max(kf * 0.6, Math.min(kf * 10, g.k * factor)), f = k / g.k;
  VIEW.goal = { k, tx: sx - (sx - g.tx) * f, ty: sy - (sy - g.ty) * f };
  VIEW.auto = false;
}
function zoomToBox(b) {
  const r = viewEl.getBoundingClientRect(), k = Math.min((r.height * 0.62) / b.h, (r.width * 0.4) / b.w);
  VIEW.goal = { k, tx: r.width / 2 - (b.x + b.w / 2) * k, ty: r.height / 2 - (b.y + b.h / 2) * k };
  VIEW.auto = false;
}

// 每帧把当前变换往目标挪一点（像地图那样平滑）；返回是否还在动
function stepView(H) {
  if (H !== VIEW.H) { VIEW.H = H; if (VIEW.auto) VIEW.goal = fitGoal(); }
  const g = VIEW.goal;
  let moving = false;
  if (g) {
    const a = 0.22;
    for (const key of ['k', 'tx', 'ty']) VIEW[key] += (g[key] - VIEW[key]) * a;
    moving = Math.abs(g.k - VIEW.k) > g.k * 0.001 || Math.abs(g.tx - VIEW.tx) > 0.3 || Math.abs(g.ty - VIEW.ty) > 0.3;
    if (!moving) { Object.assign(VIEW, { k: g.k, tx: g.tx, ty: g.ty }); VIEW.goal = null; }
  }
  worldEl.style.transform = `translate(${VIEW.tx}px, ${VIEW.ty}px) scale(${VIEW.k})`;
  // 显示档位看卡片在屏幕上有多高
  const px = WL.cardH * VIEW.k, lod = px < 150 ? 0 : px < 270 ? 1 : 2;
  if (worldEl.dataset.lod !== String(lod)) { worldEl.dataset.lod = lod; worldEl.className = `lod${lod}`; B.version++; }
  setText($('zoom-val'), `${Math.round((VIEW.k / kFit()) * 100)}%`);
  return moving;
}

// ---- 交互：滚轮缩放（以鼠标为中心）、按住左键拖动、单击卡片飞过去、双击空白复位 ----
const drag = { on: false, x: 0, y: 0, moved: 0, target: null };
viewEl.addEventListener('wheel', (e) => {
  if (!boardInput()) { e.preventDefault(); return; }
  e.preventDefault();
  const r = viewEl.getBoundingClientRect(), sx = e.clientX - r.left;
  // 刻度带和产出列上：滚轮快速滚动卡片；其他地方：缩放
  if (reelZone(sx)) { if (REEL.overflow) REEL.s += e.deltaY * 0.9; else REEL.off -= e.deltaY * 0.9; }
  else if (!boardWheelOut(e)) zoomAt(sx, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
  wake();
}, { passive: false });
viewEl.addEventListener('pointermove', (e) => { if (!drag.on && boardInput()) REEL.hover = reelZone(e.clientX - viewEl.getBoundingClientRect().left); });
viewEl.addEventListener('pointerleave', () => { REEL.hover = false; });
viewEl.addEventListener('pointerdown', (e) => {
  if (!boardInput() || e.button !== 0 || e.target.closest('#hud')) return;
  Object.assign(drag, { on: true, x: e.clientX, y: e.clientY, moved: 0, target: e.target.closest('.card, .ghead') });
  viewEl.setPointerCapture(e.pointerId);
});
viewEl.addEventListener('pointermove', (e) => {
  if (!drag.on) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.moved > 4) {
    viewEl.classList.add('dragging');
    const g = VIEW.goal || VIEW;
    VIEW.goal = null; VIEW.auto = false;
    VIEW.tx = g.tx + dx; VIEW.ty = g.ty + dy; VIEW.k = g.k;
    wake();
  }
});
viewEl.addEventListener('pointerup', () => {
  if (drag.on && drag.moved <= 4 && drag.target) {
    if (drag.target.classList.contains('ghead')) toggleGroup(drag.target.dataset.key);
    else { const box = boxOf(drag.target.dataset.lane); if (box) zoomToBox(box); }
  }
  drag.on = false;
  viewEl.classList.remove('dragging');
  wake();
});
viewEl.addEventListener('dblclick', (e) => { if (boardInput() && !e.target.closest('.card, #hud')) { fitView(); wake(); } });
// 复位按钮和 0 / + / - 键：在宇宙层管星图的镜头，在看板管看板的
$('fit').addEventListener('click', () => { if (inUniverse()) uniFit(); else if (boardInput()) fitView(); wake(); });
addEventListener('keydown', (e) => {
  if (inUniverse()) {
    const w = viewEl.clientWidth / 2, h = viewEl.clientHeight / 2;
    if (e.key === '0' || e.key === 'Home') uniFit();
    else if (e.key === '+' || e.key === '=') uniZoomAt(w, h, 1.3);
    else if (e.key === '-') uniZoomAt(w, h, 1 / 1.3);
    else return;
    wake(); return;
  }
  if (!boardInput()) return;
  if (e.key === '0' || e.key === 'Home') fitView();
  else if (e.key === '+' || e.key === '=') zoomAt(viewEl.clientWidth / 2, viewEl.clientHeight / 2, 1.3);
  else if (e.key === '-') zoomAt(viewEl.clientWidth / 2, viewEl.clientHeight / 2, 1 / 1.3);
  else return;
  wake();
});
// 视图区域大小变了（窗口缩放、用量面板随模型数量变高变矮）就重新适配，缓动过去
new ResizeObserver(() => { if (VIEW.auto) fitView(); wake(); }).observe(viewEl);

// 折叠或展开一组：记下组头现在的位置，排版时让它停在原处展开（鼠标移开后整体再慢慢回正）
function toggleGroup(key) {
  const g = FX.layout && FX.layout.groups.find((x) => x.key === key);
  if (g) REEL.anchor = { key, y: g.head.y };
  if (!UI.collapsed.delete(key)) UI.collapsed.add(key);
  B.version++; wake();
}

// 单击卡片时飞到这张卡片，放大到详情档位
function boxOf(id) {
  const L = FX.layout;
  if (!L) return null;
  return id === 'cc' ? L.cc : L.rows.get(id)?.card || null;
}
