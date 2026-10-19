# 脚本参考：check、models 和结果字段

SKILL.md 里只留了决策流程和常用命令。排查环境、帮用户选模型、看结果 JSON 里某个字段的意思时，读这里。

## check
检查环境能不能用：Node.js、Git，以及配置里的每个协作方，结果在 `agents.<代号>` 里。
- **Codex CLI**：能否启动、是否已登录；再按 Codex 自带的模型清单核对各格子配置的推理强度（不发请求），结果列在 `efforts` 里；按各类任务实际用的沙箱模式，用 `codex sandbox` 在沙箱里跑一条 echo（不调模型），结果列在 `sandbox` 里，`danger-full-access` 不进沙箱、不测。Windows 上沙箱起不来时，会顺带试 unelevated 沙箱，能用时写在 `fix` 里。
- **API**：key 是否设置，并发一个很小的请求确认能连通。
- **opencode**：能否启动、`opencode models` 里有没有这个模型，并发一个很小的请求确认能用；各格子给它配置了推理强度（variant）的，先按 opencode 的模型清单核对，清单里没有的直接判不通过，其余每个档位再各发一个小请求，结果列在 `variants` 里。
- **pi**：能否启动、模型清单里有没有这个模型，并发一个很小的请求确认能用；推理强度只按清单核对（pi 遇到模型不支持的档位不报错，会悄悄换成最接近的一档，发请求试不出来），结果列在 `efforts` 里。

总体 `ok` 只看 Node.js 和被格子引用到的协作方（包括图像格子）；没被引用的不通过只是报告出来，不影响使用。每项不通过时，结果里的 `fix` 写明该怎么处理，转告用户即可。

结果里的 `summary` 是总配置情况：`modules` 是每一格有哪些候选、什么模型和推理强度、是否必选（`required`）、检查是否通过（不通过的写了 `problem`），`agents` 是每个协作方用在哪几格（`used_at` 写成 `modules.<模块>.<格子>[序号]`），`warnings` 是值得注意的地方（没用到的协作方、明文写在配置里的 key、shell 权限用于执行或手画、失效的旧代号）。跑完 `check` 后，用一张格子表和一份提醒把它告诉用户，写法同 `/foreman:setup` 的最后一步。`config` 的输出里也有 `summary`，只是不带检查结果。

## plan 和 status --plan
一次派几个席位时先建派发计划：

```bash
node "<脚本路径>" plan --cwd "<项目目录>" --module <discuss|run|review> --cell <simple|normal|complex> --group <组名> --seat "<代号>[=<角色名>]" [--seat …] [--why "<选择理由>"]
```

- 校验都在发出任何请求之前做完：格子没关（不是 `"claude code"`）；每个席位都在这一格的候选里（旧代号会换成新代号）；必选都有席位；执行席位能执行；席位数不超过 `dispatch.max_seats`。图像模块这一版还不能建计划。
- 通过后写进记录目录的 `plans/<plan_id>.json`，输出计划内容：`plan_id`、`module`、`cell`、`group`、`seats`（每席的序号 `seat`、`agent`、`role`、`model`、`effort`、`required`）、`required`、`why`，以及 `file`（计划文件）和 `commands`（每一席的启动命令；里面的说明文件、标题和范围是占位符，换成实际的再用）。
- 每一席用 `run / discuss / review --plan <plan_id> --seat <序号> --brief …` 启动：协作方、推理强度、目录、等级和组都取自计划，不能再写 `--agent`；要换推理强度加 `--effort`，换模型加 `--model`（规则同单席派发）；执行席位照常要 `--scope`。启动时按当前配置把整份计划重新校验一遍：配置改过（包括这一席的模型或推理强度变了）、必选变了或者项目关了这一格，都会被拒绝，这时重新建计划。同一席只能启动一次，返工用 `resume`，续接沿用原来的计划和席位；计划里的席位续接时不能换等级。
- 计划不占并发名额；每一席启动时照常按它的协作方计并发。
- `status --plan <plan_id>` 输出 JSON：每一席的 `run_id`（最新一轮）、`runs`（这一席所有轮次）、`status`（没启动过是 `not_started`）、`ok`（结束后才有：正常结束并交回了有效结果）；`state` 为 `complete`（必选席位都交回了有效结果；没有必选时，每一席都结束、至少一席有效）、`incomplete`（有必选席位结束了但没有有效结果，比如失败、取消、额度用完、等人回答）或 `pending`；`missing_required` 列出还没有有效结果的必选席位和它的状态。

