// 量网页看板从宇宙飞进一个对话时的帧：node fly.mjs <root> | --url <看板地址> [--session long] [--runs 3] [--no-shared] [--headed] [--profile] [--browser <路径>] [--check]
//   [--size 1920,1080]（窗口大小，默认 1440,900） [--query look=old]（附加到看板地址的参数）
// <root> 是 long.mjs 生成的目录（只认系统临时目录里的）。起一个直播看板服务（锁文件写在 <root>/runs 里，不碰真实记录），
// 每一次都新开浏览器（临时用户目录，冷启动），等宇宙载入后飞进 --session，记飞入 1.6 秒和落地后 2 秒的帧间隔，
// 以及长动画帧（>50 ms）里排前面的脚本。--no-shared 去掉 SharedWorker，走页面直连流（Claude 桌面版内置浏览器就是这样）；
// --headed 用有窗口的浏览器（真机 GPU）；--profile 另给出 CPU 剖析里按函数自身耗时排的前 15 名；
// --check 时任何一次飞入或落地后有超过 50 ms 的帧就以退出码 1 结束。
// --url：量一个已经在跑的看板（不起服务，不用 <root>），比如 board 子命令给的直播看板；--session 写对话 id
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), live = args.includes('--url'), root = live ? null : args[0];
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const has = (name) => args.includes(`--${name}`);
const inside = root && path.relative(os.tmpdir(), path.resolve(root));
if (!live && (!inside || inside.startsWith('..') || path.isAbsolute(inside))) { console.error(`root must be a folder inside ${os.tmpdir()}`); process.exit(2); }
const session = opt('session', 'long'), times = Number(opt('runs', 3));
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../foreman/skills/dispatch/scripts/board/server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  if (opt('browser')) return path.resolve(opt('browser'));
  const env = (k) => process.env[k] || '';
  const list = process.platform === 'win32'
    ? [[env('ProgramFiles'), 'Google/Chrome/Application/chrome.exe'], [env('ProgramFiles(x86)'), 'Google/Chrome/Application/chrome.exe'], [env('LOCALAPPDATA'), 'Google/Chrome/Application/chrome.exe'],
      [env('ProgramFiles(x86)'), 'Microsoft/Edge/Application/msedge.exe'], [env('ProgramFiles'), 'Microsoft/Edge/Application/msedge.exe']].filter(([d]) => d).map(([d, f]) => path.join(d, f))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((n) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, n)));
  const found = list.find((f) => fs.existsSync(f));
  if (!found) { console.error('no Chrome or Edge found; pass --browser <path>'); process.exit(2); }
  return found;
}

