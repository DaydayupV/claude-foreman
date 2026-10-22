// watch 的启动动画：新派出的对话第一次打开实时查看时，先放几秒模型的像素头像和"正在启动"，再进入时间线。
// 头像用半块字符 ▀▄ 画，一格上下两个像素，整屏铺深色底，深浅主题看起来一样。
import { AVATARS, AVATAR_ALPHABET } from './watch-avatars.mjs';
import { M, textWidth, wrapWidth } from './util.mjs';

// ---- 头像怎么认：在模型名里找关键字，不区分大小写；先看最后一段（opencode/glm-5.3 看 glm-5.3），
// 找不到再看整串（moonshotai-cn/…）；同时命中几个时取最先出现的（deepseek-r1-distill-qwen 认成 DeepSeek）。
const AVATAR_RULES = [
  ['claude', /claude|sonnet|opus|haiku|anthropic/],
  ['chatgpt', /gpt|codex|openai|(?:^|[^a-z0-9])o\d/],
  ['gemini', /gemini|gemma/],
  ['deepseek', /deepseek/],
  ['mimo', /mimo|xiaomi/],
  ['glm', /glm|zhipu/],
  ['kimi', /kimi|moonshot/],
  ['qwen', /qwen|qwq|qvq/],
  ['minimax', /minimax|abab/],
  ['grok', /grok|x-?ai/],
];
function avatarFor(modelName, agentType) {
  const name = String(modelName || '').toLowerCase();
  for (const part of [name.split('/').pop(), name]) {
    let best = null;
    for (const [key, re] of AVATAR_RULES) {
      const m = re.exec(part);
      if (m && (!best || m.index < best.at)) best = { key, at: m.index };
    }
    if (best) return best.key;
  }
  // 没有模型名：Codex 两边都没配模型时用的是 OpenAI 的模型
  return !name && agentType === 'codex cli' ? 'chatgpt' : 'unknown';
}

// 名牌、主题色、笑话里的简称
const LOOKS = {
  claude: { name: 'Claude', color: [232, 118, 64] },
  chatgpt: { name: 'ChatGPT', short: 'GPT', color: [236, 236, 236] },
  gemini: { name: 'Gemini', color: [96, 156, 250] },
  deepseek: { name: 'DeepSeek', color: [92, 120, 254] },
  mimo: { name: 'MiMo', color: [245, 140, 50] },
  glm: { name: 'GLM', color: [128, 104, 236] },
  kimi: { name: 'Kimi', color: [110, 170, 250] },
  qwen: { name: 'Qwen', color: [140, 116, 246] },
  minimax: { name: 'MiniMax', color: [240, 84, 84] },
  grok: { name: 'Grok', color: [236, 208, 140] },
  unknown: { name: '???', color: [150, 150, 150] },
};
const decoded = new Map();
function pixels(key, size) {
  const id = `${key}:${size}`;
  if (!decoded.has(id)) {
    const { palette, rows } = AVATARS[key][size];
    const rgb = palette.map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));
    decoded.set(id, rows.map((r) => [...r].map((ch) => (ch === '.' ? null : rgb[AVATAR_ALPHABET.indexOf(ch)]))));
  }
  return decoded.get(id);
}

