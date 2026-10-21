# 出图素材：提示词、背景、格子模板和 assets 子命令

走图像模块的工作，在弹路线窗之前读这一篇：第零节是完整的流程和规则，后面几节是提示词、背景、格子模板、用在代码作品里的整套做法、改图和 `assets` 各命令的参数。SKILL.md 的"图片生成"只列了不能省的几条。

## 零、流程和规则
出图和手画都走图像模块，不用 `run`。图像任务不分等级，`plan`、`image` 和续接都不写 `--level`，推理强度用图像格子里写的；出图质量取决于图像模型，和推理强度关系不大。同一件事还要改代码（比如把图接进页面）时，代码部分另按执行定级。只看截图做视觉检查（`review --target visual`）属于审查，不走这里。

1. **范围**：要模型画的图形内容都走这里，不论最后交付的是位图，还是 SVG、HTML、canvas 或动画：照片、插画、贴图、精灵图、封面和主视觉、角色和吉祥物、场景、插画风图标、UI 组件的视觉、要切成单个素材或转成 SVG 的素材（包括 SVG、HTML、canvas 作品和动画里整块使用的插画）、给现有图片去背景、修改现有图片，以及照定稿图手画会弯的部件、纯矢量绘制。用户明确要求手写 SVG 或纯代码时不出图。
2. **弹窗选路线**：每个新的图形交付物开工前，按 SKILL.md"图片生成"里的路线表和弹窗写法，用 AskUserQuestion 弹窗：问题里带"图像路线"，header 写"图像路线"，四个选项以 ①②③④ 开头（① 位图、② 位图 + 矢量混合、③ 纯矢量，先出参考图、④ 纯矢量 / 代码）。`dispatch.auto` 开着也要弹。
   - 弹窗里写明（写在问题或各选项的说明里）：出图、手画各用哪个模型；参考图会不会上传给模型服务；返工规则：不设出图次数上限，同一个问题连续三次重出都没有改善就停下来问用户，用户给了上限就按用户的。要不要出几张候选图，在同一个弹窗里另问一题。
   - 用户的原话已经定了路线时照样弹窗，把那一项排在第一位，label 末尾加"（你已选定）"。
   - 不再问：同一个交付物的返工、局部重出、补丁、技术性重试。要重新问：换路线、加新的交付物、扩大范围、换协作方或厂商。
   - 同时还要确认角色分配时，两件事合成一次弹窗。
3. **确认凭据**：插件的钩子把路线弹窗的问题和回答按 Claude 会话记在 `~/.claude/foreman/answers/<会话>.jsonl`。`plan --module image` 只看这个会话里最近一次路线弹窗：用户选的就是 `--route` 那条才建计划；用户取消了、还没选、选了 Other 写了别的话，或者选的和 `--route` 不一致，都不建计划，这时按用户的回答处理，需要时重新弹窗。一次回答可以支撑这个交付物的几份计划（比如路线 ② 的 generate 和 draw）。answers 文件只由钩子写，不要自己写、改或删：这份凭据防的是漏问，挡不住伪造，伪造就是违规。已经弹过窗、用户也选了，`plan` 还说没有回答时，多半是钩子没生效（比如插件的钩子被禁用）：如实告诉用户，不要改用 `run` 出图。钩子 2026-10-19 在桌面版实测过；命令行版没有实测。
4. **建计划**：用到哪格建哪格的计划。路线 ① 只建 generate；路线 ② 先建 generate（定稿图、背景板、局部变体），取件之后再建 draw（会弯的部件）；路线 ③ 先建 generate（只出参考图），再建 draw（纯矢量成品）；路线 ④ 只建 draw。席位按 SKILL.md"一格有多个候选时"挑：generate 只挑能出图的（`capabilities.images` 为 `true`，目前只有 `codex cli` 类型），draw 挑能执行的。
   ```bash
   node "<脚本路径>" plan --cwd "<项目目录>" --module image --cell generate --route 2 --group <组名> --seat <generate 格子里的代号> --why "<理由>"
   ```
