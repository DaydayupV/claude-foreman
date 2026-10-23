'use strict';
// 车道事件 → 对话流的行，照 watch 的时间线：模型说的话是节点（◆），读、搜、改、命令挂在竖线下面，
// 两句话之间超过 3 个动作折叠成一行；最新的思考单独放在卡片底行。

const MAX_ACTIONS = 3;
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || String(p || '');
const EDIT_MARKS = { update: '✎', write: '✎', add: '+', delete: '−' };

function editParts(t) {
  const m = /^(\w+)\s+(.*)$/.exec(String(t || ''));
  return m ? { kind: m[1], path: m[2] } : { kind: 'update', path: String(t || '') };
}

const laneModel = (id) => { const l = B.laneById.get(id); const r = l && l.runs[l.runs.length - 1]; return r ? shortModel(r.model) : id; };
const shortModel = (m) => String(m || '').split('/').pop();

// 一条事件写成一行；返回 null 的事件不进对话流（用量、请求、开始这类）
function lineOf(ev) {
  const t = ev.t || '';
  switch (ev.k) {
    case 'prompt': return { cls: 'user', text: t };
    case 'msg': return { cls: 'node', text: t };
    case 'report': return { cls: 'node', text: `report · ${ev.n ? `${ev.n} chars` : 'submitted'}` };
    case 'end': return { cls: ev.t === 'done' ? 'node' : 'node bad', text: `finished · ${t}` };
    case 'cmd': return { cls: 'act', text: `$ ${t}`, cmd: true };
    case 'read': return { cls: 'act', text: `▸ ${t}` };
    case 'search': return { cls: 'act', text: `⌕ ${t}` };
    case 'web': return { cls: 'act', text: `⌁ ${t}` };
    case 'edit': { const e = editParts(t); return { cls: 'act', text: `${EDIT_MARKS[e.kind] || '✎'} ${e.path}` }; }
    case 'plan': return { cls: 'act', text: `plan ${t}` };
    case 'image': return { cls: 'act', text: `▣ ${t}` };
    case 'queued': return { cls: 'act', text: '… queued at provider' };
    case 'retry': return { cls: 'act bad', text: `↻ retry ${t}` };
    case 'error': return { cls: 'act bad', text: `✗ ${t}` };
    case 'tool': return { cls: 'act', text: `· ${t}` };
    case 'dispatch': return { cls: 'act link', text: `⇢ ${t}${targets(ev)}` };
    case 'collect': return { cls: 'act link', text: `⇠ ${t || 'read results'}${targets(ev)}` };
    case 'returned': return { cls: 'act link', text: `⇠ result back${targets(ev)}` };
    default: return null;
  }
}
const targets = (ev) => (ev.target && ev.target.length ? ` → ${ev.target.map(laneModel).join(', ')}` : '');

// 对话流：到时刻 t 为止的行。open 为真时返回全部，否则只要最后 limit 行。
function timeline(lane, t, { open = false, limit = 6 } = {}) {
  const lines = [];
  let block = [], lastCmd = null;
  const flush = (closed) => {
    if (block.length > MAX_ACTIONS + 1) {
      const hidden = block.length - MAX_ACTIONS;
      // 已经过去的一段留前几条（和 watch 一样），正在进行的一段留最新几条
      const kept = closed ? block.slice(0, MAX_ACTIONS) : block.slice(-MAX_ACTIONS);
      const fold = { cls: 'act fold', text: `… +${hidden} ${hidden === 1 ? 'action' : 'actions'}` };
      lines.push(...(closed ? [...kept, fold] : [fold, ...kept]));
    } else lines.push(...block);
    block = [];
  };
  for (const ev of lane.events) {
    if (ev.ts > t) break;
    if (ev.k === 'cmd_done') { if (lastCmd && ev.ok === false) { lastCmd.text += '  ✗'; lastCmd.cls += ' bad'; } continue; }
    const line = lineOf(ev);
    if (!line) continue;
    line.ts = ev.ts;
    if (line.cmd) lastCmd = line;
    if (line.cls.startsWith('act')) block.push(line);
    else { flush(true); lines.push(line); }
  }
  flush(false);
  return open ? lines : lines.slice(-limit);
}

// 卡片底行：最新的思考或正在写的回答，过了 90 秒（记录时间）就不再显示
function thinkingLine(lane, t) {
  for (let i = lane.events.length - 1; i >= 0; i--) {
    const ev = lane.events[i];
    if (ev.ts > t) continue;
    if (t - ev.ts > 90000) return '';
    if (ev.k === 'think') return ev.t ? `✻ ${ev.t}` : '✻ thinking…';
    if (ev.k === 'answer') return `✎ writing answer · ${ev.n || 0} chars`;
    if (ev.k === 'msg' || ev.k === 'end' || ev.k === 'report') return '';
  }
  return '';
}
