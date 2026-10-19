import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, json, taskArgs, MESSAGES, ROOT } from './helpers.mjs';
import { canvas } from './fixtures/png.mjs';
import * as P from '../foreman/skills/dispatch/scripts/assets-pixels.mjs';
import * as V from '../foreman/skills/dispatch/scripts/assets-vector.mjs';

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

test('assets cut --vector 用自带描图转 SVG，透明的洞留空，轮廓和颜色对得上原图', async (t) => {
  const h = sandbox(t);
  // a：深色描边的橙色方块，中间挖一个透明的洞；b：青色方块
  const image = h.write('sheet.png', canvas(240, 160, MAGENTA, 3).rect(20, 30, 110, 130, DARK).rect(26, 36, 104, 124, ORANGE).rect(50, 60, 80, 100, MAGENTA).rect(150, 40, 210, 120, TEAL).png());
  const out = path.join(h.cwd, 'cut');
  const r = output(await h.bridge(['assets', 'cut', '--image', image, '--out', out, '--names', 'a,b', '--vector']));
  assert.deepEqual(r.parts.map((p) => p.name), ['a', 'b']);
  for (const p of r.parts) {
    assert.equal(p.svg, `parts/${p.name}.svg`);
    assert.ok(p.iou >= 0.97 && p.color_error < 3 && p.paths >= 1, JSON.stringify(p));
  }
  assert.ok(!r.checks.some((c) => c.id === 'vector'));
  const layers = fs.readFileSync(path.join(out, 'layers.svg'), 'utf8');
  assert.ok(layers.includes('<g id="a"') && layers.includes('<g id="b"'));
  // 洞的中间画回来是透明的，橙色和描边处是实心
  const a = r.parts[0], svg = fs.readFileSync(path.join(out, a.svg), 'utf8'), [bx, by, bw, bh] = a.crop, img = V.render(svg, bw, bh);
  const alphaAt = (x, y) => img[((y - by) * bw + x - bx) * 4 + 3];
  assert.equal(alphaAt(65, 80), 0);
  assert.equal(alphaAt(40, 50), 255);
  assert.equal(alphaAt(22, 80), 255);
});

// 直接给 RGBA 画图：f(x, y) 返回 [r, g, b, a] 或 null（透明）
function rgba(w, h, f) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); if (c) buf.set(c.length === 4 ? c : [...c, 255], (y * w + x) * 4); }
  return buf;
}
const fills = (svg) => [...svg.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());
const opaqueIou = (a, b, n) => { let i = 0, u = 0; for (let p = 0; p < n; p++) { const x = a[p * 4 + 3] >= 128, y = b[p * 4 + 3] >= 128; if (x || y) u++; if (x && y) i++; } return i / u; };

test('自带描图：直边是直线、圆是曲线，画回来和原图的轮廓重合', () => {
  const square = rgba(60, 50, (x, y) => (x >= 10 && x < 50 && y >= 10 && y < 40 ? TEAL : null));
  const s = V.vectorize(square, 60, 50);
  assert.equal(s.paths, 1);
  assert.ok(!/C/.test(s.svg) && /L/.test(s.svg), s.svg);
  assert.ok(opaqueIou(square, V.render(s.svg, 60, 50), 60 * 50) > 0.98);
  const disc = rgba(80, 80, (x, y) => ((x + 0.5 - 40) ** 2 + (y + 0.5 - 40) ** 2 < 28 ** 2 ? ORANGE : null));
  const d = V.vectorize(disc, 80, 80);
  assert.ok(/C/.test(d.svg), d.svg);
  assert.ok(opaqueIou(disc, V.render(d.svg, 80, 80), 80 * 80) > 0.98);
  // 上下对称的水滴：尖端两个点一样尖，都算角点，绕一圈的那一段首尾也挨着；不能当成短线段把整个轮廓压没
  for (const [r, tx] of [[10, 10], [12, 8], [9, 20]]) {
    const d = 50 - tx, ang = Math.asin(r / d);
    const drop = rgba(80, 40, (x, y) => {
      const px = x + 0.5, py = y + 0.5, dx = px - tx, dy = Math.abs(py - 20);
      return (px - 50) ** 2 + (py - 20) ** 2 < r * r || (dx > 0 && dx <= d * Math.cos(ang) ** 2 && Math.atan2(dy, dx) < ang) ? DARK : null;
    });
    const v = V.vectorize(drop, 80, 40);
    assert.ok(opaqueIou(drop, V.render(v.svg, 80, 40), 80 * 40) > 0.95, `r=${r} tip=${tx} ${v.svg}`);
  }
});

