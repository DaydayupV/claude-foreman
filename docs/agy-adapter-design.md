# agy（Antigravity CLI）协作方接入设计

新增协作方类型 `type: "agy cli"`，让 Google Antigravity CLI（命令名 `agy`）和 Codex、opencode、pi 一样参加讨论、审查和执行。整体沿用 pi 的做法：限定工具和目录，把 JSON 事件翻译成 Codex 的事件形状，复用现有的时间线、状态、看板和报告。和 pi 的根本区别是守卫的位置：agy 不能按次加载扩展，只能靠它的全局 PreToolUse 钩子（方案 A）。

本文依据 2026-10-28 在 Windows 11 上对 agy 1.4.7 的实测（第 1 节），以及同一天的第 0 期验证（第 9 节，期间 agy 自动升级到 1.4.8）。第 9 节末尾记了同一天 3 级设计审查的结论和新增的待验证事项，第 11 节记录用户 2026-10-28 拍板的取舍。

## 1. 实测结论（agy 1.4.7 / 1.4.8）

**无头调用**
- `-p` 必须带值。长提示走 stdin：`agy -p= --input-format stream-json --output-format stream-json`，stdin 写一行 `{"event":"user","message":{"role":"user","content":"<提示>"}}` 后关闭，跑完一轮就退出。20 万字符的提示能完整送达：输入 token 数随长度线性增长，10 万字符时 6.8 万、20 万字符时 12.4 万；10 万字符提示末尾的暗号也能读出来。Windows 命令行有 32K 字符上限，审查材料可达 20 万字符，所以不能放在参数里。
- 输出事件：
  - `init`：顶层带 `conversation_id`，`init` 字段里有模型、工作目录、工具清单、`permission_mode`。清单里列的 `list_dir`、`grep_search`、`find_by_name` 实际不可用（见下）。
  - `step_update`：带 `step_index`、`state`（ACTIVE / DONE / ERROR）和 `step_type`（user_input / agent_response / tool / subagent）。agent_response 带流式的 `text_delta`，DONE 时带这一次请求的 `usage`；tool 带 `tool_name` 和 `tool_info`（参数、输出摘要或错误）。
  - `result`：`response`、`usage`、`conversation_id`、`num_turns`，被拒的操作在 `denied_actions`。
- 用量：`input_tokens` 不含 `cache_read_tokens`，`output_tokens` 含 `thinking_tokens`，`total = input + output`。不输出思考内容。
- 模型或 API 失败时退出码为 3，stderr 有一行 `AGY_ERROR: {...}`（状态、错误码、能否重试）。
- `--json-schema` 原生可用，结果在 `result.structured_output`。但会多跑一轮，而且续接时即使没传 schema 也会带上上一轮的结构化结果。
- 续接用 `--conversation <id>`。ID 不存在时不报错：stderr 一行 warning，开一个新会话，退出码 0。
- 续接后的 `result.usage` 是会话累计；本轮各次请求的 `usage` 加起来正好是本轮的用量（第 9 节）。
- 会话一律保存在 agy 的历史里，没有不保存的选项。
- 启动时偶尔报 `Eligibility check failed: ... EOF`（账号校验请求断开），此时还没开始任何一轮，重试即可。
- agy 会自动升级，测试当天就从 1.4.7 升到了 1.4.8。

