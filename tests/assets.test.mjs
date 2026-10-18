import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, json, taskArgs, MESSAGES } from './helpers.mjs';
import { canvas } from './fixtures/png.mjs';

const M = MESSAGES.zh;
const MAGENTA = [255, 0, 255], DARK = [34, 34, 34], ORANGE = [245, 165, 36], TEAL = [29, 91, 121];
const isPng = (file) => fs.readFileSync(file).subarray(1, 4).toString() === 'PNG';

test('assets template 画编号格子模板并按比例写出格子坐标', async (t) => {
  const h = sandbox(t), out = path.join(h.cwd, 'tpl/layout.png');
  const r = output(await h.bridge(['assets', 'template', '--out', out, '--cols', 3, '--rows', 2, '--names', 'a,b,c,d']));
  assert.equal(r.aspect, '3:2');
  assert.deepEqual(r.size, [1536, 1024]);
  assert.equal(r.slots, 4);
  assert.ok(isPng(out));
  const slots = json(r.slots_file);
  assert.deepEqual(slots.slots.map((s) => [s.slot, s.name]), [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
  for (const s of slots.slots) assert.ok(s.box.every((v) => v >= 0 && v <= 1) && s.box[0] < s.box[2] && s.box[1] < s.box[3]);
});

test('assets cut 抠掉品红底，按名单命名并写出部件、manifest 和对照拼图', async (t) => {
  const h = sandbox(t);
  const image = h.write('sheet.png', canvas(240, 160, MAGENTA, 3).rect(20, 40, 60, 110, DARK).rect(90, 40, 140, 110, ORANGE).rect(170, 40, 220, 110, TEAL).png());
  const out = path.join(h.cwd, 'cut');
  const r = output(await h.bridge(['assets', 'cut', '--image', image, '--out', out, '--names', 'a,b,c']));
  assert.equal(r.method, 'key');
  assert.equal(r.key, '#FF00FF');
  assert.ok(r.ok);
  assert.ok(r.transparent > 0.5);
  assert.deepEqual(r.parts.map((p) => p.name), ['a', 'b', 'c']);
  assert.deepEqual(r.checks, [{ id: 'names', status: 'pass', detail: M.assetsCheck.namesOk(3) }]);
  for (const f of ['alpha.png', 'sheet.png', 'parts/a.png', 'parts/b.png', 'parts/c.png']) assert.ok(isPng(path.join(out, f)), f);
  const manifest = json(path.join(out, 'manifest.json'));
  assert.deepEqual(manifest.parts.map((p) => [p.id, p.file]), [['a', 'parts/a.png'], ['b', 'parts/b.png'], ['c', 'parts/c.png']]);
  assert.equal(manifest.source.sha256, r.image_sha256);
  assert.deepEqual(json(path.join(out, 'report.json')).parts, r.parts);
});

test('assets cut 清理 image_gen 透明图的淡光晕，soft 保留柔边', async (t) => {
  const h = sandbox(t);
  const image = h.write('alpha.png', canvas(120, 100, [0, 0, 0, 0]).rect(30, 25, 90, 75, [200, 60, 60, 20]).rect(40, 35, 80, 65, [200, 60, 60, 254]).png());
  const hard = output(await h.bridge(['assets', 'cut', '--image', image, '--out', path.join(h.cwd, 'hard')]));
  assert.equal(hard.method, 'alpha');
  assert.equal(hard.matte, 'hard');
  assert.ok(hard.halo > 0.1);
  assert.equal(hard.parts.length, 1);
  assert.equal(hard.parts[0].area, 40 * 30);
  assert.deepEqual(hard.parts[0].crop, [38, 33, 44, 34]);
  const soft = output(await h.bridge(['assets', 'cut', '--image', image, '--out', path.join(h.cwd, 'soft'), '--matte', 'soft']));
  assert.equal(soft.matte, 'soft');
  assert.deepEqual(soft.parts[0].crop, [28, 23, 64, 54]);
});

test('assets cut 按格子命名，同一格里的碎片合并成一个部件并提示复查', async (t) => {
  const h = sandbox(t);
  const tpl = output(await h.bridge(['assets', 'template', '--out', path.join(h.cwd, 'tpl.png'), '--cols', 2, '--rows', 1, '--names', 'left,right']));
  // 300×200 和模板同为 3:2；格子 1 约在 x 6–147，格子 2 约在 x 153–294。
  const image = h.write('sheet.png', canvas(300, 200, MAGENTA, 3).rect(190, 60, 250, 140, TEAL).rect(30, 60, 80, 140, DARK).rect(100, 90, 120, 110, DARK).png());
  const r = output(await h.bridge(['assets', 'cut', '--image', image, '--out', path.join(h.cwd, 'cut'), '--slots', tpl.slots_file]));
  assert.deepEqual(r.parts.map((p) => [p.slot, p.name]), [[1, 'left'], [2, 'right']]);
  assert.deepEqual(r.parts[0].crop, [28, 58, 94, 84]);
  assert.ok(r.ok);
  assert.deepEqual(r.checks.map((c) => [c.id, c.status]), [['names', 'pass'], ['merged', 'needs_review']]);
  assert.equal(r.checks[1].detail, M.assetsCheck.merged([1]));
});

test('部件贴边或不在格子里时判失败，assets check 退出码为 1', async (t) => {
  const h = sandbox(t);
  const tpl = output(await h.bridge(['assets', 'template', '--out', path.join(h.cwd, 'tpl.png'), '--cols', 2, '--rows', 1]));
  const image = h.write('sheet.png', canvas(300, 200, MAGENTA, 3).rect(0, 60, 60, 140, DARK).rect(145, 90, 156, 110, ORANGE).rect(190, 60, 250, 140, TEAL).png());
  const out = path.join(h.cwd, 'cut');
  const r = output(await h.bridge(['assets', 'cut', '--image', image, '--out', out, '--slots', tpl.slots_file]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.parts.map((p) => p.name), ['slot-1', 'slot-2', 'part-03']);
  assert.deepEqual(r.checks.filter((c) => c.status === 'fail').map((c) => c.id), ['slots', 'edge']);
  assert.ok(r.checks.find((c) => c.id === 'edge').detail.includes('slot-1'));
  const check = await h.bridge(['assets', 'check', '--dir', out]);
  assert.equal(check.code, 1);
  assert.equal(JSON.parse(check.stdout).ok, false);
});

test('assets diff 逐格比较改图前后的变化', async (t) => {
  const h = sandbox(t);
  const tpl = output(await h.bridge(['assets', 'template', '--out', path.join(h.cwd, 'tpl.png'), '--cols', 2, '--rows', 1, '--names', 'left,right']));
  const before = h.write('before.png', canvas(300, 200, MAGENTA, 3).rect(30, 60, 100, 140, DARK).rect(190, 60, 250, 140, ORANGE).png());
  const after = h.write('after.png', canvas(300, 200, MAGENTA, 3).rect(30, 60, 100, 140, DARK).rect(190, 60, 250, 140, TEAL).png());
  const r = output(await h.bridge(['assets', 'diff', '--before', before, '--after', after, '--slots', tpl.slots_file]));
  assert.deepEqual(r.slots.map((s) => [s.name, s.mean_delta === 0, s.changed > 0]), [['left', true, false], ['right', false, true]]);
  failed(await h.bridge(['assets', 'diff', '--before', before, '--after', h.write('small.png', canvas(100, 100, MAGENTA, 3).png())]), M.assetsSizeMismatch('300x200', '100x100'));
});

test('没装矢量化原生包时 --vector 先停下并提示征得同意后运行 assets setup', async (t) => {
  const h = sandbox(t), tooling = path.join(h.home, 'no-tooling');
  const image = h.write('sheet.png', canvas(120, 80, MAGENTA, 3).rect(30, 20, 90, 60, DARK).png());
  failed(await h.bridge(['assets', 'cut', '--image', image, '--out', path.join(h.cwd, 'cut'), '--vector'], { env: { FOREMAN_TOOLING_DIR: tooling } }), M.assetsToolingMissing(tooling));
  assert.equal(fs.existsSync(path.join(h.cwd, 'cut')), false);
});

test('assets 参数错误给出用法或原因', async (t) => {
  const h = sandbox(t);
  failed(await h.bridge(['assets', 'nope']), M.assetsUsage);
  failed(await h.bridge(['assets', 'template', '--out', path.join(h.cwd, 'x.png'), '--cols', 2, '--rows', 2, '--aspect', '4:3']), M.assetsBadAspect('4:3'));
  failed(await h.bridge(['assets', 'template', '--out', path.join(h.cwd, 'x.png'), '--cols', 1, '--rows', 1, '--names', 'a,b']), M.assetsTooManyNames(2, 1));
  const notPng = h.write('fake.png', 'not an image');
  failed(await h.bridge(['assets', 'cut', '--image', notPng, '--out', path.join(h.cwd, 'cut')]), M.assetsBadImage(notPng, 'not a PNG file'));
  const image = h.write('sheet.png', canvas(60, 40, MAGENTA, 3).rect(20, 10, 40, 30, DARK).png());
  failed(await h.bridge(['assets', 'cut', '--image', image, '--out', path.join(h.cwd, 'cut'), '--palette', 'red']), M.assetsBadColor('red'));
});

test('结果的 image_calls 列出每次出图的参数，要求传参考图却没传时提示', async (t) => {
  const h = sandbox(t);
  const call = (input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });
  const done = (saved, transparent) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', status: 'completed', savedPath: saved, transparentBackground: transparent, failure: null } } });
  const missing = h.scenario({ rollout: [call('const r = await tools.image_gen__imagegen({prompt: p, transparent_background: true});'), done('first.png', true)] }, 'missing');
  const brief = '改图：把 referenced_image_paths 设为 ["O:/ref.png"]';
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: missing.env, input: brief }));
  assert.deepEqual(r.image_calls, [{ transparent_background: true, referenced_image_paths: null, num_last_images_to_include: null, status: 'completed', saved_path: 'first.png', failure: null }]);
  assert.ok(r.warnings.includes(M.imageRefsMissing));
  const passed = h.scenario({ rollout: [
    call('await tools.image_gen__imagegen({prompt: "a", transparent_background: false, referenced_image_paths: ["O:/ref.png", \'O:/tpl.png\']});\nawait tools.image_gen__imagegen({prompt: "b", transparent_background: false, referenced_image_paths: refs});'),
    done('a.png', false), done('b.png', false),
  ] }, 'passed');
  const ok = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: passed.env, input: brief }));
  assert.deepEqual(ok.image_calls.map((c) => [c.referenced_image_paths, c.saved_path]), [[['O:/ref.png', 'O:/tpl.png'], 'a.png'], ['unknown', 'b.png']]);
  assert.ok(!ok.warnings.includes(M.imageRefsMissing));
});

