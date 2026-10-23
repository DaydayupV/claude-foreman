import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, output, failed, read, json, hostArgs, apiAgent, ROOT, CODEX, MESSAGES, DEFAULT_SEATS } from './helpers.mjs';
import { discussion } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const planArgs = (h, module = 'discuss', seats = ['codex'], cell = 'complex') => ['plan', '--cwd', h.cwd, '--module', module,
  '--cell', cell, '--group', 'seats-group', ...seats.flatMap((seat) => ['--seat', seat])];
const url = (file) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', file)).href;

for (const codex of [false, true]) test(`${codex ? '有' : '没有'} Codex 的初始配置都写满三级 seats`, async (t) => {
  const h = sandbox(t, { config: false }), s = h.scenario({ logged_in: true });
  const script = h.write('starter-seats.mjs', `import { adapters } from ${JSON.stringify(url('adapters/index.mjs'))};
import { loadConfig } from ${JSON.stringify(url('config.mjs'))};
for (const type of ['codex cli', 'opencode cli', 'pi cli']) adapters[type].locate = () =>
  type === 'codex cli' && ${codex} ? { file: process.execPath, pre: [${JSON.stringify(CODEX)}] }
    : { file: ${JSON.stringify(path.join(h.home, 'missing-cli.exe'))}, pre: [] };
console.log(JSON.stringify(loadConfig(null, adapters)));`);
  const r = await h.start(script, [], { env: s.env }).done, cfg = output(r);
  for (const module of ['discuss', 'review']) {
    assert.deepEqual(json(h.userConfig).modules[module].seats, DEFAULT_SEATS[module]);
    assert.deepEqual(cfg.modules[module].seats, DEFAULT_SEATS[module]);
  }
  assert.equal(Object.keys(cfg.agents).length, codex ? 2 : 0);
  assert.ok(r.stderr.includes(M.starterCreated(h.userConfig, (codex ? M.starterCodex('gpt-6.1-sol', 'gpt-6-astra') : M.starterNoCodex) + M.starterNext)));
  assert.equal(fs.existsSync(`${h.userConfig}.bak`), false);
});

test('未写 seats 时并发首次读取只补写和提示一次，保留原字段且只备份一次', async (t) => {
  const h = sandbox(t), c = baseConfig();
  for (const module of ['discuss', 'review']) delete c.modules[module].seats;
  c.dispatch.max_seats = 9; c.custom = { keep: true }; c.modules.discuss.simple = { agent: 'codex' };
  h.config(c);
  const before = read(h.userConfig);
  const results = await Promise.all(Array.from({ length: 4 }, () => h.bridge(['config'])));
  for (const r of results) {
    const cfg = output(r);
    for (const module of ['discuss', 'review']) {
      assert.deepEqual(cfg.effective.modules[module].seats, DEFAULT_SEATS[module]);
      assert.deepEqual(cfg.resolved_modules[module].seats, DEFAULT_SEATS[module]);
      assert.deepEqual(cfg.summary.modules[module].seats, DEFAULT_SEATS[module]);
      assert.deepEqual(json(h.userConfig).modules[module], { ...c.modules[module], seats: DEFAULT_SEATS[module] });
    }
    assert.equal(cfg.effective.dispatch.max_seats, undefined);
    assert.deepEqual(cfg.effective, output(results[0]).effective);
  }
  const message = M.configSeatsWritten(h.userConfig, `${h.userConfig}.bak`, '讨论 2/4/8、审查 1/2/2');
  assert.equal(results.filter((r) => r.stderr === `foreman: ${message}\n`).length, 1);
  assert.ok(results.every((r) => r.stderr === '' || r.stderr === `foreman: ${message}\n`));
  assert.equal(json(h.userConfig).dispatch.max_seats, 9); assert.deepEqual(json(h.userConfig).custom, c.custom);
  assert.equal(Object.hasOwn(json(h.userConfig), 'levels'), false);
  assert.equal(read(`${h.userConfig}.bak`), before);
  assert.deepEqual(fs.readdirSync(path.dirname(h.userConfig)).filter((name) => name.includes('.bak')), ['config.json.bak']);
  assert.equal((await h.bridge(['config'])).stderr, '');
});

