# 脚本参考：check、models 和结果字段

SKILL.md 里只留了决策流程和常用命令。排查环境、帮用户选模型、看结果 JSON 里某个字段的意思时，读这里。实时查看、`status` 和开工那一行的字段（状态词、用时、计数、模型标签、用量、标签和提示）中英两个插件都写英文，模型和 Claude 写的内容照原文显示。每个子命令加 `--help` 打印这一条的用法（`assets <动作> --help` 打印这个动作的参数），退出码 0。

## check
检查环境能不能用：Node.js、Git，以及配置里的每个协作方，结果在 `agents.<代号>` 里。
- **Codex CLI**：能否启动、是否已登录；再按 Codex 自带的模型清单核对各格子配置的推理强度（不发请求），结果列在 `efforts` 里；按各类任务实际用的沙箱模式，用 `codex sandbox` 在沙箱里跑一条 echo（不调模型），结果列在 `sandbox` 里，`danger-full-access` 不进沙箱、不测。Windows 上沙箱起不来时，会顺带试 unelevated 沙箱，能用时写在 `fix` 里。
- **API**：key 是否设置，并发一个很小的请求确认能连通。
- **opencode**：能否启动、`opencode models` 里有没有这个模型，并发一个很小的请求确认能用；各格子给它配置了推理强度（variant）的，先按 opencode 的模型清单核对，清单里没有的直接判不通过，其余每个档位再各发一个小请求，结果列在 `variants` 里。
- **pi**：能否启动、模型清单里有没有这个模型，并发一个很小的请求确认能用；推理强度只按清单核对（pi 遇到模型不支持的档位不报错，会悄悄换成最接近的一档，发请求试不出来），结果列在 `efforts` 里。

总体 `ok` 只看 Node.js 和被格子引用到的协作方（包括图像格子）；没被引用的不通过只是报告出来，不影响使用。每项不通过时，结果里的 `fix` 写明该怎么处理，转告用户即可。

结果里的 `summary` 是总配置情况：`modules` 是每一格有哪些候选、什么模型和推理强度、是否必选（`required`）、检查是否通过（不通过的写了 `problem`），`agents` 是每个协作方用在哪几格（`used_at` 写成 `modules.<模块>.<格子>[序号]`），`warnings` 是值得注意的地方（没用到的协作方、明文写在配置里的 key、shell 权限用于执行或手画、讨论或审查没有只读沙箱的 Codex（`readonly_audited`）、失效的旧代号）。跑完 `check` 后，用一张格子表和一份提醒把它告诉用户，写法同 `/foreman:setup` 的最后一步。`config` 的输出里也有 `summary`，只是不带检查结果。

## plan、image 和 status --plan
一次派几个席位时先建派发计划；图像任务不论几席都要建计划：

```bash
node "<脚本路径>" plan --cwd "<项目目录>" --module <discuss|run|review> --cell <simple|normal|complex> --group <组名> --seat "<代号>[=<角色名>]" [--seat …] [--why "<选择理由>"] [--target <diff|files|claims|visual>] [--file "<路径>"]… [--uncommitted | --base <分支> | --commit <sha>]
node "<脚本路径>" plan --cwd "<项目目录>" --module image --cell <generate|draw> --route <1|2|3|4> --group <组名> --seat "<代号>" [--seat …] [--why "<选择理由>"]
```

