'use strict';
// 宇宙层 ↔ 看板的切换：
//  飞入：镜头朝星系推近（缩放按对数插值，星系从原位滑到屏幕中心），推到一半看板淡入、宇宙淡出；
//        同时关掉旧的明细流、清空看板，按这个对话打开新的（同一时刻只挂一个完整看板）。
//  飞出：看板先淡出，镜头从星系近处拉回飞入前的位置。
//  Esc、顶栏路径里的"宇宙"、看板缩到最小后继续往外滚，都是飞出。地址栏记 ?s=<对话 id>，刷新后直接回到这个对话。

const FLY = { mode: 'universe', id: null, t0: 0, from: null, to: null, back: null, out: 0, crumb: '', pending: Q.get('s') || Q.get('session') };
const FLY_IN = 1.6, FLY_OUT = 1.4;
// 老格式的地址（?group= / ?run= / ?replay=<组、任务或对话>，以前打开的是没有宇宙层的单个看板）：
// 问一次服务这个范围里的任务是哪个对话派出的，打开后飞进那个对话
function resolveLegacyFocus() {
  const scopes = { group: Q.get('group'), run: Q.get('run'), replay: LEGACY_REPLAY };
  // 只有回放的 all 是"全部"；group=all 是一个合法的组名
  const key = ['group', 'run', 'replay'].find((k) => scopes[k] != null && !(k === 'replay' && scopes[k] === 'all'));
  if (!key || FLY.pending || U.demo) return;
  const value = scopes[key], scope = LIVE_REPLAY_LINK && key === 'replay' ? (/^\d{8}-\d{6}-[a-z0-9]{4}$/.test(value) ? 'run' : 'group') : key;
  // 回放服务只认 replay=<组、任务或对话>（group=、run= 会回 400）；对不认识的范围回 404，和查不到任务一样提示
  const query = BOARD_REPLAY ? { replay: value } : { [scope]: value }, kind = /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(value) ? 'run' : 'group';
  fetch(`snapshot?${new URLSearchParams(query)}`).then((r) => (r.ok ? r.json() : r.status === 404 ? { runs: [] } : null))
    .then((s) => {
      // 按地址点名的范围取对话：任务取它自己派出时所在的对话（跨对话续接的车道里，前面几轮可能在别的对话），
      // 组取最近派出的那一份
      const runs = (s?.runs || []).filter((r) => r.session);
      const own = scope === 'run' ? runs.find((r) => r.id === value) : null;
      const latest = runs.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
      // 只有长得像对话 id（UUID）的值才直接当对话飞进去；查不到的组名、任务号不能当成对话
      const id = own?.session || latest?.session || (key === 'replay' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null);
      // 等结果的这一会儿用户已经自己动了页面，就不再自动飞进去
      if (id && !FLY.touched && !FLY.pending && FLY.mode === 'universe') { FLY.pending = id; wake(); }
      // 记录里根本没有这个组或任务（打错了、记录被删了）：说一声，不要停在宇宙里让人干等
      else if (!id && s && !(s.runs || []).length) showNotice(TEXT.legacyNotFound(kind, value));
    })
    .catch(() => {});
}

// 刷新页面时不再演一遍飞入
const RELOADED = performance.getEntriesByType?.('navigation')[0]?.type === 'reload';
// 打开链接后等自动飞入的那一小会儿里，用户点、滚、按键（包括按钮、侧栏、键盘缩放）都算自己在看了，不再自动飞入
for (const type of ['pointerdown', 'wheel', 'keydown']) addEventListener(type, () => { if (FLY.mode === 'universe') { FLY.pending = null; FLY.touched = true; } }, { capture: true, passive: true });
const flyU = () => clamp01((performance.now() - FLY.t0) / 1000 / (FLY.mode === 'in' ? FLY_IN : FLY_OUT));

