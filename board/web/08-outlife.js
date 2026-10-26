'use strict';
// 产出框的光效（显隐阶段见 04-life.js 的 outLife / ccLife）：
//  汇聚：框还没出现时，产出框的位置有一团光，越汇越大，周围绕着几颗小光点，粒子通道收进这团光里
//  展开：有了实际输出，一个亮框从光团里撑开到产出框的大小
//  收起：被读走时框缩成一颗大光点——席位的飞进 Claude Code 卡片；Claude Code 的在用户发下一条消息时往上飞走，
//        建了派发计划时就地化开，分成拉起席位卡的那几道光（08-life.js 的建计划动效）

const anchorOf = (box) => [box.x + 18, box.y + box.h / 2];
const clusterR = (grow) => 3 + 10 * grow;

// 一团正在汇聚的光：柔光、亮核、绕圈的小光点
function drawCluster(x, y, grow, color, seed) {
  const r = clusterR(grow) * FX.lw, sec = performance.now() / 1000, rand = rng(seed);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.8);
  g.addColorStop(0, color(0.3 + 0.2 * grow)); g.addColorStop(0.3, color(0.1 + 0.08 * grow)); g.addColorStop(1, color(0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.8, 0, 6.283); ctx.fill();
  ctx.fillStyle = HI(0.7); ctx.beginPath(); ctx.arc(x, y, r * 0.35, 0, 6.283); ctx.fill();
  for (let i = 0, n = 5 + Math.round(9 * grow); i < n; i++) {
    const ang = rand() * 6.283 + sec * (0.6 + rand() * 0.9) * (i % 2 ? 1 : -1), d = r * (0.9 + rand() * 1.6);
    glowDot(x + Math.cos(ang) * d, y + Math.sin(ang) * d * 0.7, 0.9 + rand() * 0.7, color, 0.3 + 0.35 * rand());
  }
}

// 交接：框出现时光团不一下子消失，一边淡掉一边缩进框的左边（框同时从这里长出来，04-life.js 的 outLook）
function drawHandoff(box, life, color, seed) {
  const u = clamp01(life.age / OUT_HANDOFF);
  if (u >= 1) return;
  const e = ease(u), ga = ctx.globalAlpha;
  ctx.globalAlpha = ga * (1 - e);
  drawCluster(...anchorOf(box), (life.grow ?? 0.5) * (1 - 0.7 * e), color, seed);
  ctx.globalAlpha = ga;
}

// 亮框从光团撑开到框的大小
function drawUnfold(box, age, color) {
  const u = clamp01(age / 0.5);
  if (u >= 1) return;
  const [ax, ay] = anchorOf(box), e = ease(u);
  const x = ax + (box.x - ax) * e, y = ay + (box.y - ay) * e, w = (box.w) * e, h = box.h * e;
  ctx.strokeStyle = HI(0.9 * (1 - u)); ctx.lineWidth = (2 - u) * FX.lw; ctx.strokeRect(x, y, Math.max(1, w), Math.max(1, h));
  ctx.fillStyle = color(0.25 * (1 - u)); ctx.fillRect(x, y, Math.max(1, w), Math.max(1, h));
}

// 收起：0–0.35 秒框缩成一颗大光点；之后光点沿 path 飞走（path 为空就原地化开）
function drawCollapse(box, age, color, path) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, grow = clamp01(age / 0.35);
  if (age < 0.35 || !path) {
    const fade = path ? 1 : clamp01(1 - (age - 0.35) / 0.6);
    if (fade <= 0) return;
    const r = (3 + 7 * ease(grow)) * FX.lw;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3);
    g.addColorStop(0, HI(0.95 * fade)); g.addColorStop(0.3, color(0.6 * fade)); g.addColorStop(1, color(0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 3, 0, 6.283); ctx.fill();
    return;
  }
  const u = (age - 0.35) / (OUT_COLLAPSE - 0.45);
  if (u <= 1) comet([[cx, cy], ...path.slice(1)], u, color, 4.2, 12);
  const end = path[3];
  ring(end[0], end[1], (u - 1) / 0.25 + 0.02, color, 8, 46);
}

function drawOutLife(L, P, t) {
  const ccCard = L.cc, ccIn = [ccCard.x + ccCard.w, ccCard.y + ccCard.h * 0.5];
  for (const g of L.groups) for (const lane of g.lanes) {
    const row = L.rows.get(lane.id);
    if (!row || lane.ghost || row.vis < 0.02) continue;
    const life = outLife(lane, t), color = tintOf(lane.id), box = row.out;
    ctx.globalAlpha = row.vis;
    if (life.phase === 'gather') drawCluster(...anchorOf(box), life.grow, color, lane.seed);
    else if (life.phase === 'show') { drawHandoff(box, life, color, lane.seed); drawUnfold(box, life.age, color); }
    else if (life.phase === 'collapse') {
      // 飞回 Claude Code 卡片：先往左上绕过刻度带，再落到卡片右边
      const c = [box.x + box.w / 2, box.y + box.h / 2];
      drawCollapse(box, life.age, color, [c, [box.x - 260, box.y - 120], [ccIn[0] + 320, ccIn[1] - 200], ccIn]);
    }
  }
  ctx.globalAlpha = L.ccDim; // 席位的产出框滚过来时，Claude Code 的产出框连同光效一起变暗
  const life = ccLife(t), box = L.ccOut, color = tintOf('cc');
  if (life.phase === 'gather') drawCluster(...anchorOf(box), life.grow, color, 77);
  else if (life.phase === 'show') { drawHandoff(box, life, color, 77); drawUnfold(box, life.age, color); }
  else if (life.phase === 'collapse') {
    const c = [box.x + box.w / 2, box.y + box.h / 2], top = (L.vis ? L.vis.top : 0) - 80;
    // 建计划时化成拉起席位的光、安静收起时就地散开；用户发下一条消息时往上飞走
    drawCollapse(box, life.age, color, life.kind === 'plan' || life.kind === 'quiet' ? null : [c, [c[0], c[1] - 40], [c[0] + 30, top + 60], [c[0] + 40, top]]);
  }
  ctx.globalAlpha = 1;
}

// 粒子通道收在哪里：框在时收进框的左边（整个高度），框不在时收进那团光
function outTarget(box, life) {
  if (life.phase === 'show') return { x: box.x + 2, y: box.y + box.h / 2, half: box.h / 2 - 2, box: true };
  const [x, y] = anchorOf(box);
  return { x, y, half: clusterR(life.grow || 0.3) * 0.8, box: false };
}
