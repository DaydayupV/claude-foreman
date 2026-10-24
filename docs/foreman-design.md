# foreman 设计文档

把 codex-bridge 升级成通用的 foreman：Claude 负责规划、决策和验收，执行、审查、讨论按配置交给不同的 CLI 工具或模型。本文定下名字、配置、内部结构、迁移、测试和分期；确认后按"分期"一节逐步派给 Codex 实现，Claude 验收并写文档。

## 1. 目标与范围

**要做到**
- CLI 工具（现在是 Codex CLI 和 Opencode CLI）的执行、审查、讨论都能在配置里随意安排；API 模型只参加讨论。
- 同一种工具可以配多个协作方，各用不同模型；Codex 不再是必需的。
- 每种任务的每一级都可以写 `"claude code"`，表示由 Claude 自己做，或者不找外部协作方。
- 不论本机只有 Codex、只有 opencode、两者都有、只有 API key 还是什么都没有，初始配置和 `/foreman:setup` 都能引导到可用状态。
- 内部拆成"公共运行器 + 每种工具一个适配器"，以后接新 CLI 基本只加一个适配器文件。
- 项目改名为 foreman，旧配置、旧记录自动迁移。

**这次不做**
- 不接 pi、Gemini CLI 等其他工具（结构上留好位置）。
- API 模型不做执行和审查。
- 不做动态插件机制：适配器写在代码里，静态注册。
- 不做额度自动调度（额度不够时自动换模型或换工具）。

**不变的分工原则**
- 规划、核心决策、创意设计和给人读的文字只由 Claude 做，对所有外部协作方都一样。
- 生成或编辑位图只交给有出图能力的协作方（目前只有 Codex CLI）。
- 各工具和模型的特点描述写在 SKILL.md 里，不进配置文件，也不进偏好文件。

## 2. 改名

### 2.1 原则
- 对外标识（仓库、插件、命令、配置路径、环境变量、终端前缀）用项目名 foreman。
- 内部文件按功能命名，以后项目再改名也不用动。
- 改名和通用化放在同一个版本发布，用户只迁移一次。

### 2.2 对照表

| 类别 | 现在 | 改成 |
|---|---|---|
| GitHub 仓库 | `DaydayupV/claude-codex-bridge` | `DaydayupV/claude-foreman`（GitHub 改名后旧地址自动跳转） |
| marketplace 名 | `claude-codex-bridge` | `claude-foreman` |
| 插件 | `codex-bridge` / `codex-bridge-en` | `foreman` / `foreman-en` |
| 插件目录 | `codex-bridge/`、`codex-bridge-en/` | `foreman/`、`foreman-en/` |
| 执行命令 | `/codex-bridge:rescue` | `/foreman:run`（rescue 沿用自 OpenAI 官方插件，意思不直白） |
| 其他命令 | `discuss` `review` `status` `watch` `config` `setup` | 不变，前缀换成 `/foreman:` |
| skill | `dispatch` | 不变 |
| 主脚本 | `skills/dispatch/scripts/bridge.mjs`（约 2700 行） | 拆成模块，见第 4.4 节；入口 `cli.mjs` |
| API 请求 | `api-chat.mjs` | 并入 `adapters/api.mjs` |
| 拦截钩子 | `hooks/guard-codex.mjs` | `hooks/guard-direct-calls.mjs`（拦所有支持的 CLI） |
| 会话提醒钩子 | `hooks/session-reminder.mjs` | 不变 |
| 用户配置 | `~/.claude/codex-bridge.json` | `~/.claude/foreman/config.json` |
| 用户偏好 | `~/.claude/codex-bridge.md` | `~/.claude/foreman/preferences.md` |
| 运行记录 | `~/.claude/codex-runs/` | `~/.claude/foreman/runs/` |
| 项目配置 | `<项目>/.claude/codex-bridge.json` | `<项目>/.claude/foreman.json` |
| 项目偏好 | `<项目>/.claude/codex-bridge.md` | `<项目>/.claude/foreman.md` |
| 环境变量 | `CODEX_BRIDGE_CONFIG`、`CODEX_RUNS_DIR`、`CODEX_BRIDGE_LANG` | `FOREMAN_CONFIG`、`FOREMAN_RUNS_DIR`、`FOREMAN_LANG`；`CODEX_BIN` 保留（本来就只管 Codex） |
| 终端提示前缀 | `bridge:` | `foreman:` |
| 结果字段 | `changes.codex_total`、文件的 `by: "codex"` | `changes.agent_total`、`by: "agent"`（旧记录读取时转换） |
| 注入 opencode 的代理名 | `codex-bridge-discuss` | `foreman-discuss`，另加 `foreman-run`、`foreman-repair` |
| 打包产物 | `dist/codex-bridge.zip` 等 | `dist/foreman.zip`、`dist/foreman-en.zip` 等 |
| 同步工具 | `tools/sync-shared.mjs` 的共用清单 | 改成新目录和新文件名；共用范围扩到 `scripts/` 整个目录和 `hooks/*.mjs` |
| 版本号 | 0.10.6 | 1.0.0 |

