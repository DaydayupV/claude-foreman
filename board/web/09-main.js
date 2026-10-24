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
  // 连不上看板服务超过 20 秒：多半是服务退出了或者换了新地址，重连旧地址没有用，提示去拿新链接（只说一次，连上后重置）。
  // 每帧都查：飞进看板以后星图那一层不再画，也要能提示
  if (U.lostAt != null && !U.lostNoticed && !U.done && nowMs - U.lostAt > 20000) { U.lostNoticed = true; showNotice(TEXT.serverLost); }
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
  // 直播时星图到了两秒还找不到要飞进去的对话（超出时间窗口或显示上限）：说一声，不再等。回放里对话是陆续出现的，不算
  if (FLY.pending && FLY.mode === 'universe' && !U.sessions.has(FLY.pending) && U.clock.mode !== 'replay'
    && U.loadedAt != null && performance.now() - U.loadedAt > 2000) {
    FLY.pending = null; showNotice(TEXT.focusMissing);
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
// 页头下方的一行提示，12 秒后淡出
function showNotice(text) {
  const el = $('notice');
  el.textContent = text; el.classList.remove('faded');
  clearTimeout(showNotice.timer); showNotice.timer = setTimeout(() => el.classList.add('faded'), 12000);
}

// 后台标签页让出数据流：浏览器对同一主机只开 6 条连接，看板标签页多了，前台的页面会连不上。
// 平时在后台 10 分钟才让（让出以后再回来，较早的记录只剩最近 200 条，不能切一下窗口就让）；
// 前台的页面连不上超过 2 秒时，通过同源广播请后台的看板标签页马上让出来。
// 让出以后每分钟向服务报一次在，服务不会因为没有连接就当成没人看而退出
const HIDDEN_RELEASE_MS = 600000, WATCHING_PING_MS = 60000;
let hiddenReleaseTimer = null, watchingTimer = null;
const STREAM_CHANNEL = typeof BroadcastChannel === 'function' ? new BroadcastChannel('foreman-board-streams') : null;
const streamPaused = () => U.demo || window.__BOARD_FIXTURE__ || B.params.replay != null || B.params.t != null;
function releaseStreams() {
  clearTimeout(hiddenReleaseTimer); hiddenReleaseTimer = null;
  if (streamsReleased || streamPaused()) return;
  streamsReleased = true;
  disconnectUniverse(); disconnect();
  watchingTimer = setInterval(() => { fetch('health?watching=1').catch(() => {}); }, WATCHING_PING_MS);
}
// 前台页面的流迟迟连不上（01-state.js 的 watchStream 调用）：请其他看板标签页让出连接
function askForStream() { if (STREAM_CHANNEL && document.visibilityState !== 'hidden') STREAM_CHANNEL.postMessage('release'); }
if (STREAM_CHANNEL) STREAM_CHANNEL.onmessage = (e) => { if (e.data === 'release' && document.visibilityState === 'hidden') releaseStreams(); };
function onVisibilityChange() {
  clearTimeout(hiddenReleaseTimer); hiddenReleaseTimer = null;
  // 回放重连会从头播放，不能暂停共用时钟；定格和演示沿用原来的取数方式。
  if (streamPaused()) return;
  if (document.visibilityState === 'hidden') hiddenReleaseTimer = setTimeout(releaseStreams, HIDDEN_RELEASE_MS);
  else if (streamsReleased) {
    streamsReleased = false;
    clearInterval(watchingTimer); watchingTimer = null;
    if (FLY.mode === 'in' || FLY.mode === 'board') connect();
    else connectUniverse(); // 飞出已经切回宇宙流，动画未结束时也接回同一层。
  }
}
document.addEventListener('visibilitychange', onVisibilityChange);
onVisibilityChange();
if (LIVE_REPLAY_LINK) showNotice(TEXT.replayLive);
// 内嵌快照（截图、测试用）：没有服务可连，直接显示快照里这个对话的看板，不走星图
if (window.__BOARD_FIXTURE__) { FLY.mode = 'board'; connect(); }
else { connectUniverse(); resolveLegacyFocus(); }
wake();
