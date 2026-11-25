# 配置字段说明

配置文件是 JSON，按下面的顺序叠加，后面的覆盖前面的：
1. 脚本内置默认值；
2. 用户配置 `~/.claude/foreman/config.json`（可以用环境变量 `FOREMAN_CONFIG` 换路径）；
3. 项目配置 `<项目目录>/.claude/foreman.json`（覆盖用户配置，见文末"项目配置：覆盖全局"）。

配置分三块：

| 块 | 回答的问题 |
|---|---|
| `dispatch` | 插件怎么派活：是否主动派、讨论轮数、超时等 |
| `agents` | 有哪些协作方，怎么连接 |
| `modules` | 按场景写：`default` 是默认的一套，其余场景只写要改的部分。每一套里，每类任务的每一格有哪些候选、谁必选、用什么推理强度；讨论和审查每一级几席、审查要不要补漏席 |

连接方式只写在 `agents`，分派只写在 `modules`。

**写法**：`modules` 里每个候选写成一行（`{ "agent": …, "effort": …, "required": true }`），`seats`、`gap` 各写一行，只含简单值的对象也收成一行，其余照常缩进。脚本自己改写配置文件（迁移、第一次生成）时用这种写法；已有的用户配置和项目配置可以用 `layout` 命令改成这样，内容不变（见 `references/cli.md`），`/foreman:setup` 也会推荐。手改配置时照这种写法写，读起来省事；写法不同不影响读取。

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
    "default": {
      "discuss": {
        "simple":  "claude code",
        "normal":  [{ "agent": "gpt-6.1-sol", "effort": "high" }, { "agent": "glm-5.3" }],
        "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }, { "agent": "glm-5.3" }, { "agent": "deepseek-v4-pro", "effort": "max" }],
        "seats":   { "simple": 2, "normal": 4, "complex": 3 }
      },
      "run":    { "simple": "claude code", "normal": "claude code", "complex": [{ "agent": "gpt-6.1-sol", "effort": "max" }] },
      "review": { "simple": [{ "agent": "gpt-6.1-sol", "effort": "medium" }], "normal": [{ "agent": "gpt-6.1-sol", "effort": "high" }], "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }],
                  "seats": { "simple": 1, "normal": 2, "complex": 2 },
                  "gap":   { "simple": false, "normal": false, "complex": false } },
      "image":  { "generate": [{ "agent": "gpt-6.1-sol", "effort": "medium" }], "draw": [{ "agent": "gpt-6-astra", "effort": "max" }] }
    }
  }
}
```

下文说"某一格""`seats`""`gap`"时，指的是某个场景里的写法；没用场景时就是 `modules.default` 里的。

## dispatch

| 字段 | 作用 | 默认 |
|---|---|---|
| `auto` | Claude 主动发起派活、讨论和审查前要不要先问用户：`true` 时看 `confirm` 里三个"开始前"节点；`false` 时这三个节点没单独写的都按 `"ask"`（见下面的"确认节点"） | `true` |
| `confirm` | 在哪几处先停下来问用户：讨论、执行、审查开始前，讨论和审查整合前，以及硬规则 R4 的角色分配和图像路线。写法、取值和默认值见下面的"确认节点" | 见"确认节点" |
| `watch` | 实时查看的开关，写成 `{ "terminal": true, "web": false }`，这两项都要写，还可以加一项 `web_open`：<br>`terminal`：网页看板关着时的终端实时查看。`web` 为 `false`、`terminal` 为 `true` 时，只要派给了其他模型（执行、续接、讨论、审查），任务启动后就打开一个终端标签页、弹出终端面板；`terminal` 为 `false` 时不主动打开。`web` 为 `true` 时只用网页看板，不主动打开终端实时查看。想在终端里看时，两种情况都可以用 `/foreman:watch`。<br>`web`：网页看板，在浏览器里用星图看本机所有 Claude Code 对话和派发进度。`true` 时每次派出都先在对话里给一个网页链接，再启动任务，由你点开在默认浏览器里看；`/foreman:watch` 也会给。看板服务这台电脑上所有对话共用，第一次用到时在后台启动，30 分钟没人看、也没有任务在跑就自己退出，插件被卸载或更新后也会退出。运行时服务约占 100–130 MB 内存，浏览器标签页约 60–90 MB；`/foreman:setup` 按内存决定开不开（总内存不到 8 GB 或可用不到 2 GB 时关着）。<br>`web_open`：可以不写，不写等于 `false`。`web` 和它都是 `true` 时，每个对话第一次派出任务，脚本自己在默认浏览器里打开这个对话的看板，同一个对话以后不再开（标签页关掉了就点对话里的链接；隔了一周以上没派出过的对话，再派出时会再开一次）。只看用户配置，项目配置里写了不起作用。1.2.2 及更早的版本读不了带这一项的配置，中英文两个插件都装着时要一起升级。<br>旧版的写法（`watch` 写 `auto` 或 `off`、另有一个 `web`）照样能读，第一次加载时会先备份、再改写成这种写法 | `{ "terminal": true, "web": false }` |
| `intro` | 新派出的对话第一次打开实时查看时，先放一段启动动画：模型的像素头像、"正在启动"和几句玩笑，单个模型 5 秒、讨论 10 秒，按任意键跳过，任务提前结束会马上收尾。续接（讨论的下一轮、返工）不放。头像按模型名里的关键字认（gpt、deepseek、glm、kimi、qwen、mimo、minimax、gemini、claude 等），认不出的用 ??? 头像。`false` 关掉 | `true` |
| `discuss_max_rounds` | 一场讨论最多几轮（第 1 轮加上之后的续接），每个参与方各自计数；超出后脚本拒绝续接 | `2` |
| `timeout_min` | 单次任务的总超时（分钟） | `480` |
| `stall_min` | 多久没有动静判定为卡死（分钟，0 为关闭）。Codex：没有任何事件，也没有命令在执行；API：流式输出里没有任何数据；opencode：没有输出任何事件；pi：没有输出任何事件，也没有工具在运行 | `40` |
| `busy_ask_min` | API 协作方因为服务繁忙排队超过多少分钟，就由 Claude 决定要不要终止它（0 为不处理） | `2` |
| `runs_dir` | 运行记录目录（也可用环境变量 `FOREMAN_RUNS_DIR`）。派发计划存在它下面的 `plans/` | `~/.claude/foreman/runs` |

### 确认节点
`dispatch.confirm` 管 Claude 在哪几处先停下来问用户。只能写在用户配置里，项目配置和偏好文件都改不了。

```json
"confirm": {
  "discuss": { "start": "auto", "adopt": "complex" },
  "run":     { "start": "auto" },
  "review":  { "start": "auto", "adopt": "normal" },
  "roles": "auto",
  "image": "ask"
}
```

| 节点 | 在哪一步问 | 弹窗里写什么 | 选项 |
|---|---|---|---|
| `discuss.start` | 主动发起讨论之前 | 议题、等级、请哪几家、为什么这样选 | 开始 / 换人或改等级 / 不做了 |
| `run.start` | 派出执行之前 | 要做的事、等级、交给谁、为什么选它 | 开始 / 换人或改等级 / 不做了 |
| `review.start` | 主动发起审查之前 | 审什么、等级、请哪几家、为什么这样选 | 开始 / 换人或改等级 / 不做了 |
| `discuss.adopt` | 讨论裁决以后、按结论动手之前 | 每条观点采纳与否和理由，打算怎么整合 | 按这个整合 / 我来改 / 都不采纳 |
| `review.adopt` | 审查核实以后、修改或返工之前 | 每条发现的去留，返工计划 | 按这个返工 / 我来改 / 不返工 |
| `roles` | 讨论和审查 2、3 级用角色模式时，启动之前 | 分配表，见 `references/roles.md` 的"确认分配" | 见那一节 |
| `image` | 每个新的图形交付物开工之前 | 图像路线，定稿图等用户认可，见 `references/image.md` | 见那个文件 |

**取值**
- 五个节点：`"auto"` 不问，直接做，开始时在正文里说一句；`"ask"` 每次都问；写等级 `"simple"`、`"normal"`、`"complex"` 表示这一级及以上才问（`"complex"` 只在 3 级问）。
- `roles`、`image` 只能写 `"ask"` 或 `"auto"`，它们是硬规则 R4 的两项确认。
- 整体可以简写成 `"confirm": "ask"`（每步都问）或 `"confirm": "auto"`（全自动），七项都取这个值。
- 没写的项按上面这一套补，老配置也一样。补的值只在内存里，不改写配置文件。`dispatch.auto` 为 `false` 时，三个 `start` 没单独写的按 `"ask"` 算；单独写了的、或者用了简写的，以写的为准。
- `config` 输出的 `effective.dispatch.confirm` 是补全后的结果，按它判断。
- `/foreman:setup` 有三套预设：默认（上面这一套）、全自动、每步都问。

**什么时候不问**
- 用户自己点名的（`/foreman:run`、`/foreman:discuss`、`/foreman:review`，或者明确说"派出去""和其他模型讨论""请人审一下"），开始前不再问。
- 0 级不问：它不派出去，也没有外部观点要整合。格子配成 `"claude code"`、不找外部模型时，开始前和整合前都不问。
- 没有要按结论去做的事时（比如用户只是来要建议，结论就是交付），整合前不问。1 级问答要据此动手、整合前又要问时，弹窗写明回答的要点和打算怎么做。

**怎么问**
- "问用户"用主持方自己的提问方式，Claude Code 里是弹窗（AskUserQuestion）。没有提问工具、但用户就在对话里时，在正文里列出内容并提问，等用户回答。
- 弹窗本身的文字里写出要用户看的内容（用户不一定看得到正文），推荐的选项放第一个。
- 同一时刻要问的几件事合成一个弹窗，比如开始讨论和角色分配、图像路线和角色分配。
- 整合前用户改了 Claude 的结论，就照用户的来；"不因为谁坚持就让步"管的是外部模型，不是用户。用户选"都不采纳""不返工"时照做，汇报里写明。
- 没人能回答时（比如无人值守的自动运行），五个节点按 `"auto"` 处理，汇报里写明哪几处本该问、按什么做了。`roles` 和 `image` 照那两个文件的规定。

**和旧版本一起用**：1.2.x 只认 `{ "roles": …, "image": … }` 两项，读到新写法会报 confirm 写法不对。同一台电脑上还有旧版本插件时（比如桌面版里上传的旧包），先都升级再改写法；不写新键时新旧版本都能读。

## agents

- 键是协作方的**代号**，`modules` 和 `--agent` 用它引用。建议直接用模型名。
- 代号只能用字母、数字、`.`、`-`、`_`，以字母或数字开头；不能叫 `claude`、`claude code` 或 `self`。
- `type` 决定怎么连接、要填哪些字段，只有六种。同一种可以配多个，各用不同的模型。
- Codex 不是必需的，一个协作方都不配也行：那样所有任务都由 Claude 自己做。

**`type: "codex cli"`**（本机的 Codex CLI）

| 字段 | 作用 | 默认 |
|---|---|---|
| `model` | 模型 | 不写就沿用 `~/.codex/config.toml` |
| `bin` | codex 可执行文件或 `codex.js` 路径（也可以用环境变量 `CODEX_BIN`） | 自动查找 |
| `max_parallel` | 这个协作方同时最多运行几个任务，所有任务组和会话加起来算（见 `references/run.md` 的"并发拆分"） | `4` |
| `sandbox` | `run` / `review` / `discuss` 各自的沙箱：`read-only` / `workspace-write` / `danger-full-access`。讨论和审查设成 `read-only` 时由系统沙箱拦下写入（结果的 `readonly` 为 `sandbox`），否则只靠规则约束和事后对比快照（`audited`）。Windows 上默认的 elevated 只读沙箱可能连读文件的命令都启动不了，见下文 | 全部 `null`，沿用 Codex 配置 |
| `approval` | 审批策略：`never` 或 `on-request` | 不写时用 `never`：无人值守，没人能审批。命令被沙箱挡住时直接把失败交回给模型；沙箱坏了要修沙箱，见下文"Codex 的沙箱起不来时" |

讨论和执行时（续接、图像任务也算），Codex 能搜网页、读网页：你的 `~/.codex/config.toml` 里没写 `web_search` 时，脚本加上 `-c web_search="live"`（实时搜索）；写了任何值（顶层、某个 profile 或 `[tools]` 里都算）就照你的，写成 `"disabled"` 时提示词里也不说能上网。审查不加。网页搜索由 Codex 的服务端完成，只读沙箱拦不到它。

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

登录和 key 都由 opencode 自己管（比如 OpenCode Go 要先在 opencode 里运行 `/connect` 登录），插件不碰。讨论和审查时，脚本给 opencode 注入一个只读代理，有读文件、搜索和列目录的工具：它能自己翻项目里的代码，但不能运行命令，也不能改文件。讨论时的代理另外放行 opencode 的 `webfetch`（读网页）；你在 opencode 里配了网页搜索服务（配置里写 `"websearch": {"provider": "random"}`，或者指定一家服务）时，再放行 `websearch`（搜网页）。没配时不放行：opencode 会想问你用哪家服务，无头运行答不了，整轮会失败。脚本派活前用 `opencode debug config` 查你配了没有。审查时这些都不放行。审查改动（`diff`）时，要看的改动由脚本用 git 算好附给它；审已有文件时只给路径，由它自己读。

注入的代理名每次运行都带一个随机后缀（比如 `foreman-run-1a2b3c4d`，这次运行里修复报告格式的那一轮也用同一个后缀）。所以你自己的 `OPENCODE_CONFIG_CONTENT`、项目和全局配置里预先写好的同名代理，顶不掉它们的权限；你写的 `foreman-discuss` 之类的条目原样保留，和注入的代理互不相干。

执行时注入的代理按 `run_access` 开放写文件，`shell` 档再开放运行命令，两档都放行 `webfetch`，配了网页搜索服务时再放行 `websearch`。opencode **没有系统沙箱**：
- `edit` 档写不了项目目录以外的文件，也没有运行命令的工具；
- `shell` 档的命令以你的账户权限运行，能访问整台机器。

opencode 自己只按字面路径判断写到哪里，所以执行档注入的写入规则是先允许、再逐个拒绝下面几类路径：
- 项目里的符号链接和 Windows 的 junction，不管指向项目里还是项目外、目标存不存在：经由链接的写入一律拒绝，要改链接指向的文件得用真实路径。派执行任务前，脚本先扫一遍项目找出它们。列不出内容的目录、文件和目录超过 30 万个时没扫到的目录，整个拒绝；链接太多、规则装不下时，合并成上层目录拒绝。这几种情况，结果的 notes 里都会写明。要合并到项目根目录，或者项目根下的链接名字没法写进规则时（比如以 `~` 开头、含 `$HOME` 或花括号，opencode 会把它们展开或替换掉），这次不启动 opencode。加上你自己的 `OPENCODE_CONFIG_CONTENT` 以后，注入的配置超过单个环境变量的长度上限时，同样不启动。
- 受保护的目录和文件：`.git`、`.claude`、`.opencode`、`.codebuddy`、`.gemini`、`.agents`、`.agent`、`_agents`、`_agent`、`.pnpm`、`.pnpm-store` 目录，以及 `opencode.json`、`opencode.jsonc`，项目里哪一层的都算；还有 Git 实际用的元数据目录和钩子目录（用 `git rev-parse` 查出、落在项目里的，路径按系统的顺序先展开链接再处理 `..`，查不清时不启动），以及登记在项目里的 Git 工作树（opencode 的 `worktree_remove` 按写文件的权限判断，按工具名禁用管不住它）。写进去等于改 git 钩子、Claude Code 或协作方的配置，之后会被执行；pnpm 这两个目录里是指向全局仓库的硬链接，改了会连带改到全局仓库。
- 项目目录以外的路径：绝对路径（`/` 开头）和 `..` 开头的路径，比如在仓库的子目录里派活时，同一仓库里这个子目录以外的地方。opencode 匹配规则时用的是相对项目目录的路径，所以项目里的文件就算用绝对路径写，也不受影响。opencode 的工作树工具 `worktree_remove`、`worktree_create` 也一并禁用。
- Windows 上含 `~` 或 `:` 的路径，防止用 8.3 短名或 NTFS 流写法绕过上面的规则。

其他硬链接、执行期间才新建的链接，这套规则管不到；macOS 和 Linux 上还没有在真机上验证过。

`edit` 档还会关掉 opencode 的格式化命令（注入 `formatter: false`，项目 `opencode.json` 里配的也关），因为它们会在写完文件后运行；`shell` 档照旧。

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
| `run_access` | 可选，和 opencode、pi 一样：`"edit"` 或 `"shell"`，只能写在用户配置里。不写就不能放进 `run` 和 `draw` 格子，也不能被点名派执行 |

能参加讨论和审查；写了 `run_access` 还能做执行任务。登录由 agy 自己管，插件不碰。agy 不能按次加载扩展，插件靠它的全局钩子管住工具：
- 用之前要装守卫（`agy-guard install`，`/foreman:setup` 会先征求用户同意）：在 `~/.gemini/config/hooks.json` 里加一个 `foreman-guard` 条目，同目录写启动器和守卫脚本。没有 foreman 运行时守卫回答 `ask`，用户平时用 agy 不受影响；
- 每次派出前自检：项目（从工作目录往上到仓库根，加上每个 `--add-dir`）的 `.agents` 等目录里有 agy 的钩子、MCP 或插件配置，或者全局 `hooks.json` 里有 foreman 以外的钩子，就不派，报错写明是哪个文件；守卫文件和插件里的不一致时在锁里重新写入；
- 守卫只放行读文件（路径限定在项目目录和 `--add-dir` 里）和任务清单；本机 agy 的沙箱经探针确认可用时（Windows 上不探测、一律按不可用处理：agy 的 Windows 沙箱不拦用户目录以外的读取），读档再放行沙箱里的命令：沙箱里改不了项目内外的文件、上不了网，但系统临时目录仍然可写。沙箱不可用时没有 shell，讨论材料附上 `git ls-files` 的清单；
- 讨论和执行时另外放行上网和浏览器工具，审查、报告格式修复和沙箱探针不放行：
  - `search_web` 搜网页：在 agy 的服务端搜，给出的来源是 Google 的跳转链接（`vertexaisearch.cloud.google.com/grounding-api-redirect/…`）；
  - 读网页（`read_url_content`）和 `open_browser_url`：守卫放行，但 agy 1.5.16 的命令行版本身没启用，调用会报 not enabled；
  - 浏览器子 agent（`invoke_subagent` 的 `browser` 类型）和它要用的 chrome_devtools 工具、`send_message`、`schedule`、`manage_subagents`。浏览器子 agent 经 Chrome 的远程调试操作用户自己正在用的 Chrome，带着用户的登录状态；Chrome 没开远程调试（`chrome://inspect/#remote-debugging`）时连不上；
  - 参数按名字检查（任意层级）：名字里带 `path` 或 `file` 的拒绝（截图存盘、上传文件这类），名字里带 `url` 或 `uri` 的必须是 http/https 网址（`file:///` 这类地址能借浏览器读本机文件）。这样项目文件仍然只读、执行的写入范围不变；但浏览器本身守卫管不住：它下载的文件会落到 Chrome 的下载目录，它能读用户已经打开的标签页（包括本机文件），也能带着用户的登录操作网站、本机服务和内网系统；
  - 名字可能来自用户自己配的 MCP 服务器的工具一律拒绝：agy 预载工具的名字是 `mcp_<服务器>_<工具>`，`~/.gemini/config/mcp_config.json` 里有服务器名和它撞上（比如名叫 `chrome-devtools`）时，浏览器的这类工具不放行；这个文件读不了时也不放行；
  - 别的子 agent 类型、用户自己配的 MCP 服务器和 `ask_question` 照旧拒绝；
