# 配置字段说明

配置文件是 JSON，按下面的顺序叠加，后面的覆盖前面的：
1. 脚本内置默认值；
2. 用户配置 `~/.claude/foreman/config.json`（可以用环境变量 `FOREMAN_CONFIG` 换路径）；
3. 用户配置里 `projects` 按项目目录写的覆盖（可以放宽，见"按项目覆盖"）；
4. 项目配置 `<项目目录>/.claude/foreman.json`（只能收紧，见文末）。

配置分三块，另有一个可选的 `projects`：

| 块 | 回答的问题 |
|---|---|
| `dispatch` | 插件怎么派活：是否主动派、讨论轮数、超时等 |
| `agents` | 有哪些协作方，怎么连接 |
| `modules` | 每类任务的每一格有哪些候选、谁必选、用什么推理强度 |
| `projects`（可选） | 按项目目录覆盖 `modules` 和几个时长，见“按项目覆盖” |

连接方式只写在 `agents`，分派只写在 `modules`。

示例：

```json
{
  "agents": {
    "gpt-6.1-sol": { "type": "codex cli", "model": "gpt-6.1-sol" },
    "gpt-6-astra": { "type": "codex cli", "model": "gpt-6-astra" },
    "glm-5.3":     { "type": "opencode cli", "model": "opencode-go/glm-5.3" },
    "deepseek-v4-pro": { "type": "api", "base_url": "https://api.deepseek.com", "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-v4-pro" }
  },
  "modules": {
    "discuss": {
      "simple":  "claude code",
      "normal":  [{ "agent": "gpt-6.1-sol", "effort": "high" }, { "agent": "glm-5.3" }],
      "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }, { "agent": "glm-5.3" }, { "agent": "deepseek-v4-pro", "effort": "max" }],
      "seats":   { "simple": 2, "normal": 4, "complex": 3 }
    },
    "run":    { "simple": "claude code", "normal": "claude code", "complex": [{ "agent": "gpt-6.1-sol", "effort": "max" }] },
    "review": { "simple": [{ "agent": "gpt-6.1-sol", "effort": "medium" }], "normal": [{ "agent": "gpt-6.1-sol", "effort": "high" }], "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }],
                "seats": { "simple": 1, "normal": 2, "complex": 2 } },
    "image":  { "generate": [{ "agent": "gpt-6.1-sol", "effort": "medium" }], "draw": [{ "agent": "gpt-6-astra", "effort": "max" }] }
  }
}
```

## dispatch

| 字段 | 作用 | 默认 |
|---|---|---|
| `auto` | Claude 主动发起派活、讨论和审查前要不要先问用户：`true` 直接做并说一句，`false` 先问（见 skill 的"授权"） | `true` |
| `watch` | 实时查看的两个开关，写成 `{ "terminal": true, "web": false }`，两项都要写：<br>`terminal`：网页看板关着时的终端实时查看。`web` 为 `false`、`terminal` 为 `true` 时，只要派给了其他模型（执行、续接、讨论、审查），任务启动后就打开一个终端标签页、弹出终端面板；`terminal` 为 `false` 时不主动打开。`web` 为 `true` 时只用网页看板，不主动打开终端实时查看。想在终端里看时，两种情况都可以用 `/foreman:watch`。<br>`web`：网页看板，在浏览器里用星图看本机所有 Claude Code 对话和派发进度。`true` 时每次派出都先在对话里给一个网页链接，再启动任务，由你点开在默认浏览器里看；`/foreman:watch` 也会给。看板服务这台电脑上所有对话共用，第一次用到时在后台启动，30 分钟没人看、也没有任务在跑就自己退出，插件被卸载或更新后也会退出。运行时服务约占 100–130 MB 内存，浏览器标签页约 60–90 MB；`/foreman:setup` 按内存决定开不开（总内存不到 8 GB 或可用不到 2 GB 时关着）。<br>旧版的写法（`watch` 写 `auto` 或 `off`、另有一个 `web`）照样能读，第一次加载时会先备份、再改写成这种写法 | `{ "terminal": true, "web": false }` |
| `intro` | 新派出的对话第一次打开实时查看时，先放一段启动动画：模型的像素头像、"正在启动"和几句玩笑，单个模型 5 秒、讨论 10 秒，按任意键跳过，任务提前结束会马上收尾。续接（讨论的下一轮、返工）不放。头像按模型名里的关键字认（gpt、deepseek、glm、kimi、qwen、mimo、minimax、gemini、claude 等），认不出的用 ??? 头像。`false` 关掉 | `true` |
| `discuss_max_rounds` | 一场讨论最多几轮（第 1 轮加上之后的续接），每个参与方各自计数；超出后脚本拒绝续接 | `2` |
| `timeout_min` | 单次任务的总超时（分钟） | `480` |
| `stall_min` | 多久没有动静判定为卡死（分钟，0 为关闭）。Codex：没有任何事件，也没有命令在执行；API：流式输出里没有任何数据；opencode：没有输出任何事件；pi：没有输出任何事件，也没有工具在运行 | `40` |
| `busy_ask_min` | API 协作方因为服务繁忙排队超过多少分钟，就由 Claude 决定要不要终止它（0 为不处理） | `2` |
| `runs_dir` | 运行记录目录（也可用环境变量 `FOREMAN_RUNS_DIR`）。派发计划存在它下面的 `plans/` | `~/.claude/foreman/runs` |

