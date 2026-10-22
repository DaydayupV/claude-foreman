# foreman 黑盒回归基线

在仓库根目录运行 `npm test`。单文件可用 `node --test tests/discuss.test.mjs`，也可替换为下面任意测试文件。仅使用 Node 内置模块和已有的 Git，不安装依赖。

所有产品调用都是子进程：`node foreman/skills/dispatch/scripts/cli.mjs` 或 `foreman/hooks/*.mjs`。仅导入允许的 `messages.mjs` 取提示文字。基线固定当前实现，不预先要求设计文档中后续阶段的行为。

每个测试在 `os.tmpdir()` 下创建独立用户目录，设置 `HOME`、`USERPROFILE`、`CODEX_HOME`、`APPDATA`，只继承启动所需系统变量。`PATH` 仅保留 Git 和系统工具目录，防止初始配置查询 npm 全局路径时找到真实 npm/CLI；Git 的全局和系统配置也隔离。语言默认中文、时区 UTC、会话为 `test-session`。假 API 仅监听 `127.0.0.1` 的随机端口，所有 key 都是合成字符串。

结束时先回收仍在运行的测试子进程，再删除对应临时目录。活动状态、事件和并发会合使用有上限的轮询；不会靠固定 sleep 猜任务是否已启动。没有读取真实运行记录或复制真实配置。

## 假工具与夹具

- `helpers.mjs`：临时用户目录、配置、子进程、轮询、Git、记录读取、路径占位替换。`seedRun` 用测试进程自己的 pid 假装调度进程还在运行时，开始时间不早于测试进程启动（`liveStart`）：脚本会核对进程启动时间，晚于任务开始的进程算作复用了进程号。
- `fake/codex.mjs`、`fake/opencode.mjs`：通过 `agents.<名字>.bin` 指定，`FAKE_SCENARIO` 指向合成 JSON 剧本。
- 剧本的 `capture` 指定 JSONL 调用日志；记录工具、操作、argv、stdin、cwd、pid 及指定的环境变量。`calls` 按同一工具/操作的调用序号覆盖基础剧本，用于续接和报告修复。
- `steps` 中每步支持 `event`、`delay_ms`、`wait_for`（临时放行文件）、`files`、`stderr`。根级支持 `files`、`last_message`、`exit_code`、`stderr` 和 `hold`。
- Codex 另支持 `logged_in`、`version`、`session_id`、`stats`、`usage`、`images`、`rollout`；`stats` 生成带 `token_count` 的合成会话 JSONL，`rollout` 往同一份会话记录里追加原始记录（没写时间的按当时补上），图片为合成的单像素 PNG。
- `fake/browser.mjs`：假的无头浏览器，照 Chrome 的截图参数画一张随 t 移动方块的 PNG，给 capture 和 playback 测试用。
- `fixtures/png.mjs`：在内存里画纯色矩形并写成 PNG（RGB 或 RGBA），给 assets 测试用。
- opencode 另支持 `models`、`session_id`、`export_messages`、`export_error` 和可选 `step_finish`；`no_final` 让它只回放 `steps` 里的事件，不再补最后一条回复（`fixtures/opencode-retry.mjs` 是按真实现场整理的流超时、重试、报告被拆成三段的事件序列；`fixtures/opencode-retry-nofinish.mjs` 是重试后写完完整报告就退出、没有 `step_finish` 的现场）。导出的消息可以用 `created: "old"` 模拟本轮开始前的历史。
- `fake/api-server.mjs`：按请求序号提供 SSE 剧本，支持正常流、保活排队、401/402、拒绝 `response_format`、报告修复、残缺流和取消；请求保存在测试内存中。
- `fixtures/`：完全合成的报告、用量和四类 watch 记录；`fixtures/watch-live.mjs` 是一场还在进行的四方讨论（Codex、opencode、pi、API），pid 用测试进程自己，任务就算在运行。`expected/`：已人工核对的文本（插件自己写的字段中英两个插件都是英文，所以只有一份）：五份非 TTY 的 watch 输出、两份组视图实时面板的画面（100x30、64x18）、一份 status 列表；仅替换临时路径为 `<HOME>`/`<CWD>`，事件时刻为 `<TIME>`，运行中的计时为 `<CLOCK>`，状态、用量、文案和排版均保留。
- 实时画面：环境变量 `FOREMAN_TEST_SCREEN=<宽>x<高>` 让 watch 把输出当成这么大的终端，照常画备用屏幕；测试从输出里取第一帧，按每行的光标定位拆回各行再比对。设了它又把 `NO_COLOR` 设成空时照常上色，用来核对颜色。

## 覆盖清单

表中名称与 `node:test` 输出一致；同一行的多个测试共同覆盖该项。