### 2.3 第 0 步：纯改名
- 按对照表做机械改名：目录、文件、插件和 marketplace 清单、命令文件、钩子配置、脚本里的路径和常量、提示文字、README 和 SKILL.md 里的名字。
- 同时加上迁移逻辑（见第 7 节）：旧配置、旧偏好、旧记录目录、旧环境变量。
- **不改任何行为**：配置结构、`type` 写法、执行逻辑都留到后面的步骤。这一步还是单文件 `bridge.mjs`，只是改了名字和路径常量；拆模块放在第 1 步。
- 等级：simple（做法完全确定，结果可以逐项核对）。
- 验收：
  - 用一份用户真实配置的副本，确认自动迁移到 `~/.claude/foreman/config.json`，内容不变，旧文件保留。
  - 旧记录目录搬到新位置后，`status`、`watch` 能看到历史任务。
  - `run`、`discuss`（Codex 加 opencode 加 API）、`review`、`resume`、`cancel`、`check`、`config` 各跑一次。
  - 新旧环境变量都生效，用旧的时有提示。
  - `node tools/sync-shared.mjs --check` 通过，代码里搜不到残留的 `codex-bridge`、`codex-runs`、`bridge:`（迁移代码和历史说明除外）。

## 3. 配置结构

### 3.1 示例

```json
{
  "dispatch": {
    "auto": true,
    "watch": "auto",
    "discuss_max_rounds": 2,
    "timeout_min": 240,
    "stall_min": 20,
    "busy_ask_min": 2,
    "runs_dir": null
  },
  "agents": {
    "gpt-6.1-sol":        { "type": "codex cli", "model": "gpt-6.1-sol" },
    "gpt-6-astra":        { "type": "codex cli", "model": "gpt-6-astra" },
    "glm-5.3":            { "type": "opencode cli", "model": "opencode-go/glm-5.3", "run_access": "shell" },
    "kimi-k3":            { "type": "opencode cli", "model": "opencode-go/kimi-k3" },
    "deepseek-flash-4.1": { "type": "api", "base_url": "https://api.deepseek.com", "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-flash" }
  },
  "levels": {
    "run": {
      "simple":  "claude code",
      "normal":  { "agent": "glm-5.3" },
      "complex": { "agent": "gpt-6-astra", "effort": "max" }
    },
    "review": {
      "simple":  { "agent": "glm-5.3" },
      "normal":  { "agent": "kimi-k3" },
      "complex": { "agent": "gpt-6-astra", "effort": "max" }
    },
    "discuss": {
      "simple":  "claude code",
      "normal":  [{ "agent": "gpt-6.1-sol", "effort": "high" }, { "agent": "kimi-k3" }],
      "complex": [{ "agent": "gpt-6-astra", "effort": "max" }, { "agent": "kimi-k3" }, { "agent": "deepseek-flash-4.1", "effort": "max" }]
    }
  }
}
```

### 3.2 agents

键是协作方的**代号**，`levels` 和 `--agent` 用它引用。建议按模型起名。

- 代号规则：字母、数字、`.`、`-`、`_`，以字母或数字开头；不能叫 `claude` 或 `claude code`。（现在不允许 `.`，要放开。）
- `type` 只有三种：