- 校验都在发出任何请求之前做完：格子没关（不是 `"claude code"` 或 `null`）；每个席位都在这一格的候选里（旧代号会换成新代号）；必选都有席位；执行和手画（draw）席位能执行；`visual` 审查的席位能看图（`reads_images`）；出图（generate）席位能出图；席位数不超过 `dispatch.max_seats`。
- 图像计划另外检查：
  - `--route` 必须写，只能是 1–4，而且和格子对得上：① 位图只用 generate；② 位图 + 矢量混合用 generate 和 draw；③ 纯矢量、先出参考图用 generate（只出参考图）和 draw；④ 纯矢量 / 代码只用 draw。计划只管一格，所以路线 ④ 的 draw 计划不看 generate 格子里的必选。别的模块写 `--route` 会被拒绝。
  - generate 的席位不带角色（`--seat 代号=角色` 会被拒绝）：画面要求由 Claude 统一写进任务说明。
  - 确认凭据：插件的钩子（`hooks/record-answers.mjs`，PreToolUse 和 PostToolUse，只认 AskUserQuestion）把问题或 header 里带"图像路线"（英文 "Image route"，大小写不限）的弹窗按 Claude 会话记在配置目录下的 `answers/<会话 id>.jsonl`：弹出时记一行 `asked`，用户回答后记一行 `answered`（带 `answers`，键是问题原文，值是选中的选项 label，选 Other 时是用户写的字）。别的弹窗不记；30 天前的文件会被清掉。`plan --module image` 取环境变量 `CLAUDE_CODE_SESSION_ID` 对应的文件，看最近一次路线弹窗：没有会话 id、没有路线弹窗、最近一次没有回答（取消了或还没选）、回答不是以 ①–④ 开头的某个选项，或者选的路线和 `--route` 不一致，都不建计划。一次弹窗问了几个交付物的路线时，其中任何一条和 `--route` 一致都算。同一次回答可以建几份计划。
- 审查计划在建计划时就定下审查对象和材料：`--target`、`--file` 和范围参数只能写在审查计划上（别的模块写了会被拒绝），校验和单席 `review` 一样，`diff` 没有改动时不建计划。计划的 `review` 记下这些参数和材料指纹（非 git 目录里的 `diff` 没有指纹，为 `null`）。
- 通过后写进记录目录的 `plans/<plan_id>.json`，输出计划内容：`plan_id`、`module`、`cell`、`group`、`seats`（每席的序号 `seat`、`agent`、`role`、`model`、`effort`、`required`）、`required`、`why`、`review`（只有审查计划有；没写范围参数的 `diff` 审查记成 `uncommitted: true`）、`route` 和 `route_confirmation`（只有图像计划有：路线号，以及凭的是哪次回答：`tool_use_id`、问题、回答和回答时间），以及 `file`（计划文件）和 `commands`（每一席的启动命令；里面的说明文件、标题、范围和输出目录是占位符，换成实际的再用）。
- 每一席用 `run / discuss / review --plan <plan_id> --seat <序号> --brief …` 启动：协作方、推理强度、目录、等级和组都取自计划，不能再写 `--agent`；要换推理强度加 `--effort`，换模型加 `--model`（规则同单席派发）；执行席位照常要 `--scope`；审查席位不再写 `--target`、`--file` 和范围参数，脚本按计划重算一次材料，指纹和计划里的不一致就拒绝启动（材料在建计划之后变了），这时按现在的材料重建计划。启动时按当前配置把整份计划重新校验一遍：配置改过（包括这一席的模型或推理强度变了）、必选变了或者项目关了这一格，都会被拒绝，这时重新建计划。同一席只能启动一次，返工用 `resume`，续接沿用原来的计划和席位；计划里的席位续接时不能换等级。
- 图像计划的席位用 `image --plan <plan_id> --seat <序号> --brief … --title … --scope <输出目录>` 启动：不写 `--level`（格子由计划决定），`--scope` 至少给一个（同组任务的写入范围检查要用；工作目录里被 `.gitignore` 忽略的输出目录会自动并入 `--track`，改动追踪才看得到，工作目录本身和没被忽略的目录不并入），其余参数（`--track`、`--effort`、`--model`、`--add-dir`、`--timeout`、`--stall`）和 `run` 一样。内部按执行任务跑：快照、执行报告、改动归属、`generated_images`、`image_calls` 都和 `run` 相同，记录里 `mode` 是 `run`、`kind` 是 `exec`，另有 `module: "image"`、`cell`、`step`（就是格子）和 `route`，`level` 为 `null`。续接用 `resume --run <run_id> --brief …`，不写 `--level`：从图像格子选派，不查执行的等级，也不再核对确认凭据。
- 计划不占并发名额；每一席启动时照常按它的协作方计并发。
- `status --plan <plan_id>` 输出 JSON：每一席的 `run_id`（最新一轮）、`runs`（这一席所有轮次）、`status`（没启动过是 `not_started`）、`ok`（结束后才有：正常结束并交回了有效结果；审查以结构化报告为准，`verdict` 为 `incomplete` 的不算，没有报告时只有 Codex 原生审查的文字算）；`state` 为 `complete`（必选席位都交回了有效结果；没有必选时，每一席都结束、至少一席有效）、`incomplete`（有必选席位结束了但没有有效结果，比如失败、取消、额度用完、等人回答）或 `pending`；`missing_required` 列出还没有有效结果的必选席位和它的状态；每一席的 `stale` 是它最新一轮审查结果里的 `stale`（不是审查或还没有结果时为 `null`），图像计划另有 `route`。审查期间材料变了的席位，实时查看和 `status --group` 会在这一席和计划那一行写"material changed during the review (stale)"，计划照样算完整。