- 执行时按 `run_access` 放行，和 pi 的两档相同，不用沙箱（各平台一样，Windows 也支持）：`edit` 再放行写文件，只能写项目目录里的文件（`--add-dir` 给的目录只能读，在项目里面的也一样），不能运行命令，任务说明末尾附上 `git ls-files` 的清单；`shell` 再放行运行命令，**没有系统沙箱**，命令能碰到整台机器、也能联网，只靠任务说明约束。两档都不许写项目里的 `.git`、`.claude`、`.gemini`、`.agents`、`.agent`、`_agents`、`_agent` 目录（不分大小写，写法本身和真实路径都查；这些目录是链接、`.git` 是写着 `gitdir:` 的文件时，指向的目录也不许写）：写这些目录等于改 git、Claude Code 或 agy 的配置和钩子。agy 的设置目录、foreman 的状态目录和运行记录也不许写，哪怕它们在项目里。写入路径带 `.` 或 `..` 段、Windows 上有段名以点或空格结尾时，拿不准实际写到哪里，一律拒绝；指向项目外网络共享的路径在访问之前就拒绝。项目目录包含主目录下的 `.gemini` 或 `.claude`（比如项目目录就是主目录），或者本身就在 agy 的设置、foreman 的状态目录或运行记录里面时，不派执行任务。上网和浏览器工具和讨论时一样放行；
- 插件升级后，守卫文件和插件里的不一致时，下一次派 agy 或运行 `check` 会自动换成新版（`hooks.json` 不动），不用重装；有别的 agy 任务正在运行时这次不换、也不派（报错写明是哪些任务），等它们结束再派；
- 启动前去掉密钥类环境变量（只留 agy 自己登录可能用到的 `GEMINI_API_KEY`）；运行期间在 foreman 状态目录写启动标记，同一目录里没有带策略的 agy 会被守卫拒绝工具调用；守卫的每次决定记在 `run_dir` 的 `agy-guard.jsonl`，用了工具却没有决定记录的一轮判失败；
- 用户自己的 GEMINI.md、skill 照常加载，全局 MCP 服务器会启动但工具被拒绝；会话出现在 agy 的历史里。

