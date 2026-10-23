'use strict';
// ?demo=universe：内置的多对话演示（PROTOCOL-v3 §10）。不连服务，按时间算出每个对话的摘要，和真实数据流发同样的消息。
// 一轮 210 秒循环播放；每轮的运行 id 带轮次，所以每轮都会重新"长出"席位。
// detail：飞进这个对话时打开的看板回放（fixtures/runs-multi 里现成的组），没有就只显示空看板。

const DEMO_T0 = Date.parse('2026-10-22T09:00:00Z'), DEMO_LEN = 210;
const DEMO_AGENTS = [
  ['gpt-6.1-sol-codex-cli', 'codex cli', 2], ['gpt-6-astra-codex-cli', 'codex cli', 4], ['gemini-4-argon-contributor', 'opencode cli', 4],
  ['deepseek-v4.1-flash', 'opencode cli', 4], ['glm-5.3-flash', 'opencode cli', 4], ['mimo-v2.6-pro-pi-cli', 'pi cli', 4], ['kimi-k2.6', 'api', 4],
];
const DEMO_MODEL = {
  'gpt-6.1-sol-codex-cli': 'gpt-6.1-sol', 'gpt-6-astra-codex-cli': 'gpt-6-astra', 'gemini-4-argon-contributor': 'opencode-go/gemini-4-argon-contributor',
  'deepseek-v4.1-flash': 'opencode-go/deepseek-v4.1-flash', 'glm-5.3-flash': 'opencode-go/glm-5.3-flash', 'mimo-v2.6-pro-pi-cli': 'xiaomi/mimo-v2.6-pro', 'kimi-k2.6': 'kimi-k2.6',
};
const DEMO_PROJECTS = [
  ['C:/demo-lab/roles', 2], ['D:/work/shop-api', 6], ['D:/work/factor-lab', 1], ['O:/sites/blog', 0],
];
// 座位：[协作方, 开始秒, 结束秒, 结束状态, 角色]
const demoSeats = (kind, group, at, list) => list.map(([agent, end, status = 'done', role = null], i) => ({ kind, group, agent, at, end, status, role, seat: i + 1 }));
const DEMO_SESSIONS = [
  { id: 'demo-roles', project: 'C:/demo-lab/roles', title: '讨论 skill 的角色分配', detail: 'replay=skills-roles-1018', age: 5400,
    think: [[0, 10], [95, 125], [185, 200]],
    runs: [
      ...demoSeats('discuss', 'skills-roles-1018', 10, [['gpt-6-astra-codex-cli', 88, 'done', '架构'], ['gemini-4-argon-contributor', 72, 'done', '用户体验'], ['deepseek-v4.1-flash', 80, 'done', '反方'], ['mimo-v2.6-pro-pi-cli', 95, 'done', '成本'], ['glm-5.3-flash', 76, 'done', '综合对照']]),
      ...demoSeats('discuss', 'skills-roles-1018', 125, [['gpt-6-astra-codex-cli', 178], ['gemini-4-argon-contributor', 162], ['deepseek-v4.1-flash', 170], ['mimo-v2.6-pro-pi-cli', 185], ['glm-5.3-flash', 166]]),
    ] },
  { id: 'demo-split', project: 'D:/work/shop-api', title: '拆分导出脚本', detail: 'replay=roles-split-1018', age: 2400,
    think: [[20, 30], [125, 140]],
    runs: demoSeats('exec', 'roles-split-1018', 30, [['gpt-6.1-sol-codex-cli', 110], ['deepseek-v4.1-flash', 125]]) },
  { id: 'demo-review', project: 'D:/work/shop-api', title: '审查缓存层改动', detail: 'replay=roles-review-1018', age: 7200,
    think: [[60, 75], [160, 180]],
    runs: demoSeats('review', 'roles-review-1018', 75, [['gpt-6-astra-codex-cli', 140], ['gemini-4-argon-contributor', 150], ['glm-5.3-flash', 160]]) },
  { id: 'demo-solo', project: 'D:/work/shop-api', title: '修复优惠券舍入', detail: 'replay=20261018-215620-solo', age: 900,
    think: [[0, 8], [70, 85]],
    runs: demoSeats('exec', null, 8, [['gpt-6.1-sol-codex-cli', 70]]) },
  { id: 'demo-mascot', project: 'O:/sites/blog', title: '首页吉祥物', age: 1800,
    think: [[15, 30], [105, 112], [175, 190]], wait: [[30, 105, '图像路线']],
    runs: demoSeats('image', null, 112, [['gpt-6.1-sol-codex-cli', 175]]) },
  { id: 'demo-factor', project: 'D:/work/factor-lab', title: '动量因子研究', age: 3600,
    think: [[0, 35], [92, 100]], queued: [[35, 60]],
    runs: demoSeats('discuss', 'factor-q-1022', 35, [['kimi-k2.6', 90, 'quota_exhausted']]) },
  { id: 'demo-readme', project: 'D:/work/factor-lab', title: '整理 README 措辞', age: 14400, last: -10800, think: [] },
  { id: 'demo-star', project: 'C:/demo-lab/roles', title: 'board 星图设计', age: 10800, think: [[5, 25], [50, 58], [140, 170]] },
  { id: 'demo-migrate', project: 'O:/sites/blog', title: '迁移评论数据', age: 6000, last: -2400, think: [] },
];

