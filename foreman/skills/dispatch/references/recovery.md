# 提问、失败和续接

下面几种情况，在做决定之前读这一篇：结果里 `needs_decision` 为 `true` 或有 `questions`；状态是 `stalled`、`interrupted`、`timeout`、`quota_exhausted`、`needs_input`、`failed`；Codex 报沙箱错误；讨论或审查里有 API 参与方（发起时就要启动排队检查）；要续接一个任务、要选 `--reason`。

## 协作方要人回答时
调度是无人值守的：协作方运行时没有人能回答它。脚本保证它们不会因为等人而卡住：Codex 默认不需要审批；opencode 不开放提问工具和需要确认的权限；pi 没有提问工具，foreman 注入的守卫扩展只放行这次任务需要的工具；agy 的提问工具被 foreman 的全局守卫拒绝；以后接入的 CLI 如果在终端打出"(y/n)"之类的提示后没了动静，3 分钟后自动结束，状态为 `needs_input`。

所有提问都收集在结果的 `questions` 里。`needs_decision` 为 `true` 时说明有事要决定；任务已经结束，不是卡住了。

**由 Claude 直接决定，不问用户。** 决定后写进续接说明，用 `resume --reason answer` 继续；小的收尾也可以 Claude 自己做掉。
- 技术做法和取舍，只要在用户已有的授权和任务范围内；
- 任务说明自相矛盾或没写清楚的地方：这通常是 Claude 自己写的说明的问题，按本意澄清；
- 缺材料、缺信息：Claude 自己查清楚后补给它。

**交给用户决定**，把问题、选项和 Claude 的推荐一起给用户：业务取舍和偏好、风险承受度、扩大范围或授权、要额外花钱、不可逆的操作。

按 `source` 分别处理：
- `decision_request`：执行报告里交回的问题。`recommendation` 里写了它已经按哪个做了。Claude 同意就不用改，不同意就在续接说明里写明要怎么改（这时续接要求改交付，写 `--reason rework`）。
- `permission_denied`：工具想做的操作被权限挡住了，比如 opencode 想读项目目录外的文件，或者 pi、agy 的操作被 foreman 的守卫挡下。权限是有意设的边界，不要为了放行去改配置；它需要的材料由 Claude 读出来，写进续接说明，或者用 `--file` 附上。
- `final_question`：最终回答是一个问题，不是报告。Claude 回答它，用 `resume --reason answer` 续接，并要求按格式交报告。
- `input_prompt`（状态 `needs_input`）：工具在等终端输入。看提示内容：属于上面 Claude 能决定的，用 `resume --reason answer` 续接，在说明里写明答复；否则交给用户。
- `asked_mid_run`：运行中提过的问题，没人回答，它已按自己的判断继续了。验收时对照报告看它选的做法，不合适就按返工处理。这类不计入 `needs_decision`。
- `open_question`：讨论报告里的待定问题，按讨论的流程处理。

## 续接写哪个 --reason
续接执行和图像任务时用 `--reason` 写明原因（讨论的续接不写），`stats` 的返工率按它算：
- `answer`：只回答问题、补材料或给决定，然后接着做。不算返工次数。
- `recover`：上一轮没有正常结束（卡死、超时、失败、中断、额度用完，或者被 Claude 主动 `cancel`），从断点继续，没有要改的。不算返工次数。
- `rework`：要求修正或补齐上一轮的交付（不合格、部分完成后补完、验收或审查发现的问题）。既回答问题又要求改的也写 `rework`。次数和升级规则见 `references/acceptance.md` 的"返工"。
- 原任务之外新加的需求不是返工，也不续接：当作新任务定级、另派。

声明和上一轮的状态对不上时（比如写了 `answer`，上一轮却没有提问），脚本照声明记，只在结果的 `notes` 里提示一句。