**`type: "codebuddy cli"`**（本机的 CodeBuddy CLI，即腾讯云代码助手，npm 包 `@tencent-ai/codebuddy-code`，命令 `codebuddy` / `cbc`）

| 字段 | 作用 |
|---|---|
| `model` | 必填，`codebuddy --help` 里 "Currently supported" 列出的模型 ID，比如 `deepseek-v4.1-flash` |
| `bin` | 可选，codebuddy 可执行文件或 npm 包里 `bin/codebuddy` 的路径。默认自动查找 |
| `max_parallel` | 可选，默认 `4` |
| `run_access` | 可选，和 opencode 一样：`"edit"` 或 `"shell"`，只能写在用户配置里。不写就只能参加讨论和审查，不能放进 `run` 和 `draw` 格子，也不能被点名派执行 |

登录和可用模型由 codebuddy 自己的账号管（在 codebuddy 里 `/login`），插件不碰。脚本每次调用都：
- 只开放这次任务需要的工具：讨论和审查只有 `Read`、`Glob`、`Grep`；执行的 `edit` 档再加 `Write`、`Edit`，`shell` 档再加 `Bash`、`PowerShell`；讨论和执行另加上网的 `WebSearch`、`WebFetch`，审查不加；
- 注入一个 `PreToolUse` 守卫钩子，检查每一次读文件、搜索、写文件和读网页：
  - 读和搜索只能在项目里；
  - `edit`、`shell` 的写入也只能在项目里，不能改 `.git`、`.codebuddy`、`.claude`、foreman 的记录和设置、CodeBuddy 的设置，也不能写有其他硬链接的文件；
  - `@`、`file:` 开头和 `/c/` 这类写法（CodeBuddy 会在钩子之后改写它们）、带 `..` 的路径、网络共享上的路径一律拒绝；
  - `WebFetch` 只能读 http、https 网页；