5. **启动**：`image --plan <plan_id> --seat 1 --brief <任务说明> --title <短标题> --scope <输出目录>`，不写 `--level`。启动后照常开实时查看。出一张图要几十秒，这段时间实时查看停在上一步是正常的；图生成后时间线上会出现一行"Generated image …"。
6. **分工**：画什么由 Claude 定：主体、风格、用途、画幅、部件清单和名字、色板、定稿图；图上要有文字的，给出原文、要求照抄。Codex 只出图。去背景、切部件、从定稿图取件、命名、减色、矢量化和检查由 Claude 在本机跑 `assets` 子命令（第八节），不派出去，也不让 Codex 做；会弯部件的描图和变形是例外，交给 Codex，它自己跑 `assets trace`、`capture`、`playback` 自查。不许用脚本冒充模型出图，但可以用脚本处理模型出的图。
7. **同源取件：Codex 只画整张画面，不画单个部件**：图像模型画不准关节转轴、和代码画的东西的接触点、两次出图之间的接缝，单独取出的部件也会被放大、重画（2026 年 10 月实测偏差动辄是部件长度的几成，单独取出的部件被放大 1.09–2.06 倍）。所以要相接的两块像素必须来自同一张图，或者一侧是代码画的。Codex 只出四种图、部件怎么取，见第六节的总则和第 1 步；按物理逐帧模拟的形状、和机械对齐的东西、文字、UI 控件、几何线性图标和图表用代码画。
8. **定稿图先给用户看**：按第六节第 2 步的定稿图模板写（只写画面上的要求，不写部件名单和拆分方法），用户认可后再出背景板、取件。接缝放在定稿图里已有的遮挡物边上。不让模型单独取出部件、删掉部件再收边，或者补画角色身上被挡住的部分。表情（眨眼、张嘴）在定稿图上局部改图，用 `assets patch` 只叠补丁：不整张换图，也不描。
9. **会弯部件的手画**：派给 draw 格子（路线 ②）。Claude 先取好件，再按第六节第 6 步的模板写任务说明：输入、固定好的页面框架和接口、转轴、动作公式、接缝要求和自查要求。交回后 Claude 自己截图、量指标验收，不采信它的自查结论。2026 年 10 月对照试片里，两边的指标打平，盲看时 Codex 手画的更自然。纯矢量路线（③、④）的绘制也派给 draw 格子。
10. **动手前告诉用户**哪些部件整块动、哪些交给 Codex 描成路径弯曲、哪些代码画，以及为什么。**动画交付前**用 `assets playback` 检查一圈播放（闪动、首尾衔接、跳帧），把生成的播放文件给用户看；连续播放有人看过才算验收完。
11. **任务说明**：
    - 写明调用方式（参数见第一节）。全新出图：`tools.image_gen__imagegen({prompt, transparent_background})`。改图、照参考图出图、拆图、分层：再加 `referenced_image_paths: ["<绝对路径>", …]`，提示词里用 "Image 1"、"Image 2" 按顺序指代。不传这个参数，工具会当成全新出图，参考图不起作用。参考图会上传给模型服务，敏感或未授权的图不要用。
    - 不写像素尺寸，只写画幅（1:1、3:2、2:3、3:1）；要别的尺寸，用 SVG 或者交付时另行缩放。
    - 要透明背景的素材写 `transparent_background: true`，背景、间距、风格和禁止项照第二、三节的模板写。
    - 两个以上部件：用第四节的格子模板命名，不按排列顺序命名：模型会打乱顺序。
    - 写明每张图保存到项目里的路径，原图照原样复制，不转换、不压缩。用户没要求变体时，每张源图只出一次。
12. **验收**：
    1. 结果里的 `module`、`step`、`route` 写明这是哪一格、哪条路线的任务。`generated_images` 列出这一轮新出现的图片原文件，`image_calls` 列出每次出图实际传的参数（从 Codex 的会话记录里读出）。该传参考图的步骤在 `image_calls` 里没有 `referenced_image_paths`，说明参考图没起作用，要返工（`warnings` 会提示）。两个字段都没有时，出图来源未经验证，先查记录目录和输出再下结论。`warnings` 里说路线 ④ 出了位图、路线 ③ 或 ④ 的 SVG 里嵌了位图（`<image>`）的，按返工处理：这两条路线的成品全是路径，不能拿嵌进 SVG 的 PNG 冒充矢量，路线 ④ 也不出位图。
    2. 要切图或矢量化的素材跑 `assets cut`：结果的 `checks` 里有 `fail` 的直接返工；`needs_review` 的项由 Claude 看图判断。
    3. 用 Read 看图（切过的看 `sheet.png` 对照拼图）：每一格是不是那个部件，细节、风格和配色对不对，图上的文字是否照抄。
