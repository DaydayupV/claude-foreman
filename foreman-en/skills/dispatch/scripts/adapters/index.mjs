// 静态注册表；配置和分派统一读取适配器的能力声明。
import codex from './codex-cli.mjs';
import opencode from './opencode-cli.mjs';
import pi from './pi-cli.mjs';
import agy from './agy-cli.mjs';
import api from './api.mjs';

export const adapters = Object.fromEntries([codex, opencode, pi, agy, api].map((adapter) => [adapter.type, adapter]));
