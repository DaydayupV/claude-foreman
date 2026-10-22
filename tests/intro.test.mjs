import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, output, failed, baseConfig, MESSAGES } from './helpers.mjs';
import { avatarFor, LOOKS, INTRO_MS, introScene, introLayout, introFrame, introState, playIntro, supportsTruecolor } from '../foreman/skills/dispatch/scripts/watch-intro.mjs';
import { AVATARS, AVATAR_ALPHABET } from '../foreman/skills/dispatch/scripts/watch-avatars.mjs';
import { textWidth } from '../foreman/skills/dispatch/scripts/util.mjs';
const M = MESSAGES.zh;

const one = (key, model = `${key}-model`) => ({ key, model, who: `${model}（Codex CLI，effort max）` });
const visible = (line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const fixed = () => 0.5;

test('头像按模型名里的关键字认：先看最后一段，取最先出现的，认不出用 ???', () => {
  const cases = {
    'gpt-6-astra': 'chatgpt', 'gpt-6.1-sol': 'chatgpt', o3: 'chatgpt', 'o4-mini': 'chatgpt', 'gpt-5-codex': 'chatgpt',
    'deepseek-flash': 'deepseek', 'deepseek/deepseek-flash': 'deepseek', 'deepseek-r1-distill-qwen-32b': 'deepseek',
    'kimi-k2.6': 'kimi', 'moonshotai-cn/kimi-k2.6': 'kimi', 'mimo-v2.6-pro': 'mimo', 'xiaomi/mimo-v2.6-pro': 'mimo',
    'opencode/glm-5.3-flash-free': 'glm', 'qwen3-coder-plus': 'qwen', 'minimax-m3': 'minimax', 'gemini-3-pro': 'gemini',
    'openrouter/anthropic/claude-opus-5': 'claude', 'Claude-Sonnet-5': 'claude', 'mistral-large-3': 'unknown',
    'grok-4.7': 'grok', 'x-ai/grok-4.6': 'grok', 'xai/grok-code-fast': 'grok',
    // 服务商前缀里的关键字不抢最后一段的；同一段里几个都命中时看谁在前，不看规则的先后
    'openai-compatible/deepseek-v4': 'deepseek', 'qwen3-deepseek-distill': 'qwen',
  };
  for (const [model, key] of Object.entries(cases)) assert.equal(avatarFor(model, 'opencode cli'), key, model);
  // 没有模型名：Codex 用的是 OpenAI 的模型，其他接入方式认不出
  assert.equal(avatarFor(null, 'codex cli'), 'chatgpt');
  assert.equal(avatarFor(null, 'pi cli'), 'unknown');
});

test('头像数据完整：每个头像都有大 48×48、中 36×36，下标都在调色板里', () => {
  assert.deepEqual(Object.keys(AVATARS).sort(), Object.keys(LOOKS).sort());
  for (const [key, sizes] of Object.entries(AVATARS)) {
    for (const [size, n] of [['L', 48], ['M', 36]]) {
      const { palette, rows } = sizes[size];
      assert.ok(palette.length && palette.length <= AVATAR_ALPHABET.length && palette.every((h) => /^[0-9a-f]{6}$/.test(h)), `${key} ${size}`);
      assert.equal(rows.length, n, `${key} ${size}`);
      for (const r of rows) {
        assert.equal(r.length, n, `${key} ${size}`);
        for (const ch of r) assert.ok(ch === '.' || AVATAR_ALPHABET.indexOf(ch) < palette.length, `${key} ${size} ${ch}`);
      }
    }
  }
});

test('排版按终端大小挑尺寸：宽屏带上 Claude，窄了只画目标，多位放不下就轮流登场，再小用文字徽章', () => {
  const single = introScene({ mode: 'run', kind: 'exec', participants: [one('chatgpt')], random: fixed });
  const three = introScene({ mode: 'discuss', kind: 'discuss', participants: ['chatgpt', 'deepseek', 'glm'].map((k) => one(k)), group: true, random: fixed });
  const five = introScene({ mode: 'discuss', kind: 'discuss', participants: ['chatgpt', 'deepseek', 'glm', 'kimi', 'minimax'].map((k) => one(k)), group: true, random: fixed });
  assert.deepEqual(introLayout(single, 119, 30, 6), { size: 'L', host: true, flip: false });
  assert.deepEqual(introLayout(single, 69, 50, 6), { size: 'L', host: false, flip: false });
  assert.deepEqual(introLayout(single, 69, 26, 6), { size: 'M', host: false, flip: false });
  assert.deepEqual(introLayout(three, 119, 30, 6), { size: 'M', host: false, flip: false });
  assert.deepEqual(introLayout(five, 119, 30, 6), { size: 'L', host: false, flip: true });
  assert.equal(introLayout(single, 30, 14, 6).size, 'T');
  assert.equal(single.duration, INTRO_MS.single);
  assert.equal(five.duration, INTRO_MS.discuss);
});

test('每一帧都不超出终端：行数等于高度，每行最多占宽度减一列；窄窗口的徽章和文字会折行', () => {
  const scenes = [
    introScene({ mode: 'run', kind: 'exec', participants: [one('chatgpt', 'gpt-6-astra')], random: fixed }),
    introScene({ mode: 'review', kind: 'review', participants: [one('unknown', 'some-very-long-model-name-without-any-keyword')], random: fixed }),
    introScene({ mode: 'discuss', kind: 'discuss', participants: ['chatgpt', 'deepseek', 'glm', 'kimi', 'minimax'].map((k) => one(k, `${k}-v4-pro`)), group: true, random: fixed }),
    introScene({ mode: 'review', kind: 'review', participants: ['m3', 'm3-pro', 'm3-max'].map((s) => one('minimax', `minimax-${s}`)), group: true, random: fixed }),
  ];
  for (const scene of scenes) for (const [W, H] of [[140, 40], [120, 30], [70, 50], [40, 30], [28, 24], [20, 12], [12, 6], [8, 4]]) for (const t of [100, 900, 2600, 4800]) {
    const lines = introFrame(introState(scene, fixed), t, W, H);
    assert.equal(lines.length, H);
    for (const l of lines) assert.ok(textWidth(visible(l)) <= W - 1, `${W}×${H} t=${t}: ${visible(l)}`);
  }
  // 30 列放不下中头像，改用文字徽章：5 个徽章分几行排开，名字一个不少；名单要折超过 3 行时只写人数
  const text = introFrame(introState(scenes[2], fixed), 2600, 30, 40).map(visible);
  const badgeLines = text.filter((l) => l.includes('│'));
  assert.ok(badgeLines.length >= 2, text.join('\n'));
  for (const name of ['ChatGPT', 'DeepSeek', 'GLM', 'Kimi', 'MiniMax']) assert.ok(badgeLines.some((l) => l.includes(name)), name);
  assert.ok(text.some((l) => l.trim().endsWith(M.introGathering(5, null))), text.join('\n'));
  assert.ok(!text.some((l) => l.includes('-v4-pro')), text.join('\n'));
  // 40 列时名单折成几行，一个模型名都不截断
  const wider = introFrame(introState(scenes[2], fixed), 2600, 40, 30).map(visible);
  for (const model of scenes[2].participants.map((p) => p.model)) assert.ok(wider.some((l) => l.includes(model)), model);
});

test('同一个头像出场两次以上时，后来的是分身：镜像画、名牌带"分身"、第一句笑话讲分身；??? 不算', () => {
  const clones = (name) => M.introCloneJokes.map((j) => j.replaceAll('{n}', name));
  const frame = (scene, W = 160, H = 40) => introFrame(introState(scene, fixed), 4800, W, H).map(visible).join('\n');
  // 组里两个同系列的模型
  const pair = introScene({ mode: 'discuss', kind: 'discuss', participants: [one('chatgpt', 'gpt-6.1-sol'), one('chatgpt', 'gpt-6-astra')], group: true, random: fixed });
  assert.ok(clones('GPT').includes(pair.jokes[0]), pair.jokes[0]);
  assert.equal(pair.jokes.length, 6);
  assert.ok(frame(pair).includes(M.introClone('ChatGPT', 1)));
  // 分身的头像是本体左右翻过来：两个 48 宽的头像居中排开，中间隔 3 列；星星可能落在空白处，先抹掉
  const x0 = (159 - (48 * 2 + 3)) >> 1, rows = introFrame(introState(pair, fixed), 4800, 160, 40).map((l) => [...visible(l).replace(/[·✧✦]/g, ' ')]);
  const art = rows.filter((l) => l.some((c) => c === '▀' || c === '▄'));
  assert.ok(art.length >= 20, `${art.length}`);
  for (const l of art) assert.deepEqual(l.slice(x0 + 51, x0 + 99), l.slice(x0, x0 + 48).reverse());
  // 三个同系列：第二个分身带编号
  const three = introScene({ mode: 'discuss', kind: 'discuss', participants: ['a', 'b', 'c'].map((s) => one('deepseek', `deepseek-${s}`)), group: true, random: fixed });
  assert.ok(frame(three).includes(M.introClone('DeepSeek', 2)));
  // 单个任务派给 Claude 系列的模型：和左边派活的 Claude 撞脸
  const self = introScene({ mode: 'run', kind: 'exec', participants: [one('claude', 'claude-sonnet-5')], random: fixed });
  assert.ok(clones('Claude').includes(self.jokes[0]), self.jokes[0]);
  assert.ok(frame(self).includes(M.introClone('Claude', 1)));
  // 轮流登场和文字徽章里也标出分身
  const many = introScene({ mode: 'discuss', kind: 'discuss', participants: ['chatgpt', 'deepseek', 'glm', 'kimi', 'chatgpt'].map((k) => one(k)), group: true, random: fixed });
  assert.equal(introLayout(many, 119, 30, 6).flip, true);
  assert.ok(introFrame(introState(many, fixed), 9300, 120, 30).map(visible).join('\n').includes(`${M.introClone('ChatGPT', 1)}  5/5`));
  assert.ok(introFrame(introState(many, fixed), 2600, 30, 40).map(visible).join('\n').includes(M.introClone('ChatGPT', 1)));
  // 认不出的模型彼此不一定同系列：不算分身
  const strangers = introScene({ mode: 'discuss', kind: 'discuss', participants: [one('unknown', 'foo-1'), one('unknown', 'bar-2')], group: true, random: fixed });
  assert.ok(!strangers.jokes.some((j) => M.introCloneJokes.some((c) => j === c.replaceAll('{n}', 'foo-1') || j === c.replaceAll('{n}', 'bar-2'))));
  assert.ok(!frame(strangers).includes(M.introClone('???', 1)));
});

test('macOS 自带终端没声明支持 24 位色时改用 256 色，其他终端用 24 位色', () => {
  assert.equal(supportsTruecolor({ TERM_PROGRAM: 'Apple_Terminal' }), false);
  assert.equal(supportsTruecolor({ TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor' }), true);
  for (const env of [{ TERM_PROGRAM: 'iTerm.app' }, { TERM_PROGRAM: 'vscode' }, { WT_SESSION: 'x' }, {}]) assert.equal(supportsTruecolor(env), true, JSON.stringify(env));
  const scene = introScene({ mode: 'run', kind: 'exec', participants: [one('chatgpt', 'gpt-6-astra')], random: fixed });
  const deep = introFrame(introState(scene, fixed, true), 2600, 120, 30).join('');
  const flat = introFrame(introState(scene, fixed, false), 2600, 120, 30).join('');
  assert.ok(deep.includes('38;2;') && !deep.includes('38;5;'));
  assert.ok(flat.includes('38;5;') && flat.includes('48;5;') && !/[34]8;2;/.test(flat));
  assert.equal(visible(deep), visible(flat)); // 只换颜色，字一样
});

test('文案：中英文都有三类任务和每个头像的笑话，占位符都被换掉', () => {
  for (const lang of ['zh', 'en']) {
    const m = MESSAGES[lang];
    for (const kind of ['run', 'review', 'discuss']) assert.ok(m.introJokes[kind].length >= 3, `${lang} ${kind}`);
    for (const key of Object.keys(LOOKS)) assert.ok(m.introModelJokes[key]?.length, `${lang} ${key}`);
  }
  for (const key of Object.keys(LOOKS)) {
    const scene = introScene({ mode: 'run', kind: 'exec', participants: [one(key, 'mystery-1')] });
    assert.ok(scene.jokes.length && scene.jokes.every((j) => !/\{[nm]\}/.test(j)), key);
  }
});

test('播放：任务提前结束就马上收尾；之后不用备用屏幕时退出，接着用时留着，等接手后再摘掉退出时恢复终端的钩子', async () => {
  for (const keepScreen of [false, true]) {
    let written = '';
    const out = { columns: 80, rows: 30, write: (s) => { written += s; }, on() {}, off() {} };
    const scene = introScene({ mode: 'run', kind: 'exec', participants: [one('deepseek', 'deepseek-flash')] });
    const started = Date.now(), exits = process.listenerCount('exit'), signals = process.listenerCount('SIGINT');
    const handOff = await playIntro(scene, { out, input: null, isOver: () => true, keepScreen });
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    assert.ok(written.startsWith('\x1b[?1049h'));
    assert.ok(visible(written).includes(M.introDone));
    assert.equal(written.endsWith('\x1b[?1049l'), !keepScreen);
    assert.equal(written.split('\x1b[?1049l').length - 1, keepScreen ? 0 : 1); // 只恢复一次
    assert.equal(process.listenerCount('SIGINT'), signals);
    assert.equal(process.listenerCount('exit'), exits + (keepScreen ? 1 : 0));
    handOff();
    assert.equal(process.listenerCount('exit'), exits);
  }
});

test('播放中组里的名单变了（人数一样也算）就换上新名单', async () => {
  const out = { columns: 120, rows: 30, write() {}, on() {}, off() {} };
  const scene = introScene({ mode: 'discuss', kind: 'discuss', participants: [one('chatgpt', 'gpt-6-astra')], group: true });
  const handOff = await playIntro(scene, { out, input: null, isOver: () => true, keepScreen: true, refresh: () => [one('deepseek', 'deepseek-flash')] });
  handOff();
  assert.deepEqual(scene.participants.map((p) => p.model), ['deepseek-flash']);
});

test('dispatch.intro 默认开，只接受 true 或 false', async (t) => {
  const h = sandbox(t);
  assert.equal(output(await h.bridge(['config'])).effective.dispatch.intro, true);
  const c = baseConfig();
  c.dispatch = { ...c.dispatch, intro: 'yes' };
  h.config(c);
  failed(await h.bridge(['config']), M.configInvalid('dispatch.intro', M.invalid.boolean));
});
