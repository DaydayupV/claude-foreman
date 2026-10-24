// 实时画面的屏幕、按键和启动动画的判断：单任务和组视图共用。
import { StringDecoder } from 'node:string_decoder';
import { TEST_SCREEN, termCols, termRows, shortModel, modelLabel } from './format.mjs';
import { isRunning } from './records.mjs';
import { modelOf, agentTypeOf } from './util.mjs';
import { avatarFor } from './watch-intro.mjs';

// 能画实时画面的终端：输出到终端，而且不是 TERM=dumb 这种不认光标控制的终端（测试用 FOREMAN_TEST_SCREEN 模拟）
const liveCapable = () => (process.stdout.isTTY && process.env.TERM !== 'dumb') || !!TEST_SCREEN;
// 有人能按键：结束后停在画面里等 q，不自动退出。输入不是终端时（比如测试、被别的程序读取）照旧结束就退出；
// 测试用 FOREMAN_TEST_KEYS=1 把管道输入当成按键
const TEST_KEYS = !!process.env.FOREMAN_TEST_KEYS;
const interactive = () => liveCapable() && (!!process.stdin.isTTY || TEST_KEYS);
// 开始和停止读按键：终端切到原始模式，测试的管道输入照原样读（停下后不再拖着进程不退出）
const listenKeys = (fn) => {
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); if (process.stdout.isTTY) process.stdout.write('\x1b[?2004h'); }
  else process.stdin.ref?.();
  process.stdin.resume(); process.stdin.on('data', fn);
};
const stopKeys = (fn) => {
  process.stdin.off('data', fn); fn.stop?.();
  if (process.stdin.isTTY) { if (process.stdout.isTTY) process.stdout.write('\x1b[?2004l'); process.stdin.setRawMode(false); }
  else process.stdin.unref?.();
  process.stdin.pause();
};

// 在终端的备用屏幕里整屏重画。关闭自动换行，超出窗口的部分直接截掉，不会折到下一行把画面挤乱；
// 每行先定位光标再写。窗口大小变化时清屏重画，停下来 0.2 秒后再补画一次：
// Windows 的 ConPTY 调整大小后会自己重绘一遍，可能盖掉刚画好的画面。
function liveScreen(render) {
  let active = false;
  let timer = null;
  const draw = () => {
    if (!active) return;
    const rows = termRows();
    const lines = render(termCols(), rows).slice(0, rows);
    let out = '';
    lines.forEach((l, i) => { out += `\x1b[${i + 1};1H\x1b[2K${l}`; });
    if (lines.length < rows) out += `\x1b[${lines.length + 1};1H\x1b[J`;
    process.stdout.write(out);
  };
  const onResize = () => {
    process.stdout.write('\x1b[2J');
    draw();
    clearTimeout(timer);
    timer = setTimeout(draw, 200);
  };
  return {
    draw,
    get active() { return active; },
    start() {
      if (active) return;
      active = true;
      // 1049 备用屏幕，25 光标，7 自动换行，1007 让鼠标滚轮在备用屏幕里变成上下方向键
      process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1007h\x1b[2J');
      process.stdout.on('resize', onResize);
      draw();
    },
    stop() {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      process.stdout.off('resize', onResize);
      process.stdout.write('\x1b[?1007l\x1b[?7h\x1b[?25h\x1b[?1049l');
    },
  };
}

// 把一段键盘输入拆成单个按键（方向键、翻页键是 ESC 开头的一串）
const splitKeys = (s) => s.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[@-~]|[\s\S]/gu) || [];

const ESC_WAIT_MS = 150; // 等拆开的粘贴标记或转义序列补齐，兼顾单按 Esc 的响应。
const PASTE_IDLE_MS = 3000; // 粘贴中途停顿时继续等结束标记，缺失时再恢复按键。
const PASTE_FOLLOW_MS = 30; // Windows 每次最多读 1024 字节，紧随其后的短尾块仍算粘贴。

