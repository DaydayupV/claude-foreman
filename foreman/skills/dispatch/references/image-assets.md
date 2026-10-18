# 出图素材：提示词、背景、格子模板和 assets 子命令

要把 Codex 出的图变成透明部件、带名字的素材或 SVG，改图、照参考图出图时读这一篇。规则摘要在 SKILL.md 的"图片生成"。

## 一、工具的四个参数
Codex 内置的 `image_gen`（exec 里写作 `tools.image_gen__imagegen`）有四个参数：

| 参数 | 用途 |
|---|---|
| `prompt` | 提示词，用英文写 |
| `transparent_background` | `true` 时输出带透明通道的 PNG |
| `referenced_image_paths` | 本地图片的绝对路径列表，作为改图或参考的输入；提示词里按顺序称作 "Image 1"、"Image 2" |
| `num_last_images_to_include` | 取对话里最近的 1–5 张图作为输入，只在图没有本地文件时用 |

- 不传后两个参数就是全新出图。Codex 先用 view_image 看过图也不算传入。
- 后两个参数不能同时传。格子模板和角色设定图都是本地文件，一起放进 `referenced_image_paths`。
- 没有尺寸参数。输出固定在约 157 万像素的几档：1:1 是 1254×1254，3:2 是 1536×1024，2:3 是 1024×1536，3:1 是 2172×724。提示词里写更大的尺寸也没用。
- 参考图会随调用上传给模型服务。
- 结果里的 `image_calls` 列出每次调用实际传的参数，`referenced_image_paths` 为 `"unknown"` 表示 Codex 用变量传的、解析不出路径，或者几次调用分不清各自对应哪张图；`status` 为 `"not_run"` 表示代码里写了这次调用但没执行到。

## 二、背景怎么选
| 方案 | 什么时候用 | 注意 |
|---|---|---|
| `transparent_background: true` | 默认 | 透明是后期抠的：实心像素是 253–254，边外有 2–7% 的淡光晕。`assets cut` 默认（`--matte hard`）把 alpha < 48 归 0、≥ 250 归 255；头发丝、烟雾、光晕这类柔边素材用 `--matte soft` |
| 品红 #FF00FF 纯色底 | 透明结果光晕太重，或主体大面积是白色、浅色 | `transparent_background: false`；主体里不能有品红、粉、紫；`assets cut` 自动识别底色并反求边缘 |
| 绿幕、白底 | 不用 | 绿幕会把主体颜色带偏；白底抠不掉被描边包住的内部白色 |

## 三、提示词积木
按"用途 → 画幅 → 内容清单 → 风格 → 背景 → 间距 → 禁止项"的顺序写，英文。

透明背景：
```text
Background: fully transparent everywhere outside the artwork (alpha = 0). No backdrop color, no floor, no cast shadow, no reflection, no glow.
```
品红底：
```text
Background: one perfectly flat, uniform pure magenta color (#FF00FF) filling the entire canvas. No gradient, no vignette, no texture, no floor, no cast shadow, no reflection, no glow. Never use magenta, pink, purple or violet anywhere inside the artwork.
```
间距（多部件必带）：
```text
Spacing: every item is fully separated by a wide empty gap; nothing touches another item or the canvas edge; nothing is cut off.
```
方便矢量化的风格（写在生成时；事后让模型"改成扁平风"几乎没效果）：
```text
Style: flat vector illustration, solid color fills with hard crisp edges, bold uniform dark outline (#222222). No gradients, no soft shading, no highlights, no texture, no noise, no 3D, no drop shadows, no glow.
Palette: use only these colors: #222222, #FFFFFF, #F5A524, #1D5B79, #E9C25A.
```
人物这类复杂画面把第一句换成 "clean anime cel shading as flat vector art: solid fills, exactly one hard-edged shadow tone per color"。
禁止项：
```text
No text, no letters, no numbers, no labels, no grid lines, no frames, no watermark.
```

