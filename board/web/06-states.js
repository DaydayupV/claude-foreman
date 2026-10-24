'use strict';
// 模块状态在卡片上的表现（G 步）：
//  Claude Code 在等你确认（弹窗出来到被回答之间）：卡片外一圈琥珀色呼吸光，卡片上方写弹窗标题；
//  席位排队等服务：琥珀色虚线边框闪烁（绕卡片转的光点在 08-states.js 画）；
//  被取消：整张卡褪成灰色；失败、额度用完、卡死、中断：红色边框（结束那一刻的红色冲击波在 08-states.js 画）；
//  执行任务：输出框第一行写它负责改的路径，改到范围外的文件时状态行标"越界 N"。

// 时刻 t 时 Claude Code 是否在等你回答弹窗：最近一条 ask 后面还没有 ask_done
function askAt(lane, t) {
  if (!lane || lane.id !== 'cc') return null;
  for (let i = lane.events.length - 1; i >= 0; i--) {
    const ev = lane.events[i];
    if (ev.ts > t) continue;
    if (ev.k === 'ask_done') return null;
    if (ev.k === 'ask') return ev;
  }
  return null;
}

// 运行在时刻 t 的处境：还没开始 null；在跑 running；排队等服务 queued；结束后 done / cancelled / failed。
// 排队看事件：最近一条有意义的事件是 queued 就还在排（回放里 run 消息的 queued 标记只反映结尾）
function fateAt(lane, r, t) {
  if (!r || r.started_at > t) return null;
  if (r.ended_at != null && r.ended_at <= t) {
    const kind = seatStatus(lane, r, t).kind;
    return ['ok', 'partial', 'blocked', 'resumed'].includes(kind) ? kind === 'ok' ? 'done' : kind : r.status === 'cancelled' ? 'cancelled' : 'failed';
  }
  for (let i = lane.events.length - 1; i >= 0; i--) {
    const ev = lane.events[i];
    if (ev.run !== r.id || ev.ts > t || ev.k === 'usage') continue;
    return ev.k === 'queued' ? 'queued' : 'running';
  }
  return r.queued ? 'queued' : 'running';
}

// 改到写入范围外的文件：进行中按编辑事件判断（相对工作目录的路径；绝对路径的改动不判断），
// 结束以后再加上结果里写到工作目录外、又不在范围里的文件（和终端 ⚠ 行同一份清单）
const scopePath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
function outOfScope(lane, r, t) {
  if (!r) return [];
  const run = r.ended_at != null && r.ended_at <= t && r.display ? Display.displayRun(r) : null;
  const out = new Set(run ? Display.outsideFiles(run.result, run.meta) : []);
  if (!r.scope?.length) return [...out];
  const scope = r.scope.map(scopePath);
  for (const ev of lane.events) {
    if (ev.run !== r.id || ev.k !== 'edit' || ev.ts > t) continue;
    // 比较时不分大小写，显示时用原样的路径
    const raw = String(ev.t).replace(/^\w+ /, '').replace(/\\/g, '/').replace(/^\.\//, ''), p = scopePath(raw);
    if (/^[a-z]:\//.test(p) || p.startsWith('/')) continue;
    if (!scope.some((s) => p === s || p.startsWith(`${s}/`))) out.add(raw);
  }
  return [...out];
}

// fillCard 之后调用：状态写成类名（样式表画边框和颜色），越界数接在状态行后面
function decorateCard(el, lane, t) {
  if (lane.id === 'cc') {
    const ask = askAt(lane, t);
    el.classList.toggle('asking', !!ask);
    const label = ask ? TEXT.asking(ask.t) : '';
    if ((el.dataset.ask || '') !== label) { if (label) el.dataset.ask = label; else delete el.dataset.ask; }
    return;
  }
  const live = lane.runs.filter((x) => x.started_at <= t && x.kind !== 'answer'), r = live[live.length - 1];
  const fate = fateAt(lane, r, t);
  for (const c of ['queued', 'cancelled', 'failed', 'partial', 'blocked', 'resumed']) el.classList.toggle(c, fate === c);
  // 改到范围外的文件：状态行最前面一个琥珀色的 ⚠N（和终端的 ⚠ 同色；放在前面，卡片窄时不会被行尾的省略号吃掉），
  // 状态本身的颜色不变；悬停写明越界几个、是哪些文件
  const files = outOfScope(lane, r, t), st = el.querySelector('.st'), over = files.length ? String(files.length) : '';
  if ((st.dataset.over || '') !== over) { if (over) st.dataset.over = over; else delete st.dataset.over; }
  st.title = files.length ? TEXT.outOfScopeList(files.slice(0, 5), files.length) : '';
}

// 补漏席（计划里角色写"补漏"的席位）还没启动时在等什么：其他席还在跑 waiting；都结束了 ready；不是补漏席 null
function gapState(lane, t) {
  if (!lane.ghost || !GAP_ROLE.test(lane.seat?.role || '')) return null;
  const p = plansAt(t).find((x) => x.id === lane.plan), others = p ? p.runs.filter((r) => r.seat !== lane.seat.seat && r.started_at <= t) : [];
  return others.length && others.every((r) => r.ended_at != null && r.ended_at <= t) ? 'ready' : 'waiting';
}

// 输出框第一行：执行任务负责改的路径（并发拆分时各份互不重叠）
function scopeLead(lane, t) {
  const live = lane.runs.filter((x) => x.started_at <= t && x.kind !== 'answer'), r = live[live.length - 1];
  if (!r || r.kind !== 'exec' || !r.scope?.length) return [];
  const names = r.scope.map((p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/').slice(-2).join('/'));
  const over = outOfScope(lane, r, t);
  return [`✎ ${names.join(' · ')}`, ...(over.length ? [TEXT.outOfScopeList(over.slice(0, 2), over.length)] : [])];
}