13. **返工**：用 `resume --run <run_id> --brief …` 续接原来的图像任务，不写 `--level`，也不再弹窗。出图不设固定次数，不合格就重出，每次重出都要改点什么（提示词、参考图、改动范围），不原样重试。重出门槛见第六节第 9 步，主要有三条：定稿图里会动的部件被别的部件压住、中间没有描边或遮挡物隔开；背景板或局部变体测出的对齐（`measured`）偏移超过 3 像素或缩放偏离超过 1%；背景板里还留着主体的残影。动起来接缝错开、线宽突变不是出图的问题：部件同源，本来是对齐的，要改变形代码（支点、权重、位置），不放大手画部分去盖；Codex 写的变形按 SKILL.md"返工与失败"返工。自带命令报"拿不准"时按门槛处理，不另写配准或拟合脚本绕过去。同一个问题连续三次重出都没有改善时停下，把问题、试过的做法、已经出了几次图和可选的做法交给用户决定；用户给了出图次数上限时按用户的。出图不套用"返工与失败"里由 Claude 接手的规则，Claude 不能出位图。局部返工把原图作为参考图传入，提示词写"只改 X，其余不变"（第七节）；交付时只替换被改的那个部件，其余部件沿用上一版的文件。
14. **矢量化**：只有扁平、颜色少的素材转 SVG（第六节第 7 步）。角色、带渐变或细节多的画默认保留 PNG，用 `<image>` 嵌进 SVG 或页面，交付时告诉用户这部分不是纯路径；这是路线 ①、② 的做法，用户选了 ③ 或 ④ 时不能这样交付。

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
要循环平移的背景层（远山、云带、地面）写成能左右无缝接上的条带，不要事后用"原图 + 水平镜像"拼：镜像的对称一眼能认出来。
```text
Tiling: this is a horizontally repeating strip. The left and right edges must continue into each other seamlessly (the same height and shapes at both edges), so copies placed side by side show no seam. Do not make it mirror-symmetric.
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
- **先出整图、验收后再拆**：要保持同一个设计的。代码作品里的角色和场景按第六节从定稿图同源取件，不让模型拆。整页 UI 拆组件、一个角色配套的几件道具这类各自单独使用的素材，把整图作为参考图传入，另出一张部件表，提示词写明必须保留的细节。实测带参考图出部件能保留帽子、发夹、披肩这类细节，纯文字描述会丢。
- 嵌在组件里的小图标（导航栏里的图标）单独列一格或单独出一张，不要指望从整页里再拆一层。
- 扩充现有素材集：把现有的一组作为参考图，要求 "exactly the same drawing style, outline weight, corner rounding, level of detail, proportions and palette as Image 1"，并写 "Do not copy any item from Image 1"。

## 六、用在 SVG、HTML 和动画里
总则：要相接的两块像素必须来自同一张图，或者一侧是代码画的。所以 Codex 出图时只画整张画面，不画单个部件；作品里的每个部件都从同一张定稿图上取：整块动的由 Claude 在本机裁出，会弯的交给 Codex 照定稿图手画成路径（第 6 步）。Codex 只出四种图：定稿图；在定稿图上改出的背景板和局部变体；不在定稿图里的独立素材（图标、道具、贴图组用第四节的格子模板命名，能左右接上的循环条带，本身就是交付物的位图）。

1. **列部件清单**：每个看得见的部件写明怎么动（不动、整块平移或转动、弯曲）、和谁相接、接缝被什么盖住、要不要和代码画的东西接触，据此定怎么取：
   - 整块动的（头、不弯的身体、道具）和静止的前景遮挡物（柜台）：从定稿图按原位置裁成 PNG；
   - 会弯、要和代码画的东西精确接触的（手臂连同袖子、腿、尾巴、翅膀）：交给 Codex 照定稿图描成路径，用骨骼权重变形，接触点用 IK 算（第 6 步）；
   - 物理、机械、文字、UI、光效：代码画。

   接缝放在定稿图里已有的遮挡物边上（衣服的带子、领口、袖口、柜台）；跟着动的衣物和配件（袖子、裤脚、手套）和会动的部件归在一起；脸和表情留在整块的头上，表情一律走第 5 步的补丁，不描。动手前用一两句话告诉用户哪些部件整块动、哪些交给 Codex 描成路径弯曲、哪些代码画。
2. **出定稿图**：整个角色或整幅画面，构图取最终画面的构图。提示词按下面的模板写，每一条都从第 1 步的部件清单推出来，写成画面上的要求；不要在提示词里写部件名单、拆分方法，也不要写 puppet、parts、joint、pivot、separate 这类词，模型会画成部件表或带断面的关节。用户看过、认可后才往下做。
```text
<主体、动作和构图>
Composition for animation:
- <每个会动的部件> is fully visible and does not overlap <它附近要分开的部件>.            （第 1 步里会动的部件逐个写）
- <接缝处的遮挡>, e.g. the collar covers the neck, the cuff wraps the wrist, <前面的物体> hides everything below the waist.
- <每个会动的部件> is drawn in the middle of its motion: <中间姿势>.
- <会动的部件> cast no shadow on other parts; no glow, light rays or sparkles cross between objects.
- Do not draw <代码画的东西：热气、粒子、反光、文字、UI>; leave <要写字的地方> blank.
Style: clean anime cel shading as flat vector art (按第三节的风格积木), bold outline of the same weight everywhere (<描边色>).
Detail: the same level of detail everywhere: <头发、衣服等细节多的地方> drawn with a few large simple shapes, not many thin strands or fine lines. <要描成路径的部件> are flat colors with exactly one hard-edged shadow tone, no gradients.
Palette: <色板>.
<背景积木；整幅画面时不透明>
No text, no letters, no numbers, no labels, no grid lines, no frames, no watermark.
```
3. **出背景板**：定稿图作 Image 1，不透明改图（`transparent_background: false`），用第七节的背景板写法把含有会动部件的主体整个去掉，补上后面的背景，画布不变。背景板只写回主体原来所在的范围，离主体远的地方有轻微变化也不影响。不要让模型单独取出某个部件，也不要让它补画角色身上被挡住的部分。
4. **取件**：写部件清单 `pieces.json`（坐标都是定稿图的像素坐标），运行 `assets layers --ref <定稿图> --plate <背景板> --pieces <pieces.json> --out <目录>`：
```json
{ "pieces": [
    { "name": "counter", "kind": "raster", "lasso": [[x, y], …], "whole": true },
    { "name": "head", "kind": "raster", "lasso": [[x, y], …] },
    { "name": "body", "kind": "raster", "lasso": [[x, y], …], "extendUnder": [{ "piece": "head", "dist": 12 }] }
  ],
  "seams": [[[x, y], …]],
  "line": 20 }