test('名单里的重名和只差大小写的名字各自得到不同文件，核对按同一份名单', async (t) => {
  const h = sandbox(t);
  const two = h.write('two.png', canvas(240, 120, MAGENTA, 3).rect(30, 30, 90, 90, DARK).rect(150, 30, 210, 90, TEAL).png());
  const dup = output(await h.bridge(['assets', 'cut', '--image', two, '--out', path.join(h.cwd, 'dup'), '--names', 'arm,arm']));
  assert.deepEqual(dup.parts.map((p) => p.name), ['arm', 'arm-2']);
  assert.ok(dup.ok);
  const cased = output(await h.bridge(['assets', 'cut', '--image', two, '--out', path.join(h.cwd, 'cased'), '--names', 'Arm,arm']));
  assert.deepEqual(cased.parts.map((p) => p.name), ['Arm', 'arm-2']);
  assert.equal(fs.readdirSync(path.join(h.cwd, 'cased/parts')).length, 2);
  const one = h.write('one.png', canvas(240, 120, MAGENTA, 3).rect(30, 30, 90, 90, DARK).png());
  const short = output(await h.bridge(['assets', 'cut', '--image', one, '--out', path.join(h.cwd, 'short'), '--names', 'arm,arm']));
  assert.equal(short.ok, false);
  assert.deepEqual(short.checks.find((c) => c.id === 'names'), { id: 'names', status: 'fail', detail: M.assetsCheck.names(['arm-2'], 0) });
});