**工具**
- 这个版本模型实际拿到的工具：`read_file`、`edit_file`、`write_file`、`run_command`、`invoke_subagent`、`define_subagent`、`manage_subagents`、`manage_task`、`schedule`、`send_message`、`ask_question`、`search_web`。没有列目录、搜索、找文件的工具，这些都靠 `run_command` 跑 shell 命令。
- 钩子收到的参数键：`read_file {Path}`、`edit_file {Path, Target, Replacement}`、`write_file {Path, Content, Overwrite}`、`run_command {CommandLine, WaitMsBeforeAsync, toolSummary}`。路径有时用 `\`，有时用 `/`。
  - `edit_file` 会替换所有匹配处；notebook 也用 `edit_file` 改，没有出现 `notebook_*`。
  - `write_file` 会自动建出不存在的目录。
  - 子 agent 里读文件的工具叫 `view_file`，也经过钩子。
- 用户的 skills、规则（GEMINI.md / AGENTS.md）、MCP、插件照常加载，没有 pi 那样的隔离参数。

**权限**
- 默认无头模式下写文件直接放行，命令被拒；一旦被拒，整轮立即结束，回复为空。所以不能靠默认权限做只读或禁命令。
- `--dangerously-skip-permissions` 加 PreToolUse 钩子：钩子返回 `deny` 时工具报错，模型继续工作，照常写出报告。实测只读策略下读、写、命令都被挡住，模型仍回复了。
- 钩子只从两处加载：项目的 `.agents/hooks.json`（也认 `.agent/`、`_agents/`、`_agent/`），或全局的 `~/.gemini/config/hooks.json`；插件也能带钩子。环境变量能传到钩子进程。
- 钩子的几种返回：
  - `{"decision":"ask"}` 不改变原有行为：无头模式、交互的默认模式和 accept-edits 模式下都和没装钩子时一样，不会多弹确认。
  - `{}` 和空决定都会拦下工具（报 `unsupported hook decision`）。
  - 钩子脚本找不到、执行出错或超时，工具都被拦（失败即拒绝）。
- 几个钩子并存时（第 9 节）：
  - 任何一个钩子 `deny` 就拒绝，别的钩子 `allow` 盖不过。
  - 项目钩子先跑；它返回 `deny` 时，后面的全局钩子不再执行。
  - 项目钩子用 `overwrite` 改写的参数，全局钩子看不到：全局钩子检查的是改写前的参数，实际执行的却是改写后的。
  - 项目里和全局同名的钩子，`/hooks` 只列出全局那个，但两个都会执行。
  - 在不受信任的目录里，无头模式照样加载项目钩子。
- Windows 上钩子命令走 `cmd /c`，带引号的绝对路径会被拼坏。工作目录是 hooks.json 所在的目录，用相对路径 `node foreman-agy-guard.mjs` 可行。
- `--sandbox`（Windows 11 24H2 以上）实测效果：
  - 能读项目文件，能跑 `git --version`；
  - 写项目内和项目外都被拒，读 `~/.gitconfig` 被拒；
  - 系统临时目录仍可写。

  也就是说，它给的是一个只读 shell。agy 在不支持沙箱的系统上会自动关掉沙箱，退回询问；加了跳过权限后就等于没有沙箱。
- init 事件里没有沙箱状态；`--log-file` 指定的日志里有一行 `Print mode: enabling terminal sandbox for this session`。
- 在中文 Windows 上，命令输出按系统代码页显示，非 ASCII 字符是乱码。这是 agy 的问题，只影响时间线里的命令输出显示。

**模型和额度**
- `agy models` 输出 Tab 分隔的纯文本，1.4.7 不支持 `--output-format`。本机可用的模型：
  - gemini-3.8-flash-high / medium / low
  - claude-sonnet-4-6、claude-opus-4-6-thinking
  - gpt-oss-120b-medium
- 推理强度写在模型 ID 的后缀里，当前模型 `--effort` 显示不可调。
- 用 Google 账号订阅，额度分两组（Gemini 一组，Claude 和 GPT 一组），各有周限额和 5 小时限额。`agy -p "/quota" --output-format json` 能读剩余比例，不耗额度，也不留会话。
- 系统提示约 7K 输入 token，每次调用至少有这么多。

## 2. 范围
- 第一期：`discuss`、`review`（只读），以及 `check`、`models`、守卫的安装和自检、看板显示。
- 第二期（2026-11-25 实现）：`run` 的 `edit` / `shell` 两档、续接、返工，连同只在写入档才需要的安全措施（3.5、第 4 节的写入规则、异步命令）。安全措施和功能同一批上线、同一批测试。
- 不做：图像（agy 有 `generate_image`，以后再评估）、子 agent、浏览器、联网搜索。
- 平台：Windows、macOS、Linux 都支持，但只读 shell 依赖 agy 的终端沙箱（第 4 节）。只有 Windows 实测过；其他平台在 `check` 通过守卫自检和沙箱探针之前，不派 agy。

## 3. 守卫架构

### 3.1 全局钩子条目和启动器
- `~/.gemini/config/hooks.json` 里放一个名为 `foreman-guard` 的条目：`PreToolUse`，`matcher: "*"`，`timeout: 10`，命令是同目录下的启动器（Windows 用 `foreman-agy-guard.cmd`，其他平台用 `foreman-agy-guard.sh`），写相对路径。原因：钩子命令走 `cmd /c` / `sh -c`，带引号的绝对路径在 Windows 上会被拼坏（第 1 节）。
- 启动器里写死安装时 node 的绝对路径和守卫脚本 `foreman-agy-guard.mjs` 的路径，不依赖 PATH：从没有 node 的环境（图形界面启动的应用、nvm 切换后的 shell）调用也能跑。启动器先判断依赖在不在：
  - node 或守卫脚本缺失、而环境里有 `FOREMAN_AGY_GUARD`（foreman 的运行）：输出 `deny`；
  - 缺失、而没有这个环境变量（用户平时的会话）：输出 `ask`，不因为 foreman 的文件丢了就拦住用户的工具；
  - 都在：交给守卫脚本。
- 守卫脚本自带路径解析等全部依赖（构建时把公共模块打进一个文件），不从插件目录 import，插件升级或卸载不影响已安装的副本。文件头写插件版本和内容哈希。
- 安装、卸载、刷新由新子命令 `agy-guard install | uninstall | status` 完成：
  - 改写 hooks.json 前备份；只增删自己的条目，保留其他条目；原子写入；文件不是合法 JSON 时拒绝改写。
  - 安装先写启动器和脚本，再写条目；卸载先删条目，再删文件。
  - 安装、卸载、刷新和每次派出共用一个跨进程锁（foreman 状态目录里的锁文件）。卸载和刷新时如果还有 agy 运行没结束，拒绝执行并列出这些运行。
  - README 写明不依赖 foreman 的手工恢复办法：删掉 hooks.json 里 `foreman-guard` 这一条，再删三个文件。
- 第一次安装要用户同意：setup 里弹窗，写明会写哪些文件、失败即拒绝的含义、每次工具调用的耗时、卸载办法，以及共用 `~/.gemini/config` 的其他 Antigravity 产品可能也会加载这个钩子（第 9 节待验证）。用户同意过、插件升级后脚本内容变了时，`run` 和 `check` 在锁内自动刷新副本，不再问；条目本身缺失时拒绝派出，提示运行 `agy-guard install`。

### 3.2 策略传递
- 适配器每次启动 agy 都经同一个函数设置环境变量 `FOREMAN_AGY_GUARD`：`{ root, add_dirs, access, run_dir, log_file, nonce }`，`access` 取 `none | read | edit | shell`。单元测试检查每条启动路径（运行、续接、报告修复、check 的试跑和沙箱探针）都带上了策略。
- 守卫有策略时按第 4 节的表判断，返回 `allow` 或 `deny`，拒绝理由以 `foreman guard:` 开头。字段缺失、`access` 不认识、`root` 不是存在的绝对路径时全部拒绝。
- 没有这个环境变量时返回 `{"decision":"ask"}`。问题在于：foreman 的运行带着跳过权限，这时 `ask` 等于放行（第 0b 期实测确认），所以光靠"每条路径都带策略"还不够。再加一道启动标记：
  - foreman 启动 agy 前，在 foreman 状态目录写一个标记文件，内容是工作目录和过期时间（运行的最长时限）；
  - 守卫在没有环境变量时先查标记：钩子输入的 `workspacePaths` 命中一个没过期的标记，就返回 `deny`，理由写明"foreman 的运行没有收到策略"；
  - 运行结束时删掉标记。代价是 foreman 运行期间，用户在同一目录里自己用 agy 会被拦，拒绝理由里说明原因、运行 id 和标记的过期时间（用户已接受，第 11 节）。
  - foreman 进程强制结束、标记没删时：守卫看到 pid 已经不在就删掉标记。pid 被别的程序复用时，靠标记里记的 foreman 进程启动时间（`started_at`）识别：守卫只在要因标记拒绝时查一次这个 pid 现在的启动时间，明显晚于记录值（超过 2 秒）才算复用、删掉标记；查不到、记录值不是数字或时间更早都继续拒绝。曾经试过用修改时间做心跳，审查指出 foreman 挂起或睡眠超过阈值时会把仍在运行的标记删掉、让丢了策略的 agy 被放行，已去掉（2026-10-29）。
- 每次守卫放行或拒绝都往 `run_dir` 追加一行决定记录。运行结束时，如果有工具步骤、却没有任何一条决定记录，这一轮判失败：说明钩子没在这次运行里生效。
- 去掉跳过权限的办法不可行（第 0b 期）：不带跳过权限时，钩子返回 `allow` 加 `permissionOverrides` 放不行命令。通配写法 `command(*)` 被直接拒绝；精确写法 `command(echo hi)` 让命令跑了，但这一轮仍记下被拒的操作、以空回复结束。所以默认保留跳过权限，靠上面的启动标记和决定记录兜底。
- 例外是 Windows 上的沙箱探针和沙箱里的只读会话：agy 1.5.x 带着跳过权限时，沙箱已经不再隔离文件（第 12 节 2026-11-24 的实测）。所以这两种运行改用会话级 `--settings`（见第 5 节），不带跳过权限；钩子照样逐个工具判断、记下决定，日志核对也不变。不过 Windows 的沙箱不拦用户目录以外的读取，所以现在 Windows 上不探测、不给 shell（见第 4 节）；这套会话设置先留着，等 agy 改掉以后再启用。

### 3.3 对平时使用 agy 的影响
- 每次工具调用多起一个启动器加 node 进程，在 Windows 上实测 75–105 毫秒。
- 交互模式下返回 `ask` 不会多弹确认（默认模式和 accept-edits 模式验证过）。自动模式在本机没能开起来（`--mode auto` 后状态栏不显示 auto）；有钩子和没钩子时，跑 `git --version` 都会问，行为相同。

### 3.4 每次派出前的自检
带着跳过权限时，钩子是唯一的闸门（Windows 的沙箱会话另有会话级 deny 规则）。按下面的顺序检查，**在启动任何 agy 进程之前**先做完静态检查：
1. **扫描项目配置**（不启动 agy）：工作目录往上到仓库根，以及每个 `--add-dir`（实测 add-dir 里的 `.agents/` 会被加载）往上到它所在的仓库根。实测 agy 不加载仓库根以上、或没有仓库时工作目录以上的目录，这里多查到文件系统根，只当保险。每一层看 `.agents/`、`.agent/`、`_agents/`、`_agent/`（不区分大小写）下有没有 `hooks.json`、`mcp_config.json`、`plugins.json`、`skills.json` 和 `plugins/` 子目录。有 `hooks.json`、`mcp_config.json`、`plugins.json` 或 `plugins/` 下的任何插件，就拒绝派出：
   - 项目钩子能改写参数、截掉守卫，或执行任意命令；
   - 项目 MCP 服务器和插件在会话启动时就会运行，不经过工具调用。

   只有 `skills.json` 或规则文件时照常派出，在结果里提示一句。
2. **解析全局 hooks.json**：直接读文件，必须恰好有一个 `foreman-guard` 条目，`enabled` 不为 false，事件、`matcher`、`timeout`、命令和 3.1 写的完全一致。别的任何条目，不论什么事件都拒绝派出，并列出它们：其他事件的钩子也能执行命令、改文件，同样会破坏只读保证。
3. **核对启动器和脚本**：哈希和插件内的副本一致，不一致就在锁内刷新后再核对一次；启动器里写的 node 路径存在。插件升级、守卫正文变了的时候也走这一步，所以用户不用重装守卫；有别的 agy 任务在运行时不刷新，这次不派。
4. **列出插件钩子**：在一个空的临时目录里跑 `agy -p "/hooks" --output-format json`，这样只会列出全局和插件来源（实测插件钩子会连同来源路径一起列出；这样跑不留会话）。除了 `foreman-guard` 还有别的条目就拒绝派出。在项目目录里跑会加载项目配置，所以不在那里跑。
5. **用户的全局 MCP**：`~/.gemini/config/mcp_config.json` 里有启用的服务器时，在结果里提示：这些服务器会随 agy 启动，它们的工具会被守卫拒绝，但启动本身不受守卫限制。这和用户平时使用 agy 的情况相同，不拒绝派出。

自检失败时不启动 agy，结果标为 `failed`，给出原因和修复办法。

### 3.5 写入档的额外保护
- 守卫拒绝写入项目里的这些目录：上面四种 agy 配置目录，加上 `.git`、`.claude`、`.gemini`（不区分大小写，先求真实路径再逐段比较，经符号链接或 junction 指过去的也拦）。写进 `.git` 能改 git 的配置和钩子（比如 `core.fsmonitor`），写进 `.claude` 能改 Claude Code 的项目设置和钩子，以及 foreman 的项目配置和偏好：这些都会在别人之后运行 git 或 Claude Code 时执行命令，绕开“edit 档不跑命令”；被 `.gitignore` 忽略的话，验收看 diff 也看不到。
- 段名按写法本身和真实路径各查一遍：经普通名字的链接指进受保护目录，或者经受保护目录名的链接指到别处，都拦。项目根上的受保护目录是链接、或者 `.git` 是写着 `gitdir:` 的文件（工作树、`--separate-git-dir`）时，它指向的项目内目录也一起保护：按真实落点判断在不在项目里，经项目外的别名绕回项目的也算；`gitdir:` 照 git 的规则读（只认开头的 `gitdir: `，只去掉末尾的换行），`.git` 链接到这样一个文件时也读那个文件。`core.hooksPath` 另设的钩子目录不在其内：那些钩子一般是被跟踪的文件，改了会出现在 diff 里。
- 写入只能落在项目目录里，`--add-dir` 只扩展读取范围（在项目里面的附加目录也只能读）。agy 的设置目录（`~/.gemini`）、foreman 的状态目录和运行记录根（策略里的 `runs_root`）不论在不在项目里都不许写：改了它们等于改守卫、配置，或者验收要用的决定记录和改动快照。
- 写入路径带 `.` 或 `..` 段（`file:///` 地址先解码再看），或者 Windows 上有段名以点、空格结尾时，agy 和系统可能按不同的规则解析，拿不准写到哪里，一律拒绝。另外两种解析（先按字面合并 `..` 再跟链接、先跟链接再处理 `..`，悬空链接也顺着查）仍然都做，两种都在项目里、都不碰受保护位置才放行。
- 范围按 `realpathSync.native` 给出的真实路径逐字比较，不折叠大小写：Windows 上同一个父目录里可以有只差大小写的两个目录。受保护的段名仍然不区分大小写。
- Windows 上指向网络共享（`\\服务器\共享`）的路径，项目根和附加目录都不在那个共享上时，碰文件系统之前就拒绝；写入时顺着走的链接指向共享，也不再跟下去。访问共享会让 Windows 先连上对方、送出登录凭据。项目里早就有的、指向共享的链接不在其内：守卫解析路径时，系统会先跟着链接过去，再判断要不要拒绝（读档从第 1 期起就是这样）。要拦住，得从根目录开始逐段展开链接、先查目标再访问，留待以后做（审查计划 `20261125-120430-9n66` 的 F2）。
- 项目根本身包含用户主目录下的 `.gemini` 或 `.claude`（比如项目根就是用户主目录），或者项目根就在 `~/.gemini`、foreman 的状态目录或运行记录根里面时，直接拒绝派出 edit / shell 任务。
- 守卫的决定记录（`agy-guard.jsonl`）里，`run_command` 一条带上完整的命令行（`command`）：stream-json 会把 `CommandLine` 截到约 512 个字符，验收时以这里为准。
- shell 档的命令不受这些限制（和 pi 的 shell 档相同），文档里写明。