// ?copies=N：把整套场景复制 N 份（项目名加后缀、时间错开），压测几十个对话时的帧率
const DEMO_COPIES = Math.max(1, Math.min(10, Number(Q.get('copies')) || 1));
const DEMO_ALL = Array.from({ length: DEMO_COPIES }, (_, c) => c === 0 ? DEMO_SESSIONS : DEMO_SESSIONS.map((x) => ({
  ...x, id: `${x.id}~${c}`, project: `${x.project}-${c + 1}`, age: x.age + c * 600,
  think: (x.think || []).map(([a, b]) => [(a + c * 37) % DEMO_LEN, Math.min(DEMO_LEN, (a + c * 37) % DEMO_LEN + (b - a))]),
  runs: (x.runs || []).map((r) => ({ ...r, at: (r.at + c * 37) % (DEMO_LEN - 60), end: (r.at + c * 37) % (DEMO_LEN - 60) + (r.end - r.at) })),
}))).flat();
const demoProjects = () => [...new Set(DEMO_ALL.map((x) => x.project))].map((cwd) => [cwd, (DEMO_PROJECTS.find(([p]) => cwd.startsWith(p)) || [0, 0])[1]]);

const demoIn = (spans, s) => (spans || []).find(([a, b]) => s >= a && s < b);

// 第 k 轮里一个座位变成的运行（秒数换成记录时间）
function demoRun(sess, r, k) {
  const base = DEMO_T0 + k * DEMO_LEN * 1000, at = base + r.at * 1000, end = base + r.end * 1000;
  return { id: `${sess.id}-${k}-${r.at}-${r.seat}`, lane: `${sess.id}-${r.at}-${r.seat}`, kind: r.kind, agent: r.agent, model: DEMO_MODEL[r.agent],
    group: r.group, plan: r.group ? `${sess.id}-${k}-${r.at}` : null, seat: r.group ? r.seat : null, role: r.role, title: r.group ? `${r.group} #${r.seat}` : sess.title,
    status: 'running', started_at: at, ended_at: null, queued: false, _end: end, _final: r.status };
}

