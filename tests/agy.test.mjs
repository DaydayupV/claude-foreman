import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { plannedSandbox as sandbox, baseConfig, taskArgs, output, failed, read, lines, write, poll, ROOT, AGY, MESSAGES, seedRun } from './helpers.mjs';
import { discussion } from './fixtures/reports.mjs';
import { AGY_EFFORTS, splitAgyModel, agyFamilies, agyModelId } from '../foreman/skills/dispatch/scripts/adapters/agy-models.mjs';

const SCRIPTS = path.join(ROOT, 'foreman/skills/dispatch/scripts'), GUARD = path.join(SCRIPTS, 'adapters/agy-guard.mjs'), M = MESSAGES.zh;
const agent = () => ({ type: 'agy cli', model: 'gemini-3.8-flash', bin: AGY });
const configure = (h, change = () => {}) => {
  const tmp = path.join(h.home, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  Object.assign(h.env, { TMP: tmp, TEMP: tmp, TMPDIR: tmp });
  // 宿主网络对照也隔离：只模拟 DNS/HTTPS，不让测试访问公网。
  const network = h.write('network-fixture.mjs', `import fs from 'node:fs';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
let index=0, current={};
const scenario=()=>JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO,'utf8'));
const record=(stage,target)=>{const file=scenario().network_capture;if(file)fs.appendFileSync(file,JSON.stringify({stage,target,index})+'\\n');};
dns.Resolver=class{cancel(){}async resolve4(host){current=scenario().network_controls?.[index++]||{};record('dns',host);if(current.dns_hang)return new Promise(()=>{});if(current.dns_error)throw Object.assign(new Error(current.dns_error),{code:current.dns_error});return ['127.0.0.1'];}};
https.get=(url,options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};record('https',url);queueMicrotask(()=>{if(current.https_error)req.emit('error',Object.assign(new Error(current.https_error),{code:current.https_error}));else{const response=new EventEmitter();response.resume=()=>{if(current.response_error)queueMicrotask(()=>response.emit('error',new Error('closed')));};callback(response);}});return req;};
`);
  h.env.NODE_OPTIONS = `--import=${pathToFileURL(network).href}`;
  const c = baseConfig(); c.agents.agy = agent();
  c.modules.discuss.complex = [{ agent: 'agy', effort: 'high' }];
  c.modules.review.complex = [{ agent: 'agy', effort: 'high' }];
  change(c); h.config(c); return c;
};
const globalDir = (h) => path.join(h.home, '.gemini/config');
const stateDir = (h) => path.join(h.home, '.claude/foreman');
const install = async (h) => output(await h.bridge(['agy-guard', 'install']));
const modelCalls = (h) => h.calls().filter((c) => c.tool === 'agy' && ['run', 'probe'].includes(c.operation));
const moduleCall = (h, file, code) => {
  const script = `import * as x from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS, file)).href)}; ${code}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: h.cwd, env: h.env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
};
const policy = (h, extra = {}) => ({ root: h.cwd, add_dirs: [], access: 'read', run_dir: h.cwd, log_file: path.join(h.cwd, 'agy.log'), nonce: 'synthetic', ...extra });
const guard = (h, p, tool = 'read_file', args = { Path: path.join(h.cwd, 'source.txt') }, inputExtra = {}) => {
  const r = spawnSync(process.execPath, [GUARD], { cwd: h.cwd, env: { ...h.env, ...(p === undefined ? {} : { FOREMAN_AGY_GUARD: typeof p === 'string' ? p : JSON.stringify(p) }) },
    input: JSON.stringify({ workspacePaths: [h.cwd], toolCall: { name: tool, args }, ...inputExtra }), encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
};
const run = (h, extra = [], opts) => h.bridge(taskArgs(h, 'discuss', ['--agent', 'agy', ...extra]), opts);

test('agy 模型族只拆词表后缀，按档位排序并解析单档、无档和旧完整 ID', () => {
  const ids = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];
  const families = agyFamilies(ids), levels = 'low / medium / high';
  assert.deepEqual(AGY_EFFORTS, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  for (const effort of AGY_EFFORTS) assert.deepEqual(splitAgyModel(`model-${effort}`), { family: 'model', effort });
  assert.deepEqual(splitAgyModel('claude-opus-4-6-thinking'), { family: 'claude-opus-4-6-thinking', effort: null });
  assert.deepEqual(families, [
    { id: 'gemini-3.8-flash', efforts: ['low', 'medium', 'high'], ids: { high: ids[0], medium: ids[1], low: ids[2] } },
    { id: ids[3], efforts: [], ids: {}, plain: ids[3] }, { id: ids[4], efforts: [], ids: {}, plain: ids[4] },
    { id: 'gpt-oss-120b', efforts: ['medium'], ids: { medium: ids[5] } },
  ]);
  for (const effort of [undefined, null, 'default']) {
    assert.equal(agyModelId(ids[0], effort, families), ids[0]);
    assert.equal(agyModelId('gpt-oss-120b', effort, families), ids[5]);
    assert.equal(agyModelId(ids[3], effort, families), ids[3]);
    assert.throws(() => agyModelId('gemini-3.8-flash', effort, families), { message: M.agyEffortMissing('gemini-3.8-flash', levels) });
  }
  assert.equal(agyModelId('gemini-3.8-flash', 'low', families), ids[2]);
  assert.throws(() => agyModelId(ids[0], 'high', families), { message: M.agyEffortFullId(ids[0], 'high', 'gemini-3.8-flash') });
  assert.throws(() => agyModelId('gemini-3.8-flash', 'max', families), { message: M.agyEffortUnknown('gemini-3.8-flash', 'max', levels) });
  assert.throws(() => agyModelId(ids[4], 'high', families), { message: M.agyEffortUnknown(ids[4], 'high', '') });
  assert.throws(() => agyModelId('missing', null, families), { code: 'agyModelMissing' });
});

test('agy 同族的原始无后缀 ID 优先于单档或多档默认选择', () => {
  for (const ids of [['synthetic-medium', 'synthetic'], ['synthetic', 'synthetic-high', 'synthetic-medium']]) {
    const families = agyFamilies(ids);
    assert.equal(families.length, 1); assert.equal(families[0].plain, 'synthetic');
    for (const effort of [undefined, null, 'default']) assert.equal(agyModelId('synthetic', effort, families), 'synthetic');
    assert.equal(agyModelId('synthetic', 'medium', families), 'synthetic-medium');
  }
  assert.equal(Object.hasOwn(agyFamilies(['synthetic-medium'])[0], 'plain'), false);
});

test('agy --model 完整 ID 覆盖格子和上一轮档位，派出和续接都按 ID 选档', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const first = output(await run(h, ['--model', 'gemini-3.8-flash-low']));
  assert.equal(first.effort, 'low');
  for (const call of modelCalls(h)) assert.equal(call.args[call.args.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  const before = modelCalls(h).length;
  const next = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-', '--model', 'gemini-3.8-flash-medium']));
  assert.equal(next.effort, 'medium');
  for (const call of modelCalls(h).slice(before)) assert.equal(call.args[call.args.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
});

test('agy 续接旧完整 ID 协作方时不迁移到同族的新写法协作方', async (t) => {
  const h = sandbox(t), full = 'gemini-3.8-flash-low';
  configure(h, (c) => {
    delete c.agents.agy; c.agents.legacy = { ...agent(), model: full }; c.agents.family = agent();
    c.modules.discuss.complex = c.modules.review.complex = [{ agent: 'legacy' }, { agent: 'family', effort: 'high' }];
    c.modules.discuss.seats.complex = 1;
  }); await install(h);
  const first = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'legacy'])));
  const next = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-']));
  for (const result of [first, next]) {
    assert.equal(result.agent, 'legacy'); assert.equal(result.effort, 'low');
    const meta = JSON.parse(read(path.join(result.run_dir, 'meta.json')));
    assert.equal(meta.model, 'gemini-3.8-flash'); assert.equal(meta.agy_model_id, full);
  }
  for (const call of modelCalls(h)) assert.equal(call.args[call.args.indexOf('--model') + 1], full);
});

test('agy 开工行先于看板且只打一次，未写档位不预报推断值，解析失败也有开工行', async (t) => {
  const h = sandbox(t); configure(h, (c) => {
    c.dispatch.watch.web = true; c.agents.agy.model = 'gpt-oss-120b';
    c.modules.discuss.complex = c.modules.review.complex = [{ agent: 'agy' }];
  }); await install(h);
  write(path.join(h.runs, 'board.lock.json'), { port: 12345, token: 'synthetic-agy-board', pid: process.pid });
  const launched = await run(h); assert.equal(output(launched).effort, 'medium');
  const rejected = await run(h, ['--model', 'gemini-3.8-flash', '--effort', 'max']);
  assert.ok(output(rejected, 1).errors.includes(M.agyEffortUnknown('gemini-3.8-flash', 'max', 'low / medium / high')));
  for (const result of [launched, rejected]) {
    const rows = result.stderr.split('\n'), started = rows.findIndex((s) => s.includes(' started ·'));
    assert.ok(started >= 0 && started < rows.findIndex((s) => s.startsWith('foreman: web board ')), result.stderr);
    assert.equal(rows.filter((s) => s.includes(' started ·')).length, 1);
  }
  assert.ok(launched.stderr.includes('gpt-oss-120b · Agy CLI')); assert.equal(launched.stderr.includes('gpt-oss-120b medium · Agy CLI'), false);
});

test('agy 旧完整 ID 不写 effort 仍可派出、列入清单并续接，记录拆成模型族和档位', async (t) => {
  const h = sandbox(t), full = 'gemini-3.8-flash-high';
  configure(h, (c) => { c.agents.agy.model = full; c.modules.discuss.complex = c.modules.review.complex = [{ agent: 'agy' }]; });
  await install(h); h.scenario({});
  const first = output(await run(h));
  assert.equal(first.model, 'gemini-3.8-flash'); assert.equal(first.effort, 'high');
  assert.equal(output(await h.bridge(['models'])).agents.agy.listed, true);
  const md = await h.bridge(['models', '--format', 'md']); assert.ok(md.stdout.includes('| gemini-3.8-flash | low / medium / high | — | agy |'));
  const next = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-']));
  assert.equal(next.model, first.model); assert.equal(next.effort, first.effort);
  for (const call of modelCalls(h)) assert.equal(call.args[call.args.indexOf('--model') + 1], full);
});

test('agy 派出拼回覆盖的档位，单档和无档自动选择，清单不可读时仍交给 agy', async (t) => {
  const h = sandbox(t); configure(h); await install(h); h.scenario({});
  const launched = await run(h, ['--effort', 'low']), result = output(launched);
  assert.equal(result.model, 'gemini-3.8-flash'); assert.equal(result.effort, 'low');
  const meta = JSON.parse(read(path.join(result.run_dir, 'meta.json')));
  assert.equal(meta.model, result.model); assert.equal(meta.effort, result.effort);
  assert.ok(launched.stderr.includes('gemini-3.8-flash low · Agy CLI'));
  assert.equal(h.calls().filter((c) => c.operation === 'catalog').length, 1);
  for (const call of modelCalls(h)) { assert.equal(call.args[call.args.indexOf('--model') + 1], 'gemini-3.8-flash-low'); assert.equal(call.args.includes('--effort'), false); }
  for (const [model, effort] of [['gpt-oss-120b', 'medium'], ['claude-sonnet-4-6', null], ['claude-opus-4-6-thinking', null]]) {
    configure(h, (c) => { c.agents.agy.model = model; c.modules.discuss.complex = c.modules.review.complex = [{ agent: 'agy' }]; }); h.scenario({});
    const r = output(await run(h)); assert.equal(r.model, model); assert.equal(r.effort, effort);
    assert.equal(modelCalls(h).at(-1).args[modelCalls(h).at(-1).args.indexOf('--model') + 1], effort ? `${model}-${effort}` : model);
  }
  configure(h); h.scenario({ agy_catalog: [] });
  assert.equal(output(await run(h, ['--effort', 'medium'])).effort, 'medium');
  assert.equal(modelCalls(h).at(-1).args[modelCalls(h).at(-1).args.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
  h.scenario({ agy_catalog: [], invalid_model: true }); assert.ok(output(await run(h), 1).errors.some((e) => e.includes('invalid model')));
});

test('agy check 和派出按每格组合拒绝缺档位、未知档位，单档和无档格子也核对', async (t) => {
  const h = sandbox(t); configure(h, (c) => {
    c.modules.discuss.complex = [{ agent: 'agy' }]; c.modules.review.complex = [{ agent: 'agy', effort: 'max' }];
    c.modules.discuss.normal = [{ agent: 'agy', model: 'gpt-oss-120b' }]; c.modules.review.normal = [{ agent: 'agy', model: 'claude-sonnet-4-6' }];
  }); await install(h); h.scenario({});
  const result = output(await h.bridge(['check', '--agent', 'agy']), 1), checked = result.agents.agy;
  assert.ok(checked.efforts.find((e) => e.variant === 'default' && e.model === 'gemini-3.8-flash').problem.includes('要在格子里写 effort'));
  assert.ok(checked.efforts.find((e) => e.variant === 'max').problem.includes('能选的：low / medium / high'));
  for (const entry of checked.efforts.filter((e) => !e.ok)) assert.equal(entry.error, entry.problem);
  assert.equal(result.summary.modules.discuss.complex[0].ok, false);
  assert.equal(result.summary.modules.discuss.complex[0].problem, M.agyEffortMissing('gemini-3.8-flash', 'low / medium / high'));
  const md = await h.bridge(['check', '--agent', 'agy', '--format', 'md']); assert.equal(md.code, 1, md.stderr);
  assert.ok(md.stdout.includes(M.agyEffortMissing('gemini-3.8-flash', 'low / medium / high')));
  assert.ok(md.stdout.includes(M.agyEffortUnknown('gemini-3.8-flash', 'max', 'low / medium / high')));
  assert.ok(md.stdout.includes(`${M.reportDefault} ⚠`));
  for (const model of ['gpt-oss-120b', 'claude-sonnet-4-6']) assert.equal(checked.efforts.find((e) => e.model === model).ok, true);
  assert.ok(output(await run(h), 1).errors.includes(M.agyEffortMissing('gemini-3.8-flash', 'low / medium / high')));
  assert.ok(output(await run(h, ['--effort', 'max']), 1).errors.includes(M.agyEffortUnknown('gemini-3.8-flash', 'max', 'low / medium / high')));
});

test('项目配置按 agy 词表调低档位，调高和无法比较的默认档保持用户配置', async (t) => {
  const h = sandbox(t); configure(h);
  for (const [effort, expected] of [['low', 'low'], ['max', 'high'], ['default', 'high']]) {
    h.write('.claude/foreman.json', { modules: { discuss: { complex: [{ agent: 'agy', effort }] } } });
    const cfg = output(await h.bridge(['config', '--cwd', h.cwd])); assert.equal(cfg.resolved_modules.discuss.complex[0].effort, expected);
  }
});

test('agy 同族不同档位在 stats 合并，不能再充当不同基础模型的补漏席', async (t) => {
  const h = sandbox(t); configure(h, (c) => {
    c.agents.other = { ...agent(), model: 'gemini-3.8-flash-low' };
    c.modules.review.complex.push({ agent: 'other' }); c.modules.review.seats.complex = 1;
  });
  for (const [i, model] of ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash'].entries())
    seedRun(h, `agy-${i}`, { model, agent_type: 'agy cli', module: 'discuss', mode: 'discuss', kind: 'discuss' }, { status: 'done', report: discussion });
  const stats = output(await h.bridge(['stats'])); assert.deepEqual(stats.rows.map((r) => [r.model, r.seats]), [['gemini-3.8-flash', 3]]);
  h.write('source.txt', 'source');
  failed(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'complex', '--group', 'agy-family',
    '--seat', 'agy', '--seat', 'other=gap', '--target', 'files', '--file', 'source.txt']), M.gapSeatSameModel(2, 'gemini-3.8-flash'));
});

test('agy 守卫逐档逐工具拒绝写入、未知工具和未知参数', (t) => {
  const h = sandbox(t); h.write('source.txt', 'readable');
  const inputs = { read_file: { Path: path.join(h.cwd, 'source.txt') }, view_file: { Path: path.join(h.cwd, 'source.txt') },
    run_command: { CommandLine: 'git --version' }, edit_file: { Path: path.join(h.cwd, 'source.txt'), Target: 'readable', Replacement: 'bad' },
    write_file: { Path: path.join(h.cwd, 'other.txt'), Content: 'bad', Overwrite: true }, manage_task: {}, ask_question: {},
    invoke_subagent: {}, define_subagent: {}, manage_subagents: {}, send_message: {}, schedule: {}, search_web: {}, browser_open: {}, call_mcp_tool: {}, generate_image: {}, notebook_edit: {}, unknown: {} };
  for (const access of ['none', 'read', 'edit', 'shell']) for (const [tool, args] of Object.entries(inputs)) {
    const result = guard(h, policy(h, { access }), tool, args);
    const allowed = access === 'read' && ['read_file', 'view_file'].includes(tool) || ['none', 'read'].includes(access) && tool === 'manage_task';
    assert.equal(result.decision, allowed ? 'allow' : 'deny', `${access}/${tool}`);
    if (!allowed) assert.match(result.reason, /^foreman guard: /);
  }
  for (const tool of ['read_file', 'view_file', 'run_command', 'edit_file', 'write_file']) {
    const r = guard(h, policy(h), tool, { ...inputs[tool], Cwd: h.cwd });
    assert.equal(r.decision, 'deny'); assert.match(r.reason, /Cwd/);
  }
  for (const bad of ['{', {}, { access: 'read' }, { ...policy(h), root: 'relative' }, { ...policy(h), add_dirs: ['relative'] }, { ...policy(h), root: path.join(h.cwd, 'missing') }])
    assert.equal(guard(h, bad).decision, 'deny');
  assert.equal(read(path.join(h.cwd, 'source.txt')), 'readable');
});

test('agy 路径只认盘符、UNC 和解码 file URL，真实路径不能逃逸', (t) => {
  const h = sandbox(t); h.write('空 格.txt', 'safe');
  const file = path.join(h.cwd, '空 格.txt'), outside = write(path.join(h.home, 'outside.txt'), 'outside');
  const add = path.join(h.home, 'extra'); fs.mkdirSync(add); write(path.join(add, 'a.txt'), 'extra');
  for (const value of [file, file.replaceAll('\\', '/'), pathToFileURL(file).href]) {
    const r = guard(h, policy(h), 'read_file', { Path: value });
    assert.equal(r.decision, 'allow', value);
  }
  for (const value of ['@source.txt', '~/source.txt', '~\\source.txt', 'source.txt', '..\\outside.txt', '/c/other', 'C:relative',
    pathToFileURL(outside).href, outside, '\\\\server\\share\\outside.txt', 'file:///broken%ZZ', 'file://server/share/a', '\\\\?\\C:\\file', ...(process.platform === 'win32' ? [`${file}:stream`] : [])]) {
    assert.equal(guard(h, policy(h), 'view_file', { Path: value }).decision, 'deny', value);
  }
  assert.equal(guard(h, policy(h, { add_dirs: [add] }), 'read_file', { Path: pathToFileURL(path.join(add, 'a.txt')).href }).decision, 'allow');
  const link = path.join(h.cwd, 'escape'); fs.symlinkSync(h.home, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const value of [path.join(link, 'outside.txt'), path.join(link, 'new', 'missing.txt')]) assert.equal(guard(h, policy(h), 'read_file', { Path: pathToFileURL(value).href }).decision, 'deny');
});

test('agy read shell 同时要求探针、sandbox 参数和本轮启用日志；probe 只认精确命令', (t) => {
  const h = sandbox(t), p = policy(h, { sandbox: true, sandbox_available: true }), args = { CommandLine: 'git --version', WaitMsBeforeAsync: 1000, toolSummary: 'version' };
  for (const log of ['', 'terminal sandbox unavailable', 'enabling terminal sandbox\nterminal sandbox disabled', 'enabling terminal sandbox\nfalling back from sandbox']) {
    h.write('agy.log', log); assert.equal(guard(h, p, 'run_command', args).decision, 'deny');
  }
  h.write('agy.log', 'Print mode: enabling terminal sandbox for this session');
  assert.equal(guard(h, p, 'run_command', args).decision, 'allow');
  // Windows 上放行的命令前面加上 UTF-8 输出编码，避免中文路径的输出让 agy 整轮报 400。
  assert.deepEqual(guard(h, p, 'run_command', args).overwrite, process.platform === 'win32'
    ? { CommandLine: `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${args.CommandLine}` } : undefined);
  assert.equal(guard(h, { ...p, sandbox: false }, 'run_command', args).decision, 'deny');
  assert.equal(guard(h, { ...p, sandbox_available: false }, 'run_command', args).decision, 'deny');
  assert.equal(guard(h, { ...p, access: 'probe', probe_commands: ['git --version'] }, 'run_command', args).decision, 'allow');
  assert.equal(guard(h, { ...p, access: 'probe', probe_commands: [] }, 'run_command', args).decision, 'deny');
  assert.ok(lines(path.join(h.cwd, 'agy-guard.jsonl')).every((r) => r.t && r.tool && ['deny', 'allow'].includes(r.decision)));
});

test('agy 丢失策略时启动标记命中拒绝、未命中或过期 ask', (t) => {
  const h = sandbox(t), file = path.join(stateDir(h), 'agy-markers/synthetic.json');
  assert.equal(guard(h, undefined).decision, 'ask');
  const expiry = new Date(Date.now() + 60000).toISOString();
  write(file, { cwd: h.cwd, expires_at: expiry });
  const result = guard(h, undefined); assert.equal(result.decision, 'deny');
  assert.equal(result.reason, `foreman guard: foreman is running agy in this folder (run unknown), so tool calls here are paused until that run ends (at the latest ${expiry}); run "agy-guard status" in foreman to see it`);
  const slashPath = h.cwd.replaceAll('\\', '/');
  assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths: [slashPath] }).decision, 'deny');
  if (process.platform === 'win32') assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths: [slashPath.toUpperCase()] }).decision, 'deny');
  assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths: [path.join(h.home, 'elsewhere')] }).decision, 'ask');
  write(file, { cwd: h.cwd, expires_at: new Date(Date.now() - 1).toISOString() });
  assert.equal(guard(h, undefined).decision, 'ask');
  write(file, { cwd: h.cwd, pid: process.pid, expires_at: expiry });
  const stale = new Date(Date.now() - 660000); fs.utimesSync(file, stale, stale);
  assert.equal(guard(h, undefined).decision, 'deny'); assert.equal(fs.existsSync(file), true);
  assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths: [] }).decision, 'deny');
});

test('agy 标记按真实子进程的启动时间拒绝或清理，查不到保留，未命中不查', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const child = h.start(h.write('live-pid.mjs', "console.log('ready');setInterval(()=>{},1000)"));
  await poll(() => child.stdout.includes('ready'), '标记子进程启动');
  const started = moduleCall(h, 'util.mjs', `console.log(JSON.stringify(x.processStartedAt(${child.child.pid})));`);
  assert.ok(Number.isFinite(started));
  const file = path.join(stateDir(h), 'agy-markers/live.json'), capture = path.join(h.home, 'process-query.jsonl');
  const marker = { cwd: h.cwd, run_dir: h.cwd, pid: child.child.pid, started_at: started, expires_at: new Date(Date.now() + 60000).toISOString() };
  const fixture = h.write('process-query.mjs', `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawnSync;cp.spawnSync=(file,args,opts)=>{const began=performance.now(),result=spawn(file,args,opts);
if(file==='ps'||file.endsWith('powershell.exe'))fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({ms:performance.now()-began,timeout:opts.timeout})+'\\n');return result};syncBuiltinESMExports();`);
  h.env.NODE_OPTIONS += ` --import=${pathToFileURL(fixture).href}`;
  write(file, marker);
  assert.equal(guard(h, policy(h), 'manage_task', {}).decision, 'allow');
  assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths: [path.join(h.home, 'elsewhere')] }).decision, 'ask');
  assert.equal(lines(capture).length, 0);
  for (const workspacePaths of [[h.cwd], []]) {
    write(file, marker); const old = new Date(Date.now() - 3600000); fs.utimesSync(file, old, old);
    assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths }).decision, 'deny');
    assert.equal(output(await h.bridge(['agy-guard', 'status'])).active.length, 1);
    // 记录值不是数字、或查到的启动时间比记录值更早：拿不准是不是复用，继续拦截。
    for (const startedAt of [String(started), started + 60000]) {
      write(file, { ...marker, started_at: startedAt });
      assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths }).decision, 'deny'); assert.equal(fs.existsSync(file), true);
      assert.equal(output(await h.bridge(['agy-guard', 'status'])).active.length, 1);
    }
    write(file, { ...marker, started_at: started - 60000 });
    assert.equal(output(await h.bridge(['agy-guard', 'status'])).active.length, 0);
    assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths }).decision, 'ask'); assert.equal(fs.existsSync(file), false);
  }
  assert.ok(lines(capture).every((query) => query.timeout === 5000));
  t.diagnostic(`agy guard process-start query: ${lines(capture)[0].ms.toFixed(1)} ms`);
  for (const result of [{ error: { code: 'ETIMEDOUT' } }, { stdout: '' }]) {
    const unavailable = h.write('query-unavailable.mjs', `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawnSync;
cp.spawnSync=(file,...args)=>file==='ps'||file.endsWith('powershell.exe')?${JSON.stringify(result)}:spawn(file,...args);syncBuiltinESMExports();`);
    h.env.NODE_OPTIONS = `--import=${pathToFileURL(unavailable).href}`;
    write(file, { ...marker, started_at: started - 60000 });
    for (const workspacePaths of [[h.cwd], []]) assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths }).decision, 'deny');
    assert.equal(output(await h.bridge(['agy-guard', 'status'])).active.length, 1); assert.equal(fs.existsSync(file), true);
  }
  child.stop(); await child.done;
});

test('agy 未知 workspace 拒绝并逐个留 stray，死 PID 标记删除而 EPERM 仍活跃', (t) => {
  const h = sandbox(t), markers = path.join(stateDir(h), 'agy-markers');
  const second = path.join(h.home, 'second'); fs.mkdirSync(second);
  const expiry = new Date(Date.now() + 60000).toISOString();
  for (const [id, root] of [['one', h.cwd], ['two', second]]) write(path.join(markers, `${id}.json`), { cwd: root, run_dir: root, pid: process.pid, expires_at: expiry });
  const reason = `foreman guard: foreman is running agy (run ${path.basename(h.cwd)}) and this call has no workspace, so tool calls are paused until that run ends (at the latest ${expiry})`;
  for (const workspacePaths of [undefined, [], 'wrong', [null], ['']]) {
    const decision = guard(h, undefined, 'read_file', {}, { workspacePaths });
    assert.equal(decision.decision, 'deny'); assert.equal(decision.reason, reason);
  }
  for (const dir of [h.cwd, second]) {
    assert.equal(lines(path.join(dir, 'agy-guard-stray.jsonl')).length, 5);
    assert.equal(fs.existsSync(path.join(dir, 'agy-guard.jsonl')), false);
  }
  fs.rmSync(path.join(markers, 'one.json')); fs.rmSync(path.join(markers, 'two.json'));
  const dead = path.join(markers, 'dead.json'); write(dead, { cwd: h.cwd, pid: 2147483647, expires_at: expiry });
  assert.equal(guard(h, undefined).decision, 'ask'); assert.equal(fs.existsSync(dead), false);
  assert.equal(guard(h, undefined, 'read_file', {}, { workspacePaths: undefined }).decision, 'ask');
  const deniedPid = 2147483646, alive = path.join(markers, 'permission.json');
  const fixture = h.write('pid-fixture.mjs', `const original=process.kill;process.kill=(pid,...args)=>{if(pid===${deniedPid})throw Object.assign(new Error('denied'),{code:'EPERM'});return original(pid,...args);};`);
  h.env.NODE_OPTIONS = `--import=${pathToFileURL(fixture).href}`;
  write(alive, { cwd: h.cwd, run_dir: h.cwd, pid: deniedPid, expires_at: expiry });
  assert.equal(guard(h, undefined).decision, 'deny'); assert.equal(fs.existsSync(alive), true);
});

test('agy uninstall 未装时不新建配置，缺条目时原文和时间不变', async (t) => {
  const h = sandbox(t), dir = globalDir(h), file = path.join(dir, 'hooks.json');
  const absent = output(await h.bridge(['agy-guard', 'uninstall']));
  assert.equal(absent.installed, false); assert.equal(absent.message, M.agyNotInstalled); assert.equal(fs.existsSync(dir), false);
  write(file, '{ "other": { "Stop": [] } }\n');
  const before = read(file), mtime = fs.statSync(file).mtimeMs;
  write(path.join(dir, 'foreman-agy-guard.cmd'), 'orphan');
  const orphan = output(await h.bridge(['agy-guard', 'uninstall']));
  assert.equal(orphan.installed, false); assert.equal(read(file), before); assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(fs.existsSync(path.join(dir, 'foreman-agy-guard.cmd')), false);
  assert.equal(MESSAGES.en.agyNotInstalled, "The foreman guard for agy isn't installed; nothing to remove.");
});

test('agy install、status、uninstall 保留其他条目、备份和独立副本', async (t) => {
  const h = sandbox(t), dir = globalDir(h), original = { other: { Stop: [{ command: 'echo harmless' }] } };
  write(path.join(dir, 'hooks.json'), original);
  const installed = await install(h);
  assert.deepEqual(JSON.parse(read(installed.backup)), original);
  assert.equal(read(path.join(dir, 'foreman-agy-guard.mjs')), read(GUARD));
  assert.ok([...read(GUARD).matchAll(/from '([^']+)'/g)].every((m) => m[1].startsWith('node:')));
  const hooks = JSON.parse(read(path.join(dir, 'hooks.json')));
  assert.deepEqual(hooks.other, original.other);
  const group = hooks['foreman-guard'].PreToolUse[0];
  assert.equal(group.matcher, '*'); assert.equal(group.hooks[0].timeout, 10);
  assert.equal(group.hooks[0].command, process.platform === 'win32' ? '.\\foreman-agy-guard.cmd' : './foreman-agy-guard.sh');
  assert.ok(read(path.join(dir, 'foreman-agy-guard.cmd')).includes(process.execPath));
  assert.ok(read(path.join(dir, 'foreman-agy-guard.sh')).includes(process.execPath));
  assert.equal(output(await h.bridge(['agy-guard', 'status'])).valid, false);
  output(await h.bridge(['agy-guard', 'uninstall']));
  assert.deepEqual(JSON.parse(read(path.join(dir, 'hooks.json'))), original);
  assert.equal(fs.existsSync(path.join(dir, 'foreman-agy-guard.mjs')), false);
  assert.equal(output(await h.bridge(['agy-guard', 'status'])).installed, false);
  const races = await Promise.all([h.bridge(['agy-guard', 'install']), h.bridge(['agy-guard', 'install'])]);
  for (const r of races) assert.ok(fs.existsSync(output(r).backup));
  assert.deepEqual(JSON.parse(read(path.join(dir, 'hooks.json'))).other, original.other);
  write(path.join(dir, 'hooks.json'), '{broken');
  failed(await h.bridge(['agy-guard', 'install']), M.agyInvalidHooks(path.join(dir, 'hooks.json'), '').split('：')[0]);
  assert.equal(read(path.join(dir, 'hooks.json')), '{broken');
});

test('agy 启动器缺依赖时有策略 deny、无策略 ask，且不依赖 PATH 的 node', async (t) => {
  const h = sandbox(t); await install(h);
  const dir = globalDir(h), script = path.join(dir, 'foreman-agy-guard.mjs');
  const invoke = (env) => spawnSync(process.platform === 'win32' ? h.env.COMSPEC : '/bin/sh', process.platform === 'win32'
    ? ['/d', '/s', '/c', '.\\foreman-agy-guard.cmd'] : ['./foreman-agy-guard.sh'], { cwd: dir, env: { ...h.env, PATH: '', NoDefaultCurrentDirectoryInExePath: '1', ...env }, input: '{}', encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(invoke({}).stdout).decision, 'ask');
  fs.rmSync(script);
  assert.equal(JSON.parse(invoke({}).stdout).decision, 'ask');
  assert.equal(JSON.parse(invoke({ FOREMAN_AGY_GUARD: '{}' }).stdout).decision, 'deny');
});

test('agy 自检静态扫描四种目录、祖先、add-dir、插件和大小写，拒绝前不启动 agy', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  h.initGit(); fs.mkdirSync(path.join(h.cwd, 'nested'));
  const cases = [['.agents/hooks.json', {}], ['.AGENT/MCP_CONFIG.JSON', {}], ['_agents/plugins.json', {}], ['_AGENT/plugins/p/manifest', 'plugin']];
  for (const [file, value] of cases) {
    h.write(file, value);
    const r = output(await run(h), 1); assert.equal(r.status, 'failed'); assert.ok(r.errors.some((e) => e.includes(file.includes('/plugins/') ? 'plugins' : path.basename(file))), JSON.stringify(r.errors));
    fs.rmSync(path.join(h.cwd, file.split('/')[0]), { recursive: true, force: true });
  }
  const extra = path.join(h.home, 'extra'); write(path.join(extra, '.agents/hooks.json'), {});
  assert.equal(output(await run(h, ['--add-dir', extra]), 1).status, 'failed');
  h.write('.agents/hooks.json', {});
  assert.equal(output(await run(h, ['--cwd', path.join(h.cwd, 'nested')]), 1).status, 'failed');
  assert.equal(h.calls().filter((c) => c.tool === 'agy').length, 0);
});

test('agy 自检严格校验全局 JSON、事件、matcher、timeout、命令、enabled 和其他钩子', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const file = path.join(globalDir(h), 'hooks.json'), original = JSON.parse(read(file));
  const variants = [null, '{bad', '{"foreman-guard":{},"foreman-guard":{}}', {}, { ...original, other: { Stop: [{ command: 'echo' }] } },
    ...[(x) => { x.enabled = false; }, (x) => { x.PreToolUse[0].matcher = 'read_file'; }, (x) => { x.PreToolUse[0].hooks[0].timeout = 11; },
      (x) => { x.PreToolUse[0].hooks[0].command = 'node alternative'; }, (x) => { x.Stop = [{ command: 'echo' }]; }].map((change) => { const x = structuredClone(original); change(x['foreman-guard']); return x; })];
  for (const value of variants) {
    if (value === null) fs.rmSync(file); else write(file, value);
    assert.equal(output(await run(h), 1).status, 'failed');
  }
  assert.equal(h.calls().filter((c) => c.tool === 'agy').length, 0);
});

test('agy 自检在锁中刷新哈希、空目录核对插件钩子，并提示全局 MCP 和 skills', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  write(path.join(globalDir(h), 'foreman-agy-guard.cmd'), 'tampered'); h.write('.agents/skills.json', {});
  write(path.join(globalDir(h), 'mcp_config.json'), { mcpServers: { global: { command: 'fake' }, disabled: { disabled: true } } });
  const r = output(await run(h)); assert.equal(r.status, 'done');
  assert.ok(r.notes.includes(M.agyGuardRewritten)); assert.ok(r.notes.includes(M.agyGlobalMcp('global'))); assert.ok(r.notes.some((n) => n.includes('skills.json')));
  assert.equal(output(await h.bridge(['agy-guard', 'status'])).valid, true);
  assert.ok(h.calls().filter((c) => c.operation === 'hooks').every((c) => c.cwd !== h.cwd && fs.existsSync(c.cwd) === false));
  h.scenario({ plugin_hooks: { plugin: { Stop: [{ command: 'echo' }] } } });
  const plugin = output(await run(h), 1); assert.ok(plugin.errors.includes(M.agyOtherHooks('plugin')));
  h.scenario({ hooks_output: 'unrecognized listing' });
  assert.equal(output(await run(h), 1).status, 'failed');
});

test('agy /hooks 只核对 command.data 的来源和唯一动作，response 不参与判断', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const source = path.join(globalDir(h), 'hooks.json');
  const command = JSON.parse(read(source))['foreman-guard'].PreToolUse[0].hooks[0].command;
  const expected = { name: 'foreman-guard', enabled: true, source, actions: [
    { event: 'PreToolUse', matcher: '*', type: 'command', command, timeout_seconds: 10 } ] };
  const body = (hooks) => ({ conversation_id: '', status: 'SUCCESS', response: 'foreman-guard\tenabled\tPreToolUse\t*\tcommand\tfake\n',
    command: { name: 'hooks', data: { hooks } } });
  const inspect = (value) => {
    h.scenario({ hooks_output: JSON.stringify(value) });
    return moduleCall(h, 'adapters/agy-setup.mjs', `try { const p=x.policyFor({cwd:${JSON.stringify(h.cwd)},runDir:${JSON.stringify(h.cwd)}}); const r=await x.prepareAgyRun(${JSON.stringify(agent())},p,Date.now()+60000); r.cleanup(); console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({error:e.message})); }`);
  };
  const good = structuredClone(expected); good.source = good.source.replaceAll('\\', '/');
  if (process.platform === 'win32') good.source = good.source.toUpperCase();
  good.extra_metadata = true; good.actions[0].extra_metadata = true;
  assert.equal(inspect({ ...body([good]), response: 'misleading text: unknown hook exists' }).ok, true);
  const changed = (fn) => { const hook = structuredClone(expected); fn(hook); return [hook]; };
  const invalid = [[], [expected, expected], [null], changed((h) => { delete h.name; }), changed((h) => { h.enabled = false; }),
    changed((h) => { h.source = 'relative/hooks.json'; }), changed((hook) => { hook.source = path.join(h.home, 'missing/hooks.json'); }),
    changed((hook) => { hook.source = write(path.join(h.home, 'other-hooks.json'), {}); }),
    changed((h) => { h.actions = []; }), changed((h) => { h.actions.push({ ...h.actions[0] }); }),
    ...Object.entries({ event: 'PostToolUse', matcher: 'read_file', type: 'other', command: 'node wrong.mjs', timeout_seconds: 11 })
      .map(([key, value]) => changed((h) => { h.actions[0][key] = value; }))];
  for (const hooks of invalid) assert.equal(inspect(body(hooks)).error, M.agyGuardInvalid, JSON.stringify(hooks));
  assert.equal(inspect(body([expected, { ...expected, name: 'plugin' }])).error, M.agyOtherHooks('plugin'));
  for (const value of [{ response: JSON.stringify({ hooks: { 'foreman-guard': {} } }) },
    { ...body([expected]), command: { name: 'other', data: { hooks: [expected] } } },
    { ...body([expected]), command: { name: 'hooks', data: { hooks: {} } } }]) assert.equal(inspect(value).error, M.agyHooksListing);
});

test('agy 原文形状的嵌套事件归一后保留时间线、步骤用量和最终回复', async (t) => {
  const h = sandbox(t); configure(h); await install(h); h.write('r.txt', 'hello\n');
  const sid = 'synthetic-real-shape', file = path.join(h.cwd, 'r.txt').replaceAll('\\', '/'), text = JSON.stringify(discussion);
  const events = [
    { event: 'init', conversation_id: sid, init: { model: agent().model, cwd: h.cwd, tools: ['read_file', 'run_command'], permission_mode: 'always-proceed' } },
    { event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'DONE', step_type: 'agent_response', duration_seconds: 4.94,
      usage: { input_tokens: 6844, output_tokens: 32, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 6876 } } },
    { event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: file } } } },
    { event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file', duration_seconds: 0.35,
      tool_info: { name: 'read_file', parameters: { Path: file }, output: '1 lines, 6 bytes' } } },
    { event: 'step_update', step_update: { conversation_id: sid, step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command',
      parameters: { CommandLine: 'echo hi', WaitMsBeforeAsync: 5000, toolSummary: 'Run echo command' } } } },
    { event: 'step_update', step_update: { conversation_id: sid, step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 3.17,
      tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'Command exited with code 0.\n\nCommand output:\nhi\r\n' } } },
    { event: 'step_update', step_update: { conversation_id: sid, step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: text } },
    { event: 'step_update', step_update: { conversation_id: sid, step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 3.07,
      usage: { input_tokens: 7047, output_tokens: 38, thinking_tokens: 3, cache_read_tokens: 13, total_tokens: 7085 } } },
    { event: 'result', result: { conversation_id: sid, status: 'SUCCESS', response: text + '\n', duration_seconds: 14.2, num_turns: 1,
      usage: { input_tokens: 20891, output_tokens: 70, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20961 } } },
  ];
  h.scenario({ no_init: true, no_reply: true, steps: [
    { event: { event: 'step_update', step_index: 99, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 999999 } } },
    ...events.map((event) => ({ event })),
    { event: { event: 'result', status: 'ERROR', response: 'this flat row must be ignored' } },
  ] });
  const result = output(await run(h)); assert.deepEqual(result.report, discussion); assert.equal(result.session_id, sid);
  assert.equal(read(path.join(result.run_dir, 'last-message.txt')), text + '\n');
  assert.deepEqual(result.usage, { input_tokens: 13904, cached_input_tokens: 13, output_tokens: 70, reasoning_output_tokens: 3 });
  const timeline = h.events(result.run_id), shell = timeline.filter((e) => e.item?.tool === 'run_command');
  assert.deepEqual(shell.map((e) => e.type), ['item.started', 'item.completed']); assert.equal(shell[0].item.id, shell[1].item.id);
  assert.equal(shell[1].item.command, 'echo hi'); assert.equal(shell[1].item.exit_code, 0); assert.match(shell[1].item.aggregated_output, /hi\r\n$/);
  const reader = timeline.find((e) => e.item?.tool === 'read_file'); assert.equal(reader.item.command, 'read_file r.txt');
  assert.equal(timeline.find((e) => e.item?.type === 'agent_message').item.text, text + '\n');
  const usage = timeline.filter((e) => e.type === 'step.usage'); assert.equal(usage.length, 2); assert.equal(usage[0].final, undefined); assert.equal(usage[1].final, true);
  const raw = lines(path.join(result.run_dir, 'agy.jsonl'));
  assert.deepEqual(raw.find((e) => e.event === 'result'), events.at(-1));
  assert.deepEqual(raw.find((e) => e.step_update?.step_index === 4 && e.step_update?.state === 'DONE'), events[5]);
  assert.equal(raw.some((e) => e.step_index === 99), false);
});

test('agy 工具错误对象和字符串识别守卫拒绝，命令输出解析退出码', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const error = 'tool call denied by pre-tool hook: foreman guard: read_file is not allowed in this run';
  h.scenario({ steps: [
    { tool: { name: 'run_command', args: { CommandLine: 'synthetic failure' } }, output: 'failed', exit_code: 7 },
    { tool: { name: 'read_file', args: { Path: path.join(h.home, 'outside.txt') } } },
    { event: { event: 'step_update', step_update: { step_index: 50, state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: {
      name: 'read_file', parameters: { Path: path.join(h.cwd, 'x') }, error } } } },
    { event: { event: 'step_update', step_update: { step_index: 51, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: {
      name: 'run_command', parameters: { CommandLine: 'plain output' }, output: 'no exit prefix' } } } },
  ] });
  const result = output(await run(h)), timeline = h.events(result.run_id);
  assert.equal(timeline.find((e) => e.type === 'item.completed' && e.item?.command === 'synthetic failure').item.exit_code, 7);
  assert.equal(timeline.find((e) => e.item?.command === 'plain output').item.exit_code, 0);
  assert.equal(result.questions.filter((q) => q.source === 'permission_denied').length, 2);
  const errors = timeline.filter((e) => e.type === 'item.completed' && e.item?.exit_code === 1);
  assert.equal(errors.length, 2); assert.ok(errors.every((e) => e.item.aggregated_output.startsWith('tool call denied by pre-tool hook: foreman guard:')));
  assert.ok(lines(path.join(result.run_dir, 'agy.jsonl')).some((e) => e.step_update?.tool_info?.error?.type === 'TOOL_ERROR'));
});

test('agy 守卫放行 ByteOffset；只读工具因不认识的参数被拦时记成说明，不算要决定的问题', async (t) => {
  const h = sandbox(t); configure(h); await install(h); h.write('source.txt', 'safe');
  const file = path.join(h.cwd, 'source.txt');
  h.scenario({ steps: [
    { tool: { name: 'read_file', args: { Path: file, StartLine: 1, EndLine: 5, ByteOffset: 0 } } },
    { tool: { name: 'read_file', args: { Path: file, FutureArg: 1 } } },
  ] });
  const r = output(await run(h)), decisions = lines(path.join(r.run_dir, 'agy-guard.jsonl'));
  assert.equal(r.status, 'done');
  assert.deepEqual(decisions.map((d) => d.decision), ['allow', 'deny']);
  assert.equal(r.questions.filter((q) => q.source === 'permission_denied').length, 0);
  assert.ok(r.notes.includes(M.agyGuardUnknownArg('read_file', 'FutureArg')));
});

test('agy 真启动器拒绝写工具，工具事件、权限问题、进度、用量与价格进入公共结果', async (t) => {
  const h = sandbox(t); configure(h); await install(h); h.write('source.txt', 'original');
  h.scenario({ steps: [
    { event: { event: 'step_update', step_update: { step_index: 100, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'working' } } },
    { tool: { name: 'read_file', args: { Path: path.join(h.cwd, 'source.txt') } } },
    { tool: { name: 'write_file', args: { Path: path.join(h.cwd, 'source.txt'), Content: 'bad' } } },
    { tool: { name: 'run_command', args: { CommandLine: 'git --version' } }, output: 'synthetic git' },
  ] });
  const r = output(await run(h));
  assert.equal(r.agent_type, 'agy cli'); assert.equal(r.status, 'done'); assert.equal(read(path.join(h.cwd, 'source.txt')), 'original');
  assert.deepEqual(r.usage, { input_tokens: 13, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2 });
  assert.equal(r.usage_scope, 'this_run'); assert.equal(r.cost_source, 'api_price');
  assert.ok(r.questions.some((q) => q.source === 'permission_denied'));
  const ev = h.events(r.run_id), commands = ev.filter((e) => e.item?.tool === 'run_command');
  assert.equal(commands[0].item.id, commands[1].item.id); assert.ok(commands.every((e) => !e.aid));
  assert.equal(new Set(ev.filter((e) => e.type === 'item.completed' && e.item.id).map((e) => e.item.id)).size, 3);
  assert.ok(ev.some((e) => e.type === 'agy.progress')); assert.equal(ev.filter((e) => e.type === 'step.usage' && e.final).length, 1);
  assert.ok(lines(path.join(r.run_dir, 'agy-guard.jsonl')).some((d) => d.decision === 'deny'));
  h.initGit(); h.write('source.txt', 'after'); h.scenario({ steps: [{ tool: { name: 'read_file', args: { Path: path.join(h.cwd, 'source.txt') } } }] });
  const reviewed = output(await h.bridge(taskArgs(h, 'review', ['--agent', 'agy'])));
  assert.equal(reviewed.status, 'done'); assert.ok(reviewed.report.verdict); assert.match(read(path.join(reviewed.run_dir, 'review.patch')), /source.txt/);
  assert.equal(read(path.join(h.cwd, 'source.txt')), 'after');
});

test('agy 下一轮、回答和报告修复续接同一会话，修复用 none，用量只算本轮各步', async (t) => {
  const h = sandbox(t); configure(h, (c) => { c.dispatch.discuss_max_rounds = 3; }); await install(h);
  const captured = path.join(h.home, 'policies.jsonl');
  h.scenario({ guard_file: captured, calls: [{ last_message: 'invalid JSON' }, { last_message: discussion }] });
  const first = output(await run(h)), requests = h.calls().filter((c) => c.operation === 'run');
  assert.equal(first.sandbox, 'agy-sandbox'); assert.equal(JSON.parse(read(path.join(first.run_dir, 'meta.json'))).sandbox, first.sandbox);
  assert.equal(requests.length, 2); assert.ok(requests[1].args.includes('--conversation')); assert.equal(requests[1].args.includes('--sandbox'), false);
  const events = h.events(first.run_id).filter((e) => e.type === 'step.usage'); assert.equal(events.length, 2); assert.equal(events[0].final, undefined); assert.equal(events[1].final, true);
  assert.equal(first.usage.input_tokens, 26); assert.equal(first.usage.output_tokens, 10);
  h.scenario({ guard_file: captured });
  const second = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-']));
  assert.equal(second.session_id, first.session_id); assert.equal(second.usage.input_tokens, 13);
  const third = output(await h.bridge(['resume', '--run', second.run_id, '--level', 'complex', '--brief', '-'], { input: '回答上一轮的问题' }));
  assert.equal(third.session_id, first.session_id);
  const policies = lines(captured); assert.ok(policies.every((c) => c.policy?.nonce));
  assert.ok(policies.some((c) => c.operation === 'probe' && c.policy.access === 'probe'));
  assert.ok(policies.some((c) => c.operation === 'run' && c.policy.access === 'none'));
  assert.ok(policies.some((c) => c.operation === 'run' && c.policy.access === 'read'));
});

test('agy 沙箱探针失败不给 shell、附文件清单，缓存按版本失效且 canary 清理', async (t) => {
  const h = sandbox(t); configure(h); await install(h); h.initGit();
  h.scenario({ sandbox: false }); const first = output(await run(h));
  assert.equal(first.sandbox, 'files-only'); assert.equal(JSON.parse(read(path.join(first.run_dir, 'meta.json'))).sandbox, first.sandbox);
  assert.ok(first.notes.includes(M.agyNoSandbox)); assert.match(read(path.join(first.run_dir, 'brief.md')), /source.txt/);
  assert.equal(h.calls().filter((c) => c.operation === 'run').at(-1).args.includes('--sandbox'), false);
  const probes = h.calls().filter((c) => c.operation === 'probe').length;
  const cached = output(await run(h)); assert.equal(h.calls().filter((c) => c.operation === 'probe').length, probes);
  assert.equal(cached.notes.some((n) => n.startsWith(M.agySandboxResult({}).split('{')[0])), false);
  h.scenario({ version: '1.4.9', probe_errors: { read_home: 'error:ENOENT' } });
  output(await run(h)); assert.equal(h.calls().filter((c) => c.operation === 'probe').length, probes + 1);
  const cache = JSON.parse(read(path.join(stateDir(h), 'agy-sandbox.json')));
  assert.equal(Object.keys(cache.entries).length, 2); assert.equal(Object.values(cache.entries).every((e) => e.available === false), true);
  assert.equal(fs.readdirSync(h.cwd).some((f) => f.startsWith('.foreman-agy-probe-')), false);
  assert.equal(fs.readdirSync(h.home).some((f) => f.startsWith('.foreman-agy-probe-')), false);
  assert.equal(fs.readdirSync(stateDir(h)).some((f) => f.startsWith('agy-probe-')), false);
  const layout = moduleCall(h, 'adapters/agy-setup.mjs', `console.log(JSON.stringify(await x.probeSandbox({agent:{},cwd:${JSON.stringify(h.home)},version:'1.4.9',run:()=>{throw new Error('probe must not start')}})));`);
  assert.equal(layout.available, false); assert.equal(layout.results.layout, 'unavailable');
});

test('agy 网络探针对照区分权限拒绝、普通断网和超时，未确认不写缓存', (t) => {
  const h = sandbox(t); configure(h); fs.mkdirSync(stateDir(h), { recursive: true });
  const capture = path.join(h.home, 'network-controls.jsonl');
  const cases = [
    ['error:EPERM', [{}, { https_error: 'ECONNREFUSED' }], 'sandbox_denied', true],
    ['error:EACCES', [{}, { response_error: true }], 'sandbox_denied', true],
    ...['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].map((code) => [`error:${code}`, [{}, {}], 'sandbox_denied', true]),
    ['error:ENOTFOUND', [{}, { dns_error: 'ENOTFOUND' }], 'unconfirmed', false],
    ['error:ECONNREFUSED', [{}, { https_error: 'ECONNREFUSED' }], 'unconfirmed', false],
    // 超时这类说不清原因的错误按 unconfirmed：不给 shell，也不写缓存。
    ['error:ETIMEDOUT', [{}, {}], 'unconfirmed', false], ['error:ECONNRESET', [{}, {}], 'unconfirmed', false], ['allowed', [{}, {}], 'allowed', false],
  ];
  const probe = (network, version) => moduleCall(h, 'adapters/agy-setup.mjs', `console.log(JSON.stringify(await x.probeSandbox({cwd:${JSON.stringify(h.cwd)},version:${JSON.stringify(version)},run:async(options)=>({status:'done',tools:options.probeCommands.map(command=>{const code=Buffer.from(/Buffer\\.from\\('([^']+)'/.exec(command)[1],'base64').toString();const prefix=/FOREMAN_AGY_PROBE:[^"']+:/.exec(code)[0];const name=/name:["']([^"']+)["']/.exec(code)[1];return {tool:'run_command',output:prefix+JSON.stringify({name,value:name==='network'?${JSON.stringify(network)}:name==='environment'?true:'sandbox_denied'})};})})})));`);
  for (const [i, [network, controls, expected, available]] of cases.entries()) {
    h.scenario({ network_controls: controls, network_capture: capture });
    const result = probe(network, `network-${i}`);
    assert.equal(result.results.network, expected); assert.equal(result.available, available); assert.equal(result.results.network_error, network);
    assert.equal(result.tested, true); assert.equal(result.results.network_control.before.dns, !controls[0].dns_error);
    assert.equal(result.results.network_control.after.https, !controls[1].dns_error && !controls[1].https_error);
    const store = fs.existsSync(path.join(stateDir(h), 'agy-sandbox.json')) ? JSON.parse(read(path.join(stateDir(h), 'agy-sandbox.json'))) : { entries: {} };
    assert.equal(!!store.entries[result.key], expected !== 'unconfirmed');
    if (expected !== 'unconfirmed') {
      const before = lines(capture).length, warm = probe(network, `network-${i}`);
      assert.equal(warm.tested, undefined); assert.equal(lines(capture).length, before);
    }
  }
  assert.ok(lines(capture).every((c) => c.target === (c.stage === 'dns' ? 'example.com' : 'https://example.com')));
});

test('agy 跨盘即使有可用缓存也不读写缓存、不跑探针，根和设备任一不同都拒绝 shell', async (t) => {
  const h = sandbox(t); configure(h); await install(h); output(await run(h));
  const extra = path.join(h.home, 'extra'); fs.mkdirSync(extra);
  const cache = path.join(stateDir(h), 'agy-sandbox.json'), before = read(cache), probes = modelCalls(h).length;
  for (const kind of ['root', 'dev']) {
    const fixture = h.write(`volume-${kind}.mjs`, `import fs from 'node:fs';import path from 'node:path';
