'use strict';
// 模型名 → 头像卡片和主题色。规则和 foreman 的 watch-intro.mjs 一致（AVATAR_RULES、LOOKS）。

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
const LOOKS = {
  claude: { name: 'Claude', color: [232, 118, 64] },
  chatgpt: { name: 'ChatGPT', color: [236, 236, 236] },
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

function avatarFor(modelName, agentType) {
  if (agentType === 'host') return 'claude';
  const name = String(modelName || '').toLowerCase();
  for (const part of [name.split('/').pop(), name]) {
    let best = null;
    for (const [key, re] of AVATAR_RULES) {
      const m = re.exec(part);
      if (m && (!best || m.index < best.at)) best = { key, at: m.index };
    }
    if (best) return best.key;
  }
  return !name && agentType === 'codex cli' ? 'chatgpt' : 'unknown';
}

const look = (key) => LOOKS[key] || LOOKS.unknown;
const rgba = (key, a = 1) => { const [r, g, b] = look(key).color; return `rgba(${r},${g},${b},${a})`; };
const avatarSrc = (key) => (window.__AVATARS__ || {})[key] || (window.__AVATARS__ || {}).unknown || '';