// 切换的进度 v：0 在宇宙，1 在看板。飞入正着走，飞出（包括飞入途中退回）倒着走；缓动前后对称，所以退回时 v 不跳
const flyV = () => { const e = ease(flyU()); return FLY.mode === 'in' ? e : 1 - e; };
const ramp = (v, a, b) => ease(clamp01((v - a) / (b - a)));
// 一次切换的分镜（v 的区间），飞出按同样的分镜倒着放：
//  0–0.34    镜头推近；要进去的星系盘面淡掉，亮核蓄能（变亮变大，08-uni-draw.js）
//  0.34–0.84 炸开：看板真正的弧线区（星云、尘埃、核心网、中心星系）从亮核此刻所在的位置长出来，先快后慢；
//            各层先转得快、再慢到平常的转速，线条先亮后回落；炸开的一瞬亮核处一团白光（08-fx.js 的 burstOf）
//  0.40–0.72 宇宙层其余的星系、星云淡出
//  0.62–0.95 卡片、刻度带、光线、标签这些淡入（只淡入，不跟着炸）
// 弧线区一直以亮核为中心，长到最后正好就是看板里的样子，所以没有"换一张画"的那一下
function flyShare() {
  if (FLY.mode !== 'in' && FLY.mode !== 'out') return FLY.mode === 'board' ? { v: 1, uni: 0, fx: 1, rest: 1 } : { v: 0, uni: 1, fx: 0, rest: 0 };
  const v = flyV();
  return { v, uni: 1 - ramp(v, 0.4, 0.72), fx: v >= 0.3 ? 1 : 0, rest: ramp(v, 0.62, 0.95) };
}
// 看板这一帧要知道的切换状态：进度、炸开的进度 p、界面的淡入程度、亮核此刻在屏幕上的位置；不在切换中为 null
let FLYFX = null;
function flyFx(share) {
  if (FLY.mode !== 'in' && FLY.mode !== 'out') return null;
  const g = uniLayout().galaxies.find((x) => x.s.id === FLY.id);
  if (!g) return null;
  return { v: share.v, p: clamp01((share.v - 0.34) / 0.5), rest: share.rest, cx: g.x * UV.k + UV.tx, cy: g.y * UV.k + UV.ty };
}
function applyShare(share) {
  const set = (el, a) => { const v = a >= 0.999 ? '' : a.toFixed(3); if (el.style.opacity !== v) el.style.opacity = v; };
  // 弧线区在底下那层画布上，自己按分镜炸开；上面那层画布（光线、刻度带等）和卡片只做淡入淡出
  set(UFX.cv, share.uni); set(FX.cv, share.fx); set(FX.ov.cv, share.rest); set(worldEl, share.rest);
  // 底部表格在 v = 0.3 时从对话列表换成模型列表：换之前淡出，换之后跟界面一起淡入，不会一下子跳过去
  set($('usage'), share.v < 0.3 ? 1 - ramp(share.v, 0.12, 0.3) : share.rest);
  // 完全看不见的那一层不参与合成
  const vis = (el, on) => { const v = on ? '' : 'hidden'; if (el.style.visibility !== v) el.style.visibility = v; };
  vis(UFX.cv, share.uni > 0); vis(FX.cv, share.fx > 0); vis(FX.ov.cv, share.rest > 0);
  document.body.classList.toggle('u-on', true);
  document.body.classList.toggle('uni', FLY.mode === 'universe');
}

// 换一个对话：清掉上一个看板留下的卡片、表格行、终端栏和平滑值（宇宙层的 u 开头的不动）
function resetBoardView() {
  worldEl.replaceChildren();
  for (const m of [UI.cards, UI.outs, UI.heads, UI.tableRows]) m.clear();
  UI.open.clear(); UI.collapsed.clear(); UI.hot = null;
  for (const id of ['usage', 'terms', 'termdone']) { $(id).replaceChildren(); delete $(id).dataset.mode; }
  // 用量面板的"展开全部"跟着对话走：换对话时收起
  document.body?.classList.remove('table-all'); $('tall')?.remove();
  PANEL.allDone = false; PANEL.fold.clear(); PANEL.doneLines.clear();
  PANEL.cols.clear(); UNI_ROWS.clear();
  Object.assign(REEL, { s: 0, off: 0, anchor: null }); REEL.born.clear();
  for (const key of [...SMOOTH.vals.keys()]) if (!key.startsWith('u')) SMOOTH.vals.delete(key);
  FX.layout = null;
  // 回放估算的总量缓存按对话分：每个对话的 Claude Code 车道 id 都是 cc，不清掉就会拿上一个对话的数
  FINAL.clear(); FINAL_EV.clear(); loadFinals.started = false; loadFinals.gen = (loadFinals.gen || 0) + 1;
  // 加速脉冲的基线也按对话分（Claude Code 车道 id 都是 cc），换对话从新的速度重新算
  SURGE.clear();
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
  started = false; DOM.version = -1;
  connect();
}

function setUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('s', id); else url.searchParams.delete('s');
  // 老格式的范围参数只用来找第一次要飞进的对话，之后地址只记 s：不然飞出后一刷新又被它们带回那个对话
  for (const key of ['group', 'run', 'session']) url.searchParams.delete(key);
  if (!BOARD_REPLAY) url.searchParams.delete('replay');
  history.replaceState(null, '', url);
}

function flyIn(id, instant = false) {
  const g = uniLayout().galaxies.find((x) => x.s.id === id);
  if (!g) return false;
  const r = viewEl.getBoundingClientRect();
  FLY.back = { k: UV.k, tx: UV.tx, ty: UV.ty, auto: UV.auto };
  FLY.from = { k: UV.k, sx: g.x * UV.k + UV.tx, sy: g.y * UV.k + UV.ty };
  Object.assign(FLY, { id, mode: instant ? 'board' : 'in', mirror: false, t0: performance.now(), out: 0, pending: null });
  // 直播只留当前层的一条流，免得多个标签页占满同主机连接；回放宇宙共用时钟，重连会从头播放。
  if (!U.demo && B.params.replay == null && B.params.t == null) disconnectUniverse();
  UV.goal = null; UV.auto = false;
  openBoardFor(g.s);
  // 星系的亮核最后落在看板核心网（弧线区）的中心：它在那里炸开成弧线区（08-uni-burst.js）
  const L = computeLayout(now());
  VIEW.H = L.H;
  const fit = fitGoal(), cx = fit.tx + L.core.cx * fit.k, cy = fit.ty + L.core.cy * fit.k;
  FLY.to = { k: uniFitGoal().k * 14, sx: Number.isFinite(cx) ? cx : r.width / 2, sy: Number.isFinite(cy) ? cy : r.height / 2 };
  setUrl(id);
  wake();
  return true;
}
// 看板核心网（弧线区中心）此刻在屏幕上的位置：看板已经在画时按它的镜头算（数据晚到、重新适配、用户缩放过都跟得上），
// 还没开始画时按适配后的版面算
function boardCoreTarget() {
  const L = FX.layout || computeLayout(now());
  if (!L?.core) return null;
  const cam = FX.layout ? VIEW : fitGoal(), sx = cam.tx + L.core.cx * cam.k, sy = cam.ty + L.core.cy * cam.k;
  return Number.isFinite(sx) && Number.isFinite(sy) ? { sx, sy } : null;
}
function flyOut() {
  if (FLY.mode !== 'board' && FLY.mode !== 'in') return;
  // 收拢从弧线区此刻所在的位置开始，不先跳到飞入时估的那个位置
  const target = boardCoreTarget();
  if (target && FLY.to) Object.assign(FLY.to, target);
  // 飞入还没结束就退回：从当前进度倒着走（缓动曲线前后对称，倒放的起点是 1 − 当前进度），不先跳到看板；
  // 远端镜头沿用飞入前的那个，不重新适配（看板里算出来的全貌和宇宙层留出侧栏的全貌不一样，会跳）
  const mirror = FLY.mode === 'in', back = mirror ? 1 - flyU() : 0;
  // 直接打开到看板（刷新进来）时没有飞入前的镜头，退回去就复位到全貌
  if (!mirror && (!FLY.back || FLY.back.auto)) { const g = uniFitGoal(); FLY.back = { ...g, auto: true }; }
  Object.assign(FLY, { mode: 'out', mirror, t0: performance.now() - back * FLY_OUT * 1000 });
  if (!U.demo && B.params.replay == null && B.params.t == null) { disconnect(); connectUniverse(); }
  setUrl(null);
  wake();
}

