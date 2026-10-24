'use strict';
// 入口：每帧算版面、推进视图变换；数据变了（或每半秒）刷新卡片和用量表。
// 限帧：画面里的动作都很慢，静止时约 30 帧；拖动、缩放、镜头在走、飞入飞出时约 60 帧。
// 不限的话会跟着显示器刷新率跑（144Hz 屏一秒重画 144 次），整页都卡。

let raf = 0, lastFx = 0, started = false, lastFrame = 0, busyUntil = 0;
const FRAME_IDLE = 33, FRAME_BUSY = 16;
function wake() { if (!raf) raf = requestAnimationFrame(frame); }

// 这一帧要不要刷新卡片和面板，以及用量表、终端区画哪几块（返回 null 是这一帧不刷新）。
// 数据一直在来的对话（正在干活的那个）事件很密：数据变了最快每 250 毫秒刷新一次；界面操作（UI.ver）马上刷新；没变也每半秒刷新一次。
// 飞入动画进行中用量表和终端区在画面下方还没露出来，先不搭（一次要算整份统计、建整块 DOM），免得和动画抢同一帧；
// 落地后先搭用量表，搭完了再搭终端区，两块不挤在同一帧里。
// 用量表和终端区一次只新建约 12 毫秒的行（第一次搭、行一下多了很多时），没建完的下一帧接着建（again）。
// 卡片没建完（world，06-cards.js 的 renderWorld 分帧建）时下一帧只接着建卡片，用量表和终端区不跟着重画
const DOM = { version: -1, ui: -1, at: 0, deferred: false, again: false, world: false, warmed: false };
function domStep(nowMs, landing) {
  if (!(UI.ver !== DOM.ui || B.version !== DOM.version && nowMs - DOM.at >= 250 || nowMs - DOM.at > 500 || DOM.again || DOM.deferred && !landing)) {
    return DOM.world ? { table: false, terms: false } : null;
  }
  DOM.version = B.version; DOM.ui = UI.ver; DOM.at = nowMs; DOM.again = false;
  if (landing) { DOM.deferred = 'all'; return { table: false, terms: false }; }
  if (DOM.deferred === 'all') return { table: true, terms: false };
  if (DOM.deferred === 'terms') return { table: false, terms: true };
  return { table: true, terms: true };
}
// 这一帧画了哪几块（dom，domStep 的返回）、画完没有：落地后的那一段按它往下走，没画完的下一帧再画
function domDrawn(dom, table, terms) {
  if (DOM.deferred === 'all') { if (dom.table) { if (table) DOM.deferred = 'terms'; else DOM.again = true; } return; }
  if (DOM.deferred === 'terms') { if (dom.terms) { if (terms) DOM.deferred = false; else DOM.again = true; } return; }
  if (dom.table && !table || dom.terms && !terms) DOM.again = true;
}
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
  viewBox(); // 先量视图，这一帧后面写 DOM 以后不再量（05-world.js）
  // 连不上看板服务超过 20 秒：多半是服务退出了或者换了新地址，重连旧地址没有用，提示去拿新链接（只说一次，连上后重置）。
  // 每帧都查：飞进看板以后星图那一层不再画，也要能提示
  // 已经确认服务退出、显示着一直留着的提示时，不拿这条会淡出的盖掉
  if (U.lostAt != null && !U.lostNoticed && !U.done && nowMs - U.lostAt > 20000) { U.lostNoticed = true; if (!showNotice.kept) showNotice(TEXT.serverLost); }
  if (U.on) {
    // 宇宙层：飞入飞出的过渡里两边都画，按各自占的份额淡入淡出
    stepFly();
    const share = flyShare();
    FLYFX = flyFx(share);
    if (share.uni > 0) uniFrame(share.fx <= 0);
    applyShare(share);
    renderCrumb();
    if (share.fx <= 0) { if (FLY.mode === 'in') warmBoard(); wake(); return; }
  }
  stepReel(nowMs);
  const t = now();
  smoothFrame(t);
  const L = computeLayout(t);
  if (!started) { started = true; VIEW.H = L.H; fitView(true); }
  const viewMoving = stepView(L.H);
  // 飞入落地以后镜头还在走的那一段也先不搭：第一次搭用量表和终端区要一两百毫秒，等画面停下再搭就看不出顿
  // 这一帧刚算了 Claude Code 车道的统计，面板就留到下一帧再刷新（连着最多留一次）
  DOM.warmed = !DOM.warmed && warmBoard();
  const dom = DOM.warmed ? null : domStep(nowMs, FLY.mode === 'in' || DOM.deferred === 'all' && viewMoving);
  if (dom) {
    loadFinals();
    renderTop(t);
    const world = renderWorld(t, L);
    const table = dom.table ? renderTable(t) : true, terms = dom.terms ? renderTerms(t, L) : true;
    domDrawn(dom, table, terms);
    DOM.world = !world; // 卡片还没建完，下一帧接着建
  }
  placeWorld(L, t);
  // 往下滚到终端、星图整个移出屏幕时不画画布。镜头不动时画布约 30 帧就够了；飞入飞出的弧线区炸开、收拢时每帧都画，
  // 不然它只有宇宙层一半的帧数，看起来一顿一顿的
  const flying = FLY.mode === 'in' || FLY.mode === 'out';
  if ((viewMoving || flying || nowMs - lastFx >= 30) && viewBox().bottom > 0) { lastFx = nowMs; drawFx(t, L); }
  wake();
}

