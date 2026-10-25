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

// 星云的配色：这个对话里用过的模型（席位）加上 Claude Code 自己。同一种颜色的输出先加起来，再开平方定分量（只跑过一次的小模型也留一缕颜色；
// 按任务逐个开平方的话，任务多的模型会盖过别的）。正在跑的模型还没有输出，分量至少给到最多那种的六成，干活时就看得出它的颜色。
// Claude Code 最多占四成，免得橙色又盖住一切；颜色太多会糊，席位最多取四种。
// seats: [{ key: 颜色键, out: 输出 token, running }]；返回 [{ key, w, running }]，w 加起来是 1，Claude Code 在最前
function nebulaMix(seats, ccOut, ccRunning) {
  const by = new Map([['claude', { key: 'claude', out: Math.max(0, ccOut || 0), running: !!ccRunning }]]);
  for (const s of seats) {
    const e = by.get(s.key) || { key: s.key, out: 0, running: false };
    e.out += Math.max(0, s.out || 0); e.running ||= !!s.running; by.set(s.key, e);
  }
  for (const e of by.values()) e.raw = Math.sqrt(Math.max(1, e.out));
  const top = Math.max(1, ...[...by.values()].filter((e) => e.key !== 'claude').map((e) => e.raw));
  for (const e of by.values()) if (e.key !== 'claude' && e.running) e.raw = Math.max(e.raw, 0.6 * top);
  const cc = by.get('claude'), others = [...by.values()].filter((e) => e !== cc).sort((a, b) => b.raw - a.raw).slice(0, 4);
  if (!others.length) return [{ key: 'claude', w: 1, running: cc.running }];
  const sum = others.reduce((s, e) => s + e.raw, 0), ccW = Math.min(0.4, cc.raw / (cc.raw + sum));
  return [{ key: 'claude', w: ccW, running: cc.running }, ...others.map((e) => ({ key: e.key, w: (1 - ccW) * e.raw / sum, running: e.running }))];
}

// 单对话的配色：车道上的任务（不含 Claude Code 席的报告），数据一变才重算
const MIX = { ver: -1, busy: null, mix: null };
function boardMix(t) {
  // Claude Code 算不算在干活：它的车道最近 90 秒有动静（host 记录的状态在对话还开着时一直是 running，不能用）
  const cc = B.laneById.get('cc'), last = cc?.events.at(-1), busy = !!last && t - last.ts < 90000;
  if (MIX.ver === B.version && MIX.busy === busy && MIX.mix) return MIX.mix;
  const seats = [], host = cc && latest(cc);
  for (const lane of B.lanes) {
    if (lane.id === 'cc' || lane.ghost) continue;
    for (const r of lane.runs) if (r.kind !== 'answer' && r.model) seats.push({ key: avatarFor(r.model, r.agent_type), out: usageOf(r)?.output ?? 0, running: r.status === 'running' });
  }
  Object.assign(MIX, { ver: B.version, busy, mix: nebulaMix(seats, host ? usageOf(host)?.output ?? 0 : 0, busy) });
  return MIX.mix;
}

// 交织的几团彩色星云：每种颜色按分量分成一到三团，摆在核心周围不同的角度和远近，各自慢慢漂；叠加混色，重叠的地方颜色自然混在一起。
// 正在跑的模型那几团亮一些，历史上用过的淡一些。(x, y) 是中心，R 是半径，flat 是上下压扁的比例，fade 是整体透明度；
// spread 是几团离中心多远（1 是绕着核心摆开，小于 1 往中心收拢、互相叠在一起），size 是每团的大小
// 近乎白色、灰色的颜色（ChatGPT、认不出的模型）当星云色叠多了是一层灰雾，把画面洗灰：这几种淡一半
const PALE = new Set(['chatgpt', 'unknown']);
function drawMixNebula(x, y, R, flat, mix, fade, seed = 0, { spread = 1, size = 1 } = {}) {
  const sec = performance.now() / 1000, prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  mix.forEach((m, i) => {
    const rand = rng(hash(`neb|${m.key}`) + seed), lobes = 1 + Math.round(2 * Math.sqrt(m.w)), dir = i % 2 ? -1 : 1;
    // 每种颜色占一个方向（按它在配色里的位置均分一圈），几团在这个方向两侧散开；整圈慢慢转，相邻两种颜色在交界处混在一起
    const home = (i / mix.length) * 6.283 + rand() * 0.6;
    for (let j = 0; j < lobes; j++) {
      const ang = home + (j - (lobes - 1) / 2) * 0.85 + rand() * 0.35 + sec * (0.01 + 0.01 * rand()) * dir, r = R * spread * (0.3 + 0.32 * rand());
      const rx = R * size * (0.36 + 0.3 * rand()) * (0.8 + 0.5 * Math.sqrt(m.w)), a = fade * (0.08 + 0.12 * Math.sqrt(m.w)) * (m.running ? 1.3 : 1) * (PALE.has(m.key) ? 0.5 : 1);
      cloud(x + Math.cos(ang) * r, y + Math.sin(ang) * r * flat, rx, rx * (0.55 + 0.25 * rand()) * Math.max(flat, 0.6), (al) => rgba(m.key, al), a);
    }
  });
  ctx.globalCompositeOperation = prev;
}

function drawNebula(L, P, t, rates) {
  if (!LOOK.nebula) return;
  const c = L.core;
  // 打底的星云按这个对话用过的模型上色（和宇宙里小星系的盘面一样，08-uni-galaxy.js）；偏上那团白光留着做层次
  drawMixNebula(c.cx, c.cy, c.R * 1.15, 0.8, boardMix(t), 1);
  cloud(c.cx + c.R * 0.25, c.cy - c.R * 0.2, c.R * 0.8, c.R * 0.55, (a) => `rgba(240,240,248,${a * 0.6})`, 0.05);
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