// 每帧推进切换中的镜头；切换结束时落到看板或宇宙
function stepFly() {
  if (FLY.mode !== 'in' && FLY.mode !== 'out') return;
  const u = flyU(), e = ease(u), g = uniLayout().galaxies.find((x) => x.s.id === FLY.id);
  // 亮核的落点跟着看板核心网的实际位置走（平滑追上，不跳）：炸开结束时弧线区正好就是看板画它的地方
  const target = FLY.mode === 'in' ? boardCoreTarget() : null;
  if (target && FLY.to) { FLY.to.sx += (target.sx - FLY.to.sx) * 0.3; FLY.to.sy += (target.sy - FLY.to.sy) * 0.3; }
  if (g) {
    const near = FLY.to, far = FLY.mode === 'in' ? FLY.from : { k: FLY.back.k, sx: g.x * FLY.back.k + FLY.back.tx, sy: g.y * FLY.back.k + FLY.back.ty };
    const v = FLY.mode === 'in' ? e : 1 - e;   // 0 在远处，1 贴近星系
    const k = far.k * Math.pow(near.k / far.k, v), sx = far.sx + (near.sx - far.sx) * v, sy = far.sy + (near.sy - far.sy) * v;
    Object.assign(UV, { k, tx: sx - g.x * k, ty: sy - g.y * k, goal: null });
  }
  if (u < 1) return;
  if (FLY.mode === 'in') { FLY.mode = 'board'; if (target && FLY.to) Object.assign(FLY.to, target); }
  else {
    FLY.mode = 'universe';
    Object.assign(UV, { k: FLY.back.k, tx: FLY.back.tx, ty: FLY.back.ty, auto: FLY.back.auto, goal: null });
    disconnect();
  }
}

// 宇宙层对着一个星系一直往里滚：星系大到占视图三分之一（或者已经放到最大）以后再攒一段就飞进去（和看板缩到最小往外滚退回宇宙对称）。
// 鼠标下没有星系时取离视图中心最近的那个；往外滚清零
function uniWheelIn(e, sx, sy) {
  const L = UV.layout, r = viewEl.getBoundingClientRect();
  if (e.deltaY >= 0 || !L) { FLY.inAcc = 0; return false; }
  let g = galaxyAt(L, sx, sy);
  if (!g) {
    let bd = Infinity;
    for (const x of L.galaxies) { const d = Math.hypot(x.x * UV.k + UV.tx - r.width / 2, x.y * UV.k + UV.ty - r.height / 2); if (d < bd) { bd = d; g = x; } }
  }
  const need = Math.min(Math.min(r.width, r.height) / 3, GAL_R * uniFitGoal().k * 14 * 0.9);
  if (!g || GAL_R * UV.k < need) { FLY.inAcc = 0; return false; }
  if (FLY.inId !== g.s.id) { FLY.inId = g.s.id; FLY.inAcc = 0; }
  FLY.inAcc = (FLY.inAcc || 0) - e.deltaY;
  if (FLY.inAcc < 220) return false; // 攒的时候照常放大
  FLY.inAcc = 0;
  return flyIn(g.s.id);
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

// 顶栏路径：FOREMAN › 项目 › 对话；在看板里点 FOREMAN 回到宇宙
function renderCrumb() {
  const s = FLY.id && U.sessions.get(FLY.id), inside = FLY.mode !== 'universe' && s;
  const proj = inside && (U.projects.get(s.project)?.name || s.project);
  const html = inside ? '<i>›</i><span></span><i>›</i><b></b>' : '<i>·</i><span></span>';
  $('brand').classList.toggle('link', !!inside);
  $('brand').title = inside ? TEXT.backToUniverse : '';
  const key = inside ? `${html}|${proj}|${s.title}` : `${html}|${U.sessions.size}`;
  if (key === FLY.crumb) return;
  FLY.crumb = key;
  const el = $('crumb');
  el.innerHTML = html;
  if (inside) { el.querySelector('span').textContent = proj; el.querySelector('b').textContent = s.title || s.id.slice(0, 8); }
  else el.querySelector('span').textContent = TEXT.conversations(U.sessions.size);
}
$('brand').addEventListener('click', () => { if ($('brand').classList.contains('link')) flyOut(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && U.on && (FLY.mode === 'board' || FLY.mode === 'in')) { flyOut(); e.preventDefault(); } });
