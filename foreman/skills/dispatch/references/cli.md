# 脚本参考：命令、check、models 和结果字段

SKILL.md 里只留了决策流程和常用命令。查某个命令的完整参数、排查环境、帮用户选模型、看结果 JSON 里某个字段的意思时，读这里对应的一节，不用整篇读完。实时查看、`status` 和开工那一行的字段（状态词、用时、计数、模型标签、用量、标签和提示）中英两个插件都写英文，模型和 Claude 写的内容照原文显示。每个子命令加 `--help`（或 `-h`）打印这一条的用法（`assets <动作> --help` 打印这个动作的参数），不带子命令时打印总用法，退出码都是 0，不写任何文件；写在选项值里的（比如 `--title -h`）不算。

## 命令一览
唯一入口是 dispatch skill 目录下的 `scripts/cli.mjs`（下面写成 `<脚本路径>`）。

```bash
node "<脚本路径>" run    --cwd "<项目目录>" --brief "<任务说明.md>" --title "<短标题>" --level <simple|normal|complex> [--agent <协作方>] [--add-dir "<目录>"] [--track "<路径>"] [--group <组名> --scope "<路径>"] [--timeout 分钟]
node "<脚本路径>" resume --run <run_id|last> --brief "<返工说明.md>" --level <simple|normal|complex> --reason <rework|answer|recover> [--track "<路径>"] [--file "<路径>[:起始行-结束行]"]（续接图像任务时不写 --level；讨论的续接不写 --reason）
node "<脚本路径>" plan   --cwd "<项目目录>" --module <discuss|run|review> --cell <simple|normal|complex> --group <组名> --seat "<代号>[=<角色名>]" [--seat …] [--why "<选择理由>"] [--host-role "<角色名>"] [--count-why "<理由>"]（这两项只用于讨论和审查计划） [--target diff|files|claims|visual --file "<路径>[:起始行-结束行]" --uncommitted | --base <分支> | --commit <sha>（只用于审查计划）]
node "<脚本路径>" submit --plan <plan_id> --report "<报告.json>" [--model <Claude Code 当前的模型>] [--author]
node "<脚本路径>" run|discuss|review --plan <plan_id> --seat <序号> --brief "<说明.md>" --title "<短标题>" [--effort <强度>] [--file "<路径>[:起始行-结束行]"] [--scope "<路径>"]（协作方、等级、目录和组取自计划；审查的对象和材料也取自计划）
node "<脚本路径>" plan   --cwd "<项目目录>" --module image --cell <generate|draw> --route <1|2|3|4> --group <组名> --seat "<代号>" [--seat …] [--why "<选择理由>"]
node "<脚本路径>" image  --plan <plan_id> --seat <序号> --brief "<任务说明.md>" --title "<短标题>" --scope "<输出目录>" [--scope …] [--track "<路径>"] [--effort <强度>]
node "<脚本路径>" status [--run <run_id|last> | --group <组名> | --plan <plan_id>] [--limit n]
node "<脚本路径>" watch  [--run <run_id|last> | --group <组名>]
node "<脚本路径>" board  [--replay <对话 id|run_id|组名|all> [--speed <倍数>] [--maxgap <秒>]]（不带 --replay 是直播看板）
node "<脚本路径>" board --stop（关掉直播看板服务）
node "<脚本路径>" config [--cwd "<项目目录>"] [--format json|md]
node "<脚本路径>" check  [--agent <协作方>] [--format json|md]
node "<脚本路径>" models [--format json|md]
node "<脚本路径>" await-busy (--group <组名> | --run <run_id>) [--after 分钟]
node "<脚本路径>" cancel --run <run_id>
node "<脚本路径>" judge  --run <run_id> [--accept "<编号,…>"] [--partial "<编号,…>"] [--reject "<编号,…>"] [--same "<编号>=<run_id>:<编号>,…"] [--clear "<编号,…>"]
node "<脚本路径>" stats  [--module discuss|run|review|image] [--since <天数>]
node "<脚本路径>" assets <template|cut|check|diff|layers|patch|trace|capture|playback> …（各命令的参数见 references/assets-cli.md）
```

- 执行单席直派时，`--agent <协作方>` 只能从这一格的候选里选。不写时：这一格只有一个候选就用它，有一个必选就用它，否则必须写。这一格还有别的必选时，单席派发会被拒绝，要先建计划。格子是 `"claude code"` 时，只有用户配置里这一格本来就是 `"claude code"` 才能用 `--agent` 点名派出（结果标 `outside_cell`），项目配置关掉的不行；讨论和审查遇到这种格子时，用户点名的协作方照样写进计划的 `--seat`，计划标 `outside_cell`，推理强度用内置默认值。每个协作方能做哪些任务看 `capabilities.modes`：`api` 协作方能参加 `discuss` 和 `review`（只审文本，不能审 `visual`）；`opencode cli` 和 `pi cli` 能做 `review` 和 `discuss`，配置里写了 `run_access` 的还能做 `run`。升级前的旧代号（比如 `codex`）照样认，脚本会提示新代号。
- 用户点名要某个推理强度（比如"用 ultra 跑"）时，照常写 `--level`，再加 `--effort <强度>`：它只换推理强度，协作方还是按格子选。
- 用户点名要某个模型时，加 `--model <模型>`。只能换同一个提供方的模型：`codex cli` 和 `api` 协作方可以换成任意模型，`opencode cli` 和 `pi cli` 的新模型要和原来的有同一个 `提供方/` 前缀；换了模型的结果标 `model_overridden`。
- 交给谁、模型、推理强度、沙箱、审批、超时由配置文件决定；Codex 没有配置的项沿用它自己的 `~/.codex/config.toml`。拿不准当前设置时先运行 `config --cwd "<项目目录>"`。
- `plan`、`submit`、`status --plan` 的检查和输出见下面一节；`judge` 和 `stats` 见最后一节。