| type | 说明 | 能做的任务 |
|---|---|---|
| `codex cli` | 本机的 Codex CLI | 执行、审查、讨论、出图 |
| `opencode cli` | 本机的 Opencode CLI | 执行（要显式开启）、审查、讨论 |
| `api` | 兼容 OpenAI 格式的模型接口 | 讨论 |

- 各类型的字段：

| 字段 | codex cli | opencode cli | api |
|---|---|---|---|
| `model` | 可选，不写就用 `~/.codex/config.toml` 里的 | 必填，写全 `提供方/模型`，和 `opencode models` 列出的一样 | 必填 |
| `bin` | 可选（也可用 `CODEX_BIN`） | 可选 | — |
| `max_parallel` | 可选，默认 4 | 可选，默认 4 | 可选，默认 4 |
| `sandbox` | 可选，`run` / `review` / `discuss` 各自的 Codex 沙箱 | — | — |
| `approval` | 可选，Codex 审批策略 | — | — |
| `run_access` | — | `"edit"` 或 `"shell"`；不写就不能出现在 `levels.run` | — |
| `base_url`、`api_key`、`api_key_env`、`extra_body` | — | — | 同现在 |

- `run_access` 的两档：
  - `"edit"`：只能读和改项目目录里的文件，不能运行命令；测试由 Claude 事后跑。
  - `"shell"`：还能运行命令。opencode 没有系统级沙箱，命令以你的账户权限运行，能访问整台机器。
- 以后要接其他 API 格式时，给 `api` 加一个 `format` 字段，不另起类型。

### 3.3 levels

- 三种任务 `run` / `review` / `discuss`，各三级 `simple` / `normal` / `complex`。
- 每一级可以写：
  - `"claude code"`：执行由 Claude 自己做；审查和讨论表示不找外部协作方。
  - 一个参与方 `{ "agent": "<代号>", "effort": "<强度>" }`（执行、审查）。
  - 参与方数组（讨论），同一代号只能出现一次。
- `effort` 可以不写，不写就用工具或模型的默认值。各类型的写法：
  - `codex cli`：`low` `medium` `high` `xhigh` `max` `ultra`。
  - `opencode cli`：模型的 variant，原样拼成 `-m 模型#variant`。
  - `api`：原样作为 `reasoning_effort` 发出。
- 等级里的 `model` 覆盖：旧配置照常能用，但不再推荐，setup 也不生成。想换模型就新加一个协作方，避免代号和实际模型对不上。
- 校验按能力表判断（见第 4.2 节）：放在 `run` 的协作方必须能执行，opencode 还要有 `run_access`；放在 `review` 的必须能审查；`api` 只能出现在 `discuss`。

### 3.4 项目配置：只能收紧，不能放宽
- 项目配置只认 `dispatch.timeout_min`、`dispatch.stall_min`、`dispatch.busy_ask_min` 和 `levels`。
- `levels` 里每一级只能：
  - 改成 `"claude code"`；
  - 从用户配置里**这一级已有的**参与方中保留一部分。
- 不能换成别的协作方，不能改协作方的字段。违反的项丢弃，并打印提示。
- 理由：克隆来的仓库不能借项目配置把执行从有沙箱的 Codex 换成没沙箱的工具，也不能把代码发给新的厂商。
- 和现在相比：现在项目配置还能改 `agents.codex.model`。新结构里模型跟着代号走，这一项取消。

## 4. 内部结构

### 4.1 分工
- **公共运行器**：参数和配置、能力校验、记录目录和 meta、并发准入、总超时、取消标记、卡死检测、改动追踪（影子 git 快照）、报告解析和一次修复、用量汇总、result.json、watch 和 status。
- **适配器**（每种 `type` 一个）：找可执行文件、拼参数和环境变量、权限设置、提示词怎么传、原始事件翻译、会话 id 和续接、最终回答、用量和费用、额度用完的识别、特殊产物（比如 Codex 的图片）、`check` 的检查项。
- 运行器只认能力和统一事件，不判断 `type` 的名字。

### 4.2 能力表
每个适配器声明一张能力表，`config` 输出里列出来，SKILL.md 按能力描述，不再到处写"Codex"。

