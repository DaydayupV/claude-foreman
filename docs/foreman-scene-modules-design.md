# 场景模块设计：modules 按场景整套配置

`docs/foreman-seat-scenes-design.md` 里，按场景只能写 `seats` 和 `gap`，用谁靠候选顺序间接决定。这一版改成在 `modules` 下按场景整套配置：`default` 是默认的那套，其余场景只写要改的部分。原来"seats、gap 每级写成按场景的对象"和"按候选顺序挑"两套机制都去掉（那一版还没发布）。

用户在 2026-10-29 确认了结构和下面第 3 节的约定。

## 1. 目标与范围

**要做到**
- 讨论、执行、审查、图像四个模块都能按场景配：每个场景可以有不同的候选、推理强度、必选、席位数和补漏开关。
- 不用场景的用户，配置里只有 `modules.default`，行为和现在一样。
- 场景名在偏好文件的场景块里定义，`default` 是保留名。

**不做**
- `dispatch` 里的设置（超时、轮数、实时查看等）不按场景分。
- 不要求各场景的必选一致：用户可以给不同场景配不同的必选方。代价是场景由 Claude 按偏好文件判断，选错场景就会换成另一套必选，只能靠留痕和提示（第 6 节）发现。

## 2. 配置写法

```json
"modules": {
  "default": {
    "discuss": { "simple": […], "normal": […], "complex": […], "seats": { … } },
    "run":     { "simple": "claude code", "normal": […], "complex": […] },
    "review":  { "simple": […], "normal": […], "complex": […], "seats": { … }, "gap": { … } },
    "image":   { "generate": […], "draw": […] }
  },
  "code": {
    "review": { "complex": [{ "agent": "sol", "effort": "max", "required": true }, { "agent": "astra", "effort": "max" }],
                "seats": { "complex": 2 }, "gap": { "complex": false } }
  },
  "research": {
    "review": { "complex": […], "seats": { "complex": 5 }, "gap": { "complex": true } }
  }
}
```

- `modules` 的键是场景名；`default` 必须有。每个场景下面的写法，就是原来平铺的 `modules`：`discuss`、`run`、`review`、`image` 四块，每块按格子写候选，`seats`、`gap` 按等级写数字和 bool。
- `seats`、`gap` 不再接受按场景写的对象（上一版的写法）。
- 场景块只写要改的部分。某个场景的生效配置（下面叫"场景视图"）= default 合并这个场景块：写了的格子整格替换，`seats`、`gap` 按等级覆盖，没写的沿用 default。
- 每个场景视图都按原来的规则整体校验：能力、必选数不超过席位数、执行和图像一格最多一个必选，等等。报错时写明是哪个场景，比如 `modules.code.review.complex`。

## 3. 选场景

- **哪些地方要写 `--scene`**：要用的这一格（模块加格子），只要在任何一个场景里和 default 不同（格子本身，或者这一级的 `seats`、`gap`），就叫"按场景配了"。按场景配了的格子，建计划（`plan`）和直接派执行（`run --level`）时必须写 `--scene <名字>` 和 `--scene-why "<依据偏好里的哪一条>"`，`<名字>` 可以是 `default`。没按场景配的格子可以不写；写了也照样记下来。
- **default 是兜底**：偏好文件的路由没写到的情况用 `default`。去掉"拿不准选席位多的场景"这条。
- **续接沿用原场景**：`resume` 沿用第一轮的场景（记在任务的 meta 和计划里），不能改。计划里的席位启动时，用计划的场景。
- **记录**：计划记下 `scene`、`scene_why`；直接派出的执行任务在 meta 里记下 `scene`、`scene_why`。没写场景的为 `null`。

## 4. 场景定义和一致性

偏好文件里的场景块，格式和解析规则和上一版相同：标记之间的 `- **<名字>**：` 行；项目偏好有场景块就只用项目的；读不了文件时提醒，按没有场景块处理。另外：

- `default` 是保留名，写进场景块算作场景名不合格式。
- `modules` 里 default 以外的场景名，都必须在场景块里定义过，否则算"对不上"。
- 偏好里定义了、`modules` 里没写的场景，等于 default，只提醒一句。
- 场景块写错时：`modules` 里只有 default，就只提醒；还有别的场景块，就算对不上。

**对不上时**：`config` 的 `scenes.problems` 列出问题，`check` 显示 ❌；建计划、直接派执行、续接都拒绝；status、看板、watch、stats 照常可用。

## 5. 配置分层

- 用户配置和项目配置 `.claude/foreman.json` 都用同样的形状（`modules.<场景>`）。
- 先按层算场景视图，再叠层：先算出用户配置里这个场景的视图（用户的 default 加用户的场景块），再用项目配置里这个场景的视图覆盖（项目的 default 加项目的场景块）。所以项目配置的 default 会覆盖用户配置的场景块，和"项目配置覆盖用户配置"一致。
- 项目配置能写的范围不变：`modules`（任意场景），以及 `dispatch` 的四个时长。

## 6. 计划、派活和显示