## 4. 访问档位

| 档位 | 用在 | 放行 | 附加参数 |
|---|---|---|---|
| `none` | 报告格式修复 | 什么都不放行 | 无 |
| `read` | 讨论、审查 | `read_file` / `view_file`（项目目录和 `--add-dir` 范围内）；沙箱确认可用时放行 `run_command` | 沙箱可用时加 `--sandbox` |
| `edit` | 执行 `run_access: "edit"` | read 档的读，加 `edit_file`、`write_file`（限项目目录内，排除 3.5 的位置） | 不加 `--sandbox`；不放行 `run_command`；任务说明末尾附 `git ls-files` 清单 |
| `shell` | 执行 `run_access: "shell"` | edit 档全部，加 `run_command`（没有系统沙箱，和 pi 的 shell 档相同；守卫用 `overwrite` 把 `WaitMsBeforeAsync` 设成 30 分钟） | 不加 `--sandbox` |

- 执行的两档在各系统上一样（Windows 也支持），都带 `--dangerously-skip-permissions`、不加 `--sandbox`，不跑沙箱探针、不查 `/permissions`：守卫是唯一的闸门，和没有沙箱的读档一样。Windows 沙箱不拦用户目录以外的读取，不影响执行：edit 档不跑命令，shell 档本来就没有沙箱。

