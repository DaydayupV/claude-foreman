# foreman 模块统一升级设计

把讨论、执行、审查、图像四类任务统一成同一套"模块 → 格子 → 候选"的结构：每一格可以配多个协作方，可以标必选；由 Claude 定等级、挑模型，脚本用派发计划检查必选和席位。同时把审查升级成能审已有材料、输出结构化、真正只读，新增独立的图像模块，并先修几个现有的绕过漏洞。

本文依据 2026-10-19 的一场 3 级角色模式讨论（任务组 `module-unify-1019`，见附录），用户当天确认了第 13 节的取舍。按第 11 节分期实现：代码按配置交给 Codex，Claude 写任务说明、验收和文档。

## 1. 目标与范围

**要做到**
- 四个模块按交付物划界，"该用哪个模块"没有歧义；多模型审查只走 review。
- 配置里四个模块并列：`modules.discuss / run / review / image`。每一格是候选列表，条目可以标 `required`。
- 一格有多个候选时，由 Claude 按第 4.6 节的规则挑；脚本只检查能机械判断的硬约束。
- review 能审 git 改动、已有文件、结论和证据、截图和播放文件；输出结构化；api 协作方也能参加；只读按实际保障分级，违规算失败。
- 图像模块不定级，分出图（generate）和手画（draw）两格；每个新的图形交付物开工前由用户选路线。
- 角色模式能用于任何多席位的任务。
- 每个协作方的并发上限（`max_parallel`）和同组写入范围不重叠的规则不变。
- 先修讨论中实测出的绕过漏洞（第 8 节）。

**这次不做**
- 自动还原讨论、审查期间被改的文件。
- 同一任务派给多个执行方，再自动择优。
- 自动轮换模型、自动给模型排名。
- 通用工作流引擎、按美元计的硬预算、按厂商账号的共享限流。
- 其他工具的出图对接（只留入口）。

**不变的原则**
- 决策、设计、给人读的文字只由 Claude 做。
- 出图只交给能出图的协作方（目前只有 Codex CLI）。
- 所有外部调用只经过 `cli.mjs`，钩子照旧拦下直接调用。
- 项目配置只能收紧。

## 2. 模块边界

### 2.1 定义

| 模块 | 交付物 | 写权限 | 例子 |
|---|---|---|---|
| discuss | 对还没定的事给方案和取舍 | 只读 | 架构选型、研究方向、根因不明时会诊 |
| review | 对已经存在的东西给问题清单（可以为空） | 只读 | 代码改动、已有文件、研究结论和证据、截图和播放文件 |
| run | 改动 | 可写 | 写代码、跑实验、生成截图和数据 |
| image | 位图和矢量部件 | 可写 | 出定稿图、改图、照定稿图手画会弯的部件、纯矢量绘制 |

判断顺序：要改东西 → run 或 image；评判已经存在的东西 → review；决定接下来做什么 → discuss。模型数量、带不带角色、要不要读代码，都不决定模块。一个请求可以拆成几段，例如"跑实验（run）→ 审结论（review）→ 讨论下一步（discuss）"。

### 2.2 由此改变的归属
- 研究结论落地前的证据审查、方案的设计评议、动画的视觉检查，从 discuss 改到 review。SKILL.md 里写着"证据审查用 3 级讨论来做"的几处（讨论的定级表和选模式、研究与分析类任务、审查一节）一起改。
- 审查里需要跑实验、渲染截图、生成数据的部分，另开 run，review 只读结果。
- 根据审查结果比较修改方案时，回到 discuss。

### 2.3 现状：为什么会混用
- review 只能审 git 改动：仓库里没有改动就直接报错（`cmdReview`），不能审没改过的已有文件。
- review 每一级只能配一个审查方，`pickProfile` 拒绝别的协作方。
- `review --file` 在三个适配器里都被忽略：Codex 只给 discuss 和 resume 读附件，opencode 和 pi 写的是 `review ? [] : …`。
- api 只能参加 discuss：适配器固定用讨论的 schema，并把任务记成 discuss。
- 实际记录（2026-10-19 统计）：共 461 次任务，discuss 288 次、review 37 次。10 月 10 日以来约 60 次 discuss 的标题实际是审查（证据审查、设计评议、visual check），37 次 review 没有一次用过任务组。

## 3. 配置结构

### 3.1 示例

```json
{
  "dispatch": { "auto": true, "watch": "auto", "max_seats": 6, "discuss_max_rounds": 2, "timeout_min": 240, "stall_min": 20, "busy_ask_min": 2 },
  "agents": {
    "gpt-6-astra-codex-cli": { "type": "codex cli", "model": "gpt-6-astra", "sandbox": { "review": "read-only", "discuss": "read-only" } },
    "gpt-6.1-sol-codex-cli": { "type": "codex cli", "model": "gpt-6.1-sol", "sandbox": { "review": "read-only", "discuss": "read-only" } },
    "deepseek-v4.1-flash":   { "type": "opencode cli", "model": "opencode-go/deepseek-v4.1-flash" },
    "kimi-k2.6-api":         { "type": "api", "base_url": "https://api.moonshot.cn/v1", "api_key_env": "KIMI_API_KEY", "model": "kimi-k2.6" }
  },
  "modules": {
    "discuss": {
      "simple":  [{ "agent": "gpt-6-astra-codex-cli", "effort": "medium" }, { "agent": "deepseek-v4.1-flash", "effort": "high" }],
      "normal":  [{ "agent": "gpt-6-astra-codex-cli", "effort": "high" }, { "agent": "deepseek-v4.1-flash", "effort": "high" }],
      "complex": [{ "agent": "gpt-6-astra-codex-cli", "effort": "max", "required": true }, { "agent": "deepseek-v4.1-flash", "effort": "max" }, { "agent": "kimi-k2.6-api" }]
    },
    "run": { "simple": "claude code", "normal": "claude code", "complex": [{ "agent": "gpt-6.1-sol-codex-cli", "effort": "max" }] },
    "review": {
      "simple":  [{ "agent": "gpt-6-astra-codex-cli", "effort": "medium" }],
      "normal":  [{ "agent": "gpt-6-astra-codex-cli", "effort": "high" }, { "agent": "deepseek-v4.1-flash", "effort": "high" }],
      "complex": [{ "agent": "gpt-6-astra-codex-cli", "effort": "max", "required": true }, { "agent": "deepseek-v4.1-flash", "effort": "max" }, { "agent": "kimi-k2.6-api" }]
    },
    "image": {
      "generate": [{ "agent": "gpt-6.1-sol-codex-cli", "effort": "medium" }],
      "draw":     [{ "agent": "gpt-6-astra-codex-cli", "effort": "max" }]
    }
  }
}
```