test('自带描图：两色之间的过渡带并掉，比两侧都深的细线和透明里的孤立小点分开处理', () => {
  const MID = [140, 128, 79];   // 在深色和橙色之间
  // 左边深色、右边橙色，中间一列过渡色；橙色里一条 2 像素宽的深色细线；角上一个 2×2 的孤立小点
  const img = rgba(90, 60, (x, y) => {
    if (x >= 86 && y >= 2 && y < 4 && x < 88) return DARK;
    if (x >= 80 || y >= 56) return null;
    if (x < 30) return DARK;
    if (x === 30) return MID;
    if (x >= 55 && x < 57) return DARK;
    return ORANGE;
  });
  const v = V.vectorize(img, 90, 60), out = V.render(v.svg, 90, 60);
  const near = (c, ref) => Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]) < 20;
  assert.ok(!fills(v.svg).some((h) => near(P.parseHex(h), MID)), v.svg);
  const at = (x, y) => [...out.subarray((y * 90 + x) * 4, (y * 90 + x) * 4 + 4)];
  assert.ok(near(at(55, 30), DARK) && near(at(56, 30), DARK), JSON.stringify(at(55, 30)));
  assert.ok(near(at(45, 30), ORANGE) && near(at(65, 30), ORANGE));
  assert.equal(at(86, 2)[3], 0);
});

test('自带描图：只出现在细线上的颜色、1 像素宽的线、相邻两个小块和大量小洞都处理对', () => {
  const at = (img, w, x, y) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  // 橙底上一条 2 像素宽的深色线，深色别处没有：不能在选色时丢掉
  const line = rgba(20, 100, (x, y) => (x >= 9 && x < 11 && y >= 10 && y < 90 ? DARK : ORANGE));
  const l = V.vectorize(line, 20, 100);
  assert.equal(l.colors, 2);
  assert.deepEqual(at(V.render(l.svg, 20, 100), 20, 9, 50), [...DARK, 255]);
  // 透明底上 1 像素宽、100 像素长的线：两边都接近直线，也不能压成零面积
  const thin = rgba(30, 120, (x, y) => (x === 10 && y >= 10 && y < 110 ? TEAL : null));
  assert.equal(at(V.render(V.vectorize(thin, 30, 120).svg, 30, 120), 30, 10, 50)[3], 255);
  // 两个相邻的小块（都小于碎块面积）合成一块，不会互相换颜色
  const pair = rgba(12, 9, (x, y) => (y >= 2 && y < 7 ? (x >= 2 && x < 4 ? [220, 30, 30] : x >= 4 && x < 6 ? [30, 30, 220] : null) : null));
  const p = V.vectorize(pair, 12, 9), pr = V.render(p.svg, 12, 9);
  assert.equal(p.paths, 1);
  assert.deepEqual(at(pr, 12, 2, 4), at(pr, 12, 5, 4));
  // 每 10 像素一个 4×4 的透明洞：洞留空，而且不能慢（轮廓方向不靠两两判断嵌套）
  const holes = rgba(400, 400, (x, y) => (x % 10 >= 3 && x % 10 < 7 && y % 10 >= 3 && y % 10 < 7 ? null : TEAL));
  const t0 = Date.now(), hv = V.vectorize(holes, 400, 400);
  assert.ok(Date.now() - t0 < 5000);
  const hr = V.render(hv.svg, 400, 400);
  assert.equal(at(hr, 400, 5, 5)[3], 0);
  assert.equal(at(hr, 400, 1, 1)[3], 255);
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
  // 全新出图的任务说明里写"不传 referenced_image_paths"，不该提示没传参考图
  const fresh = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: missing.env, input: '全新出图：只调用一次 image_gen，不传 referenced_image_paths，也不要用 num_last_images_to_include' }));
  assert.ok(!fresh.warnings.includes(M.imageRefsMissing));
  // 参数值换行写也算要求了参考图；空数组不算
  const wrapped = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: missing.env, input: '调用时传 referenced_image_paths:\n  ["O:/ref.png"]' }));
  assert.ok(wrapped.warnings.includes(M.imageRefsMissing));
  const empty = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: missing.env, input: 'referenced_image_paths: []，全新出图' }));
  assert.ok(!empty.warnings.includes(M.imageRefsMissing));
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