| 能力 | codex cli | opencode cli | pi cli | api |
|---|---|---|---|---|
| `modes` | run、review、discuss | run、review、discuss | run、review、discuss | discuss |
| `isolation`（执行时的隔离） | `os`：Codex 系统沙箱（看 sandbox 配置） | `tools`：只有工具权限，没有系统沙箱 | `tools`：工具白名单加 foreman 的守卫扩展，没有系统沙箱 | — |
| `reads_code`（能自己读代码） | 是 | 是 | 是 | 否，靠附带文件 |
| `native_schema`（原生 JSON schema 约束） | 是 | 否，提示词加一次修复 | 否，提示词加一次修复 | 否，提示词加一次修复 |
| `native_review`（原生审查命令） | 是 | 否 | 否 | — |
| `images`（出图） | 是 | 否 | 否 | 否 |
| `resume`（续接同一会话） | 是 | 是 | 是 | 是（本地保存的对话） |
| `command_start_events`（能看到命令开始） | 是 | 否，只有工具完成事件 | 是，工具开始和结束都有事件 | — |
| `usage` | 会话记录，有额度 | 会话导出，有费用 | 每条回复自带用量和费用 | 流式返回 |

### 4.3 统一事件
- 内部事件沿用现在的格式（Codex 的事件形状：`thread.started`、`item.started` / `item.completed`，item 类型有 `agent_message`、`reasoning`、`command_execution`、`file_change` 等），写进 `events.jsonl`。watch 和 status 不用为每种工具各写一套。
- 新增两个可选字段：`item.tool`（工具原名，比如 `read`、`grep`、`shell`）和 `item.category`（`read` / `search` / `edit` / `shell`）。时间线据此把读文件和跑命令分开显示，`commands_executed` 只数真正的命令。
- 工具的原始输出另存 `raw.jsonl`（现在 opencode 叫 `opencode.jsonl`），出问题时对照。
- opencode 的写文件、改文件工具翻译成 `file_change`，路径取自工具参数，作为改动归属的证据。

### 4.4 文件拆分
`skills/dispatch/scripts/` 下：

| 文件 | 内容 |
|---|---|
| `cli.mjs` | 入口：解析子命令，调用各模块 |
| `config.mjs` | 默认值、读取合并、迁移、校验、项目配置限制、初始配置生成 |
| `runner.mjs` | 运行生命周期：登记、准入、快照、执行、报告、用量、结果 |
| `tracker.mjs` | 影子 git 快照和 diff |
| `review-scope.mjs` | 审查范围的 diff 计算（第 5.2 节） |
| `watch.mjs` | 时间线、组视图、verbose |
| `watch-intro.mjs`、`watch-avatars.mjs` | watch 的启动动画：按模型名认头像、排版和动画；头像数据由 `tools/make-avatars.mjs` 从 `tools/avatars/source.webp` 生成 |
| `status.mjs` | status、await-busy、cancel |
| `adapters/codex-cli.mjs`、`adapters/opencode-cli.mjs`、`adapters/api.mjs` | 各工具适配器 |
| `adapters/index.mjs` | 静态注册表：`type` → 适配器 |
| `messages.mjs` | 中英文文字（不变，可以按模块分节） |

### 4.5 适配器接口（草案）

```js
export default {
  type: 'opencode cli',
  capabilities: { modes: ['run', 'review', 'discuss'], isolation: 'tools', readsCode: true, nativeSchema: false,
    nativeReview: false, images: false, resume: true, commandStartEvents: false },
  validate(agent, check) {},                 // 本类型的字段校验
  locate(agent) {},                          // → { file, pre }
  async check(name, agent) {},               // → check 输出里这一项
  prepare({ mode, model, effort, access, cwd, prompt, sessionId, runDir, schema }) {},
                                             // → { args, env, stdin }；API 适配器另有 request()
  decode(line, state) {},                    // 原始一行 → 统一事件数组；顺带记下 session、最终回答、错误
  async usage({ sessionId, startedAt }) {},  // → { usage, cost_usd, rate_limit, quota_resets_at }
  quotaExhausted(state) {},                  // → 是否额度用完
};
```

## 5. 各种任务在各工具上的做法

### 5.1 执行（run）
- **Codex**：和现在一样（原生 schema、沙箱、图片）。
- **opencode**：
  - 注入 `foreman-run` 代理。权限默认全部拒绝，只开：read、grep、glob、list、edit、write；`run_access` 为 `shell` 时再开 shell。`external_directory` 拒绝，question、子代理、联网工具都拒绝。
  - 报告靠提示词附 schema，解析失败修复一次（见 6.3）。
  - 归属：写文件、改文件的工具事件。
  - 卡死检测见 6.4。