- 讨论、审查和 `edit` 用 `dontAsk`，`shell` 用 `-y`，守卫照样拦写入；
- 用 `--strict-mcp-config` 不加载任何 MCP 服务器，用 `--setting-sources user` 不加载项目和本地设置以及其中的 hooks；子进程里关掉"主 agent"切换，去掉 `CODEBUDDY_PLUGIN_DIRS`、`CODEBUDDY_MCP_CONFIG`、`CODEBUDDY_PROJECT_CONFIG_DIR` 这些会换掉配置来源的环境变量；
- 启动前检查 CodeBuddy 的用户设置（`~/.codebuddy/settings.json`，设置了 `CODEBUDDY_CONFIG_DIR` 时用其中的 `settings.json`）：
  - 有 `permissions.allow`、`permissions.additionalDirectories`、`hooks` 或启用的插件，或者文件读不出来，就拒绝启动并写明路径；
  - `edit` 的守卫会批准项目内的写入、盖过用户的规则，所以 `edit` 另外拒绝 `permissions.deny`、`permissions.ask`；
  - 用户设置里的 `trustedDirectories` 不影响边界；
  - 遇到这种情况，换一份干净的独立 CodeBuddy 配置或者换别的协作方，不要替用户改这些文件；
- Windows 上固定用找得到的 Git Bash 执行钩子，找不到就拒绝启动：没有 Git Bash 时 CodeBuddy 会改用 PowerShell，守卫就不起作用；
- Windows 上 CodeBuddy 的 Grep、Glob 会跟着链接走，所以讨论、审查和 `edit` 开始前先扫一遍项目（跳过 git 忽略的目录）：有指向项目外的链接时，这一轮不给 Grep 和 Glob，改附上 `git ls-files` 清单，`notes` 里写明；
- 不支持 `--add-dir`，项目外的材料摘进说明；
- 报告走它原生的 `--json-schema` 结构化输出（`StructuredOutput` 工具只在这一轮要输出报告时放进白名单）；如果服务端仍返回无效报告，脚本会按通用流程在同一会话再修一次；
- 会话存在 codebuddy 自己的历史里，续接用 `--resume`；续接和修复报告时只算本轮的用量，不用累计的 `result.usage`。

被守卫或 CodeBuddy 拦下的调用记在结果的 `questions` 里（`permission_denied`，写明工具和路径）。`edit` 和 `shell` 都必须先拍改动快照才开始；`shell` 的命令仍以当前账户权限运行，没有系统沙箱。以上在 Windows 11、CodeBuddy 2.185.0 上实测过，macOS 和 Linux 还没有验证。

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

|  | codex cli | opencode cli | pi cli | agy cli | codebuddy cli | api |
|---|---|---|---|---|---|---|
| 能做的任务（`modes`） | 执行、审查、讨论 | 执行（要写 `run_access`）、审查、讨论 | 执行（要写 `run_access`）、审查、讨论 | 执行（要写 `run_access`）、审查、讨论 | 执行（要写 `run_access`）、审查、讨论 | 讨论、审查（只审文本材料） |
| 隔离（`isolation`） | 系统沙箱（`os`），看沙箱配置 | 只有工具权限（`tools`） | 只有工具权限加守卫扩展（`tools`） | 全局钩子里的守卫（`tools`）；讨论和审查的只读命令在 agy 沙箱里，执行不用沙箱 | 工具权限加守卫钩子（`tools`） | 无（`none`），只收发文字 |
| 自己读代码（`reads_code`） | 能 | 能 | 能 | 能 | 能 | 不能，靠附带文件 |
| 原生格式约束（`native_schema`） | 有 | 没有，靠提示词加一次修复 | 没有，同左 | 没有，同左 | 有（`--json-schema`） | 没有，同左 |
| 原生审查（`native_review`） | 有 | 没有 | 没有 | 没有 | 没有 | 没有 |
| 出图（`images`） | 能 | 不能 | 不能 | 不能 | 不能 | 不能 |
| 看图（`reads_images`），决定能不能做 `visual` 审查 | 能（view_image） | 先记为不能（还没验证） | 先记为不能（还没验证） | 先记为不能（还没验证） | 先记为不能（还没验证） | 不能 |
| 上网（讨论和执行时；审查都不能；不在 `capabilities` 里） | 能，用 Codex 自己的网页搜索 | 能读网页（`webfetch`）；在 opencode 里配了网页搜索服务才能搜 | 不能 | 能搜网页；浏览器子 agent 要 Chrome 开远程调试 | 能，`WebSearch` 搜网页、`WebFetch` 读网页 | 不能 |
| 讨论和审查的只读保障（结果的 `readonly`） | `sandbox`（配了 `read-only` 沙箱）或 `audited` | `tools` | `tools` | `tools` | `tools` | `tools` |