const extra=${JSON.stringify(extra)},cache=${JSON.stringify(cache)},read=fs.readFileSync,write=fs.writeFileSync,stat=fs.statSync;
fs.readFileSync=(file,...args)=>{if(file===cache)throw Error('cache read');return read(file,...args)};
fs.writeFileSync=(file,...args)=>{if(String(file).startsWith(cache))throw Error('cache write');return write(file,...args)};
${kind === 'dev' ? "fs.statSync=(file,...args)=>{const s=stat(file,...args);if(file===extra)s.dev+=1;return s};"
      : "path.parse=(parse=>file=>file===fs.realpathSync(extra)?{...parse(file),root:'different'}:parse(file))(path.parse);"}`);
    const env = { NODE_OPTIONS: `${h.env.NODE_OPTIONS} --import=${pathToFileURL(fixture).href}` };
    const result = output(await run(h, ['--add-dir', extra], { env }));
    assert.equal(result.sandbox, 'files-only'); assert.ok(result.notes.includes(M.agyNoShellCrossVolume));
    assert.equal(h.calls().filter((c) => c.operation === 'run').at(-1).args.includes('--sandbox'), false);
    assert.equal(modelCalls(h).filter((c) => c.operation === 'probe').length, 1);
    assert.equal(read(cache), before);
    const checked = moduleCall({ ...h, env: { ...h.env, ...env } }, 'adapters/agy-setup.mjs', `console.log(JSON.stringify(await x.probeSandbox({cwd:${JSON.stringify(h.cwd)},addDirs:[${JSON.stringify(extra)}],force:true,version:'1.4.8',run:()=>{throw Error('probe started')}})));`);
    assert.deepEqual(checked.results, { layout: 'cross_volume' }); assert.equal(checked.available, false);
  }
  assert.equal(modelCalls(h).length, probes + 2);
});

test('agy 同目录的大小写盘符不算跨盘', { skip: process.platform !== 'win32' }, (t) => {
  const h = sandbox(t); configure(h); fs.mkdirSync(stateDir(h), { recursive: true });
  const upper = h.cwd[0].toUpperCase() + h.cwd.slice(1), lower = h.cwd[0].toLowerCase() + h.cwd.slice(1);
  const result = moduleCall(h, 'adapters/agy-setup.mjs', `import fs from 'node:fs';const real=fs.realpathSync;