### 3.2 模块、格子和条目
- 三层：模块 → 格子 → 条目。discuss、run、review 各有 simple、normal、complex 三格；image 有 generate、draw 两格，没有等级。
- 格子的写法：
  - 分级模块：写 `"claude code"`（这一格不找外部协作方，执行由 Claude 自己做），或者写候选列表。单个对象当作只有一项的列表，旧写法照常能用。
  - image：写候选列表，或者 `null`（关掉）。不接受 `"claude code"`，因为 Claude 不能出位图。draw 关掉时，会弯的部件和纯矢量绘制由 Claude 自己画。
- 条目：`{ "agent": "<代号>", "effort": "<推理强度>", "required": true }`。`effort` 不写就用工具的默认值；`required` 不写就是 false。条目里的 `model` 覆盖照旧能读，但不再推荐。
- 校验：
  - 列表不能为空；同一格里，规范化（解析旧代号）之后的协作方不能重复。
  - 能力：discuss 的候选要能 discuss；review 的候选要能 review（api 在第 5.4 节之后可以）；run 的候选要能 run，opencode 和 pi 还要写了 `run_access`；generate 的候选要能出图（`capabilities.images`）；draw 的要求和 run 相同。
  - run、generate、draw 这三类格子一次只派一个执行方，最多只能有一个必选条目：两个必选的执行方没法同时做同一个工作包。
- 实现上，所有遍历改成同一套"模块 → 格子 → 条目"的函数。合并配置、校验、项目配置收紧、改名迁移、汇总、check、首次生成都用它，不为 image 另写分支。现在这些地方都只遍历 `levels`，如果在旁边另挂一个 `image` 块，每一处都要写两套。

### 3.3 必选（required）
- 放在格子的条目上，不放在协作方定义上。同一个协作方可能在审查里必选、在讨论里只是候选；协作方定义只回答"怎么连接"，格子回答"派给谁"。
- 含义：这一格被用到时（Claude 定了这一级、决定外派），必选的协作方必须在场；其余候选由 Claude 决定加不加。
- 只在实际用到的格子生效：选了纯矢量路线（第 7.3 节）就用不到 generate，那里的必选不会触发。
- 必选方达到并发上限时，等它空闲再补发，不跳过。必选方失败、额度用完或被取消时，整件事标为不完整，Claude 按第 4.3 节处理，不拿可选方顶替。

### 3.4 dispatch 的新字段

| 字段 | 作用 | 默认 |
|---|---|---|
| `max_seats` | 一个派发计划最多几个席位；同一个协作方开两个会话算两席 | `6` |

### 3.5 项目配置：只能收紧
项目配置 `<项目>/.claude/foreman.json` 仍然只认 `dispatch` 里的几个时长和席位字段，以及 `modules`（旧写法 `levels` 在内存里转换）。每一格只能：
- 去掉可选条目；
- 把分级模块的整格改成 `"claude code"`，或者把 image 的整格改成 `null`；
- 调低推理强度。只限有明确高低顺序的工具：Codex 是 low < medium < high < xhigh < max < ultra，pi 是 off < minimal < low < medium < high < xhigh < max。opencode 的 variant 和 api 的推理强度没有统一的顺序，项目配置不能改。

不能加条目、换协作方或模型、把可选改成必选，也不能只去掉必选、留下其他人继续外派。整格关掉时，这一格的必选那一步算"没做"，Claude 要如实报告，不能改成自己审一遍就说已经满足。

时长和次数取更严的值：
- `timeout_min`、`max_seats`：取较小值。
- `stall_min`、`busy_ask_min`：0 表示不检测，是最宽松的。用户写了正数时，项目写 0 不生效；两边都是正数时取较小值。