```
   - `name`：只用字母、数字、`-` 和 `_`，不重名，不叫 `static`；它也是输出的文件名。
   - `lasso`：圈出这个部件的多边形。部件范围 = 套索里面、和背景板不一样、被描边分开的区域，描边归离它最近的部件。套索按清单顺序先到先得：靠背景的一侧可以画宽，压着别的部件的那一段要贴着这个部件的外缘画。
   - `whole`：套索里的像素全取，给静止的前景遮挡物用（它在背景板里也有）。
   - `seams`：定稿图里没有描边、由 Claude 定的接缝（比如下巴和脖子同色相连），画成折线当描边用。`line`：描边的亮度上限（Lab 亮度，默认 20）；描边有断口、两个部件连成一块时调高。
   - `extendUnder`：下层部件顺着平涂色往上层部件下面延长 `dist` 像素，取转动时会露出来的最大距离；延长段只铺在上层部件盖住的地方。
   - `kind: "vector"`：这个部件再转成 SVG，只给扁平少色的部件用。SVG 用整张画布的坐标，所以清单里它的位置是整张画布，包围框另记在 `box`。

   输出 `static.png`（定稿图，主体范围换成按外圈色差校过色的背景板）、每个部件的 PNG 或 SVG、`layers.json` 和 `layers.js`（`window.LAYERS`，每层在定稿图上的位置）、`check.png`。页面按 `layers.js` 的位置放部件，不缩放、不对齐；转动支点直接在定稿图坐标里量。

   验收看 `check.png`：每个部件的颜色只盖在它自己身上，延长段颜色浅一些。品红框是拿不准的区域（`uncertain`），逐个看：框里是背景板在主体附近重画过的背景、部件上没有多出背景，就没事；部件缺了一块或带上了背景，先改套索、`seams`、`line`，原因在背景板（主体没去干净）时按第 9 步重出背景板。`reassembled_diff_px` 是部件（不含延长段）叠回静止层后和定稿图明显不同的像素数，1536×1024 的画面实测约 1,900–2,700，多出很多时看是哪里。
5. **局部变体（眨眼、张嘴）**：定稿图作 Image 1，用第七节的局部修改写法只改那一处；再运行 `assets patch --base <定稿图> --variant <改图> --out <目录>`：它先把改图对回定稿图（拿不准时按原位），去掉轮廓的细微位移和外轮廓一圈的变化，只留成片的改动，羽化后写出补丁 `patch.png`（和定稿图同一画布）、叠好的 `preview.png` 和对照图。知道要取哪一块时加 `--keep <区域>`。补丁叠在它所属的部件上，跟着部件一起动。不要整张换图：实测整张换图时，眼睛以外整颗头的轮廓一起位移约 1 像素，实际尺寸下有 6,000 多个像素在跳；只叠眼睛补丁时，变化只剩眼睛里的几百个像素。
6. **会弯的部件交给 Codex 手画**：建 draw 格子的计划（路线 ②，`plan --module image --cell draw --route 2 …`），用 `image --plan … --seat … --scope <它的输出目录>` 派出，Claude 写任务说明并验收。
   - **Claude 先准备好**：第 4 步取件时把会弯的部件也列进清单（`kind: "raster"`），裁出的 PNG 只给 Codex 当描图参考；页面框架由 Claude 写好，包括静止层、整块部件、代码画的东西、层级、`?t=` / `?rest` / `?capture` 参数，并按动作公式算好每个关节每一刻的角度，留一个空接口给 Codex 实现，比如 `buildRig({ <各层的 <g>> }) → { arm(aU, aF, aH), tail(t, amp) }`；转轴写进单独的文件（定稿图坐标）。
   - **任务说明写明**：
     - 范围：只写它自己的 rig 文件和工作目录；
     - 输入在哪；
     - 接口和每个角度的含义（全为 0 就是定稿图的姿势）；
     - 部件必须是照定稿图描的 `<path>`，不能嵌 PNG，不能用 `<image>`、滤镜或遮罩；
     - 静止姿势和定稿图一样：轮廓、描边粗细、底色和阴影；
     - 接缝要求：靠遮挡物的一端不动，接缝处不露背景，描边粗细不突变；
     - 只用原生 SVG 和普通 JavaScript；
     - 可用的命令：`assets trace`、`capture`、`playback`；
     - 自查：截 `?rest` 和每个动作的两端，看各个接缝的 2 倍特写，跑一圈播放；
     - 报告：用了哪些种子点和参数、权重怎么设的、剩下的问题。
   - **做法要点**（写进说明，或者让它读这一步）：
     - 描图：`assets trace --image <定稿图> --seed <部件填色里的一点> --box <部件周围的矩形> --out <目录>` 从种子点圈出部件，分成描边、底色和阴影（`--colors` 定几种填色），输出定稿图坐标的 `trace.svg`（每层一个 `<path>`，轮廓是曲线，内部细线是填色里的洞）和对照图；颜色不止一种的部件每种颜色放一个种子点；描出来的线宽、配色和裁出的部件同源，不用换算。
     - 变形：关节两侧共用一个权重场，靠接缝的一端钉在不动的部件上（尾根这类固定端留一段钉住带，再逐渐接入弯曲）；变形前把长曲线细分，免得一段曲线的控制柄跨过关节，被扯出尖角。
     - 画法：先画所有描边、再画所有填色，关节处的填色盖住内侧描边；和整块部件相接的一端伸到它下面。
   - **验收由 Claude 自己做，不采信它的自查结论**：
     - 看 diff，只许改了它自己的文件，也查一下有没有写到工作区外；
     - 截 `?rest`，在部件范围里和定稿图比：试片两份手画的平均 RGB 差约 4，直接贴裁出的 PNG 是 0.3；
     - 看各个接缝在动作两端的 2 倍特写；
     - 跑 `assets playback`：闪动、首尾差、跳帧都要为 0；
     - 最后亲眼看播放。
     - 不合格就按 SKILL.md"返工与失败"用 `resume` 返工一次（不写 `--level`），在返工说明里写清楚哪里不对；还不对就由 Claude 接手。
7. **转不转 SVG**：扁平少色的素材 `assets cut --vector` 转 SVG，生成时写扁平风格、少阴影，细节多、颜色杂的素材矢量化时加 `--colors 8` 到 `12`，路径数能降到原来的四分之一以下（本来就扁平的图标几乎不变）；要固定配色时用 `--palette … --snap`。角色、带渐变或细节多的画保留 PNG，用 `<image>` 嵌进 SVG 或页面：动漫角色不减色时每件几十到五百条路径，网页上会卡，减色又会出色带。这是路线 ①、② 的做法；用户选了路线 ③ 或 ④ 时成品只能是路径，不能这样交付。
8. **组装和检查**：页面要支持 `?t=<秒>` 停在某一时刻（截图和检查都靠它）。装好后用 `assets capture --url <页面> --times <秒,…> --size <显示尺寸> --zoom <名字=接缝处的矩形;…> --out <目录>` 按实际显示尺寸截几个关键时刻（动作的两端、遮挡切换、变体出现时），加 2 倍特写，看接缝、脱节和线宽。动画再用 `assets playback --url <页面> --loop <一圈的秒数> --static <不该动的区域;…> --out <目录>` 截下一圈：`static` 里不该动的区域有变化就是闪，`seam` 不为 0 就是首尾接不上，`jumps` 列出突然跳一下的时刻；把 `playback.png`（APNG，浏览器里直接播放）给用户看。截图要用本机的 Chrome 或 Edge，找不到时用 `--browser` 指定。动画交付前最好再请没参与制作的模型做一次视觉检查：`review --target visual --file <截图或 playback.png> …`，审查说明里写清要看什么（接缝、闪动、首尾衔接、线宽）；只有能看图的协作方能接（目前是 Codex）。
9. **重出门槛**：下面任一条成立，就改做法重出那张图，不在下游修补。
   - 定稿图：会动的部件被别的部件压住、中间没有描边或遮挡物隔开，或者接缝不在遮挡物边上。改提示词重出，用户重新认可。
   - 背景板：`layers.json` 里 `plate.measured`（测出的对齐，不管最后是不是按原位用的，也不管 `ambiguous`）的 `offset` 超过 3 像素或 `scale` 偏离 1 超过 1%，说明整张被挪动、重画了（实测合格的背景板偏移 0.1–0.7 像素，缩放偏离不到 0.1%）；`plate.noise`（主体以外背景板和定稿图的典型色差，实测 1.4–1.6）超过 3；`static.png` 里还看得到主体的残影。重出时在提示词里点名残留的东西。
   - 局部变体：`patch.json` 里 `align.measured` 的 `offset` 超过 3 像素或 `scale` 偏离 1 超过 1%（实测合格的改图偏移 0.6–0.8 像素）；补丁范围 `box` 明显超出要改的地方。重出时把改动范围写得更窄。
   - 动起来以后：2 倍特写里接缝错开超过约 3 像素、线宽突变，不是出图的问题。部件同源，本来是对齐的，要改变形代码（支点、权重、位置），不放大手画部分去盖：Codex 写的按第 6 步返工。
   - 自带命令报"拿不准"时按上面几条处理，不另写配准或拟合脚本绕过去。同一个问题连续三次重出都没有改善时停下，交给用户决定（第零节第 13 条的返工规则）。
10. **为什么这样分**（2026 年 10 月试片）：
   - 让模型画关节部件表、按引导图出逐帧、分两次出图再拼：关节转轴、和代码画的东西的接触点、两半之间的接缝都对不准，偏差动辄是部件长度的几成；逐帧里 8 帧有 6 帧接触点偏了。
   - 从参考图单独取出透明底部件：头被放大 1.86–2.06 倍、身体 1.4–1.59 倍，有的比例和颜色被重画；`align` 对大块平涂的部件偏向缩小，给不出可信结果；让模型"去掉手臂""去掉袖子再收边"，4 次都没照做，袖口被重画成带内沿的开口、低了约 50 像素。
   - 不透明的整张改图能保住位置：背景板远离主体的地方 99.6% 不变；单独出的柜台层偏了约 15 像素，从背景板裁出来的逐像素一致。
   - 同源取件试片：只出背景板和闭眼两张图，头、身体、柜台和定稿图逐像素一致，裁出的和描出的描边都是 3 像素，播放没有闪动、首尾差为 0。
   - 手画对照：同一套输入、同一个页面框架和动作公式，挥手的手臂连袖子和尾巴分别由 Codex（gpt-6.1-sol，effort max）和 Claude 各自独立手画。指标打平：静止姿势平均差 4.07 对 4.03，接缝露出背景都是 0，播放检查都是 0。盲看时用户判 Codex 那份更自然。它多做了几处：变形前细分曲线、肘部斜向过渡、尾根钉住带、皮肤用渐变。代价是 26 分钟和较多 token。它第一轮把中文路径写成百分号编码，写到了工作区外，所以验收要查这一点。
   - 定稿图模板：头发的细节和渐变明显减少，要描的尾尖从渐变绒毛变成平涂，出图和描出部分的细节差距缩小约六成。

## 七、改图和分层
- **局部修改**：原图作为 Image 1，提示词写 "Change ONLY <目标和位置>: <怎么改>. Keep every other part exactly unchanged: same parts, same positions, same sizes, same colors, same line art, and the same background."。改图会让其他区域有轻微变化（实测平均色差 2–3），用 `assets diff --before 原图 --after 新图 --slots 模板` 确认只有目标格变了，交付时只替换那个部件。
- **背景板**：定稿图作为 Image 1，`transparent_background: false`，写 "Remove <主体> completely and fill that area with the background that would be behind them … Change nothing else: same canvas size, same composition and framing"。主体投在地面上的阴影写明留下还是去掉：留下就是静止层的一部分，去掉就把它当作一个部件取出。不要用透明底让模型"只保留主体"来取主体层：取出来的会被放大、重画（第六节第 10 步）。
- **给现成图去背景**：原图作为 Image 1，"Remove only the background and make it fully transparent. Keep <主体> exactly as they are … Do not redraw or restyle anything."
- 连续多轮改同一张图会累积变化，改了两三轮后从源图重新出。

## 八、assets 子命令
都在本机运行，不调用模型；输出 JSON。写法是 `node "<脚本路径>" assets <命令> …`，脚本路径见 SKILL.md 的"附：调用方式"。

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

## 九、做不到或没验证的
- 像素风、精确像素尺寸、超出约 157 万像素的高清图。
- 让模型画关节部件、单独的部件或逐帧动作：见第六节，实测对不准。
- 大幅转身、换视角：需要定稿图里没有的那一面，同源取件做不到。
- 背景板和局部变体只按等比缩放和平移对回定稿图，不处理旋转；被模型转了角度时对不准，要重出。
- `assets layers` 靠和背景板的差别认出主体：主体和背后的背景同色、中间又没有描边的地方分不开，要用 `seams` 画出接缝。接缝下面延长的那一段只是顺着平涂色铺开，露出得多时显得平，转动幅度控制在 `extendUnder` 的距离以内；这一段只在两个试片里验证过。
- 部件不带层级和遮挡顺序，要在代码里定：`assets cut` 的 manifest 和 `assets layers` 的 layers.json 里都没有。
- 半透明素材（玻璃、烟雾）只能用 `--matte soft` 粗略处理，没有系统验证。
- 自带描图碰到细节多的角色部件，1 像素宽的细线（发丝）会断成一串点，路径数也多：这也是角色保留 PNG 的原因之一。
- 图层 SVG 导入 Figma、Illustrator 后的分组和可编辑性没有实际验证过。