// 提前算好 Claude Code 车道的统计（长对话有两万条统计事件，每来一批新事件整段重算要十几毫秒，之后有缓存）：
// 飞入的前一段看板还没开始画、宇宙层一帧只要几毫秒；平时是要刷新面板的那一帧之前，让两样不挤在同一帧。
// 返回这一帧是不是算了
function warmBoard() {
  const cc = B.laneById.get('cc');
  // 分段缓存还是这一版的（04-rates.js 的 segments 用同样的版本号）就不用算；回放的版本号算法不同，不提前算
  if (!cc?.rate_events.length || FINAL_EV.has('cc') || cc.segs && cc.segsAt === `${cc.ver || 0}|${cc.runs.length}`) return false;
  laneStats(cc, now());
  return true;
}

// 宇宙层：所有对话的星图（08-uni-*.js），飞进某个对话之前不画看板
let uniStarted = false;
// 看板也在画时（过渡中）平滑的节拍由看板那边推进，免得两个时钟交替让平滑每帧都当成跳变
function uniFrame(alone = true) {
  const t = uNow();
  if (alone) smoothFrame(t);
  // 飞出时看板在进度 0.3 停画（alone），面板从这时起换成宇宙的，跟着淡入（08-uni-fly.js 的 applyShare）
  if (FLY.mode === 'universe' || FLY.mode === 'out' && alone) { renderUniPanels(); renderUniTop(); }
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
  if (viewBox().bottom > 0) drawUniverse(L);
  setText($("zoom-val"), `${Math.round((UV.k / uniFitGoal().k) * 100)}%`);
}

// 图片的原生拖动一律不要（CSS 管不到的浏览器靠这里）
addEventListener('dragstart', (e) => { if (e.target instanceof HTMLImageElement) e.preventDefault(); });
history.scrollRestoration = 'manual'; // 每次打开都停在星图和用量面板的位置
// 页头下方的一行提示，12 秒后淡出；keep 为 true 时一直留着（看板服务已经退出）
function showNotice(text, keep = false) {
  const el = $('notice');
  el.textContent = text; el.classList.remove('faded');
  clearTimeout(showNotice.timer); showNotice.timer = keep ? null : setTimeout(() => el.classList.add('faded'), 12000);
  showNotice.kept = keep;
}

// 后台满 10 分钟取消订阅，省下服务和浏览器的计算；直连流也会腾出同主机最多 6 条的连接。
// 让出以后再回来，较早的记录只剩最近 200 条，不能切一下窗口就让；
// 前台的页面连不上超过 2 秒时，通过同源广播请后台用直连流的看板标签页马上让出来。
// 让出以后每分钟向服务报一次在，服务不会因为没有连接就当成没人看而退出；
// 在后台放了 30 分钟以上就不再报，忘在后台的标签页不能让服务一直不退出
const HIDDEN_RELEASE_MS = 600000, WATCHING_PING_MS = 60000, WATCHING_MAX_MS = 1800000;
let hiddenReleaseTimer = null, watchingTimer = null, hiddenSince = null;
const STREAM_CHANNEL = typeof BroadcastChannel === 'function' ? new BroadcastChannel('foreman-board-streams') : null;
const streamPaused = () => U.demo || window.__BOARD_FIXTURE__ || B.params.replay != null || B.params.t != null;
function releaseStreams() {
  clearTimeout(hiddenReleaseTimer); hiddenReleaseTimer = null;
  if (streamsReleased || streamPaused()) return;
  streamsReleased = true;
  disconnectUniverse(); disconnect();
  watchingTimer = setInterval(() => {
    if (hiddenSince != null && performance.now() - hiddenSince >= WATCHING_MAX_MS) { clearInterval(watchingTimer); watchingTimer = null; return; }
    fetch('health?watching=1').catch(() => {});
  }, WATCHING_PING_MS);
}
// 前台页面的流迟迟连不上（01-state.js 的 watchStream 调用）：请其他看板标签页让出连接
function askForStream() { if (STREAM_CHANNEL && document.visibilityState !== 'hidden') STREAM_CHANNEL.postMessage('release'); }
if (STREAM_CHANNEL) STREAM_CHANNEL.onmessage = (e) => {
  if (e.data === 'release' && document.visibilityState === 'hidden'
    && [B.es, U.es].some((es) => es && (!(es instanceof SharedStream) || es.direct))) releaseStreams();
};
function onVisibilityChange() {
  clearTimeout(hiddenReleaseTimer); hiddenReleaseTimer = null;
  // 回放重连会从头播放，不能暂停共用时钟；定格和演示沿用原来的取数方式。
  if (streamPaused()) return;
  if (document.visibilityState === 'hidden') { hiddenSince = performance.now(); hiddenReleaseTimer = setTimeout(releaseStreams, HIDDEN_RELEASE_MS); return; }
  hiddenSince = null;
  // 回到前台时流还卡在连接中（在后台时连接被占满了）：请其他看板标签页让出，不用等它们自己隐藏满 10 分钟
  if (!streamsReleased && [B.es, U.es].some((es) => es?.readyState === 0)) askForStream();
  if (streamsReleased) {
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
