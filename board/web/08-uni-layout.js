'use strict';
// 宇宙层的排布和镜头：每个项目一团星云，项目里的每个对话一个小星系。
// 位置只由 id 和对话的先后决定，刷新、新增对话时已有的星系不挪位置（星云变大时周围的会慢慢让开）。
// 镜头 UV 和看板的 VIEW 分开：滚轮以鼠标为中心缩放，按住拖动，双击复位。

const UV = { k: 1, tx: 0, ty: 0, goal: null, auto: true, hover: null, hot: null, bounds: null, frame: 0, layout: null, layoutFrame: -1 };
const PLACE = { sig: '', map: null };
const GAL_R = 40;                     // 星系盘的半径（宇宙坐标）
const inUniverse = () => U.on && FLY.mode === 'universe';
// 看板的输入只在看板完全显示时生效；飞入飞出的过渡里两边的输入都不处理
const boardInput = () => !U.on || FLY.mode === 'board';
const unit = (h) => (h % 100000) / 100000;

// 项目星云的半径随对话数增长
const nebulaR = (n) => 58 + 40 * Math.sqrt(Math.max(1, n));

// 项目：先按 id 算一个初始位置，再按名字顺序做几十轮"互相推开 + 向中心收"，同样的项目集合每次结果一样
// 结果按"有哪些项目、各有几个对话"缓存：项目多时（上百个）求解一次要几十毫秒，不能每帧重算
function placeProjects(groups) {
  const sig = [...groups].map(([key, list]) => `${key}:${list.length}`).sort().join('|');
  if (sig === PLACE.sig) return PLACE.map;
  const list = [...groups.keys()].sort().map((key) => {
    const h = hash(key), a = unit(h) * 6.283, d = 160 + unit(h >>> 7) * 260;
    return { key, x: Math.cos(a) * d, y: Math.sin(a) * d * 0.7, r: nebulaR(groups.get(key).length) };
  });
  for (let it = 0; it < 80; it++) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const p = list[i], q = list[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, need = p.r + q.r + 24;
      if (d < need) { const m = (need - d) / 2 / d; p.x -= dx * m; p.y -= dy * m; q.x += dx * m; q.y += dy * m; }
    }
    // 竖向收得比横向紧，整体铺成横向的一片，适合宽屏
    for (const p of list) { p.x *= 0.985; p.y *= 0.95; }
  }
  PLACE.sig = sig; PLACE.map = new Map(list.map((p) => [p.key, p]));
  return PLACE.map;
}

// 每帧的排布：项目位置、星系位置（向日葵式排开，旧的在里、新的在外），都经过平滑。
// 一帧只算一次（飞入飞出、绘制、命中检测共用），重复调用会让平滑在同一帧里多走几步
function uniLayout() {
  if (UV.layoutFrame === UV.frame && UV.layout) return UV.layout;
  UV.layoutFrame = UV.frame;
  const groups = sessionsByProject(), placed = placeProjects(groups), L = { projects: [], galaxies: [] };
  for (const [key, list] of groups) {
    const p = placed.get(key), cx = smoothY(`up|${key}x`, p.x), cy = smoothY(`up|${key}y`, p.y), r = smooth(`upr|${key}`, p.r, p.r);
    const proj = U.projects.get(key) || { key, name: key.split('/').pop(), older: 0 };
    L.projects.push({ key, name: proj.name, older: proj.older || 0, x: cx, y: cy, r, sessions: list });
    const order = [...list].sort((a, b) => a.started_at - b.started_at || (a.id < b.id ? -1 : 1)), turn = unit(hash(key)) * 6.283;
    order.forEach((s, i) => {
      const d = i === 0 && order.length === 1 ? 0 : 58 * Math.sqrt(i + 0.6), a = turn + i * 2.39996;
      const seed = hash(s.id);
      L.galaxies.push({ s, project: key, x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d * 0.82, seed, tilt: unit(seed >>> 3) * Math.PI, flat: morphOf(seed).flat });
    });
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of L.projects) { x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r); x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r + 30); }
  UV.bounds = L.projects.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: -300, y: -200, w: 600, h: 400 };
  return (UV.layout = L);
}

