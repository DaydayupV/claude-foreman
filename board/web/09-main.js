'use strict';
// 入口：每帧算版面、推进视图变换；数据变了（或每半秒）刷新卡片和用量表。
// 限帧：画面里的动作都很慢，静止时约 30 帧；拖动、缩放、镜头在走、飞入飞出时约 60 帧。
// 不限的话会跟着显示器刷新率跑（144Hz 屏一秒重画 144 次），整页都卡。

let raf = 0, drawnVersion = -1, lastDom = 0, lastFx = 0, started = false, lastFrame = 0, busyUntil = 0;
const FRAME_IDLE = 33, FRAME_BUSY = 16;
function wake() { if (!raf) raf = requestAnimationFrame(frame); }
// 用户在操作：接下来一小段时间按忙时的帧率画
function busy(ms = 400) { busyUntil = Math.max(busyUntil, performance.now() + ms); }
for (const type of ['wheel', 'pointermove', 'pointerdown', 'keydown']) addEventListener(type, () => busy(), { passive: true, capture: true });

// 一帧里出了错不能拖垮整个页面：记一次日志，下一帧照常画（不然 requestAnimationFrame 链断掉，页面就停住了）
let frameError = null;
function frame() {
  raf = 0;
  try { step(); } catch (e) {
    if (String(e) !== frameError) { frameError = String(e); console.error('board: frame failed', e); }
    wake();
  }
}

function step() {
  const nowMs = performance.now();
  const moving = nowMs < busyUntil || FLY.mode === 'in' || FLY.mode === 'out' || drag.on || udrag.on
    || (U.on && FLY.mode === 'universe' ? UV.moving : VIEW.goal);   // 只看正在画的那一边的镜头
  // 留 3 毫秒余量：刷新间隔有抖动，卡着整数比较会隔一帧才画
  if (nowMs - lastFrame < (moving ? FRAME_BUSY : FRAME_IDLE) - 3) { wake(); return; }
  lastFrame = nowMs;
  UV.fitCache = null; UV.frame++;
  if (U.on) {
    // 宇宙层：飞入飞出的过渡里两边都画，按各自占的份额淡入淡出
    stepFly();
    const share = flyShare();
    FLYFX = flyFx(share);
    if (share.uni > 0) uniFrame(share.fx <= 0);
    applyShare(share);
    renderCrumb();
    if (share.fx <= 0) { wake(); return; }
  }
  stepReel(nowMs);
  const t = now();
  smoothFrame(t);
  const L = computeLayout(t);
  if (!started) { started = true; VIEW.H = L.H; fitView(true); }
  const viewMoving = stepView(L.H);
  if (B.version !== drawnVersion || nowMs - lastDom > 500) {
    drawnVersion = B.version;
    lastDom = nowMs;
    loadFinals();
    renderTop(t);
    renderWorld(t, L);
    renderTable(t);
    renderTerms(t, L);
  }
  placeWorld(L, t);
  // 往下滚到终端、星图整个移出屏幕时不画画布
  if ((viewMoving || nowMs - lastFx >= 30) && viewEl.getBoundingClientRect().bottom > 0) { lastFx = nowMs; drawFx(t, L); }
  wake();
}

// 宇宙层：所有对话的星图（08-uni-*.js），飞进某个对话之前不画看板
let uniStarted = false;
// 看板也在画时（过渡中）平滑的节拍由看板那边推进，免得两个时钟交替让平滑每帧都当成跳变
function uniFrame(alone = true) {
  const t = uNow();
  if (alone) smoothFrame(t);
  if (FLY.mode === 'universe') { renderUniPanels(); renderUniTop(); }
  const L = uniLayout();
  if (!uniStarted && L.galaxies.length) {
    uniStarted = true;
    if (!(Q.get('focus') && uniFocus(L, Q.get('focus')))) uniFit(true);
  }
  // ?s=<对话>：打开链接时先看一眼宇宙，再飞进这个对话；刷新页面时直接回到对话。回放时对话是陆续出现的，等它出现了再进去
  if (FLY.pending && FLY.mode === 'universe' && U.sessions.has(FLY.pending)) {
    const id = FLY.pending, ms = performance.now();
    if (RELOADED) { FLY.pending = null; flyIn(id, true); }
    else if (FLY.pendingAt == null) FLY.pendingAt = ms + 800;
    else if (ms >= FLY.pendingAt) { FLY.pending = null; FLY.pendingAt = null; flyIn(id); }
    wake();
  }
  stepUni();
  // 往下滚到终端、星图整个移出屏幕时不画
  if (viewEl.getBoundingClientRect().bottom > 0) drawUniverse(L);
  setText($("zoom-val"), `${Math.round((UV.k / uniFitGoal().k) * 100)}%`);
}

// 图片的原生拖动一律不要（CSS 管不到的浏览器靠这里）
addEventListener('dragstart', (e) => { if (e.target instanceof HTMLImageElement) e.preventDefault(); });
history.scrollRestoration = 'manual'; // 每次打开都停在星图和用量面板的位置
connectUniverse();
resolveLegacyFocus();
wake();