- 启动行、`config` 输出和结果里都写明隔离方式，例如"Opencode CLI，工具权限，无系统沙箱"。

### 5.2 审查（review）
- **Codex**：没有审查重点时照旧用原生 `codex exec review`；有审查重点时照旧走普通 exec。
- **opencode**：
  - 审查材料由运行器算好，写进记录目录的 `review.patch`，同时直接附进提示词。
  - 用只读代理 `foreman-discuss`（只能读和搜索），不开 shell，模型不需要自己跑 git。
  - 范围的定义：
    - `--uncommitted`：暂存、未暂存的改动，加上未跟踪的新文件。
    - `--base <分支>`：先解析成 merge-base，再和它比；含不含工作区里的改动，按 Codex 原生审查的实测行为对齐（见第 10 节）。
    - `--commit <sha>`：这次提交相对父提交；根提交和父提交，合并提交和第一个父提交比。
  - 记录文件清单、内容指纹、跳过的二进制文件。
  - 材料超过上限（暂定 20 万字符）时**直接报错**，提示缩小范围（按目录或按提交）或改用 Codex，不静默截断。
- 输出格式统一成现在带审查重点时的写法：文件:行号、问题、触发场景、修复建议，按严重程度排序。不另加 schema。

### 5.3 讨论（discuss）
三种类型都和现在一样，只是走公共运行器。

### 5.4 生成图片
SKILL.md 改成"交给有出图能力的协作方"。配置里没有 `codex cli` 时，Claude 直接告诉你这次做不了，不改用其他方式凑。

## 6. 安全规则

### 6.1 执行要显式开启
- opencode 协作方没写 `run_access`，就不能放进 `levels.run`，用 `--agent` 点名派执行也会被拒。
- setup 开启时要讲清楚两档的区别，`shell` 档要你明确确认"没有系统沙箱"。

### 6.2 项目配置只能收紧
见 3.4。

### 6.3 修复时不给工具
- 执行任务的报告格式不对时，用 `foreman-repair` 代理续接同一会话：所有工具全部拒绝，只让它把上一条回答改成合法 JSON。
- 修复最多一次，失败就保留原文并给出警告，不会因为报告不合格重跑任务。
- 讨论和审查本来就只读，沿用只读代理。

### 6.4 卡死检测按能力区分
- 能看到命令开始的工具（Codex）：照旧，有命令在跑就不算卡死。
- 看不到命令开始的工具（opencode）：
  - `run_access` 为 `shell` 的执行任务，不做卡死检测，只靠总超时（`timeout_min`）。
  - 其他情况照旧。
  - status 和 watch 改为显示"进程还在、最后一次事件在 X 分钟前"。

### 6.5 改动追踪是硬前提
- 交给 `isolation: tools` 的工具执行时，快照拍不成功就不开始，也不允许 `--no-snapshot`。
- 归属证据分三种，记在结果里：快照里的变化、工具事件、模型自报。自报只算声明。
- 追踪的盲区写进结果和文档：工作目录以外、被排除的目录（node_modules 等）、超过 5 MB 只比较大小和时间的文件。

### 6.6 拦截直接调用
- `guard-direct-calls.mjs` 拦截 `codex exec`、`codex review`、`opencode run` 和直接用 pi 跑任务（pi 只放行 `--version`、`--help`、`--list-models`、`--export` 和管理类子命令），以及以后接入的工具。
- 只读命令照常放行：`opencode models`、`--version`、`session export`、`auth list` 等。
- 这是调度约束，不是安全边界。