test('seats 已写全时不补写 max_seats，也不改写文件或备份', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.modules.review.seats.normal = 1;
  h.config(c);
  const before = read(h.userConfig), r = await h.bridge(['config']);
  output(r);
  assert.equal(r.stderr, '');
  assert.equal(read(h.userConfig), before);
  assert.equal(fs.existsSync(`${h.userConfig}.bak`), false);
});

for (const missing of ['discuss', 'review']) test(`部分 seats 和缺少整个 ${missing} 模块时补写，不增加格子`, async (t) => {
  const h = sandbox(t), c = baseConfig(), module = missing === 'discuss' ? 'review' : 'discuss'; delete c.modules[missing];
  c.agents.second = { ...c.agents.codex };
  c.modules[module].simple = [{ agent: 'codex', required: true }, { agent: 'second', required: true }];
  c.modules[module].seats = { complex: 5 }; h.config(c);
  const before = read(h.userConfig), cfg = output(await h.bridge(['config']));
  const expected = { ...DEFAULT_SEATS[module], simple: 2, complex: 5 };
  assert.deepEqual(cfg.effective.modules[missing].seats, DEFAULT_SEATS[missing]);
  assert.deepEqual(cfg.effective.modules[module].seats, expected);
  assert.deepEqual(cfg.resolved_modules[module].seats, expected);
  assert.deepEqual(json(h.userConfig).modules[missing], { seats: DEFAULT_SEATS[missing] });
  assert.deepEqual(json(h.userConfig).modules[module], { ...c.modules[module], seats: expected });
  assert.equal(read(`${h.userConfig}.bak`), before);
  assert.equal(Object.hasOwn(json(h.userConfig), 'levels'), false);
});

for (const module of ['discuss', 'review']) test(`${module} 补写的 seats 不少于必选数，只提示本次补写的模块`, async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.agents.third = { ...c.agents.codex };
  delete c.modules[module].seats;
  c.modules[module].simple = ['codex', 'second', 'third'].map((agent) => ({ agent, required: true })); h.config(c);
  const before = read(h.userConfig), r = await h.bridge(['config']), cfg = output(r);
  assert.deepEqual(cfg.effective.modules[module].seats, { ...DEFAULT_SEATS[module], simple: 3 });
  assert.deepEqual(cfg.resolved_modules[module].seats, { ...DEFAULT_SEATS[module], simple: 3 });
  assert.deepEqual(json(h.userConfig).modules[module].seats, cfg.effective.modules[module].seats);
  assert.equal(read(`${h.userConfig}.bak`), before);
  assert.equal(r.stderr, `foreman: ${M.configSeatsWritten(h.userConfig, `${h.userConfig}.bak`, `${M.reportModuleNames[module]} ${Object.values(cfg.effective.modules[module].seats).join('/')}`)}\n`);
});

for (const [lang, note] of [['zh', '手写的说明'], ['en', '']]) test(`只补 seats 保留已有 levels 说明和备份，提示使用 ${lang}`, async (t) => {
  const h = sandbox(t), c = baseConfig(); delete c.modules.review.seats; c.levels = note; h.config(c);
  fs.writeFileSync(`${h.userConfig}.bak`, 'earlier backup');
  const before = read(h.userConfig), r = await h.bridge(['config'], { env: { FOREMAN_LANG: lang } }); output(r);
  const backups = fs.readdirSync(path.dirname(h.userConfig)).filter((name) => name.startsWith('config.json.bak-'));
  assert.equal(backups.length, 1);
  const bak = path.join(path.dirname(h.userConfig), backups[0]);
  assert.equal(read(`${h.userConfig}.bak`), 'earlier backup'); assert.equal(read(bak), before);
  assert.deepEqual(json(h.userConfig), { ...c, modules: { ...c.modules, review: { ...c.modules.review, seats: DEFAULT_SEATS.review } } });
  assert.equal(r.stderr, `foreman: ${MESSAGES[lang].configSeatsWritten(h.userConfig, bak, `${MESSAGES[lang].reportModuleNames.review.toLowerCase()} 1/2/2`)}\n`);
});