// ---- 场景：谁出场、放多久、讲哪几句笑话 ----
const INTRO_MS = { single: 5000, discuss: 10000 };
const shuffle = (a, random) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// participants：[{ key, model, who }]，who 是"模型（接入方式，effort …）"。
// 单个任务时 Claude 作为派活的人站在左边；组（讨论、并行的任务组）只画参与方，人数可能在播放中变多。
// 同一个头像出场两次以上（组里两个同系列的模型，或者 Claude Code 派活给 Claude 系列的模型）时，后来的是分身：
// 画成镜像，名牌带"分身"，第一句笑话讲分身。???（认不出的模型）彼此不一定同系列，不算分身。
function introScene({ mode, kind, participants, group = false, random = Math.random }) {
  const pool = M.introJokes[kind === 'discuss' ? 'discuss' : mode === 'review' ? 'review' : 'run'];
  const shortName = (p) => (p.key === 'unknown' ? p.model : LOOKS[p.key].short || LOOKS[p.key].name);
  const fill = (s, p = participants[Math.floor(random() * participants.length)]) => s.replaceAll('{n}', shortName(p)).replaceAll('{m}', p.model);
  const lineup = [...(group ? [] : [{ key: 'claude', model: 'claude' }]), ...participants];
  const twin = lineup.find((p, i) => p.key !== 'unknown' && lineup.findIndex((q) => q.key === p.key) < i);
  // 同一个模型来了几席，它的笑话只放一次；写代码的笑话只在执行任务里用
  const keys = [...new Set(participants.map((p) => p.key))];
  const modelJokes = keys.flatMap((k) => [...(M.introModelJokes[k] || []), ...(kind === 'exec' ? M.introModelRunJokes?.[k] || [] : [])]);
  const jokes = shuffle([...pool, ...modelJokes], random).slice(0, twin ? 5 : 6).map((s) => fill(s));
  if (twin) jokes.unshift(fill(M.introCloneJokes[Math.floor(random() * M.introCloneJokes.length)], twin));
  return { kind, mode, participants, group, host: !group, jokes, duration: kind === 'discuss' ? INTRO_MS.discuss : INTRO_MS.single };
}
// 每个出场位置是第几个分身：本体是 0
const cloneIndex = (keys) => keys.map((k, i) => (k === 'unknown' ? 0 : keys.slice(0, i).filter((x) => x === k).length));
// 名牌：左边派活的写 Claude Code；参加任务的 Claude 系列模型照常写 Claude
const tagOf = (k, nth, host = false) => (host ? 'Claude Code' : nth ? M.introClone(LOOKS[k].name, nth) : LOOKS[k].name);

// ---- 屏幕缓冲：每格 { ch, fg, bold }，底色统一 ----
const BG = [16, 16, 22], GRAY = [200, 200, 200], DIM = [110, 110, 110], TRACK = [60, 60, 60];
// 颜色默认用 24 位色。macOS 自带的终端旧版不支持 24 位色，它没声明支持（COLORTERM）时改用最接近的 256 色
const supportsTruecolor = (env = process.env) => env.TERM_PROGRAM !== 'Apple_Terminal' || /truecolor|24bit/i.test(env.COLORTERM || '');
const CUBE = [0, 95, 135, 175, 215, 255];
function to256([r, g, b]) {
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const cube = [q(r), q(g), q(b)], gi = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10))), gv = 8 + gi * 10;
  const dist = (c) => (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
  return dist(cube.map((i) => CUBE[i])) <= dist([gv, gv, gv]) ? 16 + 36 * cube[0] + 6 * cube[1] + cube[2] : 232 + gi; // 6×6×6 色块和 24 级灰里挑近的
}
const color = (layer, c, deep) => (deep ? `${layer};2;${c.join(';')}` : `${layer};5;${to256(c)}`);
const bgSgr = (deep) => `\x1b[0;${color(48, BG, deep)}m`;
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const dim = (c, f) => c.map((v) => Math.round(v * f));
const charW = (ch) => textWidth(ch);
function put(buf, x, y, text, fg, bold = false) {
  if (y < 0 || y >= buf.length) return;
  for (const ch of text) {
    const w = charW(ch);
    if (x >= 0 && x + w <= buf[y].length) { buf[y][x] = { ch, fg, bg: null, bold }; if (w === 2) buf[y][x + 1] = { ch: '' }; }
    x += w;
  }
}
function serialize(row, deep) {
  let s = '', cur = '';
  for (const c of row) {
    if (c.ch === '') continue;
    const sgr = `0;${c.bold ? '1;' : ''}${c.fg ? color(38, c.fg, deep) : '39'};${color(48, c.bg || BG, deep)}`;
    if (sgr !== cur) { s += `\x1b[${sgr}m`; cur = sgr; }
    s += c.ch;
  }
  return `${s}${bgSgr(deep)}\x1b[K\x1b[0m`; // 用深色擦到行尾：最后一列不写字，也就不会触发换行
}
const rowsOf = (g) => Math.ceil(g.length / 2);
// reveal：已经扫出来的像素行数，正在扫的那一行加亮；bob：整体下移 1 像素（底边一行被裁掉）
function drawAvatar(buf, x0, y0, g, { reveal, bob, fade }) {
  const pix = (j, i) => { const jj = j - bob; return jj < 0 || jj >= g.length || j >= reveal ? null : g[jj][i]; };
  const look = (j, i) => { const p = pix(j, i); return p && dim(j === Math.floor(reveal) - 1 ? mix(p, [255, 255, 255], 0.6) : p, fade); };
  for (let r = 0; r < rowsOf(g); r++) for (let i = 0; i < g[0].length; i++) {
    const y = y0 + r, x = x0 + i;
    if (!buf[y] || x < 0 || x >= buf[y].length) continue;
    const top = look(2 * r, i), bottom = look(2 * r + 1, i);
    if (top) buf[y][x] = { ch: '▀', fg: top, bg: bottom };
    else if (bottom) buf[y][x] = { ch: '▄', fg: bottom, bg: null };
  }
}

