// 假的无头浏览器：照 Chrome 的参数（--window-size、--force-device-scale-factor、--screenshot、最后一个参数是网址）
// 画一张 PNG：浅灰底，一个深色方块按网址里的 t 从左往右走（t 每过 1 秒回到原位；网址带 rest 参数时停在原位），右下角 40×40 永远不变。
import fs from 'node:fs';
import { canvas } from '../fixtures/png.mjs';

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const [w, h] = (opt('window-size') || '200,100').split(',').map(Number), s = Number(opt('force-device-scale-factor') || 1);
const url = new URL(args[args.length - 1]), t = url.searchParams.has('rest') ? 0 : Number(url.searchParams.get('t') || 0);
const W = Math.round(w * s), H = Math.round(h * s), x = Math.round(((t % 1) * (w - 30)) * s);
const img = canvas(W, H, [220, 220, 220, 255]).rect(x, Math.round(20 * s), x + Math.round(20 * s), Math.round(50 * s), [40, 40, 60, 255]).rect(W - Math.round(40 * s), H - Math.round(40 * s), W, H, [200, 80, 40, 255]);
fs.writeFileSync(opt('screenshot'), img.png());