test('seats 与旧结构和 levels 在同一次迁移写入，必选数按改名去重后的格子计算', async (t) => {
  const h = sandbox(t), agent = { ...baseConfig().agents.codex, type: 'codex' };
  h.config({ agents: { first: agent, second: agent }, levels: { review: { simple: [
    { agent: 'first', required: true }, { agent: 'second', required: true },
  ] } } });
  const before = read(h.userConfig), r = await h.bridge(['config']), cfg = output(r);
  for (const module of ['discuss', 'review']) assert.deepEqual(json(h.userConfig).modules[module].seats, DEFAULT_SEATS[module]);
  assert.equal(cfg.effective.modules.review.simple.length, 1);
  assert.equal(json(h.userConfig).levels, M.levelsNote); assert.equal(read(`${h.userConfig}.bak`), before);
  assert.ok(r.stderr.includes(M.configModulesMigrated(h.userConfig, `${h.userConfig}.bak`)));
  assert.ok(r.stderr.includes(M.configStructureMigrated(h.userConfig, `${h.userConfig}.bak`, 'first → fake-codex、second → fake-codex')));
  assert.ok(r.stderr.includes(M.configSeatsWritten(h.userConfig, `${h.userConfig}.bak`, '讨论 2/4/8、审查 1/2/2')));
  assert.deepEqual(fs.readdirSync(path.dirname(h.userConfig)).filter((name) => name.includes('.bak')), ['config.json.bak']);
});