## models
列出本机 Codex、opencode、pi 自带的模型清单（含每个模型支持的推理强度），以及每个 API 协作方的接口列出的模型名（不含推理强度），并核对配置里的模型在不在清单里、不在时给出最接近的写法。只读，不发模型请求。用户问有哪些模型可选、或者要换模型和推理强度时用。

## 结果字段
`run`、`image`、`resume`、`discuss`、`review` 的结果以 JSON 打印到 stdout，主要字段：
- `report`：协作方的结构化报告：执行报告、讨论报告或审查报告。审查报告有 `verdict`（`issues_found` / `no_issues` / `incomplete`）、`findings`（每条有 `id`、`location`、`issue`、`trigger`、`severity`、`evidence`、`suggestion`，为空是合法结果）、`coverage`（`checked`、`not_checked`）和 `unverified`。Codex 原生审查（审 `diff`、不带说明也不带 `--file`）没有结构化报告：`report` 为 `null`，意见是 `last_message` 里的英文文字。报告不是合法 JSON 时（opencode、pi、API 修复一次后仍不合格），也只有 `last_message`。
- `last_message`：没有 `report` 时，协作方最后一条回复的原文，只保留前 8000 字，全文在 `run_dir/last-message.txt`。
- `changes`：脚本追踪到的工作目录内改动。每个文件标有 `by`：`agent` 表示有工具事件证明是执行的协作方改的（改名前的记录里写作 `codex`）；`reported` 表示只有它在报告里自称改过，常见于用命令或脚本写的文件；`unknown` 表示两样都没有。报告里写成目录的（以 `/` 结尾，或者在磁盘上是目录）按前缀算，目录下被追踪的文件都记 `reported`；只有这个前缀下一个被追踪的文件都没有时，`notes` 才提示它不在追踪范围内（工作目录本身不算）。标了 `group_run` 的落在同组另一个任务的写入范围里，而且那个任务的运行时间和这个任务有重叠（区间是开始到结束，还在跑的算到现在，旧记录没有结束时间的按最后活动时间算；这个任务开始前就结束了的不认领），个数在 `group_total`；实时查看的结束行和组面板不把它们算进"of unknown origin"，另写"N from other runs in the group"。
- `notes`：提示信息，比如归属未知的改动、协作方报告了但没追踪到的文件、Codex 的沙箱启动不了命令。
- `warnings`：要注意的问题，比如审查期间材料又变了；普通执行任务出了图（"出图没有走图像模块"）；路线 ④ 的手画任务出了位图；路线 ③、④ 的手画任务新写或改过的 SVG 里嵌了位图（`<image>`；只查这一席自己的改动；没有快照、或者 `--scope` 在工作目录外时，追踪不到的地方只查执行事件和报告里列出的 SVG，`notes` 里会说明）。
- `questions` 和 `needs_decision`：协作方要人回答的事，见 SKILL.md 的"协作方要人回答时"。
- `session_id`、`run_dir`：完整 diff 在 `run_dir/diff.patch`，审查的补丁在 `run_dir/review.patch`。
- token 消耗：`usage` 是本次调用的输入、缓存、输出 token（`usage_scope` 为 `session_total` 时是整个会话的累计量）；`last_request` 是最近一次请求的用量和模型上下文窗口；`rate_limit` 是 Codex 额度的已用比例；`quota_resets_at` 是额度预计恢复的时间。被取消的任务只记得到取消前已经完成的请求的用量（正在进行的那次，厂商不报用量），一次都没完成时 `usage` 为 `null`，`notes` 里有说明；`errors` 写明是 `cancel` 命令、用户在实时查看里按 x，还是调度进程收到了终止信号。`cancel` 最多等 30 秒让任务自己停下，等不到就强行结束它，补写一份最简结果（带上会话记录里读得到的用量）。
- `agent`、`model_shown`、`effort`：这次交给了哪个协作方、实际用的模型和推理强度。`model_overridden` 为 `true` 表示这次用 `--model` 换了模型；`outside_cell` 为 `true` 表示格子是 `"claude code"`、这次是用 `--agent` 点名派出的。
- `module`、`cell`、`plan`、`seat`、`role`：这次属于哪个模块和格子；用计划启动的，还有计划的 `plan_id`、席位序号和角色（不是计划派出的为 `null`）。图像任务另有 `step`（generate 或 draw）和 `route`（1–4），`level` 为 `null`。API、opencode 和 pi 协作方的讨论和审查结果没有改动追踪（`changes.available` 为 `false`）；API 协作方的 `files` 列出附带了哪些文件，opencode 和 pi 协作方多一个 `cost_usd`（按厂商价格折算的美元费用），`status` 和实时查看会把它接在 token 用量后面显示。
- `isolation`、`run_access`：opencode 和 pi 做执行时，写明没有系统沙箱（`tools`）和这次的权限档位。
- `generated_images`：这一轮新出现的图片原文件（Codex 的在它的图片目录里）。能出图的适配器都通过同一个接口提供这一项和 `image_calls`。
- `viewed_images`：这一轮 Codex 用 view_image 打开过的图片，`[{ path, ok }]`（读自 Codex 的会话记录；路径是变量、解析不出来时为 "unknown"；`ok` 为 `true` 表示图片读到了，`false` 表示调用了但没读到，`null` 表示没找到结果，或者一段代码里看了几张图、读到的张数对不上，分不清是哪一张没读到）。补丁工具（apply_patch）里写到的 view_image 不算。实时查看的时间线上会出现"Opened image …"。`commands_executed` 不包括它。
- `image_calls`：这一轮每次出图实际传的参数和结果（读自 Codex 的会话记录）：`transparent_background`、`referenced_image_paths`（没传为 null；用变量传、解析不出来，或者几次调用分不清各自对应哪张图时为 "unknown"）、`num_last_images_to_include`（同样可能是 "unknown"）、`status`（代码里写了调用、但没执行到时为 "not_run"）、`saved_path`、`failure`。任务说明里写了 `referenced_image_paths`、但这一轮的调用都没传参考图时，`warnings` 会提示。
- `review_target`、`review_scope`：审查对象（`diff`、`files`、`claims`、`visual`），以及范围、文件数和材料指纹；`review_scope.kind` 对 `diff` 是 `uncommitted` / `base` / `commit`，对其他对象就是对象名。非 git 目录里的 `diff` 没有 `review_scope`。`native_review` 为 `true` 表示这次走的是 Codex 原生审查。
- `stale`：审查结束时重算材料指纹，和开始时不同为 `true`（这份审查可能没覆盖最新的版本，`warnings` 也会提示），相同为 `false`，没有材料指纹时为 `null`。
- `readonly`：讨论和审查的只读保障：`tools`（opencode、pi、API）、`sandbox`（Codex 在只读沙箱里）或 `audited`（Codex 没有只读沙箱，只靠规则和事后对比快照）。
- `readonly_violation`：讨论或审查里有证据的写入，列出 `[{ path, by }]`；这时 `status` 为 `failed`，`errors` 里有说明，改动没有自动还原。