## check
检查环境能不能用：Node.js、Git，以及配置里的每个协作方，结果在 `agents.<代号>` 里。
- **Codex CLI**：能否启动、是否已登录；再按 Codex 自带的模型清单核对各格子配置的推理强度（不发请求），结果列在 `efforts` 里；按各类任务实际用的沙箱模式，用 `codex sandbox` 在沙箱里跑一条 echo（不调模型），结果列在 `sandbox` 里，`danger-full-access` 不进沙箱、不测。Windows 上沙箱起不来时，会顺带试 unelevated 沙箱，能用时写在 `fix` 里。
- **API**：key 是否设置，并发一个很小的请求确认能连通。
- **opencode**：能否启动、`opencode models` 里有没有这个模型，并发一个很小的请求确认能用；各格子给它配置了推理强度（variant）的，先按 opencode 的模型清单核对，清单里没有的直接判不通过，其余每个档位再各发一个小请求，结果列在 `variants` 里。
- **pi**：能否启动、模型清单里有没有这个模型，并发一个很小的请求确认能用；推理强度只按清单核对（pi 遇到模型不支持的档位不报错，会悄悄换成最接近的一档，发请求试不出来），结果列在 `efforts` 里。

总体 `ok` 只看 Node.js 和被格子引用到的协作方（包括图像格子）；没被引用的不通过只是报告出来，不影响使用。每项不通过时，结果里的 `fix` 写明该怎么处理，转告用户即可。

结果里的 `summary` 是总配置情况：`modules` 是每一格有哪些候选、什么模型和推理强度、是否必选（`required`）、检查是否通过（不通过的写了 `problem`），`agents` 是每个协作方用在哪几格（`used_at` 写成 `modules.<模块>.<格子>[序号]`），`warnings` 是值得注意的地方（没用到的协作方、明文写在配置里的 key、shell 权限用于执行或手画、讨论或审查没有只读沙箱的 Codex（`readonly_audited`）、失效的旧代号，以及旧版本留下、可以删掉的配置：已经不用的 `dispatch.max_seats`（`obsolete_max_seats`）、和 `api_key` 同时写了而不起作用的 `api_key_env`（`obsolete_key_env`）、旧的配置备份（`old_backups`）、给旧版插件看的 `levels` 说明行（`legacy_levels_note`，保留）。`config` 的输出里也有 `summary`，只是不带检查结果。

`config`、`check`、`models` 都接受 `--format md`：不输出 JSON，改为输出排好的 Markdown 表格，`/foreman:setup` 原样贴给用户。`check` 输出"环境"和"总配置"两段，`config` 只有"总配置"、没有检查列，`models` 输出全部模型的表。默认是 `--format json`。要把总配置告诉用户时，用 `check --format md`（或 `config --format md`）的输出，不要自己排表。

## plan、submit、image 和 status --plan
执行一次派几个席位时先建派发计划；讨论、审查和图像任务不论几席都要建计划：

```bash
node "<脚本路径>" plan --cwd "<项目目录>" --module <discuss|run|review> --cell <simple|normal|complex> --group <组名> --seat "<代号>[=<角色名>]" [--seat …] [--why "<选择理由>"] [--host-role "<角色名>"] [--count-why "<理由>"] [--target <diff|files|claims|visual>] [--file "<路径>"]… [--uncommitted | --base <分支> | --commit <sha>]
node "<脚本路径>" submit --plan <plan_id> --report "<报告.json>" [--model <模型>] [--author]
node "<脚本路径>" plan --cwd "<项目目录>" --module image --cell <generate|draw> --route <1|2|3|4> --group <组名> --seat "<代号>" [--seat …] [--why "<选择理由>"]
```

- 校验都在发出任何请求之前做完：格子没关（不是 `"claude code"` 或 `null`）；每个席位都在这一格的候选里（旧代号会换成新代号）；必选都有席位；执行和手画（draw）席位能执行；`visual` 审查的席位能看图（`reads_images`）；出图（generate）席位能出图。
- 3 级审查计划还检查补漏席（角色为 `补漏` 或 `gap`）的基础模型：要和其余每一席都不同，否则拒绝。同一个模型的各种写法算同一个：去掉 `提供方/` 前缀、Bedrock 的 `…anthropic.` 前缀，Claude 的小数版本号写成连字符（`claude-fable-5.1` 即 `claude-fable-5-1`），以及插件价格表 `prices.json` 的 `aliases` 里记下的官方别名（比如 `deepseek-v4.1-flash` 即 `deepseek-flash`）。`stats` 按同一套规则把同一个模型合成一行。
- 讨论和审查计划另外检查外部席位数（3 级审查不算补漏席，也就是角色为 `补漏` 或 `gap` 的席位；其他模块和等级里这个角色名照常计数）：要等于 `min(这一级的 seats, 这一格能用的不同候选数)`，`visual` 审查只算能看图的候选。不一致时要带 `--count-why "<理由>"`，否则拒绝；`--count-why` 用在别的模块上也拒绝。计划里记 `seat_target`（上面算出的数，`outside_cell` 计划为 `null`，也不做这项检查）和 `count_why`（没写为 `null`）。这项检查只在建计划时做，启动席位时不再检查，配置改了以后已有的计划照样能启动。
- 讨论和审查计划自带 Claude Code 席：计划顶层的 `host`（`seat` 为 0，`role` 来自 `--host-role`，没写为 `null`），外部席位仍在 `seats` 里、从 1 编号。`--host-role` 写在别的模块上会被拒绝。讨论和审查不带 `--plan` 时 `discuss`、`review` 直接报错。用户配置里写成 `"claude code"` 的讨论或审查格子也能建计划（用户点名派出时用）：计划标 `outside_cell: true`，`required` 为空，每席的协作方要支持这个模块，推理强度用内置默认值；项目配置关掉的格子仍然拒绝。没有 `host` 的旧计划照旧只数 `seats`，启动时也不要求提交报告。
- 图像计划另外检查：
  - `--route` 必须写，只能是 1–4，而且和格子对得上：① 位图只用 generate；② 位图 + 矢量混合用 generate 和 draw；③ 纯矢量、先出参考图用 generate（只出参考图）和 draw；④ 纯矢量 / 代码只用 draw。计划只管一格，所以路线 ④ 的 draw 计划不看 generate 格子里的必选。别的模块写 `--route` 会被拒绝。
  - generate 的席位不带角色（`--seat 代号=角色` 会被拒绝）：画面要求由 Claude 统一写进任务说明。
  - 确认凭据：插件的钩子（`hooks/record-answers.mjs`，PreToolUse 和 PostToolUse，只认 AskUserQuestion）把问题或 header 里带"图像路线"（英文 "Image route"，大小写不限）的弹窗按 Claude 会话记在配置目录下的 `answers/<会话 id>.jsonl`：弹出时记一行 `asked`，用户回答后记一行 `answered`（带 `answers`，键是问题原文，值是选中的选项 label，选 Other 时是用户写的字）。别的弹窗不记；30 天前的文件会被清掉。`plan --module image` 取环境变量 `CLAUDE_CODE_SESSION_ID` 对应的文件，看最近一次路线弹窗：没有会话 id、没有路线弹窗、最近一次没有回答（取消了或还没选）、回答不是以 ①–④ 开头的某个选项，或者选的路线和 `--route` 不一致，都不建计划。一次弹窗问了几个交付物的路线时，其中任何一条和 `--route` 一致都算。同一次回答可以建几份计划。
