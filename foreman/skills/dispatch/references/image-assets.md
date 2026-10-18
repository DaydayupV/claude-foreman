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
- **先出整图、验收后再拆**：要保持同一个设计的，比如整页 UI 拆组件、场景分层、一个角色配套的几件道具。拆的时候把整图作为参考图传入，提示词写明必须保留的细节。实测带参考图拆部件能保留帽子、发夹、披肩这类细节，纯文字描述会丢。拆出来的每一件在作品里都按第六节当刚体用。
- 嵌在组件里的小图标（导航栏里的图标）单独列一格或单独出一张，不要指望从整页里再拆一层。
- 扩充现有素材集：把现有的一组作为参考图，要求 "exactly the same drawing style, outline weight, corner rounding, level of detail, proportions and palette as Image 1"，并写 "Do not copy any item from Image 1"。

## 六、用在 SVG、HTML 和动画里
作品最后是代码时，每个部件按 SKILL.md 的"按部件分"判断：整块动、接缝被盖住或相对不动的出图；本身要弯、转动时接缝会露出来、要和代码画的东西精确接触的由 Claude 手画；物理模拟、机械、文字、UI 控件和几何图形用代码画。同一个角色可以混合。
1. **列部件清单**：每个看得见的部件写明怎么动（不动、整块平移或转动、弯曲）、和谁相接、接缝被什么盖住、要不要和代码画的东西接触，据此定出图、手画还是代码画。动手前把结论用一两句话告诉用户。
2. **出整体参考图**：整个角色或整幅画面，最终的构图、配色和画风；风格写扁平、细节适中（第三节的积木，加一句 "moderate detail: simple shapes and few fine lines"），给定色板。要拆部件的角色，在提示词里让部件之间的接缝自然被盖住（领口盖住脖子、袖口盖住手腕、前面的物体挡住腰以下）。验收后它就是所有部件的参考。
3. **出图部件**：
   - 留在参考图原位置的部件（背景板、角色身上不动的部分）：参考图作 Image 1，用第七节的分层写法逐个取出，补上 "complete the parts hidden behind <挡住它的东西> naturally"，和别的部件相接的一端写 "continue it a little past the join, where <相邻部件> will cover it"。取出的图和参考图是同一张画布，按原位置叠回去就对齐。
   - 要换姿势、换状态或放到别处的部件：格子模板作 Image 1、参考图作 Image 2（第四节）。
   - 每件在作品里只整块动。
4. **局部变体（眨眼、张嘴）**：原部件作 Image 1，用第七节的局部修改写法只改那一处；`assets diff` 看整体变化；只取改动区域，边缘羽化 4–8 像素，作为补丁叠在原部件上，不整张换图。实测整张换图时，眼睛以外整颗头的轮廓一起位移约 1 像素，实际尺寸下有 6,000 多个像素在跳；只叠眼睛补丁时，变化只剩眼睛里的几百个像素。
5. **手画部分**：照参考图的配色和阴影层次画。线宽按出图部件换算：量出图里轮廓线有几个像素，乘以部件在画面里的缩放。会弯的肢体先画所有描边、再画所有填色，关节处的填色盖住内侧描边，弯曲时没有接缝；和出图部件相接的一端伸到出图部件下面。
6. **转不转 SVG**：扁平少色的素材 `assets cut --vector` 转 SVG，生成时写扁平风格、少阴影，矢量化时加 `--colors 8` 到 `12`，路径数能少一半左右；要固定配色时用 `--palette … --snap`。角色、带渐变或细节多的画保留 PNG，用 `<image>` 嵌进 SVG 或页面：动漫角色不减色时每件几十到五百条路径，网页上会卡，减色又会出色带。
7. **组装和检查**：`layers.svg` 是每个部件一个 `<g id>`、按源图位置排好的整体；也可以单独引用 `parts/<名字>.svg` 或 `parts/<名字>.png`。`manifest.json` 的 `crop` 只是部件在源图上的位置，放在页面上的位置在代码里定。装好后按实际显示尺寸渲染几个关键时刻（动作的两端、遮挡切换、变体出现时），看接缝、脱节，以及出图和手画部分的精细程度是否接近；动画交付前最好让没参与制作的模型或用户再看一遍。
8. **为什么这样分**（2026 年 10 月试片）：
   - 关节部件表：模型不按格子里的比例和关节位置画（偏离格子尺寸的两到四成），关节端头总会描一圈轮廓；装起来转动时像球形关节娃娃，交换上下层也只是换一条接缝露出来。
   - 按引导图出逐帧：同一张条带里人物一致，关节自然；但和代码画的东西的接触点对不准，8 帧里有 6 帧偏了（骑车试片里脚离脚踏零点几个鞋长），换成填色剪影引导、逐帧写动作说明也没改善。
   - 来自两次出图、又要拼在一起的两半，接缝对不上。
   - 出图的头放在手画的身体上：接缝被下巴和头发盖住，看不出来；主要问题是头比身体精细得多。
9. **逐帧精灵（实验性，用户明确要求时才做）**：只做不和其他东西接触的循环动作。每个动作出一条横向条带（4–8 帧），参考图和一张代码画的版式参考（格子、每帧的姿势剪影）一起作参考图；整条用一个比例切帧，不逐帧重新居中，按不动的区域对齐；每出一条立刻看，坏了只重出这一条。首尾衔接和连续播放时的闪动没有验证过，交付前让用户看实际播放。

## 七、改图和分层
- **局部修改**：原图作为 Image 1，提示词写 "Change ONLY <目标和位置>: <怎么改>. Keep every other part exactly unchanged: same parts, same positions, same sizes, same colors, same line art, and the same background."。改图会让其他区域有轻微变化（实测平均色差 2–3），用 `assets diff --before 原图 --after 新图 --slots 模板` 确认只有目标格变了，交付时只替换那个部件。
- **场景分层、取出部件**：背景板（`transparent_background: false`）写 "Remove <主体> completely and fill that area with the background that would be behind them … Change nothing else: same canvas size, same composition and framing"；主体层（`true`）写 "keep only <主体> exactly as they appear: same pose, same position in the frame, same scale … Same canvas size"。实测两层叠回去和原图几乎一样，但地面阴影两层都不带，要阴影就在任务说明里写明归哪一层或单独出一层。
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
- `--slots`、`--names`：按格子或名单命名（有模板时第 N 个名字对应格子文件里的第 N 个格子；模板里写的名字按格子号对应，合并过格子、编号不连续也不会错位）。
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
- 关节动作和精确对位：见第六节，实测做不到。
- 部件不带层级和遮挡顺序，要在代码里定，manifest 里没有。
- 半透明素材（玻璃、烟雾）只能用 `--matte soft` 粗略处理，没有系统验证。
- 图层 SVG 导入 Figma、Illustrator 后的分组和可编辑性没有实际验证过。