- **每个工具的参数白名单**：`read_file` / `view_file` 只认 `Path`、`StartLine`、`EndLine`、`ByteOffset`（`StartLine`、`EndLine` 第 1 期实测补上，`ByteOffset` 在 agy 1.4.9 的真机测试里补上，见第 12 节）；`edit_file` 只认 `Path`、`Target`、`Replacement`；`write_file` 只认 `Path`、`Content`、`Overwrite`；`run_command` 只认 `CommandLine`、`WaitMsBeforeAsync`、`toolSummary`。出现任何其他参数就拒绝，理由写明参数名。agy 自动升级后如果加了新参数，会先被拒绝，再由维护者核对后补进白名单。只读工具（`read_file`、`view_file`、`run_command`）因为不认识的参数被拒时，适配器记成一条说明，不算要用户决定的权限问题：用户没有什么可放行的，agy 一般会去掉参数重试。
- 所有档位都拒绝：子 agent 三件套、`send_message`、`schedule`、`search_web`、`ask_question`（无头模式答不了，理由里提示把问题写进报告）、`browser_*`、`call_mcp_tool`、`generate_image`、`notebook_*`。不认识的工具也拒绝。`manage_task` 和 agy 1.5 起的 `update_steps` 只是任务清单，各档放行。
- 路径按 agy 自己的规则解析，不照搬 pi 的规则。第 0b 期实测（Windows）：
  - agy 只接受绝对路径和 `file:///` 地址；
  - `@r.txt`、`~/…`、相对路径、`..\…` 都报 "must be an absolute path"；
  - `/c/…` 被当成当前盘根下的路径，结果是文件不存在。

  守卫只放行盘符绝对路径（以及 UNC 路径，求真实路径后再判断）和 `file:///` 地址（先解码成路径再检查），其余形式一律拒绝。解析逻辑打进守卫脚本（3.1）。
- **只读 shell**：没有 shell 时模型列不了目录、搜不了代码，讨论和审查的质量会明显下降（实测模型在乱猜文件名）。所以 read 档在终端沙箱确认可用时放行命令，并且：
  - **探针**（`check` 时跑，也在缓存失效后第一次派只读席前跑）：用专门的 `probe` 策略，让探针命令越过守卫的日志核对，只测沙箱本身。canary 都由 foreman 创建并在 finally 里清理：项目内一个文件（写入应被拒）；一个既不在项目里、也不在系统临时目录里的 foreman 目录（写入应被拒）；用户主目录下一个 foreman 建的可读文件（读取应被拒）。Windows 上不跑探针：agy 的 Windows 沙箱不拦用户目录以外的读取（第 12 节 2026-11-24 的实测），只读席一旦能跑命令，就能读到别的项目、别的盘上的文件，所以直接按不可用处理，不给 shell。保留下来的 Windows 探测逻辑（`%ProgramData%` 下的读取检查、按项目缓存、会话设置）只在测试开关 `FOREMAN_TEST_AGY_WINDOWS_SANDBOX=1` 打开时运行。以后要在 Windows 上放开，先处理审查计划 `20261124-231658-mj10` 记下的问题：
    - 只靠一个测试文件，可能因为 ACL 或路径出现假通过；
    - 会话实际生效的权限要核对，包括项目级和共享的授权；
    - 第二次权限查询失败时，要退回只读文件；
    - 探针自己的时限，不能把整席都结束掉；
    - `--reprobe` 和同时在跑的探针之间有竞态；
    - 开启了大小写敏感的目录；
    - 缓存键要带上 Windows 的修订号；
    - `ProgramData` 里的残留要清理。另外测一次网络访问和环境变量是否可见，结果记下来，在文档和结果里如实说明。命令失败的原因要区分是沙箱拒绝、守卫拒绝，还是文件不存在，只有沙箱拒绝才算通过。
  - **缓存**：按 agy 版本、系统版本和项目所在的卷缓存。agy 会自动升级，升级后重新探测。
    - 探针结果里有一项读得到或写得进去时，沙箱肯定没拦住，探针没跑完也照样写缓存（模型不一定把每条命令都跑到）。
    - 下面三条是保留下来的 Windows 探测逻辑，只在测试开关打开时生效：Windows 还按项目及附加目录的真实路径区分缓存（路径不分大小写），键里带 `readonly-session-v2` 标记，探针项有变化时换标记，旧结论就全部重测；整个探针最多 360 秒，其中跑命令的那一轮最多 330 秒。
    - 读不出 agy 的权限设置（`/permissions` 失败或格式不对）时，记成 `settings_error`，按"不可用"写缓存（24 小时后过期）；缓存是"可用"、而派席位或 `check` 时读不出权限设置，这一次按只读文件处理，不改缓存。
    - 附加目录和项目不在同一个卷上时不探测、不放行命令（探针只测项目所在的卷）。
    - 本机断网时不启动探针，这次不放行命令，也不写缓存。
    - "不可用"的结论 24 小时后过期，"可用"的不过期；沙箱没拦住某一项的结论也不过期（重测结果不会变，agy 升级后缓存键会变，自然重测）；`check --reprobe` 删掉本机这一条后重测。Windows 上不探测，`--reprobe` 不起作用；保留下来的 Windows 探测逻辑在测试开关打开时，会删掉同一项目的所有条目（不论附加目录和 agy 版本）。
    - 探针没跑完的结论不写缓存，例外有两种：一是有一项读得到或写得进去（见上）；二是命令没能启动：工具输出的状态行里有 `Command failed to run:`、一个探针结果都没收到时，把原文（最多 300 字符）记成 `start_error`，探针就此结束，按"不可用"写缓存（照样 24 小时后过期）。见第 12 节 agy 1.4.10 的实测。
    - 写缓存在锁内重读再合并；锁忙时这次不写。例外：缓存里留着"可用"、而这次要撤销它（强制重测或测出不可用）却写不进去时报错，不派 agy。
  - **每次运行再核对日志**：守卫第一次放行 `run_command` 前，确认 `log_file` 里有 `enabling terminal sandbox`，而且没有关闭沙箱或退回询问一类的行。退回时的日志措辞还没见过，所以以探针结果为主，日志只作补充；探针没通过的系统，read 档一律不放行命令。
  - **环境变量**：沙箱里的命令看得到 agy 进程的全部环境变量（第 0b 期实测）。所以启动 agy 时去掉已知的密钥类环境变量（各家 API key、云厂商凭据、`SSH_AUTH_SOCK` 等），只保留 agy 登录要用的（比如用 `GEMINI_API_KEY` 登录时保留这一个）。
  - 守卫进程本身不在沙箱里：实测加了 `--sandbox` 后，钩子照样能读 `~/.gemini/config`、写 run 目录、读 `--log-file` 日志，所以上面的日志核对和决定记录可行。
  - 沙箱不可用时 read 档不放行 shell，材料里附上 `git ls-files` 的文件清单代替；审查照常附 patch（和 opencode、pi 的审查材料相同）。
  - 本机实测沙箱拦网络（curl 返回 000，DNS 解析被拒），临时目录可写。别的系统以探针结果为准。只读档保证的是"项目文件不变、不能联网"，不是"整台机器不变"，文档里写明这一点。
- **异步命令**：命令跑得比 `WaitMsBeforeAsync` 久时会转到后台，但无头模式会在退出前等后台任务结束（stderr 写 `waiting up to 30m0s for 1 background task(s)`）；工具步骤的完成事件带着命令的最终输出（第 0b 期实测）。所以：
  - 守卫照样用 `overwrite` 把 `WaitMsBeforeAsync` 调大到 30 分钟（`1800000`，和无头模式等后台任务的上限一致；实测生效，agy 会告诉模型参数被钩子改过），让时间线上的命令时长准确；
  - 不会结束的命令（比如开发服务器）会让 agy 等满 30 分钟，由 foreman 的超时和卡死检测结束整棵进程树，并在结果里写明。