## 四、多部件：用格子模板命名
模型大多按列出的顺序排部件，但不保证。要按名字引用部件，就用格子模板：
1. `assets template --out <项目内路径>/layout.png --cols 4 --rows 2 --names "head,hair-back,…"`，同时写出 `layout.slots.json`。模板要放在项目里，Codex 的沙箱才读得到。
2. 把模板作为 Image 1 传入（有角色设定图就作为 Image 2）：
```text
Image 1 is a layout template: 8 numbered dashed slots in two rows. Image 2 is the character design sheet.
Draw <内容> as SEPARATE parts. Put exactly one part centered inside each slot of Image 1, fitting inside the slot:
slot 1: <部件 1>
slot 2: <部件 2>
...
Do NOT draw the dashed slot outlines or the slot numbers.
<风格、背景、禁止项>
```
3. `assets cut --image <图> --out <目录> --slots layout.slots.json`：部件按中心落在哪一格命名；同一格里分开的碎片（太阳的光芒、云下的雨滴）合并成一个部件。

名字用稳定的英文 id（文件名就是它），说明"左右"指角色自己的左右还是画面的左右。一张图里格子越多每件越小：12 格时每件约 250 像素宽。

## 五、先出整图还是直接出部件表
- **直接出部件表**：彼此独立、不用组装的素材，比如图标组、按钮和徽章、道具。
- **先出整图、验收后再拆**：要保持同一个设计的，比如角色拆部件、整页 UI 拆组件、场景分层。拆的时候把整图作为参考图传入，提示词写明必须保留的细节。实测带参考图拆部件能保留帽子、发夹、披肩这类细节，纯文字描述会丢。
- 角色部件要能转动时加上：
```text
Each part is drawn complete and whole on its own (including the areas normally hidden by overlapping parts), with rounded overlap ends at the joints so it can pivot.
```
- 嵌在组件里的小图标（导航栏里的图标）单独列一格或单独出一张，不要指望从整页里再拆一层。
- 扩充现有素材集：把现有的一组作为参考图，要求 "exactly the same drawing style, outline weight, corner rounding, level of detail, proportions and palette as Image 1"，并写 "Do not copy any item from Image 1"。

## 六、用在 SVG、HTML 和动画里
作品最后是代码时，插画同样由 Codex 画，转成 SVG 部件后再写进代码，不出"只作参考"的图让 Claude 照着手画。
1. **先出整张设定图并验收**：角色的正面、侧面，或者整个场景。之后的部件都以它为参考图，保证同一个设计。
2. **列元素清单，按元素分**：作品要求按物理逐帧模拟形状的（模拟的头发和布料、程序生成的绳子）、要和机械或物理对齐的（链条、齿轮、曲柄）、文字和 UI 控件、几何图形，用代码画；其余都进部件表。用代码画的照设定图的配色和线宽。
3. **出部件表**：格子模板作 Image 1，设定图作 Image 2，透明背景。动画用的部件这样拆：
   - 关节处拆开，提示词加上 "with rounded overlap ends at the joints so it can pivot"，并要求 "drawn complete and whole on its own"，被遮住的部分也画全。
   - 会弯会飘、但不用逐帧模拟的部位拆成几段（头发、尾巴、披风各 3–4 段，这是默认做法），每段单独一格，按顺序转动。
   - 表情和状态各占一格，和基础部件同样大小、同样角度：
```text
slot 9: the same head as slot 1 with the mouth open, drawn at exactly the same size, angle and position in its slot
slot 10: the same head as slot 1 with the eyes closed (blink), drawn at exactly the same size, angle and position in its slot
```
   - 一张图放不下就分几张，每张都带上设定图作参考。
