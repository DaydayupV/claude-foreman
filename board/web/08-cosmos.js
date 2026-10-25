'use strict';
// 宇宙背景和星系核心：星空（视差，拖动缩放时比前景动得慢）、星云（核心一团白色微光，运行中的席位在光束区留一团自己的颜色）、
// 宇宙尘（缓慢漂移的小颗粒，光束区更密）、星系核心（中心亮核、倾斜的轨道环、闪烁的星点）。
// 每一部分都能在 URL 里用 off= 关掉对比，比如 ?off=stars,dust（可选 stars、nebula、dust、dots、galaxy）。

const LOOK = (() => {
  const off = new Set((new URLSearchParams(location.search).get('off') || '').split(',').map((s) => s.trim()).filter(Boolean));
  return { stars: !off.has('stars'), nebula: !off.has('nebula'), dust: !off.has('dust'), dots: !off.has('dots'), galaxy: !off.has('galaxy') };
})();

// 星空：在比世界大三倍的范围里撒星，按"缩得少、移得少"的视差映射到屏幕
const STARS = (() => {
  const rand = rng(77001), list = [];
  for (let i = 0; i < 520; i++) {
    const tone = rand();
    list.push({ x: (rand() * 3 - 1) * WL.W, y: (rand() * 3 - 1) * 900, r: 0.35 + Math.pow(rand(), 3) * 1.4, a: 0.15 + rand() * 0.55,
      tw: rand() < 0.28 ? 0.6 + rand() * 2.2 : 0, ph: rand() * 6.28, c: tone < 0.7 ? '246,246,250' : tone < 0.9 ? '214,214,222' : '255,244,232' });
  }
  return list;
})();

function drawStars(w, h, fit) {
  if (!LOOK.stars) return;
  const sec = performance.now() / 1000, kz = fit.k * Math.pow(VIEW.k / fit.k, 0.3);
  const px = (VIEW.tx - fit.tx) * 0.25, py = (VIEW.ty - fit.ty) * 0.25;
  const cx = w / 2 + px, cy = h / 2 + py, wx = WL.W / 2, wy = VIEW.H / 2;
  for (const s of STARS) {
    const x = cx + (s.x - wx) * kz, y = cy + (s.y - wy) * kz;
    if (x < -4 || y < -4 || x > w + 4 || y > h + 4) continue;
    const a = s.tw ? s.a * (0.45 + 0.55 * Math.sin(sec * s.tw + s.ph)) : s.a;
    ctx.fillStyle = `rgba(${s.c},${a.toFixed(3)})`;
    if (s.r > 1.1) { ctx.beginPath(); ctx.arc(x, y, s.r, 0, 6.283); ctx.fill(); } else ctx.fillRect(x, y, s.r * 1.6, s.r * 1.6);
  }
}

// 一团柔光：椭圆形的径向渐变
function cloud(x, y, rx, ry, color, a) {
  if (a <= 0.002) return;
  ctx.save();
  ctx.translate(x, y); ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, color(a)); g.addColorStop(0.45, color(a * 0.45)); g.addColorStop(1, color(0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, 6.283); ctx.fill();
  ctx.restore();
}

function drawNebula(L, P, t, rates, pal = []) {
  if (!LOOK.nebula) return;
  const c = L.core, sec = performance.now() / 1000;
  // 打底的大团柔光用 Claude Code 的颜色，和宇宙里小星系的盘面柔光一样（08-uni-galaxy.js）；偏上那团白光留着做层次
  cloud(c.cx, c.cy, c.R * 1.25, c.R * 0.95, (a) => rgba('claude', a * 0.75), 0.09);
  cloud(c.cx + c.R * 0.25, c.cy - c.R * 0.2, c.R * 0.8, c.R * 0.55, (a) => `rgba(240,240,248,${a * 0.6})`, 0.05);
  // 各模型颜色的几团淡云，绕着核心慢慢转，和上色的弧线一起成星云
  pal.forEach((col, i) => {
    const ang = (i / pal.length) * 6.283 + sec * 0.02, r = c.R * (0.35 + 0.15 * Math.sin(i * 2.3));
    cloud(c.cx + Math.cos(ang) * r, c.cy + Math.sin(ang) * r * 0.8, c.R * 0.6, c.R * 0.42, col, 0.045);
  });
  // 运行中的席位：在卡片和产出框之间留一团自己颜色的星云，越忙越亮；结束后只剩很淡的一点
  for (const [id, row] of L.rows) {
    const lane = B.laneById.get(id);
    if (!lane || !latest(lane)) continue;
    const on = laneActive(lane, t), I = glow(rates.get(id) || 0);
    const x = (row.card.x + row.card.w + row.out.x) / 2, y = row.card.y + row.card.h / 2;
    cloud(x, y, 230, 85, tintOf(id), smooth(`neb|${id}`, on ? 0.07 + 0.08 * I : 0.018) * row.vis);
  }
  const cc = B.laneById.get('cc');
  if (cc) cloud(L.cc.x + L.cc.w * 0.8, L.cc.y + L.cc.h / 2, 150, 90, tintOf('cc'), smooth('neb|cc', laneActive(cc, t) ? 0.07 : 0.025) * (1 - (L.ccAway || 0)));
}

