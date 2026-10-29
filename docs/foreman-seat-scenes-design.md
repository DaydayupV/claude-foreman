# 席位场景、可配置补漏席与项目覆盖设计

讨论和审查的阵容原来只按等级分格。研究证据审查要"广"，高风险代码审查要"准"，两者挤在同一格里，调大一边就会拖累另一边。本文把三件事一起定下来：

- 席位数可以按场景写；
- 补漏席改成可以配置；
- 项目配置从"只能收紧"改成"可以覆盖"。

本文依据 2026-10-29 的一场 3 级讨论（计划 `20261029-174259-6rz4`，组名 `lineup-design-1029`）。之后用户把讨论得出的"命名阵容"方案简化成了现在这一版，当天逐条确认。

## 1. 目标与范围

**要做到**
- 不需要场景的用户看不到任何新概念：配置照旧写数字，行为和 1.2.1 一样，只多出一项显式的 `gap`。
- 需要场景的用户在偏好文件里定义场景和路由，在 `seats`、`gap` 里按场景写数字，用候选的排列顺序决定小场景用谁。
- 补漏席按等级（以及场景）开关，默认关闭，并且显式写进配置。
- 项目配置写在仓库的 `.claude/foreman.json` 里，可以覆盖全局配置；用户配置里的 `projects` 去掉。
- 项目偏好 `.claude/foreman.md` 优先于用户偏好。

**这次不做**
- `--count-why` 只要不为空就放行：保留不改，只记进计划并显示出来。
- 计划席启动时可以换成同厂商的另一个模型：之后单独修。
- 按场景单独设候选子集、推理强度或必选。场景只决定席位数和补漏，用谁靠候选顺序。

## 2. 配置分层

叠加顺序（后面的覆盖前面的）：

1. 脚本内置默认值；
2. 用户配置 `~/.claude/foreman/config.json`（`FOREMAN_CONFIG` 可以换路径）；
3. 项目配置 `<项目目录>/.claude/foreman.json`。

项目配置能写的范围，就是原来 `projects` 一项能写的范围：
- `modules` 下的所有格子，以及 `discuss`、`review` 的 `seats`，`review` 的 `gap`；
- `dispatch` 下的 `discuss_max_rounds`、`timeout_min`、`stall_min`、`busy_ask_min`。

合并方式和用户配置覆盖默认值一样：
- 写了的格子整格替换，没写的沿用用户配置。
- `seats`、`gap` 按等级覆盖：写了哪一级就替换哪一级，写成按场景的对象时整级替换。
- 可以加候选、改必选、调高席位、打开补漏、调高推理强度、延长时长。
- 项目配置只能引用用户配置 `agents` 里已有的代号，不能写 `agents`、`auto`、`watch`、`intro`、`runs_dir`。写了这些字段的，忽略并提示，不报错，以免旧仓库里按"只能收紧"时代写的文件让命令全部停下。
- 项目配置里的旧写法 `levels` 照旧只在内存里按 `modules` 读，并提示改写。
- 合并后整体按 `validateConfig` 校验，写错时报错指出是项目配置的哪个字段。

**删掉"只能收紧"的整套逻辑**：
- `projectConfig` 里的收紧判断（删条目、降强度、取较小值等）；
- `closed_by_project` 字段和相关显示；
- "项目把格子写成 `claude code` 后不能用 `--agent` 点名"的限制；
- R1 里"项目关掉整格时必选算没做"的说法。项目把某一格配成 `"claude code"` 是正常的安排。

**去掉用户配置的 `projects`**：
- 读到时不再生效，每次读配置都提醒一次（`summary.warnings` 里 kind 为 `obsolete_projects`，带上每一项的键）。
- 不报错，也不自动往别的仓库写文件。迁移交给 `/foreman:setup`（第 8 节）。
- `config` 输出里的 `project_override` 改成 `project_config`：`{ "path": "<项目配置文件路径>", "cells": ["review.complex", …] }`，没有项目配置时为 `null`。

## 3. 偏好文件与场景块

偏好文件仍是两份：用户偏好 `preferences.md`（和用户配置在同一个目录），项目偏好 `<项目目录>/.claude/foreman.md`。
- 两份都读；内容冲突时以项目为准。
- 删掉"项目偏好来自克隆仓库、只能更严"的规定。
- 偏好文件仍然只能在硬规则以内调整做法，改不了配置文件本身。