## modules

四个模块，按交付物划分：

| 模块 | 交付物 | 格子 |
|---|---|---|
| `discuss` | 对还没定的事给方案和取舍（只读） | `simple` / `normal` / `complex` |
| `run` | 改动 | `simple` / `normal` / `complex` |
| `review` | 对已经存在的东西给问题清单（只读） | `simple` / `normal` / `complex` |
| `image` | 位图和矢量部件 | `generate`（出图）、`draw`（手画矢量），不分等级 |

另有一个 0 级（未达门槛、不值得找外部模型），固定由 Claude 自己做，不进配置。每一格可以写：
- `"claude code"`（只限 discuss、run、review，也可以写成 `"self"`）：执行由 Claude 自己做；审查和讨论表示这一格不找外部协作方。
- 候选列表：`[{ "agent": "<代号>", "effort": "<推理强度>", "required": true }, …]`。只有一项时也可以写成单个对象，效果一样。同一个协作方在一格里只能出现一次。
- 混合候选（只限 run）：列表里可以加一项 `{ "agent": "claude code" }`（也可以写 `"self"`）代表主持方，和外部协作方一起当候选，比如 `[{ "agent": "claude code" }, { "agent": "gpt-6.1-sol", "effort": "max" }]`。Claude 按 models.md 挑：文档写明主持方的模型更擅长这类活时自己做，不建计划、不调用 `run`；没写出差别就派给外部候选（见 `references/seats.md` 第 4 条）。
  - 这一项只能写 `agent`：推理强度和模型在 Claude Code 里选；要主持方每次都做，把整格写成 `"claude code"`。它也不能标必选，一格只能写一次。这一格有必选的外部候选时，照常交给必选方。
  - 列表里只有它一项时，等于整格 `"claude code"`。
  - `resolved_modules` 里它显示成 `{ "agent": "claude code", "host": true }`，不带档位、推理强度和模型。单席派发不写 `--agent` 时，"只有一个候选就用它"只数外部候选；`run --agent` 和 `plan --seat` 不能点主持方。
  - discuss 和 review 的列表不能写它：主持方本来就固定占 Claude Code 席（0 号席）。image 的格子也不能写。
- `null`（只限 image）：关掉这一格。generate 关掉就不出图；draw 关掉时，会弯的部件和纯矢量绘制由 Claude 自己画。Claude 不能出位图，所以 image 的格子不能写 `"claude code"`。

`discuss` 和 `review` 另有一项 `seats`，写每一级找几个外部模型；`review` 还有一项 `gap`，写每一级要不要补漏席。三级都写在配置文件里，改直接改它们。新建的配置自带这两项；没写全的用户配置，第一次读的时候由脚本补全写进文件。默认值和规则见下文"候选和必选"，按场景整套配置见"场景"。

能放进哪一格，按能力表校验：discuss 的候选要能讨论，review 的要能审查；run 的要能执行，opencode、pi、agy 和 CodeBuddy 还要写了 `run_access`；generate 的要能出图（适配器声明了 `images`，并且实现了出图检测：这一轮新出了哪些图、每次调用传了什么参数；目前只有 codex cli）；draw 的要求和 run 相同。

图像任务的派法：每个新的图形交付物开工前，Claude 先弹窗让用户选路线（`dispatch.confirm.image` 为 `"auto"` 时由 Claude 选、在正文写明；① 位图、② 位图 + 矢量混合、③ 纯矢量先出参考图、④ 纯矢量 / 代码），再用 `plan --module image --cell <generate|draw> --route <路线号>` 建计划、`image --plan … --seat …` 启动；路线决定用到哪几格，只建用到的格子的计划，所以没用到的格子里的必选不会触发（比如选了路线 ④，generate 的必选不用到场）。脚本会核对这个会话里最近一次路线弹窗的回答（自动模式下用 `--route-auto` 记下理由，不核对），见 `references/cli.md` 的"plan、image 和 status --plan"。

### 候选和必选
- 一格有几个候选时，由 Claude 按 `references/seats.md` 的规则挑（排除做不了的、必选全部加入、讨论和审查按不同的基础模型补到配置的席位数、执行每个工作包派一个执行方），每次派出时说一句选了谁、为什么。脚本只检查能机械判断的硬约束。按场景配了的格子，先选场景，再在这个场景的格子里照同样的规则挑，见"场景"。
- `seats`（只限 `discuss` 和 `review`）：每一级的外部席位数，不含 Claude Code 席和补漏席。默认值如下（插件里写明默认数字的只有这一处，其他文档都引用这里）：

  | | simple | normal | complex |
  |---|---|---|---|
  | `discuss` | 2 | 4 | 8 |
  | `review` | 1 | 2 | 2 |

  必选算在这个数里，所以不能少于这一格的必选数，否则读配置时报错；可以多于候选数，表示候选全上。想让某一级固定用哪几家，就只放这几家、把席位数设成候选数，或者全部标必选。`plan` 建讨论或审查计划时检查外部席位数等于 `min(seats, 能用的候选数)`（`visual` 审查只算能看图的），不一致时要带 `--count-why "<理由>"`。能用的候选数按协作方代号算，同一个模型经两种方式接入算两个。每一级写一个正整数。