// 宇宙尘：在世界里缓慢漂移，绕回；六成撒在光束区（刻度带右边到产出列之间）
const DUST = (() => {
  const rand = rng(50311), list = [];
  for (let i = 0; i < 220; i++) {
    const gap = rand() < 0.6;
    list.push({ x0: gap ? WL.bandX + WL.bandW + rand() * (WL.outX - WL.bandX - WL.bandW) : rand() * WL.W, y0: rand(), vx: (rand() - 0.3) * 6, vy: (rand() - 0.5) * 3,
      r: 0.5 + rand() * 1.1, a: 0.08 + rand() * 0.22, ph: rand() * 6.28, gap });
  }
  return list;
})();

function drawDust(L) {
  if (!LOOK.dust) return;
  const sec = performance.now() / 1000;
  for (const d of DUST) {
    const span = d.gap ? WL.outX - WL.bandX - WL.bandW : WL.W, left = d.gap ? WL.bandX + WL.bandW : 0;
    const x = left + ((((d.x0 - left + d.vx * sec) % span) + span) % span), y = ((((d.y0 * L.H + d.vy * sec) % L.H) + L.H) % L.H);
    ctx.fillStyle = `rgba(236,236,242,${(d.a * (0.6 + 0.4 * Math.sin(sec * 0.7 + d.ph))).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(x, y, d.r * FX.lw, 0, 6.283); ctx.fill();
  }
}

// 星系核心：中心亮核、两道倾斜的轨道环（上面有光点在走）、闪烁的星点；画在核心网上面。
// 配色和宇宙里的小星系一样（08-uni-galaxy.js）：亮核是 Claude Code 的暖色，星点六成白、四成取出场模型的颜色（pal：
// Claude Code 加上正在跑的席位），飞入时交过来的橙色亮核落地后还是橙色
const TWINKLE = (() => {
  const rand = rng(90127), tints = rng(90128), list = [];
  for (let i = 0; i < 70; i++) { const a = rand() * 6.283, r = Math.sqrt(rand()); list.push({ a, r, s: 0.8 + rand() * 1.6, f: 0.8 + rand() * 2.5, ph: rand() * 6.28, tint: tints() }); }
  return list;
})();
const starWhite = (a) => `rgba(248,248,252,${a})`;
const starColor = (tint, pal) => (tint < 0.6 || !pal.length ? starWhite : pal[Math.floor(tint * 10) % pal.length]);

function drawGalaxy(c, intensity, pal = []) {
  if (!LOOK.galaxy) return;
  const sec = performance.now() / 1000;
  ctx.save();
  ctx.beginPath(); ctx.rect(c.cx - c.R * 2, c.cy - c.R * 1.5, c.clipX - (c.cx - c.R * 2), c.R * 3); ctx.clip();
  // 轨道环
  for (const [tilt, rx, ry, spin, a] of [[0.32, 0.8, 0.22, 0.03, 0.24], [-0.6, 0.62, 0.17, -0.045, 0.19]]) {
    ctx.save();
    ctx.translate(c.cx, c.cy); ctx.rotate(tilt + Math.sin(sec * 0.05) * 0.06);
    ctx.strokeStyle = `rgba(235,235,242,${a})`; ctx.lineWidth = 0.8 * FX.lw;
    ctx.beginPath(); ctx.ellipse(0, 0, c.R * rx, c.R * ry, 0, 0, 6.283); ctx.stroke();
    // 每道环上三颗光点：第一颗取出场模型的颜色（两道环取调色板里不同的两个），另两颗白色
    for (let j = 0; j < 3; j++) {
      const th = sec * spin * 6.283 + j * 2.09;
      glowDot(Math.cos(th) * c.R * rx, Math.sin(th) * c.R * ry, 1.5, j ? starWhite : starColor(spin > 0 ? 0.6 : 0.7, pal), 0.8);
    }
    ctx.restore();
  }
  // 闪烁的星点
  for (const s of TWINKLE) {
    const a = 0.25 + 0.6 * Math.max(0, Math.sin(sec * s.f + s.ph));
    ctx.fillStyle = starColor(s.tint, pal)(a.toFixed(3));
    ctx.beginPath(); ctx.arc(c.cx + Math.cos(s.a) * s.r * c.R * 0.92, c.cy + Math.sin(s.a) * s.r * c.R * 0.92, s.s * FX.lw * 0.7, 0, 6.283); ctx.fill();
  }
  // 中心亮核：正中一点暖白高光，外面一圈 Claude Code 的橙色光晕
  const g = ctx.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, c.R * 0.28);
  g.addColorStop(0, `rgba(255,244,232,${0.35 + 0.25 * intensity})`); g.addColorStop(0.25, rgba('claude', 0.14 + 0.1 * intensity)); g.addColorStop(1, rgba('claude', 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.cx, c.cy, c.R * 0.28, 0, 6.283); ctx.fill();
  // 节拍（04-life.js 的 beatsAt）：亮核另闪一团光，不跟着输出强度封顶
  const beat = FX.beat?.env || 0;
  if (beat > 0.01) {
    const f = ctx.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, c.R * 0.34);
    f.addColorStop(0, `rgba(255,246,236,${0.6 * beat})`); f.addColorStop(0.3, rgba('claude', 0.28 * beat)); f.addColorStop(1, rgba('claude', 0));
    ctx.fillStyle = f; ctx.beginPath(); ctx.arc(c.cx, c.cy, c.R * 0.34, 0, 6.283); ctx.fill();
  }
  ctx.restore();
}