**场景块**：只有放在标记之间的内容，脚本才认作场景定义。

```markdown
<!-- foreman:scenes -->
## 场景路由
- **code**：评判或决定代码、接口、配置、脚本、测试的改动；`--target diff` 的审查一律算 code。
- **research**：研究结论和证据、研究方案、卡片、说明文档、研究方向构思；`--target claims` 的审查一律算 research。
- 两类都有的拆成两个计划；拿不准时选席位多的场景。
<!-- /foreman:scenes -->
```

- 块里以 `- **<名字>**：` 或 `- **<名字>**:` 开头的行定义一个场景。名字只能用小写字母、数字和连字符，以字母开头，不能重名。
- 块里的其他文字是写给 Claude Code 看的路由说明，脚本不解析。块外面写的场景，脚本一概不认。
- 生效的场景定义：
  - 项目偏好里有场景块，就只用项目的；块里一个场景都没写，表示这个项目不用场景模式；
  - 否则用用户偏好的；
  - 两份都没有场景块，就是没有场景定义。
- 一份文件里有多个场景块、开始和结束标记不配对，都算场景块写错（见第 4 节的一致性检查）。

## 4. seats、gap 与场景模式

### 写法
- `seats`（`discuss`、`review`）：每一级写正整数，或者写 `{ "<场景>": 正整数, … }`。
- `gap`（只限 `review`）：每一级写 `true`/`false`，或者写 `{ "<场景>": bool, … }`。写在 `discuss` 里报错。
- 某一级的 `seats` 或 `gap` 只要有一个写成了对象，这一级就叫"拆分的一级"。
- 写数字或 bool 表示这一级各个场景都一样。

### 默认值和第一次生成的配置
- `DEFAULT_GAP = { review: { simple: false, normal: false, complex: false } }`，旁边就是 `DEFAULT_SEATS`。插件里写明默认值的只有这一处，文档只在 `references/config.md` 写一次。
- 第一次运行生成的配置显式写上 `review.gap`，三级都是 `false`。

### 一致性检查
拿生效的场景定义（第 3 节）对照合并后的 `seats`、`gap`：

| 场景定义 | seats/gap | 结果 |
|---|---|---|
| 没有 | 全部是数字和 bool | 普通模式 |
| 有 | 全部是数字和 bool | 普通模式，提醒"偏好里定义了场景，但配置没用上" |
| 场景块写错 | 全部是数字和 bool | 普通模式，把场景块的问题作为提醒报出，不拦计划 |
| 没有（或场景块写错） | 有对象 | 错误 |
| 有 | 某个对象的键和定义的场景不完全一样 | 错误：指出哪一个字段多了或少了哪些名字 |
| 有 | 对象的键都和定义一致 | 场景模式 |

另外，每个场景的 `seats` 都不能少于这一格的必选数。这条和格式错误一样，读配置时就报。

**报错范围**：只有一致性错误（上表的两种"错误"）不在读配置时停下，而是：
- `config` 输出里 `scenes.problems` 列出问题，`check` 显示 ❌，`summary.warnings` 带上 kind `scenes_mismatch`；
- `plan` 建讨论或审查计划时拒绝，报错里写明原因和改法；
- status、board、watch、stats、run 和图像任务照常工作。

`config` 输出新增 `scenes`：`{ "names": [...], "source": "user" | "project" | null, "file": "<偏好文件路径>", "problems": [...] }`。`resolved_modules.review.gap` 给出生效后的值。

## 5. 计划的检查（`plan`）

### 选场景
- 讨论或审查遇到拆分的一级时，`plan` 必须带 `--scene <名字>` 和 `--scene-why "<依据>"`，名字必须是生效的场景之一。
- 没拆分的一级：有场景定义时可以写 `--scene`（同样要写 `--scene-why`），只记录下来供统计用；没有场景定义时写 `--scene` 会被拒绝。
- `run`、`image` 写 `--scene` 一律拒绝。
- 计划记下 `scene`、`scene_why`。

### 席位数
- `configured` 取 `seats[level]`；拆分的一级取 `seats[level][scene]`。其余照旧：外部席位数要等于 `min(configured, 能用的候选数)`，不等时要写 `--count-why`。
- 补漏席不计入外部席位数，现在审查的每一级都是这样，不再只限 complex。