## agents

- 键是协作方的**代号**，`modules` 和 `--agent` 用它引用。建议直接用模型名。
- 代号只能用字母、数字、`.`、`-`、`_`，以字母或数字开头；不能叫 `claude` 或 `claude code`。
- `type` 决定怎么连接、要填哪些字段，只有四种。同一种可以配多个，各用不同的模型。
- Codex 不是必需的，一个协作方都不配也行：那样所有任务都由 Claude 自己做。

**`type: "codex cli"`**（本机的 Codex CLI）

| 字段 | 作用 | 默认 |
|---|---|---|
| `model` | 模型 | 不写就沿用 `~/.codex/config.toml` |
| `bin` | codex 可执行文件或 `codex.js` 路径（也可以用环境变量 `CODEX_BIN`） | 自动查找 |
| `max_parallel` | 这个协作方同时最多运行几个任务，所有任务组和会话加起来算（见 `references/run.md` 的"并发拆分"） | `4` |
| `sandbox` | `run` / `review` / `discuss` 各自的沙箱：`read-only` / `workspace-write` / `danger-full-access`。讨论和审查设成 `read-only` 时由系统沙箱拦下写入（结果的 `readonly` 为 `sandbox`），否则只靠规则约束和事后对比快照（`audited`）。Windows 上默认的 elevated 只读沙箱可能连读文件的命令都启动不了，见下文 | 全部 `null`，沿用 Codex 配置 |
| `approval` | 审批策略：`never` 或 `on-request` | 不写时用 `never`：无人值守，没人能审批。命令被沙箱挡住时直接把失败交回给模型；沙箱坏了要修沙箱，见下文"Codex 的沙箱起不来时" |

### Codex 的沙箱起不来时
现象：派给 Codex 的任务里每条命令都失败，报 `windows sandbox failed`、`helper_unknown_error`、`setup refresh had errors` 或 `Failed to create unified exec process`；结果的 `notes` 会提示沙箱坏了。最常见的原因是 Windows 上 Codex 默认的 elevated 沙箱设置坏了（它要以管理员身份完成一次设置）。

运行 `check`：它按各类任务实际用的沙箱模式，用 `codex sandbox` 跑一条 echo，不调模型、不花钱，坏了就判不通过并列出修法。选一种：
1. Windows 上在 `~/.codex/config.toml` 的 `[windows]` 里写 `sandbox = "unelevated"`。`check` 会顺带试一下，能用时会写明。
2. 按 Codex 的 Windows 沙箱说明重新完成设置（通常要管理员权限）。
3. 在 foreman 配置里把 `agents.<代号>.sandbox` 对应的任务设成 `"danger-full-access"`：不用沙箱，Codex 能读写整台电脑，靠任务说明约束、事后看 diff 把关。

不要靠改 `approval` 解决。Codex 0.162 的审批只有两个值：`never`（命令被挡住就直接把失败交回给模型）和 `on-request`（模型决定什么时候申请批准）。派出去的任务没人能批准，所以 foreman 默认用 `never`；沙箱坏了时两个值都一样跑不了命令。另外，`workspace-write` 默认不能联网，任务要装依赖时会失败，需要的话在 Codex 配置的 `[sandbox_workspace_write]` 里开 `network_access = true`。

**`type: "opencode cli"`**（本机的 Opencode CLI）

| 字段 | 作用 |
|---|---|
| `model` | 必填，写成 `提供方/模型`，比如 `opencode-go/glm-5.3`。`opencode models` 列出的都能用 |
| `bin` | 可选，opencode 可执行文件路径。默认自动查找 |
| `max_parallel` | 可选，默认 `4` |
| `run_access` | 可选，允许它做执行任务：`"edit"` 只能读写项目目录里的文件、不能运行命令；`"shell"` 还能运行命令。不写就不能放进 `run` 和 `draw` 格子，也不能被点名派执行 |

