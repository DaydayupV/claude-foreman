'use strict';
// 宇宙层的画面（PROTOCOL-v3 的摘要 → 星图）：
//  项目 = 一团星云（按项目里出场模型的颜色上色），旧对话化作星云边上的星尘；
//  对话 = 一个小星系：Claude Code 亮核、两条旋臂；正在干活的协作方是绕核转的星，一个派发组一圈轨道；
//  状态：思考中亮核脉动，派发中轨道亮、星往核里送光点，等你确认外面一圈琥珀色呼吸光环，出错留红点。

const UNI_STATE_A = { idle: 0.32, thinking: 0.85, dispatching: 0.95, waiting: 0.9 };
const uniSec = (ms) => (uNow() - ms) / 1000 / (U.clock.speed || 1);   // 记录时间 → 屏幕上过去了几秒
const runKey = (r) => avatarFor(r.model, r.agent);
const AMBER = (a) => `rgba(255,186,90,${a})`, ALERT = (a) => `rgba(255,92,80,${a})`;

// 背景星：铺满屏幕，随镜头轻微视差
const UNI_STARS = (() => {
  const rand = rng(9001), out = [];
  for (let i = 0; i < 420; i++) out.push({ x: rand(), y: rand(), r: rand() < 0.08 ? 1.3 : 0.6 + rand() * 0.5, a: 0.15 + rand() * 0.45, tw: rand() < 0.3 ? 0.5 + rand() * 2 : 0, ph: rand() * 6.283 });
  return out;
})();
function drawUniStars(w, h) {
  const sec = performance.now() / 1000, px = UV.tx * 0.04, py = UV.ty * 0.04;
  for (const s of UNI_STARS) {
    const x = ((s.x * w + px) % w + w) % w, y = ((s.y * h + py) % h + h) % h;
    const a = s.tw ? s.a * (0.5 + 0.5 * Math.sin(sec * s.tw + s.ph)) : s.a;
    ctx.fillStyle = `rgba(225,228,240,${a.toFixed(3)})`;
    ctx.fillRect(x, y, s.r * 1.5, s.r * 1.5);
  }
}

// 一个项目里出场的模型颜色：Claude Code 加上各对话最近的协作方
function projectPalette(p) {
  const keys = new Set(['claude']);
  for (const s of p.sessions) for (const r of s.runs) keys.add(runKey(r));
  return [...keys].map((k) => (a) => rgba(k, a));
}

function drawNebulaOf(p) {
  const pal = projectPalette(p), rand = rng(hash(p.key)), sec = performance.now() / 1000;
  const busy = p.sessions.reduce((n, s) => n + (s.state === 'idle' ? 0 : 1), 0);
  const a = 0.05 + 0.04 * Math.min(3, busy);
  for (let i = 0; i < 6; i++) {
    const ang = rand() * 6.283 + sec * 0.01 * (i % 2 ? 1 : -1), d = p.r * (0.15 + rand() * 0.5);
    cloud(p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d * 0.75, p.r * (0.55 + rand() * 0.4), p.r * (0.4 + rand() * 0.3), pal[i % pal.length], a);
  }
  // 窗口外的旧对话：星云边上的星尘
  const dust = rng(hash(p.key) ^ 77);
  for (let i = 0, n = Math.min(80, p.older * 10); i < n; i++) {
    const ang = dust() * 6.283, d = p.r * (0.75 + dust() * 0.35);
    ctx.fillStyle = HI(0.08 + dust() * 0.12);
    ctx.fillRect(p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d * 0.8, 1.2 / UV.k, 1.2 / UV.k);
  }
}

// charge：飞入前的蓄能（0–1），亮核变大变亮，外面多一圈柔光
function drawCoreOf(g, alpha, charge = 0) {
  const s = g.s, sec = performance.now() / 1000;
  const pulse = s.state === 'thinking' ? 1 + 0.18 * Math.sin(sec * 3.4 + g.seed % 7) : 1;
  const r = 4.2 * pulse * (1 + 1.4 * charge), c = (a) => rgba('claude', a);
  if (charge > 0) {
    const halo = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, r * 7);
    halo.addColorStop(0, c(0.35 * charge * alpha)); halo.addColorStop(1, c(0));
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(g.x, g.y, r * 7, 0, 6.283); ctx.fill();
  }
  const grd = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, r * 2.8);
  grd.addColorStop(0, HI(0.95 * alpha)); grd.addColorStop(0.22, c(0.7 * alpha)); grd.addColorStop(1, c(0));
  ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(g.x, g.y, r * 2.8, 0, 6.283); ctx.fill();
}