- `gap`（只限 `review`）：每一级审查要不要补漏席，写 `true` 或 `false`。默认三级都是 `false`。开着时，计划里要列一个补漏席（这一格还有合适的候选时），做法见 `references/review.md` 的"补漏轮"；关着时不做补漏轮。写在 `discuss` 里会报错。
- 用户配置里 `default` 的 `seats`、`gap` 没写全时，第一次读配置会补写进文件：`seats` 缺的等级按默认值补（不少于这一格的必选数，照旧配置标了很多必选也能直接用）；`gap` 整项没写、而且配置还是平铺写法的旧配置时，补成 `{ "simple": false, "normal": false, "complex": true }`，和升级前"只有 3 级审查做补漏轮"的做法一样；已经是场景写法的配置，`gap` 没写的等级按默认值（关）算，不改写文件。已经写了的等级不动。原文件备份成 `<文件名>.bak`（已有同名备份时在后面加时间和进程号），改写后的文件保留原来的权限，并提示补写了什么；写不进去时（比如文件只读，或者别的进程占着改写锁超过 10 秒）只在内存里补，同时提示补写失败、文件没改。写错（格式不对、少于必选数）时不会自动改，照常报错。项目配置不改写，没写的等级沿用用户配置。不认识 `seats`、`gap` 的旧版插件读到它们会报错，所以每台电脑都要升级。实际用的值看 `config` 输出的 `resolved_modules.<discuss|review>.seats` 和 `resolved_modules.review.gap`。
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
- `codebuddy cli`：`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，作为 `--effort` 传给 codebuddy。各模型支持哪些档位不同，但 `codebuddy --help` 只列模型、不列档位，`models` 和 `check` 只能按这六个档位核对，实测不支持的档位可能被换成最接近的一档，所以拿不准时先按模型厂商的说法写。

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

按检测结果生成，都写在 `modules.default` 里（每一格都写成候选列表，不标必选）：

| 检测到 | 生成的内容 |
|---|---|
| 能用的 Codex | 两个 `codex cli` 协作方 `gpt-6.1-sol` 和 `gpt-6-astra`。执行：simple、normal 由 Claude 做，complex 用 gpt-6.1-sol max。审查：gpt-6.1-sol medium / high，complex 用 gpt-6-astra max。讨论：gpt-6.1-sol medium / high，complex 用 gpt-6-astra max。图像：generate 用 gpt-6.1-sol medium，draw 用 gpt-6-astra max |
| 没有能用的 Codex | discuss、run、review 九格都是 `"claude code"`，image 两格是 `null` |
| API key | 每家一个 `api` 协作方，`api_key_env` 指向检测到的变量，代号用模型名，**不放进任何格子** |
| opencode、pi、agy、CodeBuddy | 不写，要用哪个模型由 `/foreman:setup` 引导用户选 |

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
- 同一个文件里同时写了 `levels`（对象）和 `modules` 时直接报错，不猜以哪个为准；`levels` 是上面那行说明文字时不算。项目配置里的 `levels` 不改写文件，只在内存里按 `modules` 读，并提示改成新写法。
- 用户配置里的 `projects`（按项目目录写的覆盖）已经不用了：读到时不生效，每次都提示一次，`summary.warnings` 里有一条 `obsolete_projects`。改成在各项目里写 `.claude/foreman.json`（见文末），`/foreman:setup` 可以帮着搬过去，并从用户配置里删掉 `projects`。
- 从 1.2 及更早的版本升级时，项目配置从"只能收紧"变成了"覆盖用户配置"：以前写了会被忽略的放宽项（加候选、调高席位、延长超时等），升级后会生效；项目在某一格写 `"claude code"` 也不再挡住 `--agent` 点名派出（以前会挡住，并列在 `closed_by_project` 里，这个字段已经去掉）。`config` 和 `check` 会把还是平铺写法的项目配置列进 `summary.warnings`（`project_modules_flat`），`/foreman:setup` 会提醒你核对里面的放宽项。
- 从 1.2 及更早的版本升级时，界面视觉定稿和给人读的文字不再固定由 Claude 做，和其余实现一样按 run 的格子和 models.md 决定。想保持原来的做法，在 run 写了外部候选的格子里加上 `{ "agent": "claude code" }`，并在 models.md 里 Claude 那一节写明它擅长这些（`/foreman:setup` 生成的默认版本就是这样写的，也会问要不要加进格子）。混合候选和整格 `"self"` 是这一版新加的写法，旧版插件读到会报错：每台电脑都要升级，中英两个包都装了的两个都要升级（它们读同一份配置）。
- 第一次读到平铺的 `modules`（下面直接是 `discuss`、`run`、`review`、`image`）时，脚本把它整体放进 `modules.default`，原文件先备份，并提示改写了什么；格子的内容一点不变。项目配置里的平铺写法不改写文件，只在内存里按 `default` 读，并提示改成新写法。同一个 `modules` 里既有平铺的模块又有场景时直接报错。不认识场景写法的旧版插件读到 `modules.default` 会报错，所以每台电脑都要升级。

## 场景
同一类任务往往服务于不同的场合：比如研究证据的审查要"广"，多找几家、留补漏席；高风险代码的审查要"准"，只用最强的两家，推理强度开满。这时可以在 `modules` 下按场景整套配置。不需要的话不用管这一节，配置里只有 `modules.default`。

**1. 在偏好文件里定义场景**：用户偏好 `~/.claude/foreman/preferences.md`（和用户配置在同一个目录），或者项目偏好 `<项目目录>/.claude/foreman.md`，写一个场景块：

```markdown
<!-- foreman:scenes -->
## 场景路由
- **code**：评判或决定代码、接口、配置、脚本、测试的改动；`--target diff` 的审查一律算 code。
- **research**：研究结论和证据、研究方案、研究报告、研究方向构思；`--target claims` 的审查一律算 research。
- 两类都有的拆成两个计划；没写到的情况用 default。
<!-- /foreman:scenes -->
```

- 块里以 `- **<名字>**：` 开头的行定义一个场景。名字只能用小写字母、数字和连字符，以字母开头；`default` 是保留名，不能用。
- 其余文字是给 Claude Code 看的路由说明：什么样的任务算哪个场景。脚本不读它们，Claude Code 派活和建计划时按它们选。
- 项目偏好里有场景块时，只用项目的场景：项目定义了哪几个，这个项目里就只能用哪几个，用户配置里其余的场景块在这个项目里不生效（`config` 输出的 `scenes.inactive` 列出它们，并提示一句）；写一个空的场景块，表示这个项目不分场景、全用 `default`。项目配置自己写的场景块，必须在项目偏好里定义。项目偏好里没有场景块时，用用户偏好的。
- 一份文件只能有一个场景块；开始和结束标记要配对。

**2. 在 `modules` 下写场景块**：

```json
"modules": {
  "default": { "discuss": { … }, "run": { … }, "review": { … }, "image": { … } },
  "code": {
    "review": { "complex": [{ "agent": "gpt-6.1-sol", "effort": "max", "required": true }, { "agent": "gpt-6-astra", "effort": "max" }],
                "seats": { "complex": 2 }, "gap": { "complex": false } }
  },
  "research": {
    "review": { "normal": [{ "agent": "gpt-6.1-sol", "effort": "high", "required": true }, { "agent": "gpt-6-astra", "effort": "high" },
                           { "agent": "deepseek-flash" }, { "agent": "glm-5.3" }],
                "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }, { "agent": "gpt-6.1-sol", "effort": "high" },
                            { "agent": "deepseek-flash" }, { "agent": "glm-5.3" }],
                "seats": { "normal": 3, "complex": 4 }, "gap": { "normal": true, "complex": true } }
  }
}
```

- 场景块只写要改的部分，其余沿用 `default`：写了的格子整格替换，`seats`、`gap` 按等级覆盖。上例的 `code` 只改了审查 complex，它的讨论、执行和图像都和 `default` 一样；`research` 改了审查 normal 和 complex（一般的研究证据审查是 2 级，用于高风险决定的是 3 级，见 SKILL.md 的审查定级）。
- 每个场景合并后都按同样的规则整体校验（能力、必选数不超过席位数、执行和图像一格最多一个必选等），报错会写明是哪个场景。
- 不同场景可以有不同的必选方。场景由 Claude Code 按偏好里的路由选，脚本没法核实选得对不对，所以选的场景少了 `default` 同一格的某个必选时，`plan` 的输出会提示一句。
- 场景能改所有四个模块；`dispatch` 里的设置不按场景分。

**3. 派活时选场景**：
- 要用的这一格只要在任何一个场景里和 `default` 不同（格子本身，或者这一级的 `seats`、`gap`），就算"按场景配了"。按场景配了的格子，建计划（`plan`）和直接派执行（`run --level`）时要写 `--scene <场景>` 和 `--scene-why "<依据偏好里的哪一条>"`；偏好没写到的情况写 `--scene default`。没按场景配的格子不用写；写了也照收，只记进记录（`plan` 的 `notes` 会说明），用的是 `default` 的配置，`stats --by scene` 会按写的场景算。只在不生效的场景（见上）里不同的格子，不算按场景配了。
- 计划里的席位启动时，用计划记下的场景；续接（`resume`）沿用原任务的场景。这两种情况都不能再写 `--scene` 或 `--scene-why`。
- 选了场景以后，在这个场景的格子里怎么挑人、几席、补漏，都和没有场景时一样（见 `references/seats.md`）。

**对不上时**：
- 偏好里定义了、`modules` 里没写的场景，等于 `default`，提示一句。
- `modules` 里有偏好没定义的场景（场景定义来自项目偏好、这个场景块又只写在用户配置里时不算，见上），或者场景块写错了而 `modules` 里还有别的场景：`config` 和 `check` 报出来，提示里写明场景块在哪个文件；派活、建计划、续接都会被拒绝，要先修好。`status`、看板和 Claude Code 席的 `submit` 照常能用。
- 实际生效的场景看 `config` 输出的 `scenes`：`names`（场景名）、`source`（`user` 或 `project`）、`file`、`inactive`（在这个项目里不生效的场景）、`problems`（对不上的地方）。每个场景和 `default` 不同的格子看 `resolved_scenes`。

## 项目配置：覆盖全局
某个项目要换一套候选、多用或少用几家、改时长时，在项目里写 `<项目目录>/.claude/foreman.json`，形状和用户配置一样：

```json
{
  "dispatch": { "timeout_min": 600 },
  "modules": {
    "default": {
      "review": { "normal": [{ "agent": "a" }, { "agent": "b" }], "seats": { "normal": 3 }, "gap": { "complex": true } },
      "run": { "normal": "claude code" }
    },
    "code": { "review": { "complex": [{ "agent": "a", "effort": "max", "required": true }] } }
  }
}
```

- 只能写 `modules`（任意场景），以及 `dispatch` 的 `discuss_max_rounds`、`timeout_min`、`stall_min`、`busy_ask_min`。`agents`、`auto`、`confirm`、`watch`、`intro`、`runs_dir` 作用于整台机器或整个会话（`confirm` 还关系到确认能不能跳过），写在项目配置里会提示并忽略（`summary.warnings` 里有一条 `project_ignored_keys`）。协作方只能引用用户配置 `agents` 里定义过的代号。
- 合并方式和用户配置覆盖默认值一样：写了的格子整格替换（要在用户配置的候选上加几个，就把原来那几个也写上），没写的格子沿用用户配置；`seats`、`gap` 按等级覆盖。可以加候选、改必选、调高席位、打开补漏、换推理强度、延长时长。
- 有场景时按层叠：先算用户配置里这个场景的结果（用户的 `default` 加用户的场景块），再用项目配置里这个场景的结果（项目的 `default` 加项目的场景块）覆盖。所以项目的 `default` 也会盖过用户配置的场景块。
- 合并后整体校验，写错时报错会指出是项目配置文件；席位数、补漏的报错里，值来自项目配置时也会写明。项目配置还是平铺写法时，按 `default` 读，并提示改成新写法（`summary.warnings` 里有一条 `project_modules_flat`）。
- 只认项目目录本身的 `.claude/foreman.json`：`--cwd` 是哪个目录就读哪个目录下的。这个文件不存在、而改名前的旧文件名 `.claude/codex-bridge.json` 存在时，照常读旧文件，并提示改名。
- `config --cwd` 输出的 `project_config` 是 `{ "path": "<文件路径>", "cells": [<覆盖了哪些场景的哪些格子和时长>] }`，没有项目配置时为 `null`；`check` 的总配置里也会列出来。

## 模型特长文档（models.md）
用户写的各模型擅长和短处，和用户配置在同一个目录：`~/.claude/foreman/models.md`（设了 `FOREMAN_CONFIG` 时跟着它换目录）。它不是配置，脚本不解析里面的判断，只由 Claude 读：挑人（`references/seats.md` 第 4、6 条，`references/roles.md`），写任务说明时提醒短处（`references/run.md`），验收时对照短处（`references/acceptance.md`），权衡审查和讨论意见（`references/review.md`、`references/discuss.md`）。和档位冲突时以它为准（`references/model-tiers.md`）。
- **写法**：标题写模型名，下面怎么写都行。一个模型不管经哪种 CLI 或 API 调用，都用同一节。
  - **模糊匹配**：拿标题和这个模型的每一种写法比：身份 ID、`scripts/models.json` 里登记的别名、配置里写的模型名，任意一种对得上就算。比较前两边按同样的规则归一（大小写、服务商前缀、Claude 的小数版本号写成连字符都不影响），再切成段：在 `-`、`_` 处，以及字母和数字的交界处切开，连续的纯数字段算一个版本号（`claude-opus-4-5` 的版本是 4.5）。标题写出的每一段都按顺序出现在模型名里，这一节就对得上这个模型，没写的段可以省略。词要完全相同，版本号按整段前缀比：`claude-opus` 对得上 claude-opus-5-5 和 claude-opus-4-8，`claude-opus-5` 对得上 5.5、对不上 4.5，`deepseek-flash` 对得上 deepseek-v4.1-flash，`glm-flash` 对不上 glm-5.3-flashx。也可以写展示名，比如 `Claude Opus 5.5`。
  - **一节写几个模型**：用中英文逗号或顿号隔开，比如 `## claude-opus, claude-fable`。括号里的内容是备注（里面的逗号也不算分隔），不参与匹配。
  - **几节都对得上一个模型**：都读；说法冲突时以更具体的那一节为准。和模型名完全一样的最具体，其余写出的段越多越具体。
  - **默认版本**：每个在用的模型一节，标题是确切的模型 ID，下面一行 LiveBench 的档位和长短处，再加"擅长""短处"两行。GPT 的 Astra 和 Sol、Gemini 4、Claude Opus 这几个系列，这两行带上插件自带的判断（按和标题一样的模糊匹配对上，行末标"（插件默认，2026-11，可改）"）；其他模型的两行空着。标题可以自己改宽，几节也可以合并。