登录和 key 都由 opencode 自己管（比如 OpenCode Go 要先在 opencode 里运行 `/connect` 登录），插件不碰。讨论和审查时，脚本给 opencode 注入一个只读代理，只有读文件、搜索和列目录的工具：它能自己翻项目里的代码，但不能运行命令，也不能改文件。审查改动（`diff`）时，要看的改动由脚本用 git 算好附给它；审已有文件时只给路径，由它自己读。

执行时注入的代理按 `run_access` 开放写文件，`shell` 档再开放运行命令。opencode **没有系统沙箱**：
- `edit` 档写不了项目目录以外的文件，也没有运行命令的工具；
- `shell` 档的命令以你的账户权限运行，能访问整台机器。

两档都必须先拍改动快照才开始执行（不能 `--no-snapshot`），改动靠事后审查 diff 把关。

**`type: "pi cli"`**（本机的 Pi CLI，npm 包 `@earendil-works/pi-coding-agent`）

| 字段 | 作用 |
|---|---|
| `model` | 必填，写成 `提供方/模型`，比如 `deepseek/deepseek-flash`。`pi --list-models` 列出的都能用 |
| `bin` | 可选，pi 可执行文件或它的 `cli.js` 的路径。默认自动查找 |
| `max_parallel` | 可选，默认 `4` |
| `run_access` | 可选，和 opencode 一样：`"edit"` 或 `"shell"`，只能写在用户配置里。不写就不能放进 `run` 和 `draw` 格子，也不能被点名派执行 |

登录和 key 由 pi 自己管（在 pi 里用 `/login`，或者设置厂商的 API key 环境变量），插件不碰。pi 本身没有权限系统，脚本每次调用都：
- 只开放这次任务需要的工具：讨论和审查只有读文件、搜索和列目录；执行的 `edit` 档再加编辑和写文件，`shell` 档再加运行命令；
- 注入 foreman 的守卫扩展：文件工具的路径不能出项目目录（`shell` 档运行的命令不受它限制）；
- 不加载你装的扩展、skill、提示模板、MCP 和项目里的 `.pi` 设置；项目的 AGENTS.md / CLAUDE.md 照常读；
- 会话存在 pi 的默认位置，在 pi 里用 `/resume` 也能找到。

和 opencode 一样没有系统沙箱，两档都必须先拍改动快照才开始执行。

**`type: "agy cli"`**（本机的 Agy CLI，即 Google Antigravity CLI，命令 `agy`）

| 字段 | 作用 |
|---|---|
| `model` | 必填，模型族，比如 `gemini-3.8-flash`。agy 把推理强度写在 ID 的后缀里（`gemini-3.8-flash-high`），插件拆开显示、派出时拼回去，档位写在格子的 `effort` 里。也可以照旧写完整 ID、不写 `effort` |
| `bin` | 可选，agy 可执行文件的路径。默认在 PATH 里找，Windows 上再找 `%LOCALAPPDATA%\agy\bin\agy.exe` |
| `max_parallel` | 可选，默认 `2`：订阅额度按 5 小时窗口算，并发高了容易一起撞限额 |

只能参加讨论和审查，不能写 `run_access`，也不能放进 `run`、`draw` 格子。登录由 agy 自己管，插件不碰。agy 不能按次加载扩展，插件靠它的全局钩子管住工具：
- 用之前要装守卫（`agy-guard install`，`/foreman:setup` 会先征求用户同意）：在 `~/.gemini/config/hooks.json` 里加一个 `foreman-guard` 条目，同目录写启动器和守卫脚本。没有 foreman 运行时守卫回答 `ask`，用户平时用 agy 不受影响；
- 每次派出前自检：项目（从工作目录往上到仓库根，加上每个 `--add-dir`）的 `.agents` 等目录里有 agy 的钩子、MCP 或插件配置，或者全局 `hooks.json` 里有 foreman 以外的钩子，就不派，报错写明是哪个文件；守卫文件和插件里的不一致时在锁里重新写入；
- 守卫只放行读文件（路径限定在项目目录和 `--add-dir` 里）和任务清单；本机 agy 的沙箱经探针确认可用时（Windows 11 24H2 及以上），读档再放行沙箱里的命令：沙箱里改不了项目内外的文件、上不了网，但系统临时目录仍然可写。沙箱不可用时没有 shell，讨论材料附上 `git ls-files` 的清单；
- 启动前去掉密钥类环境变量；运行期间在 foreman 状态目录写启动标记，同一目录里没有带策略的 agy 会被守卫拒绝工具调用；守卫的每次决定记在 `run_dir` 的 `agy-guard.jsonl`，用了工具却没有决定记录的一轮判失败；
- 用户自己的 GEMINI.md、skill 照常加载，全局 MCP 服务器会启动但工具被拒绝；会话出现在 agy 的历史里。

