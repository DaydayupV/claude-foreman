// node bench.mjs <root> [replay|build]：用合成数据量耗时、进程峰值内存和读取次数
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../foreman/skills/dispatch/scripts');
const { createFeed, buildReplay } = await import(pathToFileURL(`${W}/board/feed.mjs`));
const { createUniverse } = await import(pathToFileURL(`${W}/board/universe.mjs`));
const { loadPrices } = await import(pathToFileURL(`${W}/prices.mjs`));
const [root, mode] = process.argv.slice(2);
const inside = root && path.relative(os.tmpdir(), path.resolve(root));
if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`root must be a folder inside ${os.tmpdir()}`);
const runs = path.join(root, 'runs'), claudeDir = path.join(root, 'claude');
const prices = loadPrices(`${W}/prices.json`), options = { claudeDir, lead: 10, tail: 5, prices };
const mb = (v) => Math.round(v / 1048576);
const mem = () => { const m = process.memoryUsage(); return `rss ${mb(m.rss)} heap ${mb(m.heapUsed)} peak ${mb(process.resourceUsage().maxRSS * 1024)} MB`; };
// 数 fs 同步调用次数
const counts = {};
for (const name of ['readdirSync', 'statSync', 'readFileSync', 'openSync', 'readSync']) {
  const orig = fs[name]; fs[name] = function (...a) { counts[name] = (counts[name] || 0) + 1; return orig.apply(this, a); };
}
const time = (label, fn) => {
  for (const k of Object.keys(counts)) delete counts[k];
  const t = performance.now(), out = fn(), ms = (performance.now() - t).toFixed(1);
  console.log(`${label.padEnd(34)} ${ms.padStart(8)} ms  ${mem()}  fs ${JSON.stringify(counts)}`);
  return out;
};
console.log('start', mem());
if (mode === 'build') {
  const dir = fs.readdirSync(claudeDir).find((name) => fs.readdirSync(path.join(claudeDir, name)).some((file) => file.endsWith('.jsonl')));
  const file = fs.readdirSync(path.join(claudeDir, dir)).find((name) => name.endsWith('.jsonl')), session = file.slice(0, -6);
  console.log(`  transcript ${fs.statSync(path.join(claudeDir, dir, file)).size} bytes`);
  const data = time('feed.read full session', () => createFeed(runs, options).read({ session, replay: session }));
  const replay = time('buildReplay', () => buildReplay(data));
  console.log(`  timeline ${replay.timeline.length}`);
  process.exit(0);
}
const feed = time('feed.hasRunning (startup)', () => { const f = createFeed(runs, options); f.hasRunning(Date.now()); return f; });
// 规模基准绕过产品默认上限，单独测出构建本身的成本。
const universe = createUniverse({ ...options, runs, config: path.join(root, 'config.json'), windowH: 24, replayLimitBytes: Number.MAX_SAFE_INTEGER });
let u = time('universe.read first', () => universe.read());
console.log(`  sessions ${u.sessions.length} projects ${u.projects.length} payload ${JSON.stringify(u).length} chars`);
for (let i = 0; i < 3; i++) time(`universe.read steady #${i + 1}`, () => universe.read());
const target = u.sessions[0].id;
let d = time(`feed.read session first`, () => feed.read({ session: target }));
console.log(`  runs ${d.runs.length} events ${d.events.length}`);
for (let i = 0; i < 3; i++) time(`feed.read session steady #${i + 1}`, () => feed.read({ session: target }));
feed.watch(true);
for (let i = 0; i < 2; i++) time(`feed.read session watched #${i + 1}`, () => feed.read({ session: target }));
feed.watch(false);
time('feed.read recent first', () => feed.read({}));
time('feed.read recent steady', () => feed.read({}));
if (mode === 'replay') {
  const r = time('universe.replay (replay=all)', () => universe.replay({ speed: 1, maxgap: 20 }));
  console.log(`  timeline ${r.timeline.length}`);
  time('replay.detail(session)', () => r.detail(target));
}
console.log('end', mem());