### 3.6 迁移
- 用户配置第一次被读到 `levels` 时，自动改写成 `modules`，原文件备份为 `config.json.bak`（已经有了就加时间戳），并打印对照。改写只换结构，每一格的协作方、推理强度和顺序都不变。
- run 和 review 的单个对象改成只有一项的列表。不自动给任何条目标 `required`。
- **行为变化**：旧的讨论名单原来是"全员参加"，改写后变成"候选池，由 Claude 挑"。迁移提示里要写明这一点，并说明想保留全员参加就全部标上 `required`，`/foreman:setup` 可以帮着标。
- 旧配置没有图像块时不自动添加，不擅自开启新的外派路径，只提示运行 `/foreman:setup`。首次生成的配置在检测到可用的 Codex 时，写入图像两格的默认值（第 7.1 节）。
- `agent-aliases.json` 照旧使用。改名、去重时也要遍历图像块：现在的 `renameAgentsByModel`、旧格式判定和"删除旧的 codex 代号"都只看 `levels`，图像块里引用的旧代号会漏改或被误删。
- 续接旧任务：旧记录没有模块和格子信息，按旧规则推断（`kind` 和 `mode` 对应模块，`level` 对应格子）。图像任务沿用 `mode: run`、`kind: exec`，记录里另加 `module: image` 和 `step`，不新增 kind 的取值：watch、status、会话提醒和准入都按现有的取值判断。
- 同一个文件里同时写了 `levels` 和 `modules` 时直接报错，不猜。
- **给旧版留的说明**：每次改写用户配置（包括没写 `levels` 的更老写法），`levels` 都留成一行说明文字（放在 `modules` 前面；文件里原来有非空的说明就沿用），比如"已改为 modules 写法（见下面的 modules）。读到这一行报错，说明 foreman 插件还是旧版，请升级"，中英文各一份，放在 `messages.mjs`。
  - 原因：旧版插件只合并 `dispatch`、`agents`、`levels` 三个键，缺了 `levels` 就用默认值，也不检查未知的顶层键，所以读到只有 `modules` 的配置不会报错，而是悄悄把九格都当成 `"claude code"`，派活全停。2026-10-19 用已安装的旧版读真实配置的副本实测过：只有 `modules` 时九格全是 `"claude code"`、退出码 0；留了说明字符串后报"配置 levels 无效：应为对象"、退出码 2。
  - 新版读到"`levels` 是字符串、同时有 `modules`"时当作正常情况，跳过这一行，不报"同时写了 levels 和 modules"，也不再迁移；`levels` 是对象又有 `modules` 时照旧报错；`levels` 是字符串却没有 `modules` 时报"levels 应为对象"。已经带说明的文件因为别的旧写法再次改写时，保留原来的说明。
  - 项目配置不会被改写，所以不会加这行说明；项目配置里写了说明和 `modules` 时同样照常读取。旧版插件会忽略项目配置里的 `modules`（只提示一句），所以要让旧版也照项目配置收紧，项目配置继续用 `levels` 写法，新版照样认。

### 3.7 能力表的变化

| 能力 | codex cli | opencode cli | pi cli | api |
|---|---|---|---|---|
| `modes` | run、review、discuss | 同左（run 要写 `run_access`） | 同左 | discuss，新增 review（只审文本材料） |
| `images`（能出图） | 能 | 不能 | 不能 | 不能 |
| `reads_images`（能看图，新增） | 能（view_image） | 先记为不能，验证后再开 | 先记为不能，验证后再开 | 不能 |

图像模块不加进 `modes`：generate 看 `images`，draw 看 run 的条件。

## 4. 派发计划和选派

### 4.1 为什么要有计划
`pickProfile` 一次只解析一个协作方，看不到同一件事还会派给谁，所以没法逐次检查"必选是否都在"。讨论前的初稿设想"可选席位要等必选席位先登记"，但同一条消息里并行启动的几个后台命令，登记顺序是不确定的，可选席位可能抢先、反而被误拒。所以改为先登记一份计划，再逐席启动。

### 4.2 plan 命令

```bash
node cli.mjs plan --cwd "<项目>" --module <discuss|run|review|image> --cell <simple|normal|complex|generate|draw> --group <组名> --seat "<代号>[=<角色名>]" [--seat …] [--why "<选择理由>"] [--target <diff|files|claims|visual>] [--file "<路径>"] [--uncommitted | --base <分支> | --commit <sha>] [--route <1|2|3|4>]
```

全部校验在任何外部请求之前完成，都通过才写计划：
- 格子存在，而且不是 `"claude code"` 或 `null`；
- 每个席位的协作方都在这一格的候选里（先解析旧代号）；
- 这一格的必选全部有席位；
- 能力：visual 审查要 `reads_images`，generate 要 `images`，run 和 draw 要能执行；
- 席位数不超过 `max_seats`；
- image 模块必须给 `--route`，而且路线和格子对得上（第 7.3 节）；
- review 记下材料指纹：diff 对象用现有的审查范围指纹，其他对象对 `--file` 列出的文件算内容哈希。

计划写在记录目录下的 `plans/<plan_id>.json`，内容包括：模块、格子、等级、组名、席位（序号、协作方、角色、推理强度）、必选名单、选择理由、路线、材料指纹，以及创建它的 Claude 会话。命令输出 `plan_id`、席位表和每个席位的启动命令。计划本身不占并发名额。

### 4.3 席位的启动和完成
- 每个席位用 `discuss / run / review / image --plan <plan_id> --seat <序号> --brief …` 启动。协作方和推理强度取自计划，不再写 `--agent`；需要换推理强度时，在这一席加 `--effort`，并记进记录。
- 启动时检查：席位必须在计划里，而且还没启动过（返工走 resume）；review 的材料指纹必须和计划一致，不一致就拒绝，提示重建计划。
- 准入照旧：每个席位各自走 `newRunDir → startRun → checkAdmission`，按规范化后的协作方占名额。
- 完成条件：必选席位都正常结束，并交回了有效的结果。`status --plan <plan_id>` 列出每一席的状态和缺了哪个必选。必选失败、额度用完或被取消时，计划标为不完整；Claude 照旧按"返工与失败"处理（比如额度用完就交给用户决定），不拿可选方顶替。
- 续接：resume 沿用父任务的计划和席位，讨论轮数的上限照旧对每个席位各自生效。必选只对一次派发生效，局部返工不要求所有席位重做；审查对象换了版本，就是一份新的计划。