## 5. 调用与事件翻译

**命令**：`agy -p= --input-format stream-json --output-format stream-json --model <id> --dangerously-skip-permissions --disable-slash-commands --log-file <run_dir>/agy.log`，按需再加 `[--sandbox] [--conversation <id>] [--add-dir <dir>]…`。Windows 的沙箱探测和只读命令会话用会话级 `--settings` 替代 `--dangerously-skip-permissions`：`agentMode` 为空、`toolPermission` 为 `proceed-in-sandbox`，`permissions` 的 `allow` 和 `ask` 固定为空，`deny` 是全局 deny 规则加上 `write_file(*)`、`read_url(*)`。启动前先用 `agy -p /permissions --output-format json` 读出全局 deny 规则，因为会话设置会整组替换这几个数组。工作目录是项目目录。提示从 stdin 写一行后关闭。超时和卡死由 foreman 管，不用 `--print-timeout`，要停时整棵进程树结束。

**翻译**（照 pi-cli.mjs 的 `translate`）：

| agy 事件 | 写进 events.jsonl |
|---|---|
| `init`（`conversation_id` 在顶层） | `thread.started`，同时写入 meta.session_id；`init` 没给时从 `result` 补，只写一次 |
| agent_response 的 ACTIVE + `text_delta` | 累计字数，每 5 秒写一条进度事件；进度事件的消费方（records.mjs、board/feed.mjs）一并支持 |
| agent_response 的 DONE | 有文字时写 `item.completed agent_message`；用量见下 |
| tool ACTIVE | 记进运行中的工具集合；`run_command` 写 `item.started command_execution` |
| tool DONE / ERROR | 移出运行中集合；`edit_file` / `write_file` 写 `file_change`，其余写 `command_execution`（含 exit_code、输出摘要） |
| tool ERROR，错误以 `tool call denied by pre-tool hook: foreman guard:` 开头 | 另外记进 `permission_denied` 问题，和 pi 的处理相同 |
| `result` | 取最终 `response`；`denied_actions` 记进问题；状态见下 |

- 每个工具步骤生成一次运行内唯一的 `item.id`（例如 `agy-<序号>`），开始和完成事件用同一个；页面用的 `aid` 由 feed 层从 `item.id` 生成，适配器不写。
- 运行中的工具集合交给 `spawnCli` 的 `busy` 回调和卡死检测：有工具在跑时，不算卡住。
- **用量**：`input_tokens = input + cache_read`，`cached_input_tokens = cache_read`，`output_tokens = output`，`reasoning_output_tokens = thinking`。每次请求的用量先缓存在内存里，下一次请求的用量到达时，才把上一条写成 `step.usage`。整个运行结束时（报告修复轮也结束后），最后一条带 `final` 写出。不追加重复事件，也不改写已写的事件。本轮用量是各步之和，`usage_scope: this_run`；续接时 `result.usage` 是会话累计数，不用它。一次请求都没完成时返回 `usage: null`、`usage_scope: null`。

**报告**：第一期不用 `--json-schema`，和 pi 一样把 schema 写进提示，由 `reportWithRepair` 校验。修复轮在同一会话里续接，用 `none` 档。原生 schema 留作第三期的候选。

**续接**：`--conversation <meta.session_id>`。返回的 conversation_id 和请求的不同，说明 agy 开了新会话、上下文丢了，这一轮按失败处理，错误里写明。

**状态判定**（以 `result` 为准，退出码只作辅助）：

| 情况 | 状态 |
|---|---|
| foreman 取消、超时、卡死 | `cancelled` / `timeout` / `stalled` |
| 启动时报 `Eligibility check failed`，没有产生任何一步 | 等几秒自动重试一次，再失败判 `failed` |
| 没有 `result` 事件 | `failed`，附 stderr 末尾几行 |
| `result.status` 不是 SUCCESS | 错误文字（或 `AGY_ERROR`）含 `RESOURCE_EXHAUSTED`、`quota`、`usage limit`、`insufficient quota` 时判 `quota_exhausted`；429 或并发限制时判 `failed` 并加 rate-limit 提示；其余判 `failed` |
| SUCCESS，但回复为空且有 `denied_actions` | `failed`：有一次权限拒绝没被钩子接住，自检有漏洞 |
| SUCCESS，但回复为空且没有 `denied_actions` | `failed`，写明"回复为空" |
| SUCCESS、回复非空，退出码不为 0 | `failed`，保留退出码和 stderr |
| SUCCESS、回复非空、退出码 0 | `done`（之后照常校验报告） |

stream-json 输入下，模型名无效时退出码是 1（不是 3），`result.status` 为 ERROR、`error` 字段带原因，stderr 有一行 `error: …`（第 0b 期）。运行中途的 API 错误没能造出来，所以表里一律以 `result` 为准，不依赖具体的退出码。

## 6. 模型、推理强度和检查
- `catalog`：解析 `agy models` 的两列（ID、显示名）。拿不到时 `ok: false`。
- 推理强度：agy 的档位是模型 ID 后缀（`-low` / `-medium` / `-high`），它的 `--effort` 对这些模型不能调。2026-10-29 改成在插件这边统一写法：清单按后缀（`minimal` 到 `max`）拆成模型族和档位（`-thinking` 这类其他后缀不拆），配置写 `model: "gemini-3.8-flash"`、格子写 `effort: "high"`，派出时拼回 `gemini-3.8-flash-high`。只有一档的族不写就用那一档，有几档的必须写；旧写法（完整 ID、不写 effort）照常能用，完整 ID 再写 effort 报错。档位和价格查不到时去掉后缀再查。
- `check`：
  1. `agy --version`；
  2. 模型在不在 `agy models` 的清单里，不在时给出最接近的；
  3. 守卫自检（3.4）；
  4. 沙箱探针（第 4 节，有缓存时跳过）；
  5. 在临时目录写一个随机令牌文件，让模型用 `read_file` 读出来并原样回复（约 1–2 万输入 token，会在 agy 历史里留一条会话），同时确认守卫留下了一条 `read_file` 的放行记录（第 1 期实现时从"Reply with the single word OK."改成这样：模型不一定调工具，回复 OK 证明不了守卫生效）；
  6. 读 `/quota`（在空的临时目录里跑），剩余低于 10% 时提示。
- 价格和身份：
  - gemini-3.8-flash-* 和 claude-opus-4-6-thinking 已能按 `-` 后缀匹配到价格，价格测试里加上这两个；
  - claude-opus-4-6-thinking 在 `models.json` 的 claude-opus-4-6 下加进 aliases，比较基础模型和 stats 分行时并成同一个；
  - gpt-oss-120b 缺价格，补一行并注明来源；
  - `cost_source` 照例是 api_price（实际走的是订阅额度，和其他协作方一样只用来比较花费）。

## 7. 配置

```json
"gemini-flash-agy": { "type": "agy cli", "model": "gemini-3.8-flash" }
```

| 字段 | 作用 |
|---|---|
| `model` | 必填，模型族（`agy models` 第一列去掉档位后缀），档位写在格子的 `effort` 里；也可以写完整 ID |
| `bin` | 可选，agy 可执行文件路径。默认在 PATH 里找，Windows 上再找 `%LOCALAPPDATA%\agy\bin\agy.exe` |
| `max_parallel` | 可选，默认 `2`：订阅额度按 5 小时窗口算，并发高了容易一起撞限额 |
| `run_access` | 可选，`"edit"` 或 `"shell"`，只能写在用户配置里，含义和 opencode、pi 相同 |