fs.realpathSync=Object.assign((file,...args)=>{const p=real(file,...args);return file===${JSON.stringify(lower)}?p[0].toLowerCase()+p.slice(1):p[0].toUpperCase()+p.slice(1)},real);
console.log(JSON.stringify(await x.probeSandbox({cwd:${JSON.stringify(upper)},addDirs:[${JSON.stringify(lower)}],version:'case',run:async()=>({status:'done',tools:[]})})));`);
  assert.equal(result.tested, true); assert.equal(result.results.layout, undefined);
});

test('agy 宿主 DNS 或 HTTPS 断网时不放 canary、不启动探针、不写缓存，联网后重测', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const capture = path.join(h.home, 'offline-network.jsonl'), cache = path.join(stateDir(h), 'agy-sandbox.json');
  for (const control of [{ dns_error: 'ENOTFOUND' }, { https_error: 'ECONNREFUSED' }]) {
    h.scenario({ network_controls: [control], network_capture: capture });
    const result = moduleCall(h, 'adapters/agy-setup.mjs', `import fs from 'node:fs';const write=fs.writeFileSync;fs.writeFileSync=(file,...args)=>{if(String(file).includes('.foreman-agy-probe-'))throw Error('canary created');return write(file,...args)};
console.log(JSON.stringify(await x.probeSandbox({cwd:${JSON.stringify(h.cwd)},version:'offline',run:()=>{throw Error('probe started')}})));`);
    assert.equal(result.available, false); assert.equal(result.tested, true); assert.equal(result.results.network, 'host_offline');
    assert.equal(result.results.network_control.after, undefined); assert.equal(fs.existsSync(cache), false);
    h.scenario({ network_controls: [control] });
    const dispatched = output(await run(h)); assert.equal(dispatched.sandbox, 'files-only'); assert.ok(dispatched.notes.includes(M.agyNoShellOffline));
    assert.equal(h.calls().some((c) => c.operation === 'probe'), false); assert.equal(fs.existsSync(cache), false);
    assert.equal(h.calls().filter((c) => c.operation === 'run').at(-1).args.includes('--sandbox'), false);
  }
  assert.equal(lines(capture).length, 3);
  h.scenario({}); assert.equal(output(await run(h)).sandbox, 'agy-sandbox');
  assert.equal(h.calls().filter((c) => c.operation === 'probe').length, 1); assert.equal(fs.existsSync(cache), true);
});

test('agy 不可用缓存 24 小时后重测，可用缓存不过期，check --reprobe 只删除本键再测', async (t) => {
  const h = sandbox(t); configure(h); await install(h); h.scenario({ sandbox: false });
  const check = async (args = []) => output(await h.bridge(['check', '--agent', 'agy', ...args])).agents.agy.sandbox;
  const first = await check(), cache = path.join(stateDir(h), 'agy-sandbox.json'), store = JSON.parse(read(cache));
  h.scenario({}); assert.equal((await check()).tested, undefined);
  store.entries[first.key].at = new Date(Date.now() - 86400001).toISOString(); write(cache, store);
  assert.equal((await check()).available, true); assert.equal(h.calls().filter((c) => c.operation === 'probe').length, 2);
  const positive = JSON.parse(read(cache)); positive.entries[first.key].at = '2000-01-01T00:00:00Z'; write(cache, positive);
  assert.equal((await check()).tested, undefined); assert.equal(h.calls().filter((c) => c.operation === 'probe').length, 2);
  const other = { ...positive.entries[first.key], key: 'other' }; positive.entries.other = other; write(cache, positive);
  h.scenario({ sandbox: false }); assert.equal((await check(['--reprobe'])).available, false);
  assert.equal(h.calls().filter((c) => c.operation === 'probe').length, 3); assert.deepEqual(JSON.parse(read(cache)).entries.other, other);
  h.scenario({}); output(await h.bridge(['check', '--agent', 'codex', '--reprobe']));
  assert.equal(h.calls().filter((c) => c.operation === 'probe').length, 3);
  for (const locale of ['zh', 'en']) assert.equal((await h.bridge(['check', '--reprobe', '--help'], { env: { FOREMAN_LANG: locale } })).stdout.trim(), MESSAGES[locale].help.check);
});

test('agy 缓存锁忙仍返回探针结论，force 删除失败仍重测，总时限不能吞掉', (t) => {
  const h = sandbox(t); configure(h); fs.mkdirSync(stateDir(h), { recursive: true });
  const result = moduleCall(h, 'adapters/agy-setup.mjs', `import fs from 'node:fs';import {acquireLock} from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS, 'locks.mjs')).href)};