### 按顺序挑（只对按场景拆分的一级检查）
按场景拆分的一级，"能用的候选"按格子里的排列顺序处理（必选的基础模型先占位）：
1. 去掉做不了的：不支持这个模块的；visual 审查里不能看图的。
2. 按基础模型（`modelIdentity`，用每个候选实际用的模型）去重，同一个基础模型只保留排在前面的那个。

期望的主席位 = 必选 + 剩下的候选里按顺序取前几个，凑够 `seat_target`。计划里主席位的协作方去重之后，必须和期望的完全相同；不同时要写 `--count-why`。脚本看不出来的跳过原因（材料不能发给这一家、额度用完）就写在这里。

没拆分的等级（包括定义了场景、但这一级写的是数字的）不检查顺序，仍由 Claude 按 `references/seats.md` 挑；补漏席同样只在拆分的一级按顺序检查。

### 补漏席
- 补漏席的写法照旧是 `=补漏` 或 `=gap`。一份计划最多一个补漏席，写了两个时一律拒绝，`--count-why` 也不能放行。
- 补漏开关取 `gap[level]`；拆分的一级取 `gap[level][scene]`。讨论没有补漏席，讨论计划里写了补漏席就拒绝。
- 开关开着、有补漏候选（主席位之外还有能用的候选，而且它的基础模型和所有主席位都不同）时，必须恰好有一个补漏席：
  - 场景模式下，必须是按顺序轮到的第一个补漏候选；
  - 普通模式下，任意一个补漏候选都行。

  没写补漏席、或者写的不对时，要写 `--count-why`。
- 开关关着时写了补漏席，要写 `--count-why`。
- 补漏席的基础模型不能和任何主席位相同，这条照旧检查，并且扩展到每一级。
- 补漏席启动时（`review --plan … --seat <补漏席>`），还要和 Claude Code 席提交时报的模型（`submit --model`）比较基础模型，相同就拒绝。R5 要求 Claude Code 先提交，所以启动补漏席时已经知道这个模型。
- `planStatus` 的 `gap_unfinished` 照旧，只是不再只限 complex。

### 启动和显示
`status --plan` 的输出新增 `scene`、`scene_why`、`gap`（这份计划生效的补漏开关）。

## 6. 迁移与兼容

- **补写 gap**：沿用补写 `seats` 的机制（`migrateConfig` 一带）：用户配置的 `review` 没写 `gap` 时，补写成原来的实际行为 `{ simple: false, normal: false, complex: true }`。照旧先备份成 `.bak`，保留文件权限，再提示。写不进去时只在内存里补。项目配置不改写。
- 新生成的配置三级都写 `false`（第 4 节）。
- **旧版插件**读到新写法会报错，不会悄悄忽略：
  - `seats` 写成对象，旧版会报"seats 无效"；
  - `gap` 不在旧版认识的格子里，会报"未知格子"。

  所以补写了 `gap` 以后，每台电脑都要升级。这和当初加 `seats` 时一样，发版说明里要写明。
- 用户配置里的 `projects`：提醒、忽略，由 setup 迁移（第 2、8 节）。

## 7. 显示

- `config` 的席位表（`report.mjs` 的 `seatsTable`）：
  - 拆分的一级在"席位"一列写成 `code 2 · research 6`；
  - 新增"补漏"一列：关、开，或者按场景写成 `code 关 · research 开`；
  - "实际怎么派"一列按补漏开关描述。
- `check`：有项目配置时，列出它覆盖了哪些格子、哪些时长。
- `status --plan`、网页看板、终端看板（`display.mjs`、`watch-group.mjs`、`board/index.html`）：计划的标题行显示场景名，悬停或展开时显示 `scene_why`。
- `stats --by` 增加 `scene`，可以和 `effort`、`cell` 组合。没有场景的计划记为 `—`。

## 8. setup

在"④ 修改建议"的第一张表里新增两类建议：

1. **场景模式**（用户配置的 `seats`、`gap` 全是数字和 bool，而且没有生效的场景定义时）：
   - 讨论或审查的 complex 候选比这一级的席位数多出两个以上时，推荐开启；否则也列出来，但推荐"不开"。
   - 推荐开启时给出：
     - 写入用户偏好的场景块原文，默认两个场景 code 和 research，内容用第 3 节的样板；
     - 按现有配置算出的 `seats`：code 沿用现在的数；research 的审查取 complex 候选数和 6 里较小的那个，讨论取 complex 候选数；
     - `gap`：审查 complex 的 code 为 `false`、research 为 `true`，其余照旧。
   - 用户同意后：先备份配置和偏好文件，再写入。偏好文件里已经有场景块时只替换块里的内容，没有就追加到文件末尾，不碰块外面的内容。