// ---- 排版：按终端大小挑能放下的最大尺寸；below 是头像下面要占的行数 ----
// 依次试：大头像加左边的 Claude、只画大头像、中头像加 Claude、只画中头像；多位放不下时一位一位轮流登场；都不行用文字徽章
function introLayout(scene, Wd, H, below) {
  const keys = (host) => [...(host ? ['claude'] : []), ...scene.participants.map((p) => p.key)];
  const fits = (size, ks, host) => {
    const width = ks.reduce((a, k) => a + pixels(k, size)[0].length, 0) + (host ? 14 : 0) + 3 * Math.max(0, ks.length - 1 - (host ? 1 : 0));
    return width <= Wd - 1 && Math.max(...ks.map((k) => rowsOf(pixels(k, size)))) + below <= H;
  };
  for (const size of ['L', 'M']) {
    if (scene.host && fits(size, keys(true), true)) return { size, host: true, flip: false };
    if (fits(size, keys(false), false)) return { size, host: false, flip: false };
  }
  if (scene.participants.length > 1) for (const size of ['L', 'M']) if (fits(size, [scene.participants[0].key], false)) return { size, host: false, flip: true };
  return { size: 'T', host: scene.host, flip: false };
}
// 文字模式的徽章：一行放不下就换行
function badgeRows(keys, nths, Wd, host = false) {
  const rows = [];
  let row = [], rw = 0;
  keys.forEach((k, i) => {
    const name = tagOf(k, nths[i], host && i === 0), w = Math.min(textWidth(name) + 8, Wd);
    if (row.length && rw + 2 + w > Wd) { rows.push(row); row = []; rw = 0; }
    rw += (row.length ? 2 : 0) + w;
    row.push({ k, w, name });
  });
  if (row.length) rows.push(row);
  return rows;
}