- 审查计划在建计划时就定下审查对象和材料：`--target`、`--file` 和范围参数只能写在审查计划上（别的模块写了会被拒绝），校验和单席 `review` 一样，`diff` 没有改动时不建计划。计划的 `review` 记下这些参数和材料指纹（非 git 目录里的 `diff` 没有指纹，为 `null`）。`diff` 审查计划里不是 Codex 的席位，按它运行时的预算（opencode、pi 20 万字符，API 30 万字符）放不下去掉生成文件后的材料时，建计划时就拒绝，报错写明是哪几席、各多少字符，以及换成 Codex 席或缩小范围；不会等到启动这一席才被拒、留下一份永远等不到结果的计划。
- `diff` 审查时，opencode、pi 和 API 拿到的是脚本用 git 算好的补丁；Git 属性 `linguist-generated` 为 `set` 或 `true` 的生成文件只列在清单里，不放补丁。opencode、pi 的清单和补丁超过 20 万字符时，只有新侧为工作区的 `uncommitted`、`base` 范围才把放不下的补丁改成行号，让它们在项目目录里直接读取：只列新侧行数大于 0 的段，没有这些段时注明只有删除、改名或权限变化（新文件读全文，删除的文件注明读不到原文）。`commit` 范围不能按行号读取历史版本，过滤生成文件后仍超限就拒绝；只剩清单和位置说明仍超限也拒绝。API 不能读文件，去掉生成文件后整个提示仍超过 30 万字符就拒绝。遇到上限可以用 `--commit` 按提交分开审，或换成 Codex（它自己读改动，没有这个限制）。材料指纹仍包含生成文件，生成文件变化也会使原材料失效。
- 通过后写进记录目录的 `plans/<plan_id>.json`，输出计划内容：`plan_id`、`module`、`cell`、`group`、`seats`（每席的序号 `seat`、`agent`、`role`、`model`、`effort`、`required`）、`required`、`why`、`review`（只有审查计划有；没写范围参数的 `diff` 审查记成 `uncommitted: true`）、`route` 和 `route_confirmation`（只有图像计划有：路线号，以及凭的是哪次回答：`tool_use_id`、问题、回答和回答时间），以及 `file`（计划文件）和 `commands`（每一席的启动命令；里面的说明文件、标题、范围和输出目录是占位符，换成实际的再用）。
- 每一席用 `run / discuss / review --plan <plan_id> --seat <序号> --brief …` 启动：协作方、推理强度、目录、等级和组都取自计划，不能再写 `--agent`；要换推理强度加 `--effort`，换模型加 `--model`（规则同单席派发）；执行席位照常要 `--scope`；审查席位不再写 `--target`、`--file` 和范围参数，脚本按计划重算一次材料，指纹和计划里的不一致就拒绝启动（材料在建计划之后变了），这时按现在的材料重建计划。启动时按当前配置把整份计划重新校验一遍：配置改过（包括这一席的模型或推理强度变了）、必选变了或者项目关了这一格，都会被拒绝，这时重新建计划。同一席只能启动一次，返工用 `resume`，续接沿用原来的计划和席位；计划里的席位续接时不能换等级。审查席没交回有效结果（失败、卡死、取消，或者 `verdict` 为 `incomplete`）时，可以用同一条命令重新启动这一席；这一席还有一轮在运行、或者已经交回有效结果时会被拒绝。执行、讨论和图像席位一般不能重新启动；只有这一席没有一轮交回有效结果，而且最新一轮既没有会话 id、记录目录里也没有 `messages.json`（第一轮还没拿到会话就失败了，没法续接）时，才可以用同一条命令重新启动。同一席的各轮按 run id 排先后（run id 在登记锁里生成，严格递增）。
- 图像计划的席位用 `image --plan <plan_id> --seat <序号> --brief … --title … --scope <输出目录>` 启动：不写 `--level`（格子由计划决定），`--scope` 至少给一个（同组任务的写入范围检查要用；工作目录里被 `.gitignore` 忽略的输出目录会自动并入 `--track`，改动追踪才看得到，工作目录本身和没被忽略的目录不并入），其余参数（`--track`、`--effort`、`--model`、`--add-dir`、`--timeout`、`--stall`）和 `run` 一样。内部按执行任务跑：快照、执行报告、改动归属、`generated_images`、`image_calls` 都和 `run` 相同，记录里 `mode` 是 `run`、`kind` 是 `exec`，另有 `module: "image"`、`cell`、`step`（就是格子）和 `route`，`level` 为 `null`。续接用 `resume --run <run_id> --brief … --reason <rework|answer|recover>`，不写 `--level`：从图像格子选派，不查执行的等级，也不再核对确认凭据。
- `submit` 登记 Claude Code 席的报告：
  - 报告是 JSON，讨论计划按 `discuss.schema.json`、审查计划按 `review.schema.json` 校验，不合格就报错并列出问题。计划不是讨论或审查计划、或者没有 `host`（旧计划）时拒绝。
  - 在登记锁里检查并登记，和外部席启动用同一把锁。讨论每轮交一份：这是第几轮按已提交报告里最大的轮次加 1 算，不超过 `dispatch.discuss_max_rounds`，`parent` 指向上一份报告。锁内有读不出的记录（可能就是一份报告）时拒绝登记，免得算错轮次。审查只提交一次，并按计划重算材料指纹，和计划不一致就拒绝。
  - 记录目录里写 `meta.json`（`mode: "submit"`、`participant: "host"`、`agent: "claude-code"`、`agent_type: "host"`、`model`（`--model` 的值，没写为 `null`）、`model_source`（写了 `--model` 时为 `"self_reported"`）、`plan`、`seat: 0`、`role`、`round`、`parent`、`author`、`report_sha256`、`submitted_at`，审查另有 `review_fingerprint`；`status` 直接是 `done`，没有进程号）、报告快照 `report.json` 和 `result.json`（`report` 是报告内容，`usage` 为 `null`）。
  - 输出 JSON：`run_id`、`plan`、`seat`、`round`、`submitted_at`、`report_sha256`、`run_dir`，以及 `commands`（第 1 轮是各外部席的启动命令，讨论后面几轮是各席的续接命令）。后面几轮另有 `resumable`（能续接的每一席：`seat`、`agent`、`model`、`run_id`）和 `note`：脚本不知道模型档位，广度席不续接，由 Claude 只挑要进下一轮的席位运行。
  - 准入：带 `host` 的计划，外部席启动或续接时要求 Claude Code 席已经提交了这一轮的报告：审查要有一份，讨论要有一份轮次不小于这一轮的报告（第 2 轮要有第 2 轮的报告；同一轮多出来的不算）。没有就拒绝，提示先 `submit`。审查席失败后重新启动不受影响（报告已经在）。计划文件被删了照样检查：这份计划提交过报告，就按有 Claude Code 席处理；计划文件读得到却解析不了时拒绝启动。
  - 报告记录不算运行中、不占并发名额、不出现在会话开始时的未完成提醒里；`resume` 和 `cancel` 会拒绝它；`judge` 照常可用，`--same` 可以和同一计划的外部席互连。
