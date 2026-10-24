// 把 board/web 下的样式和脚本拼成一个自包含的 index.html，头像卡片（board/avatars/*.png）以 data URI 内嵌，
// 写到插件里：foreman/skills/dispatch/scripts/board/index.html（英文插件由 tools/sync-shared.mjs 同步过去）。
// 页面语言默认中文，服务按插件的 language.json 在返回页面时把 window.__LANG__ 换成 'en'。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, 'web');
const out = path.join(here, '..', 'foreman', 'skills', 'dispatch', 'scripts', 'board', 'index.html');
const read = (f) => fs.readFileSync(path.join(web, f), 'utf8');
const scripts = fs.readdirSync(web).filter((f) => /^\d\d-.+\.js$/.test(f)).sort();
const avatarDir = path.join(here, 'avatars');
const avatars = Object.fromEntries(fs.readdirSync(avatarDir).filter((f) => f.endsWith('.png'))
  .map((f) => [f.slice(0, -4), `data:image/png;base64,${fs.readFileSync(path.join(avatarDir, f)).toString('base64')}`]));
const prelude = `window.__LANG__ = 'zh';\nwindow.__BOARD_MODE__ = 'live';\nwindow.__AVATARS__ = ${JSON.stringify(avatars)};\n`;
const display = fs.readFileSync(path.join(here, '../foreman/skills/dispatch/scripts/display.mjs'), 'utf8');
const names = /export \{([\s\S]*?)\};/.exec(display)[1];
// 独立对象避免页面原有工具函数重名；构建产物不再需要模块加载器。
const shared = `const Display = (() => {\n${display.replace(/export \{[\s\S]*?\};/, '')}\nreturn {${names}};\n})();\n`;
const js = shared + scripts.map((f) => `// ---- ${f}\n${read(f)}`).join('\n');
const page = read('shell.html').replace('/*CSS*/', () => read('board.css')).replace('/*JS*/', () => prelude + js);
fs.writeFileSync(out, page);
console.log(`${path.relative(process.cwd(), out)}: ${scripts.length} scripts · ${Object.keys(avatars).length} avatars · ${(page.length / 1e6).toFixed(2)} MB`);