### 6.7 pi 的边界
- pi 本身没有权限系统，也没有系统沙箱。每次调用都用 `--tools` 只开放这次任务需要的工具，并用 `-e` 注入 `adapters/pi-guard.mjs`：不在白名单里的工具一律拒绝，文件工具的路径不能出项目目录；`shell` 档的命令不受它限制。
- 关掉用户自己的扩展、skill、提示模板、MCP 和项目里的 `.pi` 设置（`--no-extensions` 等加 `--no-approve`），项目的 AGENTS.md / CLAUDE.md 照常读；会话放在 pi 的默认位置。
- pi 遇到模型不支持的推理强度不报错，会悄悄换一档，所以 `check` 只按 RPC 读到的模型清单核对；运行时实际档位和配置不同会在 notes 里提示。
- JSON 模式下回复出错时 pi 照样以 0 退出，按最后一条回复的结束原因判断成败（自动重试成功的不算失败）。
- 能看到工具开始事件，`shell` 档也做卡死检测：有工具在运行时不算卡住。

### 6.8 opencode 版本
- `check` 报告 opencode 版本。
- 不在已验证范围内（目前是 2.0.x）时给出提示，但不拦截。
- 注入的代理找不到时（比如以后配置写法变了），opencode 会报 Agent not found，任务直接失败，不会放宽权限。

### 6.9 协作方要人回答（已实现，提交见 git log）
- 防止卡住：
  - Codex 没配置 `approval` 时默认 `never`；
  - opencode 注入的代理一律"全部拒绝 + 白名单"，不开放 `question` 工具和需要确认的权限。第 4 步的 `foreman-run` 代理同样要遵守。
  - 提示词里写明运行中没人回答。
- 收集：结果里的 `questions`（六种 source）和 `needs_decision`。
- 看门狗：CLI 打出 `(y/n)` 之类的终端提示后 3 分钟没动静，就结束进程树，状态记 `needs_input`。以后接入的 CLI 自动享有。
- 决定：由 Claude 按 SKILL.md"协作方要人回答时"一节判断，能决定的直接续接，业务取舍等才问用户。

## 7. 初始配置和 setup 引导

### 7.1 第一次运行时自动检测
用户配置不存在时，任何子命令第一次运行都会先检测本机环境（不发模型请求，只看安装和登录）：
- Codex CLI：能否启动、`codex login status` 是否已登录。
- Opencode CLI：能否启动、`opencode models` 列出了哪些模型（据此判断登录了哪些提供方，比如 `opencode-go/*`）。
- API key：常见环境变量有没有设置（`DEEPSEEK_API_KEY`、`KIMI_API_KEY` / `MOONSHOT_API_KEY`、`MIMO_API_KEY` 等，名单和各家的接口地址、默认模型一起写在代码里）。

### 7.2 按环境生成初始配置
初始配置**只自动安排 Codex**。Codex 用的是订阅额度，现在的默认安排也已经验证过。opencode 和 API 只写进 `agents`，不放进等级。原因：

- opencode 要选哪个模型、开不开执行，涉及花钱和安全，要你来定；
- API 按量计费，也不应自动启用。

| 检测到 | agents | levels |
|---|---|---|
| 只有 Codex | Codex 两个协作方（默认模型、复杂级模型） | 同现在：执行 simple、normal 由 Claude 做，complex 给 Codex；审查和讨论给 Codex |
| Codex 和 opencode | 同上，另列出 opencode（不放进等级） | 同"只有 Codex" |
| 只有 opencode | 不写 | 全部 `"claude code"`，提示运行 `/foreman:setup` 选模型 |
| 只有 API key | 检测到 key 的厂商各一个（`api_key_env` 指向那个变量） | 全部 `"claude code"`，提示运行 setup |
| 什么都没有 | 不写 | 全部 `"claude code"`，提示运行 setup，setup 告诉你怎么安装 |

- 生成后打印一句：检测到了什么、现在每类任务交给谁、下一步运行 `/foreman:setup`。
- 会话开始的提醒：配置里没有任何外部协作方时，只提醒一次"运行 /foreman:setup"，不提醒派活。