// ---- 画一帧：返回每一行（带颜色控制符）。state 里有场景、是否已结束、星星；W、H 是终端大小 ----
const JOKE_AT = 800;
function introFrame(state, t, W, H) {
  const deep = state.truecolor !== false;
  if (W < 12 || H < 6) return Array.from({ length: H }, () => `${bgSgr(deep)}\x1b[K\x1b[0m`); // 窄得画不下任何东西：只铺底色
  const { scene } = state, D = scene.duration, Wd = W - 1; // 最后一列不画
  const fade = t > state.end - 600 ? Math.max(0, (state.end - t) / 600) : 1;
  const main = scene.participants[0], theme = LOOKS[main.key].color, accent = scene.host ? LOOKS.claude.color : theme;
  const center = (s) => Math.max(0, (Wd - textWidth(s)) >> 1);
  const buf = Array.from({ length: H }, () => Array.from({ length: Wd }, () => ({ ch: ' ', fg: null, bg: null })));

  // 先排文字区：启动信息、笑话、进度条按宽度折行，行数固定下来，画面不会上下跳
  const tw = Wd - 2, spin = SPIN[Math.floor(t / 80) % SPIN.length];
  // 同一个模型占了几席时只列一次，写成"模型 ×2"
  const counts = new Map();
  for (const p of scene.participants) counts.set(p.model, (counts.get(p.model) || 0) + 1);
  const models = [...counts].map(([m, n]) => (n > 1 ? `${m} ×${n}` : m));
  const many = scene.kind === 'discuss' ? M.introGathering : M.introDispatching;
  const what = scene.group ? many(scene.participants.length, models) : M.introStarting(main.who);
  let status = wrapWidth(`${spin} ${what}`, tw);
  if (status.length > 3) status = wrapWidth(`${spin} ${many(scene.participants.length, null)}`, tw);
  const jokeRows = Math.max(...[...scene.jokes, M.introDone].map((j) => wrapWidth(j, tw).length));
  const longest = `  ${M.introCountdown(10)}`, barOne = Wd >= 12 + textWidth(longest);
  const tail = state.finished ? M.introEnded : M.introCountdown(Math.max(0, Math.ceil((D - t) / 1000)));
  const textH = status.length + jokeRows + (barOne ? 1 : 1 + wrapWidth(longest.trim(), tw).length);

  const L = introLayout(scene, Wd, H, 2 + textH);
  const slot = (D - 900) / scene.participants.length;
  const cur = L.flip ? Math.min(scene.participants.length - 1, Math.floor(Math.max(0, t - 300) / slot)) : 0;
  // 分身按整个出场名单数（轮流登场时也一样），再挑出这一帧画的几位
  const allKeys = [...(L.host ? ['claude'] : []), ...scene.participants.map((p) => p.key)], allNths = cloneIndex(allKeys);
  const shown = L.flip ? [...(L.host ? [0] : []), (L.host ? 1 : 0) + cur] : allKeys.map((_, i) => i);
  const keys = shown.map((i) => allKeys[i]), nths = shown.map((i) => allNths[i]);
  let textY;
  if (L.size === 'T') {
    const rows = badgeRows(keys, nths, Wd, L.host), top = Math.max(0, (H - (rows.length * 3 + 1 + textH)) >> 1);
    rows.forEach((row, r) => {
      let x = Math.max(0, (Wd - row.reduce((a, b) => a + b.w, 0) - 2 * (row.length - 1)) >> 1);
      for (const b of row) {
        const c = dim(LOOKS[b.k].color, fade * Math.min(1, t / 400)), y = top + r * 3, name = b.name;
        put(buf, x, y, `╭${'─'.repeat(b.w - 2)}╮`, c);
        put(buf, x, y + 1, '│', c);
        put(buf, x + b.w - 1, y + 1, '│', c);
        put(buf, x, y + 2, `╰${'─'.repeat(b.w - 2)}╯`, c);
        put(buf, x + Math.max(1, (b.w - textWidth(name)) >> 1), y + 1, name, c, true);
        x += b.w + 2;
      }
    });
    textY = top + rows.length * 3 + 1;
  } else {
    const gs = keys.map((k, i) => (nths[i] ? pixels(k, L.size).map((r) => [...r].reverse()) : pixels(k, L.size))), avH = Math.max(...gs.map(rowsOf)), items = [];
    const total = gs.reduce((a, g) => a + g[0].length, 0) + (L.host ? 14 : 0) + 3 * Math.max(0, keys.length - 1 - (L.host ? 1 : 0));
    const top = Math.max(0, (H - (avH + 2 + textH)) >> 1);
    let x = Math.max(0, (Wd - total) >> 1);
    keys.forEach((k, i) => {
      const g = gs[i], isHost = L.host && i === 0;
      const born = isHost ? 0 : L.flip ? 300 + cur * slot : L.host ? 350 : 150 * i; // 什么时候开始扫出来
      const reveal = Math.max(0, (t - born) / 650) * g.length;
      const bob = reveal > g.length && Math.floor((t - born) / 700) % 2 === 1 ? 1 : 0; // 扫完后每 0.7 秒上下浮动一次
      drawAvatar(buf, x, top + avH - rowsOf(g), g, { reveal, bob, fade });
      items.push({ k, x, w: g[0].length, born, isHost, tag: tagOf(k, nths[i], isHost) });
      x += g[0].length + (isHost ? 14 : 3);
    });
    // Claude 和目标之间：一串光点从 Claude 飞向目标
    if (L.host && t > 500) {
      const ax = items[0].x + items[0].w + 2, len = 10, ay = top + (avH >> 1), head = ((t - 500) / 45) % (len + 6);
      for (let k = 0; k < len; k++) {
        const d = head - k, c = mix(LOOKS.claude.color, LOOKS[keys[1]].color, k / (len - 1)), lit = d >= 0 && d < 4;
        put(buf, ax + k, ay, d >= 0 && d < 1 ? '▶' : lit ? '━' : '·', dim(lit ? c : dim(c, 0.35), fade));
      }
    }
    // 星星：在头像周围的空白处一闪一闪
    if (t - state.lastSpark > 220 && fade === 1) {
      state.lastSpark = t;
      const it = items[Math.floor(state.random() * items.length)];
      state.sparks.push({ x: it.x - 2 + Math.floor(state.random() * (it.w + 4)), y: top + Math.floor(state.random() * avH), t, c: LOOKS[it.k].color });
      state.sparks = state.sparks.filter((s) => t - s.t < 900);
    }
    for (const s of state.sparks) {
      const age = (t - s.t) / 900, cell = buf[s.y]?.[s.x];
      if (age > 1 || !cell || cell.ch !== ' ') continue;
      put(buf, s.x, s.y, age < 0.2 || age > 0.8 ? '·' : age < 0.35 || age > 0.65 ? '✧' : '✦', dim(s.c, fade * (1 - Math.abs(age - 0.5))));
    }
    // 名牌：头像扫出来以后逐字打出来
    for (const it of items) {
      const text = `${it.tag}${L.flip && !it.isHost ? `  ${cur + 1}/${scene.participants.length}` : ''}`;
      const n = Math.max(0, Math.floor((t - it.born - 650) / 60));
      put(buf, it.x + Math.max(0, (it.w - textWidth(text)) >> 1), top + avH, [...text].slice(0, n).join(''), dim(LOOKS[it.k].color, fade), true);
    }
    textY = top + avH + 2;
  }

  // 文字区：启动信息、笑话（打字机效果，每条 1.5 秒，讨论 1.8 秒）、进度条和倒计时
  status.forEach((l, i) => put(buf, center(l), textY + i, l, dim(GRAY, fade)));
  let y = textY + status.length;
  if (state.finished) wrapWidth(M.introDone, tw).forEach((l, i) => put(buf, center(l), y + i, l, dim(GRAY, fade)));
  else if (t > JOKE_AT) {
    const every = scene.kind === 'discuss' ? 1800 : 1500;
    const ji = Math.min(scene.jokes.length - 1, Math.floor((t - JOKE_AT) / every));
    let typed = Math.floor((t - JOKE_AT - ji * every) / 35);
    wrapWidth(scene.jokes[ji], tw).forEach((l, i) => {
      const chars = [...l];
      put(buf, center(l), y + i, chars.slice(0, Math.max(0, typed)).join(''), dim(accent, fade));
      typed -= chars.length;
    });
  }
  y += jokeRows;
  const bw = barOne ? Math.min(40, Wd - textWidth(longest) - 2) : Math.max(4, Math.min(40, Wd - 2));
  const filled = Math.round(bw * (state.finished ? 1 : Math.min(1, t / D)));
  const bx = barOne ? center(`${'x'.repeat(bw)}  ${tail}`) : center('x'.repeat(bw));
  for (let k = 0; k < bw; k++) put(buf, bx + k, y, k < filled ? '━' : '─', dim(k < filled ? mix(accent, theme, k / bw) : TRACK, fade));
  if (barOne) put(buf, bx + bw + 2, y, tail, dim(DIM, fade));
  else wrapWidth(tail, tw).forEach((l, i) => put(buf, center(l), y + 1 + i, l, dim(DIM, fade)));
  return buf.map((row) => serialize(row, deep));
}
const introState = (scene, random = Math.random, truecolor = supportsTruecolor()) => ({ scene, random, truecolor, end: scene.duration, finished: false, sparks: [], lastSpark: 0 });

