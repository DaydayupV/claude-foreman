// 测试用的合成图片：在内存里画矩形，写成 PNG。只用 node:zlib，和产品代码无关。
import zlib from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// channels 为 3 时写 RGB（没有透明通道），为 4 时写 RGBA。
export function canvas(width, height, fill, channels = 4) {
  const data = Buffer.alloc(width * height * channels);
  const rect = (x0, y0, x1, y1, color) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
      for (let c = 0; c < channels; c++) data[(y * width + x) * channels + c] = color[c] ?? 255;
    }
  };
  rect(0, 0, width, height, fill);
  return {
    rect(...args) { rect(...args); return this; },
    png() {
      const stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
      for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(height, 4);
      ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    },
  };
}
