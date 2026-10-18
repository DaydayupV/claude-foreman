// 从 Codex 会话记录里读出每次 image_gen 调用实际传的参数和结果。exec --json 的事件里没有这些。
// 代码模式下调用写在 exec 单元的 JS 代码里，只能按代码文字解析：能确定的写出值，
// 不能确定的（参数用变量传、展开了别的对象、并发调用分不清对应关系）记为 "unknown"，不猜。
import fs from 'node:fs';

// 跳过从 i 开始的字符串（' " 或模板字符串，模板里的 ${…} 也跳过），返回结束引号的位置；没闭合返回 -1。
function skipString(text, i) {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (q === '`' && text[j] === '$' && text[j + 1] === '{') {
      const end = closing(text, j + 2);
      if (end < 0) return -1;
      j = end;
      continue;
    }
    if (text[j] === q) return j;
  }
  return -1;
}

// 从 start（某个开括号之后）找到配对的闭括号位置，跳过字符串和注释；找不到返回 -1。
function closing(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); if (i < 0) return -1; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i;
  }
  return -1;
}

// 按最外层的逗号切开（括号和字符串里的逗号不算）。
function splitTop(text) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); if (i < 0) break; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

// 不含 ${} 的字符串字面量取出值，其他返回 undefined。
function literalString(v) {
  const q = v[0];
  if (!['"', "'", '`'].includes(q) || skipString(v, 0) !== v.length - 1 || (q === '`' && v.includes('${'))) return undefined;
  if (q === '"') { try { return JSON.parse(v); } catch { return undefined; } }
  return v.slice(1, -1).replace(/\\(.)/g, '$1');
}

function refsValue(v) {
  if (v === 'null' || v === 'undefined') return null;
  if (!v.startsWith('[') || closing(v, 1) !== v.length - 1) return 'unknown';
  const items = splitTop(v.slice(1, -1)).map(literalString);
  return items.every((x) => typeof x === 'string') ? items : 'unknown';
}

// 一次调用的参数文字（括号里的内容）→ 参数。不是对象字面量（比如整个参数对象是变量）时都记为未知。
export function parseImageArgs(args) {
  const unknown = { transparent_background: null, referenced_image_paths: 'unknown', num_last_images_to_include: 'unknown' };
  const text = args.trim();
  if (!text.startsWith('{') || closing(text, 1) !== text.length - 1) return unknown;
  const props = new Map();
  let spread = false;
  for (const entry of splitTop(text.slice(1, -1))) {
    if (entry.startsWith('...')) { spread = true; continue; }
    let colon = -1;
    for (let i = 0, depth = 0; i < entry.length; i++) {
      const c = entry[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(entry, i); if (i < 0) break; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) { colon = i; break; }
    }
    const key = colon < 0 ? entry : entry.slice(0, colon).trim();
    props.set(literalString(key) ?? key, colon < 0 ? key : entry.slice(colon + 1).trim()); // 简写属性的值是同名变量
  }
  const missing = spread ? 'unknown' : null;
  const refs = props.has('referenced_image_paths') ? refsValue(props.get('referenced_image_paths')) : missing;
  const lastRaw = props.get('num_last_images_to_include');
  const last = lastRaw == null ? missing : /^\d+$/.test(lastRaw) ? Number(lastRaw) : lastRaw === 'null' || lastRaw === 'undefined' ? null : 'unknown';
  const t = props.get('transparent_background');
  return { transparent_background: t === 'true' ? true : t === 'false' ? false : null, referenced_image_paths: refs, num_last_images_to_include: last };
}

// 一段 exec 代码里所有 image_gen__imagegen(…) 调用的参数。
function callsInCode(code) {
  const out = [], re = /image_gen__imagegen\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const end = closing(code, m.index + m[0].length);
    out.push(end < 0 ? parseImageArgs('') : parseImageArgs(code.slice(m.index + m[0].length, end)));
  }
  return out;
}

const sameArgs = (a, b) => JSON.stringify([a.referenced_image_paths, a.num_last_images_to_include]) === JSON.stringify([b.referenced_image_paths, b.num_last_images_to_include]);

// 读 file 里 since（毫秒时间戳）之后的出图调用和结果。结果归到它之前最近一个还有空位的调用单元，
// 单元内按先后配对；单元里调用数和结果数对不上、或者用了并发，而各次参数又不一样时，参数记为未知。
export function readImageCalls(file, since) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const cells = [];
  for (const line of text.split('\n')) {
    if (!line.includes('image_gen') && !line.includes('imagegen')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (since && Date.parse(d.timestamp) < since) continue;
    const p = d.payload || {};
    if (p.type === 'custom_tool_call' && typeof p.input === 'string' && p.input.includes('image_gen__imagegen')) {
      cells.push({ calls: callsInCode(p.input), results: [], concurrent: /Promise\.(all|allSettled|any|race)\b/.test(p.input) });
    } else if (p.type === 'function_call' && /image_?gen/i.test(p.name || '')) {
      let a = null;
      try { a = JSON.parse(p.arguments || '{}'); } catch { /* 参数不是 JSON，按未知处理 */ }
      cells.push({ calls: [a ? { transparent_background: a.transparent_background ?? null, referenced_image_paths: a.referenced_image_paths ?? null, num_last_images_to_include: a.num_last_images_to_include ?? null } : parseImageArgs('')], results: [] });
    } else if (p.type === 'item_completed' && p.item?.kind === 'image_gen.generation') {
      const r = { status: p.item.status ?? null, saved_path: p.item.savedPath ?? null, transparent_background: p.item.transparentBackground ?? null, failure: p.item.failure ?? null };
      const cell = [...cells].reverse().find((c) => c.results.length < c.calls.length) || cells.at(-1);
      if (cell) cell.results.push(r);
      else cells.push({ calls: [], results: [r] });
    }
  }
  const out = [];
  for (const cell of cells) {
    const uniform = cell.calls.every((c) => sameArgs(c, cell.calls[0]));
    const sure = uniform || (cell.calls.length === cell.results.length && !cell.concurrent);
    for (let i = 0; i < Math.max(cell.calls.length, cell.results.length); i++) {
      const c = cell.calls[i] || parseImageArgs(''), r = cell.results[i];
      out.push({
        transparent_background: r?.transparent_background ?? c.transparent_background,
        referenced_image_paths: sure ? c.referenced_image_paths : 'unknown',
        num_last_images_to_include: sure ? c.num_last_images_to_include : 'unknown',
        status: r ? r.status : 'not_run', saved_path: r?.saved_path ?? null, failure: r?.failure ?? null,
      });
    }
  }
  return out;
}

// 这一轮的出图里有没有该传参考图却没传的：有出图结果，而且每一次都确定没传参考图。
export function missingReferences(calls) {
  const done = calls.filter((c) => c.status !== 'not_run');
  const passed = (c) => (Array.isArray(c.referenced_image_paths) && c.referenced_image_paths.length) || c.referenced_image_paths === 'unknown'
    || c.num_last_images_to_include === 'unknown' || c.num_last_images_to_include > 0;
  return done.length > 0 && !done.some(passed);
}