- 计划不占并发名额；每一席启动时照常按它的协作方计并发。
- `status --plan <plan_id>` 输出 JSON：每一席的 `run_id`（最新一轮）、`runs`（这一席所有轮次）、`status`（没启动过是 `not_started`）、`ok`（结束后才有：正常结束并交回了有效结果；审查以结构化报告为准，`verdict` 为 `incomplete` 的不算，没有报告时只有 Codex 原生审查的文字算）；`state` 为 `complete`（要交回有效结果的席位都交回了：执行和图像计划是每一席，讨论和审查计划是必选席位；讨论和审查计划没有必选时，每一席都结束、至少一席有效）、`incomplete`（要交回有效结果的席位有一席结束了却没有有效结果，比如失败、取消、额度用完、等人回答）或 `pending`；`missing` 列出要交回有效结果、但还没有的席位和它的状态，`missing_required` 只列其中的必选；`running` 列出还在运行的席位（`seat`、`agent`）：`state` 为 `complete` 时非必选的席位也可能还在跑；哪几席是必选以计划的 `required` 名单为准；每一席的 `stale` 是它最新一轮审查结果里的 `stale`（不是审查或还没有结果时为 `null`），图像计划另有 `route`。带 `host` 的计划另有 `host`：`seat`（0）、`role`、`status`（`submitted` 或 `missing`）、`rounds`（每份报告的 `round`、`run_id`、`submitted_at`、`report_sha256`、`model`、`author`）和 `before_external_start`（第一份报告是否早于这份计划里最早的外部任务启动；还没有外部任务时为 `null`）。Claude Code 席没提交报告时 `state` 不会是 `complete`，`missing` 里有一项 `seat: 0`、`agent: "claude-code"`、`status: "not_submitted"`；`missing_required` 只列外部必选。讨论和审查计划还照抄计划里的 `seat_target` 和 `count_why`（旧计划没有这两项时为 `null`）。审查期间材料变了的席位，实时查看和 `status --group` 会在这一席和计划那一行写"material changed during the review (stale)"，计划照样算完整。实时查看和 `status --group` 的计划行按这份计划在同组所有 Claude 会话里的记录算，换了会话续接也不会把别的席位误报成没启动。
- 补漏席是角色为 `补漏`（英文插件写 `gap`）的席位。它用的协作方没标必选、计划里又有必选席时，`state` 只看必选席，补漏席还没跑完计划也会显示 `complete`。所以另有 `gap_unfinished`：还没交回有效结果的补漏席（没启动、还在运行、失败或结果无效），每项是 `seat`、`agent`、`status`，没有时为空数组；实时查看和 `status --group` 在计划那一行加一句"gap seat not finished: …"，写明是哪一席、处于什么状态（not started、running、no valid result，或者 failed 这类状态词）。

## models
列出本机 Codex、opencode、pi 自带的模型清单（含每个模型支持的推理强度），以及每个 API 协作方的接口列出的模型名（不含推理强度），并核对配置里的模型在不在清单里、不在时给出最接近的写法。只读，不发模型请求。用户问有哪些模型可选、或者要换模型和推理强度时用。

