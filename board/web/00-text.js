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
    outOfScope: (n) => `越界 ${n}`,
    outOfScopeList: (shown, n) => `越界：${shown.join(' · ')}${n > shown.length ? ` 等 ${n} 个` : ''}`,
    replayEstimate: '席位速度为回放估算',
    replayLive: '回放是调试功能，这里显示的是实时画面。要回放，请运行 board --replay <对话、任务或组>',
    focusMissing: '这个地址指向的对话不在当前星图里（超出了时间窗口或显示上限），没法飞进去',
    legacyNotFound: (kind, value) => `记录里找不到这个地址里的${kind === 'run' ? '任务' : '组'}：${value}`,
    serverLost: '连不上看板服务了（它可能已经退出，或者换了新的地址）：在 Claude Code 里运行 /foreman:watch，或者让它重新给看板链接',
    streamStuck: '连不上看板服务：可能同一个浏览器里开着很多看板标签页（关掉几个，再刷新这一页），也可能看板服务已经退出（在 Claude Code 里运行 /foreman:watch，或者让它重新给看板链接）',
    boardGone: '看板服务已经退出，这一页的链接不能再用了。在 Claude Code 里运行 /foreman:watch，或者让它重新给看板链接',
    plan: (module, cell, seats) => `派发计划 · ${module} ${cell} · ${seats} 席`,
    gateWaiting: '外部席准入 · 等 Claude Code 席先交报告',
    gateOpen: '已开闸',
    crossCheck: (round, last) => `ROUND ${round} · 匿名成方案 A–${last} · 交叉挑错`,
    decisionWritten: '决策记录已写成',
    backToUniverse: '回到所有对话（Esc）',
    conversations: (n) => `${n} 个对话`,
    costTitle: '根据模型官方 API 价格计算（插件自带的价格表），和实际扣费不一定相同；+ 表示有的模型不在价格表里，这部分没算进去',
    nowTitle: '近 10 秒的估算，可能借用同一模型之前的样本',
    recentTitle: '这条车道全部时长的速度曲线（估算）：从第一轮开始画到最后一轮结束，结束后停住；40 个点，每个点是它之前约两格时长内的输出 token 除以这段时间；运行中可能借用实时估速',
    genAvgTitle: '本席各轮累计输出 ÷ 估算的生成时长；已扣掉能识别的跑命令时段，仍可能含等待和读文件的时间',
    usageUnattributed: '用量无法归属到本轮：缺少可信的续接累计基线',
    tableAll: '展开全部 ▾',
    tableLess: '收起 ▴',
    tableAllTitle: '展开用量面板，列出这个对话里的全部模型；再点一下收起',
    emptyList: (h) => `最近 ${h} 小时没有派发过任务的对话。派发之后会出现在这里。`,
    slotsTitle: '同时运行',
    slotsHint: '每个协作方一行，一格是它能同时跑的一个任务（配置里的 max_parallel）。亮起的格子正被某个对话占着，闪烁的在服务商那边排队；点一格飞进那个对话',
    shell: {
      crumb: '当前位置',
      view: '多模型协作视图：滚轮缩放，按住左键拖动，单击卡片放大，双击空白处复位',
      slots: '各协作方正在同时运行的任务',
      fit: '复位（0）',
      hintBoard: '滚轮缩放（刻度带上是滚动）· 拖动平移 · 单击卡片放大 · 双击复位',
      hintUniverse: '滚轮缩放 · 拖动平移 · 双击复位',
      more: '▾ 终端',
      moreTitle: '滚到下面的终端（在用量面板上滚到底后继续滚动也可以）',
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
    outOfScope: (n) => `out of scope ${n}`,
    outOfScopeList: (shown, n) => `out of scope: ${shown.join(' · ')}${n > shown.length ? ` and ${n - shown.length} more` : ''}`,
    replayEstimate: 'seat rates are replay estimates',
    replayLive: 'Replay is a debugging tool; this page shows live data. To replay, run board --replay <conversation, run or group>',
    focusMissing: "The conversation this link points to isn't on the current map (outside the time window or the display limit), so the page can't fly into it",
    legacyNotFound: (kind, value) => `No records were found for the ${kind === 'run' ? 'run' : 'group'} in this link: ${value}`,
    serverLost: 'Lost the connection to the board server (it may have exited or moved to a new address): run /foreman-en:watch in Claude Code, or ask it for the board link again',
    streamStuck: "Can't reach the board service: too many board tabs may be open in this browser (close a few, then reload this page), or the board service may have exited (run /foreman-en:watch in Claude Code, or ask it for the board link again)",
    boardGone: "The board service has exited and this page's link no longer works. Run /foreman-en:watch in Claude Code or ask it for the board link again",
    plan: (module, cell, seats) => `dispatch plan · ${module} ${cell} · ${seats} ${seats === 1 ? 'seat' : 'seats'}`,
    gateWaiting: 'external seats wait · Claude Code seat reports first',
    gateOpen: 'gate open',
    crossCheck: (round, last) => `ROUND ${round} · anonymized as options A–${last} · cross-check`,
    decisionWritten: 'decision record written',
    backToUniverse: 'Back to all conversations (Esc)',
    conversations: (n) => `${n} ${n === 1 ? 'conversation' : 'conversations'}`,
    costTitle: "Computed from each model's official API price (the plugin's price table); may differ from what you're actually charged. + means some models aren't in the table and weren't counted",
    nowTitle: 'Estimate over the last 10 seconds; may borrow earlier samples of the same model',
    recentTitle: "Speed over this lane's whole time (estimated): drawn from its first round's start to its last round's end, then it stays put; 40 points, each the output tokens in about two points' worth of time before it divided by that time; while running it may use the live estimate",
    genAvgTitle: "This seat's total output ÷ estimated generation time; command time that can be recognised is excluded, waiting and file reads may remain",
    usageUnattributed: 'Usage cannot be attributed to this run: a reliable continuation baseline is missing',
    tableAll: 'Show all ▾',
    tableLess: 'Collapse ▴',
    tableAllTitle: 'Expand the usage panel to list every model in this conversation; click again to collapse',
    emptyList: (h) => `No conversation has dispatched work in the last ${h} hours. New ones show up here.`,
    slotsTitle: 'Running now',
    slotsHint: 'One row per agent; each cell is one run it can have going at once (max_parallel in the config). Lit cells are taken by a conversation, blinking ones wait in the provider queue; click a cell to fly into that conversation',
    shell: {
      crumb: 'Where you are',
      view: 'Multi-model view: scroll to zoom, drag to pan, click a card to zoom in, double-click empty space to reset',
      slots: 'Runs going on now, per agent',
      fit: 'Reset (0)',
      hintBoard: 'Scroll to zoom (scrolls the cards over the band) · drag to pan · click a card to zoom in · double-click to reset',
      hintUniverse: 'Scroll to zoom · drag to pan · double-click to reset',
      more: '▾ Terminals',
      moreTitle: 'Scroll down to the terminals (or keep scrolling past the end of the usage panel)',
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
  set('#uslots', 'aria-label', s.slots);
  set('#fit', 'title', s.fit); set('.hint.board-only', null, s.hintBoard); set('.hint.uni-only', null, s.hintUniverse);
  set('#more', null, s.more); set('#more', 'title', s.moreTitle); set('#termsec', 'aria-label', s.terms);
}