## models
列出本机 Codex、opencode、pi 自带的模型清单（含每个模型支持的推理强度），以及每个 API 协作方的接口列出的模型名（不含推理强度），并核对配置里的模型在不在清单里、不在时给出最接近的写法。只读，不发模型请求。用户问有哪些模型可选、或者要换模型和推理强度时用。

## 结果字段
`run`、`resume`、`discuss`、`review` 的结果以 JSON 打印到 stdout，主要字段：
- `report`：协作方的结构化报告。审查没有结构化报告：`report` 为 `null`，审查意见是 `last_message` 里的文字。执行和讨论的报告不是合法 JSON 时，也只有 `last_message`。
- `last_message`：没有 `report` 时，协作方最后一条回复的原文，只保留前 8000 字，全文在 `run_dir/last-message.txt`。
- `changes`：脚本追踪到的工作目录内改动。每个文件标有 `by`：`agent` 表示有工具事件证明是执行的协作方改的（改名前的记录里写作 `codex`）；`reported` 表示只有它在报告里自称改过，常见于用命令或脚本写的文件；`unknown` 表示两样都没有。标了 `group_run` 的落在同组另一个任务的写入范围里。
- `notes`：提示信息，比如归属未知的改动、协作方报告了但没追踪到的文件、Codex 的沙箱启动不了命令。
- `warnings`：要注意的问题，比如讨论或审查时文件被改了、审查期间改动又变了。
- `questions` 和 `needs_decision`：协作方要人回答的事，见 SKILL.md 的"协作方要人回答时"。
- `session_id`、`run_dir`：完整 diff 在 `run_dir/diff.patch`，审查的补丁在 `run_dir/review.patch`。
- token 消耗：`usage` 是本次调用的输入、缓存、输出 token（`usage_scope` 为 `session_total` 时是整个会话的累计量）；`last_request` 是最近一次请求的用量和模型上下文窗口；`rate_limit` 是 Codex 额度的已用比例；`quota_resets_at` 是额度预计恢复的时间。
- `agent`、`model_shown`、`effort`：这次交给了哪个协作方、实际用的模型和推理强度。`model_overridden` 为 `true` 表示这次用 `--model` 换了模型；`outside_cell` 为 `true` 表示格子是 `"claude code"`、这次是用 `--agent` 点名派出的。
- `module`、`cell`、`plan`、`seat`、`role`：这次属于哪个模块和格子；用计划启动的，还有计划的 `plan_id`、席位序号和角色（不是计划派出的为 `null`）。API、opencode 和 pi 协作方的讨论结果没有改动追踪（`changes.available` 为 `false`）；API 协作方的 `files` 列出附带了哪些文件，opencode 和 pi 协作方多一个 `cost_usd`。
- `isolation`、`run_access`：opencode 和 pi 做执行时，写明没有系统沙箱（`tools`）和这次的权限档位。
- `generated_images`：这一轮在 Codex 图片目录里新出现的图片原文件。
- `image_calls`：这一轮每次出图实际传的参数和结果（读自 Codex 的会话记录）：`transparent_background`、`referenced_image_paths`（没传为 null；用变量传、解析不出来，或者几次调用分不清各自对应哪张图时为 "unknown"）、`num_last_images_to_include`（同样可能是 "unknown"）、`status`（代码里写了调用、但没执行到时为 "not_run"）、`saved_path`、`failure`。任务说明里写了 `referenced_image_paths`、但这一轮的调用都没传参考图时，`warnings` 会提示。
- `review_scope`：审查的范围、文件数和指纹。