// 看板服务：直播模式，数据和锁文件都在 <root> 里（--url 时用现成的看板）
const server = live ? null : spawn(process.execPath, [SERVER, '--runs', path.join(root, 'runs'), '--claude-dir', path.join(root, 'claude'), '--config', path.join(root, 'config.json'),
  '--window-h', '48', '--idle-min', '30'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
// --query 两种方式都拼上（现成看板的地址自己已经带了 ?）
const withQuery = (u) => opt('query') ? `${u}${u.includes('?') ? '&' : '?'}${opt('query')}` : u;
const url = live ? withQuery(opt('url')) : await new Promise((resolve, reject) => {
  let out = '';
  server.stdout.on('data', (s) => { out += s; const m = /board: (\S+)/.exec(out); if (m) resolve(withQuery(`${m[1].replace(/\?.*$/, '')}?level=all&lang=zh`)); });
  server.once('exit', (code) => reject(new Error(`board server exited (${code})`)));
});

// 一次冷启动飞入：新开浏览器、连 CDP、载入宇宙、飞进去、记帧
async function once() {
  // --keep-profile：几次运行共用一个浏览器目录（页面照样冷启动，但浏览器的着色器等缓存是热的，和平时用的浏览器一样）
  const dir = has('keep-profile') ? (once.dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-fly-'))) : fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-fly-'));
  fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true }); // 共用目录时上一次留下的端口文件
  // 无头默认是软件 GL（SwiftShader），绘制和合成会被放大很多；--gpu 让无头也用显卡
  const browser = spawn(findBrowser(), [...(has('headed') ? [] : ['--headless=new']), ...(has('gpu') ? ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] : []), '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', `--window-size=${opt('size', '1440,900')}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* 还没写 */ } }
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let seq = 0, traceDone = null; const pending = new Map(), trace = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Tracing.dataCollected') trace.push(...m.params.value);
      else if (m.method === 'Tracing.tracingComplete') traceDone?.();
    };
    const send = (method, params = {}, sid) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId: sid })); });
    const evaluate = async (sid, expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value;
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Target.activateTarget', { targetId });
    if (has('no-shared')) await send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete window.SharedWorker;' }, sid);
    await send('Page.enable', {}, sid);
    await send('Page.navigate', { url }, sid);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { await sleep(250); ready = await evaluate(sid, `typeof U !== 'undefined' && U.sessions.has(${JSON.stringify(session)}) && FLY.mode === 'universe'`); }
    if (!ready) throw new Error(`conversation ${session} did not show up in the universe`);
    // --css：临时加一段样式（排查哪一块绘制贵时用，比如关掉某个滤镜）
    if (opt('css')) await evaluate(sid, `document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(opt('css'))} }))`);
    await sleep(2500);
    if (has('profile')) { await send('Profiler.enable', {}, sid); await send('Profiler.setSamplingInterval', { interval: 200 }, sid); await send('Profiler.start', {}, sid); }
    if (has('trace')) await send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'gpu', 'toplevel', 'cc', 'viz'] } });
    // 帧按时刻记下来，飞入和落地后按页面真正落地（FLY.mode 变成 board）的时刻切开；另数过渡期间看板画布实际画了几次
    const result = await evaluate(sid, `(async () => {
      const frames = [], loaf = []; let last = performance.now(), on = true, landed = null, draws = 0;
      const obs = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame') ? new PerformanceObserver((list) => {
        for (const e of list.getEntries()) loaf.push({ at: e.startTime, d: e.duration, scripts: e.scripts.map((s) => ({ name: s.invoker + ' ' + (s.sourceFunctionName || ''), d: s.duration })) });
      }) : null;
      obs?.observe({ type: 'long-animation-frame' });
      const draw = drawFx; drawFx = (...a) => { if (landed == null) draws++; return draw(...a); };
      // --breakdown：每帧里主要几步各花了多少（包一层计时），超过 50 ms 的帧记下来；--wrap a,b,c 换成只包这几个函数；--slow <毫秒> 改慢帧的门槛（默认 50）
      const parts = ${JSON.stringify(opt('wrap', '').split(',').filter(Boolean))}.length ? ${JSON.stringify(opt('wrap', '').split(',').filter(Boolean))} : ${has('breakdown')} ? ['stepFly', 'uniFrame', 'applyShare', 'smoothFrame', 'computeLayout', 'stepView', 'loadFinals', 'renderTop', 'renderWorld',
        'renderTable', 'renderTerms', 'placeWorld', 'drawFx', 'onRun', 'onEvents', 'onBacklog', 'replaceRateHistory',
        'step', 'stepReel', 'renderCrumb', 'flyFx', 'uniLayout', 'fitView', 'fitGoal', 'domStep', 'renderUniPanels', 'renderUniTop', 'drawUniverse', 'stepUni', 'drawFlyCore', 'burstOf'] : [];
      const spent = {}, slow = [], keep = {};
      for (const name of parts) {
        const fn = globalThis[name]; if (typeof fn !== 'function') continue;
        keep[name] = fn;
        globalThis[name] = function (...a) { const s = performance.now(); try { return fn.apply(this, a); } finally { spent[name] = (spent[name] || 0) + performance.now() - s; } };
      }
      const tick = (ts) => {
        frames.push([ts, ts - last]);
        if (ts - last > ${Number(opt('slow', 50))}) slow.push({ at: Math.round(ts - t0), gap: Math.round(ts - last), parts: Object.entries(spent).filter(([, ms]) => ms >= 2).sort((a, b) => b[1] - a[1]).map(([k, ms]) => k + ' ' + Math.round(ms)).join(', ') });
        for (const k in spent) delete spent[k];
        last = ts; if (landed == null && FLY.mode === 'board') landed = ts; if (on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      performance.mark('fly-start');
      flyIn(${JSON.stringify(session)});
      while (landed == null && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 2000));
      // --steady <秒>：落地以后接着记这么多秒的平时帧（对话正在干活、事件不断到达时看有没有周期性的卡顿）
      const st0 = performance.now(), steadyMs = ${Number(opt('steady', 0)) * 1000};
      if (steadyMs) await new Promise((r) => setTimeout(r, steadyMs));
      // --out：再飞回宇宙，记飞出过程和回到宇宙以后 1 秒
      let out0 = null, back = null;
      if (${has('out')}) {
        out0 = performance.now(); flyOut();
        while (FLY.mode !== 'universe' && performance.now() - out0 < 5000) await new Promise((r) => setTimeout(r, 50));
        back = performance.now(); await new Promise((r) => setTimeout(r, 1000));
      }
      on = false; obs?.disconnect(); drawFx = draw;
      for (const [name, fn] of Object.entries(keep)) globalThis[name] = fn;
      const end = landed ?? Infinity, cut = (a, b) => frames.filter(([ts]) => ts > a && ts <= b).map(([, d]) => d);
      const outFrames = out0 == null ? null : { fly: cut(out0, back), after: cut(back, back + 1000), ms: Math.round(back - out0) };
      const gl = document.createElement('canvas').getContext('webgl'), info = gl?.getExtension('WEBGL_debug_renderer_info');
      return { fly: cut(t0, end), after: cut(end, end + 2000), steady: steadyMs ? cut(st0, st0 + steadyMs) : null, out: outFrames, flyMs: Math.round(end - t0), draws, slow, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '?',
        flyLoaf: loaf.filter((l) => l.at < end), afterLoaf: loaf.filter((l) => l.at >= end), lanes: B.lanes.length, runs: B.runs.size, mode: FLY.mode };
    })()`);
    if (has('profile')) {
      const { result: { profile } } = await send('Profiler.stop', {}, sid);
      const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
      profile.samples.forEach((id, i) => {
        const f = byId.get(id).callFrame, key = `${f.functionName || '(anonymous)'}${f.url ? ':' + (f.lineNumber + 1) : ''}`;
        self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0) / 1000);
      });
      result.top = [...self].filter(([k]) => k !== '(idle)').sort((a, b) => b[1] - a[1]).slice(0, 15);
    }
    if (has('trace')) {
      await new Promise((r) => { traceDone = r; send('Tracing.end'); });
      result.trace = traceSummary(trace);
    }
    ws.close();
    return result;
  } finally {
    browser.kill();
    await sleep(500);
    if (!has('keep-profile')) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

const STEADY_US = Number(opt('steady', 0)) * 1e6;
// --trace：从飞入开始的 4 秒里（加上 --steady 的时长），页面主线程上超过 40 ms 的任务各由哪些事件组成（同名事件的时长加总，嵌套的会重复算），
// 以及 GPU 进程主线程上的任务
function traceSummary(events) {
  const names = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
  const start = events.find((e) => e.name === 'fly-start')?.ts;
  if (start == null) return { error: 'no fly-start mark in the trace' };
  const inWindow = events.filter((e) => e.ph === 'X' && e.ts >= start && e.ts < start + 4e6 + STEADY_US);
  const byThread = (name) => { const count = new Map(); for (const e of inWindow) { const t = names.get(`${e.pid}:${e.tid}`); if (t === name) count.set(`${e.pid}:${e.tid}`, (count.get(`${e.pid}:${e.tid}`) || 0) + 1); } return [...count].sort((a, b) => b[1] - a[1])[0]?.[0]; };
  const main = byThread('CrRendererMain'), gpu = byThread('CrGpuMain'), on = (key) => inWindow.filter((e) => `${e.pid}:${e.tid}` === key);
  const tasks = on(main).filter((e) => e.name === 'ThreadControllerImpl::RunTask' && e.dur > Number(opt('slow', 40)) * 1000);
  // V8 的采样（ProfileChunk）：页面主线程那份，算出每个样本的时刻，落在长任务里的按函数自身耗时合计
  const samples = [], pid = Number(main?.split(':')[0]), tid = Number(main?.split(':')[1]);
  const profile = events.find((e) => e.name === 'Profile' && e.pid === pid && e.tid === tid);
  if (profile) {
    const nodes = new Map();
    let t = profile.args.data.startTime;
    for (const c of events.filter((e) => e.name === 'ProfileChunk' && e.id === profile.id)) {
      for (const n of c.args.data.cpuProfile?.nodes || []) nodes.set(n.id, n);
      (c.args.data.cpuProfile?.samples || []).forEach((id, i) => { t += c.args.data.timeDeltas?.[i] ?? 0; samples.push([t, id]); });
    }
    for (const s of samples) { const f = nodes.get(s[1])?.callFrame; s[1] = f ? `${f.functionName || '(anonymous)'}${f.url ? ':' + (f.lineNumber + 1) : ''}` : '?'; }
  }
  const long = tasks.map((task) => {
    const sum = new Map(), self = new Map();
    for (const e of on(main)) if (e !== task && e.ts >= task.ts && e.ts + (e.dur || 0) <= task.ts + task.dur && /^(Layout|UpdateLayoutTree|Paint|MinorGC|MajorGC|FunctionCall|ParseHTML|Commit)$/.test(e.name)) sum.set(e.name, (sum.get(e.name) || 0) + e.dur);
    const inside = samples.filter(([ts]) => ts >= task.ts && ts < task.ts + task.dur);
    for (let i = 0; i < inside.length; i++) self.set(inside[i][1], (self.get(inside[i][1]) || 0) + ((inside[i + 1]?.[0] ?? task.ts + task.dur) - inside[i][0]));
    const top = [...self].filter(([k]) => k !== '(idle)').sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, d]) => `${n} ${Math.round(d / 1000)}`).join(', ');
    return `+${Math.round((task.ts - start) / 1000)} ms ${Math.round(task.dur / 1000)} ms: ` + [...sum].sort((a, b) => b[1] - a[1]).map(([n, d]) => `${n} ${Math.round(d / 1000)}`).join(', ') + (top ? `\n      js: ${top}` : '');
  });
  const gpuTasks = on(gpu).filter((e) => e.name === 'GPUTask' || e.name === 'RunTask');
  // GPU 主线程每 250 ms 忙了多少毫秒，看它集中在飞入的哪一段
  const buckets = Array(16).fill(0);
  for (const e of gpuTasks) buckets[Math.min(15, Math.floor((e.ts - start) / 250000))] += e.dur / 1000;
  return { long, gpu: `GPU main: ${Math.round(gpuTasks.reduce((n, e) => n + e.dur, 0) / 1000)} ms busy, longest ${Math.round(Math.max(0, ...gpuTasks.map((e) => e.dur)) / 1000)} ms; per 250 ms: ${buckets.map(Math.round).join(' ')}` };
}

const stats = (g) => { const s = [...g].sort((a, b) => a - b); return { frames: g.length, max: Math.round(s.at(-1) ?? 0), p95: Math.round(s[Math.floor(s.length * 0.95)] ?? 0), over50: g.filter((x) => x > 50).length, over100: g.filter((x) => x > 100).length }; };
// 长动画帧里的脚本按调用方和函数名合计
const scripts = (loaf) => { const m = new Map(); for (const l of loaf) for (const s of l.scripts) m.set(s.name, (m.get(s.name) || 0) + s.d); return [...m].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, d]) => `${k.trim()} ${Math.round(d)} ms`); };
let failed = false;
try {
  console.log(`${url}  session ${session}  ${has('no-shared') ? 'direct stream' : 'shared stream'}  ${has('headed') ? 'headed' : 'headless'}`);
  for (let i = 1; i <= times; i++) {
    const r = await once(), fly = stats(r.fly), after = stats(r.after);
    if (fly.over50 || after.over50) failed = true;
    console.log(`#${i} ${r.lanes} lanes ${r.runs} runs → ${r.mode} after ${r.flyMs} ms; board canvas drawn ${r.draws} times during the fly; ${r.renderer}`);
    console.log(`   fly-in  ${JSON.stringify(fly)}  long frames ${r.flyLoaf.length}: ${scripts(r.flyLoaf).join(', ') || '—'}`);
    console.log(`   landed  ${JSON.stringify(after)}  long frames ${r.afterLoaf.length}: ${scripts(r.afterLoaf).join(', ') || '—'}`);
    if (r.steady) { const g = r.steady; console.log(`   steady  ${JSON.stringify(stats(g))} over33 ${g.filter((x) => x > 33).length}`); }
    if (r.out) { console.log(`   fly-out ${JSON.stringify(stats(r.out.fly))} in ${r.out.ms} ms`); console.log(`   back    ${JSON.stringify(stats(r.out.after))}`); }
    if (r.top) console.log(r.top.map(([k, ms]) => `   ${ms.toFixed(1).padStart(7)} ms  ${k}`).join('\n'));
    for (const s of r.slow) console.log(`   slow frame at +${s.at} ms (${s.gap} ms): ${s.parts || 'no wrapped step over 2 ms'}`);
    if (r.trace) { for (const line of r.trace.long || [r.trace.error]) console.log(`   main-thread task ${line}`); console.log(`   ${r.trace.gpu}`); }
  }
} finally {
  server?.kill();
  if (once.dir) fs.rmSync(once.dir, { recursive: true, force: true, maxRetries: 5 });
}
if (has('check') && failed) { console.log('FAIL: a frame over 50 ms'); process.exit(1); }