- 现在所有协作方共用 `DEFAULT_AGENT_PARALLEL = 4`。改成适配器可以声明自己的默认值（`defaultMaxParallel`），排队、准入、status 和看板都改读同一个函数，并加测试。
- 协作方代号后缀为 `agy`。看板和消息里的接入方式标签用 `Agy CLI`（第 11 节）。登录由 agy 自己管，插件不碰。

## 8. 改动清单（参照加 pi 的提交 ed9c3f1）
- 新文件：
  - `adapters/agy-cli.mjs`
  - `adapters/agy-guard.mjs`（构建成自带依赖的单文件），以及 `.cmd` / `.sh` 启动器模板
  - `agy-guard` 子命令（install / uninstall / status，带锁）
  - `tests/fake/agy.mjs`：假 agy 读 `~/.gemini/config/hooks.json` 和项目的 `.agents/`，按调用真的去执行启动器和守卫，用来端到端测试守卫、自检、启动标记和决定记录
  - `tests/agy.test.mjs`
- 修改：
  - `adapters/index.mjs`
  - `config.mjs`：类型清单、代号后缀、环境检测、`effort` 校验、按适配器取默认并发
  - `records.mjs`、`cli.mjs`、`board/universe.mjs`：默认并发改读同一个函数
  - `records.mjs`、`board/feed.mjs`：进度事件
  - `cli.mjs`：工具检测
  - `messages.mjs` / `display.mjs`：channel 标签、新错误文案
  - 看板的 `06-cards.js` 和 `07-uni-side.js`（CHANNEL / VIA），以及重新生成 `board/index.html`
  - `prices.mjs`、`prices.json`、`models.json`
  - `report.mjs`、`status.mjs`：工具类型清单
  - `hooks/guard-direct-calls.mjs`：拦下所有会运行模型的 `agy` 调用，包括任何带 `-p` / `--print` / `--prompt` / `-i` / `--input-format` 的形式和裸的 `agy`。只放行 `models`、`agents`、`changelog`、`help` 子命令和单独的 `--version`；额度和钩子状态由 foreman 的 `check` 去读
  - `hooks/session-reminder.mjs`
  - setup skill：安装弹窗，以及执行两档的说明
  - references 下的 `config.md`、`cli.md`、`seats.md`
  - 两个 README（含手工恢复办法）
  - foreman-en 镜像
- 文档里写明：agy 的会话会出现在用户的 `/resume` 历史里；用户自己的 GEMINI.md、skills 会加载，全局 MCP 服务器会启动，但它们的工具被守卫拒绝。

## 9. 第 0 期验证结果（2026-10-28，Windows 11，agy 1.4.7 → 1.4.8）

测试用的全局钩子只在测试期间存在，测完已删除。

| # | 问题 | 结果 | 对设计的影响 |
|---|---|---|---|
| 1 | 全局钩子返回 `ask` 会不会打扰平时使用 | 不会。交互的默认模式读文件、accept-edits 模式改文件都没有多弹确认，钩子日志确认返回的是 `ask` | 方案 A 成立，不需要方案 B |
| 2 | 几个钩子怎么合并 | 任何一个 `deny` 就拒绝；项目钩子先跑，它 `deny` 后全局钩子不再执行；项目钩子 `overwrite` 改写的参数全局钩子看不到；同名的项目钩子在 `/hooks` 里不显示但照样执行；不受信任的目录也加载项目钩子 | 自检改为：有其他 PreToolUse 条目或任何项目钩子就拒绝派出，项目钩子靠直接扫描文件发现；edit 档禁止写 `.agents/` 这类目录（3.4） |
| 3 | 续接时的用量 | `result.usage` 是会话累计（第一轮 93,597 + 第二轮 11,271 = 104,868）；本轮各步 `usage` 之和等于本轮用量 | 用量只按本轮各步加总 |
| 4 | 怎么知道沙箱开了 | init 事件没有沙箱字段；日志里有 `Print mode: enabling terminal sandbox for this session`。手头没有不支持沙箱的系统，退回无沙箱时日志怎么写还不知道 | 探针加每次运行的日志核对（第 4 节）；只认"开了"的那一行，看不到就不放行命令 |
| 5 | 钩子耗时和超时 | 每次 75–105 毫秒；超时按失败处理，工具被拦 | 超时设 10 秒即可，超时等于拒绝 |
| 6 | 子 agent 的工具调用会不会经过钩子 | 会，子 agent 读文件用的是 `view_file` | 子 agent 已被拒绝，这是纵深防御；`view_file` 按读处理 |
| 7 | macOS / Linux | 没有机器，未验证 | 第 1 期先只在 Windows 上标为已验证；其他平台的 `check` 第一次运行时要通过同样的守卫和沙箱探针 |
| 8 | 编辑类工具的参数键 | 一次改多处、改 notebook 都用 `edit_file {Path, Target, Replacement}`（替换所有匹配处）；`write_file` 会自动建目录；没有出现 `notebook_*` | 路径键清单不变，仍对不认识的路径型参数拒绝 |

另外发现：启动时偶尔会因为账号校验请求断开而失败（第 5 节加了自动重试一次）；agy 会自动升级（第 4 节探针的缓存跟着版本走）。

### 第 0b 期验证结果（2026-10-28，Windows 11，agy 1.4.8）
3 级设计审查（任务组 `agy-design-1028`）之后补测的 12 项。测试用的全局钩子测完已删除。

| # | 问题 | 结果 | 对设计的影响 |
|---|---|---|---|
| 1 | 不带跳过权限，钩子 `allow` 加 `permissionOverrides` 能否放行 | 不能：`command(*)` 被直接拒绝；`command(echo hi)` 让命令跑了，但这一轮仍记下被拒的操作、空回复结束 | 保留跳过权限（3.2） |
| 2 | 带跳过权限、没有环境变量时，`ask` 是不是放行 | 是，命令照常执行 | 启动标记和决定记录是必需的（3.2） |
| 3 | `overwrite` 能否改 `WaitMsBeforeAsync`；后台命令怎么收场 | 能改，agy 会告诉模型参数被改过；转到后台的命令，无头模式会在退出前等它结束（最多 30 分钟），完成事件带最终输出 | 第 4 节"异步命令"简化为调大等待时间，加上 foreman 的超时兜底 |
| 4 | 加 `--sandbox` 时钩子能否读配置、写 run 目录、读日志 | 都能，钩子不在沙箱里；日志里有 `enabling terminal sandbox` | 日志核对和决定记录可行 |
| 5 | 沙箱里的网络和环境变量 | 网络被拦（curl 000，DNS 被拒）；环境变量全部可见 | 启动 agy 前去掉密钥类环境变量（第 4 节） |
| 6 | stream-json 输入下出错 | 模型名无效：退出码 1、`result.status` ERROR、`error` 带原因、stderr 一行 `error: …`；运行中途的 API 错误没能造出来 | 状态以 `result` 为准（第 5 节） |
| 7 | 自动模式下 `ask` 会不会多弹确认 | 本机 `--mode auto` 没能开起来（状态栏不显示 auto）；有钩子和没钩子时跑 `git --version` 都会问，行为相同 | 没有发现影响；自动模式真正可用的机器上仍待验证 |
| 8 | `--add-dir` 和祖先目录的 `.agents/` 会不会被加载 | add-dir 里的会；仓库根以上、或没有仓库时工作目录以上的不会 | 自检扫描每个 add-dir（3.4） |
| 9 | `/hooks` 列不列插件钩子；在空目录跑会不会留会话 | 项目 `.agents/plugins/<名字>/hooks.json` 的钩子会连同来源一起列出；不留会话 | 自检也扫描 `plugins/` 子目录（3.4） |
| 10 | Antigravity 桌面版、IDE 是否读全局 hooks.json | 本机没装，没法验证 | 3.1 的启动器在依赖缺失时对普通会话返回 `ask`，setup 弹窗里写明可能的影响 |
| 11 | 20 万字符提示经 stdin 能否完整送达 | 能（见第 1 节） | 无 |
| 12 | agy 的路径解析规则 | 只认绝对路径和 `file:///` 地址；`@`、`~/`、相对路径报 "must be an absolute path"；`/c/…` 被当成当前盘根下的路径 | 守卫只放行盘符 / UNC 绝对路径和解码后的 `file:///`（第 4 节） |