// 时刻 t（记录时间）的一个对话摘要
function demoSummary(sess, t) {
  const sec = (t - DEMO_T0) / 1000, k = Math.max(0, Math.floor(sec / DEMO_LEN)), s = sec - k * DEMO_LEN;
  const runs = [];
  let done = 0, failed = 0, alert = null, last = DEMO_T0 + (sess.last ?? -60) * 1000;
  for (let j = Math.max(0, k - 3); j <= k; j++) for (const r of sess.runs || []) {
    const run = demoRun(sess, r, j);
    if (run.started_at > t) continue;
    last = Math.max(last, run.started_at);
    if (run._end <= t) {
      Object.assign(run, { status: run._final, ended_at: run._end });
      last = Math.max(last, run._end);
      run._final === 'done' ? done++ : failed++;
      // 失败后用户又发过消息就不再标红；用户发消息的时刻默认是每轮第一段思考的开头
      const prompts = sess.prompts || (sess.think?.length ? [sess.think[0][0]] : []);
      const prompted = [j, j + 1].some((m) => prompts.some((a) => { const p = DEMO_T0 + (m * DEMO_LEN + a) * 1000; return p > run._end && p <= t; }));
      if (run._final !== 'done' && t - run._end < 1800000 && !prompted) alert = { kind: run._final, run: run.id, model: run.model, at: run._end };
      if (t - run._end > 600000) continue;
    } else if (j === k && demoIn(sess.queued, s)) run.queued = true;
    delete run._end; delete run._final;
    runs.push(run);
  }
  runs.sort((a, b) => b.started_at - a.started_at);
  const thinking = demoIn(sess.think, s), waiting = demoIn(sess.wait, s);
  for (const spans of [sess.think, sess.wait]) for (const [a, b] of spans || []) {
    const from = DEMO_T0 + (k * DEMO_LEN + a) * 1000;
    if (from <= t) last = Math.max(last, Math.min(t, DEMO_T0 + (k * DEMO_LEN + b) * 1000));
  }
  const running = runs.filter((r) => r.status === 'running').length;
  const state = waiting ? 'waiting' : running ? 'dispatching' : thinking ? 'thinking' : 'idle';
  const talk = (sess.think || []).reduce((n, [a, b]) => n + Math.max(0, Math.min(b, s) - a), 0) + k * 40;
  return { id: sess.id, project: sess.project.toLowerCase(), cwd: sess.project, title: sess.title, model: 'claude-opus-5-5', state,
    started_at: DEMO_T0 - sess.age * 1000, last_at: last,
    waiting: waiting ? { tool: 'AskUserQuestion', since: DEMO_T0 + (k * DEMO_LEN + waiting[0]) * 1000, header: waiting[2] } : null,
    runs: runs.slice(0, 16), counts: { running, done, failed },
    usage: { input: 900 + talk * 40, cached: 30000 + talk * 2600, cache_write: 2000 + talk * 90, output: 400 + talk * 55 },
    cost_usd: Math.round((0.4 + talk * 0.012 + done * 0.05) * 100) / 100, alert, detail: sess.detail || null };
}

function demoUniverse(t) {
  const sessions = DEMO_ALL.map((s) => demoSummary(s, t));
  const busy = new Map();
  for (const s of sessions) for (const r of s.runs) if (r.status === 'running') {
    if (!busy.has(r.agent)) busy.set(r.agent, { running: [], queued: [] });
    busy.get(r.agent).running.push({ run: r.id, session: s.id });
    if (r.queued) busy.get(r.agent).queued.push({ run: r.id, session: s.id, since: r.started_at });
  }
  const agents = DEMO_AGENTS.map(([id, type, max]) => ({ id, type, max_parallel: max, ...(busy.get(id) || { running: [], queued: [] }) }));
  const projects = demoProjects().map(([cwd, older]) => ({ key: cwd.toLowerCase(), cwd, name: cwd.split('/').pop(), older }));
  return { v: 3, now: t, window_h: 24, projects, sessions, agents };
}

// 播放：每 250 毫秒按 uNow() 重算一遍，只把变了的对话和名额发出去
function playDemo() {
  const speed = Number(B.params.speed) || 1;
  uHello({ v: 3, level: 'all', mode: 'replay', now: DEMO_T0, window_h: 24, replay: { start: DEMO_T0, end: Infinity, speed, maxgap: 0 } });
  const first = demoUniverse(uNow());
  uUniverse(first);
  const sent = new Map(first.sessions.map((s) => [s.id, JSON.stringify(s)]));
  let agents = JSON.stringify(first.agents);
  const tick = () => {
    const u = demoUniverse(uNow());
    for (const s of u.sessions) { const text = JSON.stringify(s); if (sent.get(s.id) !== text) { sent.set(s.id, text); uSession(s); } }
    const a = JSON.stringify(u.agents);
    if (a !== agents) { agents = a; uAgents({ agents: u.agents }); }
  };
  if (U.clock.frozenAt == null) setInterval(tick, 250);
}
