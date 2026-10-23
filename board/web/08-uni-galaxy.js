'use strict';
// 一个对话星系的细节：盘面旋臂、派发组的轨道、协作方的星（出生时从核里长出来，结束时盘旋着收回核里）、
// 星往核里送的光点、等你确认的琥珀光环、出错时的红闪和红点。盘面是倾斜的椭圆，倾角按对话 id 定。

const GAL_MORPH = new Map();  // seed → 形态（类型、扁度、转向、盘面上的点）
const GAL_SPIN = { idle: 0.035, thinking: 0.16, dispatching: 0.12, waiting: 0.06 };
const STAR_BORN = 1.2, STAR_HOME = 1.4;   // 秒：星长出来、收回去各用多久
// 线宽按屏幕像素给：放大时只稍微变粗
const upx = (n) => n / UV.k * Math.pow(1 / FX.lw, 0.35);

// 形态按对话 id 定，十份里：两份双臂旋涡、三份多臂旋涡，棒旋、透镜、椭圆、环状、不规则各一份。
// 双臂和棒旋天生像 S，所以份数少、旋臂绕得更紧，看起来是卷起来的涡而不是一个 S。
// 弯度、散布、大小、扁度、转向、转速也都各不相同，免得满屏都是同一个 S
const GAL_KINDS = ['spiral', 'spiral', 'multi', 'multi', 'multi', 'barred', 'lenticular', 'elliptical', 'ring', 'irregular'];
function morphOf(seed) {
  let m = GAL_MORPH.get(seed);
  if (m) return m;
  const rand = rng(seed ^ 0x5bd1e995), kind = GAL_KINDS[Math.floor(rand() * GAL_KINDS.length)];
  const size = 0.82 + rand() * 0.3, pts = [];
  // r 是相对盘面半径（0–1），a 是角度；s 点的大小，b 亮度，tint 小于 0.6 的是白点，其余取出场模型的颜色
  const add = (r, a, s = 0.8 + rand() * 1.1, b = 0.45 + rand() * 0.55) => pts.push({ r: r * GAL_R * size, a, s, b, tint: rand() });
  const addXY = (x, y, s, b) => add(Math.hypot(x, y), Math.atan2(y, x), s, b);
  const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
  const arm = (start, wind, spread, n, from = 0.14) => {
    for (let i = 0; i < n; i++) {
      const u = i / n;
      add((from + (1 - from) * u) * (0.9 + rand() * 0.2), start + u * wind + gauss() * spread * (0.4 + u));
    }
  };
  const halo = (n, reach = 0.9) => { for (let i = 0; i < n; i++) add(Math.sqrt(rand()) * reach, rand() * 6.283, 0.4 + rand() * 0.5, 0.25 + rand() * 0.4); };
  if (kind === 'spiral' || kind === 'multi') {
    const arms = kind === 'spiral' ? 2 : 3 + Math.floor(rand() * 2);
    const wind = kind === 'spiral' ? 3 + rand() * 2.8 : 1.1 + rand() * 2, spread = kind === 'spiral' ? 0.15 + rand() * 0.3 : 0.35 + rand() * 0.4;
    const skew = rand() * 0.6;   // 各条臂起点不完全对称
    for (let i = 0; i < arms; i++) arm(i * 6.283 / arms + (i % 2) * skew, wind, spread, Math.round(92 / arms));
    halo(22);
  } else if (kind === 'barred') {
    const bar = 0.24 + rand() * 0.14, wind = 2.6 + rand() * 1.6;
    for (let i = 0; i < 26; i++) addXY((rand() * 2 - 1) * bar, gauss() * 0.05);
    arm(0, wind, 0.2, 38, bar); arm(Math.PI, wind, 0.2, 38, bar);
    halo(18);
  } else if (kind === 'lenticular') {
    // 透镜：亮的核球加一层平滑的薄盘，没有旋臂
    for (let i = 0; i < 40; i++) add(0.3 * Math.pow(rand(), 1.3), rand() * 6.283, 0.7 + rand() * 0.9, 0.55 + rand() * 0.45);
    for (let i = 0; i < 70; i++) add(0.25 + 0.75 * Math.pow(rand(), 0.8), rand() * 6.283, 0.5 + rand() * 0.7, 0.25 + rand() * 0.45);
  } else if (kind === 'elliptical') {
    for (let i = 0; i < 104; i++) add(0.92 * Math.pow(rand(), 1.5), rand() * 6.283, 0.6 + rand() * 0.9, 0.3 + rand() * 0.7);
  } else if (kind === 'ring') {
    const ring = 0.58 + rand() * 0.18;
    for (let i = 0; i < 74; i++) add(ring + gauss() * 0.07, rand() * 6.283);
    halo(16, 0.3); halo(10, 1);
  } else {
    // 不规则：几团各自聚集的星点
    for (let c = 0, n = 4 + Math.floor(rand() * 3); c < n; c++) {
      const cr = 0.15 + rand() * 0.65, ca = rand() * 6.283, cx = Math.cos(ca) * cr, cy = Math.sin(ca) * cr, w = 0.08 + rand() * 0.12;
      for (let i = 0; i < 18; i++) addXY(cx + gauss() * w, cy + gauss() * w);
    }
    halo(14);
  }
  // 倾斜后的扁度：椭圆星系更圆，旋涡和环状可以很扁
  const flat = kind === 'elliptical' ? 0.62 + rand() * 0.25 : kind === 'lenticular' ? 0.3 + rand() * 0.25 : 0.38 + rand() * 0.42;
  m = { kind, pts, flat, size, dir: rand() < 0.5 ? -1 : 1, speed: 0.7 + rand() * 0.6 };
  GAL_MORPH.set(seed, m);
  return m;
}