### 4.4 不走计划的派发
- 单席任务可以不建计划，例如 `run --level complex --brief …`。条件是：这一格里除了被选中的这一方，没有别的必选。有一个必选时，默认就选它；有两个以上必选时，必须建计划。图像模块总是要建计划，因为路线记在计划里。
- `--agent` 只能在这一格的候选里选，四个模块统一。这取代了现在 run 和 review"只认配置的那一个"的规则。
- 格子是 `"claude code"` 时，用户点名派出（比如 `/foreman:run`）仍然可以用 `--agent`，但只限用户配置里这一格本来就是 `"claude code"`。如果是项目配置把这一格关掉的，就拒绝。结果里标 `outside_cell: true`。
- 分级模块必须给 `--level`。`--effort` 只覆盖推理强度，不再能脱离格子去选协作方。
- `--model` 只能在同一家里换：codex cli 和 api 的连接本身就固定了厂商，可以换；opencode 和 pi 必须和原模型用同一个 `提供方/` 前缀。结果里标 `model_overridden`。

### 4.5 把 pickProfile 拆成三步
- `resolveCell(cfg, module, cell)`：返回规范化后的候选列表和必选名单。
- `validatePlan(cfg, plan)`：第 4.2 节的校验。
- `resolveProfile(cfg, seat)`：给一个席位解析适配器参数（协作方、模型、推理强度）。

不走计划的单席派发，在内部构造一份单席计划，走同一套校验，不能成为绕过必选的另一条路。

### 4.6 Claude 选模型的规则（写进 skill）
1. 先排除做不了的：能力不够（看图、出图、执行权限）、材料不允许发给这一家（偏好文件或项目的要求）、额度已经用完。
2. 必选全部加入。
3. 判断类任务（discuss、review）按"不同的基础模型"补席位：
   - 默认 1 级 1 席、2 级 2 席、3 级 3 席。
   - 证据审查和 3 级的高风险审查，用这一格里所有不同的基础模型，不超过 `max_seats`。依据是用户在另一个项目里做的多角色审查试点：召回主要取决于有几个不同的模型。
   - 同一个模型经 api、pi、opencode 接入，只算一个基础模型（去掉 `提供方/` 前缀后比较，规则同 model-tiers.md）。
   - 中档、弱档可以作"广度席"，只参加第 1 轮的独立出稿，由 Claude 逐条核实，不参加第 2 轮。
4. 执行类任务（run、draw）每个工作包派一个执行方：复杂任务优先选强档、能跑命令、有沙箱的；机械任务可以用便宜的；拆分时，不同的份可以交给同一格里不同的协作方，各占各的并发名额。
5. 审查方尽量和执行方用不同的模型；只有同一个模型可选时照常审，汇报时注明。
6. 依据：model-tiers.md 作为先验，偏好文件可以覆盖；第 4 期以后再加本地实测（第 6.4 节）。
7. 每次派出时，用一句话告诉用户选了谁、为什么、没选谁；理由写进计划的 `--why`。

## 5. review 升级

### 5.1 审查对象

```bash
node cli.mjs review --cwd "<项目>" --level <级> [--plan <id> --seat <n>] [--target diff|files|claims|visual] [--uncommitted | --base <分支> | --commit <sha>] [--file "<路径>"]… --brief "<审查说明.md>"
```

| `--target` | 审什么 | 材料 |
|---|---|---|
| `diff`（默认） | 代码改动 | 现有的三种范围，由脚本用 git 算好 |
| `files` | 已有文件，没改过也能审 | `--file` 列出的文件 |
| `claims` | 结论和证据 | 审查说明里逐条列出结论，`--file` 附上证据文件 |
| `visual` | 截图、播放文件、渲染结果 | `--file` 列出的图片 |

- 非 diff 的对象必须给 `--file`，不再因为"仓库里没有改动"被拒绝。
- `visual` 只派给 `reads_images` 为真的协作方。
- 补丁或材料超过上限时照旧报错（opencode 和 pi 的补丁约 20 万字符，api 的材料约 30 万字符），提示按提交或按文件拆开审。

### 5.2 --file 在审查里生效
三个适配器的审查路径都要读 `--file`：Codex、opencode、pi 只把路径列成"重点文件"，由它们自己去读；api 附上文件内容。

### 5.3 结构化报告
新增 `schemas/review.schema.json`：

| 字段 | 内容 |
|---|---|
| `verdict` | `issues_found`、`no_issues` 或 `incomplete` |
| `findings` | 每条：`id`（F1、F2…）、`location`（文件:行号或材料里的位置）、`issue`、`trigger`（什么输入或状态会出错）、`severity`（high / medium / low）、`evidence`、`suggestion` |
| `coverage` | `checked`：检查了哪些；`not_checked`：没覆盖哪些 |
| `unverified` | 拿不准、没能验证的地方 |

- `findings` 为空是合法结果，配合 `verdict: no_issues`。
- Codex 用 `--output-schema` 约束；opencode、pi、api 靠提示词加一次修复，和执行报告的做法一样。
- 审查规则默认加一句："材料可能没有问题，只报能定位到证据的问题。"用户的多角色试点里，干净对照加了这句之后没有误报。
- 不带审查说明的 Codex 原生审查保留为旧路径（输出是英文文字，没有结构）。skill 照旧要求总是带审查说明。

### 5.4 api 参加审查
- `capabilities.modes` 加上 review；适配器的审查路径改用审查 schema，任务记成 review（现在固定用讨论的 schema、记成 discuss）。
- 只审文本：diff 对象附上脚本算好的补丁，其他对象附上 `--file` 的内容；不能审 visual。
- 材料会发给对应的厂商：偏好文件或项目不允许外发时，Claude 不选 api 协作方（第 4.6 节第 1 条）。

