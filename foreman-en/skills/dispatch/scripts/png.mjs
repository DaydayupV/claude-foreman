// PNG 读写，只用 node:zlib：读 8 / 16 位的灰度、RGB、调色板、带透明的格式（不支持隔行扫描），统一转成 RGBA；写 8 位 RGBA。
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 把一行按滤波类型还原；prev 是上一行已还原的数据（第一行为全 0）。
function unfilter(type, row, prev, bpp) {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
    if (type === 1) row[i] = (row[i] + a) & 0xff;
    else if (type === 2) row[i] = (row[i] + b) & 0xff;
    else if (type === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
    else if (type === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    } else if (type !== 0) throw new Error(`unknown PNG filter ${type}`);
  }
}

// 返回 { width, height, data: RGBA Buffer, hasAlpha }；格式不支持时抛错，错误文字由调用方转成提示。
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let pos = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  const { width, height, depth, color, interlace } = ihdr;
  const channels = CHANNELS[color];
  if (!channels) throw new Error(`unsupported PNG color type ${color}`);
  if (interlace) throw new Error('interlaced PNG is not supported');
  if (depth !== 8 && depth !== 16) throw new Error(`unsupported PNG bit depth ${depth}`);
  if (color === 3 && depth !== 8) throw new Error('only 8-bit palette PNG is supported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bps = depth / 8, bpp = channels * bps, stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  // 16 位只取高字节；tRNS 给灰度和 RGB 指定一个透明色，给调色板指定每个颜色的 alpha。
  const sample = (row, x, ch) => row[x * bpp + ch * bps];
  const key = trns && (color === 0 ? [trns.readUInt16BE(0)] : color === 2 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null);
  const full = (row, x, ch) => (bps === 2 ? row.readUInt16BE(x * bpp + ch * 2) : row[x * bpp + ch]);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(raw[start], row, prev, bpp);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (color === 3) {
        const i = row[x];
        out[o] = palette[i * 3]; out[o + 1] = palette[i * 3 + 1]; out[o + 2] = palette[i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (color === 0 || color === 4) {
        out[o] = out[o + 1] = out[o + 2] = sample(row, x, 0);
        out[o + 3] = color === 4 ? sample(row, x, 1) : key && full(row, x, 0) === key[0] ? 0 : 255;
      } else {
        for (let c = 0; c < 3; c++) out[o + c] = sample(row, x, c);
        out[o + 3] = color === 6 ? sample(row, x, 3) : key && [0, 1, 2].every((c) => full(row, x, c) === key[c]) ? 0 : 255;
      }
    }
    prev = row;
  }
  return { width, height, data: out, hasAlpha: color === 4 || color === 6 || !!trns };
}

// 8 位 RGBA，每行用 Sub 滤波（平涂素材压缩得好，也够快）。
export function encodePng(width, height, rgba) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1), s = y * stride;
    raw[o] = 1;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (rgba[s + i] - (i >= 4 ? rgba[s + i - 4] : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// 动画 PNG（APNG）：frames 是同尺寸的 RGBA 帧，每帧 delayMs 毫秒，无限循环。浏览器都能直接播放。
// 第一帧存整张，之后每帧只存和上一帧不同的那个矩形（背景不动时文件小得多），结果和逐帧整张存一样。
export function encodeApng(width, height, frames, delayMs) {
  const encodeRect = (rgba, x0, y0, w, h) => {
    const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (stride + 1), s = ((y + y0) * width + x0) * 4;
      raw[o] = 1;
      for (let i = 0; i < stride; i++) raw[o + 1 + i] = (rgba[s + i] - (i >= 4 ? rgba[s + i - 4] : 0)) & 0xff;
    }
    return zlib.deflateSync(raw, { level: 6 });
  };
  const changedRect = (a, b) => {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2] || a[p + 3] !== b[p + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return x1 < 0 ? [0, 0, 1, 1] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(0, 4);
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('acTL', actl)];
  let seq = 0;
  frames.forEach((rgba, i) => {
    const [x0, y0, w, h] = i === 0 ? [0, 0, width, height] : changedRect(frames[i - 1], rgba);
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0); fctl.writeUInt32BE(w, 4); fctl.writeUInt32BE(h, 8);
    fctl.writeUInt32BE(x0, 12); fctl.writeUInt32BE(y0, 16);
    fctl.writeUInt16BE(Math.round(delayMs), 20); fctl.writeUInt16BE(1000, 22); fctl[24] = 0; fctl[25] = 0;
    parts.push(chunk('fcTL', fctl));
    const data = encodeRect(rgba, x0, y0, w, h);
    if (i === 0) parts.push(chunk('IDAT', data));
    else { const sq = Buffer.alloc(4); sq.writeUInt32BE(seq++, 0); parts.push(chunk('fdAT', Buffer.concat([sq, data]))); }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