test('格子文件合并过、编号不连续时仍按格子号命名', async (t) => {
  const h = sandbox(t);
  const tpl = output(await h.bridge(['assets', 'template', '--out', path.join(h.cwd, 'tpl.png'), '--cols', 3, '--rows', 1, '--names', 'a,b,c']));
  // 把第 1、2 格合并成一格（编号还是 1），剩下第 3 格：格子号变成 1、3。
  const doc = json(tpl.slots_file), [s1, s2, s3] = doc.slots;
  doc.slots = [{ slot: 1, name: 'ab', box: [s1.box[0], s1.box[1], s2.box[2], s2.box[3]] }, s3];
  const merged = h.write('merged.slots.json', doc);
  const image = h.write('sheet.png', canvas(300, 200, MAGENTA, 3).rect(40, 60, 160, 140, DARK).rect(220, 60, 280, 140, TEAL).png());
  const r = output(await h.bridge(['assets', 'cut', '--image', image, '--out', path.join(h.cwd, 'cut'), '--slots', merged]));
  assert.deepEqual(r.parts.map((p) => [p.slot, p.name]), [[1, 'ab'], [3, 'c']]);
  assert.ok(r.ok);
  const byList = output(await h.bridge(['assets', 'cut', '--image', image, '--out', path.join(h.cwd, 'cut2'), '--slots', merged, '--names', 'long,short']));
  assert.deepEqual(byList.parts.map((p) => [p.slot, p.name]), [[1, 'long'], [3, 'short']]);
});

test('assets align 找回取出部件的缩放和偏移，输出同画布的对齐图、对照图和区域色差', async (t) => {
  const h = sandbox(t);
  // 参考图：白底上几块不同颜色的方块；部件：参考图 (100,50)–(200,150) 这一块放大 1.5 倍、挪到 (30,40)，其余透明
  const blocks = [[60, 30, 140, 90, ORANGE], [120, 70, 190, 140, TEAL], [150, 40, 180, 60, DARK], [105, 100, 135, 145, [200, 60, 60]], [20, 120, 80, 180, [90, 160, 70]]];
  const ref = canvas(300, 200, [255, 255, 255], 3);
  for (const [x0, y0, x1, y1, c] of blocks) ref.rect(x0, y0, x1, y1, c);
  const f = 1.5, map = (v, o, p) => Math.round(p + (v - o) * f);
  const piece = canvas(400, 300, [0, 0, 0, 0]).rect(30, 40, 30 + 150, 40 + 150, [255, 255, 255, 255]);
  for (const [x0, y0, x1, y1, c] of blocks) {
    const X0 = Math.max(x0, 100), Y0 = Math.max(y0, 50), X1 = Math.min(x1, 200), Y1 = Math.min(y1, 150);
    if (X0 < X1 && Y0 < Y1) piece.rect(map(X0, 100, 30), map(Y0, 50, 40), map(X1, 100, 30), map(Y1, 50, 40), [...c, 255]);
  }
  const out = path.join(h.cwd, 'aligned');
  const r = output(await h.bridge(['assets', 'align', '--ref', h.write('ref.png', ref.png()), '--image', h.write('piece.png', piece.png()), '--out', out, '--regions', '120,70,190,140;0,0,40,40']));
  assert.ok(Math.abs(r.scale - 1 / f) < 0.02, `scale ${r.scale}`);
  assert.ok(Math.abs(r.offset[0] - (100 - 30 / f)) < 2 && Math.abs(r.offset[1] - (50 - 40 / f)) < 2, `offset ${r.offset}`);
  assert.ok(r.mean_delta < 5 && r.matched > 0.9, `${r.mean_delta} ${r.matched}`);
  assert.equal(r.regions.length, 2);
  assert.ok(r.regions[0].pixels > 0 && r.regions[0].mean_delta < 5);
  assert.equal(r.regions[1].pixels, 0);
  for (const f2 of ['aligned.png', 'check.png']) assert.ok(isPng(path.join(out, f2)), f2);
  assert.deepEqual(json(path.join(out, 'align.json')).offset, r.offset);
  failed(await h.bridge(['assets', 'align', '--ref', path.join(h.cwd, 'ref.png'), '--image', path.join(h.cwd, 'piece.png'), '--out', out, '--regions', '5,5,1,1']), M.assetsBadRegion('5,5,1,1'));
});