test('一个部件都没切出来时判失败，不声明没生成的对照拼图', async (t) => {
  const h = sandbox(t), out = path.join(h.cwd, 'cut');
  const image = h.write('empty.png', canvas(120, 80, [0, 0, 0, 0]).rect(0, 0, 4, 4, [10, 10, 10, 20]).png());
  const r = output(await h.bridge(['assets', 'cut', '--image', image, '--out', out]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.map((c) => [c.id, c.status]), [['parts', 'fail']]);
  assert.equal(r.outputs.sheet, null);
  assert.equal(fs.existsSync(path.join(out, 'sheet.png')), false);
  assert.equal((await h.bridge(['assets', 'check', '--dir', out])).code, 1);
});

test('assets diff 发现透明画布上被删掉的部件', async (t) => {
  const h = sandbox(t);
  const before = h.write('before.png', canvas(100, 80, [0, 0, 0, 0]).rect(20, 20, 60, 60, [128, 128, 128, 255]).png());
  const after = h.write('after.png', canvas(100, 80, [0, 0, 0, 0]).png());
  const r = output(await h.bridge(['assets', 'diff', '--before', before, '--after', after]));
  assert.ok(r.overall.mean_delta > 0 && r.overall.changed > 0.15, JSON.stringify(r.overall));
});

test('出图参数按代码结构解析：字符串里的参数名、显式 null、带引号的键、变量传参、没执行的调用', async (t) => {
  const h = sandbox(t);
  const call = (input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });
  const done = (saved) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', status: 'completed', savedPath: saved, transparentBackground: false, failure: null } } });
  const brief = '改图：把 referenced_image_paths 设为 ["O:/ref.png"]';
  const run = async (rollout, name) => output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: h.scenario({ rollout }, name).env, input: brief }));
  const inString = await run([call('await tools.image_gen__imagegen({prompt: "keep referenced_image_paths: [\'O:/x.png\'] in mind", transparent_background: false});'), done('a.png')], 'in-string');
  assert.equal(inString.image_calls[0].referenced_image_paths, null);
  assert.ok(inString.warnings.includes(M.imageRefsMissing));
  const explicitNull = await run([call('await tools.image_gen__imagegen({prompt, referenced_image_paths: null});'), done('b.png')], 'explicit-null');
  assert.equal(explicitNull.image_calls[0].referenced_image_paths, null);
  assert.ok(explicitNull.warnings.includes(M.imageRefsMissing));
  const quoted = await run([call('await tools.image_gen__imagegen({"prompt": p, "referenced_image_paths": ["O:/ref.png"]});'), done('c.png')], 'quoted');
  assert.deepEqual(quoted.image_calls[0].referenced_image_paths, ['O:/ref.png']);
  assert.ok(!quoted.warnings.includes(M.imageRefsMissing));
  const variable = await run([call('await tools.image_gen__imagegen(args);'), done('d.png')], 'variable');
  assert.equal(variable.image_calls[0].referenced_image_paths, 'unknown');
  assert.ok(!variable.warnings.includes(M.imageRefsMissing));
  const notRun = await run([
    call('throw new Error("stop"); await tools.image_gen__imagegen({prompt, referenced_image_paths: ["O:/ref.png"]});'),
    call('await tools.image_gen__imagegen({prompt});'), done('e.png'),
  ], 'not-run');
  assert.deepEqual(notRun.image_calls.map((c) => [c.referenced_image_paths, c.status, c.saved_path]), [[['O:/ref.png'], 'not_run', null], [null, 'completed', 'e.png']]);
  assert.ok(notRun.warnings.includes(M.imageRefsMissing));
});