// 星系局部坐标（盘面上的半径和角度）→ 宇宙坐标
function galPoint(g, r, a) {
  const tilt = g.tilt, lx = Math.cos(a) * r, ly = Math.sin(a) * r * g.flat;
  return [g.x + Math.cos(tilt) * lx - Math.sin(tilt) * ly, g.y + Math.sin(tilt) * lx + Math.cos(tilt) * ly];
}

// 这一帧要画的星：在跑的，加上刚结束、还在往回收的；按派发组分圈
function starsOf(g) {
  const s = g.s, m = U.marks.get(s.id), out = [], rings = new Map();
  for (const r of [...s.runs].reverse()) {
    const rm = m?.runs.get(r.id);
    if (!rm) continue;
    const home = rm.ended == null ? 0 : uniSec(rm.ended) / STAR_HOME;
    if (home >= 1) continue;
    const key = r.group || r.id;
    if (!rings.has(key)) rings.set(key, rings.size);
    out.push({ r, ring: rings.get(key), born: clamp01(uniSec(rm.born) / STAR_BORN), home: clamp01(home), color: (a) => rgba(runKey(r), a) });
  }
  const perRing = new Map();
  for (const st of out) perRing.set(st.ring, (perRing.get(st.ring) || 0) + 1);
  const idx = new Map();
  for (const st of out) { const i = idx.get(st.ring) || 0; idx.set(st.ring, i + 1); st.slot = i / perRing.get(st.ring); }
  return out;
}