**`type: "api"`**（兼容 OpenAI 接口的模型）

| 字段 | 作用 |
|---|---|
| `base_url` | 接口地址，例如 `https://api.deepseek.com`，脚本请求 `<base_url>/chat/completions` |
| `api_key` | API key 本身。明文保存在配置文件里，改完立即生效；只能写在用户配置中。留空 `""` 表示还没填 |
| `api_key_env` | 存放 API key 的环境变量名；设置环境变量后要重启 Claude Code 才能读到。两个都填时用 `api_key`；两个都没有的协作方不能参加讨论和审查，放进这些格子会在运行时报错 |
| `model` | 必填，模型 |
| `max_parallel` | 可选，默认 `4` |
| `extra_body` | 可选，原样并进请求体的参数，比如 `{ "max_tokens": 65536 }` |

### 能做什么（能力表）
`config` 输出的 `agents_status.<代号>.capabilities` 列出每个协作方能做什么。配置校验也按它来：把协作方放进它做不了的格子，会报错。

| | codex cli | opencode cli | pi cli | agy cli | api |
|---|---|---|---|---|---|
| 能做的任务（`modes`） | 执行、审查、讨论 | 执行（要写 `run_access`）、审查、讨论 | 执行（要写 `run_access`）、审查、讨论 | 审查、讨论 | 讨论、审查（只审文本材料） |
| 隔离（`isolation`） | 系统沙箱（`os`），看沙箱配置 | 只有工具权限（`tools`） | 只有工具权限加守卫扩展（`tools`） | 全局钩子里的守卫（`tools`）；只读命令在 agy 沙箱里 | 无（`none`），只收发文字 |
| 自己读代码（`reads_code`） | 能 | 能 | 能 | 能 | 不能，靠附带文件 |
| 原生格式约束（`native_schema`） | 有 | 没有，靠提示词加一次修复 | 没有，同左 | 没有，同左 | 没有，同左 |
| 原生审查（`native_review`） | 有 | 没有 | 没有 | 没有 | 没有 |
| 出图（`images`） | 能 | 不能 | 不能 | 不能 | 不能 |
| 看图（`reads_images`），决定能不能做 `visual` 审查 | 能（view_image） | 先记为不能（还没验证） | 先记为不能（还没验证） | 先记为不能（还没验证） | 不能 |
| 讨论和审查的只读保障（结果的 `readonly`） | `sandbox`（配了 `read-only` 沙箱）或 `audited` | `tools` | `tools` | `tools` | `tools` |

## modules

四个模块，按交付物划分：

| 模块 | 交付物 | 格子 |
|---|---|---|
| `discuss` | 对还没定的事给方案和取舍（只读） | `simple` / `normal` / `complex` |
| `run` | 改动 | `simple` / `normal` / `complex` |
| `review` | 对已经存在的东西给问题清单（只读） | `simple` / `normal` / `complex` |
| `image` | 位图和矢量部件 | `generate`（出图）、`draw`（手画矢量），不分等级 |

另有一个 0 级（未达门槛、不值得找外部模型），固定由 Claude 自己做，不进配置。每一格可以写：
- `"claude code"`（只限 discuss、run、review）：执行由 Claude 自己做；审查和讨论表示这一格不找外部协作方。
- 候选列表：`[{ "agent": "<代号>", "effort": "<推理强度>", "required": true }, …]`。只有一项时也可以写成单个对象，效果一样。同一个协作方在一格里只能出现一次。
- `null`（只限 image）：关掉这一格。generate 关掉就不出图；draw 关掉时，会弯的部件和纯矢量绘制由 Claude 自己画。Claude 不能出位图，所以 image 的格子不能写 `"claude code"`。

`discuss` 和 `review` 另有一项 `seats`，写每一级找几个外部模型，三级都写在配置文件里，改数量直接改它。新建的配置自带这一项；没写全的用户配置，第一次读的时候由脚本按默认值补全写进文件。默认值和规则见下文"候选和必选"。

能放进哪一格，按能力表校验：discuss 的候选要能讨论，review 的要能审查；run 的要能执行，opencode 和 pi 还要写了 `run_access`；generate 的要能出图（适配器声明了 `images`，并且实现了出图检测：这一轮新出了哪些图、每次调用传了什么参数；目前只有 codex cli）；draw 的要求和 run 相同。

