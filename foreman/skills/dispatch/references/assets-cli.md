# assets 子命令
都在本机运行，不调用模型；输出 JSON。写法是 `node "<脚本路径>" assets <命令> …`，脚本路径见 SKILL.md 的"调用方式"。什么时候用哪个命令见 `references/image.md` 和 `references/image-assets.md`；下面说的"第 N 节"都指 image-assets.md。

| 命令 | 作用 |
|---|---|
| `template --out <png> --cols C --rows R [--aspect 1:1\|3:2\|2:3\|3:1] [--names a,b,…]` | 画编号虚线格子模板和 `.slots.json`（格子坐标按比例存，出图尺寸不同也能用）。不给 `--aspect` 时按行列数选 |
| `cut --image <png> --out <目录> [选项]` | 去背景、切部件、命名、出对照拼图和清单 |
| `check --dir <cut 的输出目录>` | 重新读出判定；有 `fail` 时退出码为 1 |
| `diff --before <png> --after <png> [--slots <json>]` | 改图前后整体和逐格的平均色差 `mean_delta`、变化像素比例 `changed` |
| `layers --ref <定稿图> --plate <背景板> --pieces <json> --out <目录>` | 同源取件（第六节第 4 步）：先把背景板对回定稿图（拿不准或不比原位好时按原位），按所有套索外面一圈的色差给背景板校色；部件范围 = 套索里面、和背景板的色差超过门槛 `tol`（主体以外背景板噪声的 3 倍，至少 4）、被描边分开的区域，描边归离它最近的部件；`extendUnder` 顺着平涂色往上层部件下面延长。写出 `static.png`、每个部件的 PNG 或 SVG（`kind: "vector"`）、`layers.json`（`plate` 里实际用的变换、测出的对齐 `measured` 和噪声 `noise`，`reassembled_diff_px`、`uncertain`、每层的位置和像素数）、`layers.js` 和对照图 `check.png`（各部件上色，延长段浅色，拿不准的区域画品红框） |
| `align --ref <png> --image <png> --out <目录> [--regions x0,y0,x1,y1;…] [--min-scale <倍数>] [--max-scale <倍数>]` | 找出一张图在另一张图上的位置（`layers` 和 `patch` 内部用的同一套对齐，流程里不单独用）：等比缩放 `scale` 和偏移 `offset`（部件像素 (x, y) 落在参考图的 (offset + scale·x)），整体平均色差 `mean_delta` 和吻合比例 `matched`，`ambiguous` 为 true 时结果拿不准（部件太小、缺少特征，或者顶在缩放范围的边上，这时看 `note`），每个区域（参考图像素坐标）各自的色差；写出和参考图同一画布的 `aligned.png`、"参考图 / 叠上部件 / 差异"三联对照图 `check.png`（差异格里灰色是对得上，橙色有出入，红色明显不同）和 `align.json` |
| `patch --base <png> --variant <png> --out <目录> [--keep x0,y0,x1,y1;…] [--threshold <色差>] [--min-area <像素>] [--open <像素>] [--edge <像素>] [--grow <像素>] [--feather <像素>]` | 从改图里只取变了的区域：先把改图对回原图（拿不准时按原位），离原图外轮廓 `--edge`（默认 6）像素以内的变化不算，开运算 `--open`（默认 2）去掉轮廓的细微位移，去掉小于 `--min-area` 的碎块，外扩 `--grow`、羽化 `--feather` 后写出 `patch.png`、`preview.png`、`check.png` 和 `patch.json`（补丁范围 `box`、像素数，`align` 是实际用的变换，`align.measured` 是测出的对齐）。改图把东西删掉的地方补丁盖不掉 |
| `trace --image <png> --seed x,y;… --out <目录> [--box x0,y0,x1,y1] [--tolerance <色差>] [--colors <N>] [--outline <像素>] [--dark <亮度>] [--simplify <像素>]` | 照定稿图描出一个部件：从种子点按颜色相近（`--tolerance`，默认 30）圈出填色，深色（亮度低于 `--dark`，默认 25）、离填色 `--outline`（默认 4）像素以内的算描边，填色分成 `--colors`（默认 2）种；轮廓按 `--simplify`（默认 0.8 像素）化简后拟合成直线和三次贝塞尔曲线，内外两条边一起平滑，描边宽度保持均匀；写出定稿图坐标的 `trace.svg`（outline、base、shadow 各一层）、`trace.json` 和按最终 SVG 画回来的对照图 |
| `capture --url <网址或文件> --times <秒,…> --out <目录> [--size 宽x高] [--scale <倍数>] [--zoom 名字=x0,y0,x1,y1;…] [--param t] [--wait <毫秒>] [--browser <路径>]` | 用本机 Chrome 或 Edge 无头模式，在页面网址后加 `?t=<秒>` 逐个时刻截图（`--scale` 默认 2），按 CSS 像素裁出特写，写出拼图 `sheet.png` 和 `capture.json`；整张同一个颜色时自动加长等待重截 |
| `playback --url <网址或文件> --loop <秒> --out <目录> [--fps <N>] [--static 名字=x0,y0,x1,y1;…] [--size 宽x高] [--scale <倍数>] [--preview-width <像素>] [--browser <路径>]` | 按 `--fps`（默认 12）截下一圈（多截最后一帧对首帧），算相邻帧的变化、`static` 区域的变化（闪）、首尾的差 `seam`、突然变大的 `jumps`；写出逐帧 `frames/`、能播放的 `playback.png`（APNG）、翻页拼图 `flipbook.png` 和 `playback.json` |