- **plan**：
  - 解析 `--scene`，用场景视图建计划。必选、席位数、补漏开关和补漏席的检查，全部按这个场景视图算。
  - 选的场景视图里，这一格少了 default 里同一格的某个必选时，计划输出里加一行提示 `sceneDropsRequired`，不拦。
  - 计划输出、`status --plan` 和看板显示这个场景的必选是谁。
- **去掉"按候选顺序挑"**：删掉顺序检查、`planSeatOrder`、`planGapNotNext` 以及相关的去重代码。补漏席的规则保留：开着、还有补漏候选时必须恰好有一个，任意一个补漏候选都行；基础模型不能和主席位、Claude Code 席相同；带补漏席时 submit 必须写 `--model`。
- **启动和续接**：计划席启动时重新校验，用计划里记的场景的视图；`resume` 用原任务的场景视图，这个场景现在对不上时拒绝。
- **config 输出**：
  - `resolved_modules` 是 default 的视图；
  - 新增 `resolved_scenes`：`{ "<场景>": { "<模块>": { "<格子>": …, "seats": { 只列和 default 不同的等级 }, "gap": { … } } } }`，只列和 default 不同的格子；
  - `scenes` 照旧给出 `names`、`source`、`file`、`problems`。
- **check、config 的 Markdown 和 setup 的总表**：先列 default 的表；每个场景再列一张小表，只列和 default 不同的格子（候选、推理强度、必选、席位数、补漏）。
- **stats**：`--by scene` 先取任务 meta 里的 `scene`，没有再取所属计划的 `scene`。
- **看板**：组标题显示场景：先看计划的 `scene`，没有计划时看任务 meta 里的 `scene`。

## 7. 迁移与兼容

- **用户配置**：
  - 读到平铺写法（`modules` 下直接是 `discuss`、`run`、`review`、`image`）时，先做原有的迁移（levels、seats、gap），再整体改写成 `modules.default`。照旧先备份、保留文件权限、提示 `configScenesWritten`。
  - 平铺写法和场景写法混在一起（既有 `discuss` 等模块键，又有 `default`），直接报错。
- **项目配置**：平铺写法在内存里按 `default` 读，提示一次改成新写法，不改写文件。
- **初始配置**：第一次运行生成的配置直接写成 `modules.default`。
- **旧版插件**：读到 `modules.default` 时会按"未知模块"报错，不会悄悄忽略。发版说明里写明：每台电脑都要升级。
- **上一版没发布的写法**：`seats`、`gap` 按场景写成对象，现在按格式错误报错。

## 8. setup

修改建议里的"场景模式"一项改成：
- 推荐开启时，给出三样东西：
  - 用户偏好里的场景块（code、research 两个场景）；
  - `modules.code`：审查 complex 只放两家强模型，`seats` 为 2，`gap` 关；
  - `modules.research`：审查 complex 放全部候选，`seats` 取候选数和 6 里较小的，`gap` 开；讨论 complex 不改。
- 同意后，先备份配置和偏好文件，再写入。
- 用户配置里还是平铺写法的，第 1 步跑 `config` 时脚本已经改写好，setup 照常在新写法上改。

## 9. 规则和文档

- **dispatch SKILL.md**：R5 的场景一句改成"按偏好里的场景路由选场景，没写到的用 default，`--scene-why` 写依据"。R1 补一句"选的场景决定了必选是谁"。
- **references 和 skill 文档**：
  - `config.md`：示例、`modules` 一节、"场景"一节、项目配置一节、迁移一节；
  - `seats.md`：删掉"场景模式下按候选顺序挑"，改成"先选场景，再在这个场景的格子里按原规则挑"；
  - `review.md`、`discuss.md`、`run.md`、`image.md`：写明什么时候要 `--scene`；
  - `cli.md`：`plan`、`run`、`image`、`resume` 的 `--scene`，`resolved_scenes`，`stats`；
  - setup、config 两个 skill；
  - 中英两份 README。
- 英文插件同步。上一版的设计文档在开头加一句"第 4、5 节已被本文取代"。

## 10. 测试要点

- 迁移：平铺写法改写成 default（含备份）；混写报错；项目配置的平铺写法按 default 读。
- 场景视图：只写部分格子时其余沿用 default；`seats`、`gap` 按等级覆盖；每个场景视图都整体校验，报错带上场景名。
- 分层：项目的 default 覆盖用户的场景块；项目的场景块覆盖项目的 default。
- `--scene`：
  - 按场景配了的格子必须写；`default` 可以写；名字没定义时拒绝；只写 `--scene-why` 时拒绝；
  - `run --level` 直派和图像计划同样适用；
  - `resume` 沿用原来的场景。
- 必选：不同场景可以有不同的必选；选的场景少了 default 的必选时有提示。
- 补漏：规则和上一版相同，只是不再按候选顺序检查。
- 一致性：未定义的场景块、偏好定义了但配置没用到、保留名 `default`。
- 显示：`resolved_scenes`、Markdown 的场景小表、`stats --by scene` 先取 meta、看板显示直派任务的场景。