图像任务的派法：每个新的图形交付物开工前，Claude 先弹窗让用户选路线（① 位图、② 位图 + 矢量混合、③ 纯矢量先出参考图、④ 纯矢量 / 代码），再用 `plan --module image --cell <generate|draw> --route <路线号>` 建计划、`image --plan … --seat …` 启动；路线决定用到哪几格，只建用到的格子的计划，所以没用到的格子里的必选不会触发（比如选了路线 ④，generate 的必选不用到场）。脚本会核对这个会话里最近一次路线弹窗的回答，见 `references/cli.md` 的"plan、image 和 status --plan"。

### 候选和必选
- 一格有几个候选时，由 Claude 按 `references/seats.md` 的规则挑（排除做不了的、必选全部加入、讨论和审查按不同的基础模型补到配置的席位数、执行每个工作包派一个执行方），每次派出时说一句选了谁、为什么。脚本只检查能机械判断的硬约束。
- `seats`（只限 `discuss` 和 `review`）：每一级的外部席位数，不含 Claude Code 席和 3 级审查的补漏席。默认值如下（插件里写明默认数字的只有这一处，其他文档都引用这里）：

  | | simple | normal | complex |
  |---|---|---|---|
  | `discuss` | 2 | 4 | 8 |
  | `review` | 1 | 2 | 2 |

  必选算在这个数里，所以不能少于这一格的必选数，否则读配置时报错；可以多于候选数，表示候选全上。想让某一级固定用哪几家，就只放这几家、把席位数设成候选数，或者全部标必选。`plan` 建讨论或审查计划时检查外部席位数等于 `min(seats, 能用的候选数)`（`visual` 审查只算能看图的），不一致时要带 `--count-why "<理由>"`。能用的候选数按协作方代号算，同一个模型经两种方式接入算两个。用户配置里没写全时，第一次读配置会把缺的等级按默认值补写进文件（不少于这一格的必选数，照旧配置标了很多必选也能直接用；已经写了的等级不动），原文件备份成 `<文件名>.bak`（已有同名备份时在后面加时间和进程号），改写后的文件保留原来的权限，并提示补写了什么；写不进去时（比如文件只读，或者别的进程占着改写锁超过 10 秒）只在内存里补，同时提示补写失败、文件没改。`seats` 写错（格式不对、少于必选数）时不会自动改，照常报错。项目配置不改写，没写的等级沿用用户配置。不认识 `seats` 的旧版插件读到它会报错，所以每台电脑都要升级。实际用的数看 `config` 输出的 `resolved_modules.<discuss|review>.seats`。
- `required: true` 表示这一格被用到时，这个协作方必须在场；不写就是普通候选，由 Claude 决定加不加。同一个协作方可能在审查里必选、在讨论里只是候选，所以必选写在格子的条目上，不写在协作方定义上。
- 一次派几个席位时，Claude 先建一份派发计划（`plan`），脚本检查必选是否都在、讨论和审查的外部席位数是否和 `seats` 一致，再逐席启动。执行单席派发时，这一格还有别的必选，脚本会拒绝。讨论和审查一律建计划：计划自带 Claude Code 席，它先用 `submit` 提交报告，外部席才能启动。
- 必选方达到并发上限时，派发命令自动排队等名额（见下面"并发上限"）；必选方失败、额度用完或被取消时，这件事算不完整，不拿其他候选顶替。
- `run`、`generate`、`draw` 一次只派一个执行方，所以这三类格子最多只能有一个必选条目。