test('assets align 不把缩小的部件塞进同色区域，细线部件也能对齐，缩放上下限是硬约束', async (t) => {
  const h = sandbox(t);
  // 白底上一块红色方块；部件就是这块方块本身（同一画布，其余透明），正确答案是缩放 1、偏移 0
  const ref = h.write('ref.png', canvas(300, 200, [255, 255, 255], 3).rect(80, 40, 220, 160, [220, 40, 40]).png());
  const block = h.write('block.png', canvas(300, 200, [0, 0, 0, 0]).rect(80, 40, 220, 160, [220, 40, 40, 255]).png());
  const a = output(await h.bridge(['assets', 'align', '--ref', ref, '--image', block, '--out', path.join(h.cwd, 'a')]));
  assert.ok(Math.abs(a.scale - 1) < 0.02 && Math.abs(a.offset[0]) < 2 && Math.abs(a.offset[1]) < 2, `${a.scale} ${a.offset}`);
  // 第 0 行的一条细线：参考图和部件一样，必须能对上（不能因为抽样漏掉而报"没有不透明像素"）
  const lineRef = h.write('line-ref.png', canvas(300, 200, [255, 255, 255], 3).rect(20, 0, 280, 1, [30, 30, 30]).rect(0, 120, 300, 200, [90, 160, 70]).png());
  const line = h.write('line.png', canvas(300, 200, [0, 0, 0, 0]).rect(20, 0, 280, 1, [30, 30, 30, 255]).png());
  const b = output(await h.bridge(['assets', 'align', '--ref', lineRef, '--image', line, '--out', path.join(h.cwd, 'b')]));
  assert.ok(Number.isFinite(b.scale) && Number.isFinite(b.mean_delta));
  // 上下限相等时缩放就是它
  const c = output(await h.bridge(['assets', 'align', '--ref', ref, '--image', block, '--out', path.join(h.cwd, 'c'), '--min-scale', 0.7, '--max-scale', 0.7]));
  assert.equal(c.scale, 0.7);
  failed(await h.bridge(['assets', 'align', '--ref', ref, '--image', block, '--out', path.join(h.cwd, 'd'), '--min-scale', 2, '--max-scale', 1]), M.assetsBadScaleRange(2, 1));
});