let runs=0;const options={cwd:${JSON.stringify(h.cwd)},version:'locked',deadline:Infinity,run:async({probeCommands})=>{runs++;return {status:'done',tools:probeCommands.map(command=>{
const code=Buffer.from(/Buffer\\.from\\('([^']+)'/.exec(command)[1],'base64').toString(),prefix=/FOREMAN_AGY_PROBE:[^"']+:/.exec(code)[0],name=/name:["']([^"']+)["']/.exec(code)[1];
return {tool:'run_command',output:prefix+JSON.stringify({name,value:name==='environment'?true:'sandbox_denied'})}})}}};
await x.probeSandbox(options);const cache=${JSON.stringify(path.join(stateDir(h), 'agy-sandbox.json'))},before=fs.readFileSync(cache,'utf8');
const lock=await acquireLock(${JSON.stringify(path.join(stateDir(h), 'agy-guard.lock'))},{waitMs:1000,busy:()=>{throw Error('lock setup failed')}}),read=fs.readFileSync,now=Date.now;let offset=0;
// 锁由活进程持有，推进锁的时钟，避免测试真等一分钟。
Date.now=()=>now()+offset;fs.readFileSync=(file,...args)=>{const text=read(file,...args);if(file===lock.file)offset+=61000;return text};
try{const fresh=await x.probeSandbox({...options,version:'uncached'});let forced;try{forced=await x.probeSandbox({...options,force:true})}catch(e){forced={error:e.message}}const completed=runs,expired=[];
for(const force of [false,true])try{await x.probeSandbox({...options,version:force?'locked':'expired',force,deadline:Date.now()+30000})}catch(e){expired.push(e.code)}
console.log(JSON.stringify({fresh:fresh.available,forced:forced.error,runs:completed,unchanged:read(cache,'utf8')===before,expired}));
}finally{Date.now=now;fs.readFileSync=read;lock.release()}`);
  // 旧的可用结论删不掉时，强制重测直接报错，不能让它继续留着放行命令。
  assert.ok(result.forced.startsWith(M.agyCacheStale(path.join(stateDir(h), 'agy-sandbox.json'), '').trimEnd()));
  assert.deepEqual({ ...result, forced: undefined }, { fresh: true, forced: undefined, runs: 2, unchanged: true, expired: ['ETIMEDOUT', 'ETIMEDOUT'] });
});

test('agy 两个并发探针写缓存时锁内重读，保留两个版本的键且探针本身不占锁', async (t) => {
  const h = sandbox(t); configure(h); fs.mkdirSync(stateDir(h), { recursive: true });
  const cache = path.join(stateDir(h), 'agy-sandbox.json'), ready = [1, 2].map((i) => path.join(h.home, `probe-${i}`));
  const script = h.write('cache-race.mjs', `import fs from 'node:fs';import {probeSandbox} from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS, 'adapters/agy-setup.mjs')).href)};
