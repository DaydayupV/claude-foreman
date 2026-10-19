import path from 'node:path';
import { setup, replay, write, finish } from './common.mjs';
import { report, review } from '../fixtures/reports.mjs';

const args = process.argv.slice(2);
const operation = args[0] === '--version' ? 'version' : args[0] === 'login' ? 'login' : args[0] === 'debug' ? 'catalog' : args[0] === 'sandbox' ? 'sandbox' : 'exec';
const { scenario: s } = await setup('codex', operation, args);
if (operation === 'version') {
  console.log(s.version || 'codex-cli synthetic-1.0');
} else if (operation === 'catalog') {
  // codex debug models：剧本没给 codex_catalog 时当作读不到清单
  if (s.codex_catalog) console.log(JSON.stringify(s.codex_catalog));
  else { process.stderr.write('synthetic: no model catalog\n'); process.exitCode = 1; }
} else if (operation === 'sandbox') {
  // codex sandbox -c sandbox_mode=… -- <echo 命令>：剧本 sandbox_broken 时模拟 Windows 沙箱设置坏了，unelevated_ok 时 unelevated 模式还能用
  const unelevated = args.includes('windows.sandbox="unelevated"');
  if (s.sandbox_broken && !(unelevated && s.unelevated_ok)) { process.stderr.write('windows sandbox failed: helper_unknown_error: setup refresh had errors\n'); process.exitCode = 1; }
  else console.log(args.at(-1));
} else if (operation === 'login') {
  process.stderr.write(s.logged_in === false ? 'Not logged in\n' : 'Logged in using synthetic credentials\n');
  process.exitCode = s.logged_in === false ? 1 : 0;
} else {
  if (args[0] !== 'exec') throw new Error(`假 codex 不支持 ${args[0]}`);
  const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
  const session = s.session_id || 'synthetic-session';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: session }));
  await replay(s.steps, cwd);
  for (const [name, content] of Object.entries(s.files || {})) write(path.resolve(cwd, name), content);
  // 会话记录：stats 写一条用量；rollout 是额外的原始记录（比如出图调用），没写时间的按现在补上。
  if (s.stats || s.rollout) {
    const d = new Date();
    const dir = path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    const records = [...(s.rollout || []).map((r) => ({ timestamp: d.toISOString(), ...r })), ...(s.stats ? [{ type: 'event_msg', payload: { type: 'token_count', ...s.stats } }] : [])];
    write(path.join(dir, `rollout-${session}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  for (const name of s.images || []) {
    write(path.join(process.env.CODEX_HOME, 'generated_images', session, name), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iQAAAABJRU5ErkJggg==', 'base64'));
  }
  if (!s.hold) {
    const last = s.last_message ?? (args.some((a) => a.endsWith('review.schema.json')) ? review : report);
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: typeof last === 'string' ? last : JSON.stringify(last) } }));
    if (args.includes('-o')) write(args[args.indexOf('-o') + 1], typeof last === 'string' ? last : JSON.stringify(last));
    if (s.usage) console.log(JSON.stringify({ type: 'turn.completed', usage: s.usage }));
  }
  await finish(s);
}