function drawGalaxyOf(g, alpha, hover) {
  const s = g.s, M = morphOf(g.seed), sec = performance.now() / 1000;
  // 整个盘面一起转（各点角速度相同），形状不会越转越卷
  const spin = sec * smooth(`uspin|${s.id}`, GAL_SPIN[s.state], GAL_SPIN[s.state]) * M.speed * M.dir;
  const pal = [(a) => rgba('claude', a), ...s.runs.filter((r) => r.status === 'running').map((r) => (a) => rgba(runKey(r), a))];
  // 盘面的柔光
  cloud(g.x, g.y, GAL_R * 1.05 * M.size, GAL_R * (M.flat + 0.06) * M.size, pal[0], 0.07 * alpha + (hover ? 0.05 : 0));
  // 旋臂：大部分是白色星点，带活的模型颜色点缀。按颜色和三档亮度分桶，每桶一次填充（逐点设颜色太慢）
  // 点的大小按屏幕像素算：远看 1 像素上下，放大时只慢慢变大（开平方），近看画成圆点，不显得方块化
  const grow = 1.2 * Math.sqrt(1 / FX.lw), round = grow * 1.4 >= 1.8, buckets = new Map();
  for (const p of M.pts) {
    const ci = p.tint < 0.6 ? -1 : Math.floor(p.tint * 10) % pal.length, key = (ci + 1) * 3 + Math.min(2, Math.floor(p.b * 3));
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(p);
  }
  const k = alpha * (hover ? 1 : 0.85);
  for (const [key, list] of buckets) {
    const ci = Math.floor(key / 3) - 1, col = ci < 0 ? HI : pal[ci];
    ctx.fillStyle = col((0.45 + 0.22 * (key % 3)) * k);
    ctx.beginPath();
    for (const p of list) {
      const [x, y] = galPoint(g, p.r, p.a + spin), d = p.s * grow / UV.k;
      if (round) { ctx.moveTo(x + d / 2, y); ctx.arc(x, y, d / 2, 0, 6.283); } else ctx.rect(x - d / 2, y - d / 2, d, d);
    }
    ctx.fill();
  }
  const stars = starsOf(g), ringA = new Map();
  for (const st of stars) ringA.set(st.ring, Math.max(ringA.get(st.ring) || 0, st.born * (1 - st.home)));
  // 派发组的轨道
  for (const [ring, a] of ringA) {
    const R = GAL_R * (0.48 + 0.24 * ring), col = stars.find((x) => x.ring === ring).color;
    ctx.lineWidth = upx(0.7);
    ctx.strokeStyle = col(0.32 * a); ctx.beginPath(); ctx.ellipse(g.x, g.y, R, R * g.flat, g.tilt, 0, 6.283); ctx.stroke();
  }
  for (const st of stars) {
    const R = GAL_R * (0.48 + 0.24 * st.ring), orbit = R * ease(st.born) * (1 - ease(st.home));
    const ang = st.slot * 6.283 + sec * (0.32 - 0.07 * st.ring) + (g.seed % 628) / 100 + st.home * 5;
    const [x, y] = galPoint(g, orbit, ang);
    const live = st.r.status === 'running' && !st.r.queued;
    // 往核里送的光点
    if (live && st.born >= 1) {
      // 一根淡淡的光丝，上面有光点往核里流
      const lg = ctx.createLinearGradient(x, y, g.x, g.y);
      lg.addColorStop(0, st.color(0.35 * alpha)); lg.addColorStop(1, st.color(0));
      ctx.strokeStyle = lg; ctx.lineWidth = upx(0.9); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(g.x, g.y); ctx.stroke();
      for (let j = 0; j < 3; j++) {
        const u = (sec * 0.55 + j / 3 + st.slot) % 1;
        glowDot(x + (g.x - x) * u, y + (g.y - y) * u, 2, st.color, 0.9 * (1 - u * 0.8));
      }
    }
    const blink = st.r.queued ? 0.35 + 0.3 * Math.sin(sec * 5) : 1;
    glowDot(x, y, 2.2 + 0.8 * st.born * (1 - st.home), st.color, alpha * blink * (0.3 + 0.7 * st.born));
  }
}

// 等你确认：一圈琥珀色的呼吸光环；出错：红色闪一下，之后在右上角留一个红点
function drawSignals(g) {
  const s = g.s, m = U.marks.get(s.id), sec = performance.now() / 1000;
  const wait = smooth(`uwait|${s.id}`, s.state === 'waiting' ? 1 : 0);
  if (wait > 0.01) {
    const br = 0.5 + 0.5 * Math.sin(sec * 2.2), R = GAL_R * (1.08 + 0.05 * br);
    ctx.lineWidth = upx(1.6); ctx.strokeStyle = AMBER((0.35 + 0.35 * br) * wait);
    ctx.beginPath(); ctx.ellipse(g.x, g.y, R, R * (g.flat + 0.08), g.tilt, 0, 6.283); ctx.stroke();
    cloud(g.x, g.y, R * 1.15, R * 0.8, AMBER, 0.06 * wait * (0.6 + 0.4 * br));
  }
  const alert = smooth(`ualert|${s.id}`, s.alert ? 1 : 0);
  if (alert > 0.01) {
    const age = m ? uniSec(m.alertAt) : Infinity;
    if (age < 1.6) { const u = age / 1.6; ctx.lineWidth = upx(2.4 * (1 - u)); ctx.strokeStyle = ALERT(0.8 * (1 - u)); ctx.beginPath(); ctx.arc(g.x, g.y, GAL_R * (0.3 + 1.1 * ease(u)), 0, 6.283); ctx.stroke(); }
    const ax = g.x + GAL_R * 0.72, ay = g.y - GAL_R * 0.52, beat = 0.75 + 0.25 * Math.sin(sec * 3);
    cloud(ax, ay, upx(9), upx(9), ALERT, 0.35 * alert * beat);
    glowDot(ax, ay, 3, ALERT, alert * beat);
    ctx.lineWidth = upx(0.8); ctx.strokeStyle = ALERT(0.5 * alert); ctx.beginPath(); ctx.arc(ax, ay, upx(6), 0, 6.283); ctx.stroke();
  }
}