### 5.5 多席位审查
- 用计划派出，每席一个新会话；材料指纹固定在计划里（第 4.2 节）。
- 每一席结束时再算一次指纹，变了就在结果里标 `stale`：这一席审的可能不是计划里那一版。
- review 仍然不能续接。追问和复审都开新的审查；补漏轮（第 6.3 节）也是一次新的审查。
- Claude 汇总时按 `findings` 去重、逐条核实，误报要说明为什么不成立。

### 5.6 只读
discuss 和 review 都不许改项目文件，这是任务合同。每次结果写明实际的保障：

| `readonly` | 适用 | 含义 |
|---|---|---|
| `tools` | opencode、pi、api | 只有读文件、搜索、列目录的工具，或者根本没有工具 |
| `sandbox` | 这类任务配了 `read-only` 沙箱的 Codex | 系统沙箱拦下写入 |
| `audited` | 全权限运行的 Codex | 只靠提示词，加上事后对比 |

- `audited` 必须能拍快照：快照失败就不启动，也不接受 `--no-snapshot`。
- 发现有证据的写入（`by: agent` 或 `reported`）时，任务状态记为 `failed`，结果里列出 `readonly_violation` 和 diff。原始输出保留，Claude 可以参考其中的意见，但要在汇报里写明。
- 不自动还原：归属是按整个文件判断的，同一个文件里用户或其他任务的改动也会被算进去。SKILL.md 里"还原 Codex 改的部分"改成：只还原能证明是它改的部分，分不清就不动，交给用户。
- 被审材料在审查期间被别人改了（`by: unknown`）：标 `stale`，不算违规。
- 本机的设置（2026-10-19 实测，codex-cli 0.162.1）：elevated 只读沙箱起不来（`helper_unknown_error: setup refresh had errors`）；unelevated 只读沙箱里能读文件、能跑 `git status`，写文件被拒绝。所以在 `~/.codex/config.toml` 的 `[windows]` 里设 `sandbox = "unelevated"`，两个 Codex 协作方的 `sandbox` 设成 `{ "review": "read-only", "discuss": "read-only" }`；run 不受影响，仍然是全权限。`check` 已经能探测沙箱，再加一条：review 或 discuss 是 `audited` 时在提醒里说明。
- opencode 和 pi 的 discuss、review 现在不拍快照（直接走 `startRun` 和 `finishDiscussion`），保障来自工具权限，这一点照旧，结果里写 `readonly: tools`。

## 6. 角色模式和选模型的依据

### 6.1 适用范围
- 机制上，任何多席位的计划都可以给席位带角色（`--seat 代号=角色名`），角色卡写进各自的任务说明。
- discuss 和 review 的 2、3 级：角色是检查视角，启动前照旧必须弹窗让用户确认分配，`dispatch.auto` 开着也一样。
- run 和 draw：角色就是带写入范围的工作包（比如"实现""测试"），按并发拆分的规则派出，说一句即可，不弹窗。
- generate：不分角色，画面要求由 Claude 统一定。
- 图像路线弹窗和角色分配弹窗同时需要时，合并成一次。

### 6.2 roles.md 的改法
- 工具能力仍然是硬门槛；档位只作参考，不再是能不能参加的资格。
- 删去"弱档只给边界清单员，没有合适的就不参加"：中档、弱档可以作广度席，只参加第 1 轮。
- 3 级允许同一个关键角色由两个不同的基础模型各做一遍。
- 核心角色不许并进别的席位。试点里一个角色被合并以后，漏掉的 5 条问题有 4 条属于它。
- 席位上限改为 `max_seats`，不再等于这一格的条目数；必选的协作方一定占一席。
- 同一个模型多开会话时，照旧优先选强档；每个会话各占一个并发名额，不算独立的模型证据。

### 6.3 补漏轮（可选）
各席的结果去重以后，交给这一格里还没参加过的合适模型，新开一次审查，只问"这份清单还漏了什么"。它算原计划的一个席位，占 `max_seats`。没有可用的模型时，在汇报里注明。第 4 期用现有的计划机制表达，没有加代码：建计划时预留一席 `--seat <代号>=补漏`，其余各席结束、去重后再启动它（做法写在 SKILL.md"五、审查"的"补漏轮"）。

### 6.4 本地实测（第 4 期）
- `cli.mjs judge --run <run_id> --accept "F1,F3" --reject "F2"`：Claude 核实之后，记下每条意见的去留，写进记录目录的 `verdict.json`。讨论也可以记，按观点编号。
- `cli.mjs stats [--module review] [--since <天数>]`：按基础模型和模块汇总席位数、核实成立的条数、误报条数、只有它发现的条数、返工率、用时和花费。
- 偏好文件可以引用这份统计，覆盖 model-tiers.md 的档位；不做自动排名。

## 7. 图像模块

### 7.1 两格和默认值

| 格子 | 做什么 | 能力要求 | 默认（首次生成的配置，检测到 Codex 时） |
|---|---|---|---|
| `generate` | 出位图：定稿图、背景板、局部变体、独立素材，以及改图 | `images`（目前只有 codex cli） | gpt-6.1-sol，medium |
| `draw` | 手画矢量：照定稿图描会弯的部件、写好变形；纯矢量路线下直接画 | 和 run 相同 | gpt-6-astra，max |

- gpt-6.1-sol 是驱动出图工具的 Codex 模型。真正出图的是 Codex 内置的 imagegen 工具（用户告知背后是 gpt-image-2），foreman 不控制它。
- 推理强度默认用 medium：现有规则的判断是，出图质量主要取决于图像模型，和推理强度关系不大，xhigh 会多花额度。用户原先要的是 xhigh，可以在配置里改。
- 第二格叫 draw，沿用 skill 里已有的"手画"说法。它既描会弯的部件，也负责纯矢量绘制，所以不用 trace、convert 这种只描述一种用法的名字。

### 7.2 image 子命令