### 推理强度
`effort` 可以不写，不写就用工具或模型自己的默认值。各类型的写法：
- `codex cli`：`low`、`medium`、`high`、`xhigh`、`max`、`ultra`。每个模型支持哪些以 Codex 自带的模型清单为准（比如 gpt-5.5 最高到 `xhigh`），`check` 会按清单核对。
- `api`：原样作为 `reasoning_effort` 发出（DeepSeek 接受 `low` / `high` / `max`）；写 `null` 表示不发。没有推理强度参数的模型写 `null`，比如小米 MiMo（只有思考开关，默认开启）。
- `opencode cli`：模型的 variant（比如 `high`），拼成 `-m 模型#variant` 传给 opencode；`null` 表示用模型的默认设置。各模型有哪些 variant 不一样（比如免费的 DeepSeek 模型接受 `low`、`high`、`max`，不接受 `medium`），写错了 opencode 会报错。写 `default` 和不写一样。改完运行 `check`：opencode 的模型清单里没有的 variant 直接报出，其余逐个试一遍。
- `pi cli`：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，作为 `--thinking` 传给 pi。每个模型支持哪些不一样（比如 deepseek-flash 是 off / low / high / max），以 pi 的模型清单为准。**写了不支持的档位，pi 不会报错，会悄悄换成最接近的一档**（先往高处找，所以可能更贵），改完一定要运行 `check`，它按清单核对。
- `agy cli`：`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 里这个模型有的档位（`models` 列出，比如 gemini-3.8-flash 是 low / medium / high），派出时拼成 `<模型>-<档位>` 传给 agy。只有一档的模型不写就用那一档，没有档位的（比如 claude-sonnet-4-6）不写；有几档的必须写，否则 `check` 和派出时报错。`model` 已经写了带档位的完整 ID 时不能再写 `effort`。

向用户汇报时，不写和 `null` 都说成"推理强度：默认"。

各模型能选哪些推理强度，运行 `models` 查看：Codex、opencode 和 pi 读它们自带的模型清单；API 只能列出模型名，推理强度要查厂商的官方文档。

条目里还可以写 `model` 覆盖协作方的模型，旧配置里有这种写法照常能用。新配置不推荐：代号和实际模型会对不上。想换模型，就新加一个协作方。

内置默认值：没有协作方，discuss、run、review 九格都是 `"claude code"`，image 两格是 `null`。实际的安排来自第一次运行时生成的配置（见下文）。

## 第一次运行时生成的配置
用户配置不存在时，脚本第一次运行（任何子命令）会先检测本机，再生成配置。`config` 输出的 `environment` 字段也会列出检测结果。检测这几样：
- 有没有能用的 Codex：能启动、已登录；
- 有没有 opencode：能启动，`opencode models` 列出了几个模型；
- 有没有 pi：能启动，`pi --list-models` 列出了几个模型；
- 有没有 agy：能启动；
- 常见 API key 的环境变量：`DEEPSEEK_API_KEY`、`KIMI_API_KEY` / `MOONSHOT_API_KEY`、`MIMO_API_KEY`。

按检测结果生成（每一格都写成候选列表，不标必选）：

| 检测到 | 生成的内容 |
|---|---|
| 能用的 Codex | 两个 `codex cli` 协作方 `gpt-6.1-sol` 和 `gpt-6-astra`。执行：simple、normal 由 Claude 做，complex 用 gpt-6.1-sol max。审查：gpt-6.1-sol medium / high，complex 用 gpt-6-astra max。讨论：gpt-6.1-sol medium / high，complex 用 gpt-6-astra max。图像：generate 用 gpt-6.1-sol medium，draw 用 gpt-6-astra max |
| 没有能用的 Codex | discuss、run、review 九格都是 `"claude code"`，image 两格是 `null` |
| API key | 每家一个 `api` 协作方，`api_key_env` 指向检测到的变量，代号用模型名，**不放进任何格子** |
| opencode、pi、agy | 不写，要用哪个模型由 `/foreman:setup` 引导用户选 |

花钱或有安全影响的决定（用哪个 opencode 或 pi 模型、让 API 模型参加讨论、谁必选）都不会自动做，统一由 `/foreman:setup` 问用户。以后装了新工具，重跑 setup 就能补进配置。

## 从旧配置升级
- 从 codex-bridge 升级时，旧的 `~/.claude/codex-bridge.json` 会先复制到新位置。
- `dispatch.max_seats` 已经不用了，每一级找几家由 `seats` 决定：用户配置里留着它不影响，读配置时忽略，也不显示在 `config` 的输出里，文件不改；项目配置里写了会提示已忽略。
- 第一次读到 `levels` 写法时，脚本把它改写成 `modules`，原文件备份为 `config.json.bak`（已经有了就加时间戳）：
  - 只换结构，每一格的协作方、推理强度和顺序都不变；`run` 和 `review` 的单个对象改成只有一项的列表；
  - 不给任何条目加 `required`，也不加图像块（要用时运行 `/foreman:setup` 添加）；
  - **行为变化**：旧的讨论名单是"全员参加"，改写后变成"候选，由 Claude 挑"。想保留全员参加，就给这些条目都标上 `"required": true`，`/foreman:setup` 可以帮着标。
  - 改写后的文件里（包括下面更早的写法），`levels` 都留成一行说明文字（在 `modules` 前面），不要删。旧版插件只认 `levels`，读到只有 `modules` 的配置不会报错，而是悄悄把所有任务都改成 Claude 自己做；留着这行说明，旧版会直接报错（"配置 levels 无效：应为对象"），提醒你升级。新版读到它会跳过，不当成"同时写了 levels 和 modules"。
- 更早的写法一并转换，只写一次文件、只备份一次：
  - `type`：`codex` → `codex cli`，`opencode` → `opencode cli`，`openai-compatible` → `api`；
  - 格子里的 `"claude"` → `"claude code"`；
  - 协作方代号改成模型名，比如 `codex` → `gpt-6-astra`、`deepseek` → `deepseek-flash`，格子里的引用（包括图像格子）一起改；
  - 格子里覆盖了模型的，拆成一个新协作方；
  - 0.10 以前的写法，比如 `auto_dispatch`、顶层的 `model` 和 `sandbox`。
- 改写前后，每一格实际用的模型和推理强度不变。
- 新旧代号的对照记在 `~/.claude/foreman/agent-aliases.json`：续接旧任务、`--agent` 写旧代号、项目配置里的旧代号，都会自动换成新代号。
- 同一个文件里同时写了 `levels`（对象）和 `modules` 时直接报错，不猜以哪个为准；`levels` 是上面那行说明文字时不算。项目配置里的 `levels` 不改写文件，只在内存里按 `modules` 读，并提示改成新写法。旧版插件会忽略项目配置里的 `modules`，所以项目要同时约束还在用旧版插件的人时，项目配置可以继续用 `levels` 写法。

## 按项目覆盖：写在用户配置里
某个项目要比全局多用几个模型、换一套候选或者改时长时，在用户配置里加顶层 `projects`，按项目目录写：

```json
"projects": {
  "O:/work/app": {
    "dispatch": { "timeout_min": 600 },
    "modules": { "review": { "normal": [{ "agent": "a" }, { "agent": "b" }], "seats": { "normal": 3 } } }
  },
  "~/code/lib": { "modules": { "run": { "normal": "claude code" } } }
}
```

- 键写项目目录的绝对路径，可以用 `~` 开头；Windows 上要带盘符（`O:/work/app`）或写全 UNC（`//server/share/app`）。工作目录是这个目录或在它下面（子目录、仓库里的 worktree）都算；几条都对得上时只用最具体（路径最长）的一条，不叠加。Windows 上不分大小写。
- 只能写 `modules`，以及 `dispatch` 的 `discuss_max_rounds`、`timeout_min`、`stall_min`、`busy_ask_min`。`agents`、`auto`、`watch`、`intro`、`runs_dir` 作用于整台机器或整个会话，只能写在顶层，写进 `projects` 会报错。协作方只能引用顶层 `agents` 里定义过的代号。
- 合并方式和顶层覆盖默认值一样：写了的格子整格替换（要在全局候选的基础上加几个，就把全局那几个也写上），没写的格子沿用顶层；`seats` 按级覆盖。可以放宽也可以收紧。
- 每次读配置都会校验 `projects` 里的所有条目，不只当前项目那条；写错时报错会指出是哪一条。
- 它写在你自己的用户配置里，不随仓库走，所以可以放宽。仓库里的 `.claude/foreman.json` 仍然只能收紧，收紧的基准是套用了 `projects` 之后的配置。
- `config --cwd` 输出的 `project_override` 是 `{ "path": "<用到的那条的键原文>" }`，没用到时为 `null`。