// ---- 播放：画在备用屏幕里，任意键跳过，任务提前结束就马上收尾 ----
// isOver()：任务是不是已经结束；refresh()：组里有新登记的任务时返回新的出场名单。
// keepScreen：之后的画面也用备用屏幕（实时时间线、组面板）时不退出，免得中间闪一下原来的屏幕。
// 这时返回一个交接函数：接手的画面起来了（或者调用方自己退出了备用屏幕）再调用它，摘掉退出时恢复终端的钩子；
// 在那之前进程退出，钩子会把终端恢复。只能恢复一次：已经回到普通屏幕时再发 ?1049l，光标会跳回动画开始前的位置。
const RESTORE = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
const lineup = (list) => list.map((p) => `${p.key}:${p.model}`).join('|');
function playIntro(scene, { out = process.stdout, input = process.stdin, isOver = () => false, refresh = null, keepScreen = false } = {}) {
  return new Promise((resolve) => {
    const state = introState(scene), start = Date.now();
    let prev = [], frame = 0, repaintUntil = 0, skipped = false;
    const restore = () => out.write(RESTORE);
    const handOff = () => process.off('exit', restore);
    // Ctrl+C：raw mode 下是按键 \x03；stdin 不是终端或外部发来的是 SIGINT / SIGTERM。都先恢复终端再退出
    const quit = () => { cleanup(); handOff(); restore(); process.exit(130); };
    const onKey = (d) => {
      if (d.toString().includes('\x03')) quit();
      if (!skipped) { skipped = true; state.end = Math.min(state.end, Date.now() - start + 300); }
    };
    // ConPTY 在窗口变化后会自己重绘一遍，可能弄乱画面：之后 0.7 秒内每帧整屏重画
    const onResize = () => { repaintUntil = Date.now() + 700; };
    const raw = input?.isTTY;
    if (raw) { input.setRawMode(true); input.resume(); input.on('data', onKey); }
    out.on?.('resize', onResize);
    process.on('exit', restore);
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    out.write(`\x1b[?1049h\x1b[?25l\x1b[?7l${bgSgr(state.truecolor)}\x1b[2J`);
    let timer = null;
    function cleanup() {
      clearInterval(timer);
      if (raw) { input.off('data', onKey); input.setRawMode(false); input.pause(); }
      out.off?.('resize', onResize);
      process.off('SIGINT', quit);
      process.off('SIGTERM', quit);
    }
    const tick = () => {
      const t = Date.now() - start, W = out.columns || 100, H = out.rows || 30;
      if (frame % 6 === 0) {
        if (!state.finished && isOver()) { state.finished = true; state.end = Math.min(state.end, t + 400); }
        // 组里后登记的任务也出场；同名组换了一批人时（人数可能一样）按名单内容换
        const next = refresh?.();
        if (next?.length && lineup(next) !== lineup(scene.participants)) scene.participants = next;
      }
      if (prev.length !== H || prev.w !== W) { prev = []; out.write(`${bgSgr(state.truecolor)}\x1b[2J`); }
      // 平时只写变了的行；每 8 帧整屏重画一次，终端自己弄乱的地方最多留 0.3 秒
      if (frame++ % 8 === 0 || Date.now() < repaintUntil || !prev.length) prev = Object.assign(new Array(H).fill(null), { w: W });
      let text = '';
      introFrame(state, t, W, H).forEach((line, r) => { if (line !== prev[r]) { text += `\x1b[${r + 1};1H${line}`; prev[r] = line; } });
      if (text) out.write(text);
      if (t >= state.end) {
        cleanup();
        if (keepScreen) out.write('\x1b[0m\x1b[2J');
        else { handOff(); restore(); }
        resolve(handOff);
      }
    };
    timer = setInterval(tick, 40);
    tick();
  });
}

export { avatarFor, LOOKS, INTRO_MS, introScene, introLayout, introFrame, introState, playIntro, supportsTruecolor };
