'use strict';
// 宇宙层的光效（?look=old 换回以前的样子）：
//  亮星和亮核画成带十字星芒的光斑，正在干活的再拖一道横向长光；叠加混色（lighter），颜色重叠处发白；
//  亮的东西同时往辉光里放一份（08-fx.js 的 glowAt，宇宙层的光晕贴图比看板多两级，外面溢出一大圈柔光），整层画完后叠上去。
//  星云不进辉光，所以只有亮的东西会发光，不会把整片底色洗亮。
//  看板中心的亮核也带同一颗星芒（boardCoreFlare），飞入时从星系亮核的星芒原样接过来。

// gain：光斑、柔光和溢出辉光的总强度，整体调亮调暗只改这一个数
const ULOOK = { on: Q.get('look') !== 'old', gain: 0.5 };
const FLARES = new Map();   // 颜色 → { star, streak } 两张预先画好的光斑

// 光斑按颜色画一次缓存起来，每帧只缩放贴图（比每帧建渐变省得多）。base 是 'r,g,b'
function flareOf(base) {
  let f = FLARES.get(base);
  if (f) return f;
  const col = (a) => `rgba(${base},${a})`, white = (a) => `rgba(255,252,248,${a})`;
  // 十字星芒：256×256，中心一小团白热，外面一圈本色柔光，上下左右四道细芒，对角线两道短而淡
  const star = document.createElement('canvas');
  star.width = star.height = 256;
  const s = star.getContext('2d'), c = 128;
  s.globalCompositeOperation = 'lighter';
  const halo = s.createRadialGradient(c, c, 0, c, c, 64);
  halo.addColorStop(0, col(0.22)); halo.addColorStop(0.3, col(0.06)); halo.addColorStop(1, col(0));
  s.fillStyle = halo; s.fillRect(0, 0, 256, 256);
  const core = s.createRadialGradient(c, c, 0, c, c, 10);
  core.addColorStop(0, white(0.85)); core.addColorStop(0.35, white(0.55)); core.addColorStop(1, col(0));
  s.fillStyle = core; s.beginPath(); s.arc(c, c, 10, 0, 6.283); s.fill();
  const spike = (ang, len, w, a) => {
    s.save(); s.translate(c, c); s.rotate(ang);
    const g = s.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, white(a)); g.addColorStop(0.25, col(a * 0.55)); g.addColorStop(1, col(0));
    s.fillStyle = g; s.beginPath(); s.moveTo(0, -w); s.lineTo(len, 0); s.lineTo(0, w); s.closePath(); s.fill();
    s.restore();
  };
  for (let i = 0; i < 4; i++) spike(i * Math.PI / 2, 126, 1.4, 0.95);
  for (let i = 0; i < 4; i++) spike(Math.PI / 4 + i * Math.PI / 2, 46, 1.2, 0.35);
  // 横向长光：512×32 的扁椭圆，中间一道亮线
  const streak = document.createElement('canvas');
  streak.width = 512; streak.height = 32;
  const t = streak.getContext('2d');
  t.globalCompositeOperation = 'lighter';
  t.save(); t.translate(256, 16); t.scale(1, 16 / 256);
  const sg = t.createRadialGradient(0, 0, 0, 0, 0, 256);
  sg.addColorStop(0, col(0.45)); sg.addColorStop(0.4, col(0.12)); sg.addColorStop(1, col(0));
  t.fillStyle = sg; t.beginPath(); t.arc(0, 0, 256, 0, 6.283); t.fill();
  t.restore();
  const lg = t.createLinearGradient(0, 0, 512, 0);
  lg.addColorStop(0, white(0)); lg.addColorStop(0.5, white(0.85)); lg.addColorStop(1, white(0));
  t.fillStyle = lg; t.fillRect(0, 15.4, 512, 1.2);
  FLARES.set(base, f = { star, streak });
  return f;
}
// 一颗亮星：size 是星芒从中心到尖的屏幕像素，streak 是横向长光半宽的屏幕像素（0 不画）。
// 画在当前画布上，同时往辉光里放一份淡的，散开成柔光
function flare(x, y, color, size, a, streak = 0) {
  flareAt(x, y, color, upx(size), a, streak > 0 ? upx(streak) : 0);
}
// 同上，size、streak 按当前画布的坐标单位给（看板那边自己换算）
function flareAt(x, y, color, size, a, streak = 0) {
  a *= ULOOK.gain;
  if (a < 0.01 || size <= 0) return;
  const f = flareOf(baseOf(color)), d = size * 2, prev = ctx.globalCompositeOperation, pa = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = pa * Math.min(1, a);
  ctx.drawImage(f.star, x - d / 2, y - d / 2, d, d);
  if (streak > 0) { const sw = streak * 2, sh = sw / 16; ctx.drawImage(f.streak, x - sw / 2, y - sh / 2, sw, sh); }
  ctx.globalAlpha = pa; ctx.globalCompositeOperation = prev;
  if (GLOW.on) glowAt(x, y, size, color, Math.min(1, a) * 0.2, 'star');
}

// 只进辉光的一团柔光（亮核外面那圈大光晕用）；辉光关着时不画
function bloomBlob(x, y, r, color, a) {
  a *= ULOOK.gain;
  if (GLOW.on && a >= 0.01) glowAt(x, y, r, color, a, 'blob');
}

// 星系亮核的星芒：size、streak 是屏幕像素（宇宙层再经 upx 随缩放稍微变大），a 是透明度（还要乘星系的亮度）。
// 干活时星芒更长，思考中跟着脉动，派发中或飞入蓄能时再拖一道横向长光；charge 是飞入前的蓄能（0–1）
function coreFlare(state, charge, sec, seed) {
  const busy = state === 'idle' ? 0 : 1, tw = 0.92 + 0.08 * Math.sin(sec * 1.7 + seed % 11);
  const pulse = state === 'thinking' ? 1 + 0.18 * Math.sin(sec * 3.4 + seed % 7) : 1;
  return { size: (busy ? 40 : 12) * pulse * tw * (1 + 1.2 * charge), a: busy ? 0.6 : 0.3, streak: state === 'dispatching' || charge > 0 ? 95 * tw : 0 };
}

// 看板中心亮核的星芒（画在弧线区那层，世界坐标）。平时大小固定在屏幕上、亮度跟着总输出；
// 飞入时在星系亮核淡掉的同一段（v 0.34–0.44）淡入，起始的大小和亮度就是那一刻宇宙层蓄满能的星芒，随炸开慢慢变成平时的样子；飞出倒着放
function boardCoreFlare(core, intensity, T, burst) {
  const px = 1 / VIEW.k, sec = animMs() / 1000;
  let size = 44, a = 0.35 + 0.3 * intensity, streak = 80 * (0.5 + 0.5 * intensity), x = core.cx, y = core.cy;
  if (T && burst && T.g) {
    const u = coreFlare(T.g.s.state, 1, sec, T.g.seed), zf = Math.pow(UV.k / uniFitGoal().k, 0.35), s = burst.s;
    size = u.size * zf + (size - u.size * zf) * s;
    streak = u.streak * zf + (streak - u.streak * zf) * s;
    a = (u.a * uniStateA(T.g.s.state) + (a - u.a * uniStateA(T.g.s.state)) * s) * ramp(T.v, 0.34, 0.44);
    x = burst.wx; y = burst.wy;
  }
  flareAt(x, y, (al) => rgba('claude', al), size * px, a, streak * px);
}