### 7.3 setup 的引导流程
`/foreman:setup` 由 Claude 按步骤和你对话。推荐一次给全，最后你来定：
1. **检查环境**：`check` 和 `config` 列出本机有什么、每个工具和模型能不能用，不能用的给出处理办法。
2. **读模型清单**：`models` 列出 Codex（`codex debug models`）和 opencode（`opencode api GET /api/model`）自带的模型清单，含每个模型支持的推理强度，以及每个 API 协作方的接口列出的模型名；配置里的模型不在清单里时给出最接近的写法。
3. **新加 API 模型时查文档**：API 的模型清单没有推理强度，只在新加 API 模型时查厂商的官方文档，已经在用的不再查。
4. **一次给出完整推荐**：九格等级表（现在 → 推荐，附理由和推理强度的来源）、协作方的增删改、失效旧代号怎么改。已有的安排默认不变，推理强度只从清单支持的档位里选；opencode 做执行不默认推荐，要的话讲清楚 `edit` 和 `shell` 两档，`shell` 档要你明确确认"没有系统沙箱"。
5. **你逐项调整**：按推荐改、逐项调整或先不改。
6. **写配置**：先备份，代号按模型起；改完运行 `config` 校验，再运行 `check`。
7. **总配置情况**：用 `check` 输出的 `summary` 给出等级表、协作方表和提醒（没用到的协作方、明文 key、shell 权限、失效的旧代号）。`check` 平时跑完也给出这张总表。
8. **以后装了新工具或想换模型**：重跑 setup。它只推荐改有理由改的部分，你已经改过的设置不动。

## 8. 迁移

### 8.1 配置
迁移分两次：第 0 步只搬位置，第 2 步才转换结构。

- **第 0 步：搬位置。**
  - 新插件第一次运行时，如果 `~/.claude/foreman/config.json` 不存在而 `~/.claude/codex-bridge.json` 存在，就把旧配置原样复制到新位置。旧文件不删，打印一句说明。
  - 旧偏好 `~/.claude/codex-bridge.md` 复制成 `~/.claude/foreman/preferences.md`。
- **第 2 步：转换结构。** 第一次读到旧结构时改写，原文件留 `.bak` 备份。
  - `type`：`codex` → `codex cli`，`opencode` → `opencode cli`，`openai-compatible` → `api`。
  - 等级里的 `"claude"` → `"claude code"`。
  - 更早的 0.10 以前的旧写法照常先转换一次。
- **第 2 步：代号按模型自动改名**，`levels` 里的引用一起改。规则：
  - 新代号取模型名。opencode 的 `提供方/模型` 取 `/` 后面那段（`opencode-go/glm-5.3` → `glm-5.3`）。模型名里不合法的字符换成 `-`。
  - Codex 协作方没写模型时，用 `~/.codex/config.toml` 里的模型名；那里也没有，就保留原代号。
  - 等级里用 `model` 覆盖了模型的（比如默认模型是 gpt-6.1-sol，复杂审查改用 gpt-6-astra），拆成一个新协作方，代号用覆盖的模型名，其他字段照抄，那一级改为引用它。
  - 同一个模型、配置相同的，合并成一个协作方；同一个模型、配置不同的（比如沙箱不同），第二个起在代号后面加类型后缀，比如 `-opencode`、`-api`，仍然重复再加 `-2`、`-3`。
  - 新旧代号的对照记在内部文件 `~/.claude/foreman/agent-aliases.json`，不写进配置。旧运行记录续接时（记录里的 `agent` 还是旧代号），按对照找到新代号；`--agent` 写旧代号时也照样认，并提示新代号。
  - 改名结果打印出来，例如"codex → gpt-6-astra、deepseek → deepseek-flash"。
- **项目配置 `.claude/codex-bridge.json`：**
  - 第 0 步：新文件 `.claude/foreman.json` 不存在时读旧文件，提示改名，不动项目里的文件。
  - 第 2 步：读的时候在内存里转换结构，代号按上面的对照表换成新名字。

### 8.2 运行记录
- 新插件第一次运行时，如果 `~/.claude/codex-runs` 里没有正在运行的任务，整个目录搬到 `~/.claude/foreman/runs`；有的话本次先不搬，下次再试。
- 用户在配置里自己设过 `runs_dir` 的不搬。
- 旧记录里的 `agent_type`（`codex` / `openai-compatible` / `opencode`）和 `codex_total`、`by: "codex"`，读取时按新名字解释，不改写原文件。
- 没有 `agent_type` 的更早记录按 Codex 处理。

### 8.3 环境变量
新名字优先。旧名字在 1.x 里继续认，用到时提示改名。

### 8.4 插件本身
- Claude Code 不会把旧插件自动升级成改了名的新插件。README 新增"从 codex-bridge 升级"一节：
  1. 卸载 `codex-bridge`；
  2. 添加 `DaydayupV/claude-foreman`；
  3. 安装 `foreman`。