// 每帧只量一次（要读侧栏的位置，读一次就会让浏览器重新排版）；frame() 开头清掉缓存
function uniFitGoal() {
  if (UV.fitCache && UV.fitCache.bounds === UV.bounds) return UV.fitCache;
  const r = viewEl.getBoundingClientRect(), b = UV.bounds;
  // 视图还没有大小时不适配（和看板的 fitGoal 一样），留着原来的镜头
  if (!(r.width > 0 && r.height > 0)) return { k: UV.k > 0 ? UV.k : 1, tx: UV.tx, ty: UV.ty, bounds: b };
  // 让开左上的名额面板（收起或没显示时不让）
  const side = (id, edge) => { const e = $(id).getBoundingClientRect(); return e.width ? (edge === 'l' ? e.right - r.left : r.right - e.left) + 8 : 0; };
  const left = FLY.mode === 'universe' ? side('uslots', 'l') : 0, right = 0;
  const w = Math.max(200, r.width - left - right), k = Math.min(w / b.w, r.height / b.h) * 0.86;
  return (UV.fitCache = { k, tx: left + w / 2 - (b.x + b.w / 2) * k, ty: r.height / 2 - (b.y + b.h / 2) * k, bounds: b });
}
// ?focus=<对话 id>：一打开就停在这个星系近处（截图、以后从别处跳进来时用）
function uniFocus(L, id) {
  const g = L.galaxies.find((x) => x.s.id === id);
  if (!g) return false;
  const r = viewEl.getBoundingClientRect(), k = uniFitGoal().k * 4.5;
  Object.assign(UV, { k, tx: r.width / 2 - g.x * k, ty: r.height / 2 - g.y * k, goal: null, auto: false });
  return true;
}
function uniFit(now = false) { UV.auto = true; UV.goal = uniFitGoal(); if (now) Object.assign(UV, UV.goal); }
function uniZoomAt(sx, sy, f) {
  const g = UV.goal || UV, kf = uniFitGoal().k, k = Math.min(kf * 14, Math.max(kf * 0.5, g.k * f));
  UV.goal = { k, tx: sx - (sx - g.tx) * (k / g.k), ty: sy - (sy - g.ty) * (k / g.k) };
  UV.auto = false;
}
function stepUni() {
  if (UV.auto) UV.goal = uniFitGoal();
  const g = UV.goal;
  if (!g) return (UV.moving = false);
  for (const key of ['k', 'tx', 'ty']) UV[key] += (g[key] - UV[key]) * 0.16;
  const moving = Math.abs(g.k - UV.k) > g.k * 0.001 || Math.abs(g.tx - UV.tx) > 0.3 || Math.abs(g.ty - UV.ty) > 0.3;
  if (!moving) { Object.assign(UV, { k: g.k, tx: g.tx, ty: g.ty }); if (!UV.auto) UV.goal = null; }
  // 自动适配全貌时 goal 一直在，是否在动看这里（限帧用）
  return (UV.moving = moving);
}
const toUni = (sx, sy) => [(sx - UV.tx) / UV.k, (sy - UV.ty) / UV.k];

// 鼠标下是哪个星系（给悬停高亮和之后的点击飞入用）
function galaxyAt(L, sx, sy) {
  const [x, y] = toUni(sx, sy);
  let best = null, bd = GAL_R * 1.1;
  for (const g of L.galaxies) { const d = Math.hypot(g.x - x, g.y - y); if (d < bd) { bd = d; best = g; } }
  return best;
}

// ---- 交互：只在宇宙层生效；看板里的同名操作在 05-world.js，那边先判断 inUniverse() 让开 ----
const udrag = { on: false, x: 0, y: 0, moved: 0, target: null };
viewEl.addEventListener('wheel', (e) => {
  if (!inUniverse()) return;
  e.preventDefault();
  const r = viewEl.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (!uniWheelIn(e, sx, sy)) uniZoomAt(sx, sy, Math.exp(-e.deltaY * 0.0016));
  wake();
}, { passive: false });
viewEl.addEventListener('pointerdown', (e) => {
  if (!inUniverse() || e.button !== 0 || e.target.closest('#hud')) return;
  // 按下时就记住点中的星系：按住期间重画会清掉悬停结果，松开时不能再靠它
  const r = viewEl.getBoundingClientRect(), hit = UV.layout && galaxyAt(UV.layout, e.clientX - r.left, e.clientY - r.top);
  Object.assign(udrag, { on: true, x: e.clientX, y: e.clientY, moved: 0, target: hit ? hit.s.id : null });
  viewEl.setPointerCapture(e.pointerId);
});
viewEl.addEventListener('pointermove', (e) => {
  if (!inUniverse()) return;
  const r = viewEl.getBoundingClientRect();
  UV.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (!udrag.on) return;
  const dx = e.clientX - udrag.x, dy = e.clientY - udrag.y;
  udrag.moved += Math.abs(dx) + Math.abs(dy); udrag.x = e.clientX; udrag.y = e.clientY;
  if (udrag.moved > 4) {
    const g = UV.goal || UV;
    UV.goal = null; UV.auto = false;
    UV.tx = g.tx + dx; UV.ty = g.ty + dy; UV.k = g.k;
    viewEl.classList.add('dragging');
  }
  wake();
});
viewEl.addEventListener('pointerleave', () => { UV.hover = null; });
viewEl.addEventListener('pointerup', () => {
  if (!inUniverse()) { udrag.on = false; viewEl.classList.remove('dragging'); return; }
  // 没拖动、点在星系上：飞进这个对话
  if (udrag.on && udrag.moved <= 4 && udrag.target) flyIn(udrag.target);
  udrag.on = false; viewEl.classList.remove('dragging'); wake();
});
viewEl.addEventListener('dblclick', () => { if (inUniverse()) { uniFit(); wake(); } });