4. **转 SVG**：`assets cut --slots … --vector`。生成时写扁平风格、少阴影，矢量化时加 `--colors 8` 到 `12`，路径数能少一半左右；动漫角色部件不减色时每件几十到五百条路径，网页上部件多时会卡。要固定配色时用 `--palette … --snap`。
5. **组装**：`layers.svg` 是每个部件一个 `<g id>`、按源图位置排好的整体；也可以单独引用 `parts/<名字>.svg`。`manifest.json` 的 `crop` 只是部件在源图上的位置，组装位置和旋转中心（关节的圆头中心）要在代码里定。

## 七、改图和分层
- **局部修改**：原图作为 Image 1，提示词写 "Change ONLY <目标和位置>: <怎么改>. Keep every other part exactly unchanged: same parts, same positions, same sizes, same colors, same line art, and the same background."。改图会让其他区域有轻微变化（实测平均色差 2–3），用 `assets diff --before 原图 --after 新图 --slots 模板` 确认只有目标格变了，交付时只替换那个部件。
- **场景分层**：背景板（`transparent_background: false`）写 "Remove <主体> completely and fill that area with the background that would be behind them … Change nothing else: same canvas size, same composition and framing"；主体层（`true`）写 "keep only <主体> exactly as they appear: same pose, same position in the frame, same scale … Same canvas size"。实测两层叠回去和原图几乎一样，但地面阴影两层都不带，要阴影就在任务说明里写明归哪一层或单独出一层。
- **给现成图去背景**：原图作为 Image 1，"Remove only the background and make it fully transparent. Keep <主体> exactly as they are … Do not redraw or restyle anything."
- 连续多轮改同一张图会累积变化，改了两三轮后从源图重新出。

## 八、assets 子命令
都在本机运行，不调用模型；输出 JSON。

| 命令 | 作用 |
|---|---|
| `template --out <png> --cols C --rows R [--aspect 1:1\|3:2\|2:3\|3:1] [--names a,b,…]` | 画编号虚线格子模板和 `.slots.json`（格子坐标按比例存，出图尺寸不同也能用）。不给 `--aspect` 时按行列数选 |
| `cut --image <png> --out <目录> [选项]` | 去背景、切部件、命名、出对照拼图和清单 |
| `check --dir <cut 的输出目录>` | 重新读出判定；有 `fail` 时退出码为 1 |
| `diff --before <png> --after <png> [--slots <json>]` | 改图前后整体和逐格的平均色差 `mean_delta`、变化像素比例 `changed` |
| `setup` | 把矢量化用的两个原生包装到 `~/.claude/foreman/tooling`（先问用户） |

`cut` 的选项：
- `--slots`、`--names`：按格子或名单命名（有模板时第 N 个名字对应第 N 格）。
- `--matte hard|soft`：透明图怎么清理，见第二节。
- `--key auto|#rrggbb`：纯色底的底色，默认取画布边缘的中位色；白或浅灰底只去掉和边缘连通的部分。
- `--gap <像素>`（默认 6）：相距不到两倍 gap 的碎块算同一个部件。`--min-area <比例>`（默认 0.0004）：比这还小的碎屑丢掉。
- `--palette "#rrggbb,…"`：统计每个部件有多少像素落在色板上；加 `--snap` 把颜色吸附到色板（色板外的明暗色阶会被吸掉，要保留就写进色板）。
- `--colors N`：整张图共用一套 N 色色板再切，减少矢量路径。
- `--vector`：再转 SVG，写出 `parts/<名字>.svg` 和按原位置排好、每个部件一个 `<g id>` 的 `layers.svg`（能直接导入 Figma、Illustrator）。需要先 `setup`。
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

## 九、做不到或没验证的
- 像素风、精确像素尺寸、超出约 157 万像素的高清图。
- 部件不带骨骼数据：层级、遮挡顺序和旋转中心要在代码里定，manifest 里没有。
- 半透明素材（玻璃、烟雾）只能用 `--matte soft` 粗略处理，没有系统验证。
- 图层 SVG 导入 Figma、Illustrator 后的分组和可编辑性没有实际验证过。