## 项目配置：只能收紧
- 项目配置只认 `dispatch` 的 `timeout_min`、`stall_min`、`busy_ask_min`，以及 `modules`（包括 `discuss`、`review` 的 `seats`；旧写法 `levels` 也认）；其他字段都会被忽略并提示，包括 `agents` 整块。
- 时长和席位取更严的值：`timeout_min` 和每一级的 `seats` 取两边较小的（`seats` 调到少于这一格的必选数时报错）；`stall_min`、`busy_ask_min` 的 0 表示不检测，是最宽松的，所以用户写了正数时项目写 0 不生效，两边都是正数时取较小的。
- `modules` 可以只写要改的那几格。每一格只能：
  - 整格关掉：discuss、run、review 写 `"claude code"`，image 写 `null`；
  - 从用户配置这一格已有的条目里删掉一部分可选条目（条目顺序沿用用户配置）；
  - 调低推理强度：只限有明确高低顺序的工具，Codex 是 low < medium < high < xhigh < max < ultra，pi 是 off < minimal < low < medium < high < xhigh < max，agy 是 minimal < low < medium < high < xhigh < max。opencode 的 variant 和 api 的推理强度没有统一的顺序，项目配置不能改；用户配置没写推理强度的条目，项目也不能加。
- 不能加条目、换协作方或模型、改 `required`、打开用户关着的格子。这些写法会被忽略并提示。
- 不能只去掉必选、留下其他条目继续外派：会报错，要么留着必选，要么整格关掉。写的条目一个都对不上用户配置（比如克隆来的仓库用的是别人的一套代号）时，提示一句，按项目关掉这一格。
- 项目在某一格写了 `"claude code"`（或 `null`）以后，这个项目里这一格不能再用 `--agent` 点名派出，哪怕用户配置里它本来就是 `"claude code"`；项目没写、用户配置里是 `"claude code"` 的格子照常可以点名。这一格有必选时，那一步算"没做"，Claude 会如实告诉你，不会自己审一遍就当作已经满足。`config --cwd` 输出的 `closed_by_project` 列出被项目关掉的格子。
- 这样别人的仓库没法借项目配置换掉执行方（比如从有沙箱的 Codex 换成没沙箱的工具）、把代码发给新的厂商、跳过必选的审查，或者延长超时、调高推理强度来多花你的额度。敏感项目可以删掉 api 候选，或者把讨论、审查整格写成 `"claude code"`。