```bash
node cli.mjs image --plan <plan_id> --seat <n> --brief "<任务说明.md>" --title "<短标题>" --scope "<输出目录>" [--track "<路径>"]
```

- 没有 `--level`，格子由计划决定（generate 或 draw）。
- 内部按 run 的流程跑：改动快照、执行报告、`generated_images`、`image_calls`；记录里写 `module: image`、`step` 和 `route`。
- 必须带 `--scope`（输出目录），这样同组其他任务做写入范围检查时能看到它。
- 续接（返工）从图像格子选派，不查 run 的等级。

### 7.3 路线确认
每个新的图形交付物开工前，Claude 用 AskUserQuestion 弹窗让用户选路线，`dispatch.auto` 开着也一样。

| 路线 | 做法 | 用到的格子 |
|---|---|---|
| ① 位图 | 新出图，或者改已有的图，交付位图 | generate |
| ② 位图 + 矢量混合 | 一张定稿图；整块动的部件由 Claude 用 `assets layers` 裁出来；会弯的部件照定稿图手画成 SVG | generate、draw |
| ③ 纯矢量，先出参考图 | 参考图只用来定风格，成品全是路径，不嵌位图 | generate（只出参考图）、draw |
| ④ 纯矢量 / 代码 | 不调用出图工具 | draw |

- 弹窗里同时写明：用哪个模型；参考图会不会上传给模型服务；返工规则（不设出图次数上限，同一个问题连续三次重出都没有改善就停下来问用户，用户给了上限就按用户的）；要不要出几张候选图。
- 不再问的情况：同一个交付物的返工、局部重出、补丁、技术性重试。要重新问的情况：换路线、加新的交付物、扩大范围、换协作方或厂商。
- 用户的原话已经定了路线时，照样弹窗，把那一项预选好。
- 纯矢量不能拿嵌进 SVG 的 PNG 冒充；路线 ④ 不出位图。
- 只读取截图做视觉检查属于 review，不需要这个弹窗。

### 7.4 确认凭据（第 3 期，先验证）
脚本只能保证"走 image 入口的任务一定带着路线"，证明不了真的弹过窗，因为 `--route` 是 Claude 自己填的。加强的办法：
- 新增钩子 `hooks/record-answers.mjs`（PostToolUse，匹配 AskUserQuestion），把问题和回答按 Claude 会话写进 `~/.claude/foreman/answers/<会话>.jsonl`。钩子由宿主运行，模型改不了它收到的内容。
- 路线弹窗的问题里带一个固定标记（比如"图像路线"）。`plan --module image` 要求同一个会话里有对应的回答，而且选项和 `--route` 一致；用户取消或没有回答，就不建计划。
- 先验证两件事：桌面版和命令行版会不会对 AskUserQuestion 触发 PostToolUse；钩子的输入里有没有用户选中的选项。验证不通过，就退回"`--route` 记录 + skill 规则"，并在文档里如实写明这不是强制。
- 验证结果（2026-10-19，桌面版，Claude Code 2.1.299）：PreToolUse 和 PostToolUse 都会触发，带同一个 `tool_use_id`；PostToolUse 的 `tool_input.answers` 和 `tool_response.answers` 都是"问题原文 → 选中的 label"，选 Other 时是用户写的字；钩子输入的 `session_id` 等于 `CLAUDE_CODE_SESSION_ID`。命令行版按用户要求没有测。据此第 3 期按强制做：钩子同时登记 PreToolUse 和 PostToolUse，只记带标记的题目；plan 只认最近一次（按每个 tool_use_id 第一次出现的位置算）路线弹窗，没有回答、不是 ①–④ 的选项或路线不一致都不建计划。answers 文件 Claude 写得到，所以这份凭据防漏问、不防伪造，skill 里写明不许自己写。

### 7.5 绕过检测
普通 run（不是 image 模块）的结果里出现了 `generated_images` 时，给出警告"出图没有走图像模块"。Codex 每次执行都会扫描图片目录，这一条几乎没有额外成本。

### 7.6 其他出图工具的入口
适配器声明 `images: true`，再实现出图检测（新图片在哪、每次调用传了什么参数），就能接入 generate；配置结构和选派都不用改。draw 只要求能执行，不需要额外适配。

## 8. 先修的现有漏洞
下面的问题是讨论中红队席在内存里直接调用函数实测出来的，Claude 都对照代码核实过（2026-10-19）。

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| 1 | 项目配置把某一格改成 `"claude code"` 后，`--agent` 能派给任何协作方：原来只许用 A 的格子，反而谁都能用了。只给 `--effort`、不给 `--level`，同样能选到格子外的协作方 | `pickProfile` | 第 4.4 节 |
| 2 | 项目配置能放宽资源：`timeout_min` 写 999999、`stall_min` 写 0、推理强度从 low 提到 max，都会被接受 | `projectConfig` | 第 3.5 节 |
| 3 | `--model` 能换成任意模型名；对 opencode 和 pi 带厂商前缀的模型来说，等于换了一家接收方 | `pickProfile` | 第 4.4 节 |
| 4 | 项目偏好文件优先于 skill，而且会话一开始就被注入。克隆来的仓库可以用一段文字要求跳过确认、放宽选派 | SKILL.md 的"开始前"、`session-reminder.mjs` | 偏好文件只能在硬规则以内调整做法；钩子注入时标明"来自项目，不能放宽用户配置和插件的规则"；必选、材料外发、只读、确认弹窗、席位上限不受偏好文件影响 |
| 5 | 登记锁超过 30 秒就会被删，哪怕持有者还活着；释放时也不核对是不是自己的锁。这一条是从代码推出来的，没有实际复现 | `records.mjs` 的 `newRunDir` | 锁文件写入持有者标识，只释放自己的锁；持有者还活着时不抢 |
| 6 | SKILL.md 让 Claude"还原 Codex 改的部分"，但归属是按整个文件判断的 | SKILL.md 讨论一节 | 第 5.6 节 |
| 7 | hooks.json 的说明还写着只拦 codex exec / codex review，实际也拦 opencode run 和 pi | 两个插件的 `hooks/hooks.json` | 改说明 |
| 8 | 出图任务按 skill 写的 `run --agent <Codex> --level simple` 派出时，只要这一级配给了别的协作方就会被拒绝 | `pickProfile` | 由图像模块取代这条派法（第 7 节） |