### 设计审查的结论
- 参与方：gpt-6.1-sol（Codex CLI，max，必选）、deepseek-flash（Pi CLI，max），加上 Claude Code 席（作者）。这一格只有这两个候选，都用在了独立审查里，没有做补漏轮。
- 三席共报 32 条，去重后约 27 个问题。核实后 2 条部分成立，其余成立，都已改进本文：
  - init 里其实有 `conversation_id`（在顶层），原文漏写，不是设计缺陷；
  - 用户自己的全局 MCP 服务器在平时使用 agy 时同样会启动，这里只做提示、不拒绝；项目级 MCP 和插件改为拒绝派出。
- 影响最大的几条：
  - 带跳过权限时，钩子的 `ask` 等于放行。改进：3.2 的启动标记和决定记录，第 0b 期确认去掉跳过权限的办法不可行；
  - 自检先启动 agy、后扫描项目。改进：3.4 先做静态扫描；
  - 自检不核对 matcher，也放过了其他事件的钩子。改进：3.4 直接解析 hooks.json，有任何其他钩子就拒绝；
  - 写入档能改写守卫自己。改进：3.5；
  - 普通会话依赖 PATH 里的 node。改进：3.1 的启动器；
  - 用量 `final` 标记和只追加的事件文件冲突、卡死检测、异步命令、状态表不全、参数白名单、大小写、默认并发、直接调用守卫的漏洞、分期矛盾、价格别名放错文件。分别改进在第 4–8 节和第 10 节。

## 10. 分期
- **第 0 期**：已完成（第 9 节）。
- **第 0b 期**：已完成（第 9 节），只剩桌面版 / IDE 和自动模式两项因为没有条件没能验证。
- **第 1 期**（2026-10-28 完成，真实 agy 1.4.8 / 1.4.9 上验证过 check、讨论、审查和两席并发）：守卫（启动器、启动标记、决定记录）、自检、`agy-guard` 子命令和锁、读档（讨论和审查）和沙箱探针、`check`、`models`、看板、价格和身份表、默认并发、直接调用守卫、假 agy 和测试。
- **第 2 期**（2026-11-25 实现，Issue #5）：执行的 `edit` / `shell` 两档、3.5 的写入保护、异步命令处理、续接、返工。真机验证结果见第 12 节；只在 Windows 11 上验证过。
- **第 3 期**：原生 `--json-schema`、图像（`generate_image`）是否接入。

## 11. 用户拍板的取舍
2026-10-28 用户同意下面六条，全部按推荐做法：
1. **全局钩子**：采用方案 A，在 `~/.gemini/config/` 下写全局钩子、启动器和守卫脚本。setup 加 agy 协作方时弹窗征求每位用户的同意，不同意就不加；`agy-guard uninstall` 随时可以撤掉（3.1）。
2. **沙箱不可用时**：read 档不给 shell，讨论材料附 `git ls-files` 的文件清单，审查照常附 patch（第 4 节）。agy 仍然参加讨论和审查，结果里注明它这次没有 shell。
3. **默认并发**：`max_parallel` 默认 2，通过适配器的 `defaultMaxParallel` 给出，用户配置可以改（第 7 节）。
4. **接入方式标签**：用 `Agy CLI`，和命令名一致，也和 `Codex CLI`、`Pi CLI` 的叫法对齐。说明文字里第一次出现时写"Agy CLI（Google Antigravity CLI）"。
5. **项目配置和其他钩子**：一律拒绝派出，不留按项目放行的开关。项目里（含 `--add-dir` 目录）有 agy 的钩子、MCP 或插件配置，或者全局 hooks.json 里有 foreman 以外的钩子时，这次不派 agy，结果里写明是哪个文件挡住的（3.4）。
6. **启动标记**：接受。foreman 运行期间，同一目录里用户自己用 agy 会被启动标记拦下工具调用，拒绝理由写明原因和标记的过期时间；单元测试照样检查每条启动路径都带策略（3.2）。

2026-11-25 做第二期前，用户定了下面四条：
1. **两档都做**：`edit` 和 `shell` 和 pi、opencode 一致，用哪一档由用户在 `run_access` 里选。
2. **Windows 也支持**：执行不靠沙箱，各系统行为一致。
3. **agy 自带的联网工具一律不放行**：`search_web`、`read_url`、`browser_*` 在所有档位都拒绝；shell 档的命令没有沙箱，本来就能联网，这一条管不到。
4. **守卫自动更新**：插件升级后守卫文件对不上时，派出和 `check` 前自动换成新版（`hooks.json` 不动），不用用户重装；这就是 3.4 自检里现有的重写行为，只把提示改成说明插件升级过。