const i=Number(process.argv[2]),ready=${JSON.stringify(ready)},cache=${JSON.stringify(cache)},read=fs.readFileSync;let reads=0;
fs.readFileSync=(file,...args)=>{if(file!==cache)return read(file,...args);let text;try{text=read(file,...args)}catch(e){if(e.code!=='ENOENT')throw e;text='{"entries":{}}'}
if(++reads===2){fs.writeFileSync(ready[i]+'.merge','');const until=Date.now()+500;while(!fs.existsSync(ready[1-i]+'.merge')&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}return text};
console.log(JSON.stringify(await probeSandbox({cwd:${JSON.stringify(h.cwd)},version:'race-'+i,run:async(options)=>{fs.writeFileSync(ready[i],'');
while(!fs.existsSync(ready[1-i]))await new Promise(r=>setTimeout(r,10));return {status:'done',tools:options.probeCommands.map(command=>{const code=Buffer.from(/Buffer\\.from\\('([^']+)'/.exec(command)[1],'base64').toString();const prefix=/FOREMAN_AGY_PROBE:[^"']+:/.exec(code)[0],name=/name:["']([^"']+)["']/.exec(code)[1];return {tool:'run_command',output:prefix+JSON.stringify({name,value:name==='environment'?true:'sandbox_denied'})}})}}})));`);
  const results = await Promise.all([0, 1].map((i) => h.start(script, [i]).done));
  const entries = JSON.parse(read(cache)).entries; assert.equal(Object.keys(entries).length, 2);
  for (const result of results) { const tested = output(result); assert.equal(tested.available, true); assert.equal(entries[tested.key].available, true); }
});

test('agy 标记缓存本进程启动时间，查不到时省略字段且不重复查询，也不再启动心跳', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  for (const available of [true, false]) {
    const result = moduleCall(h, 'adapters/agy-setup.mjs', `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';let queries=0;