## 其他规则
- 每个协作方的并发上限按它自己正在运行的任务算，不分任务组、不分会话；达到上限时派发命令默认按先来后到排队：在记录目录的 `.state/queue/<协作方>/` 下领一张票据，每秒检查一次，排到最前面并且有空名额时启动；stderr 写出排在第几位和最多还等几分钟。`--queue-timeout <分钟>` 改最长等待时间（默认 60，最多 1440），写 0 时不排队、名额满了立即拒绝，报错里列出占着名额的任务。排队的进程被结束时票据随之删掉；被强制结束留下的票据，由下一个检查者按进程是否还在、票据是否过期回收。`status` 列出排队中的票据。派发计划本身不占名额。
- 同组任务的写入范围不能重叠，这条只查会写文件的任务（执行），讨论和审查不查。
- 沙箱不是 `read-only` / `workspace-write` 时（比如 `danger-full-access`），Codex 能写任何目录，`--cwd` 只决定它从哪里开始工作，**不限制写入范围**。这时范围只能靠任务说明约束，再靠事后审查 diff 把关。
- 用户改了配置，改完运行 `config` 确认：
  - `resolved_modules` 列出每一格最终有哪些候选，每个候选的模型、推理强度和是否必选；
  - `project_override` 是 `{ "path": "<用到的那条 projects 的键>" }`（带 `--cwd` 时，没用到为 `null`）；
  - `closed_by_project` 列出被项目配置关掉的格子（带 `--cwd` 时）；
  - `image_configured` 说明用户配置里写没写图像块：为 `false` 时图像两格显示的 `null` 是默认值，不是用户关掉的；
  - `agents_status` 列出每个协作方的类型、能力、key 是否已设置、实际用的可执行文件；
  - `summary` 是总配置情况：每一格交给谁，每个协作方用在哪几格，以及提醒（没用到的协作方、明文 key、shell 权限用于执行或手画、`agent-aliases.json` 里指向已不存在代号的旧代号）。`check` 的输出里也有，并带上检查结果。

## 脚本输出配置提示时怎么转告
- 脚本输出"首次使用，已生成配置文件"时，转告用户检测到了什么（Codex、opencode、pi、API key）、现在各类任务交给谁，并建议运行 `/foreman:setup` 选择要用的模型。
- 脚本输出"已把配置文件 … 改成新写法"时，告诉用户：配置换成了新写法（`type` 改为 `codex cli` / `opencode cli` / `api`，`"claude"` 改为 `"claude code"`），协作方代号改成了模型名（转告脚本列出的对照），实际用的模型和推理强度都没变，原文件备份在哪里。
- 脚本输出"已把配置文件 … 里的 levels 改写成 modules"时，告诉用户：配置换成了 `modules` 写法，每一格的协作方、推理强度和顺序都没变；有一处行为变化，以前讨论一级里的协作方全员参加，现在是候选、由 Claude 挑，想保留全员参加就给它们标 `"required": true`；配置里还没有图像两格；文件里的 `levels` 留成了一行说明，旧版插件读到会报错，不会悄悄改成全由 Claude 做；原文件备份在哪里。建议运行 `/foreman:setup` 标必选、加图像两格。改配置时保留 `levels` 那行说明。
- **Windows 上 Codex 的只读沙箱**：默认的 elevated 沙箱在 `read-only` 模式下可能连读文件的命令都启动不了。给讨论和审查设 `read-only` 之前先运行 `check`：起不来时按它的 `fix` 在 `~/.codex/config.toml` 的 `[windows]` 里改用 `sandbox = "unelevated"`。没设只读沙箱时（`readonly` 为 `audited`），只读靠规则约束和事后对比快照，发现写入就记为失败，见 `references/review.md` 的"只读"。
- 用户要改配置时，直接编辑对应的 JSON 文件，改完运行 `config` 确认生效。
