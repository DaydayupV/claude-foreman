// assets 各子命令共用的读写和参数小工具。
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import { M, die } from './util.mjs';

export const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
export const names = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
export const safeName = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '-');
export function num(o, key, fallback, int = false) {
  if (o[key] == null) return fallback;
  const v = Number(o[key]);
  if (!Number.isFinite(v) || v <= 0 || (int && !Number.isInteger(v))) die(M.assetsBadNumber(key, o[key]));
  return v;
}
export function readImage(file) {
  try { const bytes = fs.readFileSync(file); return { ...decodePng(bytes), bytes }; } catch (e) { die(M.assetsBadImage(file, e.message)); }
}
export function writePng(file, w, h, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(w, h, data));
}
// "x0,y0,x1,y1;x0,y0,x1,y1" → [[x0,y0,x1,y1], …]；写错时用 bad(原文) 报错
export function boxes(value, bad) {
  if (!value) return [];
  return String(value).split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const v = s.split(',').map(Number);
    if (v.length !== 4 || !v.every(Number.isFinite) || v[0] >= v[2] || v[1] >= v[3]) die(bad(s));
    return v;
  });
}
// "name=x0,y0,x1,y1;…" → [{ name, box }]
export function namedBoxes(value, bad) {
  if (!value) return [];
  return String(value).split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^([\w.-]+)=(.+)$/.exec(s);
    if (!m) die(bad(s));
    return { name: m[1], box: boxes(m[2], () => bad(s))[0] };
  });
}