test('assets patch 只取改了的区域做羽化补丁，轮廓的细微位移和外轮廓不算', async (t) => {
  const h = sandbox(t);
  // 原图：透明底上一张"脸"（深色描边、浅色填充、两只深色眼睛）；改图：眼睛换成红色横条，外轮廓整圈往外多 1 像素
  const face = (eye, grow) => {
    const c = canvas(240, 180, [0, 0, 0, 0]).rect(30 - grow, 20 - grow, 210 + grow, 160 + grow, [40, 30, 30, 255]).rect(34, 24, 206, 156, [250, 215, 190, 255]);
    return eye(c).png();
  };
  const base = h.write('base.png', face((c) => c.rect(70, 60, 100, 85, [30, 30, 40, 255]).rect(140, 60, 170, 85, [30, 30, 40, 255]), 0));
  const variant = h.write('variant.png', face((c) => c.rect(66, 70, 104, 76, [200, 40, 40, 255]).rect(136, 70, 174, 76, [200, 40, 40, 255]), 1));
  const out = path.join(h.cwd, 'patch');
  const r = output(await h.bridge(['assets', 'patch', '--base', base, '--variant', variant, '--out', out]));
  assert.ok(r.patch_pixels > 500, `${r.patch_pixels}`);
  const [x0, y0, x1, y1] = r.box;
  assert.ok(x0 >= 55 && x1 <= 190 && y0 >= 45 && y1 <= 100, `box ${r.box}`);
  for (const f of ['patch.png', 'preview.png', 'check.png']) assert.ok(isPng(path.join(out, f)), f);
  assert.deepEqual(json(path.join(out, 'patch.json')).box, r.box);
  // 只取左眼
  const left = output(await h.bridge(['assets', 'patch', '--base', base, '--variant', variant, '--out', path.join(h.cwd, 'left'), '--keep', '50,40,120,110']));
  assert.ok(left.box[2] <= 125, `${left.box}`);
});

test('assets trace 照参考图描出部件的描边、底色和阴影，种子不对时报错', async (t) => {
  const h = sandbox(t);
  // 白底上一块带 3 像素深色描边的肤色块，左边一条阴影，中间一条深色细线
  const img = h.write('ref.png', canvas(220, 160, [255, 255, 255], 3).rect(37, 27, 183, 133, [40, 25, 20]).rect(40, 30, 180, 130, [252, 214, 186]).rect(40, 30, 80, 130, [235, 165, 130]).rect(110, 60, 112, 100, [40, 25, 20]).png());
  const out = path.join(h.cwd, 'trace');
  const r = output(await h.bridge(['assets', 'trace', '--image', img, '--seed', '140,80;60,80', '--out', out]));
  assert.deepEqual(r.layers.map((l) => l.name), ['outline', 'base', 'shadow1']);
  const near = (hex, rgb) => P.parseHex(hex).every((v, i) => Math.abs(v - rgb[i]) < 12);
  assert.ok(near(r.layers[1].color, [252, 214, 186]) && near(r.layers[2].color, [235, 165, 130]), JSON.stringify(r.layers));
  assert.ok(near(r.layers[0].color, [40, 25, 20]));
  const svg = fs.readFileSync(path.join(out, 'trace.svg'), 'utf8');
  assert.equal((svg.match(/<path /g) || []).length, 3);
  assert.ok(isPng(path.join(out, 'check.png')));
  failed(await h.bridge(['assets', 'trace', '--image', img, '--seed', '5000,1', '--out', out]), M.assetsBadSeed('5000,1'));
  failed(await h.bridge(['assets', 'trace', '--image', img, '--seed', '38,28', '--out', out]), M.assetsTraceEmpty('38,28'));
});

test('assets capture 和 playback 用指定的浏览器截图，检查静止区域、首尾衔接并写出 APNG', async (t) => {
  const h = sandbox(t);
  const browser = path.join(ROOT, 'tests', 'fake', 'browser.mjs'), page = 'http://localhost:9/page.html';
  const cap = output(await h.bridge(['assets', 'capture', '--url', page, '--times', '0,0.5', '--size', '200x100', '--scale', 2, '--zoom', 'corner=160,60,200,100', '--browser', browser, '--out', path.join(h.cwd, 'cap')]));
  assert.deepEqual(cap.frames.map((f) => [f.t, f.size]), [[0, [400, 200]], [0.5, [400, 200]]]);
  assert.ok(isPng(cap.frames[0].zooms[0].file) && isPng(cap.sheet));
  const pb = output(await h.bridge(['assets', 'playback', '--url', page, '--loop', 1, '--fps', 4, '--size', '200x100', '--static', 'corner=165,65,195,95', '--browser', browser, '--out', path.join(h.cwd, 'pb')]));
  assert.equal(pb.frames, 4);
  assert.deepEqual(pb.seam, { mean_delta: 0, changed: 0 });
  assert.equal(pb.static[0].max_changed, 0);
  assert.deepEqual(pb.jumps, []);
  const apng = fs.readFileSync(pb.files.playback);
  assert.ok(apng.includes(Buffer.from('acTL')) && apng.includes(Buffer.from('fdAT')));
  assert.ok(isPng(pb.files.flipbook));
  failed(await h.bridge(['assets', 'capture', '--url', page, '--times', 'a', '--browser', browser, '--out', path.join(h.cwd, 'x')]), M.assetsBadTimes('a'));
});