## 没有正常结束的任务
- 结果状态为 `stalled`（卡死：超过 `dispatch.stall_min` 分钟没有任何活动，且没有命令在执行，脚本已自动终止；分钟数以 `config` 输出为准）时，多半是网络或服务的临时问题。用 `resume --reason recover` 让它从断点继续一次；再卡死就由 Claude 接手。可以用 `--stall <分钟>` 调整阈值，`--stall 0` 关闭检测。总超时是 `dispatch.timeout_min`，用 `--timeout` 调整。
- 怀疑任务卡住时，先运行 `status` 看"last activity X min ago"和当前步骤，不要凭感觉判断。正在执行命令（比如跑大计算）时，长时间没有新事件是正常的。`interrupted` 表示调度进程已经不在了（比如会话或应用被关闭），这时 Claude 收不到完成通知，需要手动查看 `status --run <run_id>`，再决定是续接还是重来。
- 结果状态为 `quota_exhausted` 时，是额度用完了：Codex 是订阅额度，API 协作方是账户余额不足。不要重试，也不要自动改由 Claude 重做；告诉用户额度用完和预计恢复时间（`quota_resets_at`），由用户决定是等额度恢复后用 `resume --reason recover` 继续，还是改由 Claude 接手。
- Claude 接手或用户决定放弃的任务，状态是 `interrupted`、`stalled`、`timeout`、`quota_exhausted` 或 `needs_input` 时，运行 `cancel --run <run_id>` 标记为已处理：会话开始时的提醒只列还没处理的执行任务。
- 会话开始时的提醒如果列出了执行没有正常结束的任务，在合适的时候告诉用户一句，按用户的意思处理。
- 派活或讨论因为环境问题失败（找不到命令、没登录、API 报 401 等）时，先跑 `check` 确认原因，把结果里的 `fix` 转告用户。
- 排查 agy 时：记录目录里 `agy.log` 开头常有一串 "You are not logged into Antigravity"，运行成功时也有，不代表没登录。登录有没有问题看结果的 `errors` 和 `check`。
- `check` 报 agy 自己的沙箱起不来（原文类似 `exebox: creating sandbox: …`）：这是 agy 在本机建不起沙箱，不是网络或项目路径的问题，重测也一样。agy 照常参加讨论和审查，只是只读文件、不跑命令；agy 升级后会自动重测。探针跑完记录目录就删了，要看 agy 当时做了什么，读 `~/.gemini/antigravity-cli/brain/<对话 ID>/.system_generated/logs/transcript_full.jsonl`。

## 遇到沙箱问题时停下来
Codex 因为沙箱无法启动命令或报错时（结果的 `notes` 会提示"Codex 的沙箱启动不了命令"，常见原文是 `windows sandbox failed`、`setup refresh had errors`），不要重试，也不要自己换沙箱、改配置文件、想办法绕开脚本。先运行 `check`，它会不调模型地测一遍沙箱，`fix` 里列出可选的修法；把错误原文、你的判断和这些选项告诉用户，由用户决定。不要建议改 `approval`：派出去的任务没人能批准，`never` 是对的，问题在沙箱。Windows 上 Codex 只读沙箱的具体情况见 `references/config.md`。

## API 参与方繁忙时
API 协作方的服务繁忙时，请求会在服务端排队，迟迟不开始处理，最后可能被服务端断开。别让用户干等：
- 发起（或续接）的讨论、发起的审查里有 API 参与方，并且 `effective.dispatch.busy_ask_min` 大于 0 时，紧接着在后台再启动一次 `await-busy --group <组名>`（只盯一席时也可以用 `--run <run_id>`）。它不发请求，只在有参与方排队超过 `busy_ask_min` 分钟、或者全部结束时退出，退出时会通知你。脚本启动时输出的"排队检查"一行给出了完整命令。
- 它退出后读输出：`busy` 为空就不用管。不为空时由 Claude 直接决定，不问用户：
  - 其他参与方已经有可用的结果，或者这一方已经排队超过 10 分钟：运行 `cancel --run <run_id>` 终止它，用其他参与方的结果继续。这一方的结果标为 `cancelled`，裁决时说明少了它。
  - 否则再等 5 分钟：后台再启动 `await-busy --run <run_id> --after <已排队分钟数 + 5>`，到时还在排队就终止。
  - 事后用一句话告诉用户终止了哪一方、为什么。
- 用户也可以在实时查看里对排队中的模型按 x 终止，效果和 `cancel` 一样。收到 `cancelled` 的结果时照常继续。