## 结果字段
`run`、`image`、`resume`、`discuss`、`review` 的结果以 JSON 打印到 stdout，主要字段：
- `report`：协作方的结构化报告：执行报告、讨论报告或审查报告。审查报告有 `verdict`（`issues_found` / `no_issues` / `incomplete`）、`findings`（每条有 `id`、`location`、`issue`、`trigger`、`severity`、`evidence`、`suggestion`，为空是合法结果）、`coverage`（`checked`、`not_checked`）和 `unverified`。Codex 原生审查（审 `diff`、不带说明也不带 `--file`）没有结构化报告：`report` 为 `null`，意见是 `last_message` 里的英文文字。报告不是合法 JSON 时（opencode、pi、API 修复一次后仍不合格），也只有 `last_message`。
- `last_message`：没有 `report` 时，协作方最后一条回复的原文，只保留前 8000 字，全文在 `run_dir/last-message.txt`。
- `changes`：脚本追踪到的工作目录内改动。每个文件标有 `by`：`agent` 表示有工具事件证明是执行的协作方改的（改名前的记录里写作 `codex`）；`reported` 表示只有它在报告里自称改过，常见于用命令或脚本写的文件；`unknown` 表示两样都没有。报告里写成目录的（以 `/` 结尾，或者在磁盘上是目录）按前缀算，目录下被追踪的文件都记 `reported`；只有这个前缀下一个被追踪的文件都没有时，`notes` 才提示它不在追踪范围内（工作目录本身不算）。标了 `group_run` 的落在同一工作目录下另一个执行任务的写入范围里（不分组和会话），不在这个任务自己的范围和 `--track` 里，而且那个任务的运行时间和这个任务有重叠（区间是开始到结束，还在跑的算到现在，旧记录没有结束时间的按最后活动时间算；这个任务开始前就结束了的不认领）；两边的范围都覆盖、或者有几个别的任务都覆盖的，仍记 `unknown`；同一席的几轮（续接、同一计划同一席重启）算一个任务，记到它最新的一轮上。个数在 `group_total`；实时查看的结束行和组面板不把它们算进"of unknown origin"，另写"N from other runs in the group"。快照按文件的原始字节比较：不按项目 `.gitattributes` 转换换行，也不跑 clean 过滤和 ident 等，所以项目改了这些设置时，字节没变的文件不算改动，`diff.patch` 里的换行和磁盘上一致。
- `changes.outside_cwd`：仅执行任务记录工具事件或报告提到的工作目录外写入，每项是 `{ path: <绝对路径>, by: "agent" | "reported", in_scope: <是否在 --scope / --track 内> }`；同一路径只列一次，工具事件优先，最多 30 条，`outside_cwd_total` 是完整条数，没有时两个字段都不加。判定不依赖快照，`--no-snapshot` 或快照失败也照常记录；`in_scope: false` 时写入 `warnings`，范围内的只进 `notes`，说明这些改动不在快照和补丁里，不再归为“报告了但没追踪到”。讨论和审查仍按 `readonly_violation` 处理。
- `notes`：提示信息，比如归属未知的改动、协作方报告了但没追踪到的文件、Codex 的沙箱启动不了命令、opencode 中途报错后自动重试并正常结束（见下）。
- opencode 中途报错（比如流超时 "Timed out waiting for response data"）、自己重试后最后一步正常结束（`step_finish` 的 reason 是 `stop`），或者事件流以一段写完的回复结尾（opencode 有时写完回复就退出、不发 `step_finish`）时，不算失败：错误原文写进 `notes`，不进 `errors`，opencode 的退出码不是 0 也一样。这时回复可能被拆成了几段，最后一段不是合格的报告，就照常发一次修复请求，让它把完整报告重发一遍；不拼接几段消息。错误之后没有正常结束的，照旧记成 `failed`；恢复之后修复请求又失败、或者任务被取消、超时的，恢复过的错误也照实写进 `errors`，不写这条提示。
- `warnings`：要注意的问题，比如审查期间材料又变了；普通执行任务出了图（"出图没有走图像模块"）；路线 ③、④ 的手画任务出了位图（路线 ③ 的位图只该在出图那一步出参考图）；路线 ③、④ 的手画任务新写或改过的 SVG 里嵌了位图（`<image>`，带命名空间前缀的 `<svg:image>` 也算；只查这一席自己的改动；没有快照、或者 `--scope` 在工作目录外时，追踪不到的地方只查执行事件和报告里列出的 SVG，`notes` 里会说明）；收尾时 `meta.json` 一直写不进（多半是备份或同步软件占着它，约 15 秒后放弃），这时它停在上一次写好的内容，结果照常在 `result.json` 里（这条提示只在打印出来的结果里，`result.json` 里没有）。
- `questions` 和 `needs_decision`：协作方要人回答的事，见 `references/recovery.md` 的"协作方要人回答时"。
- `session_id`、`run_dir`：`run_dir/diff.patch` 是这个任务的补丁（`by` 为 `agent`、`reported`、`unknown` 的文件），`run_dir/diff.all.patch` 是两次快照之间观测到的全部改动（另含标了 `group_run` 的文件）；`changes` 里的 `shortstat`、`patch_bytes` 对应前者，`all_shortstat`、`all_patch_bytes` 对应后者。审查的补丁在 `run_dir/review.patch`。`changes.unstable_files` 列出拍快照时一直在被改写、没能放进开工或结束快照的文件（`path`、`phase`）：它们的改动没法比较，不在两份补丁里；超过 20 个时只列前 20 个，`changes.unstable_total` 是总数，完整列表在 `changes.unstable_list` 指向的文件（记录目录里的 `unstable-files.json`）。拍快照总共最多用 60 秒，到时还没确认完的文件也列进 `unstable_files`，并且 `changes.incomplete` 为 true；只读审计的任务要求快照完整（有拍不稳的文件、或者用完了 60 秒，都算不完整），开工快照不完整时不启动，结束快照不完整时记为失败。
- token 消耗：`usage` 是本次调用的输入、缓存、输出 token（`usage_scope` 为 `session_total` 时是整个会话的累计量）；`last_request` 是最近一次请求的用量和模型上下文窗口；`rate_limit` 是 Codex 额度的已用比例；`quota_resets_at` 是额度预计恢复的时间。Codex 的用量读自它自己的会话记录，每次请求一完成就有累计值，所以命令执行期间取消也记得到。被取消或超时的任务只记得到终止前已经完成的请求的用量（正在进行的那次，厂商不报用量），一次都没完成时 `usage` 为 `null`，`notes` 里有说明；超时的任务 `errors` 第一条写明超过了几分钟的总时限；`errors` 写明是 `cancel` 命令、用户在实时查看里按 x，还是调度进程收到了终止信号。`cancel` 怎么处理各种任务见下面的"cancel 和 status"。API 协作方的厂商一次都没返回用量时，`usage` 和 `usage_scope` 都是 `null`，`notes` 里有说明，`stats` 把这一轮计入 `missing_runs`。`output_tokens_per_s` 是这一轮的平均输出速度：这一轮的输出 token（含推理）除以这一轮的用时 `duration_s`，含拍快照、跑命令、等厂商响应和报告修复请求的时间，不含本地排队等名额的时间。它和网页看板上的生成估速（只估算生成时间）口径不同，两者不能直接比。终端用量行写成 `run avg N tok/s`；取消、超时、卡死的轮次只记到最后一次完成的请求，速度偏低，后面标 `(partial usage)`。只在 `usage_scope` 为 `this_run`、有输出、时长不为 0 时给出，否则为 `null`。
- `agent`、`model_shown`、`effort`：这次交给了哪个协作方、实际用的模型和推理强度。`model_overridden` 为 `true` 表示这次用 `--model` 换了模型；`outside_cell` 为 `true` 表示格子是 `"claude code"`、这次是用 `--agent` 点名派出的。
- `module`、`cell`、`plan`、`seat`、`role`：这次属于哪个模块和格子；用计划启动的，还有计划的 `plan_id`、席位序号和角色（不是计划派出的为 `null`）。图像任务另有 `step`（generate 或 draw）和 `route`（1–4），`level` 为 `null`。API、opencode 和 pi 协作方的讨论和审查结果没有改动追踪（`changes.available` 为 `false`）；API 协作方的 `files` 列出附带了哪些文件，所有协作方的结果都有 `cost_usd`（按模型官方 API 价格算的美元费用，模型不在价格表里时为 `null`）和 `cost_source`（`api_price` 或 `unknown`），`status` 和实时查看会把它接在 token 用量后面显示；opencode 和 pi 自己报的费用另存在 `reported_cost_usd`，只留档。
- `isolation`、`run_access`：opencode 和 pi 做执行时，写明没有系统沙箱（`tools`）和这次的权限档位。
- `generated_images`：这一轮新出现的图片原文件（Codex 的在它的图片目录里）。能出图的适配器都通过同一个接口提供这一项和 `image_calls`。
- `viewed_images`：这一轮 Codex 用 view_image 打开过的图片，`[{ path, ok }]`（读自 Codex 的会话记录；路径是变量、解析不出来时为 "unknown"；`ok` 为 `true` 表示图片读到了，`false` 表示调用了但没读到，`null` 表示没找到结果，或者一段代码里看了几张图、读到的张数对不上，分不清是哪一张没读到）。补丁工具（apply_patch）里写到的 view_image 不算。实时查看的时间线上会出现"Opened image …"。`commands_executed` 不包括它。
- `image_calls`：这一轮每次出图实际传的参数和结果（读自 Codex 的会话记录）：`transparent_background`、`referenced_image_paths`（没传为 null；用变量传、解析不出来，或者几次调用分不清各自对应哪张图时为 "unknown"）、`num_last_images_to_include`（同样可能是 "unknown"）、`status`（代码里写了调用、但没执行到时为 "not_run"）、`saved_path`、`failure`。任务说明里写了 `referenced_image_paths`、但这一轮的调用都没传参考图时，`warnings` 会提示。
- `review_target`、`review_scope`：审查对象（`diff`、`files`、`claims`、`visual`），以及范围、文件数和材料指纹；`review_scope.kind` 对 `diff` 是 `uncommitted` / `base` / `commit`，对其他对象就是对象名。非 git 目录里的 `diff` 没有 `review_scope`。`native_review` 为 `true` 表示这次走的是 Codex 原生审查。`diff` 带了 `--file` 时，指纹也包含附件的内容；超过 1 MiB 的未跟踪文件不附正文，但内容哈希算进指纹。
- `stale`：审查结束时重算材料指纹，和开始时不同为 `true`（这份审查可能没覆盖最新的版本，`warnings` 也会提示），相同为 `false`，没有材料指纹时为 `null`。
- `readonly`：讨论和审查的只读保障：`tools`（opencode、pi、API）、`sandbox`（Codex 在只读沙箱里）或 `audited`（Codex 没有只读沙箱，只靠规则和事后对比快照）。
- `readonly_violation`：讨论或审查里有证据的写入，列出 `[{ path, by }]`；这时 `status` 为 `failed`，`errors` 里有说明，改动没有自动还原。快照可用时，自称改过、但不在快照范围内的文件（被 `.gitignore` 忽略的、在快照排除的目录里的、在工作目录外的）也算，`by` 为 `reported`；在快照范围内、快照又没看到变化的不算。自称改过的是目录时，目录下（包括开工时有、后来被删掉的）有被忽略、又没被 `--track` 覆盖的文件，就算不在快照范围内；判断快照范围的命令出错时，自报的都算。

