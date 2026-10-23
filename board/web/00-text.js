'use strict';
// 页面上给人看的文字，中英两份。语言跟插件走：服务返回页面时按插件的 language.json 写进 window.__LANG__，默认中文。
// 模型名、文件路径、任务标题这些数据原样显示，不翻译。

const LANG = window.__LANG__ === 'en' ? 'en' : 'zh';
// 审查补漏席在计划里的角色名：中文插件写"补漏"，英文插件写"gap"
const GAP_ROLE = /^(补漏|gap)$/i;

const TEXTS = {
  zh: {
    states: { waiting: '等你确认', dispatching: '派发中', thinking: '思考中', idle: '空闲' },
    asking: (header) => `等你确认 · ${header}`,
    gapSeat: '补漏席',
    gapReady: '其他席已结束 · 等去重后启动',
    gapWaiting: '等其他席结束',
    decision: (round, c) => `决策记录 · round ${round} · ✓${c.a} ◐${c.p} ✗${c.r}`,
    hostReport: (round, head) => `Claude Code 席报告 · round ${round}${head ? ` · ${head}` : ''}`,
    hostSealed: (round) => `Claude Code 席报告 · round ${round} · 已封存`,
    hostSeat: 'Claude Code 席',
    hostSeatNote: '自己提交的报告，不计用量',
    outOfScope: (n) => `越界 ${n}`,
    outOfScopeList: (shown, n) => `越界：${shown.join(' · ')}${n > shown.length ? ` 等 ${n} 个` : ''}`,
    replayEstimate: '席位速度为回放估算',
    conversation: (title) => title ? `当前对话 · ${title}` : '当前对话',
    plan: (module, cell, seats) => `派发计划 · ${module} ${cell} · ${seats} 席`,
    gateWaiting: '外部席准入 · 等 Claude Code 席先交报告',
    gateOpen: '已开闸',
    crossCheck: (round, last) => `ROUND ${round} · 匿名成方案 A–${last} · 交叉挑错`,
    decisionWritten: '决策记录已写成',
    universe: '宇宙',
    conversations: (n) => `${n} 个对话`,
    noneSelected: (n) => `${n} 个对话 · 未选择`,
    pickHint: '在星图里点一个星系，或者在左边的列表里选一个对话，这里会显示它的终端。',
    listTitle: '对话',
    emptyList: (h) => `最近 ${h} 小时没有派发过任务的对话。派发之后会出现在这里。`,
    fold: '收起或展开',
    slotsTitle: '名额',
    shell: {
      crumb: '当前位置',
      view: '多模型协作视图：滚轮缩放，按住左键拖动，单击卡片放大，双击空白处复位',
      list: '所有对话',
      slots: '协作方并发名额',
      fit: '复位（0）',
      hintBoard: '滚轮缩放（刻度带上是滚动）· 拖动平移 · 单击卡片放大 · 双击复位',
      hintUniverse: '滚轮缩放 · 拖动平移 · 双击复位',
      more: '▾ 终端',
      moreTitle: '滚到下面的终端（在用量面板上滚动滚轮也可以）',
      terms: '终端：当前对话里各模型的终端对话',
    },
  },
  en: {
    states: { waiting: 'waiting for you', dispatching: 'dispatching', thinking: 'thinking', idle: 'idle' },
    asking: (header) => `waiting for you · ${header}`,
    gapSeat: 'gap seat',
    gapReady: 'other seats done · starts after merging',
    gapWaiting: 'waiting for the other seats',
    decision: (round, c) => `decision record · round ${round} · ✓${c.a} ◐${c.p} ✗${c.r}`,
    hostReport: (round, head) => `Claude Code seat report · round ${round}${head ? ` · ${head}` : ''}`,
    hostSealed: (round) => `Claude Code seat report · round ${round} · sealed`,
    hostSeat: 'Claude Code seat',
    hostSeatNote: 'its own report; usage not counted',
    outOfScope: (n) => `out of scope ${n}`,
    outOfScopeList: (shown, n) => `out of scope: ${shown.join(' · ')}${n > shown.length ? ` and ${n - shown.length} more` : ''}`,
    replayEstimate: 'seat rates are replay estimates',
    conversation: (title) => title ? `this conversation · ${title}` : 'this conversation',
    plan: (module, cell, seats) => `dispatch plan · ${module} ${cell} · ${seats} ${seats === 1 ? 'seat' : 'seats'}`,
    gateWaiting: 'external seats wait · Claude Code seat reports first',
    gateOpen: 'gate open',
    crossCheck: (round, last) => `ROUND ${round} · anonymized as options A–${last} · cross-check`,
    decisionWritten: 'decision record written',
    universe: 'Universe',
    conversations: (n) => `${n} ${n === 1 ? 'conversation' : 'conversations'}`,
    noneSelected: (n) => `${n} ${n === 1 ? 'conversation' : 'conversations'} · none selected`,
    pickHint: 'Click a galaxy in the star map, or pick a conversation in the list on the left, to see its terminals here.',
    listTitle: 'Conversations',
    emptyList: (h) => `No conversation has dispatched work in the last ${h} hours. New ones show up here.`,
    fold: 'Collapse or expand',
    slotsTitle: 'Slots',
    shell: {
      crumb: 'Where you are',
      view: 'Multi-model view: scroll to zoom, drag to pan, click a card to zoom in, double-click empty space to reset',
      list: 'All conversations',
      slots: 'Parallel slots per agent',
      fit: 'Reset (0)',
      hintBoard: 'Scroll to zoom (scrolls the cards over the band) · drag to pan · click a card to zoom in · double-click to reset',
      hintUniverse: 'Scroll to zoom · drag to pan · double-click to reset',
      more: '▾ Terminals',
      moreTitle: 'Scroll down to the terminals (scrolling over the usage panel works too)',
      terms: 'Terminals: each model in this conversation',
    },
  },
};
const TEXT = TEXTS[LANG];

// shell.html 里写死的中文（提示、按钮、无障碍标签）在英文插件里换掉
if (LANG !== 'zh') {
  document.documentElement.lang = 'en';
  const s = TEXT.shell, set = (sel, attr, value) => { const el = document.querySelector(sel); if (el) { if (attr) el.setAttribute(attr, value); else el.textContent = value; } };
  set('#crumb', 'aria-label', s.crumb); set('#view', 'aria-label', s.view);
  set('#ulist', 'aria-label', s.list); set('#uslots', 'aria-label', s.slots);
  set('#fit', 'title', s.fit); set('.hint.board-only', null, s.hintBoard); set('.hint.uni-only', null, s.hintUniverse);
  set('#more', null, s.more); set('#more', 'title', s.moreTitle); set('#termsec', 'aria-label', s.terms);
}