2. **旧的 `projects`**：每一项列成一条建议，"迁移到 `<目录>/.claude/foreman.json`"。
   - 目录不存在的，推荐删除；
   - 目标文件已经存在的，给出合并后的内容（`projects` 这一项的格子覆盖原文件里同名的格子），让用户确认。
   - 确认后写入，并从用户配置里删掉 `projects`。

## 9. 规则和文档

- **dispatch `SKILL.md`**：
  - "开始前"删掉项目偏好只能更严的那一段，改成"两份都读，冲突时以项目为准"；
  - 硬规则 R1 删掉 `closed_by_project` 的说法；
  - R5 加一句：场景模式下，偏好没写到的情况选席位多的场景，`--scene-why` 要写依据偏好里的哪一条。
- **`references/config.md`**：
  - 分层改写，删掉"按项目覆盖：写在用户配置里"和"项目配置：只能收紧"，新增"项目配置：覆盖全局"；
  - "候选和必选"写明 `seats`/`gap` 的两种写法、默认值和场景模式；
  - 新增"场景"一节：场景块格式、一致性检查、报错范围。
- **`references/seats.md`**：第 3 步分成普通模式和场景模式；补漏席按开关。
- **`references/review.md`**：补漏轮按开关、不再只限 3 级；写 `--scene`。
- **`references/discuss.md`**：写 `--scene`。
- **`references/cli.md`**：`plan` 的新参数和 `status --plan` 的新字段，`stats --by scene`。
- **`references/roles.md`**：补漏席不再只限 3 级。
- **setup `SKILL.md`**：第 8 节的两类建议。
- **钩子**：会话开始时注入偏好的说明。
- **README（中英）**、`docs/foreman-modules-design.md` 里关于项目配置的部分。
- 英文插件 `foreman-en/` 逐个文件同步。

## 10. 改动清单

| 文件 | 改动 |
|---|---|
| `scripts/config.mjs` | `DEFAULT_GAP`；`normalizeModules` 补齐 gap；`validateModuleKeys` 认 `gap` 和按场景写的对象；删 `projectOverride`；`projectConfig` 改成合并加校验；迁移补写 gap；初始配置写 gap；解析场景块（`readScenes(cwd)`）和一致性检查；`config` 输出 `scenes`、`project_config` |
| `scripts/plan.mjs` | `cmdPlan`：`--scene`、`--scene-why`、按场景取席位数、顺序检查、补漏开关和一席上限；`planStatus` 新字段 |
| `scripts/cli.mjs` | 新参数的帮助文字；启动补漏席时比较 Claude Code 席的模型 |
| `scripts/report.mjs` | 席位表、补漏列、项目配置覆盖了哪些格子 |
| `scripts/status.mjs`、`display.mjs`、`watch-group.mjs`、`board/index.html` | 显示场景 |
| `scripts/stats.mjs` | `--by scene` |
| `scripts/messages.mjs`（中英） | 新的提示文字，删掉收紧相关的 |
| 测试 | 改写 `project-tightening.test.mjs`（改名为 `project-config.test.mjs`）；改 `config`、`seats`、`plan`、`migration`、`setup-report`、`skill-docs`；新增 `scenes.test.mjs` |

## 11. 测试要点

- 普通模式：只补写 gap，席位检查和 1.2.1 一样。
- 补漏席：开关的各种组合、两个补漏席、讨论里写补漏席、启动时和 Claude Code 席的模型相同。
- 场景模式：一致性检查的五种情况、项目场景块替换用户场景块、空块关掉场景模式、场景块写错。
- `--scene`：必须写、名字未定义、没拆分的一级可以写、run 写了被拒绝。
- 顺序检查：期望的席位、按基础模型去重、visual 只算能看图的、用 `--count-why` 放行。
- 项目配置：覆盖格子、`seats`、`gap`、时长；不允许的字段忽略并提示；校验错误指出字段；`levels` 旧写法。
- `projects`：提醒、忽略。
- 迁移：补写 gap、备份、写不进去时只在内存里补。