function readKeys(fn) {
  const decoder = new StringDecoder('utf8');
  let pending = '', pasting = false, timer = null, followingPaste = false, followTimer = null;
  const read = (data) => {
    clearTimeout(timer);
    clearTimeout(followTimer);
    let text = pending + decoder.write(data);
    // Esc 已等到超时发出时，下一块独立到达的起止标记也不能拆成快捷键。
    if (/^\[20[01]~/u.test(text)) text = '\x1b' + text;
    // 留住块尾的半截转义序列，避免把鼠标参数或粘贴标记拆成快捷键。
    pending = text.match(/\x1b(?:\[[0-?]*[ -/]*|O)?$/u)?.[0] || '';
    const keys = [];
    let ignore = pasting || followingPaste;
    for (const k of splitKeys(text.slice(0, text.length - pending.length))) {
      if (k === '\x1b[200~' || k === '\x1b[201~') { pasting = k === '\x1b[200~'; ignore = true; }
      else if (!pasting) keys.push(k);
    }
    const unmarkedPaste = keys.filter((k) => /^[^\x00-\x1f\x7f-\x9f]$/u.test(k)).length >= 3;
    ignore ||= unmarkedPaste;
    if (unmarkedPaste || followingPaste) {
      followingPaste = true;
      followTimer = setTimeout(() => { followingPaste = false; }, PASTE_FOLLOW_MS);
    }
    if (pending && !pasting) timer = setTimeout(() => { pending = ''; if (!ignore) fn(['\x1b']); }, ESC_WAIT_MS);
    else if (pasting) timer = setTimeout(() => { pasting = false; pending = ''; }, PASTE_IDLE_MS);
    if (ignore) return;
    let sawX = false;
    const accepted = keys.filter((k) => {
      if (k !== 'x' && k !== 'X') return true;
      // 确认必须来自下一块输入，避免同块的 xx 直接终止排队任务。
      if (sawX) return false;
      sawX = true;
      return true;
    });
    if (accepted.length) fn(accepted);
  };
  read.stop = () => { clearTimeout(timer); clearTimeout(followTimer); pending = ''; pasting = followingPaste = false; decoder.end(); };
  return read;
}

// 翻看：offset 是离"默认位置"有多少行。时间线默认跟着最新的内容（从底部往回数），组视图默认在顶上（从顶部往下数）
function scroller({ fromBottom }) {
  const s = { offset: 0, total: 0, room: 0 };
  // 按键改 offset，认出来的返回 true
  s.key = (k, page) => {
    const back = fromBottom ? 1 : -1;
    if (k === '\x1b[A' || k === '\x1bOA' || k === 'k') s.offset += back;
    else if (k === '\x1b[B' || k === '\x1bOB' || k === 'j') s.offset -= back;
    else if (k === '\x1b[5~' || k === 'b') s.offset += back * page;
    else if (k === '\x1b[6~' || k === ' ') s.offset -= back * page;
    else if (k === '\x1b[H' || k === '\x1b[1~' || k === 'g') s.offset = fromBottom ? Number.MAX_SAFE_INTEGER : 0;
    else if (k === '\x1b[F' || k === '\x1b[4~' || k === 'G') s.offset = fromBottom ? 0 : Number.MAX_SAFE_INTEGER;
    else return false;
    s.offset = Math.max(0, s.offset);
    return true;
  };
  // 取出能显示的一段，补齐空行；above、below 是上下还有多少行没显示
  s.view = (lines, room) => {
    const max = Math.max(0, lines.length - room);
    s.offset = Math.min(s.offset, max);
    const start = fromBottom ? max - s.offset : s.offset;
    const shown = lines.slice(start, start + room);
    const above = start, below = lines.length - start - shown.length;
    while (shown.length < room) shown.push('');
    return { shown, above, below };
  };
  return s;
}

// 启动动画只在新派出的对话第一次打开时放：输出到能画实时画面的终端、没设 NO_COLOR、
// 配置没关（dispatch.intro）、没加 --no-intro，而且有还在运行的、不是续接出来的任务（讨论第 2 轮、返工都不放）。
const LEAVE_SCREEN = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
const kindOf = (m) => m.kind || (m.mode === 'discuss' ? 'discuss' : m.mode === 'review' ? 'review' : 'exec');
const introWanted = (o, metas, loadCfg) => liveCapable() && !process.env.NO_COLOR && !o['no-intro']
  && metas.some((m) => isRunning(m) && !m.parent && !m.dismissed_at) && loadCfg(metas[0].cwd).dispatch.intro !== false;
const introOf = (m) => ({ key: avatarFor(m.model_name ?? m.model, agentTypeOf(m)), model: shortModel(modelOf(m)), who: modelLabel(m) });

export { liveCapable, interactive, listenKeys, stopKeys, liveScreen, splitKeys, readKeys, scroller, LEAVE_SCREEN, kindOf, introWanted, introOf };