- 新旧插件同时装着时，钩子会重复拦截、重复提醒，所以要先卸载旧的。
- 桌面版"我的上传"里的旧插件要手动删除。

## 9. 测试方案

现在没有自动化测试，第 1 步先补上，以后每一步都要跑。

### 9.1 自动化测试（Node 内置 `node:test`，放在仓库根目录 `tests/`，不进插件包）
- **事件回放**：用真实运行录下的原始输出（Codex、opencode、API 的流式数据各几份，包括失败、取消、修复）做夹具，校验翻译出来的统一事件、最终回答、用量和状态。
- **假 CLI**：用 Node 脚本模拟 codex 和 opencode，按夹具吐事件，可以模拟长时间无输出、非零退出、被取消，用来测运行器的超时、卡死、取消和准入。
- **临时 Git 仓库**：测改动追踪和归属，以及审查范围的三种模式：暂存加未暂存、新文件、删除、重命名、二进制、根提交、合并提交。
- **配置**：新写法校验、旧写法迁移（拿用户真实配置的脱敏副本当样例）、项目配置限制、各种环境的初始配置生成。
- **渲染**：watch 在非 TTY 下的输出，和固定的期望文本比对。
- 入口：`node --test tests/`。

### 9.2 真机冒烟（Windows 原生，每步发布前手工跑）
- Codex：run、review（原生和带重点各一次）、discuss、resume、cancel、出图。
- opencode：discuss、review、run（`edit` 和 `shell` 各一次，含一次测试失败后修好）、cancel、长命令。
- API：discuss（多方并行）、繁忙排队提示。
- watch 的组视图、status、check、setup 的几种环境（用临时配置模拟）。
- macOS 和 Linux 没有实机，只靠自动化测试；文档里写明没有实机验证。

## 10. 分期

每一步单独提交，测试和冒烟都通过才进入下一步；全部完成后统一发布 1.0.0。

| 步 | 内容 | 等级 | 主要验收 |
|---|---|---|---|
| 0 | 纯改名和迁移（第 2.3 节） | simple | 见 2.3 |
| 1 | 先补测试基线，再拆模块（第 4 节），行为不变 | complex | 拆前写好的测试，拆完全部通过；冒烟清单 |
| 2 | 新配置格式、能力表、`"claude code"`、Codex 可选、初始配置和 setup（第 3、7、8.1 节） | complex | 各种环境的初始配置；旧配置迁移；校验和项目配置限制的测试 |
| 3 | 通用审查：opencode 审查、审查范围计算（第 5.2 节） | complex | 临时仓库的范围测试；和 Codex 原生审查的范围对照 |
| 4 | opencode 执行（第 5.1、6 节） | complex | 两档权限的正反测试（被禁止的操作确实失败）；归属、修复、卡死、取消 |
| 发布 | 版本号、README 升级说明、发布说明、仓库改名、marketplace | Claude 做 | 按发布流程 |

- 代码由 Codex 实现（按配置，complex 级交给 Codex），每步的任务说明由 Claude 写。
- 文档（SKILL.md、README、配置说明、命令说明）由 Claude 写，中英文同步。
- 第 3 步之前要先用 OpenCode Go 的付费模型实测审查质量和报告格式合格率；第 4 步之前实测 opencode 跑长命令时的事件间隔，以及执行时的权限行为。

## 11. 已确认（2026-10-16）
第 1–5、7 条按下面的默认做法；第 6 条改为迁移时按模型自动改名。

1. 版本号用 1.0.0 吗？还是接着 0.12？
2. 用户级的配置、偏好、记录收进 `~/.claude/foreman/` 一个目录，可以吗？
3. 审查材料超过上限时直接报错，让 Claude 缩小范围或改用 Codex，不做分段审查，可以吗？
4. opencode `shell` 档的执行任务不做卡死检测、只靠总超时，可以吗？
5. 初始配置只自动安排 Codex，opencode 和 API 一律由 setup 引导你来选，可以吗？
6. ~~迁移时保留旧代号~~：已定为**迁移时按模型自动改名**，规则见 8.1。
7. 项目配置不再允许改模型，可以吗？现在它能改 `agents.codex.model`。