test('用户配置替换被拒绝时提示失败，内存补齐并缓存结果，清理临时文件和锁', async (t) => {
  const h = sandbox(t), c = baseConfig(); delete c.modules.discuss;
  c.agents.second = { ...c.agents.codex };
  c.modules.review.simple = [{ agent: 'codex', required: true }, { agent: 'second', required: true }];
  c.modules.review.seats = { complex: 5 }; h.config(c);
  const before = read(h.userConfig), script = h.write('denied-seats.mjs', `import fs from 'node:fs';
import { loadConfig } from ${JSON.stringify(url('config.mjs'))};
import { adapters } from ${JSON.stringify(url('adapters/index.mjs'))};
const rename = fs.renameSync;
fs.renameSync = (from, to) => { if (to === ${JSON.stringify(h.userConfig)}) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return rename(from, to); };
console.log(JSON.stringify([loadConfig(null, adapters), loadConfig(null, adapters)]));`);
  const r = await h.start(script).done, [first, second] = output(r);
  assert.deepEqual(first, second);
  assert.deepEqual(first.modules.discuss.seats, DEFAULT_SEATS.discuss);
  assert.deepEqual(first.modules.review.seats, { simple: 2, normal: DEFAULT_SEATS.review.normal, complex: 5 });
  assert.equal(r.stderr, `foreman: ${M.configSeatsWriteFailed(h.userConfig, 'EACCES')}\n`);
  assert.equal(read(h.userConfig), before); assert.equal(read(`${h.userConfig}.bak`), before);
  assert.equal(fs.readdirSync(path.dirname(h.userConfig)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('改写锁：空的残留锁放久了会被清掉，活进程的锁等满 10 秒后放弃改写并退回内存', async (t) => {
  const h = sandbox(t), c = baseConfig(); delete c.modules.discuss.seats; h.config(c);
  const lock = `${h.userConfig}.structure.lock`, old = new Date(Date.now() - 60000);
  fs.writeFileSync(lock, ''); fs.utimesSync(lock, old, old);
  const cleared = await h.bridge(['config']);
  assert.ok(cleared.stderr.includes(M.configSeatsWritten(h.userConfig, `${h.userConfig}.bak`, '讨论 2/4/8')));
  assert.deepEqual(JSON.parse(read(h.userConfig)).modules.discuss.seats, DEFAULT_SEATS.discuss);
  assert.equal(fs.existsSync(lock), false);
  delete c.modules.discuss.seats; h.config(c);
  fs.writeFileSync(lock, String(process.pid));
  const before = read(h.userConfig), started = Date.now(), waited = await h.bridge(['config']);
  assert.ok(Date.now() - started >= 10000);
  assert.equal(output(waited).effective.modules.discuss.seats.complex, DEFAULT_SEATS.discuss.complex);
  assert.ok(waited.stderr.includes(M.configSeatsWriteFailed(h.userConfig, M.configLockTimeout(lock))));
  assert.equal(read(h.userConfig), before); assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  fs.rmSync(lock);
});

test('改写保留原配置文件的权限', { skip: process.platform === 'win32' }, async (t) => {
  const h = sandbox(t), c = baseConfig(); delete c.modules.review.seats; h.config(c);
  fs.chmodSync(h.userConfig, 0o600);
  const r = await h.bridge(['config']);
  assert.ok(r.stderr.includes(M.configSeatsWritten(h.userConfig, `${h.userConfig}.bak`, '审查 1/2/2')));
  assert.equal(fs.statSync(h.userConfig).mode & 0o777, 0o600);
});

test('seats 拒绝错误格式、未知等级和非正整数，错误配置不改写', async (t) => {
  const h = sandbox(t);
  for (const seats of [null, [], 2, { unknown: 1 }, { normal: 0 }, { normal: 1.5 }, { normal: '2' }]) {
    const c = baseConfig(); c.modules.discuss.seats = seats; h.config(c);
    const before = read(h.userConfig);
    const r = await h.bridge(['config']);
    failed(r, M.configInvalid('modules.discuss.seats', M.invalid.seats));
    // 缺级的错误 seats 不会先报一条误导的“改写失败”。
    assert.equal(r.stderr.includes(M.configMigrateFailed(h.userConfig, '<detail>').split('<detail>')[0]), false);
    assert.equal(read(h.userConfig), before);
    assert.equal(fs.existsSync(`${h.userConfig}.bak`), false);
  }
});

test('run 和 image 不允许写 seats', async (t) => {
  const h = sandbox(t);
  for (const module of ['run', 'image']) {
    const c = baseConfig(); c.modules[module].seats = { normal: 1 }; h.config(c);
    failed(await h.bridge(['config']), M.configInvalid(`modules.${module}.seats`, M.seatsModuleOnly));
  }
});

for (const module of ['discuss', 'review']) test(`${module} 显式填写的外部席位数不得少于必选数`, async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules[module].normal = [{ agent: 'codex', required: true }, { agent: 'second', required: true }];
  c.modules[module].seats = { normal: 1 }; h.config(c);
  const before = read(h.userConfig);
  failed(await h.bridge(['config']), M.seatsBelowRequired(`modules.${module}.seats.normal`, 1, 2));
  assert.equal(read(h.userConfig), before); assert.equal(fs.existsSync(`${h.userConfig}.bak`), false);
});

test('项目 seats 只能调低，未写的等级继承用户配置且不改写项目文件', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex }; c.agents.third = { ...c.agents.codex };
  c.modules.review.normal = [{ agent: 'codex', required: true }, { agent: 'second' }, { agent: 'third' }];
  c.modules.review.seats = { simple: 2, normal: 3, complex: 4 }; h.config(c);
  const file = h.write('.claude/foreman.json', { modules: { review: {
    normal: [{ agent: 'codex' }, { agent: 'second' }], seats: { normal: 2, complex: 5 },
  } } });
  const before = read(file), r = await h.bridge(['config', '--cwd', h.cwd]), cfg = output(r);
  assert.deepEqual(cfg.effective.modules.review.seats, { simple: 2, normal: 2, complex: 4 });
  assert.deepEqual(cfg.resolved_modules.review.seats, cfg.effective.modules.review.seats);
  assert.equal(cfg.resolved_modules.review.normal.length, 2);
  assert.ok(r.stderr.includes(M.projectLooser('modules.review.seats.complex', 5, 4)));
  assert.equal(read(file), before); assert.equal(fs.existsSync(`${file}.bak`), false);
  const p = output(await h.bridge([...planArgs(h, 'review', ['codex', 'second'], 'normal'), '--target', 'claims', '--file', h.write('claims.txt', '合成待审主张')]));
  assert.equal(p.seat_target, 2);
});

test('项目按补齐后的席位数收紧，低于必选数报错，整格关闭后免检', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  delete c.modules.review.seats;
  c.modules.review.simple = [{ agent: 'codex', required: true }, { agent: 'second', required: true }]; h.config(c);
  h.write('.claude/foreman.json', { modules: { review: { seats: { simple: 3 } } } });
  const raised = await h.bridge(['config', '--cwd', h.cwd]);
  assert.equal(output(raised).effective.modules.review.seats.simple, 2);
  assert.ok(raised.stderr.includes(M.projectLooser('modules.review.seats.simple', 3, 2)));
  h.write('.claude/foreman.json', { modules: { review: { seats: { simple: 1 } } } });
  failed(await h.bridge(['config', '--cwd', h.cwd]), M.projectCellSeatsBelowRequired('modules.review.seats.simple', 1, 2));
  const file = h.write('.claude/foreman.json', { modules: { review: { simple: 'claude code', seats: { simple: 1 } } } });
  const before = read(file), cfg = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.deepEqual(cfg.closed_by_project, ['review.simple']); assert.equal(cfg.effective.modules.review.seats.simple, 1);
  assert.equal(read(file), before);
});