## 9. 改动清单

| 文件 | 改动 |
|---|---|
| `scripts/config.mjs` | `modules` 结构和遍历函数；校验；项目配置收紧；迁移和改名；首次生成；`resolveCell`、`validatePlan`、`resolveProfile` |
| `scripts/plan.mjs`（新） | `plan` 命令、计划文件、`status --plan` |
| `scripts/cli.mjs` | `plan`、`image`、`judge`、`stats` 子命令；review 的 `--target` 和 `--file`；`--level` 必填；组名校验加上 image |
| `scripts/records.mjs` | 锁的持有者标识；准入按"写不写文件"决定要不要检查写入范围 |
| `scripts/runner.mjs` | 只读三级、违规算失败、材料指纹和过期标记、普通 run 出图告警 |
| `scripts/review-scope.mjs` | 非 diff 对象的材料清单和指纹 |
| `scripts/adapters/*.mjs` | 审查读 `--file`；review schema；api 的审查模式；`reads_images` 能力 |
| `schemas/review.schema.json`（新） | 第 5.3 节 |
| `scripts/summary.mjs` | 按模块遍历；图像块计入 `used_at`；draw 用 shell 权限时给出提醒 |
| `scripts/status.mjs`、`scripts/watch.mjs` | 计划状态；图像任务的显示 |
| `scripts/messages.mjs` | 所有新增的提示文字，中英文都要 |
| `hooks/session-reminder.mjs` | 图像规则的文字；项目偏好的来源标注 |
| `hooks/record-answers.mjs`（新，第 3 期） | 第 7.4 节 |
| `hooks/hooks.json` | 说明文字；新钩子 |
| `SKILL.md`、`references/`（config、roles、image-assets、cli、model-tiers） | 中英文都改 |
| `skills/run`、`review`、`discuss`、`setup`、`config` | 命令说明；setup 的推荐规则加上候选、必选和图像两格 |
| `README.md`、`README.en.md` | 配置写法和新命令 |
| `tools/sync-shared.mjs` | 共用清单加入新文件；review schema 加进结构检查 |
| `tests/` | 第 10 节 |

## 10. 测试方案

### 10.1 自动化（node:test、假 CLI、临时 Git 仓库）
- **配置和迁移**：`levels` 改写成 `modules`（有备份，协作方顺序和推理强度不变）；单个对象等于一项的列表；空列表、重复、能力不符、run / generate / draw 有两个必选时报错；图像块里的旧代号会被改名、不会被误删；同时写了 `levels` 和 `modules` 时报错；首次生成的图像默认值只在有 Codex 时写入。
- **项目配置**：不能加条目、换模型、打开必选，也不能单独去掉必选；可以去掉可选条目、整格关掉；时长和席位取更严的值（包括 `stall_min`、`busy_ask_min` 为 0 的情况）；推理强度只能调低，而且只限有顺序的档位；项目把格子改成 `"claude code"` 后，点名外派被拒。
- **选派**：`--agent` 不在格子里时被拒；缺 `--level` 被拒；`--model` 换厂商被拒；有其他必选时单席派发被拒；计划校验（必选、能力、看图、出图、`max_seats`、路线和格子）；同一席位重复启动被拒；续接沿用计划。
- **并发**：每个协作方跨组、跨会话计数不变；计划不占名额；同组写入范围按"写不写文件"判断（review 不查，图像要查）；锁的持有者标识（持有者暂停时不会被抢，释放时不会删掉别人的锁）。
- **review**：四类对象；`--file` 在三个适配器里都生效；schema 校验和一次修复；api 审查；visual 拒绝不能看图的协作方；指纹不一致时拒绝启动；结束时指纹变了标 `stale`；只读违规记为 failed；`audited` 快照失败时不启动。
- **图像**：image 子命令不需要 `--level`；路线 ④ 不能派 generate；续接从图像格子选派；普通 run 出图时告警；第 3 期加上：没有确认记录时拒绝建计划。
- **钩子和同步**：项目偏好注入时带来源标注；`node tools/sync-shared.mjs --check` 通过；中英文 schema 结构一致。

### 10.2 真机冒烟（Windows，每期发布前）
- Codex 在 unelevated 只读沙箱里做一次真实的审查和讨论：能读代码、能跑 git，写入被拒，结果写 `readonly: sandbox`。
- 多席位审查：Codex、opencode 和 api 各一席，一份计划，其中一个必选；故意取消必选席位，计划要标为不完整。
- 图像：路线弹窗 → 计划 → generate → draw，中间做一次局部重出，这时不应再弹窗。
- PostToolUse 钩子的实验（第 7.4 节）。
- 拿用户真实配置的副本，自动迁移一次。

## 11. 分期