- **生成**：`model-notes --write [--host-model <模型 ID>]`，`/foreman:setup` 会运行它。文件不存在就新建；已存在只在末尾给哪一节都对不上的模型补一节，写过的内容一个字节都不改。"在用的模型"是用户配置各格（各场景）引用到的协作方的模型，再加上 `--host-model`。主持方的模型是 Claude 系列时，它那一节的擅长行还带上插件以前固定的分工：界面视觉定稿、给人读的文字（Opus 接在它的系列判断后面）。不带 `--write` 时只报告状态，不写文件。
- **状态**：`config` 输出的 `model_notes` 是 `{ "file", "exists", "missing", "unwritten" }`。`missing` 是在用、但哪一节都对不上的模型；`unwritten` 是有节对得上、但这些节除了默认的几行（LiveBench 那一行、空着的擅长和短处、原样没改的插件默认判断）什么都还没写的模型。文件不存在时 `summary.warnings` 里有一条 `models_doc_missing`。
- **注入**：会话开始的提醒钩子把整份文件接在偏好文件后面注入，长度上限和偏好文件一样，超出的部分截掉并提示。
- **补充**：验收或审查时发现某个模型反复出现同一类问题、文档里还没写的，向用户汇报时提议补进 models.md，用户同意再改。
- 只有用户级这一份，项目里不能另写。