for (const [module, configured, target] of [['discuss', 3, 2], ['review', 1, 1]]) test(`${module} 按 min(seats, usable) 建计划，数量偏离要理由并保存到计划和 status`, async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules[module].complex = [{ agent: 'codex' }, { agent: 'second' }]; c.modules[module].seats = { complex: configured }; h.config(c);
  const extra = module === 'review' ? ['--target', 'claims', '--file', h.write('claims.txt', '合成待审主张')] : [];
  const args = planArgs(h, module, target === 2 ? ['codex', 'second'] : ['codex']);
  const p = output(await h.bridge([...args, ...extra]));
  assert.equal(p.seat_target, target); assert.equal(p.count_why, null);
  assert.equal(json(p.file).seat_target, target); assert.equal(json(p.file).count_why, null);
  const status = output(await h.bridge(['status', '--plan', p.plan_id]));
  assert.equal(status.seat_target, target); assert.equal(status.count_why, null);
  const mismatch = planArgs(h, module, target === 2 ? ['codex'] : ['codex', 'second']);
  failed(await h.bridge([...mismatch, ...extra]), M.planSeatCount(`modules.${module}.seats.complex`, configured, target, target === 2 ? 1 : 2));
  const why = '用户调整了角色';
  for (const seats of [args, mismatch]) {
    const changed = output(await h.bridge([...seats, ...extra, '--count-why', why]));
    assert.equal(changed.count_why, why); assert.equal(json(changed.file).count_why, why);
    const status = output(await h.bridge(['status', '--plan', changed.plan_id]));
    assert.equal(status.seat_target, target); assert.equal(status.count_why, why);
  }
});

test('三级审查的补漏和 gap 大小写不敏感且不计入外部席位数', async (t) => {
  // 补漏席要换一个基础模型，second 用别的模型
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex, model: 'other-model' };
  c.modules.review.complex = [{ agent: 'codex' }, { agent: 'second' }]; c.modules.review.seats = { complex: 1 }; h.config(c);
  const extra = ['--target', 'claims', '--file', h.write('claims.txt', '合成待审主张')];
  const p = output(await h.bridge([...planArgs(h, 'review', ['codex', 'second= 补漏 ', 'second= GaP ']), ...extra]));
  assert.equal(p.seat_target, 1); assert.equal(p.count_why, null); assert.equal(p.seats.length, 3);
  failed(await h.bridge([...planArgs(h, 'review', ['codex=gap']), ...extra]), M.planSeatCount('modules.review.seats.complex', 1, 1, 0));
});