## cancel 和 status
- 怎么算"在运行"：`meta.json` 的状态是 `running`、调度进程的进程号还活着，并且这个进程不晚于任务的 `started_at` 启动（调度进程自己写 `started_at`，复用这个进程号的程序一定启动得更晚）。没写完结果就被杀掉的旧任务，进程号以后分给了别的程序时，按中断算，不再占并发名额，也不算进 `stats` 的 `running_skipped`。`status`、`stats`、实时查看、并发名额检查和会话开始时的提醒都这样判断：先挑出状态是 `running`、进程号又还活着的几条，一次查完它们的启动时间（Windows 上用一次 PowerShell，不弹窗），没有这样的任务时不查；同一个进程里的结论会缓存，实时查看不会每秒都去查。派活时在拿登记锁之前查；拿锁前就有、当时没核对上的记录（很少见）才在锁内补查；拿锁之后才登记的任务直接算在运行。锁内读不出的 `meta.json` 合计最多重读约 1 秒，仍读不出就不启动、报错列出这些文件：确认那个任务早已结束、只是记录坏了，把它的记录目录移走才能继续派活；会话开始时的提醒最多查 3 秒。查不到启动时间时，照旧算在运行。
- `result.json` 只在任务结束时写。它写好了，`status`、实时查看、`cancel` 和会话开始时的提醒就都按它的状态算，不看调度进程的进程号：收尾时写不进 `meta.json` 的任务，磁盘上的 `meta.json` 会一直停在 `running`，而这个进程号以后可能分给别的程序。`cancel` 遇到这种任务、调度进程又已经退出时，顺手把终态写回 `meta.json`；只读的命令不写。
- `cancel --run <run_id>` 输出一段 JSON，`ok` 表示这次有没有做成：
  - 运行中的任务：先核对这个进程号还是不是当初的调度进程（比对进程的启动时间，Windows 上用 PowerShell 查，不弹窗），再留终止标记，最多等 30 秒让它自己停下、写好结果（`ok: true`，`status` 是它自己写的状态）。等不到时再核对一次，确认是同一个进程才强行结束它，补写一份最简结果（带上会话记录里读得到的用量），输出 `forced: true`。
  - 查不到进程的启动时间时不强行结束，记录也不动：`ok: false`、`status: "running"`，`error` 说明怎么手动处理。
  - 进程号已经属于别的程序（它在任务开始之后才启动），或者等待期间调度进程自己退出、没留下结果：不结束任何进程，只把任务标成已处理（`status: "interrupted"`、`dismissed: true`），`note` 说明是哪种情况。
  - 已经结束、没正常完成的任务（`interrupted`、`stalled`、`timeout`、`quota_exhausted`、`needs_input`）：标成已处理（`dismissed: true`），会话开始时的提醒不再列它。
  - 其他已经结束的任务（比如 `done`、`failed`、`cancelled`）：`ok: false`，`note` 说明没有可取消的。
  - 写不进 `meta.json` 时：标成已处理的返回 `ok: false` 和 `error`；强行结束的仍返回 `ok: true`，带 `warning`。