test('审查发现的问题：时刻参数替换旧值且不落进 #片段、首尾帧正好在一圈的终点、补丁不带回外轮廓、种子要在框里、细线保留、截图不重名', async (t) => {
  const h = sandbox(t);
  const browser = path.join(ROOT, 'tests', 'fake', 'browser.mjs');
  const a = output(await h.bridge(['assets', 'capture', '--url', 'http://localhost:9/p.html', '--times', '0.5', '--size', '200x100', '--scale', 1, '--browser', browser, '--out', path.join(h.cwd, 'a')]));
  const b = output(await h.bridge(['assets', 'capture', '--url', 'http://localhost:9/p.html?t=9#scene', '--times', '0.5', '--size', '200x100', '--scale', 1, '--browser', browser, '--out', path.join(h.cwd, 'b')]));
  assert.ok(fs.readFileSync(a.frames[0].file).equals(fs.readFileSync(b.frames[0].file)));
  const twin = output(await h.bridge(['assets', 'capture', '--url', 'http://localhost:9/p.html', '--times', '0,0.0004', '--size', '200x100', '--scale', 1, '--browser', browser, '--out', path.join(h.cwd, 'twin')]));
  assert.notEqual(twin.frames[0].file, twin.frames[1].file);
  // 假页面 1 秒一圈；fps 2.6 时一圈分 3 段，最后一帧要正好是 1 秒
  const pb = output(await h.bridge(['assets', 'playback', '--url', 'http://localhost:9/p.html', '--loop', 1, '--fps', 2.6, '--size', '200x100', '--browser', browser, '--out', path.join(h.cwd, 'pb')]));
  assert.deepEqual(pb.seam, { mean_delta: 0, changed: 0 });
  // 补丁：改动挨着外轮廓时，外扩和羽化也不能超出原图外轮廓往里 --edge 的范围
  const face = (eyeY, grow) => canvas(160, 120, [0, 0, 0, 0]).rect(20 - grow, 20 - grow, 140 + grow, 100 + grow, [40, 30, 30, 255]).rect(23, 23, 137, 97, [250, 215, 190, 255]).rect(40, eyeY, 70, eyeY + 12, [30, 30, 40, 255]).png();
  const base = h.write('pbase.png', face(30, 0)), variant = h.write('pvar.png', face(34, 1));
  const r = output(await h.bridge(['assets', 'patch', '--base', base, '--variant', variant, '--out', path.join(h.cwd, 'patch')]));
  const { decodePng } = await import('../foreman/skills/dispatch/scripts/png.mjs');
  const patch = decodePng(fs.readFileSync(r.files.patch));
  for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) if (x < 26 || y < 26 || x >= 134 || y >= 94) assert.equal(patch.data[(y * 160 + x) * 4 + 3], 0, `alpha at ${x},${y}`);
  // trace：种子不在框里时报错；填色里 2 像素宽的细线留成底色层里的洞
  const img = h.write('tr.png', canvas(220, 160, [255, 255, 255], 3).rect(37, 27, 183, 133, [40, 25, 20]).rect(40, 30, 180, 130, [252, 214, 186]).rect(110, 60, 112, 100, [40, 25, 20]).png());
  failed(await h.bridge(['assets', 'trace', '--image', img, '--seed', '140,80', '--box', '0,0,100,100', '--out', path.join(h.cwd, 'tr')]), M.assetsBadSeed('140,80'));
  const tr = output(await h.bridge(['assets', 'trace', '--image', img, '--seed', '140,80', '--colors', 1, '--out', path.join(h.cwd, 'tr2')]));
  assert.ok(tr.layers.find((l) => l.name === 'base').paths >= 2, JSON.stringify(tr.layers));
});