| 期 | 内容 | 等级 | 主要验收 |
|---|---|---|---|
| 1 | 收紧和骨架：第 8 节的漏洞 1–7；`modules` 结构、遍历函数、校验、迁移、项目配置规则；`plan`、必选、`max_seats`；summary、check、setup、首次生成 | complex | 10.1 的配置、项目配置、选派、并发四组测试；迁移冒烟 |
| 2 | review：四类对象、`--file`、review schema、api 审查、`reads_images`、只读三级、违规算失败、材料指纹；证据审查迁到 review；skill 改写模块边界 | complex | 10.1 的 review 测试；Codex 只读沙箱冒烟；多席位审查冒烟 |
| 3 | 图像：两格配置、`image` 子命令、路线弹窗、确认凭据（先验证）、普通 run 出图告警；改写 image-assets.md 和会话钩子的文字 | complex | 10.1 的图像测试；图像冒烟 |
| 4 | 角色和实测：roles.md 的改法、广度席、冗余、补漏轮、`judge` 和 `stats` | normal | 文档一致；`stats` 能在真实记录上跑 |
| 发布 | 版本号、README、发布说明 | Claude 做 | 按发布流程 |

- 每期单独提交，测试和冒烟都通过才进入下一期。
- 代码按配置交给 Codex（complex 级给 gpt-6.1-sol，max），Claude 写任务说明并验收；文档由 Claude 写，中英文同步。sync-shared 不同步 SKILL.md、references 和 hooks.json，这几处要手工改。
- 第 13 节第 2 条（本机 Codex 改用 unelevated 只读沙箱）只改配置，不依赖新代码，现在就能做。
- 第 1 期上线后，对本机配置做第 13 节确认的其余改动：给 gpt-6-astra 标必选，加上图像两格。本机 review 的三格现在都只有 gpt-6-astra，要做多模型审查，还得先用 `/foreman:setup` 给 review 加候选。

## 12. 待验证的事
1. AskUserQuestion 会不会触发 PostToolUse 钩子，钩子的输入里有没有用户选中的选项（桌面版、命令行版都要试）。这决定第 7.4 节能不能做成强制。桌面版 2026-10-19 验证通过（见 7.4 节），命令行版还没测。
2. opencode、pi 能不能看图（它们的读文件工具怎么处理图片）。能的话再打开 `reads_images`。
3. 在 unelevated 只读沙箱里，Codex 做真实审查时会不会有别的命令起不来。目前只测了 `type`、`git status` 和一次写入。
4. 推理强度对出图质量有没有影响。这决定 generate 的默认值要不要维持 medium。
5. 旧的讨论名单改成候选池以后，Claude 默认 1 / 2 / 3 席会不会让审查覆盖下降。可以用多角色试点的回放（R1、R2）对比一次。第 4 期以后 `stats --module review` 能回答一部分：多席审查都用 `judge` 记了去留、用 `--same` 标了同一个问题时，每个模型的 `unique` 就是少了它会漏掉的成立问题数，某个模型的 `unique` 一直不低，说明默认席位偏少；但它看不到没被派出的模型会发现什么，和试点回放的对比仍要单独做。

## 13. 已确认（2026-10-19）
用户确认按推荐处理：
1. 配置统一成 `modules`，第一次读到旧写法时自动改写并备份。
2. 本机 Codex 改用 unelevated 沙箱，review 和 discuss 设成只读，run 不变。
3. 旧的讨论名单变成候选池；review.complex 和 discuss.complex 里的 gpt-6-astra 标为必选。
4. generate 的默认推理强度用 medium（原先要求的是 xhigh）。
5. `max_seats` 默认 6。

讨论中一并定下的取舍：必选放在格子的条目上；项目配置不能单独去掉必选；不自动还原；不做同一任务多方自动择优；图像按交付物弹窗，返工不再问。

## 附：讨论记录
- 任务组 `module-unify-1019`，3 级，角色模式，1 轮；记录在 `~/.claude/foreman/runs/`。

| 席位 | 模型［角色］ | 接入方式，推理强度 | run_id |
|---|---|---|---|
| ① | gpt-6-astra［架构师］ | Codex，max | 20261019-151342-zg29 |
| ② | gpt-6-astra［安全与可靠性红队］ | Codex，max | 20261019-151347-pdc7 |
| ③ | gemini-4-argon［综合对照位］ | opencode，high | 20261019-151350-yl5p |
| ④ | deepseek-v4.1-flash［维护与兼容］ | opencode，max | 20261019-151355-vb7c |
| ⑤ | mimo-v2.6-pro［边界清单员］ | pi，high | 20261019-151359-fsvi |

- 主要贡献：
  - 架构师：`modules` 统一结构和派发计划；指出 api 要改适配器才能审查，看图和出图要分开。
  - 红队：第 8 节的漏洞 1–6；不能按文件归属自动还原；项目偏好不能盖过硬规则。
  - 综合对照位：弹窗按交付物算，不按每一步算；角色模式的重点放在 review。
  - 维护与兼容：列出只遍历 `levels` 的那批位置；发现 `review --file` 被忽略；图像任务要带 `--scope`。
  - 边界清单员：api 必须能参加审查，否则证据审查迁过去会少掉几个模型；看图能力要单独过滤。
- 不采纳的观点：
  - 用 `levels.image`：现有校验要求 `levels` 下每块都有三级。
  - 自动还原。
  - 项目配置可以单独关掉必选。
  - 讨论不强制只读。
  - 取消出图不限次数：这是用户 10 月 19 日定的规则。
- 没做第 2 轮：剩下的分歧要么已经对照代码查清，要么是需要用户拍板的取舍（第 13 节）。
- "极简派"和"用户体验"两个视角没有单独开席位，由 Claude 补查。①②出自同一个模型，两者一致的结论不算两份独立的证据。
- 选模型规则的主要依据，是用户 2026-10-18 在 select-stock-pro 项目里做的多角色审查试点：召回主要取决于有几个不同的模型；弱档模型在独立出稿、由主持方核实时也能贡献独有的发现；角色被合并后容易漏查。