const spawn=cp.spawnSync;cp.spawnSync=(file,...args)=>{if(file==='ps'||file.endsWith('powershell.exe')){queries++;if(!${available})return {stdout:''}}return spawn(file,...args)};syncBuiltinESMExports();
globalThis.setInterval=()=>{throw Error('unexpected heartbeat')};
const policies=[0,1].map(()=>x.policyFor({cwd:${JSON.stringify(h.cwd)},runDir:${JSON.stringify(h.cwd)}})),prepared=[];
for(const p of policies)prepared.push(await x.prepareAgyRun(${JSON.stringify(agent())},p,Date.now()+120000));
const times=policies.map(p=>JSON.parse(fs.readFileSync(${JSON.stringify(path.join(stateDir(h), 'agy-markers'))}+'/'+p.nonce+'.json','utf8')).started_at??null);
for(const p of prepared)p.cleanup();console.log(JSON.stringify({queries,times}));`);
    // 查到了就缓存；查不到下次再查（每次最多 5 秒）。
    assert.ok(available ? result.queries === 1 : result.queries >= 2, String(result.queries)); assert.equal(result.times[0], result.times[1]);
    assert.equal(Number.isFinite(result.times[0]), available);
  }
});

test('agy 总时限覆盖版本查询、hooks、探针和宿主网络对照，到期不再派模型', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  for (const phase of ['version', 'hooks', 'probe', 'network']) {
    const scenario = h.scenario(phase === 'network' ? { network_controls: [{ dns_hang: true }] } : { [`${phase}_delay_ms`]: 5000 }, `deadline-${phase}`);
    const started = Date.now(), result = output(await run(h, ['--timeout', '0.02'], { env: scenario.env } ), 1);
    assert.equal(result.status, 'timeout', phase); assert.ok(Date.now() - started < 4500, phase);
    assert.equal(scenario.calls().some((c) => c.operation === 'run'), false, phase);
    if (phase === 'version' || phase === 'network') assert.equal(scenario.calls().some((c) => c.operation === 'probe'), false);
    assert.equal(fs.existsSync(path.join(stateDir(h), 'agy-sandbox.json')), false);
    assert.equal(fs.readdirSync(path.join(stateDir(h), 'agy-markers')).filter((f) => f.endsWith('.json')).length, 0);
  }
  const started = h.calls().length;
  const expired = moduleCall(h, 'adapters/agy-setup.mjs', `try{x.queryAgy(${JSON.stringify(agent())},['--version'],60000,Date.now()-1);}catch(e){console.log(JSON.stringify({code:e.code}));}`);
  assert.equal(expired.code, 'ETIMEDOUT'); assert.equal(h.calls().length, started);
});

test('agy check 按 --cwd 扫描和探针，令牌读取仍在 agy-work', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const target = path.join(h.home, 'target'), bad = path.join(target, '.agents/hooks.json'); write(bad, {});
  const rejected = output(await h.bridge(['check', '--agent', 'agy', '--cwd', target]), 1).agents.agy;
  assert.ok(rejected.error.includes(bad)); assert.equal(h.calls().filter((c) => c.tool === 'agy').length, 0);
  fs.rmSync(path.join(target, '.agents'), { recursive: true });
  const capture = path.join(h.home, 'check-target.jsonl'); h.scenario({ guard_file: capture });
  assert.equal(output(await h.bridge(['check', '--agent', 'agy', '--cwd', target])).agents.agy.ok, true);
  assert.equal(h.calls().find((c) => c.operation === 'probe').cwd, target);
  const policies = lines(capture); assert.equal(policies.find((c) => c.operation === 'probe').policy.root, target);
  assert.ok(policies.find((c) => c.operation === 'run').policy.root.startsWith(path.join(stateDir(h), 'agy-work')));
});

test('agy 提示词在探针后选择读命令权限，讨论和审查无 shell 都附清单', async (t) => {
  const h = sandbox(t); configure(h); await install(h); h.initGit(); h.write('source.txt', 'review this change\n');
  for (const shell of [true, false]) {
    h.scenario({ sandbox: shell, version: shell ? 'prompt-shell' : 'prompt-no-shell' });
    for (const mode of ['discuss', 'review']) {
      const result = output(await h.bridge(taskArgs(h, mode, ['--agent', 'agy'])));
      const prompt = read(path.join(result.run_dir, 'brief.md'));
      const request = h.calls().filter((c) => c.operation === 'run').at(-1);
      assert.equal(JSON.parse(request.stdin).message.content, prompt);
      assert.equal(request.args.includes('--sandbox'), shell);
      if (mode === 'discuss') assert.ok(prompt.includes(M.agyDiscussFooter(h.cwd, read(path.join(SCRIPTS, '../schemas/discuss.schema.json')), shell)));
      else assert.ok(prompt.includes(shell ? '也可以用 run_command 在 agy 的沙箱里跑只读命令' : '这次不能运行命令，也没有搜索工具'));
      assert.equal(prompt.includes('你只能用读文件和搜索工具'), false);
      assert.equal(prompt.includes('项目的 git ls-files 清单'), !shell);
      if (!shell) assert.ok(prompt.endsWith('source.txt'));
    }
  }
  for (const locale of ['zh', 'en']) {
    const text = MESSAGES[locale];
    for (const shell of [true, false]) {
      const footer = text.agyDiscussFooter('project', 'schema', shell);
      assert.equal(footer.slice(footer.indexOf('\n- ', footer.indexOf('\n- ') + 1)), text.opencodeDiscussFooter('project', 'schema').slice(text.opencodeDiscussFooter('project', 'schema').indexOf('\n- ', text.opencodeDiscussFooter('project', 'schema').indexOf('\n- ') + 1)));
      const review = text.agyReviewPrompt('project', 'scope', shell);
      assert.ok(review.includes(shell ? 'run_command' : locale === 'en' ? "you can't run commands this time and have no search tool" : '这次不能运行命令，也没有搜索工具'));
    }
  }
});

test('agy 两席同时启动时 hooks 查询不占锁且每次请求只查一次', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const warm = output(await run(h)); assert.ok(warm.notes.some((n) => n.startsWith(M.agySandboxResult({}).split('{')[0])));
  const probes = h.calls().filter((c) => c.operation === 'probe').length, hooks = h.calls().filter((c) => c.operation === 'hooks').length;
  h.scenario({ hooks_delay_ms: 11000 });
  const first = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'agy']), { timeout: 30000 });
  const second = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'agy']), { timeout: 30000 });
  for (const result of await Promise.all([first.done, second.done])) assert.equal(output(result).status, 'done');
  assert.equal(h.calls().filter((c) => c.operation === 'probe').length, probes);
  assert.equal(h.calls().filter((c) => c.operation === 'hooks').length - hooks, 2);
  assert.equal(fs.readdirSync(path.join(stateDir(h), 'agy-markers')).filter((f) => f.endsWith('.json')).length, 0);
});

test('agy hooks 查完再拿锁核对文件快照，期间变动就拒绝派模型', async (t) => {
  const h = sandbox(t); configure(h); await install(h); output(await run(h));
  const ready = path.join(h.home, 'hooks-ready'), gate = path.join(h.home, 'hooks-release');
  const scenario = h.scenario({ hooks_ready: ready, hooks_wait_for: gate }, 'changing-hooks');
  const running = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'agy']), { env: scenario.env });
  await poll(() => fs.existsSync(ready), 'hooks 查询开始');
  const file = path.join(globalDir(h), 'hooks.json'), hooks = JSON.parse(read(file)); hooks['foreman-guard'].enabled = true; write(file, hooks);
  write(gate, 'go');
  const result = output(await running.done, 1); assert.ok(result.errors.includes(M.agyGuardInvalid));
  assert.equal(scenario.calls().some((c) => c.operation === 'run'), false);
});

test('agy 看板回放里移出配置的历史协作方仍是两个并发', (t) => {
  const h = sandbox(t); configure(h);
  const at = Date.now(), session = 'test-session', claude = path.join(h.home, 'claude');
  const row = (type, time, content) => JSON.stringify({ type, cwd: h.cwd, timestamp: new Date(time).toISOString(), message: { content } });
  write(path.join(claude, 'project', `${session}.jsonl`), row('user', at - 10000, 'start') + '\n' + row('assistant', at, [{ type: 'text', text: 'done' }]) + '\n');
  seedRun(h, 'old-agy', { agent: 'removed', agent_type: 'agy cli', claude_session: session, status: 'done', started_at: new Date(at - 8000).toISOString(), ended_at: new Date(at - 2000).toISOString(), kind: 'discuss' },
    { status: 'done', report: discussion }, []);
  const replay = moduleCall(h, 'board/universe.mjs', `const replay=x.createUniverse({runs:${JSON.stringify(h.runs)},config:${JSON.stringify(h.userConfig)},claudeDir:${JSON.stringify(claude)},now:()=>${at},prices:null}).replay();console.log(JSON.stringify(replay.timeline.filter(m=>m.event==='agents').flatMap(m=>m.data.agents).filter(a=>a.id==='removed')));`);
  assert.ok(replay.length); assert.ok(replay.every((a) => a.max_parallel === 2));
});

test('agy 每轮必须有决定记录，丢失环境变量被启动标记拦下；结束后删除标记', async (t) => {
  const h = sandbox(t); configure(h); await install(h); h.write('source.txt', 'safe');
  const steps = [{ tool: { name: 'read_file', args: { Path: path.join(h.cwd, 'source.txt') } } }];
  h.scenario({ skip_hooks: true, steps }); const missing = output(await run(h), 1); assert.ok(missing.errors.includes(M.agyDecisionsMissing));
  // 丢了策略的那一轮被标记拦下，拒绝记在 stray 文件里，不算这一轮的守卫生效证据，所以这一轮判失败。
  h.scenario({ drop_guard_env: true, steps }); const dropped = output(await run(h), 1);
  assert.ok(dropped.errors.includes(M.agyDecisionsMissing));
  assert.ok(lines(path.join(dropped.run_dir, 'agy-guard-stray.jsonl')).some((d) => d.decision === 'deny' && d.reason.includes(`foreman is running agy in this folder (run ${dropped.run_id})`)));
  assert.equal(fs.existsSync(path.join(dropped.run_dir, 'agy-guard.jsonl')), false);
  assert.ok(dropped.questions.some((q) => q.source === 'permission_denied')); assert.equal(read(path.join(h.cwd, 'source.txt')), 'safe');
  assert.equal(fs.readdirSync(path.join(stateDir(h), 'agy-markers')).filter((f) => f.endsWith('.json')).length, 0);
});

test('agy check 六步、models 两列、清理密钥环境以及模型身份和价格', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const groups = [{ name: 'Gemini', buckets: [
    { name: 'Gemini weekly', window: 'weekly', remaining_fraction: 0.1, reset_time: '2026-11-02T00:00:00Z' },
    { name: 'Gemini 5h', window: '5h', remaining_fraction: 0.09, reset_time: '2026-10-28T10:00:00Z' } ] },
    { name: 'Claude/GPT', buckets: [{ name: 'Claude/GPT weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: '2026-11-03T00:00:00Z' }] }];
  const file = path.join(h.home, 'env.jsonl'); h.scenario({ guard_file: file, check_whitespace: true,
    quota: { status: 'SUCCESS', response: 'all groups 99% remaining', command: { name: 'usage', data: { groups } } } });
  const result = output(await h.bridge(['check', '--agent', 'agy'], { env: { OPENAI_API_KEY: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic', SSH_AUTH_SOCK: 'synthetic', GEMINI_API_KEY: 'synthetic-agy' } }));
  const checked = result.agents.agy; assert.equal(checked.ok, true); assert.match(checked.reply, /^[a-f0-9-]{36}$/); assert.ok(checked.notes.includes(M.agyQuotaLow));
  assert.deepEqual(checked.quota.groups, groups);
  const calls = h.calls().filter((c) => c.tool === 'agy'); assert.equal(calls[0].operation, 'version'); assert.equal(calls[1].operation, 'catalog');
  assert.ok(calls.findIndex((c) => c.operation === 'hooks') < calls.findIndex((c) => c.operation === 'probe'));
  assert.ok(calls.findIndex((c) => c.operation === 'probe') < calls.findIndex((c) => c.operation === 'run')); assert.equal(calls.at(-1).operation, 'quota');
  const request = calls.find((c) => c.operation === 'run'), prompt = JSON.parse(request.stdin).message.content;
  assert.equal(prompt, M.agyCheckPrompt(path.join(request.cwd, 'guard-check.txt')));
  assert.notEqual(request.cwd, h.cwd); assert.equal(fs.existsSync(request.cwd), false);
  const runPolicy = lines(file).find((c) => c.operation === 'run').policy;
  assert.equal(runPolicy.root, request.cwd); assert.equal(runPolicy.run_dir, request.cwd);
  assert.ok(lines(file).every((c) => c.policy && c.env.OPENAI_API_KEY === null && c.env.AWS_SECRET_ACCESS_KEY === null && c.env.SSH_AUTH_SOCK === null && c.env.GEMINI_API_KEY === 'synthetic-agy'));
  const models = output(await h.bridge(['models'])); assert.equal(models.tools['agy cli'].ok, true); assert.equal(models.agents.agy.listed, true);
  assert.deepEqual(models.tools['agy cli'].models[0].efforts, ['low', 'medium', 'high']); assert.equal(models.tools['agy cli'].models[0].default_effort, null);
  assert.ok(models.tools['agy cli'].raw_ids.includes('gemini-3.8-flash-high'));
  const markdown = await h.bridge(['models', '--format', 'md']); assert.equal(markdown.code, 0); assert.ok(markdown.stdout.includes('| gemini-3.8-flash | low / medium / high |')); assert.ok(markdown.stdout.includes('Agy CLI 4'));
  assert.ok(markdown.stdout.includes(`${M.reportAgyTitle}\n\n| 模型 | 推理强度 | 上下文 | 已配置 |`)); assert.ok(markdown.stdout.includes('| claude-opus-4-6-thinking | — 只能不写 |'));
  const english = await h.bridge(['models', '--format', 'md'], { env: { FOREMAN_LANG: 'en' } });
  assert.ok(english.stdout.includes(`${MESSAGES.en.reportAgyTitle}\n\n| Model | Effort | Context | Configured |`));
  const prices = moduleCall(h, 'prices.mjs', `console.log(JSON.stringify({gemini:x.priceFor('gemini-3.8-flash-high',{input:1000000},x.loadPrices()),opus:x.priceFor('claude-opus-4-6-thinking',{input:1000000},x.loadPrices()),oss:x.priceFor('gpt-oss-120b-medium',{input:1000000,output:1000000},x.loadPrices()),key:x.modelIdentity('claude-opus-4-6-thinking')}));`);
  assert.ok(prices.gemini > 0); assert.equal(prices.opus, 5); assert.equal(prices.oss, 0.75); assert.equal(prices.key, 'claude-opus-4-6');
});

test('agy check 核对格子覆写的模型，不写 effort 的格子也算', async (t) => {
  const h = sandbox(t); configure(h, (c) => { c.modules.review.complex = [{ agent: 'agy', model: 'missing-model' }]; }); await install(h);
  h.scenario({});
  const r = await h.bridge(['check', '--agent', 'agy']), checked = JSON.parse(r.stdout).agents.agy;
  assert.equal(checked.ok, false);
  const entry = checked.efforts.find((e) => e.model === 'missing-model');
  assert.equal(entry.ok, false); assert.ok(entry.problem.includes('missing-model'));
});

test('agy 沙箱运行各用一个空的 git 全局配置，每次清空重写', (t) => {
  const h = sandbox(t); configure(h);
  const envs = moduleCall(h, 'adapters/agy-setup.mjs', `const fs=await import('node:fs');