## 其他规则
- 每个协作方的并发上限按它自己正在运行的任务算，不分任务组、不分会话；达到上限时派发命令默认按先来后到排队：在记录目录的 `.state/queue/<协作方>/` 下领一张票据，每秒检查一次，排到最前面并且有空名额时启动；stderr 写出排在第几位和最多还等几分钟。`--queue-timeout <分钟>` 改最长等待时间（默认 60，最多 1440），写 0 时不排队、名额满了立即拒绝，报错里列出占着名额的任务。排队的进程被结束时票据随之删掉；被强制结束留下的票据，由下一个检查者按进程是否还在、票据是否过期回收。`status` 列出排队中的票据。派发计划本身不占名额。
- 同组任务的写入范围不能重叠，这条只查会写文件的任务（执行），讨论和审查不查。
- 沙箱不是 `read-only` / `workspace-write` 时（比如 `danger-full-access`），Codex 能写任何目录，`--cwd` 只决定它从哪里开始工作，**不限制写入范围**。这时范围只能靠任务说明约束，再靠事后审查 diff 把关。
- `config` 输出的 JSON 很长（几十 KB，大头是 `summary` 和 `effective`），派活前只需要 skill 列的那几项：`effective.dispatch` 里的 `auto`、`confirm`、`watch`，`scenes` 是场景定义和对不上的地方，`agents_status` 是各协作方的能力和 API key 是否已设置，`model_notes` 是模型特长文档的位置和还没写的模型，`summary.warnings` 是没有价格或档位的在用模型、明文 key 等提醒。要看排好的总配置时用 `config --format md`（几 KB），`summary` 的内容都在里面，开头一段写明 `auto` 和 `confirm` 的当前设置。
- 用户改了配置，改完运行 `config` 确认：
  - `resolved_modules` 列出 `default` 里每一格最终有哪些候选，每个候选的模型、推理强度和是否必选；
  - `resolved_scenes` 按场景列出和 `default` 不同的格子、`seats` 和 `gap`（没有场景时为空对象）；
  - `project_config` 是项目配置的路径和它覆盖了哪些格子（带 `--cwd` 时，没有项目配置为 `null`）；
  - `scenes` 是生效的场景定义和对不上的地方（见"场景"）；
  - `image_configured` 说明用户配置里写没写图像块：为 `false` 时图像两格显示的 `null` 是默认值，不是用户关掉的；
  - `agents_status` 列出每个协作方的类型、能力、key 是否已设置、实际用的可执行文件；
  - `summary` 是总配置情况：每一格交给谁，每个协作方用在哪几格，以及提醒（没用到的协作方、明文 key、shell 权限用于执行或手画、`agent-aliases.json` 里指向已不存在代号的旧代号）。`check` 的输出里也有，并带上检查结果。

## 脚本输出配置提示时怎么转告
- 脚本输出"首次使用，已生成配置文件"时，转告用户检测到了什么（Codex、opencode、pi、API key）、现在各类任务交给谁，并建议运行 `/foreman:setup` 选择要用的模型。
- 脚本输出"已在配置文件 … 里写明审查每一级要不要补漏席"时，告诉用户：补漏席现在可以按等级开关，已经按原来的做法写进配置（只有 3 级审查做补漏轮），想关掉或在别的等级打开就改 `review.gap`；原文件备份在哪里。
- 脚本输出"用户配置里的 projects 已经不用了"时，告诉用户哪几项不再生效，建议运行 `/foreman:setup` 把它们搬到各项目的 `.claude/foreman.json`。
- 脚本输出"已把配置文件 … 的 modules 改成按场景写"时，告诉用户：配置换成了按场景的写法，原来的内容原样放进了 `modules.default`，用起来和以前一样；想按场景配时在 `modules` 下加场景块（见"场景"）；原文件备份在哪里。
- 脚本输出"偏好里定义的场景 … 在 modules 里没有场景块"时，告诉用户这些场景现在和 `default` 一样，想让它们不同就按"场景"一节在 `modules` 下加场景块。`config` 的 `scenes.problems` 不为空时，把每一条转告用户：修好之前派活、建计划和续接都会被拒绝。脚本输出"这个项目的偏好 … 没有定义场景 …"时，告诉用户这些场景在这个项目里不生效，是项目偏好的场景块决定的；想在这个项目里也用，就在项目偏好的场景块里加上。
- `summary.warnings` 里有 `models_doc_missing` 时，告诉用户：还没有模型特长文档，界面视觉和给人读的文字现在按 run 的格子和这份文档决定由谁做，不再固定由 Claude 做；建议运行 `/foreman:setup` 生成默认版本，并决定要不要把 `claude code` 加进 run 的格子。
- `summary.warnings` 里有 `project_modules_flat` 时，告诉用户这份项目配置还是旧的平铺写法，建议改成 `{ "modules": { "default": { … } } }`；从 1.2 及更早的版本升级来的，提醒用户核对里面的放宽项（加候选、调高席位、延长时长），它们现在会生效。有 `project_ignored_keys` 时，告诉用户这几个键只能写在用户配置里，在项目配置里不生效。
- 脚本输出"已把配置文件 … 改成新写法"时，告诉用户：配置换成了新写法（`type` 改为 `codex cli` / `opencode cli` / `api`，`"claude"` 改为 `"claude code"`），协作方代号改成了模型名（转告脚本列出的对照），实际用的模型和推理强度都没变，原文件备份在哪里。
- 脚本输出"已把配置文件 … 里的 levels 改写成 modules"时，告诉用户：配置换成了 `modules` 写法，每一格的协作方、推理强度和顺序都没变；有一处行为变化，以前讨论一级里的协作方全员参加，现在是候选、由 Claude 挑，想保留全员参加就给它们标 `"required": true`；配置里还没有图像两格；文件里的 `levels` 留成了一行说明，旧版插件读到会报错，不会悄悄改成全由 Claude 做；原文件备份在哪里。建议运行 `/foreman:setup` 标必选、加图像两格。改配置时保留 `levels` 那行说明。
- **Windows 上 Codex 的只读沙箱**：默认的 elevated 沙箱在 `read-only` 模式下可能连读文件的命令都启动不了。给讨论和审查设 `read-only` 之前先运行 `check`：起不来时按它的 `fix` 在 `~/.codex/config.toml` 的 `[windows]` 里改用 `sandbox = "unelevated"`。没设只读沙箱时（`readonly` 为 `audited`），只读靠规则约束和事后对比快照，发现写入就记为失败，见 `references/review.md` 的"只读"。
- 用户要改配置时，直接编辑对应的 JSON 文件，改完运行 `config` 确认生效。