function drawUniLabels(L, hover) {
  // 飞入飞出时文字先淡掉，不跟着镜头飘在画面中间
  const lab = smooth('ulab', FLY.mode === 'universe' ? 1 : 0, 1);
  if (lab < 0.02) return;
  ctx.globalAlpha = lab;
  try { drawLabelsOn(L, hover); } finally { ctx.globalAlpha = 1; }
}
function drawLabelsOn(L, hover) {
  const kf = uniFitGoal().k, z = UV.k / kf;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const p of L.projects) {
    ctx.font = `600 ${12 / UV.k}px ui-monospace, Consolas, monospace`;
    // 写在这个项目最靠下的星系下面一点
    const low = Math.max(...L.galaxies.filter((g) => g.project === p.key).map((g) => g.y)) + GAL_R * 0.75 + 16 / UV.k;
    ctx.fillStyle = HI(0.55);
    ctx.fillText(p.name, p.x, low);
  }
  // 放大到一定程度才写对话标题，免得远看糊成一片
  const show = smooth('uni-titles', z > 1.6 ? 1 : 0);
  ctx.font = `${10.5 / UV.k}px "Microsoft YaHei", sans-serif`;
  for (const g of L.galaxies) {
    const a = Math.max(show, smooth(`uhl|${g.s.id}`, g === hover ? 1 : 0));
    if (a < 0.02) continue;
    ctx.fillStyle = HI(0.75 * a * UNI_STATE_A[g.s.state] + 0.2 * a);
    ctx.fillText(g.s.title || g.s.id.slice(0, 8), g.x, g.y + GAL_R * 0.62);
  }
}

function drawUniverse(L) {
  const board = ctx;
  ctx = UFX.ctx;
  try { drawUniverseOn(L); } finally { ctx = board; }
}
function drawUniverseOn(L) {
  // 星图都是柔光，按 1 倍像素画看不出差别，高分屏上要画的像素少很多
  const dpr = Math.min(devicePixelRatio || 1, 1), w = viewEl.clientWidth, h = viewEl.clientHeight, cv = UFX.cv;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawUniStars(w, h);
  ctx.setTransform(dpr * UV.k, 0, 0, dpr * UV.k, dpr * UV.tx, dpr * UV.ty);
  FX.lw = 1 / UV.k * uniFitGoal().k;
  // 屏幕外的星云和星系不画（放大以后大部分都在外面）；亮度照常平滑，飞回来时不会从 0 闪出
  const seen = (x, y, r) => x * UV.k + UV.tx > -r * UV.k && x * UV.k + UV.tx < w + r * UV.k && y * UV.k + UV.ty > -r * UV.k && y * UV.k + UV.ty < h + r * UV.k;
  for (const p of L.projects) if (seen(p.x, p.y, p.r * 1.3)) drawNebulaOf(p);
  const hover = UV.pick ? L.galaxies.find((g) => g.s.id === UV.pick) || null : UV.hover && !udrag.on ? galaxyAt(L, UV.hover.x, UV.hover.y) : null;
  UV.hot = hover;
  viewEl.style.cursor = hover ? 'pointer' : '';
  for (const g of L.galaxies) {
    // 新出现的对话：1.5 秒里从暗到亮
    const m = U.marks.get(g.s.id), born = m ? ease(clamp01(uniSec(m.born) / 1.5)) : 1;
    const a = smooth(`ua|${g.s.id}`, UNI_STATE_A[g.s.state] + (g === hover ? 0.25 : 0), UNI_STATE_A[g.s.state]) * born;
    if (!seen(g.x, g.y, GAL_R * 1.4) || a < 0.01) continue;
    // 正在飞入/飞出的星系：盘面在炸开前淡掉，亮核先蓄能（变亮变大），炸开后交给看板的弧线区（见 08-uni-fly.js 的分镜）
    const focus = FLYFX && g.s.id === FLY.id;
    drawGalaxyOf(g, focus ? a * (1 - ramp(FLYFX.v, 0.24, 0.4)) : a, g === hover);
    drawCoreOf(g, focus ? a * (1 - ramp(FLYFX.v, 0.34, 0.44)) : a, focus ? ramp(FLYFX.v, 0.12, 0.34) : 0);
    drawSignals(g);
  }
  if (hover) {
    ctx.lineWidth = upx(1.2); ctx.strokeStyle = markOf(hover.s.id, 0.75);
    ctx.beginPath(); ctx.ellipse(hover.x, hover.y, GAL_R * 1.2, GAL_R * (hover.flat + 0.2), hover.tilt, 0, 6.283); ctx.stroke();
  }
  drawUniLabels(L, hover);
}