const a=x.policyFor({cwd:process.cwd(),runDir:process.cwd(),access:'read',sandbox:true}), b=x.policyFor({cwd:process.cwd(),runDir:process.cwd(),access:'read',sandbox:true});
const first=x.guardEnvironment(a).GIT_CONFIG_GLOBAL; fs.writeFileSync(first,'[include]\\n\\tpath = C:/blocked');
const again=x.guardEnvironment(a).GIT_CONFIG_GLOBAL, other=x.guardEnvironment(b).GIT_CONFIG_GLOBAL;
console.log(JSON.stringify({first,again,other,content:fs.readFileSync(again,'utf8'),none:x.guardEnvironment(x.policyFor({cwd:process.cwd(),runDir:process.cwd()})).GIT_CONFIG_GLOBAL??null}));`);
  assert.equal(envs.first, envs.again); assert.notEqual(envs.first, envs.other); assert.equal(envs.content, ''); assert.equal(envs.none, h.env.GIT_CONFIG_GLOBAL ?? null);
});

test('agy 查询遇到账号 EOF 等两秒仅重试一次，每次仍有策略并清理标记', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const capture = path.join(h.home, 'query-policies.jsonl');
  h.scenario({ guard_file: capture, calls: [{ eligibility_error: true }, {}] });
  const args = [['-p', '/hooks', '--output-format', 'json'], ['-p', '/quota', '--output-format', 'json'], ['models'], ['--version']];
  const results = moduleCall(h, 'adapters/agy-setup.mjs', `console.log(JSON.stringify(${JSON.stringify(args)}.map(args=>{const started=Date.now();const r=x.queryAgy(${JSON.stringify(agent())},args,10000);return {status:r.status,error:r.error?.message,elapsed:Date.now()-started};})));`);
  assert.ok(results.every((r) => r.status === 0 && !r.error && r.elapsed >= 2000));
  for (const operation of ['hooks', 'quota', 'catalog', 'version']) assert.equal(h.calls().filter((c) => c.operation === operation).length, 2);
  const policies = lines(capture); assert.equal(policies.length, 8); assert.equal(new Set(policies.map((c) => c.policy.nonce)).size, 8);
  assert.equal(fs.readdirSync(path.join(stateDir(h), 'agy-markers')).filter((f) => f.endsWith('.json')).length, 0);
  const persistent = h.scenario({ eligibility_error: true }, 'persistent'); h.env.FAKE_SCENARIO = persistent.file;
  const exhausted = moduleCall(h, 'adapters/agy-setup.mjs', `const r=x.queryAgy(${JSON.stringify(agent())},['-p','/hooks','--output-format','json'],10000);console.log(JSON.stringify({status:r.status,error:r.error?.message}));`);
  assert.match(exhausted.error, /Eligibility check failed[\s\S]*EOF/); assert.equal(persistent.calls().length, 2);
});

test('agy check 只接受令牌及 read_file allow，额度只读各桶数值', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  const check = async (scenario, ok) => {
    h.scenario(scenario);
    const result = output(await h.bridge(['check', '--agent', 'agy']), ok ? 0 : 1).agents.agy;
    assert.equal(result.ok, ok); return result;
  };
  assert.ok((await check({ no_check_tool: true }, false)).error);
  assert.ok((await check({ last_message: 'wrong token' }, false)).error);
  assert.ok((await check({ check_tool: 'view_file' }, false)).error.includes(M.agyDecisionsMissing));
  assert.ok((await check({ skip_hooks: true }, false)).error.includes(M.agyDecisionsMissing));
  const quota = { command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [
    { name: 'weekly', window: 'weekly', remaining_fraction: 0.1, reset_time: '2026-11-02T00:00:00Z' },
    { name: 'short', window: '5h', remaining_fraction: 0.9, reset_time: '2026-10-28T10:00:00Z' } ] }] } }, response: 'Gemini\tweekly\t1%' };
  assert.equal((await check({ quota }, true)).notes.includes(M.agyQuotaLow), false);
  assert.equal((await check({ quota: { response: 'Gemini 1%' } }, false)).error, M.agyQuotaInvalid);
  h.scenario({ agy_catalog: [] });
  const catalog = moduleCall(h, 'adapters/index.mjs', `console.log(JSON.stringify(x.adapters['agy cli'].catalog(${JSON.stringify(agent())})));`);
  assert.equal(catalog.ok, false); assert.equal(catalog.error, M.agyCatalogInvalid);
});

test('agy 配置拒绝 run、词表外 effort 和完整 ID 重复指定档位；默认并发共用同一函数', async (t) => {
  const h = sandbox(t); configure(h);
  const cfg = output(await h.bridge(['config'])); assert.equal(cfg.agents_status.agy.max_parallel, 2); assert.equal(cfg.agents_status.codex.max_parallel, 4);
  assert.deepEqual(cfg.agents_status.agy.capabilities.modes, ['discuss', 'review']);
  configure(h, (c) => { c.modules.run.complex = [{ agent: 'agy' }]; }); failed(await h.bridge(['config']), 'agy');
  configure(h, (c) => { c.modules.discuss.complex[0].effort = 'off'; }); failed(await h.bridge(['config']), 'default / minimal / low / medium / high / xhigh / max');
  configure(h, (c) => { c.modules.discuss.complex[0].model = 'gemini-3.8-flash-high'; });
  failed(await h.bridge(['config']), M.agyEffortFullId('gemini-3.8-flash-high', 'high', 'gemini-3.8-flash'));
  configure(h); failed(await run(h, ['--model', 'gemini-3.8-flash-high', '--effort', 'low']), M.agyEffortFullId('gemini-3.8-flash-high', 'low', 'gemini-3.8-flash'));
  configure(h, (c) => { c.modules.discuss.complex[0].effort = null; }); output(await h.bridge(['config']));
  const limits = moduleCall(h, 'config.mjs', `console.log(JSON.stringify([x.agentMaxParallel({type:'agy cli'}),x.agentMaxParallel({type:'pi cli'}),x.agentMaxParallel({type:'agy cli',max_parallel:7})]));`);
  assert.deepEqual(limits, [2, 4, 7]);
});

test('agy 默认并发准入、排队、status 和看板 channel 共用接线', async (t) => {
  const h = sandbox(t); const c = configure(h); await install(h);
  for (const id of ['agy-one', 'agy-two']) seedRun(h, id, { agent: 'agy', agent_type: 'agy cli', model: agent().model, status: 'running', pid: process.pid, kind: 'discuss' });
  const blocked = await run(h, ['--queue-timeout', '0']); failed(blocked, '2');
  const queued = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'agy', '--queue-timeout', '0.01']));
  assert.equal((await queued.done).code, 2);
  const status = output(await h.bridge(['status', '--run', 'agy-one'])); assert.equal(status.agent_type || status.meta?.agent_type, 'agy cli');
  const data = moduleCall(h, 'board/universe.mjs', `console.log(JSON.stringify(x.agentSlots([{id:'agy',type:'agy cli'}],[])));`);
  assert.equal(data[0].max_parallel, 2);
  assert.ok(read(path.join(ROOT, 'board/web/06-cards.js')).includes("'agy cli': 'Agy CLI'"));
  assert.ok(read(path.join(ROOT, 'board/web/07-uni-side.js')).includes("'agy cli': 'agy'"));
});

test('agy 运行时 install/uninstall/刷新拒绝；取消、超时和异常退出都删启动标记', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  h.scenario({ hold: true }); const child = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'agy']));
  const meta = await h.running();
  await poll(() => h.calls().some((c) => c.operation === 'run'), 'agy 真运行');
  for (const action of ['install', 'uninstall']) failed(await h.bridge(['agy-guard', action]), 'agy');
  const status = output(await h.bridge(['agy-guard', 'status'])); assert.ok(status.active.length);
  const launcher = path.join(globalDir(h), 'foreman-agy-guard.cmd'), original = read(launcher); write(launcher, 'changed');
  const refresh = output(await run(h), 1); assert.ok(refresh.errors.some((e) => e.includes('agy') && e.includes('运行')));
  write(launcher, original);
  output(await h.bridge(['cancel', '--run', meta.id])); const cancelled = output(await child.done, 1); assert.equal(cancelled.status, 'cancelled');
  h.scenario({ hold: true }); const timeout = output(await run(h, ['--timeout', '0.04']), 1); assert.equal(timeout.status, 'timeout');
  h.scenario({ no_result: true }); assert.equal(output(await run(h), 1).status, 'failed');
  assert.equal(fs.readdirSync(path.join(stateDir(h), 'agy-markers')).filter((f) => f.endsWith('.json')).length, 0);
});

test('agy 工具运行时不判卡死，空转会卡死，进程信号后清理标记', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  h.scenario({ steps: [{ tool: { name: 'run_command', args: { CommandLine: 'synthetic long command' } }, before: [{ delay_ms: 1500 }] }] });
  assert.equal(output(await run(h, ['--stall', '0.001'])).status, 'done');
  h.scenario({ steps: [{ delay_ms: 1500 }] }); assert.equal(output(await run(h, ['--stall', '0.001']), 1).status, 'stalled');
  const before = h.calls().filter((c) => c.operation === 'run').length;
  h.scenario({ hold: true }); const child = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'agy']));
  await poll(() => h.calls().filter((c) => c.operation === 'run').length > before, '启动标记');
  // Windows 的强制终止不能运行 JS 收尾；由前面的 cancel 测试验证可捕获的结束路径。
  if (process.platform !== 'win32') { child.child.kill('SIGTERM'); output(await child.done, 1); }
  else { const meta = await h.running(); output(await h.bridge(['cancel', '--run', meta.id])); output(await child.done, 1); }
  assert.equal(fs.readdirSync(path.join(stateDir(h), 'agy-markers')).filter((f) => f.endsWith('.json')).length, 0);
});

test('agy 状态以 result 为准：无效模型、累计用量忽略、空回复、会话丢失和额度错误', async (t) => {
  const h = sandbox(t); configure(h); await install(h);
  h.scenario({ invalid_model: true }); const invalid = output(await run(h), 1); assert.equal(invalid.status, 'failed'); assert.equal(invalid.usage, null); assert.ok(invalid.errors.some((e) => e.includes('invalid model')));
  h.scenario({ no_completed: true }); const noUsage = output(await run(h)); assert.equal(noUsage.usage, null); assert.equal(noUsage.usage_scope, null);
  h.scenario({ result_status: 'ERROR', result_error: 'RESOURCE_EXHAUSTED quota', last_message: '' }); assert.equal(output(await run(h), 1).status, 'quota_exhausted');
  // 实测：模型已经交回完整回复之后 agy 才报 400，回复照常采用，错误记进 notes。
  h.scenario({ result_status: 'ERROR', result_error: 'INVALID_ARGUMENT (code 400): Request contains an invalid argument.', exit_code: 1 });
  const late = output(await run(h)); assert.equal(late.status, 'done');
  assert.ok(late.notes.includes(M.agyErrorAfterReply('INVALID_ARGUMENT (code 400): Request contains an invalid argument.')));
  h.scenario({ last_message: '', denied_actions: ['permission denied'] }); assert.ok(output(await run(h), 1).errors.includes(M.agyUncaughtDenial));
  h.scenario({}); const first = output(await run(h));
  h.scenario({ conversation_id: 'different-conversation' }); const mismatch = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-']), 1);
  assert.equal(mismatch.status, 'failed'); assert.ok(mismatch.errors.some((e) => e.includes('different-conversation')));
  h.scenario({ no_init: true, no_reply: true, steps: [{ event: { event: 'result', result: { conversation_id: 'synthetic-decode-error', status: 'ERROR', response: '',
    error: 'failed to decode stream input: synthetic malformed request', usage: { input_tokens: 9999 } } } }] });
  const decode = output(await run(h), 1); assert.equal(decode.status, 'failed'); assert.equal(decode.usage, null); assert.equal(decode.session_id, 'synthetic-decode-error');
  assert.ok(decode.errors.some((e) => e.includes('failed to decode stream input')));
});

test('agy 直接调用守卫只放行管理查询，提示参数、裸调用和绝对路径均拦下', async (t) => {
  const h = sandbox(t);
  for (const command of ['agy models', 'agy agents', 'agy changelog', 'agy help', 'agy --version', 'agy models --help']) assert.equal((await h.hook('guard-direct-calls.mjs', { tool_input: { command } })).code, 0, command);
  for (const command of ['agy', 'agy -p hi', 'agy -p=hi', 'agy --print hi', 'agy --prompt=hi', 'agy -i file', 'agy --input-format stream-json',
    'agy models -p hi', 'agy help --prompt=hi', 'agy --version -p hi', 'agy models -- hi', '& "C:\\fake\\agy.exe" -p hi'])
    assert.equal((await h.hook('guard-direct-calls.mjs', { tool_input: { command } })).code, 2, command);
});