| 要求 | 文件 | 测试名 |
|---|---|---|
| 1 初始配置和提示 | config.test.mjs | 没有用户配置时生成初始配置并提示首次使用；英文覆盖变量使用英文首次提示 |
| 1 旧结构和备份 | config.test.mjs | 零点十以前的配置自动改写并保留原文备份 |
| 1 校验错误 | config.test.mjs | 未知协作方类型被拒绝；执行等级不能使用 API 协作方；opencode 模型必须带厂商斜杠；讨论等级不能为空；同一讨论等级不能重复参与方 |
| 1 项目字段限制 | config.test.mjs | 项目配置忽略不允许的字段并保留允许的覆盖 |
| 1 非 Codex 参与方限制 | config.test.mjs | 项目配置不能把额外的 API 或 opencode 加入讨论等级 |
| 1 config 输出 | config.test.mjs | config 输出解析后的等级、协作方状态、偏好及记录目录 |
| 2 旧配置和偏好 | migration.test.mjs | 旧配置和旧偏好在第一次运行时复制到新位置，旧文件保留 |
| 2 记录搬迁及启动器 | migration.test.mjs | 旧记录目录整体迁移并重写 watch 启动器 |
| 2 活跃 PID | migration.test.mjs | 旧目录里有活着的任务时延后迁移 |
| 2 并发迁移 | migration.test.mjs | 四个进程同时启动只迁移一次且记录完整；记录目录搬迁锁正被删除时报 EPERM、EACCES、EBUSY 只是稍等再试，删残留锁和释放时都不会删掉别的进程拿到的锁 |
| 2 自定义记录目录 | migration.test.mjs | 用户通过配置指定记录目录时不搬旧目录；用户通过环境变量指定记录目录时不搬旧目录 |
| 2 旧环境变量 | migration.test.mjs | 旧环境变量仍生效并提示改名；旧语言环境变量生效时也提示改名 |
| 2 项目旧文件名 | migration.test.mjs | 项目里的旧配置和偏好文件名照常读取并提示改名 |
| 3 成功、改动归属、用量 | run.test.mjs | 执行成功写报告、补丁、事件归属和会话用量 |
| 3 未知归属 | run.test.mjs | 没有事件或报告证据的文件变化归属未知 |
| 3 退出错误 | run.test.mjs | 非零退出把 stderr 最后五行带入 errors |
| 3 超时 | run.test.mjs | 小数分钟超时终止未结束的执行 |
| 3 卡死和执行中命令 | run.test.mjs | 卡死检测终止无活动任务，执行中的命令不判卡死 |
| 3 用户取消 | run.test.mjs | cancel 终止正在执行的任务并保存取消结果 |
| 3 额度 | run.test.mjs | 额度用完保留会话、恢复时间和额度提示 |
| 3 断线重连 | run.test.mjs | 断线重连事件只记警告不导致任务失败 |
| 3 组与范围 | run.test.mjs | 组名非法、缺少写入范围和范围重叠均被拒绝 |
| 3 并发上限 | run.test.mjs | 达到协作方并发上限时拒绝新任务 |
| 3 图片 | run.test.mjs | 会话图片收集到 generated_images 和事件文件 |
| 3 交回问题 | run.test.mjs | 交回问题的执行任务提示 Claude 决定，watch 用问号列出问题和推荐 |
| 4 会话、组、track 续接 | resume-review.test.mjs | 续接使用上一轮会话并沿用组、范围和 track，用量只算新增 |
| 4 讨论轮数 | resume-review.test.mjs | 讨论续接到轮数上限后拒绝再开一轮 |
| 5 原生审查 | resume-review.test.mjs | 没有审查重点时使用原生 exec review --uncommitted；没有审查重点时使用原生 exec review --base；没有审查重点时使用原生 exec review --commit |
| 5 带重点审查 | resume-review.test.mjs | 有审查重点时普通 exec 提示词包含 uncommitted 范围；有审查重点时普通 exec 提示词包含 base 范围；有审查重点时普通 exec 提示词包含 commit 范围 |
| 5 非 Git 审查 | resume-review.test.mjs | 非 Git 目录审查要求说明并使用普通 exec |
| 6 Codex 讨论 | discuss.test.mjs | Codex 讨论解析报告并传递只读规则和附件范围 |
| 6 API 材料、清单、正常 SSE | discuss.test.mjs | API 讨论发送附件行范围和项目清单，保存流式事件与用量 |
| 6 API 材料上限 | discuss.test.mjs | API 附件超过材料上限时拒绝请求 |
| 6 API 格式参数重试 | discuss.test.mjs | API 拒绝 response_format 后去掉该字段重试 |
| 6 API 报告修复 | discuss.test.mjs | API 非 JSON 报告只修复一次并累计两次用量；API 第二次报告仍不合法时保留原文并停止修复 |
| 6 API 错误状态和提示 | discuss.test.mjs | API 401 保存正确状态和提示；API 402 保存正确状态和提示 |
| 6 API 排队 | discuss.test.mjs | API 保活注释产生排队事件，放行后继续回答 |
| 6 API 取消 | discuss.test.mjs | API 取消正在排队的请求并保存取消结果 |
| 6 API 回答中断 | discuss.test.mjs | API 回答中途断开后重试一次且不拼接残缺回答 |
| 6 opencode 权限、PWD、事件、用量 | discuss.test.mjs | opencode 注入只读代理、设置 PWD 并翻译工具事件和导出用量（包含最后一步无 step_finish、旧消息排除和 cost_usd） |
| 6 opencode 修复会话 | discuss.test.mjs | opencode 修复报告时续接同一会话且仍使用只读权限 |
| 6 opencode 导出失败 | discuss.test.mjs | opencode 会话导出失败时保留报告并提示缺少用量 |
| 6 同组并发及 await-busy | discuss.test.mjs | 同组多方并发，await-busy 列出超过阈值的 API 参与方 |
| 7 status 列表与汇总 | status-watch.test.mjs | status 列表按记录排序并汇总当前会话的组 |
| 7 status 活动 | status-watch.test.mjs | status 对正在运行的任务给出当前命令和活动时间 |
| 7 watch 单任务文本 | status-watch.test.mjs | watch --run 非 TTY 的Codex 执行输出与期望一致；watch --run 非 TTY 的API 讨论输出与期望一致；watch --run 非 TTY 的opencode 讨论输出与期望一致；watch --run 非 TTY 的失败任务输出与期望一致 |
| 7 watch 组文本 | status-watch.test.mjs | watch --group 非 TTY 的四类任务汇总与期望一致 |
| 7 取消已结束任务 | status-watch.test.mjs | cancel 对已完成任务不改结果，对未正常结束任务标记已处理 |
| 8 Codex 检查 | check.test.mjs | check 识别 Codex 已登录状态；check 识别 Codex 未登录状态；check 找不到指定 Codex 时提示安装且不调用真实 CLI |
| 8 API 检查 | check.test.mjs | check 报告 API 可连通且不改变 Codex 总体结果；check 报告 API 认证失败且不改变 Codex 总体结果 |
| 8 opencode 检查 | check.test.mjs | check 检查 opencode 模型存在于 models；check 检查 opencode 模型不存在于 models；check 按各等级配置的 variant 逐个试，不支持的档位列出位置并给出修正提示，同一档位只试一次，默认请求失败时不再试 |
| 9 首次会话提醒 | hooks.test.mjs | 会话提醒首次使用并且不创建配置或迁移目录 |
| 9 偏好位置兼容 | hooks.test.mjs | 会话提醒带上新位置用户和项目偏好；会话提醒带上旧位置用户和项目偏好 |
| 9 未完成任务与取消 | hooks.test.mjs | 会话提醒列出未正常结束的执行任务，取消后不再列出 |
| 9 直接调用拦截 | hooks.test.mjs | 直接调用守卫拦截 codex exec；直接调用守卫拦截 codex review；直接调用守卫拦截 node codex.js exec；直接调用守卫拦截 npx Codex |
| 9 查询与普通文字放行 | hooks.test.mjs | 直接调用守卫放行版本查询；直接调用守卫放行登录状态；直接调用守卫放行普通文本提及；直接调用守卫放行带分隔符的文字 |
| 11 协作方要人回答 | questions.test.mjs | 六种来源各自收集进 questions，needs_decision 只算需要决定的四种；Codex 默认 approval_policy=never、配置了就用配置的；opencode 注入的权限里 question 被拒；最终回答是问题时不修复，像 JSON 或长篇分析时照常修复；终端提示加 3 分钟静默触发看门狗、结束进程树并记 needs_input，模型消息静默和执行中的命令不触发；watch、status 和组计数里问题的显示 |
| 12 新配置写法和迁移 | structure-migration.test.mjs | 真实结构配置迁移后按模型改名、每格模型和强度不变、有备份和别名；部分字段的旧等级先补全；模型覆盖拆成新协作方；同名合并或加后缀；Codex 没写模型时取 config.toml；项目配置的旧代号；并发迁移只备份一次、校验失败不改文件；结构迁移锁正被删除时短暂报 EPERM、EACCES、EBUSY 只是稍等再试，一直报错才按原错误提示改写失败，删残留锁和释放时都不会删掉别的进程拿到的锁；旧记录在 status、watch、resume 和并发准入里照常可用 |
| 13 通用化 | generalization.test.mjs | 多个 Codex、没有 Codex、能力表校验；代号规则；三种任务的 "claude code" 和点名派出；--effort 只覆盖强度且 --level 必填；check 的新结构和总体结果；项目只能保留同格候选，整格关闭并忽略模型覆盖；按环境生成 modules、max_seats 和有 Codex 时的图像默认值；没有协作方时的会话提醒 |
| 14 审查范围 | review-scope.test.mjs | 未提交范围含暂存、未暂存和未跟踪文件，指纹稳定且不动索引；删除、改名、二进制、非 UTF-8、过大文件；没有提交的仓库；base 从分叉点到工作区、含未提交改动、不含未跟踪文件，分支不存在或没有共同祖先时报错；根提交和合并提交（只比第一个父提交） |
| 15 通用审查 | review.test.mjs | opencode 审查注入只读的 foreman-review，材料和正文落盘（中英文各一）；材料超限拒绝且不启动，Codex 没有这个限制；非 git 目录要求 brief；空范围不启动任何审查方；审查期间改动变化时警告并标 stale；opencode 审查只收集权限拒绝和终端提示，正文按审查 schema 修复一次 |
| 16 opencode 执行 | opencode-run.test.mjs | run_access 校验和授权（项目配置开不了）；edit 和 shell 两档注入的权限、改动归属（工具事件为 agent、自报为 reported、其余 unknown）、报告和用量、watch；报告只修复一次且修复阶段没有工具；禁止 --no-snapshot、快照失败不启动；shell 档不判卡死、edit 档按 stall_min；续接同一会话、run_access 变化提示；同组范围重叠；超时、额度和输入看门狗 |
| 17 拦截 opencode run | hooks.test.mjs | 拦下各种写法的 opencode run（含 npx），放行版本、模型、会话、认证、调试、服务、帮助和文字提及 |
| 18 模型清单和总表 | catalog.test.mjs | models 列出 Codex、opencode 和 API 的清单并核对配置里的模型，读不到清单时如实报告；check 按 Codex 清单核对推理强度、不发执行请求，模型不在清单里或读不到清单时只提示；opencode 清单外的档位不发请求、修正提示列出支持的档位；模型提供方前缀和 modules 里的代号写错时提示最接近的写法；config 和 check 输出总表，含 required、统一的 modules.*[i] 位置、没用到的协作方、明文 key、shell 权限和失效的旧代号，档位不支持的格子写明原因 |
| 19 实测补漏 | generalization.test.mjs、review.test.mjs、run.test.mjs、status-watch.test.mjs | 续接到 "claude code" 的等级时不沿用上一轮的协作方；opencode 审查和 check 总是带标题、被厂商限流时提示稍后再试、出错的回复没有 tokens 时照常统计用量；来源不明的改动落在同组其他任务的范围里时标出 group_run；组汇总把已续接的任务记作已续接 |
| 20 pi 协作方 | pi.test.mjs、generalization.test.mjs | 配置校验（模型写法、run_access、推理强度、执行授权按能力判断）；讨论的隔离参数、只读工具、守卫策略、事件翻译、用量和费用、续接同一会话；审查的补丁材料和不能续接；edit / shell 两档执行的工具、守卫策略、改动归属、被挡的操作、命令计数和 watch；报告修复同会话不开工具；出错、限流、截断、自动重试和推理强度被改；check 按清单核对推理强度并写明会换成哪一档；models 按 pi 的规则算推理强度；守卫扩展按档位放行工具、路径按 pi 的规则解析（@、~、file://、/c/…）并按真实路径判断（符号链接、junction）；拦截钩子按 pi 的参数语义判断；环境检测带隔离参数；check 按覆盖的模型核对；自动压缩的用量；会话头之后才失败时保留 stderr；流式输出期间定期写进度，status 显示思考或回答了多少字 |
| 21 Codex 沙箱 | check.test.mjs、run.test.mjs | check 按各类任务实际用的沙箱模式用 codex sandbox 探测（不调模型），坏了判不通过并给出修法，Windows 上顺带试 unelevated，danger-full-access 不探测；运行时命令因为沙箱失败时 notes 里说明，成功的命令不误判 |
| 22 watch 启动动画 | intro.test.mjs | 按模型名的关键字认头像（先看最后一段、取最先出现的、没有模型名时 Codex 用 ChatGPT、认不出用 ???）；头像数据的尺寸和调色板下标；按终端大小选大头像加 Claude、只画目标、中头像、轮流登场或文字徽章；每帧不超出终端、窄窗口的徽章和文字折行、名单太长时只写人数；macOS 自带终端没声明支持 24 位色时改用 256 色；中英文笑话齐全、占位符都换掉；任务提前结束马上收尾、接着用备用屏幕时不退出；dispatch.intro 默认开且只接受布尔值 |
| 23 出图素材 | assets.test.mjs | template 写出模板和按比例的格子坐标；cut 抠品红底、按名单命名、写出部件、manifest 和对照拼图；透明图清理光晕，soft 保留柔边；按格子命名并合并同格碎片；贴边和格外部件判失败、check 退出码为 1；diff 逐格比较；--vector 用自带描图转 SVG（透明的洞留空、轮廓和颜色对得上原图），自带描图的直边是直线、圆是曲线、对称水滴不被压没，两色之间的过渡带并掉、比两侧都深的细线保留、透明里的孤立小点去掉，只出现在细线上的颜色不丢、1 像素宽的线不被压没、相邻两个小块不互换颜色、大量小洞时不慢；参数错误；结果的 image_calls 和没传参考图的提示；名单重名和只差大小写；一个部件都没有时判失败；diff 发现被删掉的部件；出图参数按代码结构解析（字符串里的参数名、显式 null、带引号的键、变量传参、没执行的调用）；任务说明只提到参数名时不误报没传参考图；格子合并后按格子号命名；align 找回部件的缩放和偏移、写出对齐图和对照图、按区域算色差、区域写错时报错，不把部件缩小塞进同色区域、细线也能对齐、缩放上下限是硬约束；patch 只取成片的改动（去掉轮廓位移和外轮廓），--keep 限定区域；trace 分出描边、底色和阴影并写出 SVG，种子不对时报错；layers 从定稿图取出同画布的图层：背景板只写回主体范围并校色，部件按原位置裁出，下层部件穿过自己那段描边往上层下面延长、延长段不露在背景上，矢量部件的位置是整张画布，部件名不合法、重名、叫 static 或 extendUnder 指向不存在的部件时报错，主体占大半张画面时噪声只按背景估计、校色一直铺到主体中心；patch 和 layers 都留下测出的原始对齐；capture 的本地路径可以带 ?参数；capture 和 playback 用假浏览器截图、检查静止区域和首尾衔接、写出 APNG |
| 10 共用文件同步 | sync.test.mjs | 中英文插件的共用文件、schema 结构和版本号一致 |
| 24 第一期配置和迁移 | modules.test.mjs、structure-migration.test.mjs | 模块遍历顺序一致，单对象只在内存规范为列表；levels 迁移一次备份，顺序强度不变且不补格子或 required；已有备份加时间戳，校验失败的 levels 不改原文；用户和项目不能同时写 levels 和 modules；空列表、重复、能力、required 类型、缺少 agent、对象类型、max_seats 和执行格子多个必选校验；未知模块或格子；旧单对象已写 agent 时也保留逐字段继承；图像引用参与旧类型改名、去重与 codex 保留判断；check 和 summary 覆盖仅用于图像的协作方、强度和 shell 提醒 |
| 25 第一期项目收紧 | project-tightening.test.mjs | 项目保留用户顺序和必选，忽略模型及其他字段，解析旧代号；时长和席位取严（含 stall_min / busy_ask_min 的 0）；项目先校验 dispatch；只降低 Codex 和 pi 的有序强度，未写时不能加，opencode / api 不能改；不能只去掉必选；各模块过滤为空报错；用户关闭的格子不能打开；整格关闭记 closed_by_project，点名及续接均拒绝；用户自己的 Claude 格子可点名并标 outside_cell |
| 26 第一期选派和计划 | plan.test.mjs | 三模块单席必须选格子并遵守候选和必选；计划先校验格子、候选、必选、能力、席位上限和参数，失败不落盘；保存同方多席、角色、理由、默认模型和启动命令，不占任务名额；启动参数配对及一致性；启动时按当前配置重验整份计划；同一席并发只启动一次；准入拒绝不消耗席位；旧代号席位；续接沿用计划席位角色且不查其他必选；四种适配器的模型覆盖规则及标记；status 的三种 state、missing_required、最新续接和有效结果判定；status / watch 不把 plans 当任务 |
| 27 第一期并发和锁 | admission.test.mjs、run.test.mjs、structure-migration.test.mjs | 同组 discuss 和 review 不查写入范围，exec 仍检查；groupScopeOwner 只认 exec，而且只认运行时间有重叠的；协作方跨组跨会话及旧代号并发计数不变；活着的登记锁不按年龄被抢（旧 pid 和 pid/token）；死锁回收及一分钟等待上限；读不出持有者的旧锁放一会儿后清掉；登记锁和清理锁正被删除时短暂报 EPERM、EACCES、EBUSY 只是稍等再试，一直报错才抛出原错误，删除前每次重试都重新确认锁还是残留的或自己的；显式释放和退出清理只删自己的 token |
| 28 第一期偏好来源 | hooks.test.mjs | 新旧位置的用户和项目偏好分开标注来源与硬规则；英文偏好来源标注与硬规则一致，plans 不算未完成任务 |
| 29 续接换格子的必选 | plan.test.mjs | 无计划续接换格子重验必选，同格返工保留豁免且兼容旧 level；计划续接禁止换格子（包括 Claude 格子） |
| 30 计划席位配置重验 | plan.test.mjs | 计划保存的模型和强度必须匹配当前格子，覆盖参数不能绕过重验；覆盖模型按当前提供方检查并标记 |
| 31 残留锁串行回收 | admission.test.mjs | 活进程持有清理锁时不回收残留登记锁，释放后任务登记；清理锁的持有者退出后清掉清理锁并完成登记；读不出持有者的旧清理锁放一会儿后清掉并完成登记 |
| 32 图像块是否配置 | modules.test.mjs、config.test.mjs、generalization.test.mjs | levels 迁移后 image_configured 为 false；首次生成（有或没有 Codex）为 true；显式图像块为 true，项目配置不影响 |
| 33 给旧版留的 levels 说明 | modules.test.mjs | 迁移后文件里的 levels 是说明文字并排在 modules 前面，再读不再迁移；levels 是说明文字（中文、英文或手写）又有 modules 时照常读取、不改文件；levels 是字符串却没有 modules 时报错；带说明的文件因旧类型再次改写时保留原说明；没写 levels 的旧配置（只有旧类型、只有零点十以前的键）和空字符串说明改写后都写上标准说明；项目配置里的说明和 modules 照常收紧 |
| 34 审查对象和材料 | review-targets.test.mjs | 四种 --target 的参数错误在登记和调用前拒绝（写错、非 diff 缺 --file 或带范围参数、缺说明、visual 不是图片或带行范围）；files 和 claims 在干净仓库和非 Git 目录都能审，整文件指纹保留附件顺序和行范围；--file 在 Codex、opencode、pi 的审查里列成重点文件，API 附上内容；diff 补丁超限时 opencode 和 pi 不登记、不调用 |
| 35 结构化审查报告和 API 审查 | review-targets.test.mjs、review.test.mjs | Codex 带说明或 --file 的审查用 --output-schema 并解析报告，只有无说明、无附件的 git diff 走原生审查；opencode、pi、API 的审查报告修复一次，仍不合格保留原文并警告；审查不收集中途和最终提问；API 审查的系统提示、材料、任务类型，非 Git 的 diff、材料超限和不能续接；visual 在单席、格外点名、建计划和席位启动都拒绝不能看图的协作方，Codex 逐图提示 |
| 36 审查计划和材料指纹 | review-targets.test.mjs | 计划固定审查对象、文件、范围和指纹，其他模块不能写材料参数，空 diff 不写计划；席位启动拒绝材料参数和材料变化，旧计划按 diff 兼容；三种 diff 范围各自重算；结束时材料被改、被删或 git 出错不丢结果，stale 如实记录 |
| 37 讨论和审查的只读三级 | readonly-review.test.mjs | opencode、pi、API 为 tools；Codex 按 foreman 配置和 config.toml 判断 sandbox 或 audited，续接的讨论沿用；audited 拒绝 --no-snapshot、快照失败不启动；有工具事件或自报的写入记为失败并列出 readonly_violation，sandbox 级别不拍快照时看事件；沙箱挡下的写入（failed）不算；只有归属未知的改动不算违规但标 stale；config 和 check 每方一条 readonly_audited 提醒；watch 显示审查结论、问题和拿不准的地方（中英文） |
| 38 冒烟小修：取消和计划状态 | cancel-and-plans.test.mjs | 取消原因照实写（cancel 命令、实时查看里按 x、旧版标记）；取消时记下已完成请求的用量并说明进行中的那次没算，一次都没完成时 usage 为 null；cancel 等不到调度进程停下时强行结束并补写结果，带上 Codex 会话记录里的用量；组视图和 status --group 写出计划完整、进行中（必选还没启动）或不完整（缺哪个必选）；项目关掉的格子，建计划和启动席位都说明是项目配置关的；强行结束前先确认调度进程已经退出，它已经写好的结果不被覆盖，只写了一半的结果换成补写的最简结果；计划状态里没审完或格式不合格的审查不算有效，Codex 原生审查和旧记录的文字算 |
| 39 图像计划和能力 | image.test.mjs | 路线必填、取值及格子匹配，generate 不带角色，审查参数仅供 review；候选、必选、上限、用户和项目关格、席位模型和强度重验；路线 4 不触发 generate 必选；generate 依赖完整 images 接口，draw 依赖 run 和 run_access |
| 40 图像路线确认 | image.test.mjs | 当前会话最近一次路线弹窗：缺会话、没提问、未回答、取消、自由文字、多选及路线不一致拒绝；同一次回答支持两格、多交付物和重复计划，无标记弹窗不影响；先跑 Pre/Post 钩子再建计划；按 asked 顺序判断，迟到回答不覆盖新弹窗，漏记 asked 时认 answered；非法会话 ID 即使能指向有效回答也拒绝；漏记提问的旧弹窗再次回答不改顺序，没有 tool_use_id 的记录各算一次，同一弹窗只认最后一条回答，坏记录不报错 |
| 41 路线回答钩子 | image.test.mjs | 只记录路线问题及其回答，不记其他弹窗或回答；非法会话、其他工具和坏 JSON 静默忽略；tool_response 优先、tool_input 回退、无回答记空对象；自定义及旧名配置目录，先记录再清理超过 30 天的 jsonl，旧条目删不掉、目录读不出来都不影响记录 |
| 42 图像执行和续接 | image.test.mjs | image 必须带计划和 scope、不接受 level 或 agent；结果与 meta 的 module/cell/step/route/level、图片、快照、计划完整状态及 status/watch 标题；续接不查 run 等级、不重新确认、排除旧图片，候选移除和关格拒绝；执行并发和同组范围准入；启动和续接只把被 .gitignore 忽略的项目内 scope 并入 track（去重，工作目录本身、没被忽略的目录和项目外路径不并入）；续接沿用 scope 时自己的上一轮不算同组其他任务；会话记录读不出来时用量统计为空、结果照常落盘 |
| 43 图像路线告警 | image.test.mjs | 普通 run 及其续接出图告警；路线 4 draw 出位图告警；路线 3/4 的改动 SVG 嵌入位图告警，路线 2 允许混合；排除同组其他席位和范围外的 unknown，事件和报告合并去重，无快照仍检查并注明部分检查，scope 在工作目录外时也注明；超过 2 MB 的 SVG 分块检查且识别跨块标签 |
| 44 冒烟修复：stale | image-smoke.test.mjs | status、status --group、watch 两种结束行与组汇总、计划行和席位显示 stale，计划仍完整；最新轮结果为准，stale 与未启动必选同时说明，中英文分隔符一致 |
| 45 冒烟修复：看图步骤 | image-smoke.test.mjs | 代码和函数形式的 view_image、字面量及未知路径、成功失败未结束、since 过滤；运行中增量写事件及活动步骤，时间线和详细模式显示，续接只读本轮新增日志且不增加命令数；同一 call_id 合并调用并累计图片数，部分成功记未知，后续文字不抹掉成功；输出先到和末行无换行仍能配对；apply_patch 中的看图及出图代码不记调用；会话文件中途被删仍保留结果并正常结束；一次读不满时读到文件末尾，收尾时没写完的末行留到下次 |
| 46 冒烟修复：费用和措辞 | image-smoke.test.mjs | opencode 费用接在 status/watch 用量行及组汇总后，只有费用也显示、零和小额格式；审查默认 uncommitted 为 true，旧 false 计划仍审未提交改动；项目关格仅在显式 agent 时提点名 |
| 47 显示统一：标签、状态词、用时、数字和分隔符（中英两个插件都用英文那一套，显示得一样） | display.test.mjs、status-watch.test.mjs | status 表：状态词和用时写英文，中英两个插件一样；模式和等级写原词，模型标签写成"模型 强度 · 接入方式"，各列按显示宽度对齐；开工那一行中英两个插件都写 <模式> started · <模型> <强度> · <接入方式> · <等级> · run dir，用" · "分隔；watch --run 非 TTY 的Codex 执行输出与期望一致；watch --group 非 TTY 的四类任务汇总与期望一致 |
| 48 组视图实时面板 | display.test.mjs | 组视图实时面板按 100x30 和 64x18 的终端排版：每席顶上是最近说的话，下面是折叠后的动作；实时面板只给状态上色：任务行和模型行加粗，模型行跟着状态变色，动作和思考摘要用暗色，说的话用默认色；组视图窗口不够高时先把正文压到每席一行，还放不下就翻看，底部写下面还有多少行；组视图汇总最后写一行回看命令：记录目录带空格时给路径加引号，换上 run_id 就能运行 |
| 49 时间线的实时画面 | display.test.mjs | 单任务的实时画面：顶部固定身份行和任务行，读文件和搜索照写，思考摘要在底部，失败的命令行尾标出 |
| 50 子命令 --help | display.test.mjs | 子命令认 --help 和 -h：只打印这一条的用法，退出码 0，不生成配置文件，也不迁移旧版的配置（写在选项值里的 --help、-h 不算；总用法末尾指向各子命令的 --help） |
| 51 目录归属和归同组任务 | run.test.mjs | 报告里写成目录的改动按前缀归属：目录下被追踪的文件都算自称改过的，前缀下没有被追踪的文件才提示没追踪到；来源不明的改动落在同组其他任务的范围里时，标出是哪个任务（group_total、时间线结束行和组汇总里的"N from other runs in the group"）；同组任务只有运行时间和这个任务重叠的才能认领它的改动：开始前就结束的不认领，有重叠的认领 |
| 52 元数据读写竞态 | meta-writes.test.mjs | findRun 读到空文件或半份 JSON 时稍等再读，一直读不出才抛出原错误；meta.json 改名一直失败时退回直接覆盖写，不抛错也不留临时文件；cancel 等待时 meta.json 读不出不算已停下，调度进程退出后不再等满就补写记录；meta.json 一律先写临时文件再改名，并发读不会读到半份（执行、cancel 标记已处理、强行结束） |
| 52 只读任务的根目录声明 | readonly-review.test.mjs | 只读任务的报告把工作目录本身（./）写进 files_changed 不算违规，没有快照时也一样；具体的文件照样算 |
| 53 meta.json 被占用（不许写共享） | meta-writes.test.mjs、hooks.test.mjs | 改名和覆盖都被占用时返回 false 并清理临时文件，后续完整写入和结束重试可以补上；结果被占用或只写了一半时暂不采用，进程退出后完整结果的状态优先于旧元数据；会话 ID 写入被占用不影响 runner 完成，异常或直接退出也清理影子目录和监听；会话写入和收尾写入都放弃后，续接从结果取会话，cancel 不误标记为已处理；讨论父链中元数据仍为运行中但结果已完成的轮次计入上限；登记写入放弃就删除运行目录并释放锁，不启动协作方；cancel 等待期间进程退出而元数据未更新时采用结果状态；cancel 第一次读不出结果、再读才读到时，以再读的为准，不把完成的任务标记为已处理；强行结束前一刻调度进程自己收完了尾、结果正被占着时，cancel 照原样返回，不改成已取消；会话提醒以已退出任务的结果为准，没有结果仍提醒中断；Windows 真实只读共享占用 meta.json 时任务继续运行，释放后完整收尾（其他平台跳过）；cancel 的结束写入被占用时，标记已处理返回错误，强行结束仍返回成功并带警告 |
| 54 窄窗口的席位身份行和汇总折行 | display.test.mjs | 40 列的四席身份行都保留状态词和时钟，API 排队和回答时也一样；64 列先保留状态词和时钟，再截模型标签，身份行不写计数；needs_input 的长状态在 40 列不越界，44 列能保留时钟；30 列和 22 列的 API 排队、回答及 Codex 运行身份行都不越界；最终汇总的用量按分隔符折行，长改动说明在 83 列和 40 列都写全，run_id 靠右 |
| 55 搜索的写法和组汇总 | opencode-run.test.mjs、pi.test.mjs、status-watch.test.mjs | opencode 和 pi 的搜索都先写模式，再写 glob 过滤和路径，没有模式时写工具名；组视图汇总里每席写结论（不带 Report、Position 前缀）、用量和 run_id |
| 56 judge 记录去留 | judge-stats.test.mjs | judge 写入规定字段、保留未修改条目，第二次调用覆盖去留并补齐 unjudged；judge 拒绝空调用、不合格或未知编号、冲突、运行中任务和执行任务；judge --same 校验语法、自指、同伴、两端编号、目标存在以及左侧去留；judge --same 合并同编号多条链接、去重、整体替换并保留其他编号的链接；judge 支持讨论自由编号、旧续接的根模块和原生审查，旧 verdict 损坏时重新记；judge 拒绝解析后为空的去留和 same，不写 verdict 或锁 |
| 57 stats 汇总口径 | judge-stats.test.mjs | stats 合并两种接入的基础模型，保留用量缺失并只对 opencode/pi 计费用缺失；stats 按链扣除累计用量、处理倒退并将升级轮次记在各自模型上；stats 返工只算正常交回报告后的续接，图像沿根模块统计；stats 同一计划的去留和 --same 无向传递链接按问题计 unique；stats 无计划按组、会话和模块分同伴，单模型和无组记录不参与 unique；stats --module/--since 按根过滤整链，支持小数并拒绝非法值；stats 空记录、坏元数据/结果/verdict 和运行中跳过计数，过滤后只统计保留项；stats 完整席位链阻止向运行中续接补读，排除中位用时并跳过运行中的根；stats 祖先不可读时跳过后代并计 unreadable，父目录不存在时才另算根；stats no_issues 空报告自动计入去留和 unique 基数，incomplete 或坏 verdict 不替代；stats 同席多轮的同编号只计一条，same 指向续接时连接到同一根 |
| 58 judge、stats 的帮助、并发和 runEnd | judge-stats.test.mjs | judge 和 stats 的 --help/-h 在坏配置下仍输出中英文用法且不创建记录目录；judge 两个进程并发合并同一任务的不同编号，均成功且不丢条目；judge 回收超过 30 秒的死进程锁，写完清理锁和临时文件；judge 新锁等待 5 秒报 judgeBusy，保留别人的锁且不写去留；runEnd 已处理分支排除 verdict、锁和各进程的临时文件 |
| 59 冒烟修复：opencode 中途出错后恢复 | opencode-retry.test.mjs、pi.test.mjs | 审查回放 mpxt：退出码 1 的已恢复错误允许同会话修复，修复调用也可恢复且提示去重；审查回放 mpxt：修复后仍不合格维持 done、空报告和警告，不再发第三次请求；审查错误后没有正常结束：最后事件是 error 时失败且不修复；审查最后一次 stop 后又出 error：全部错误仍未恢复且不修复；审查最后一次结束为 tool-calls：此前有 stop 也不能恢复错误；审查最后一次结束为 length：此前有 stop 也不能恢复错误；审查没有 error 但退出码非零：即使以 stop 结束也仍失败；审查回放 mpxt 后修复调用失败：恢复过的错误并回 errors，不写恢复提示；审查回放 7ce3：重试后写完报告就退出、没有 step_finish，也算恢复，直接收下报告；审查重试后以写完的报告残片结尾：算恢复，照常修复一次；审查重试后最后一段回复没写完（没有 time.end）：仍然失败、不修复；pi 自动重试覆盖带残片的错误回复，最后回复不合格时同会话修复一次 |
| 60 冒烟修复：进程号复用的旧 running 记录 | running-check.test.mjs、status-watch.test.mjs、hooks.test.mjs、cancel-and-plans.test.mjs | processStartTimes 一次查询多个真实进程，缺失进程为 null，单进程接口保持一致；isRunning 首次自行查询，重复判断复用缓存，无候选时不查询；same 和 unknown 缓存 60 秒后重新查询，other 永久有效；checkAdmission 批量核对，复用进程号的旧记录不占名额，当前 runner 仍占名额；runOutcome 将复用进程号且无结果的旧记录记为 interrupted，并重读刚收尾的元数据；status 将复用进程号的旧 running 显示为 interrupted，当前 runner 仍为 running；watch 单任务和组视图将复用进程号的旧 running 视为中断并退出；会话提醒批量识别复用进程号的旧 running，保留当前 runner 且不回写记录；观察到退出后清除缓存，isRunning 和 checkRunners 都会重新查询复用的进程号；newRunDir 在锁外预查，准入不查询，旧记录不占名额，预查后登记的 runner 仍占名额；确认复用后进程号消失再出现，查不到启动时间也不算回运行中；拿锁前就有、当时元数据读不出的旧记录，准入时在锁内补查；会话提醒以 3000 毫秒查询，查询失败仍输出其余提醒；会话提醒核对期间任务写好结果时以结果为准，不误报中断 |
| 61 冒烟修复：judge 的运行中同伴和 --clear | judge-stats.test.mjs | judge --same 拒绝运行中同伴且不写文件，运行中任务也不能 clear；judge 只给 --clear 可删除报告外的误记和自身链接，保留其他条目及同伴链接；judge --clear 删完移除 verdict，file 为 null 且 stats 不再计为记过去留；judge --clear 删完 no_issues 审查席的误记后恢复自动零条统计；judge --clear 拒绝未记过或格式错误的编号，报出已记列表且不改文件；judge --clear 与 accept partial reject 或 same 左侧冲突时锁外拒绝；judge --clear 等到锁后按最新 items 校验并删除 |
| 62 冒烟修复：补漏席标记 | plan.test.mjs | status --plan 列出未启动的补漏和 gap 席，跑完后清空且不改变 state 算法；status --group 计划行显示未启动及运行中的 gap seat not finished |
| 63 链路审计修复：续接和准入 | resume-chain.test.mjs、plan.test.mjs | 续接拒绝运行中和旧轮次，锁内阻止并行分叉，最新结束轮次可续接；续接不能改组或给无组任务加组，允许同组重给 scope 并照常查重叠；锁内重新检查续接父任务是否仍在运行；审查席失败或无有效结果可以重启，有运行轮次或有效审查就拒绝；非审查席重启提示最新一轮，而不是最初一轮；findRun 拒绝相对路径、绝对路径和点目录，last 仍可读取；时钟回拨直接取最新时间加一秒，跨年也不会卡住登记锁 |
| 64 链路审计修复：结果有效性和计划状态 | resume-chain.test.mjs、status-watch.test.mjs、meta-writes.test.mjs | 统一结果有效性：四模块、旧审查、原生审查、incomplete、partial 和交回问题；跨会话组计划使用同次读取的全部记录，status 和 watch 只展示当前会话 |
| 65 链路审计修复：只读、图像和续接目录 | resume-chain.test.mjs | 快照外自报改动算只读违规，快照内无变化和工作目录自身不算，track 可覆盖忽略规则；路线三手画出位图告警，SVG 带命名空间并跨块仍识别，imageset 不误判；add-dir 元数据存绝对路径，续接合并去重并用 Codex TOML writable_roots 传递；出图参数只信最后一次展开之后明确写出的属性 |
| 66 链路审计修复：材料指纹、用量、排队检查、judge 和钩子 | review-scope.test.mjs、review-targets.test.mjs、resume-chain.test.mjs、usage-busy.test.mjs、judge-stats.test.mjs、hooks.test.mjs | diff 指纹包含附件路径、行范围和完整内容，非 Git 目录仍返回 null；超过 1 MiB 的未跟踪文件只改内容也会改变指纹，不增加文件字段或补丁；diff 计划拒绝附件变化，审查结束时也复核补丁之外的附件；diff 审查结束复核也包含附件指纹；讨论缺失用量时 usage 和 usage_scope 都写 null；API 明确返回零用量时保留零值，不记缺失提示；API 取消前未收到用量时只保留通用取消提示；await-busy 按任务目录采用项目阈值，同一目录只加载一次；await-busy 用户阈值为零时仍采用项目阈值，并忽略阈值为零的任务；await-busy 全部零阈值时禁用，--after 统一覆盖任务阈值；judge 不抢超过 30 秒的活进程锁，仍等待 5 秒报 judgeBusy；judge --same 拒绝同一席的另一轮和同一条续接链（judge-stats.test.mjs）；带 -y、--yes、-p 的 npx 调用被拦下、--help 放行（hooks.test.mjs）；Windows 上计划目录比较忽略路径大小写 |
| 67 链路审计复审：核心链路返工 | resume-chain.test.mjs | 目录自报包含忽略文件和子目录时算快照外，track 覆盖的部分可以排除；目录里被忽略的文件在任务中被删掉也算快照外；--track 的文件在被忽略目录里时不把整个目录算成盲区；covers 命令出错时保留快照，所有非 root 自报从严计违规；Codex 续接合并用户 TOML 可写目录，支持跨行注释、单双引号、点号键和带引号的表头，读不懂时不覆盖；计划轮次、准入提示和无当前会话的组视图都按 run id 选最新；生成 run id 忽略 backup、zzz 等非格式目录并释放登记锁；多条坏元数据共享约一秒的准入重读预算，仍列出所有坏路径；非审查席没有续接材料时可重启，有有效结果、会话或 API 消息时仍拒绝；旧续接缺 kind 和 module 时沿祖先识别讨论并继续计轮数；missing.label 和计划行沿用面板状态词，blocked 和 partial 不写成无结果；watch 组视图同计划同席只显示 run id 最大的重启轮次，计划仍保留完整历史；出图参数的展开前允许块注释和行注释，注释里的逗号与括号不干扰解析；审查席失败或无有效结果可以重启，有运行轮次或有效审查就拒绝（status --group 把重启前的轮次算已续接） |
| 68 链路审计复审：外围返工 | judge-stats.test.mjs、hooks.test.mjs、usage-busy.test.mjs | judge 两方同时回收死进程锁时不删新锁，并发写入不丢条目；stats 正常交回 partial 报告后的续接也算返工；stats 按 run id 扣除时钟回拨后的累计用量；stats 同计划同席的无 parent 重启只算一席，重复观点沿用同一个根；stats 合并重启的席位时，各会话的累计用量分开扣减；npx 带值的选项、写了几个 -p、--registry 后的包名、-c 和 --call= 整条命令都被拦下，npx -c 别的命令放行（hooks.test.mjs）；API 修复请求被取消时保留已返回的累计用量，不加缺失提示 |
| 69 按代号递增的锁和跨会话组视图 | locks.test.mjs、judge-stats.test.mjs、resume-chain.test.mjs、admission.test.mjs | 两个进程同时接管死锁，暂停的旧读者不能删掉新持有者；活持有者不按年龄被抢，等待上限后 busy 收到当前文件和 pid；没权限探测（EPERM）时锁当成被占着，任务的 pidAlive 仍按进程不在算；进程号被别的程序复用时不按时间猜身份，等到上限报 busy、保留锁，删掉锁文件后可接着用；硬链接暂时报 EACCES 时短暂重试后照样拿到，不当成不支持硬链接；数字代号、done 清理和过时建锁复查，释放幂等且临时文件不残留；残缺或读失败的锁不按年龄接管，目录快照中的本体被删后仍递增代号；持有者 exit 后下一进程能接管；持有者 kill 后下一进程能接管；登记先等旧版活锁，持有者退出后接管并先释放旧路径；.start.lock 的 legacy 选项等待活锁和活清理锁，回收残留后退出按序释放；verdict.json.lock 的 legacy 选项等待活锁和活清理锁，回收残留后退出按序释放；超过上限后只做最后一轮，EEXIST 和更高代号都会报 busy，空锁仍可拿到；只剩 done 时仍沿最大代号递增，并清理死进程临时文件、保留活进程文件；八个进程同时抢锁，临界区读改写计数不丢失；硬链接不支持时退回 wx（EPERM 先重试几次），目录缓存避免第二次重试，失败也清掉临时文件；judge 两方同时回收死进程锁时不删新锁，并发写入不丢条目；judge 回收超过 30 秒的死进程锁，写完清理旧代和临时文件；另一个会话重启同席并续接任务链，watch 显示最新轮次且 status 将旧轮算已续接 |
| 70 实时查看重构 | display.test.mjs、status-watch.test.mjs、submissions.test.mjs、image.test.mjs、image-smoke.test.mjs、cancel-and-plans.test.mjs、resume-chain.test.mjs、questions.test.mjs | 单任务顶部两行：模型行"模型 强度 · 接入方式"跟着状态上色、右边状态和时钟，任务行"模块 · 标题 · 等级"，执行和图像的续接按续接链写第几轮；组视图标题行写模块、模式（panel、roles、split）、标题和等级，右边是各状态的个数，计划只在有缺口时写一行（不写计划号）；Claude Code 席排在最前、和外部席一样写结论，单席查看照样显示答卷；交回问题记作 ?，失败的命令和没搜到的搜索标在行尾 |

## 说明

- 整套约 90 秒，大头是几处真实等待：Codex 卡死检测每 30 秒查一次，测试要等无活动的任务真的被判卡死；API 断流后的重试固定等 5 秒；已结束任务组的 watch 固定停留 5 秒。
- Node 24 第一次运行 `config` 时可能附带 DEP0190 警告，测试只核对插件自己的提示行。
- 不覆盖：真实的 Codex 和 opencode、外部 API、真实终端里的按键、翻看和窗口大小变化（实时画面的排版用 `FOREMAN_TEST_SCREEN` 模拟的固定宽高核对）。这些发布前按设计文档 9.2 节的清单手工冒烟。
- 改了 watch 的排版，要人工核对新输出后再更新 `expected/` 里的文本。
- 加了新行为，同时在上面的覆盖表里补一行。