`cut` 的选项：
- `--slots`、`--names`：按格子或名单命名（有模板时第 N 个名字对应格子文件里的第 N 个格子；模板里写的名字按格子号对应，合并过格子、编号不连续也不会错位）。
- `--matte hard|soft`：透明图怎么清理，见第二节。
- `--key auto|#rrggbb`：纯色底的底色，默认取画布边缘的中位色；白或浅灰底只去掉和边缘连通的部分。
- `--gap <像素>`（默认 6）：相距不到两倍 gap 的碎块算同一个部件。`--min-area <比例>`（默认 0.0004）：比这还小的碎屑丢掉。
- `--palette "#rrggbb,…"`：统计每个部件有多少像素落在色板上；加 `--snap` 把颜色吸附到色板（色板外的明暗色阶会被吸掉，要保留就写进色板）。
- `--colors N`：整张图共用一套 N 色色板再切，减少矢量路径。
- `--vector`：再转 SVG，写出 `parts/<名字>.svg` 和按原位置排好、每个部件一个 `<g id>` 的 `layers.svg`（能直接导入 Figma、Illustrator）。用插件自带的描图，不依赖别的包：先减色、按颜色分块，大块在下、小块在上层叠，轮廓拟合成直线和三次贝塞尔曲线；对照拼图里右边是 SVG 画回来的样子，`iou` 和 `color_error` 也是画回来量的。
- `--allow-edge`：本来就要横贯全宽的素材（视差背景层），贴边不判失败。

`cut` 的输出：`alpha.png`（整张去背景后的图）、`parts/<名字>.png`、`sheet.png`（对照拼图，左上角是格子编号；有 SVG 时左原图、右 SVG 渲染）、`manifest.json`（每个部件的 id、格子、文件和在源图上的位置 `crop`，组装位置不猜）、`report.json`。

`report.json` 的 `checks`：
| id | 状态 | 含义 |
|---|---|---|
| `names` | fail | 名单里的部件缺了，或多出没名字的部件 |
| `slots` | fail | 有部件不在任何格子里 |
| `merged` | needs_review | 有格子里几块碎片被合并，看对照拼图确认是同一个东西 |
| `edge` | fail（`--allow-edge` 时 needs_review） | 部件贴着画布边缘，可能被裁掉了 |
| `transparency` | fail | 透明像素不到 5%，背景多半没去掉 |
| `background` | needs_review | 纯色底不够平，边缘可能残留底色 |
| `specks` | needs_review | 丢掉了碎屑 |
| `vector` | needs_review | 某些部件 SVG 和原图轮廓重合度（IoU）低于 0.95 |

其他指标：`halo`（清理前光晕占比）、`transparent`、`edge_width`（边缘半透明宽度，1–3 像素正常）、`background_p99`、每个部件的 `colors95`（覆盖 95% 像素要几种颜色，越少越好矢量化）、`on_palette`、`paths`、`iou`、`color_error`。这些数是 2026 年 10 月几十张图上的经验值，不是硬标准。