- 正常结束（`done`）、却没交回有效结果的任务（执行、图像和讨论没有合格报告；审查的 `verdict` 为 `incomplete`，或者没有报告、也不是 Codex 原生审查），`status` 和实时查看记成 ✗ "no valid result"，组汇总算失败，和 `status --plan` 里的 `ok` 判断一致。同一计划同一席重新启动过的，前面那几轮在 `status --group` 的汇总里算"已续接"，实时查看只显示最新的一轮。
- `status` 列表不列出读不了 `meta.json` 的任务（被别的程序占着、不许别人读，或者内容不完整），末尾一行写明有几个。`status --run <run_id>` 读不了 `meta.json`、但读得出 `result.json` 时，输出 `result.json`，在 `warnings` 末尾注明；两个都读不了时报错。
- 标成已处理、又没有结束时间的任务，用时算到运行目录里除 `meta.json` 和 `verdict.json` 以外最晚修改的那个文件（标记已处理会改写 `meta.json`，`judge` 往往很久以后才写 `verdict.json`）。

## judge 和 stats
审查或讨论结束、Claude 核实完以后，用 `judge` 记下每条意见的去留；`stats` 把这些记录和用量汇总成各模型的本地实测。

```bash
node "<脚本路径>" judge --run <run_id> [--accept "F1,F3"] [--partial "F4"] [--reject "F2"] [--same "F1=<run_id>:F3,…"] [--clear "F5,…"]
node "<脚本路径>" stats [--module discuss|run|review|image] [--since <天数>] [--group <组名>] [--plan <plan_id>]
```

**judge**
- 只记审查和讨论（执行和图像任务会被拒绝），任务要已经结束。编号以字母开头，只用字母、数字和 `. _ -`，最长 32 个字符，几个编号用逗号隔开。
- 编号：带结构化报告的审查用报告里的 `id`（F1、F2…），不在报告里的会被拒绝；讨论用 Claude 在决策记录里给观点编的号（P1、P2…），没有结构化报告的审查用 Claude 在汇报里给的编号，这两种不校验。一个编号只能有一种去留：`accept`（成立）、`partial`（部分成立）或 `reject`（不成立，审查里就是误报）。
- 同一个问题：几席报的是同一个问题时，在其中一席加 `--same "<本席的编号>=<另一席的 run_id>:<那一席的编号>"`。链接不分方向、可以传递，写在一边就够。只能连到同伴：同一份计划里的另一席；没有计划时，是同一个任务组、同一个 Claude 会话、同一个模块的任务。同一席（或同一条续接链）的另一轮不算同伴：同一个参与方后面几轮重复的观点沿用原来的编号。等号左边的编号要有去留（这次一起写，或者以前记过）；右边是带结构化报告的审查时，编号要在它的报告里。右边的任务还在运行时拒绝（它的编号还定不下来），等它结束、核实完再连。
- 删掉记错的条目：`--clear "<编号,…>"` 删掉这些条目，连同它们的 `--same` 链接；编号要已经记过，同一个编号不能同时写在 `--clear` 和去留或 `--same` 里。别的任务里指向它们的链接不动，`stats` 会忽略找不到的链接。全部删完时 `verdict.json` 也删掉，这个任务回到没记过去留的状态（结构化报告是 `no_issues` 的审查轮次重新按 0 条自动计入）。
- 结果写进这个任务记录目录的 `verdict.json`（先写临时文件再改名）。同一个任务同时只有一个 `judge` 在写：后来的最多等 5 秒，还拿不到就报错退出、不写文件。锁是 `verdict.json.lock.<代号>` 这组文件里代号最大的那个，释放时留下 `.done` 标记；持有它的进程已经不在时，下一个 `judge` 直接接管，不会删别人还拿着的锁。没权限探测的进程（比如在管理员终端里跑的）也算还在。锁文件内容读不出，或者持有者的进程号已经被别的程序复用时，等到上限报错，按提示删掉那个锁文件即可：脚本不拿时间去猜进程身份，免得时钟一跳就抢走活着的锁。登记锁（记录目录下的 `.start.lock.<代号>`）是同一套做法。两把锁拿到以后，还按旧协议占着旧版插件认的 `verdict.json.lock` / `.start.lock`，新旧版本同时运行时的互斥和旧版之间一样。再次运行只改这次写到的编号：写到去留的，覆盖原来的去留；`--same` 写到的，链接整个换成这次给的；其余条目不动。
- 输出 `verdict.json` 的内容（`run_id`、`module`、`plan`、`seat`、`group`、`claude_session`、`agent`、`model`、`updated_at`，以及 `items`：每条的 `verdict`、`same_as`、`at`），外加 `file`（文件路径；`--clear` 删完、文件被删掉时为 `null`）、`unjudged`（报告里还没记去留的编号；没有结构化报告时为 `null`），给了 `--clear` 时还有 `cleared`（这次删掉的编号）。