## 12. 第 1 期实现时的实测补充（2026-10-28，Windows 11，agy 1.4.8）
在真实 agy 上冒烟时发现、前面各节没写到的事实，代码已按这些实现：
- **事件是嵌套的**：每行是 `{"event":"<名字>","<名字>":{…}}`，比如 `{"event":"step_update","step_update":{…}}`、`{"event":"result","result":{…}}`；`init` 另外在顶层带 `conversation_id`。适配器读行时先归一成平铺对象。
- **工具字段**：参数在 `tool_info.parameters`，守卫拒绝时步骤为 `state: "ERROR"`，`error` 是 `{type, message}`，`message` 以 `tool call denied by pre-tool hook: ` 开头。命令没有单独的退出码，`output` 以 `Command exited with code N.` 开头。stream-json 会把较长的参数（实测 `CommandLine`）截到约 512 个字符，所以只能按输出认探针结果，不能按命令原文匹配；钩子收到的参数是完整的。
- **钩子输入**：`{toolCall:{name,args}, workspacePaths:[正斜杠路径], conversationId, stepIdx, modelName, lastUserInput, artifactDirectoryPath, transcriptPath}`。`read_file` 会带 `StartLine` / `EndLine`；agy 1.4.9 起有时还带 `ByteOffset`（数字，实测为 0），被拒后 agy 会去掉它重试。
- **钩子命令**：Claude Code 给子进程设了 `NoDefaultCurrentDirectoryInExePath=1`，agy 继承下来以后，`cmd /c` 不在当前目录找裸文件名，所以 Windows 上的命令写成 `.\foreman-agy-guard.cmd`。钩子命令本身失败时，cmd 的报错是系统代码页，agy 会整轮报 `string_value contains invalid UTF-8` 而失败。
- **`run_command` 在 Windows 上用 PowerShell 跑**：带引号的程序路径要写成 `& "…\node.exe" …`。
- **沙箱的网络**：表现为 DNS 解析失败（`ENOTFOUND`），不是权限错误；探针用 foreman 自己（沙箱外）的对照来区分"沙箱拦下"和"本来就断网"。
- **后台更新进程**：agy 每次启动可能拉起 `agy --bg-updater`，工作目录就是这次的 cwd，几分钟内删不掉那个目录。foreman 的临时目录因此放在自己的状态目录里，删不掉的留到下次清理。
- **`/hooks`**：结果在 `command.data.hooks`，每项 `{name, enabled, source, actions:[{event, matcher, type, command, timeout_seconds}]}`；`response` 是给人看的制表符文本。**`/quota`** 的 `command.name` 是 `usage`，额度在 `command.data.groups[].buckets[].remaining_fraction`。**`agy models`** 前面可能有一行没有制表符的 `Fetching available models...`。
- **账号校验断流**：偶发 `Eligibility check failed: … EOF`，查询和请求都重试一次。
- 全局 `mcp_config.json` 可能是 agy 自己留下的空文件。
- **命令输出的编码**：PowerShell 的输出按系统代码页编码，里面有中文（比如项目路径）时，agy 会把非 UTF-8 的字节原样发给模型接口，整轮报 `INVALID_ARGUMENT (code 400)`。守卫在 Windows 上放行 `run_command` 时用 `overwrite` 在命令前面加 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;`（agy 会告诉模型参数被钩子改过）。
- **沙箱里的 git**：沙箱读不到 `~/.gitconfig`，git 直接报错退出；沙箱运行时 foreman 把 `GIT_CONFIG_GLOBAL` 指向临时目录里的一个空文件。
- **回复之后的报错**：实测有一次模型已经交回完整回复，agy 之后的一次请求被接口以 400 拒绝，result 记为 ERROR。回复还在时照常采用，错误记进 notes，回复合不合格交给报告校验。
- **命令输出的格式**：`run_command` 的 `tool_info.output` 开头常有一行 `A pre-tool hook changed the arguments of this tool call before it ran. Changed: CommandLine.`（守卫每次都改写命令行），然后是状态行 `Command exited with code N.`，`Command output:` 之后才是命令自己打印的内容。退出码和"没能启动"都只在 `Command output:` 之前找。
- **agy 1.4.10 的沙箱起不来**（2026-10-29 自动升级后，Windows 11）：`--sandbox` 下每条命令都没能启动，步骤仍是 `DONE`，状态行是 `Command failed to run: exebox: creating sandbox: CreateProcessSecurityEnvironment: The system cannot find the path specified..`，换 ASCII 路径的目录也一样，1.4.9 上同一台机器正常。模型每次失败后要想 10–50 秒再换写法重试（还会试 `run_command` 的新参数 `BypassSandbox`，被守卫按不认识的参数拒绝），探针会拖过 120 秒时限，所以探针遇到第一条没能启动的命令就结束（见第 4 节缓存规则）。

### 2026-11-24 的实测补充（Windows 11，agy 1.5.16）
- **带跳过权限时沙箱不隔离**：agy 1.5.9–1.5.13 带 `--dangerously-skip-permissions` 跑探针，项目内写入、项目外写入、读主目录三项都是 `allowed`，只读席一直只能读文件。
- **会话设置**：改用 `--settings` 后，四项都是 `sandbox_denied`。agy 日志里有一行 `CLI settings initialized: permissions=&{Allow:[…] Deny:[…] Ask:[…]}, toolPermission=…`，记的是这次会话实际生效的规则。
- **替换还是合并**：会话设置里写了的数组，整组替换全局的；没写的沿用全局的。只写 deny 时，全局 `settings.json` 里的 allow 照样生效。
- **放行规则就是沙箱的挂载**：全局 allow 里的 `read_file(<目录>)` 会把那个目录只读挂进沙箱，命令能读到原本读不到的、用户目录下的文件。路径写错时，每条命令都报 `sandbox configuration error: readonly …: non-absolute file path`，没能启动。会话设置把 allow 和 ask 固定为空之后，日志里的 Allow 是空的，那个目录又读不到了。
- **用户目录以外的文件**：沙箱里的命令能读用户目录以外的文件（另一个盘上项目外的文件被读到了），agy 文档也是这样写的。所以 Windows 上现在不探测、不给 shell。一开始是用 `%ProgramData%` 下的读取检查来判断，审查指出只靠一个测试文件可能因为 ACL 或路径出现假通过，于是改成了直接不给。
- **守卫照常生效**：`--settings` 会话里每次工具调用都有一条守卫决定，读项目外的文件被守卫拒绝；`proceed-in-sandbox` 下 `read_file` 不需要审批。`agentMode` 为空就是非 auto 模式。
- **`/permissions`**：用户没配任何全局规则时，也正好返回一个 global 作用域。
- **宿主网络对照**：经 TUN 代理上网时（DNS 返回代理分配的地址），探针后的 HTTPS 对照有一次超过了 12 秒，结论成了 `unconfirmed`。后来加过一次重试，审查指出它会把探针中途的断网误判成沙箱禁网，已经撤回。
- **探针不一定跑全**：探针要模型照着跑六条命令，有一次只出了四条的结果（项目外写入、联网两项没有），读主目录以外那一项是 `allowed`。所以只要有一项读得到，探针没跑完也照样写缓存。

### 2026-11-25 第二期的实测（Windows 11，agy 1.5.16，gemini-3.8-flash high）
- **edit、shell 两档各跑了两次真实的执行任务**：edit 档修一个函数的错误、补一个测试；shell 档加一个函数、补测试，再自己运行 `node --test`。四次都正常完成，改动按 `by: agent` 归属，调度方自己再跑测试也全部通过。edit 档用时 167–353 秒、执行 0 条命令；shell 档用时 134–365 秒、执行 6–11 条命令（`Get-ChildItem`、`node --test`、`git status`、`git diff` 之类）。
- **守卫拦下的写入**：项目外的文件、项目里的 `.git` 和 `.claude`，拒绝理由原文都对。测试前后项目外、`.git`、`.claude` 里都没有多出文件。
- **模型会主动去读项目外的东西**：上一级目录的 `package.json`、`~\.gemini\antigravity-cli\` 下的 `settings.json` 和 `hooks.json`，都被守卫按项目外拒绝。shell 档的命令没有沙箱，用命令照样读得到，这一点文档里写明了。
- **任务清单工具**：agy 1.5.16 用的是 `update_steps`（参数 `steps`），不是第 1 期见过的 `manage_task`。原来被当作不认识的工具拒绝，每次都多出一条要决定的问题，现在两个都各档放行。
- **完整命令行**：决定记录里的 `command` 写下了每条命令的原文。
- **守卫自动更新**：开发版和已装的守卫不一致时，派出前在锁里换成新版，结果的 `notes` 里有一句提示；测完把 `~/.gemini/config` 恢复成测试前的样子，sha256 核对一致。