test('讨论里的补漏席照常计入外部席位数', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules.discuss.complex = [{ agent: 'codex' }, { agent: 'second' }]; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'discuss', ['codex=补漏', 'second=GaP'])));
  assert.equal(p.seat_target, 2); assert.equal(p.count_why, null);
  failed(await h.bridge(planArgs(h, 'discuss', ['codex', 'second=补漏', 'second=gap'])), M.planSeatCount('modules.discuss.seats.complex', DEFAULT_SEATS.discuss.complex, 2, 3));
});

test('一级和二级审查的补漏席照常计数', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  for (const cell of ['simple', 'normal']) c.modules.review[cell] = [{ agent: 'codex' }, { agent: 'second' }];
  c.modules.review.seats = { simple: 2, normal: 2 }; h.config(c);
  const extra = ['--target', 'claims', '--file', h.write('claims.txt', '合成待审主张')];
  for (const cell of ['simple', 'normal']) {
    const p = output(await h.bridge([...planArgs(h, 'review', ['codex=gap', 'second=补漏'], cell), ...extra]));
    assert.equal(p.seat_target, 2); assert.equal(p.count_why, null);
  }
});

test('visual 只把能看图的不同候选计入 usable，同一 agent 的多席仍按席数检查', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.api = apiAgent('http://127.0.0.1:1');
  c.modules.review.complex = [{ agent: 'codex' }, { agent: 'api' }]; h.config(c);
  h.write('shot.png', Buffer.from([137, 80, 78, 71]));
  const extra = ['--target', 'visual', '--file', 'shot.png'];
  const p = output(await h.bridge([...planArgs(h, 'review'), ...extra]));
  assert.equal(p.seat_target, 1); assert.equal(p.count_why, null);
  failed(await h.bridge([...planArgs(h, 'review', ['codex=视觉', 'codex=内容']), ...extra]), M.planSeatCount('modules.review.seats.complex', DEFAULT_SEATS.review.complex, 1, 2));
});

test('outside_cell 计划不检查数量，seat_target 为 null', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.discuss.complex = 'claude code'; h.config(c);
  const p = output(await h.bridge(planArgs(h, 'discuss', ['codex', 'codex'])));
  assert.equal(p.outside_cell, true); assert.equal(p.seat_target, null); assert.equal(p.count_why, null);
});

test('--count-why 只接受讨论和审查计划，不能绕过必选', async (t) => {
  const h = sandbox(t), extra = ['--count-why', '合成理由'];
  for (const module of ['run', 'image']) failed(await h.bridge([...planArgs(h, module), ...extra]), M.countWhyOnly);
  const c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules.discuss.complex = [{ agent: 'codex', required: true }, { agent: 'second', required: true }]; h.config(c);
  failed(await h.bridge([...planArgs(h), ...extra]), M.planMissingRequired('modules.discuss.complex', 'second'));
});

test('修改 seats 后已有计划仍可启动，新计划按新数量校验', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.second = { ...c.agents.codex };
  c.modules.discuss.complex = [{ agent: 'codex' }, { agent: 'second' }]; c.modules.discuss.seats = { complex: 1 }; h.config(c);
  const p = output(await h.bridge(planArgs(h))); output(await h.bridge(hostArgs(h, p)));
  c.modules.discuss.seats.complex = 2; h.config(c);
  failed(await h.bridge(planArgs(h)), M.planSeatCount('modules.discuss.seats.complex', 2, 2, 1));
  const s = h.scenario({ last_message: discussion });
  const started = output(await h.bridge(['discuss', '--plan', p.plan_id, '--seat', '1', '--brief', '-'], { env: s.env }));
  assert.equal(started.plan, p.plan_id); assert.equal(started.agent, 'codex');
  assert.equal(json(p.file).seat_target, 1);
});