**stats**
- 不改任何记录，读记录目录里的全部任务。读不了 `meta.json` 的任务，以及父任务读不了、归不了席位的续接，记在 `totals.unreadable`；还在运行的轮次记在 `totals.running_skipped`；根本没调用协作方就失败的席位（结果里 `not_started` 为 true，比如开工前拍快照失败）记在 `totals.not_started`（没有时不出现）；这些都不进统计，根任务还在运行的整个席位不算。
- 席位：一个没有父任务的任务，加上它所有的续接（讨论的后续轮次、返工、回答问题），算一个席位。`--since <天数>` 按这个根任务的开始时间过滤，`--module` 按根任务的模块过滤（旧记录没有 `module` 的按 `kind` 推断），`--group`、`--plan` 按根任务的组名和计划过滤（几个会话并行时只看一批；这时 `totals.running_skipped` 也只数这一批，`totals.unreadable` 分不出组，照旧全数）。
- 按（基础模型，模块）分行。基础模型是模型名去掉最后一个 `/` 以前的提供方前缀、再转小写，所以经 opencode、pi、api 接入的同一个模型合成一行。席位数和返工记在根任务的模型上；每一轮的用时、用量、费用和去留记在那一轮自己的模型上（返工升级时可能换了模型）。Claude Code 席的报告单独成行（`participant: "host"`、`self_judged: true`，有自报模型时一并列出），按"计划 + 席位 0"算一席，不和外部模型行合并，不计用量、费用和 `missing_runs`；算"只有它发现"时它照常参与重叠判断，外部席位的这项数字因此更真实。`notes` 里写明它的去留是自评，不能和外部席位直接比，也不要据此改模型档位。
- 每行的字段：
  - `seats`、`runs`：席位数和轮数。
  - `findings_reported`：审查报告里一共报了多少条（只算审查）；`judged_runs`、`judged`：记过去留的轮数和条数（结构化报告是 `no_issues`、一条都没报的审查轮次不用 `judge`，自动算作记过、0 条）；`accepted`、`partial`、`rejected`：成立、部分成立、不成立的条数。
  - `unique`：只有这个模型发现、核实成立（含部分成立）的问题数。同一席位各轮里编号相同的条目算同一条，同伴里的条目再按 `--same` 连成一个个问题，一个问题只由这一个基础模型的席位报出，就给它记一条。只在同一份计划（没有计划时是同一个任务组和 Claude 会话）里有两个以上不同的基础模型都记过去留时才统计；`unique_basis_runs` 是参与统计的轮数，一轮都没有时 `unique` 为 `null`。
  - `rework`（只对执行和图像，其他模块为 `null`）：`seats`、`reworked`、`rate`。一席曾被续接要求修正或补齐原任务的交付（`resume --reason rework`，兼有回答问题的也算），就算返工过，每席最多算一次；`answer`（只回答问题、补材料或给决定）和 `recover`（断点续跑）的续接不算。没有声明原因的旧续接沿用旧规则推断：上一轮正常交回报告（报告是 partial 的也算）、不是交回问题的才算返工。同一计划同一席重新启动的几条记录算同一个席位。
  - `rework_basis`（只在执行和图像行）：`inferred_seats` 是至少有一次续接没有声明原因、用了旧规则推断的席位数，`inferred_reworked` 是没有声明过 `rework`、只靠推断记成返工的席位数。`seats - inferred_seats` 个席位的每次续接都有声明。
  - `duration_s`：`total`（各轮用时之和）、`median_per_seat`（没有运行中的轮次、每一轮都有用时的席位，按席位总用时取中位数）、`missing_runs`（没有用时的轮数）。
  - `tokens`：`input`、`cached_input`、`output`，有用量的轮数 `runs`，缺失的轮数 `missing_runs`。记的是会话累计（`usage_scope` 为 `session_total`）的续接，只算这一轮新增的部分。Codex 的轮次没记用量、又是这个会话的最后一轮（后面没有任何续接，正在运行的也算）时，从 Codex 自己的会话记录补读；读不到的计入 `missing_runs`，不当成 0。
  - `output_tokens_per_s`：平均输出速度，只用同时有用量和用时的轮次（输出 token 之和除以用时之和），口径和结果里的同名字段一样（含跑命令和等待的时间，和网页看板的生成估速不能直接比）；没有这样的轮次时为 `null`。
  - `speed_basis`：速度用到的轮数 `runs`、秒数 `seconds`、输出 token `output_tokens`，以及排除的轮数 `excluded`：`no_usage`（没记用量）、`no_duration`（没有用时）、`mixed_session_total`（前一轮缺用量，这一轮的会话累计差值里混着那一轮的输出）。取消、超时的轮次不排除，它们的速度偏低。
  - `cost_usd`：`total`、`runs`、`missing_runs`。一律按模型官方 API 价格算（插件自带的价格表 `scripts/prices.json`），和实际扣费不一定相同。表里没有的模型算不出费用，计入 `missing_runs`（Claude Code 席不算）。
- 输出 JSON：`runs_dir`、`module`、`since_days`、`group`、`plan`、`generated_at`、`totals`（`runs`、`seats`、`judged_runs`、`running_skipped`、`unreadable`、`unreadable_verdicts`）、`rows`（按讨论、审查、执行、图像的顺序，同一模块里席位多的在前）和 `notes`（上面几条口径的说明）。
- 怎么用：偏好文件可以引用这份统计改某个模型的档位（比如"本地实测里 deepseek-v4.1-flash 审查的独有发现多，审查时按强档用"），以偏好文件为准；脚本不自动排名，也不改配置和档位。记过去留的轮数少时（看 `judged_runs` 和 `unique_basis_runs`），这些数字只作参考。
