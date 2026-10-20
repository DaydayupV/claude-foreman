// 脚本里所有给人看的文字：终端提示、报错，以及附加给 Codex 的固定约束。
// 中英两个插件共用这份文件，由同目录的 language.json 决定用哪种语言。

const zh = {
  configModulesMigrated: (file, bak) => `已把配置文件 ${file} 里的 levels 改写成 modules：每一格的协作方、推理强度和顺序都没变，run 和 review 的单个条目改成了只有一项的列表。有一处行为变化：以前讨论一级里写的协作方全部参加，现在它们是候选，由 Claude 按规则挑选；想保留全员参加，就给这些条目加上 "required": true（/foreman:setup 可以帮着标）。配置里还没有图像块（出图 generate、手画 draw 两格），要用时运行 /foreman:setup 添加。文件里的 levels 留成了一行说明：旧版插件读到会直接报错，不会悄悄改成全由 Claude 自己做。原文件备份在 ${bak}`,
  levelsNote: '已改为 modules 写法（见下面的 modules）。读到这一行报错，说明 foreman 插件还是旧版，请升级',
  configBothFormats: (file) => `配置文件 ${file} 里同时写了 levels 和 modules，不知道以哪个为准。请删掉 levels（旧写法），只保留 modules`,
  projectLooser: (key, value, user) => `项目配置的 ${key}（${value}）比用户配置（${user}）宽松，项目配置只能收紧，已按用户配置`,
  projectCellOpened: (key) => `用户配置里 ${key} 是关着的（"claude code" 或 null），项目配置不能打开它，已忽略`,
  projectAgentDropped: (item, key) => `项目配置在 ${key} 里写了 ${item}，已忽略：项目配置只能从用户配置这一格已有的条目里删减、调低推理强度，或者把整格关掉（分级的写 "claude code"，图像的写 null）`,
  projectRequiredChanged: (key, agent) => `项目配置在 ${key} 里改了 ${agent} 的 required，已忽略：必选只能在用户配置里改`,
  projectEffortRaised: (key, agent, effort, user) => `项目配置在 ${key} 里把 ${agent} 的推理强度写成 ${effort}，比用户配置的 ${user} 高；项目配置只能调低，已按用户配置`,
  projectEffortUnordered: (key, agent, type) => `项目配置在 ${key} 里改了 ${agent} 的推理强度，已忽略：${type} 的推理强度没有统一的高低顺序，项目配置不能改`,
  projectEffortNoBase: (key, agent) => `项目配置在 ${key} 里给 ${agent} 写了推理强度，已忽略：用户配置这一条没写推理强度（用工具的默认值），比不出高低`,
  projectRequiredDropped: (key, agents) => `项目配置在 ${key} 里去掉了必选的 ${agents}，又留下了其他协作方。项目配置不能只去掉必选：要么留着它，要么把整格关掉（分级的写 "claude code"，图像的写 null）`,
  projectLevelEmpty: (key) => `项目配置去掉这些条目后，${key} 一个候选都不剩了。要关掉这一格，写 "claude code"（图像格子写 null）`,
  cellClosedByProject: (key, named) => `项目配置把 ${key} 关掉了，这个项目里这一格不能派出${named ? '，--agent 点名也不行' : ''}`,
  agentNotInLevel: (name, key, names) => `${name} 不在 ${key} 的候选里，这一格的候选：${names}`,
  agentRequired: (key, names) => `${key} 有多个候选：${names}。请用 --agent 指定这次派给谁；要同时派几个席位，先用 plan 建计划`,
  otherRequired: (key, selected, names) => `${key} 有必选的 ${names}，这次选的是 ${selected}，单席派发不能绕开必选。派给必选的那一方，或者先用 plan 建计划，把必选和 ${selected} 都放进去`,
  severalRequired: (key, names) => `${key} 有多个必选：${names}，单席派发满足不了，先用 plan 建计划，每个必选各占一席`,
  missingLevel: (levels) => `缺少 --level（${levels}）。--effort 只覆盖推理强度，不能代替 --level 选格子`,
  modelVendorChanged: (name, model, base) => `--model ${model} 和 ${name} 原来的模型 ${base} 不是同一个提供方（"提供方/" 前缀不同）。--model 只能在同一个提供方里换模型；要换一家，用这一格里的其他候选，或者改用户配置`,
  resumeAgentNotInCell: (agent, key, names) => `续接沿用上一轮的协作方 ${agent}，但它不在 ${key} 的候选里（${names}）。换一个包含它的等级续接，或者开新任务`,
  resumePlanCellChanged: (plan, from, to) => `这一轮属于计划 ${plan}（格子 ${from}），续接不能换到 ${to}。要换等级，按新等级重新建计划`,
  resumeOtherRequired: (key, agent, names) => `续接换到了 ${key}，这一格有必选的 ${names}，不能只由 ${agent} 续接。按新等级重新派出：交给必选的一方，或者建计划`,
  planSeatChanged: (id, seat, key) => `计划 ${id} 第 ${seat} 席的模型或推理强度和当前 ${key} 的配置不一致，请按当前配置重建计划`,
  levelForClaude: (level) => `按配置（modules.run.${level} 为 "claude code"），${level} 等级的执行任务由 Claude 自己做。要派出去，用 --agent 指定，推理强度用内置默认值`,
  levelEntryChoices: '应为 "claude code"、候选列表，或者单个 { "agent": "<代号>", "effort": "<强度>" }',
  imagesNotSupported: (name, type) => `${name}（${type}）不能出图，不能放进 generate 格子`,
  planRouteRequired: '图像计划要用 --route 写明路线：1 位图、2 位图 + 矢量混合、3 纯矢量（先出参考图）、4 纯矢量 / 代码',
  planRouteChoices: (value) => `--route 只能是 1、2、3、4，现在写的是 ${value}`,
  planRouteImageOnly: '--route 只用于图像计划（--module image）',
  planRouteCell: (mark, cell, uses) => `路线 ${mark} 用不到 ${cell} 格子，这条路线用的是 ${uses}`,
  routeUses: { 1: 'generate', 2: 'generate、draw', 3: 'generate（只出参考图）、draw', 4: 'draw' },
  generateNoRoles: 'generate 的席位不带角色：画面要求由 Claude 统一写进任务说明，把 =<角色名> 去掉',
  imageNeedsPlan: '图像任务要从计划启动：先用 plan --module image --cell <generate|draw> --route <1-4> 建计划（路线记在计划里），再用 image --plan <plan_id> --seat <序号> 启动',
  imageNoLevel: '图像任务不用 --level：格子（generate 或 draw）由计划决定，续接沿用原来的格子',
  imageNeedsScope: 'image 要用 --scope 写明输出目录（可以给多次），用来检查同组任务的写入范围是否重叠',
  imageCellClosed: (key) => `${key} 现在是 null（关着），图像任务不能派出或续接`,
  routeNoSession: '没有 Claude 会话 ID（环境变量 CLAUDE_CODE_SESSION_ID），对不上图像路线弹窗的回答，不建计划。图像计划要在 Claude Code 里、用户在弹窗里选好路线之后再建',
  routeNotAsked: '这个会话里没有图像路线弹窗的回答，不建计划。先用 AskUserQuestion 让用户选路线（问题里带"图像路线"，选项以 ①–④ 开头），用户选好后再建计划',
  routeNotAnswered: '最近一次图像路线弹窗没有回答（被取消了，或者还没选），不建计划。按 skill 重新弹窗确认',
  routeNotChosen: (answer) => `最近一次图像路线弹窗里，用户没有选 ①–④ 中的一项（回答是"${answer}"），不建计划。按用户的回答处理，需要时重新弹窗`,
  routeMismatch: (chosen, route) => `用户在最近一次图像路线弹窗里选的是路线 ${chosen}，和 --route ${route} 不一致，不建计划`,
  imageOutsideModule: '这一轮出了图（generated_images），但没有走图像模块：出图要先弹窗让用户选路线，再用 plan --module image 建计划、用 image 启动',
  vectorRouteImages: (mark) => `路线 ${mark} 不出位图，这一轮却生成了图片（generated_images）`,
  vectorEmbedsBitmap: (mark, files) => `路线 ${mark} 的成品应该全是路径，这些 SVG 里嵌了位图（<image>）：${files}`,
  vectorCheckPartial: (mark) => `路线 ${mark} 的手画任务有输出不在改动追踪范围内（没有快照，或者 --scope 在工作目录外），这部分只检查了执行事件和报告里列出的 SVG 有没有嵌位图`,
  planModuleChoices: (list) => `--module 只能是 ${list}`,
  planCellChoices: (module, list) => `${module} 的 --cell 只能是 ${list}`,
  planNoSeats: '至少要用 --seat 写一个席位，写法是 <代号> 或 <代号>=<角色名>',
  badSeat: (value) => `--seat 写法不对：${value}。应为 <代号> 或 <代号>=<角色名>`,
  planCellClosed: (key) => `${key} 是关着的（"claude code" 或 null），没有外部候选，不能建计划`,
  planCellClosedByProject: (key) => `项目配置把 ${key} 关掉了，这个项目里这一格不能派出，也不能建计划`,
  planMissingRequired: (key, names) => `${key} 的必选没有全部加入计划，缺：${names}`,
  planRequiredChanged: (id, key) => `计划 ${id} 的必选名单和当前 ${key} 不一致，请按当前配置重建计划`,
  planTooManySeats: (n, max) => `计划有 ${n} 个席位，超过了上限 dispatch.max_seats（${max}）`,
  planNotFound: (id) => `找不到计划 ${id}`,
  planSeatChoices: (id, n) => `计划 ${id} 有 ${n} 个席位，--seat 应为 1 到 ${n}`,
  planNeedsSeat: '用 --plan 启动时，要用 --seat 写明是第几席',
  seatNeedsPlan: '--seat 要和 --plan 一起用',
  planModuleMismatch: (id, module, cmd) => `计划 ${id} 是${zh.modeNames[module]}计划，不能用 ${cmd} 启动`,
  planAgentFlag: '用 --plan 启动时协作方取自计划，不要再写 --agent；要换推理强度用 --effort',
  planLevelMismatch: (id, cell, level) => `计划 ${id} 的格子是 ${cell}，和 --level ${level} 不一致；用计划启动时可以不写 --level`,
  planCwdMismatch: (id, cwd) => `计划 ${id} 是为 ${cwd} 建的，--cwd 和它不一致`,
  planGroupMismatch: (id, group) => `计划 ${id} 的组是 ${group}，--group 和它不一致；用计划启动时可以不写 --group`,
  seatAlreadyStarted: (id, seat, run) => `计划 ${id} 的第 ${seat} 席已经启动过（${run}）。返工用 resume --run ${run}`,
  planPlaceholders: { brief: '<任务说明.md>', topic: '<议题.md>', review: '<审查说明.md>', title: '<短标题>', scope: '<允许改动的路径>', outDir: '<输出目录>' },
  startLockBusy: (lock, pid, seconds) => `登记锁 ${lock} 被进程 ${pid} 占着，等了 ${seconds} 秒还没释放。确认这个进程不是 foreman（比如它的进程号被别的程序复用了）之后，删掉这个锁文件再试`,
  starterCodex: (model, complexModel) => `检测到 Codex，simple 和 normal 的执行任务由 Claude 自己做，复杂的执行任务用 ${model}，复杂的审查和讨论用 ${complexModel}；出图用 ${model}，手画矢量部件用 ${complexModel}。`,
  warnUnusedAgent: (name) => `${name} 没有用在任何格子里`,
  usage: '用法：cli.mjs <run|discuss|resume|review|image|plan|status|watch|config|check|models|await-busy|cancel|assets> [选项]，run / discuss / review 用 --level 选格子，可以加 [--agent <协作方>]，或者用 [--plan <计划> --seat <序号>] 启动计划里的一席；image 只能用 --plan <计划> --seat <序号> 启动，要带 --scope <输出目录>；check 支持 [--agent <协作方>]；discuss / resume 支持 [--file <路径[:起始行-结束行]>]...；run / resume / discuss / review 支持 [--track <路径>]...；run / resume / discuss 支持 [--group <组名>] [--scope <路径>]...；status 支持 [--group <组名>] 或 [--plan <计划>]，watch 支持 [--group <组名>]；每个子命令的完整参数用 cli.mjs <命令> --help（或 -h）查看',
  starterCreated: (file, parts) => `首次使用，已生成配置文件 ${file}：${parts}`,
  starterNoCodex: '没有检测到可用的 Codex，执行、审查和讨论暂时都由 Claude 自己做。',
  starterOpencode: (n) => `检测到 opencode（${n} 个可用模型），还没有加入。`,
  starterPi: (n) => `检测到 pi（${n} 个可用模型），还没有加入。`,
  starterApi: (names) => `检测到 ${names} 的 API key，已写进配置，还没加入讨论。`,
  starterNext: '运行 /foreman:setup 检查环境、选择要用的模型。',
  configStructureMigrated: (file, bak, renames) => `已把配置文件 ${file} 改成新写法（type 改为 codex cli / opencode cli / api，"claude" 改为 "claude code"${renames ? `，协作方代号按模型改名：${renames}` : ''}），原文件备份在 ${bak}`,
  modeNotSupported: (name, type, mode, modes) => `${name}（${type}）不能做${zh.modeNames[mode]}，它能做的是：${modes}`,
  levelIsClaude: (key) => `${key} 写的是 "claude code"，这一级不找外部协作方。要派出去，用 --agent 指定`,
  legacyAgentAlias: (old, name) => `协作方代号 ${old} 已改名为 ${name}，这次按新代号处理`,

  list: (items) => items.join('、'),

  // ---------- 配置 ----------
  configBadJson: (file, err) => `配置文件不是合法 JSON：${file}（${err}）`,
  starterFailed: (file, err) => `无法生成配置文件 ${file}（${err}），本次按内置默认值运行`,
  projectIgnored: (keys) => `项目配置里的 ${keys} 只能写在用户配置中，已忽略`,
  configMigrateFailed: (file, err) => `配置文件 ${file} 是旧写法，改写失败（${err}），本次在内存里按新结构读取`,
  // 改名迁移（codex-bridge → foreman）
  legacyConfigCopied: (from, to) => `插件已改名为 foreman：已把原来的配置 ${from} 复制到 ${to}，以后读新位置；旧文件保留，确认没问题后可以删掉`,
  legacyPrefsCopied: (from, to) => `插件已改名为 foreman：已把原来的偏好文件 ${from} 复制到 ${to}；旧文件保留`,
  legacyCopyFailed: (from, err) => `复制原来的文件 ${from} 失败（${err}），这次按没有这个文件处理`,
  legacyEnv: (old, name) => `环境变量 ${old} 已改名为 ${name}，这次先按旧名字读取；请改用新名字`,
  runsMoved: (from, to) => `已把运行记录目录从 ${from} 搬到 ${to}`,
  runsMoveDeferred: (from) => `原来的运行记录目录 ${from} 里还有任务在运行，这次先不搬，继续用它；下次运行时再搬`,
  runsMoveFailed: (from, err) => `搬运行记录目录 ${from} 失败（${err}），这次继续用原来的目录`,
  projectLegacyName: (old, name) => `项目里的 ${old} 是改名前的文件名，已照常读取；建议改名为 ${name}`,
  projectOldFormat: (file) => `项目配置 ${file} 是旧写法，已按新结构读取；建议改成新写法（见 README 的"配置"一节）`,
  configInvalid: (key, reason) => `配置 ${key} 无效：${reason}`,
  // 配置校验的报错原因，接在 configInvalid 后面
  invalid: {
    module: '只能是 discuss、run、review 或 image',
    imageCell: '只能是 generate 或 draw',
    candidates: '应为 "claude code" 或候选列表，例如 [{ "agent": "<代号>", "effort": "high" }]',
    imageCandidates: '应为候选列表或 null（关掉）；Claude 不能出位图，这里不能写 "claude code"',
    oneRequired: '这一格一次只派一个执行方，最多只能有一个必选条目',
    duplicate: '同一个协作方在一格里只能出现一次',
    object: '应为对象',
    boolean: '应为 true 或 false',
    watch: '只能是 auto 或 off',
    positiveInt: '应为不小于 1 的整数',
    minutes: '应为分钟数（stall_min 和 busy_ask_min 可以是 0）',
    pathOrNull: '应为路径或 null',
    agentName: '代号只能用字母、数字、.、- 和 _，以字母或数字开头，不能叫 claude 或 claude code',
    agentType: '只能是 codex cli、opencode cli、pi cli 或 api',
    opencodeModel: '应写成 厂商/模型，例如 opencode-go/glm-5.3',
    piModel: '应写成 提供方/模型，例如 deepseek/deepseek-flash',
    runAccess: '应为 "edit" 或 "shell"',
    modelName: '应为模型名或 null',
    stringOrNull: '应为字符串或 null',
    sandbox: '只能是 read-only、workspace-write、danger-full-access 或 null',
    nonEmpty: '不能为空',
    level: '只能是 simple、normal 或 complex',
    agentRef: '应为 agents 里的协作方名字',
    apiKeyText: '应为字符串（还没填就留空 ""）',
    apiEffort: '应为字符串或 null',
  },
  unknownAgent: (key, name) => `配置 ${key} 引用了不存在的协作方 "${name}"（在 agents 里定义）`,
  unknownAgentFlag: (name) => `--agent 写的协作方 "${name}" 不在配置的 agents 里`,
  resumeAgentMismatch: (name, parent) => `续接沿用上一轮的协作方 ${parent}，不能改成 ${name}`,
  apiKeyMissing: (name, env) => `协作方 ${name} 没有可用的 API key：${env ? `环境变量 ${env} 没有设置，` : ''}请在 ~/.claude/foreman/config.json 的 agents.${name}.api_key 里填上（立即生效）${env ? `，或者设置环境变量 ${env}（设置后要重启 Claude Code）` : ''}`,
  fileNotFound: (p) => `找不到附带文件：${p}`,
  fileBinary: (p) => `附带文件不是文本文件：${p}`,
  badFileRange: (spec) => `附带文件的行范围写法不对：${spec}，应为 路径:起始行-结束行`,
  materialsTooLarge: (total, max, list) => `附带材料共 ${total} 字符，超过上限 ${max}。请精选文件或改用行范围。各文件：${list}`,
  apiNoMessages: (id) => `找不到运行 ${id} 的对话记录 messages.json，无法续接`,
  apiError: (name, kind, status, msg) => `${name} 请求失败（${kind}${status ? ` ${status}` : ''}）：${msg}`,
  apiBalance: (name, msg) => `${name} 账户余额不足：${msg}。充值后可以用 resume 继续`,
  apiBusy: (name, waited, retried) => `${name} 服务繁忙：请求在服务端排队约 ${waited}，还没开始处理就被断开${retried ? '，重试一次也一样' : ''}。稍后再试；这次可以先用其他参与方的结果`,
  apiTruncated: (name) => `${name} 的回答被截断（达到 max_tokens）。可以在 agents.${name}.extra_body 里调大 max_tokens`,
  reportInvalid: (name, file) => `${name} 两次都没有输出符合格式的报告，原文见 ${file}`,
  apiNoResponseFormat: '接口不接受 response_format，已去掉后重试，只靠提示词要求 JSON 格式',
  apiNoChanges: 'API 协作方不能改动文件，不追踪改动',
  opencodeNoChanges: 'opencode 协作方只能读文件和搜索，不能改动文件，不追踪改动',
  piNoChanges: 'pi 协作方只能读项目里的文件和搜索，不能改动文件，不追踪改动',
  runAccessRequired: (name, type) => `${name}（${type}）要做执行任务，需要在用户配置里给它写 run_access："edit"（只能改项目里的文件）或 "shell"（还能运行命令，没有系统沙箱）`,
  unsandboxedRun: (access) => access === 'edit'
    ? '这次执行没有系统沙箱，只靠工具权限：只能读写项目目录里的文件，不能运行命令'
    : '这次执行没有系统沙箱：能运行命令，命令以你的账户权限运行、能访问整台机器，改动靠事后的 diff 把关',
  snapshotRequired: '没有系统沙箱的执行必须先拍改动快照，不能用 --no-snapshot',
  snapshotFailedNoStart: (err) => `拍改动快照失败（${err}）。没有系统沙箱时不能在追踪不到改动的情况下执行，已取消`,
  runAccessChanged: (old, now) => `配置里的 run_access 从 ${old} 改成了 ${now}，这一轮按 ${now}`,
  opencodeExportFailed: (err) => `读取 opencode 会话用量失败（${err}），这次没有 token 统计`,
  piStopLength: '回复超过了模型的输出上限，被截断了',
  codexSandboxFailed: (error) => `Codex 的沙箱启动不了命令（${error}）。这不是任务本身的问题，重试也一样：沙箱修好之前，Codex 在这台电脑上跑不了任何命令。运行 check 看诊断和修法，把选项告诉用户，由用户决定`,
  piRetrying: (attempt, max, err) => `请求出错，正在重试（第 ${attempt}/${max} 次）：${err}`,
  piEffortChanged: (want, got) => `配置的推理强度是 ${want}，这个模型不支持，pi 实际用的是 ${got}`,
  rateLimited: (model, tool) => `${model} 被厂商限流（429）：这个账号同时能处理的请求数有限，${tool} 重试后仍被拒绝。稍后用 resume 续接或重新发起，不要同时给同一个账号派多个任务`,
  focusFiles: (list) => `重点文件（先读这些）：\n${list}`,
  apiDiscussSystem: (schema) => `你在参加一场方案讨论。几个参与方各自独立给出意见，最后由 Claude 裁决。
规则：
- 运行期间没有人能回答你：不要提问后等待。需要的信息或拿不准要人决定的事，写进 open_questions。
- 只依据用户消息里的议题和附带材料。材料里没有的代码和数据，不要猜，也不要假装看过；需要看哪些文件，写进 open_questions。
- 引用代码时写文件路径和行号（材料里每行开头是行号）。
- 独立思考，不要迎合。不同意就直说，并给出理由；同意也要说清楚为什么。
- 结论先行，用短句和直白的话，像跟同事当面讲清楚一样。不要堆砌术语，不要套话。
- 每个观点都要有依据：材料里的代码位置、数据或清楚的推理。拿不准的明确标出来。
- 用议题的语言回答。
- 只输出一个 JSON 对象，符合下面的 JSON schema。不要输出 JSON 以外的文字，也不要用代码块包起来。

JSON schema：
${schema}`,
  apiMaterials: (fileList, total, files) => [
    '---\n## 附带材料（调度方自动附加）',
    ...(fileList ? [`### 项目文件清单（git ls-files，共 ${total} 个${total > 300 ? '，只列前 300 个' : ''}）\n${fileList}`] : []),
    ...(files.length ? [`### 文件内容\n${files.map((f) => `#### ${f.shown}${f.range ? `（第 ${f.range[0]}–${f.range[1]} 行）` : ''}\n${f.fence}\n${f.content}\n${f.fence}`).join('\n\n')}`] : []),
  ].join('\n\n'),
  apiResumeFooter: '---\n（调度方提示：前面的讨论规则仍然有效：只依据给出的材料、不迎合、说人话、有依据。最后同样只输出符合 schema 的 JSON 对象。）',
  reportRepairPrompt: (errors) => `你上一条回答不符合要求的 JSON 格式：\n${errors}\n请只输出修正后的完整 JSON 对象，不要输出其他文字。`,
  opencodeDiscussFooter: (cwd, schema) => `---
## 讨论规则（调度方自动附加）
- 这是方案讨论，不是执行任务。你只能用读文件和搜索工具查看 ${cwd} 下的代码和数据，不能运行命令，也不能修改文件。
- 运行期间没有人能回答你：不要提问后等待。需要的信息或拿不准要人决定的事，写进 open_questions。
- 独立思考，不要迎合。不同意就直说，并给出理由；同意也要说清楚为什么。
- 结论先行，用短句和直白的话，像跟同事当面讲清楚一样。不要堆砌术语，不要套话。
- 每个观点都要有依据：代码位置（文件路径和行号）、数据或清楚的推理。拿不准的明确标出来；没看过的代码不要假装看过。
- 用议题的语言回答。
- 最后只输出一个 JSON 对象，符合下面的 JSON schema。不要输出 JSON 以外的文字，也不要用代码块包起来。

JSON schema：
${schema}`,
  opencodeResumeFooter: '---\n（调度方提示：前面的讨论规则仍然有效：只读、不迎合、说人话、有依据，运行中没人回答。最后同样只输出符合 schema 的 JSON 对象，不要用代码块包起来。）',
  opencodeRunFooter: (schema, access) => `---
## 交付格式（调度方自动附加）
- ${access === 'edit' ? '你没有运行命令的工具：不要尝试运行测试或脚本。完成标准里要求运行的命令，在报告的 verification 里写明"未运行，由调度方运行"。' : '你可以运行命令，但命令以用户的账户权限运行：只在项目目录里做事；任务说明没有允许的，不要碰项目以外的文件，不要联网下载或安装东西。'}
- 运行期间没有人能回答你：不要提问后等待，问题写进报告的 decision_requests。
- 最后只输出一个 JSON 对象，符合下面的 JSON schema。不要输出 JSON 以外的文字，也不要用代码块包起来。

JSON schema：
${schema}`,
  opencodeRunResumeFooter: '---\n（调度方提示：前面的固定约束和交付格式仍然有效。完成后同样只输出符合 schema 的 JSON 对象，不要用代码块包起来。）',

  // ---------- check ----------
  fixNode: (v) => `Node.js ${v} 太旧，需要 18 或更高版本：https://nodejs.org`,
  fixGit: (v) => `${v ? `${v} 太旧` : '没有找到 git'}，改动追踪用不了。请安装 Git 2.25 或更高版本：https://git-scm.com`,
  fixCodexMissing: '没有找到 Codex CLI。在终端运行 npm install -g @openai/codex 安装，再运行 codex login 登录；装在别的位置时，在配置的 agents.codex.bin 里写上路径',
  fixCodexLogin: 'Codex 还没有登录：在终端运行 codex login',
  fixCodexSandbox: (name, error, usedIn, unelevatedOk) => `Codex 的沙箱在这台电脑上启动不了命令（${error}），${name} 做 ${usedIn} 时任何命令都会失败；审批是 never，Codex 也没法申请放开。选一种修法：${unelevatedOk ? '① 推荐：在 ~/.codex/config.toml 的 [windows] 里写 sandbox = "unelevated"（刚在这台电脑上试过，能用）；' : process.platform === 'win32' ? '① 按 Codex 的 Windows 沙箱说明重新完成设置（通常要管理员权限），或者在 ~/.codex/config.toml 的 [windows] 里改成 sandbox = "unelevated" 再运行一次 check；' : '① 按 Codex 的文档修好本机的沙箱；'}② 在 foreman 配置里把 agents.${name}.sandbox 里对应的任务设成 "danger-full-access"：不用沙箱，Codex 能读写整台电脑，靠任务说明约束、事后看 diff 把关；③ 把用到 ${name} 的等级改成 "claude code" 或别的协作方。不要靠改 approval 解决：派出去的任务没人能批准`,
  fixApiKey: (name, env) => `还没有 API key：在 ~/.claude/foreman/config.json 的 agents.${name}.api_key 里填上（立即生效）${env ? `，或者设置环境变量 ${env}（设置后要重启 Claude Code）` : ''}，方法见 /foreman:setup。不打算用这个模型的话可以不管`,
  fixApiAuth: (name, source, env) => `key 无效或没有权限，检查${source === 'config' ? `配置里 agents.${name}.api_key` : `环境变量 ${env}`} 的值`,
  keyHidden: '（已填写，不显示）',
  fixApiBalance: '账户余额不足，充值后再试',
  fixApiRequest: (name) => `请求被拒绝，检查 agents.${name} 里的 model 和 base_url 是否正确`,
  fixApiNetwork: (url) => `连不上 ${url}，检查地址和网络`,
  fixApiRetry: '服务暂时不可用或太忙，稍后再试',
  fixApiBusy: '服务繁忙：请求一直在排队，没开始处理。稍后再试',
  fixPiMissing: () => '没有找到 pi。在终端运行 npm install -g @earendil-works/pi-coding-agent 安装；装在别的位置时，在配置的 agents 里给这个协作方写上 bin',
  fixPiCatalog: (name, err) => `读不到 pi 的模型清单（${err}）。先在终端运行 pi --list-models 看看能不能列出模型`,
  fixPiModel: (name, model) => `pi 里找不到模型 ${model}。在终端运行 pi --list-models 查看可用的模型（写成 提供方/模型），改好 agents.${name}.model；要用的厂商还没登录的话，先在 pi 里用 /login 登录`,
  fixPiRun: (name, err) => `pi 调用 ${name} 的模型失败：${err}。先在终端里用 pi -p "hi" --model <模型> 试一下`,
  piEffortClamped: (effort, to, supported) => `模型不支持 ${effort} 这一档，pi 不会报错，而是悄悄改用 ${to}；支持：${supported}`,
  fixOpencodeMissing: (name) => `没有找到 opencode。在终端运行 npm install -g @opencode/cli 安装；装在别的位置时，在配置的 agents.${name}.bin 里写上路径`,
  fixOpencodeModel: (name, model) => `opencode 里找不到模型 ${model}。在终端运行 opencode models 查看可用的模型，改好 agents.${name}.model；OpenCode Go 的模型要先在 opencode 里运行 /connect 登录`,
  fixOpencodeRun: (name, err) => `opencode 调用 ${name} 的模型失败：${err}。先在终端里用 opencode run -m <模型> "hi" 试一下`,
  fixOpencodeVariant: (name, list) => `${name} 的模型不支持这些推理强度（variant）：${list}。改成模型支持的档位，或者删掉这些 effort、用模型的默认设置；各模型支持哪些档位见厂商文档`,
  fixOpencodeVariantFailed: (name, list, err) => `${name} 的模型支持这些推理强度，但用它们发的请求失败了：${list}。档位本身没写错，报错是：${err}。多半是服务端的临时限制，稍后重跑 check；仍然失败，在终端里用 opencode run -m <模型>#<档位> "hi" 试一下`,
  // 模型清单、总表和最接近的写法
  closestHint: (list) => `。最接近的是：${list}`,
  modelNotInCatalog: (model, near = '') => `模型 ${model} 不在本机的模型清单里，核对不了它的推理强度${near ? `；最接近的是：${near}` : ''}`,
  effortNotInCatalog: (effort, supported) => `模型清单里没有 ${effort} 这一档，它支持：${supported}`,
  noEfforts: '没有可选档位（只能用默认设置）',
  effortAt: (effort, at, model, supported) => `${effort}（用在 ${at}；${model} 支持：${supported}）`,
  fixEffortUnsupported: (name, list) => `${name} 配置的推理强度有模型不支持的：${list}。改成支持的档位，或者删掉这些 effort、用模型的默认设置`,
  warnStaleAlias: (old, target, closest) => `旧代号 ${old} 指向的 ${target} 已经不在配置里，续接升级前的任务、或者写 --agent ${old} 时会找不到协作方。在 agent-aliases.json 里把它改成现在的代号${closest ? `（可能是 ${closest}）` : ''}`,
  warnPlaintextKey: (name) => `${name} 的 API key 明文写在配置文件里，这个文件不要提交或分享`,
  warnShellAccess: (name) => `${name} 开了 shell 执行权限：它的命令没有系统沙箱，以你的账户权限运行`,
  fixLauncherNotAscii: '记录目录的路径里有非英文字符，桌面版的终端面板打不开实时查看（它只接受 ASCII 命令）。在 ~/.claude/foreman/config.json 里把 dispatch.runs_dir 设成只含英文字母和数字的路径，比如 "D:/foreman-runs"。命令行版不受影响',

  // ---------- 参数 ----------

  // ---------- assets：出图之后的确定性处理 ----------
  assetsActions: {
    template: '--out <模板.png> --cols <列> --rows <行> [--aspect 1:1|3:2|2:3|3:1] [--names <名字,…>]',
    cut: '--image <图.png> --out <目录> [--slots <模板.slots.json>] [--names <名字,…>] [--matte hard|soft] [--key auto|#rrggbb] [--gap <像素>] [--min-area <占画面比例>] [--palette <#rrggbb,…> [--snap]] [--colors <N>] [--vector] [--allow-edge]',
    check: '--dir <cut 的输出目录>',
    diff: '--before <原图.png> --after <新图.png> [--slots <模板.slots.json>]',
    align: '--ref <参考图.png> --image <部件.png> --out <目录> [--regions <x0,y0,x1,y1;…>] [--min-scale <倍数>] [--max-scale <倍数>]',
    patch: '--base <原图.png> --variant <改图.png> --out <目录> [--keep <x0,y0,x1,y1;…>] [--threshold <色差>] [--min-area <像素>] [--open <像素>] [--edge <像素>] [--grow <像素>] [--feather <像素>]',
    trace: '--image <参考图.png> --seed <x,y;…> --out <目录> [--box <x0,y0,x1,y1>] [--tolerance <色差>] [--colors <N>] [--outline <像素>] [--dark <亮度>] [--simplify <像素>]',
    capture: '--url <网址或文件> --times <秒,…> --out <目录> [--size <宽x高>] [--scale <倍数>] [--zoom <名字=x0,y0,x1,y1;…>] [--param t] [--wait <毫秒>] [--browser <路径>]',
    playback: '--url <网址或文件> --loop <秒> --out <目录> [--fps <N>] [--static <名字=x0,y0,x1,y1;…>] [--size <宽x高>] [--scale <倍数>] [--preview-width <像素>] [--param t] [--wait <毫秒>] [--browser <路径>]',
    layers: '--ref <定稿图.png> --plate <背景板.png> --pieces <部件清单.json> --out <目录>',
  },
  get assetsUsage() { return `用法：cli.mjs assets <${Object.keys(zh.assetsActions).join('|')}> [选项]。${Object.entries(zh.assetsActions).map(([action, args]) => `${action} ${args}`).join('；')}`; },
  assetsHelp: (action) => `用法：cli.mjs assets ${action} ${zh.assetsActions[action]}\n参数和输出见 references/image-assets.md。`,
  // 子命令的 --help
  help: {
    run: '用法：\n  cli.mjs run --cwd <项目目录> --brief <任务说明.md> --title <短标题> --level <simple|normal|complex> [--agent <协作方>]\n  cli.mjs run --plan <plan_id> --seat <序号> --brief <任务说明.md> --title <短标题> --scope <允许改动的路径>\n派出一个执行任务。可选：--effort <强度>、--model <模型>、--add-dir <目录>、--track <路径>、--group <组名>（同组派活时要带 --scope <路径>）、--timeout <分钟>、--stall <分钟>、--no-snapshot。--brief - 表示从标准输入读任务说明。',
    discuss: '用法：\n  cli.mjs discuss --cwd <项目目录> --brief <议题.md> --title <短标题> --level <simple|normal|complex> [--agent <协作方>]\n  cli.mjs discuss --plan <plan_id> --seat <序号> --brief <议题.md> --title <短标题>\n发起一场讨论，只读。可选：--file <路径[:起始行-结束行]>（可以给多次）、--group <组名>、--effort <强度>、--model <模型>、--timeout <分钟>。',
    review: '用法：\n  cli.mjs review --cwd <项目目录> --level <simple|normal|complex> [--target diff|files|claims|visual] [--uncommitted | --base <分支> | --commit <sha>] [--file <路径[:起始行-结束行]>]... [--brief <审查说明.md>] [--agent <协作方>]\n  cli.mjs review --plan <plan_id> --seat <序号> --brief <审查说明.md> --title <短标题>\n请协作方审查，只读，不能续接。--target 默认 diff，范围默认 --uncommitted；files、claims、visual 要用 --file 列出材料。',
    resume: '用法：cli.mjs resume --run <run_id|last> --brief <返工说明.md> --level <simple|normal|complex> [--file <路径[:起始行-结束行]>]... [--track <路径>]...\n续接上一轮的会话：返工、讨论的下一轮、回答协作方的问题。续接图像任务时不写 --level；审查不能续接。',
    image: '用法：cli.mjs image --plan <plan_id> --seat <序号> --brief <任务说明.md> --title <短标题> --scope <输出目录>... [--track <路径>]... [--effort <强度>]\n启动图像计划里的一席，不写 --level。先用 plan --module image 建计划。',
    plan: '用法：\n  cli.mjs plan --cwd <项目目录> --module <discuss|run|review> --cell <simple|normal|complex> --group <组名> --seat <代号>[=<角色名>]... [--why <选择理由>]\n  审查计划另可带：[--target diff|files|claims|visual] [--file <路径>]... [--uncommitted | --base <分支> | --commit <sha>]\n  cli.mjs plan --cwd <项目目录> --module image --cell <generate|draw> --route <1|2|3|4> --group <组名> --seat <代号>... [--why <选择理由>]\n建一份派发计划，输出 plan_id 和每一席的启动命令。检查规则见 references/cli.md。',
    status: '用法：cli.mjs status [--run <run_id|last> | --group <组名> | --plan <plan_id>] [--limit <n>]\n不带参数时列出最近 10 个任务；--run 输出一个任务的结果或当前状态（JSON），--group 列出一组任务和汇总，--plan 输出计划每一席的状态（JSON）。',
    watch: '用法：cli.mjs watch [--run <run_id|last> | --group <组名>] [--verbose] [--no-intro]\n实时查看一个任务（时间线）或一组任务（分块面板）。--verbose 只用于 --run：逐个事件显示，包括思考原文和命令输出。按 q 退出查看，任务照常运行。',
    cancel: '用法：cli.mjs cancel --run <run_id>\n终止正在运行的任务；已经结束、没正常完成的任务，标记为已处理。',
    config: '用法：cli.mjs config [--cwd <项目目录>]\n输出生效的配置、协作方状态和每一格的候选。',
    check: '用法：cli.mjs check [--agent <协作方>]\n检查 Node.js、Git 和每个协作方能不能用，不通过的写明修法。',
    models: '用法：cli.mjs models\n列出本机各工具自带的模型清单，并核对配置里的模型。',
    'await-busy': '用法：cli.mjs await-busy (--group <组名> | --run <run_id>) [--after <分钟>]\n有 API 参与方排队超过 --after 分钟（默认 dispatch.busy_ask_min）或者全部结束时退出，列出排队的参与方。',
  },
  assetsBadImage: (file, err) => `读不了图片 ${file}（${err}）。assets 只处理 PNG（不支持隔行扫描）`,
  assetsBadNumber: (key, value) => `--${key} 的值 ${value} 不对，应为正数`,
  assetsBadAspect: (value) => `--aspect 只能是 1:1、3:2、2:3 或 3:1，收到的是 ${value}`,
  assetsTooManyNames: (names, slots) => `给了 ${names} 个名字，但格子只有 ${slots} 个`,
  assetsBadColor: (value) => `颜色 ${value} 不对，应写成 #rrggbb`,
  assetsBadSlots: (file, err) => `读不了格子文件 ${file}（${err}），它应是 assets template 生成的 .slots.json`,
  assetsNoReport: (dir) => `${dir} 里没有 report.json，先运行 assets cut`,
  assetsSizeMismatch: (a, b) => `两张图尺寸不同（${a} 和 ${b}），没法逐格比较`,
  assetsBadRegion: (value) => `--regions 里的 ${value} 不对，每个区域写成 x0,y0,x1,y1（参考图像素，x0<x1、y0<y1），多个区域用分号隔开`,
  assetsAlignEmpty: (file) => `${file} 里没有不透明的像素，没法对齐`,
  assetsBadScaleRange: (lo, hi) => `--min-scale（${lo}）不能大于 --max-scale（${hi}）`,
  assetsPatchEmpty: '没有找到成片的变化：改图和原图在去掉轮廓的细微位移后几乎一样。看 check.png，必要时调低 --threshold 或 --min-area，或者用 --keep 指定要取的区域',
  assetsBadSeed: (value) => `--seed 里的 ${value} 不对，写成图片里的整数像素坐标 x,y，多个种子用分号隔开`,
  assetsTraceEmpty: (seeds) => `种子点 ${seeds} 落在描边或透明区域上，圈不出部件。把种子点放在部件的填色里面，或者调大 --tolerance`,
  assetsLayersBadConfig: (file, what) => `部件清单 ${file} 用不了（${what}）：要有 pieces 数组；每个部件要有 name（只用字母、数字、- 和 _，不重名，不叫 static）和至少 3 个点的 lasso；extendUnder 里的 piece 要是清单里另一个部件，dist 大于 0`,
  assetsLayersEmpty: (name) => `部件 ${name} 一个像素都没取到：套索可能没圈住主体，或者那块已经被清单里前面的部件取走了`,
  assetsNoBrowser: '没找到 Chrome 或 Edge。用 --browser <浏览器可执行文件> 或环境变量 FOREMAN_BROWSER 指定；没有浏览器时改用 Claude 的内置浏览器手动截图',
  assetsCaptureFailed: (url, err) => `截图失败（${url}）：${err}`,
  assetsCaptureBlank: '有的截图整张是同一个颜色，页面可能还没画出来：加大 --wait 再试，或者检查页面在 ?t= 下是否立刻画出这一帧',
  assetsBadTimes: (value) => `--times 的值 ${value} 不对，写成逗号隔开的秒数，比如 0,0.5,1.2`,
  assetsBadSize: (value) => `--size 的值 ${value} 不对，写成 宽x高，比如 960x540`,
  assetsBadZoom: (value) => `${value} 不对，写成 名字=x0,y0,x1,y1（页面上的 CSS 像素），多个用分号隔开`,
  assetsAlignAmbiguous: '结果拿不准：另一个明显不同的缩放或位置分数差不多，或者结果顶在缩放范围的边上。部件太小或缺少特征时会这样：用 --min-scale、--max-scale 缩小范围，或者对更大的、带轮廓的部件对齐，再看 check.png 确认',
  assetsAlignPlacement: (s, tx, ty) => `部件原图的 (x, y) 落在参考图的 (${tx} + ${s}·x, ${ty} + ${s}·y)；SVG 里写 transform="translate(${tx} ${ty}) scale(${s})"，或者直接用和参考图同一画布的 aligned.png`,
  assetsCheck: {
    names: (missing, extra) => [missing.length ? `缺少部件：${missing.join('、')}` : '', extra ? `多出 ${extra} 个没有名字的部件` : ''].filter(Boolean).join('；'),
    empty: '一个部件都没切出来：图是空的，或者整张都被当成背景去掉了',
    namesOk: (n) => `${n} 个部件和名单一致`,
    count: (n) => `切出 ${n} 个部件（没有名单，未核对）`,
    outside: (n) => `${n} 个部件不在任何格子里`,
    merged: (slots) => `第 ${slots.join('、')} 格里有几块分开的碎片，已合并成一个部件，看对照拼图确认是同一个东西`,
    edge: (names) => `贴着画布边缘，可能被裁掉了一部分：${names.join('、')}`,
    noTransparency: (pct) => `只有 ${pct}% 的像素是透明的，背景很可能没去掉`,
    background: (p99) => `底色不够平（99% 的底色像素色差在 ${p99} 以内，超过 6），边缘可能残留底色`,
    specks: (n) => `丢掉了 ${n} 块很小的碎屑，看对照拼图确认没有丢掉有用的细节`,
    vector: (names) => `SVG 和原图轮廓重合度低于 0.95：${names.join('、')}`,
  },
  imageRefsMissing: '任务说明要求用 referenced_image_paths 传参考图，但这一轮的出图调用都没有传，参考图没有起作用，出的是全新的图',
  badDiscussMaxRounds: 'dispatch.discuss_max_rounds 必须是不小于 1 的整数（在 ~/.claude/foreman/config.json 里设置）',
  discussRoundsExceeded: (root, done, max) => `讨论 ${root} 已经完成 ${done} 轮，达到上限 ${max}（配置项 dispatch.discuss_max_rounds）。请根据已有结果裁决；确实需要再讨论，调大 ~/.claude/foreman/config.json 里的 dispatch.discuss_max_rounds`,
  badAfter: (min) => `--after 应为大于 0 的分钟数。不写就用配置里的 busy_ask_min（现在是 ${min} 分钟）`,
  badGroupName: (name) => `组名 ${name} 不能用：只能用英文字母、数字和 . _ -，最多 64 个字符，比如 factor-scripts-1013。实时查看要把组名写进终端命令，桌面版的终端面板只接受 ASCII 命令`,
  groupNeedsScope: '用 --group 派活时必须用 --scope 写明允许改动的路径（可以给多次），用来检查同组任务的范围是否重叠',
  agentFull: (agent, n, max, ids) => `协作方 ${agent} 已有 ${n} 个任务在运行（${ids}），达到它的并发上限 ${max}。等其中一个结束再派，或者调大 ~/.claude/foreman/config.json 里的 agents.${agent}.max_parallel`,
  scopeOverlap: (group, other, paths) => `和任务组 ${group} 里正在运行的任务 ${other} 写入范围重叠：${paths.join('、')}。同组任务写入的文件不能重叠，请重新划分范围`,
  groupNotFound: (group) => `24 小时内没有找到任务组 ${group} 的任务`,
  badArg: (a) => `无法识别的参数：${a}`,
  missingValue: (a) => `缺少参数值：${a}`,
  missingOpt: (key) => `缺少 --${key}`,
  effortChoices: (list) => `--effort 只能是 ${list}`,
  levelChoices: (list) => `--level 只能是 ${list}`,
  dirMissing: (dir) => `目录不存在：${dir}`,
  emptyBrief: '任务说明为空',
  noRuns: '还没有任何运行记录',
  runNotFound: (ref) => `找不到运行记录：${ref}`,
  noSession: (id) => `运行 ${id} 没有 session id，无法续接`,
  reviewNoResume: '审查会话不支持续接，请用 run 发起修复任务',

  // ---------- 执行 ----------
  gitFailed: (cmd, err) => `git ${cmd} 失败：${err}`,
  tooManyFiles: (n, max) => `文件数 ${n} 超过 ${max}，跳过快照`,
  stalled: (min) => `超过 ${min} 分钟没有任何活动，且没有命令在执行，判定为卡死并已终止`,
  spawnFailed: (err) => `启动 codex 失败：${err}`,
  exitCode: (code, tail, bin = 'codex') => `${bin} 退出码 ${code}：${tail}`,
  unknownModel: '未知',
  modelFromCodex: (name) => `${name}（来自 Codex 配置）`,
  // 接入方式的名字，各适配器登记用
  channel: { codex: 'Codex CLI', api: 'API', opencode: 'opencode CLI', pi: 'pi CLI' },
  busyHint: (command, min) => `排队检查：在后台运行 ${command}（同一组只需一次）。有参与方排队超过 ${min} 分钟时它会退出，届时按 skill 的"API 参与方繁忙时"决定是否终止那一方，事后告诉用户`,
  trackingUnavailable: (err) => `改动追踪不可用：${err}`,
  trackingFailed: (err) => `改动追踪失败：${err}`,
  readonlyViolated: (kind, n) => `${kind === 'discuss' ? '讨论' : '审查'}本应只读，协作方却改动了 ${n} 个文件（有工具事件或它自己的报告为证），这次记为失败。改动列在 readonly_violation 里，diff 见 diff.patch；没有自动还原：只还原能证明是它改的部分，分不清的交给用户`,
  auditedNoSnapshot: (kind) => `这次${kind === 'discuss' ? '讨论' : '审查'}没有只读沙箱（readonly 为 audited），只能靠事后对比快照发现写入，不能用 --no-snapshot`,
  auditedSnapshotFailed: (err) => `拍改动快照失败（${err}）。这次没有只读沙箱，拍不了快照就发现不了写入，所以没有开始`,
  warnReadonlyAudited: (name, modes) => `${name} 做${modes}时没有只读沙箱（readonly 为 audited）：只靠规则约束，事后对比快照，发现写入就记为失败。想让系统直接拦下写入，在 agents.${name}.sandbox 里把这几类任务设成 "read-only"（Windows 上 Codex 的只读沙箱起不来时，在 ~/.codex/config.toml 的 [windows] 里写 sandbox = "unelevated"）`,
  groupScopeChanges: (n, runs) => `任务期间另有 ${n} 个文件发生变化，都在同组任务 ${runs} 的写入范围里，多半是它改的（changes 里标了 group_run），验收时归到那个任务`,
  unattributedChanges: (n) => `任务期间工作目录里另有 ${n} 个文件发生变化：没有工具事件证明是协作方改的，它的报告里也没提到，可能来自 Claude 或其他会话，也可能是协作方用命令写了却没报告。不要直接还原，先确认是谁改的`,
  reportedNotTracked: (paths) => `Codex 报告改动了这些文件，但它们不在追踪范围内（可能被忽略规则排除），diff.patch 里没有：${paths.join('、')}。需要追踪时，派活时用 --track 指定`,
  quotaExhausted: (resets) => `Codex 额度已用完${resets ? `，预计 ${resets} 恢复` : ''}。不要重试；会话已保留，额度恢复后可以用 resume 继续`,
  lastMessageTruncated: (file) => `last_message 只保留了前 8000 字，全文见 ${file}`,
  badReport: '最终报告不是合法 JSON，见 last_message',
  trackNote: '只追踪工作目录内的改动',
  // meta.json 被别的程序以不许写共享的方式占着（备份、同步软件，或者 .NET 的 File.OpenRead）
  metaWriteGaveUp: (file, sec, err) => `${sec} 秒内一直写不进 ${file}（${err}），多半是别的程序占着它、不许别人写。放弃这次写入：meta.json 停在上一次写好的内容，结果照常在 result.json 里`,
  metaUnreadable: (file) => `读不了 ${file}：别的程序占着它、不许别人读。关掉占用它的程序（比如备份或同步软件）再试`,

  // ---------- 发给 Codex 的约束 ----------
  footer: (cwd, addDirs) => `---
## 固定约束（调度方自动附加）
- 工作目录：${cwd}${addDirs.length ? `；另可改动：${addDirs.join('、')}` : ''}。只改任务说明列出的文件和范围。任务说明"允许的适配"一节写明的事可以直接做，在报告里说明做了什么、为什么等效；没写明的越界都不要做。
- 开始前先花很少的成本做预检：解释器和依赖能用、测试能被发现、任务需要的输入存在。只做检查，不要因此跑耗时的完整验收。
- 运行期间没有人能回答你：不要在中途提问后等答复，问题只在最终报告里提。
- 遇到下面的情况，这一项不要自己做主：需要突破上面的范围或授权；需要改变研究口径、样本外纪律或验收标准；要做不可逆的操作；问题的答案不同会让后面耗时的工作作废。这一项先不做，或者用最保守、能撤回的做法；不受它影响的部分照常做完。最后把问题写进报告的 decision_requests，status 填 blocked；recommendation 里写明你推荐哪个选项，以及你已经按哪个做了、还是这一项还没做。
- 其他拿不准的地方，选保守、可逆的做法继续，并在报告里写明；不要每个小疑问都停下。
- 测试只写任务说明要求的，或者确实需要用来验证这次改动的；小改动不另写测试。不要过度防御：不加多余的参数校验、try/catch、兜底分支和重复测试。
- 按任务说明的规模做，不要做成更大的工程：不新增任务没要求的命令行参数、配置项、抽象层和兼容分支，能用现有函数就不新写。实际改动明显超过任务说明里预计的规模时，先想想是不是做多了；确实需要的，在报告里说明为什么。
- 命名、注释和提示文字以任务说明为准，给了原文就照用。没有指定的：命名沿用项目现有风格，起直白、能看出用途的名字；注释只在不显而易见的地方用一句简短的话说明"为什么"，不要长篇解释，也不要逐行注释。
- 不执行 git commit / git push / git reset --hard 或任何改写历史的操作；不删除范围外的文件；不读取或修改密钥、凭据、.env 等敏感文件。
- 不安装全局依赖，不改系统配置；项目内确需新增依赖时在报告里说明。
- 完成后按给定的 JSON schema 输出最终报告，如实填写：没做到或没验证的写进 open_issues，不要粉饰。`,
  resumeFooter: `---
（调度方提示：前面的固定约束仍然有效。完成后同样按 JSON schema 输出最终报告。）`,
  discussFooter: (cwd) => `---
## 讨论规则（调度方自动附加）
- 这是方案讨论，不是执行任务。可以阅读 ${cwd} 下的代码和数据、运行只读命令来支撑观点，但不要修改、创建或删除任何文件。
- 运行期间没有人能回答你：不要提问后等待。需要的信息或拿不准要人决定的事，写进 open_questions。
- 独立思考，不要迎合。不同意就直说，并给出理由；同意也要说清楚为什么。
- 结论先行，用短句和直白的话，像跟同事当面讲清楚一样。不要堆砌术语，不要套话。
- 每个观点都要有依据：代码位置、数据或清楚的推理。拿不准的明确标出来。
- 最后按给定的 JSON schema 输出。`,
  discussResumeFooter: `---
（调度方提示：前面的讨论规则仍然有效：只读、不迎合、说人话、有依据，运行中没人回答。最后同样按 JSON schema 输出。）`,
  reviewFooter: `---
## 审查要求（调度方自动附加）
- 只审查，不要修改、创建或删除任何文件，不要执行会改动文件的命令。
- 材料可能没有问题，只报能定位到证据的问题。
- 只报告真实存在的问题：正确性 bug、逻辑漏洞、边界条件、并发与数据一致性、安全问题、明显的性能问题。不报告纯风格偏好。
- 每个问题写清：位置（文件:行号，或材料里的位置）、问题、触发场景（什么输入或状态会出错）、证据和修复建议，按严重程度从高到低排列，编号 F1、F2……
- 没发现问题时 findings 留空、verdict 写 no_issues，不要凑数；没审完时 verdict 写 incomplete。coverage 写明检查了哪些、没覆盖哪些，拿不准或没能验证的写进 unverified。
- 运行期间没有人能回答你：不要提问后等待。
- 最后按给定的 JSON schema 输出。`,
  reviewTargetChoices: (list) => `--target 只能是 ${list}`,
  reviewTargetNeedsFile: (target) => `--target ${target} 要用 --file 写明审查哪些文件（可以给多次）`,
  reviewScopeDiffOnly: '--uncommitted、--base 和 --commit 只用于 --target diff',
  reviewVisualNotImage: (file) => `--target visual 的 --file 只能是图片（png、apng、jpg、jpeg、gif、webp），不能带行范围：${file}`,
  readsImagesRequired: (name, type) => `${name}（${type}）不能看图，不能做 visual 审查。visual 只派给能看图的协作方（capabilities.reads_images 为 true，目前只有 Codex CLI）`,
  planReviewOnly: '--target、--file、--uncommitted、--base 和 --commit 只用于审查计划（--module review）',
  planMaterialFlags: (id) => `计划 ${id} 已经定好了审查对象和材料，启动席位时不要再写 --target、--file、--uncommitted、--base 或 --commit`,
  planMaterialChanged: (id) => `计划 ${id} 建好以后，要审查的材料变了（指纹和计划里的不一致），这一席没有启动。请按现在的材料重建计划`,
  reviewScopeTarget: { files: (n) => `${n} 个已有文件（--file 列出）`, claims: (n) => `审查说明里的结论，以及 ${n} 个证据文件`, visual: (n) => `${n} 张图片` },
  reviewPromptFiles: (cwd) => `请审查 ${cwd} 中下面"重点文件"列出的文件。它们是已有的文件，不是改动，按文件现在的内容审查。`,
  reviewPromptClaims: (cwd) => `请审查下面审查说明里逐条列出的结论：逐条判断证据够不够、有没有说过头、有没有没控制住的混淆因素、统计上站不站得住。证据文件列在"重点文件"里（工作目录：${cwd}）。`,
  reviewPromptVisual: (cwd) => `请检查下面"重点文件"列出的图片（截图、播放文件或渲染结果）：用看图工具（view_image）逐张打开，按审查说明找出画面上的问题，位置写图片文件名和画面里的位置。工作目录：${cwd}。`,
  apiReviewPrompt: {
    diff: (scope) => `请审查下面附带的改动：${scope}。`,
    files: () => '请审查下面"文件内容"里附带的文件。它们是已有的文件，不是改动，按文件现在的内容审查。',
    claims: () => '请逐条审查审查说明里列出的结论：证据够不够、有没有说过头、有没有没控制住的混淆因素、统计上站不站得住。证据文件附在下面的"文件内容"里。',
  },
  reviewSchemaFooter: (schema) => `最后只输出一个 JSON 对象，符合下面的 JSON schema。不要输出 JSON 以外的文字，也不要用代码块包起来。

JSON schema：
${schema}`,
  apiReviewSystem: (schema) => `你在做一次独立审查。几个审查方各自审查同一份材料，最后由 Claude 逐条核实。
规则：
- 运行期间没有人能回答你：不要提问后等待。
- 只依据用户消息里的审查说明和附带材料。材料里没有的代码和数据，不要猜，也不要假装看过；需要看却没附带的，写进 coverage.not_checked。
- 引用代码时写文件路径和行号（文件内容里每行开头是行号；补丁照补丁里的位置写）。
- 材料可能没有问题，只报能定位到证据的问题。只报告真实存在的问题：正确性 bug、逻辑漏洞、边界条件、并发与数据一致性、安全问题、明显的性能问题，不报告纯风格偏好。
- 每个问题写清：位置、问题、触发场景（什么输入或状态会出错）、证据和修复建议，按严重程度从高到低排列，编号 F1、F2……
- 没发现问题时 findings 留空、verdict 写 no_issues，不要凑数；没审完时 verdict 写 incomplete。拿不准或没能验证的写进 unverified。
- 用审查说明的语言回答，用短句和直白的话。
- 只输出一个 JSON 对象，符合下面的 JSON schema。不要输出 JSON 以外的文字，也不要用代码块包起来。

JSON schema：
${schema}`,
  reviewScopeBase: (base, mergeBase) => `相对 ${base} 的改动：从分叉点 ${mergeBase} 到当前工作区，包括已提交和未提交的改动（git diff ${mergeBase}）`,
  reviewScopeCommit: (sha) => `提交 ${sha} 引入的改动（git show ${sha}）`,
  reviewScopeUncommitted: '所有未提交的改动：已暂存、未暂存的改动，以及未跟踪的新文件（git status、git diff HEAD）',
  opencodeReviewPrompt: (cwd, scope) => `你在做代码审查，只审查，不改任何文件。项目目录：${cwd}。审查范围：${scope}。下面"要审查的改动"是调度方用 git 算好的完整改动；需要更多上下文时，用读文件和搜索工具查看 ${cwd} 下的代码。运行期间没有人能回答你，不要提问后等待。`,
  reviewMaterial: (fileList, patch, fence) => `---\n## 要审查的改动（调度方用 git 算好）\n### 文件清单\n${fileList}\n### 补丁\n${fence}diff\n${patch}\n${fence}`,
  reviewFileBinary: '（二进制，未列出内容）',
  reviewFileTooLarge: '（超过 1 MB，未列出内容）',
  reviewEmpty: (scope) => `${scope}：没有可审查的改动`,
  reviewTooLarge: (chars, max) => `要审查的改动共 ${chars} 字符，超过上限 ${max}。可以按提交分开审（--commit），或者交给 Codex 审查：它自己读改动，没有这个限制`,
  reviewScopeChanged: '审查期间要审查的材料又变了（开始和结束时的指纹不同），这份审查可能没覆盖最新的内容，结果标了 stale',
  baseNotFound: (base) => `找不到分支 ${base}，或者算不出它和当前分支的分叉点`,
  reviewPromptGit: (cwd, scope) => `请审查 ${cwd} 中${scope}。`,
  reviewPromptPlain: (cwd) => `请审查以下内容（工作目录：${cwd}）：`,
  // ---------- status 和 watch ----------
  // 实时查看、status 和开工那一行的显示文字，中英两个插件都用 en 里那一套（format.mjs 的 D），这里不再重复；
  // 下面是报错、提醒和启动动画用的。
  modeNames: { run: '执行', resume: '续接', discuss: '讨论', review: '审查', image: '图像' },
  duration: (sec) => {
    const s = Math.round(sec), m = Math.floor(s / 60);
    return s < 60 ? `${s} 秒` : m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  },
  runCancelled: (model, by) => ({ command: `${model} 已被 cancel 命令终止`, watch: `${model} 已被用户在实时查看里终止`, signal: `${model} 已终止：调度进程收到了终止信号` })[by] ?? `${model} 已终止`,
  cancelForced: '调度进程没在时限内自己停下，已被强行结束；这份结果是 cancel 命令补写的，没有改动追踪和报告',
  cancelNotStopped: (pid) => `调度进程（pid ${pid}）结束不了，任务的记录没有改动。在任务管理器里（或者用 kill -9）结束它，再运行一次 cancel`,
  cancelledUsageMissing: '取消前没有一次请求完成，厂商还没报用量，这次花掉的 token 记不到（usage 为 null）',
  cancelledUsagePartial: '用量只算到取消前最后一次完成的请求；取消时正在进行的那次请求，厂商没有报用量，没算进去',
  needsDecisionNote: (n) => `有 ${n} 个问题要决定（见 questions）。任务已经结束，不是卡住了：Claude 能决定的直接决定，再用 resume 续接或自己做掉；需要用户拍板的才问用户`,
  inputWaitDetected: (min, line) => `输出了像是在等人回答的提示，之后 ${min} 分钟没有动静，已结束这次运行，问题交回给 Claude：${line}`,
  // watch 的启动动画。笑话里 {n} 换成模型简称（GPT、DeepSeek……），{m} 换成模型名
  introStarting: (who) => `正在启动 ${who}`,
  introGathering: (n, models) => (models ? `正在召集 ${n} 位模型：${models.join('、')}` : `正在召集 ${n} 位模型`),
  introDispatching: (n, models) => (models ? `正在派出 ${n} 个任务：${models.join('、')}` : `正在派出 ${n} 个任务`),
  introDone: '任务已经结束，直接看结果',
  introCountdown: (s) => `${s} 秒 · 任意键跳过`,
  introEnded: '已结束',
  introJokes: {
    run: ['Claude 正在鞭打 {n}……', 'Claude 正在把需求切成 {n} 一口能吃下的小块……', '正在提醒 {n}：这次不许写 300 个测试……', '{n} 正在签署《不越界承诺书》……', '{n} 正在翻仓库的族谱（git log）……', 'Claude 正在给 {n} 划重点……', '正在给 {n} 泡一杯赛博咖啡……'],
    review: ['{n} 正在戴上老花镜……', '正在给 {n} 的红笔灌墨水……', '{n} 正在 diff 里找茬……', 'Claude 正在假装一点也不紧张……'],
    discuss: ['Claude 正在给各位分发辩论稿……', '正在把会议室的椅子摆成一圈……', '正在没收手机，防止偷看别人的方案……', 'Claude 宣布规则：对事不对模型……', '{n} 正在清嗓子……', 'Claude 正在给每位倒一杯水……'],
  },
  introModelJokes: {
    claude: ['Claude 正在照镜子……'],
    chatgpt: ['GPT 正在把 effort 拧到最大……', 'GPT 正在活动手指，准备敲代码……'],
    gemini: ['双子座的两位正在猜拳决定谁来上班……', 'Gemini 比了个耶，表示收到……'],
    deepseek: ['DeepSeek 正在深度思考要不要深度思考……', '小鲸鱼正在下潜到代码最底层……'],
    mimo: ['MiMo 正在握拳给自己打气……', 'MiMo 正在把 M 字发卡别正……'],
    glm: ['GLM 正在把立方体发卡扶正……', 'GLM 正在默念：先读代码，再开口……'],
    kimi: ['Kimi 正在一口气读完整个仓库……', 'Kimi 正在把 K 字发卡擦亮……'],
    qwen: ['Qwen 正在问第一千个问题……', 'Qwen 冲你眨了眨眼……'],
    minimax: ['MiniMax 正在给声波发卡调音……', 'MiniMax 正在清嗓子，准备开麦……'],
    unknown: ['一位神秘嘉宾正在入场……', '正在核对神秘嘉宾的入场券……', '正在给 {m} 办临时工牌……'],
  },
};

const en = {
  configModulesMigrated: (file, bak) => `Rewrote levels as modules in the config file ${file}: every cell keeps its agents, reasoning efforts and order, and single run and review entries became one-item lists. One behavior change: everyone listed at a discussion level used to take part; now they are candidates and Claude picks among them by its rules. To keep everyone taking part, add "required": true to those entries (/foreman-en:setup can mark them). The config has no image block yet (the generate and draw cells); run /foreman-en:setup to add it when you need it. levels is kept in the file as a one-line note, so an old version of the plugin stops with an error instead of quietly having Claude do everything. The original is backed up at ${bak}`,
  levelsNote: 'Moved to modules (see modules below). If an error points here, the foreman plugin is an old version; please update it',
  configBothFormats: (file) => `The config file ${file} has both levels and modules, so it's unclear which one counts. Delete levels (the old form) and keep only modules`,
  projectLooser: (key, value, user) => `The project config's ${key} (${value}) is looser than the user config (${user}); a project config can only tighten, so the user config's value is used`,
  projectCellOpened: (key) => `${key} is closed in the user config ("claude code" or null), and a project config can't open it; ignored`,
  projectAgentDropped: (item, key) => `The project config has ${item} in ${key}; ignored: a project config can only remove entries the user config already has in that cell, lower their reasoning effort, or close the whole cell ("claude code" for a graded cell, null for an image cell)`,
  projectRequiredChanged: (key, agent) => `The project config changes required for ${agent} in ${key}; ignored: required can only be changed in the user config`,
  projectEffortRaised: (key, agent, effort, user) => `The project config sets ${agent}'s reasoning effort in ${key} to ${effort}, higher than ${user} in the user config; a project config can only lower it, so the user config's value is used`,
  projectEffortUnordered: (key, agent, type) => `The project config changes ${agent}'s reasoning effort in ${key}; ignored: ${type} reasoning efforts have no common order, so a project config can't change them`,
  projectEffortNoBase: (key, agent) => `The project config gives ${agent} a reasoning effort in ${key}; ignored: the user config's entry has none (the tool's default), so there's nothing to compare it with`,
  projectRequiredDropped: (key, agents) => `The project config removes the required ${agents} from ${key} but keeps other agents. A project config can't remove only the required ones: keep them, or close the whole cell ("claude code" for a graded cell, null for an image cell)`,
  projectLevelEmpty: (key) => `After removing those entries, ${key} has no candidates left. To close the cell, write "claude code" (null for an image cell)`,
  cellClosedByProject: (key, named) => `The project config closes ${key}, so nothing at this cell can be handed off in this project${named ? ', not even with --agent' : ''}`,
  agentNotInLevel: (name, key, names) => `${name} isn't a candidate in ${key}; the candidates in this cell are: ${names}`,
  agentRequired: (key, names) => `${key} has several candidates: ${names}. Use --agent to say who gets this one; to hand it to several seats at once, create a plan first`,
  otherRequired: (key, selected, names) => `${key} has required ${names}, but this call picked ${selected}; a single-seat handoff can't skip a required agent. Hand it to the required agent, or create a plan with both the required agent and ${selected}`,
  severalRequired: (key, names) => `${key} has several required agents: ${names}. A single-seat handoff can't satisfy that; create a plan first with one seat for each`,
  missingLevel: (levels) => `Missing --level (${levels}). --effort only overrides the reasoning effort; it can't pick a cell instead of --level`,
  modelVendorChanged: (name, model, base) => `--model ${model} isn't from the same provider as ${name}'s model ${base} (the "provider/" prefix differs). --model can only switch models within a provider; to use another provider, pick another candidate in this cell or change the user config`,
  resumeAgentNotInCell: (agent, key, names) => `A resume keeps the previous round's agent ${agent}, but it isn't a candidate in ${key} (${names}). Resume at a level that has it, or start a new run`,
  resumePlanCellChanged: (plan, from, to) => `This run belongs to plan ${plan} (cell ${from}), so a resume can't move it to ${to}. To change the level, create a new plan for the new level`,
  resumeOtherRequired: (key, agent, names) => `This resume moves to ${key}, which has required ${names}, so ${agent} can't continue it alone. Hand it off again at the new level: to the required agent, or with a plan`,
  planSeatChanged: (id, seat, key) => `Seat ${seat} of plan ${id} no longer matches the model or effort configured in ${key}; recreate the plan with the current config`,
  levelForClaude: (level) => `Per the config (modules.run.${level} is "claude code"), ${level} hands-on work is done by Claude. To hand it off, name an agent with --agent; the built-in default reasoning effort is used`,
  levelEntryChoices: 'Must be "claude code", a list of candidates, or a single { "agent": "<name>", "effort": "<effort>" }',
  imagesNotSupported: (name, type) => `${name} (${type}) can't generate images, so it can't be in the generate cell`,
  planRouteRequired: 'An image plan needs --route: 1 bitmap, 2 bitmap + vector mix, 3 pure vector (reference image first), 4 pure vector / code',
  planRouteChoices: (value) => `--route must be 1, 2, 3 or 4, not ${value}`,
  planRouteImageOnly: '--route is only for image plans (--module image)',
  planRouteCell: (mark, cell, uses) => `Route ${mark} doesn't use the ${cell} cell; it uses ${uses}`,
  routeUses: { 1: 'generate', 2: 'generate and draw', 3: 'generate (reference image only) and draw', 4: 'draw' },
  generateNoRoles: 'Generate seats take no roles: Claude writes the picture requirements into the brief, so drop the =<role>',
  imageNeedsPlan: 'Image tasks start from a plan: create one with plan --module image --cell <generate|draw> --route <1-4> (the route is kept in the plan), then start it with image --plan <plan_id> --seat <n>',
  imageNoLevel: 'Image tasks don\'t take --level: the cell (generate or draw) comes from the plan, and a resume keeps the original cell',
  imageNeedsScope: 'image needs --scope with the output directory (can be repeated), so overlapping write scopes in the group can be caught',
  imageCellClosed: (key) => `${key} is now null (turned off), so image tasks can't be handed off or resumed from it`,
  routeNoSession: 'There\'s no Claude session ID (CLAUDE_CODE_SESSION_ID), so the image route answer can\'t be matched and no plan was created. Create image plans inside Claude Code, after the user has picked a route in the dialog',
  routeNotAsked: 'No image route answer was found in this session, so no plan was created. Ask the user with AskUserQuestion first (put "Image route" in the question and start the options with ①–④), then create the plan once they\'ve chosen',
  routeNotAnswered: 'The latest image route dialog wasn\'t answered (it was cancelled or is still open), so no plan was created. Ask again as the skill says',
  routeNotChosen: (answer) => `In the latest image route dialog the user didn't pick one of ①–④ (the answer was "${answer}"), so no plan was created. Act on what they said and ask again if needed`,
  routeMismatch: (chosen, route) => `In the latest image route dialog the user chose route ${chosen}, which doesn't match --route ${route}, so no plan was created`,
  imageOutsideModule: 'This round generated images (generated_images) outside the image module: have the user pick a route in a dialog first, then create a plan with plan --module image and start it with image',
  vectorRouteImages: (mark) => `Route ${mark} makes no bitmaps, but this round generated images (generated_images)`,
  vectorEmbedsBitmap: (mark, files) => `Route ${mark} should deliver paths only, but these SVG files embed bitmaps (<image>): ${files}`,
  vectorCheckPartial: (mark) => `Part of the route ${mark} draw task's output is outside change tracking (no snapshot, or a --scope outside the working directory), so there only the SVG files listed in its tool events and report were checked for embedded bitmaps`,
  startedImage: (mode, who, cell, mark, dir) => `${mode} started · ${who} · ${cell} · route ${mark} · run dir ${dir}`,
  watchImageHead: (mode, title, cell, mark) => `${mode} · ${title} · ${cell} · route ${mark}`,
  statusRoute: (mark) => `[route ${mark}] `,
  watchImageViewed: (file) => `Opened image ${file}`,
  stepImageViewed: (file) => `Just opened image ${file}, looking at it`,
  watchStale: 'material changed during the review (stale)',
  watchPlanStale: (list) => `material changed during the review (stale): ${list}`,
  costUsd: (text) => `cost $${text}`,
  planModuleChoices: (list) => `--module must be one of ${list}`,
  planCellChoices: (module, list) => `--cell for ${module} must be one of ${list}`,
  planNoSeats: 'Give at least one seat with --seat, written as <agent> or <agent>=<role>',
  badSeat: (value) => `--seat is written wrong: ${value}. Use <agent> or <agent>=<role>`,
  planCellClosed: (key) => `${key} is closed ("claude code" or null) and has no outside candidates, so no plan can be created for it`,
  planCellClosedByProject: (key) => `The project config closes ${key}, so nothing at this cell can be handed off in this project, and no plan can be created for it`,
  planMissingRequired: (key, names) => `Not every required agent of ${key} is in the plan; missing: ${names}`,
  planRequiredChanged: (id, key) => `The required agents in plan ${id} no longer match ${key}; recreate the plan with the current config`,
  planTooManySeats: (n, max) => `The plan has ${n} seats, more than dispatch.max_seats (${max})`,
  planNotFound: (id) => `Plan ${id} not found`,
  planSeatChoices: (id, n) => `Plan ${id} has ${n} seats; --seat must be 1 to ${n}`,
  planNeedsSeat: 'When starting from --plan, say which seat with --seat',
  seatNeedsPlan: '--seat goes together with --plan',
  planModuleMismatch: (id, module, cmd) => `Plan ${id} is a ${en.modeNames[module]} plan and can't be started with ${cmd}`,
  planAgentFlag: 'When starting from --plan, the agent comes from the plan; drop --agent. Use --effort to change the reasoning effort',
  planLevelMismatch: (id, cell, level) => `Plan ${id} is for cell ${cell}, which doesn't match --level ${level}; --level can be left out when starting from a plan`,
  planCwdMismatch: (id, cwd) => `Plan ${id} was created for ${cwd}; --cwd doesn't match it`,
  planGroupMismatch: (id, group) => `Plan ${id} uses group ${group}; --group doesn't match it, and can be left out when starting from a plan`,
  seatAlreadyStarted: (id, seat, run) => `Seat ${seat} of plan ${id} has already been started (${run}). For rework, use resume --run ${run}`,
  planPlaceholders: { brief: '<brief.md>', topic: '<topic.md>', review: '<review-brief.md>', title: '<short title>', scope: '<path it may change>', outDir: '<output dir>' },
  startLockBusy: (lock, pid, seconds) => `The start lock ${lock} is held by process ${pid} and hasn't been released after ${seconds} seconds. Once you've confirmed that process isn't foreman (for example, its process ID was reused by another program), delete the lock file and try again`,
  starterCodex: (model, complexModel) => `found Codex. Claude does simple and normal hands-on tasks itself, complex ones use ${model}, complex reviews and discussions use ${complexModel}, image generation uses ${model}, and hand-drawn vector pieces use ${complexModel}. `,
  warnUnusedAgent: (name) => `${name} isn't used in any cell`,
  usage: 'Usage: cli.mjs <run|discuss|resume|review|image|plan|status|watch|config|check|models|await-busy|cancel|assets> [options]; run / discuss / review pick a cell with --level and can add [--agent <agent>], or start one seat of a plan with [--plan <plan> --seat <n>]; image only starts from --plan <plan> --seat <n> and needs --scope <output dir>; check supports [--agent <agent>]; discuss / resume support [--file <path[:start-end]>]...; run / resume / discuss / review support [--track <path>]...; run / resume / discuss support [--group <name>] [--scope <path>]...; status supports [--group <name>] or [--plan <plan>], watch supports [--group <name>]; for the full options of a subcommand, run cli.mjs <command> --help (or -h)',
  starterCreated: (file, parts) => `First run: created config file ${file}: ${parts}`,
  starterNoCodex: 'no usable Codex found, so Claude does hands-on work, reviews and discussions itself for now. ',
  starterOpencode: (n) => `found opencode (${n} models available), not added yet. `,
  starterPi: (n) => `found pi (${n} models available), not added yet. `,
  starterApi: (names) => `found API keys for ${names}; they're in the config but not in any discussion yet. `,
  starterNext: 'Run /foreman-en:setup to check the setup and choose models.',
  configStructureMigrated: (file, bak, renames) => `Rewrote config file ${file} in the new format (type is now codex cli / opencode cli / api, "claude" is now "claude code"${renames ? `, agent IDs renamed after their models: ${renames}` : ''}); the original is backed up at ${bak}`,
  modeNotSupported: (name, type, mode, modes) => `${name} (${type}) can't do ${mode}; it can do: ${modes}`,
  levelIsClaude: (key) => `${key} is "claude code", so this level uses no outside agent. Use --agent to send it out anyway`,
  legacyAgentAlias: (old, name) => `Agent ID ${old} has been renamed to ${name}; using the new ID this time`,

  list: (items) => items.join(', '),

  // ---------- config ----------
  configBadJson: (file, err) => `Config file is not valid JSON: ${file} (${err})`,
  starterFailed: (file, err) => `Could not create config file ${file} (${err}); using built-in defaults for this run`,
  projectIgnored: (keys) => `${keys} can only be set in the user config; ignored in the project config`,
  configMigrateFailed: (file, err) => `Config file ${file} uses the old layout and couldn't be rewritten (${err}); reading it in the new layout in memory for this run`,
  // Rename migration (codex-bridge → foreman)
  legacyConfigCopied: (from, to) => `The plugin is now called foreman: copied your config ${from} to ${to}, which is read from now on. The old file is kept; delete it once you've checked everything works`,
  legacyPrefsCopied: (from, to) => `The plugin is now called foreman: copied your preferences file ${from} to ${to}. The old file is kept`,
  legacyCopyFailed: (from, err) => `Couldn't copy ${from} (${err}); carrying on as if it didn't exist`,
  legacyEnv: (old, name) => `The environment variable ${old} has been renamed to ${name}. It was read under the old name this time; please switch to the new one`,
  runsMoved: (from, to) => `Moved the run directory from ${from} to ${to}`,
  runsMoveDeferred: (from) => `The old run directory ${from} still has runs in progress, so it wasn't moved this time and is still in use. It'll be moved on a later run`,
  runsMoveFailed: (from, err) => `Couldn't move the run directory ${from} (${err}); still using it for now`,
  projectLegacyName: (old, name) => `${old} in this project uses the file name from before the rename; it was read as usual. Consider renaming it to ${name}`,
  projectOldFormat: (file) => `Project config ${file} uses the old layout; it was converted when read. Consider updating it (see "Configuration" in the README)`,
  configInvalid: (key, reason) => `Invalid config ${key}: ${reason}`,
  // Reasons for config validation errors, appended to configInvalid
  invalid: {
    module: 'Must be discuss, run, review or image',
    imageCell: 'Must be generate or draw',
    candidates: 'Must be "claude code" or a list of candidates, for example [{ "agent": "<name>", "effort": "high" }]',
    imageCandidates: 'Must be a list of candidates or null (closed); Claude can\'t produce bitmaps, so "claude code" isn\'t allowed here',
    oneRequired: 'This cell hands work to one executor at a time, so at most one entry can be required',
    duplicate: 'An agent can appear only once in a cell',
    object: 'must be an object',
    boolean: 'must be true or false',
    watch: 'must be auto or off',
    positiveInt: 'must be a whole number of at least 1',
    minutes: 'must be a number of minutes (stall_min and busy_ask_min may be 0)',
    pathOrNull: 'must be a path or null',
    agentName: "IDs may only use letters, digits, ., - and _, must start with a letter or digit, and can't be claude or claude code",
    agentType: 'must be codex cli, opencode cli, pi cli or api',
    opencodeModel: 'must be provider/model, e.g. opencode-go/glm-5.3',
    piModel: 'must be provider/model, e.g. deepseek/deepseek-flash',
    runAccess: 'must be "edit" or "shell"',
    modelName: 'must be a model name or null',
    stringOrNull: 'must be a string or null',
    sandbox: 'must be read-only, workspace-write, danger-full-access or null',
    nonEmpty: "can't be empty",
    level: 'must be simple, normal or complex',
    agentRef: 'must name an agent under agents',
    apiKeyText: 'must be a string (leave it as "" until you fill it in)',
    apiEffort: 'must be a string or null',
  },
  unknownAgent: (key, name) => `Config ${key} refers to an agent "${name}" that doesn't exist (define it under agents)`,
  unknownAgentFlag: (name) => `--agent names an agent "${name}" that isn't under agents in the config`,
  resumeAgentMismatch: (name, parent) => `A resume keeps the previous round's agent ${parent}; it can't switch to ${name}`,
  apiKeyMissing: (name, env) => `Agent ${name} has no API key${env ? ` (environment variable ${env} isn't set)` : ''}. Fill in agents.${name}.api_key in ~/.claude/foreman/config.json (takes effect immediately)${env ? `, or set ${env} (then restart Claude Code)` : ''}`,
  fileNotFound: (p) => `Attached file not found: ${p}`,
  fileBinary: (p) => `Attached file isn't a text file: ${p}`,
  badFileRange: (spec) => `The line range for attached file ${spec} isn't right; write it as path:start-end`,
  materialsTooLarge: (total, max, list) => `The attached material is ${total} characters, over the limit of ${max}. Pick files more carefully or use line ranges. Per file: ${list}`,
  apiNoMessages: (id) => `Can't find the conversation history messages.json for run ${id}, so it can't be resumed`,
  apiError: (name, kind, status, msg) => `${name} request failed (${kind}${status ? ` ${status}` : ''}): ${msg}`,
  apiBalance: (name, msg) => `${name}'s account balance is too low: ${msg}. Top it up, then continue with resume`,
  apiBusy: (name, waited, retried) => `${name} is too busy: the request waited about ${waited} in the server's queue and was dropped before it started${retried ? ', and the retry went the same way' : ''}. Try again later; for now, go ahead with the other participants' results`,
  apiTruncated: (name) => `${name}'s reply was cut off (max_tokens reached). Raise max_tokens in agents.${name}.extra_body`,
  reportInvalid: (name, file) => `${name} didn't produce a report in the required format in two tries; the raw text is in ${file}`,
  apiNoResponseFormat: "The API doesn't accept response_format; retried without it, relying on the prompt alone for JSON",
  apiNoChanges: "API agents can't change files, so changes aren't tracked",
  opencodeNoChanges: "opencode agents can only read and search files, not change them, so changes aren't tracked",
  piNoChanges: "pi agents can only read and search files in the project, not change them, so changes aren't tracked",
  opencodeExportFailed: (err) => `Couldn't read token usage from the opencode session (${err}), so there are no token counts this time`,
  piStopLength: 'The reply hit the model\'s output limit and was cut off',
  codexSandboxFailed: (error) => `Codex's sandbox couldn't start commands (${error}). This isn't about the task itself, and retrying won't help: until the sandbox is fixed, Codex can't run any command on this machine. Run check for the diagnosis and fixes, pass the options to the user, and let them decide`,
  piRetrying: (attempt, max, err) => `Request failed; retrying (${attempt}/${max}): ${err}`,
  piEffortChanged: (want, got) => `The configured effort is ${want}, which this model doesn't support; pi used ${got} instead`,
  rateLimited: (model, tool) => `${model} was rate limited by its provider (429): the account can only handle so many requests at once, and ${tool} was still refused after retrying. Resume or start it again later, and don't send several tasks to the same account at once`,
  stepApiWaiting: 'Request sent, waiting for a reply',
  stepApiThinking: (n) => `Thinking (${Number(n).toLocaleString('en-US')} characters so far)`,
  stepApiAnswering: (n) => `Writing the answer (${Number(n).toLocaleString('en-US')} characters so far)`,
  retryReasons: { network: 'Connection dropped', rate_limit: 'Rate limited', server: 'Server error', stall: 'No data for too long', response_format: "The API doesn't accept response_format", busy: 'Service busy; dropped after queuing too long' },
  stepApiRetry: (reason) => `${en.retryReasons[reason] ?? `Request failed (${reason})`}, retrying shortly`,
  stepApiRepair: 'Report not in the required format, asking for a fix',
  stepApiQueued: 'Service busy; the request is queued',
  watchApiRequest: (model, effort, attempt) => `Request sent: model ${model}, effort ${effort ?? 'default'}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
  watchApiAnswering: 'Writing the answer',
  watchApiRetry: (reason, s) => `${en.retryReasons[reason] ?? `Request failed (${reason})`}, ${s ? `retrying in ${s}s` : 'retrying now'}`,
  watchApiRepair: (errors) => `Report not in the required format, asking for a fix: ${errors}`,
  watchApiQueued: "Service busy; the request is queued and hasn't started",
  apiPhases: { thinking: 'thinking', answering: 'writing the answer', queued: 'queued' },
  watchApiQueuedLive: (time) => `${en.apiPhases.queued} ${time} (service busy)`,
  watchApiDequeued: (duration) => `Started after ${duration} in the queue`,
  watchApiDropped: (duration) => `Dropped by the server after ${duration} in the queue (service busy)`,
  focusFiles: (list) => `Key files (read these first):\n${list}`,
  apiDiscussSystem: (schema) => `You are taking part in a design discussion. Several participants give their views independently, and Claude makes the final call.
Rules:
- Nobody can answer you while you run: don't ask and wait. Put information you need, or anything someone else has to decide, in open_questions.
- Work only from the topic and the attached material in the user message. Don't guess at code or data that isn't in the material, and don't pretend you've seen it; list the files you'd need in open_questions.
- When you cite code, give the file path and line number (each line of the material starts with its line number).
- Think independently; don't just agree. If you disagree, say so and give your reasons; if you agree, say why.
- Lead with the conclusion. Use short, plain sentences, as if explaining it to a colleague in person. No jargon piles, no filler.
- Back every point up: a code location in the material, data, or clear reasoning. Flag anything you're unsure about.
- Answer in the language of the topic.
- Output a single JSON object that matches the JSON schema below. No text outside the JSON, and don't wrap it in a code block.

JSON schema:
${schema}`,
  apiMaterials: (fileList, total, files) => [
    '---\n## Attached material (added by the dispatcher)',
    ...(fileList ? [`### Project files (git ls-files, ${total} in total${total > 300 ? ', first 300 shown' : ''})\n${fileList}`] : []),
    ...(files.length ? [`### File contents\n${files.map((f) => `#### ${f.shown}${f.range ? ` (lines ${f.range[0]}–${f.range[1]})` : ''}\n${f.fence}\n${f.content}\n${f.fence}`).join('\n\n')}`] : []),
  ].join('\n\n'),
  apiResumeFooter: "---\n(Note from the dispatcher: the discussion rules above still apply: work only from the material given, don't just agree, speak plainly, back it up. Finish with a single JSON object matching the schema.)",
  reportRepairPrompt: (errors) => `Your last reply wasn't valid JSON in the required format:\n${errors}\nOutput only the corrected, complete JSON object and nothing else.`,
  opencodeDiscussFooter: (cwd, schema) => `---
## Discussion rules (added by the dispatcher)
- This is a design discussion, not a task to carry out. You may only use file-reading and search tools to inspect the code and data under ${cwd}. Don't run commands or change files.
- Nobody can answer you while you run: don't ask and wait. Put information you need, or anything someone else has to decide, in open_questions.
- Think independently; don't just agree. If you disagree, say so and give your reasons; if you agree, say why.
- Lead with the conclusion. Use short, plain sentences, as if explaining it to a colleague in person. No jargon piles, no filler.
- Back every point up: a code location (file path and line number), data, or clear reasoning. Flag anything you're unsure about; don't pretend you've read code you haven't seen.
- Answer in the language of the topic.
- Finish with a single JSON object that matches the JSON schema below. No text outside the JSON, and don't wrap it in a code block.

JSON schema:
${schema}`,
  opencodeResumeFooter: "---\n(Note from the dispatcher: the discussion rules above still apply: read-only, don't just agree, speak plainly, back it up; nobody can answer you while you run. Finish with a single JSON object matching the schema, without a code block.)",
  runAccessRequired: (name, type) => `${name} (${type}) needs run_access in the user config to do hands-on work: "edit" (only change files in the project) or "shell" (can also run commands, with no OS sandbox)`,
  unsandboxedRun: (access) => access === 'edit'
    ? "No OS sandbox for this run, only tool permissions: it can read and write files in the project directory and can't run commands"
    : "No OS sandbox for this run: it can run commands, which run with your account's permissions and can reach the whole machine; the diff afterwards is the check",
  snapshotRequired: "Runs without an OS sandbox must take a change snapshot first; --no-snapshot isn't allowed",
  snapshotFailedNoStart: (err) => `Couldn't take the change snapshot (${err}). Without an OS sandbox, a run can't go ahead untracked, so it was cancelled`,
  runAccessChanged: (old, now) => `run_access in the config changed from ${old} to ${now}; this round uses ${now}`,
  opencodeRunFooter: (schema, access) => `---
## Delivery format (added by the dispatcher)
- ${access === 'edit' ? 'You have no tools for running commands: do not try to run tests or scripts. For commands required by the acceptance criteria, write "Not run; the dispatcher will run them" in the report\'s verification.' : "You may run commands, but they run with the user's account permissions: work only in the project directory; unless the brief allows it, do not touch files outside the project or download or install anything from the network."}
- Nobody can answer you while you run: do not ask and wait. Put questions in the report's decision_requests.
- Finish with a single JSON object matching the JSON schema below. Do not write anything outside the JSON or wrap it in a code block.

JSON schema:
${schema}`,
  opencodeRunResumeFooter: '---\n(Note from the dispatcher: the standing rules and delivery format above still apply. Finish with a single JSON object matching the schema, without a code block.)',

  // ---------- check ----------
  fixNode: (v) => `Node.js ${v} is too old; version 18 or later is needed: https://nodejs.org`,
  fixGit: (v) => `${v ? `${v} is too old` : "git wasn't found"}, so change tracking won't work. Install Git 2.25 or later: https://git-scm.com`,
  fixCodexMissing: "The Codex CLI wasn't found. Install it by running npm install -g @openai/codex in a terminal, then sign in with codex login. If it's installed elsewhere, put its path in agents.codex.bin in the config",
  fixCodexLogin: "Codex isn't signed in: run codex login in a terminal",
  fixCodexSandbox: (name, error, usedIn, unelevatedOk) => `Codex's sandbox can't start commands on this machine (${error}), so every command fails when ${name} does ${usedIn}; with approval set to never, Codex can't ask to lift it either. Pick one fix: ${unelevatedOk ? '1) recommended: set sandbox = "unelevated" under [windows] in ~/.codex/config.toml (just tried on this machine, and it works); ' : process.platform === 'win32' ? '1) redo the setup per Codex\'s Windows sandbox instructions (usually needs administrator rights), or set sandbox = "unelevated" under [windows] in ~/.codex/config.toml and run check again; ' : '1) fix this machine\'s sandbox per the Codex docs; '}2) in the foreman config, set the matching task under agents.${name}.sandbox to "danger-full-access": no sandbox, Codex can read and write the whole machine, held only by the brief and the diff review afterwards; 3) change the levels that use ${name} to "claude code" or another agent. Don't fix it by changing approval: nobody can approve requests in a handed-off task`,
  fixApiKey: (name, env) => `No API key yet: fill in agents.${name}.api_key in ~/.claude/foreman/config.json (takes effect immediately)${env ? `, or set environment variable ${env} (then restart Claude Code)` : ''}; see /foreman-en:setup for how. If you don't plan to use this model, you can leave it`,
  fixApiAuth: (name, source, env) => `The key is invalid or lacks permission; check ${source === 'config' ? `agents.${name}.api_key in the config` : `environment variable ${env}`}`,
  keyHidden: '(set, hidden)',
  fixApiBalance: 'The account balance is too low; top it up and try again',
  fixApiRequest: (name) => `The request was rejected; check that model and base_url in agents.${name} are right`,
  fixApiNetwork: (url) => `Can't reach ${url}; check the address and your network`,
  fixApiRetry: 'The service is unavailable or busy right now; try again later',
  fixApiBusy: 'The service is busy: the request stayed queued and never started. Try again later',
  fixPiMissing: () => "pi wasn't found. Install it by running npm install -g @earendil-works/pi-coding-agent in a terminal. If it's installed elsewhere, set bin for this agent under agents in the config",
  fixPiCatalog: (name, err) => `Couldn't read pi's model list (${err}). Run pi --list-models in a terminal to check that it lists models`,
  fixPiModel: (name, model) => `pi doesn't list the model ${model}. Run pi --list-models in a terminal to see what's available (as provider/model) and fix agents.${name}.model; if the provider isn't signed in yet, sign in with /login inside pi first`,
  fixPiRun: (name, err) => `pi failed to call ${name}'s model: ${err}. Try pi -p "hi" --model <model> in a terminal first`,
  piEffortClamped: (effort, to, supported) => `The model doesn't support ${effort}; pi won't report an error and quietly uses ${to} instead. Supported: ${supported}`,
  fixOpencodeMissing: (name) => `opencode wasn't found. Install it by running npm install -g @opencode/cli in a terminal. If it's installed elsewhere, put its path in agents.${name}.bin in the config`,
  fixOpencodeModel: (name, model) => `opencode doesn't list the model ${model}. Run opencode models in a terminal to see what's available and fix agents.${name}.model. For OpenCode Go models, sign in first by running /connect in opencode`,
  fixOpencodeRun: (name, err) => `opencode failed to call ${name}'s model: ${err}. Try opencode run -m <model> "hi" in a terminal first`,
  fixOpencodeVariant: (name, list) => `${name}'s model doesn't support these reasoning efforts (variants): ${list}. Change them to ones the model supports, or remove these efforts to use the model's default; see the provider's docs for which ones each model has`,
  fixOpencodeVariantFailed: (name, list, err) => `${name}'s model supports these reasoning efforts, but requests using them failed: ${list}. The efforts themselves are fine; the error was: ${err}. This is usually a temporary limit on the provider's side, so run check again later. If it keeps failing, try opencode run -m <model>#<effort> "hi" in a terminal`,
  // Model catalogs, the summary and closest matches
  closestHint: (list) => `. Closest: ${list}`,
  modelNotInCatalog: (model, near = '') => `Model ${model} isn't in this machine's model catalog, so its reasoning effort can't be checked${near ? `; closest: ${near}` : ''}`,
  effortNotInCatalog: (effort, supported) => `The model catalog has no ${effort} level; it supports: ${supported}`,
  noEfforts: 'no levels to choose (default only)',
  effortAt: (effort, at, model, supported) => `${effort} (used at ${at}; ${model} supports: ${supported})`,
  fixEffortUnsupported: (name, list) => `${name} has reasoning efforts its model doesn't support: ${list}. Change them to supported levels, or remove these efforts to use the model's default`,
  warnStaleAlias: (old, target, closest) => `The old ID ${old} points to ${target}, which is no longer in the config, so resuming a run from before the upgrade or passing --agent ${old} won't find an agent. Point it at a current ID in agent-aliases.json${closest ? ` (maybe ${closest})` : ''}`,
  warnPlaintextKey: (name) => `${name}'s API key is written in plain text in the config file; don't commit or share that file`,
  warnShellAccess: (name) => `${name} has shell run access: its commands have no OS sandbox and run with your account's permissions`,
  fixLauncherNotAscii: "The run directory path has non-English characters, so the desktop app's terminal panel can't open the live view (it only accepts ASCII commands). In ~/.claude/foreman/config.json, set dispatch.runs_dir to a path with only English letters and digits, such as \"D:/foreman-runs\". The CLI isn't affected",

  // ---------- arguments ----------

  // ---------- assets: deterministic processing after image generation ----------
  assetsActions: {
    template: '--out <template.png> --cols <n> --rows <n> [--aspect 1:1|3:2|2:3|3:1] [--names <name,…>]',
    cut: '--image <image.png> --out <dir> [--slots <template.slots.json>] [--names <name,…>] [--matte hard|soft] [--key auto|#rrggbb] [--gap <px>] [--min-area <share of canvas>] [--palette <#rrggbb,…> [--snap]] [--colors <n>] [--vector] [--allow-edge]',
    check: '--dir <cut output dir>',
    diff: '--before <old.png> --after <new.png> [--slots <template.slots.json>]',
    align: '--ref <reference.png> --image <piece.png> --out <dir> [--regions <x0,y0,x1,y1;…>] [--min-scale <factor>] [--max-scale <factor>]',
    patch: '--base <original.png> --variant <edited.png> --out <dir> [--keep <x0,y0,x1,y1;…>] [--threshold <difference>] [--min-area <px>] [--open <px>] [--edge <px>] [--grow <px>] [--feather <px>]',
    trace: '--image <reference.png> --seed <x,y;…> --out <dir> [--box <x0,y0,x1,y1>] [--tolerance <difference>] [--colors <n>] [--outline <px>] [--dark <lightness>] [--simplify <px>]',
    capture: '--url <url or file> --times <seconds,…> --out <dir> [--size <w>x<h>] [--scale <factor>] [--zoom <name=x0,y0,x1,y1;…>] [--param t] [--wait <ms>] [--browser <path>]',
    playback: '--url <url or file> --loop <seconds> --out <dir> [--fps <n>] [--static <name=x0,y0,x1,y1;…>] [--size <w>x<h>] [--scale <factor>] [--preview-width <px>] [--param t] [--wait <ms>] [--browser <path>]',
    layers: '--ref <final.png> --plate <plate.png> --pieces <pieces.json> --out <dir>',
  },
  get assetsUsage() { return `Usage: cli.mjs assets <${Object.keys(en.assetsActions).join('|')}> [options]. ${Object.entries(en.assetsActions).map(([action, args]) => `${action} ${args}`).join('; ')}`; },
  assetsHelp: (action) => `Usage: cli.mjs assets ${action} ${en.assetsActions[action]}\nOptions and output are described in references/image-assets.md.`,
  // --help for each subcommand
  help: {
    run: 'Usage:\n  cli.mjs run --cwd <project dir> --brief <brief.md> --title <short title> --level <simple|normal|complex> [--agent <agent>]\n  cli.mjs run --plan <plan_id> --seat <n> --brief <brief.md> --title <short title> --scope <path it may change>\nHands off one piece of hands-on work. Optional: --effort <effort>, --model <model>, --add-dir <dir>, --track <path>, --group <name> (with --scope <path> for group handoffs), --timeout <minutes>, --stall <minutes>, --no-snapshot. --brief - reads the brief from stdin.',
    discuss: 'Usage:\n  cli.mjs discuss --cwd <project dir> --brief <topic.md> --title <short title> --level <simple|normal|complex> [--agent <agent>]\n  cli.mjs discuss --plan <plan_id> --seat <n> --brief <topic.md> --title <short title>\nStarts a read-only discussion. Optional: --file <path[:start-end]> (repeatable), --group <name>, --effort <effort>, --model <model>, --timeout <minutes>.',
    review: 'Usage:\n  cli.mjs review --cwd <project dir> --level <simple|normal|complex> [--target diff|files|claims|visual] [--uncommitted | --base <branch> | --commit <sha>] [--file <path[:start-end]>]... [--brief <review notes.md>] [--agent <agent>]\n  cli.mjs review --plan <plan_id> --seat <n> --brief <review notes.md> --title <short title>\nHas an agent review something; read-only and can\'t be resumed. --target defaults to diff and the range to --uncommitted; files, claims and visual list their material with --file.',
    resume: 'Usage: cli.mjs resume --run <run_id|last> --brief <rework.md> --level <simple|normal|complex> [--file <path[:start-end]>]... [--track <path>]...\nContinues the previous round\'s session: rework, the next round of a discussion, or answering an agent\'s question. Leave out --level when resuming an image task; reviews can\'t be resumed.',
    image: 'Usage: cli.mjs image --plan <plan_id> --seat <n> --brief <brief.md> --title <short title> --scope <output dir>... [--track <path>]... [--effort <effort>]\nStarts one seat of an image plan, without --level. Create the plan first with plan --module image.',
    plan: 'Usage:\n  cli.mjs plan --cwd <project dir> --module <discuss|run|review> --cell <simple|normal|complex> --group <name> --seat <agent>[=<role>]... [--why <reasons>]\n  A review plan can also take: [--target diff|files|claims|visual] [--file <path>]... [--uncommitted | --base <branch> | --commit <sha>]\n  cli.mjs plan --cwd <project dir> --module image --cell <generate|draw> --route <1|2|3|4> --group <name> --seat <agent>... [--why <reasons>]\nCreates a dispatch plan and prints its plan_id and the start command for each seat. The checks are described in references/cli.md.',
    status: 'Usage: cli.mjs status [--run <run_id|last> | --group <name> | --plan <plan_id>] [--limit <n>]\nWith no options, lists the 10 most recent runs; --run prints one run\'s result or current state (JSON), --group lists a group\'s runs with a summary, and --plan prints the state of each seat of a plan (JSON).',
    watch: 'Usage: cli.mjs watch [--run <run_id|last> | --group <name>] [--verbose] [--no-intro]\nShows one run (a timeline) or a group (one panel per run) live. --verbose works with --run and shows every event, including the raw thinking and command output. Press q to stop watching; the runs keep going.',
    cancel: 'Usage: cli.mjs cancel --run <run_id>\nStops a running run; a run that has already ended without finishing normally is marked as dealt with.',
    config: 'Usage: cli.mjs config [--cwd <project dir>]\nPrints the effective config, the agents\' status and the candidates in each cell.',
    check: 'Usage: cli.mjs check [--agent <agent>]\nChecks Node.js, Git and whether each agent works, with a fix for anything that fails.',
    models: 'Usage: cli.mjs models\nLists the models each tool on this machine offers and checks the models in the config against them.',
    'await-busy': 'Usage: cli.mjs await-busy (--group <name> | --run <run_id>) [--after <minutes>]\nExits once an API participant has been queued longer than --after minutes (default dispatch.busy_ask_min) or everything has ended, and lists the queued participants.',
  },
  assetsBadImage: (file, err) => `Can't read the image ${file} (${err}). assets only handles PNG (not interlaced)`,
  assetsBadNumber: (key, value) => `--${key} got ${value}; it must be a positive number`,
  assetsBadAspect: (value) => `--aspect must be 1:1, 3:2, 2:3 or 3:1, got ${value}`,
  assetsTooManyNames: (names, slots) => `Got ${names} names but there are only ${slots} slots`,
  assetsBadColor: (value) => `The color ${value} is invalid; write it as #rrggbb`,
  assetsBadSlots: (file, err) => `Can't read the slots file ${file} (${err}); it should be the .slots.json written by assets template`,
  assetsNoReport: (dir) => `There's no report.json in ${dir}; run assets cut first`,
  assetsSizeMismatch: (a, b) => `The two images have different sizes (${a} and ${b}), so they can't be compared slot by slot`,
  assetsBadRegion: (value) => `${value} in --regions is invalid; write each region as x0,y0,x1,y1 in reference pixels (x0<x1, y0<y1), separated by semicolons`,
  assetsAlignEmpty: (file) => `${file} has no opaque pixels, so there's nothing to align`,
  assetsBadScaleRange: (lo, hi) => `--min-scale (${lo}) can't be larger than --max-scale (${hi})`,
  assetsPatchEmpty: "No solid area of change was found: after ignoring the slight outline shifts, the edited image is almost the same as the original. Look at check.png, and if needed lower --threshold or --min-area, or name the area to take with --keep",
  assetsBadSeed: (value) => `${value} in --seed is invalid; write integer pixel coordinates x,y in the image, separated by semicolons`,
  assetsTraceEmpty: (seeds) => `The seed point ${seeds} is on an outline or a transparent area, so no piece can be traced. Put the seed inside the piece's fill, or raise --tolerance`,
  assetsLayersBadConfig: (file, what) => `Can't use the piece list ${file} (${what}): it needs a pieces array; each piece needs a name (letters, digits, - and _ only, no duplicates, not static) and a lasso of at least 3 points; each extendUnder piece must be another piece in the list, with dist above 0`,
  assetsLayersEmpty: (name) => `Piece ${name} got no pixels: its lasso may miss the subject, or an earlier piece in the list already took that area`,
  assetsNoBrowser: "Couldn't find Chrome or Edge. Point to one with --browser <executable> or the FOREMAN_BROWSER environment variable; without a browser, take the screenshots by hand in Claude's built-in browser",
  assetsCaptureFailed: (url, err) => `Screenshot failed (${url}): ${err}`,
  assetsCaptureBlank: 'Some screenshots are a single flat color, so the page may not have drawn yet: raise --wait and try again, or check that the page draws the frame right away for ?t=',
  assetsBadTimes: (value) => `--times got ${value}; write seconds separated by commas, such as 0,0.5,1.2`,
  assetsBadSize: (value) => `--size got ${value}; write it as <width>x<height>, such as 960x540`,
  assetsBadZoom: (value) => `${value} is invalid; write name=x0,y0,x1,y1 in CSS pixels of the page, separated by semicolons`,
  assetsAlignAmbiguous: "The result isn't reliable: a clearly different scale or position scored about as well, or the result sits at the edge of the scale range. This happens when the piece is small or has few features: narrow the range with --min-scale and --max-scale, or align a larger piece with outlines, and confirm in check.png",
  assetsAlignPlacement: (s, tx, ty) => `Pixel (x, y) of the piece lands at (${tx} + ${s}·x, ${ty} + ${s}·y) in the reference; in SVG write transform="translate(${tx} ${ty}) scale(${s})", or use aligned.png, which shares the reference's canvas`,
  assetsCheck: {
    names: (missing, extra) => [missing.length ? `Missing parts: ${missing.join(', ')}` : '', extra ? `${extra} extra parts without a name` : ''].filter(Boolean).join('; '),
    empty: 'No parts were cut: the image is empty, or all of it was treated as background',
    namesOk: (n) => `${n} parts match the name list`,
    count: (n) => `Cut ${n} parts (no name list, not checked)`,
    outside: (n) => `${n} parts are not inside any slot`,
    merged: (slots) => `Slots ${slots.join(', ')} held several separate pieces, which were merged into one part; check the contact sheet that they belong together`,
    edge: (names) => `Touching the canvas edge, possibly cropped: ${names.join(', ')}`,
    noTransparency: (pct) => `Only ${pct}% of the pixels are transparent; the background was probably not removed`,
    background: (p99) => `The background isn't flat enough (99% of background pixels are within ${p99} of the key color, above 6); edges may keep some background color`,
    specks: (n) => `Dropped ${n} tiny specks; check the contact sheet that no useful detail was lost`,
    vector: (names) => `SVG outline overlap with the image is below 0.95: ${names.join(', ')}`,
  },
  imageRefsMissing: 'The brief asked for reference images through referenced_image_paths, but none of the image calls in this round passed them, so the references had no effect and the images were generated from scratch',
  badDiscussMaxRounds: 'dispatch.discuss_max_rounds must be a whole number of at least 1 (set it in ~/.claude/foreman/config.json)',
  discussRoundsExceeded: (root, done, max) => `Discussion ${root} has already had ${done} rounds, the limit of ${max} (the dispatch.discuss_max_rounds setting). Rule on the results you have; if another round is really needed, raise dispatch.discuss_max_rounds in ~/.claude/foreman/config.json`,
  statusRound: (n) => `[round ${n}] `,
  watchRound: (n) => `round ${n}`,
  badAfter: (min) => `--after must be a number of minutes above 0. Leave it out to use busy_ask_min from the config (${min} min now)`,
  badGroupName: (name) => `Group name ${name} can't be used: use only letters, digits, ".", "_" and "-", up to 64 characters, for example factor-scripts-1013. The live view puts the group name on a terminal command line, and the desktop app's terminal panel only accepts ASCII commands`,
  groupNeedsScope: 'When handing off with --group, give the paths the task may change with --scope (can be repeated), so overlapping scopes in the group can be caught',
  agentFull: (agent, n, max, ids) => `Agent ${agent} already has ${n} runs in progress (${ids}), its parallel limit of ${max}. Wait for one to finish, or raise agents.${agent}.max_parallel in ~/.claude/foreman/config.json`,
  scopeOverlap: (group, other, paths) => `The write scope overlaps with run ${other} in progress in group ${group}: ${paths.join(', ')}. Runs in the same group must not write the same files; split the scope again`,
  groupNotFound: (group) => `No runs found for group ${group} in the last 24 hours`,
  statusGroup: (group) => `[group ${group}] `,
  groupHeader: (group, title, n) => `Group ${group}${title ? ` · ${title}` : ''} · ${n} runs`,
  groupCount: { running: (n) => `running ${n}`, ok: (n) => `done ${n}`, resumed: (n) => `resumed ${n}`, blocked: (n) => `questions returned ${n}`, failed: (n) => `failed ${n}` },
  dashHint: 'Press Ctrl+C to stop watching; the runs keep going',
  dashHidden: (n) => (n === 1 ? "… 1 more run doesn't fit; make the window taller to see it" : `… ${n} more runs don't fit; make the window taller to see them`),
  dashHintQueued: 'A model is queued: press x to stop it · Ctrl+C to stop watching; the runs keep going',
  dashCancelConfirm: (models) => `Press x again to stop ${models}, or any other key to cancel`,
  groupSummary: (total, running, ok, failed, blocked = 0, resumed = 0) => `${total} runs: ${en.dots([`${running} running`, `${ok} done`, resumed && `${resumed} resumed`, blocked && `${blocked} with questions`, `${failed} failed`])}`,
  badArg: (a) => `Unknown argument: ${a}`,
  missingValue: (a) => `Missing value for ${a}`,
  missingOpt: (key) => `Missing --${key}`,
  effortChoices: (list) => `--effort must be one of ${list}`,
  levelChoices: (list) => `--level must be one of ${list}`,
  dirMissing: (dir) => `Directory not found: ${dir}`,
  emptyBrief: 'The brief is empty',
  noRuns: 'No runs recorded yet',
  runNotFound: (ref) => `Run not found: ${ref}`,
  noSession: (id) => `Run ${id} has no session id and can't be resumed`,
  reviewNoResume: "Review sessions can't be resumed; start a fix task with run",

  // ---------- running ----------
  gitFailed: (cmd, err) => `git ${cmd} failed: ${err}`,
  tooManyFiles: (n, max) => `${n} files is more than ${max}; skipping the snapshot`,
  stalled: (min) => `No activity for ${min} minutes and no command running; treated as stuck and stopped`,
  spawnFailed: (err) => `Failed to start codex: ${err}`,
  exitCode: (code, tail, bin = 'codex') => `${bin} exited with code ${code}: ${tail}`,
  unknownModel: 'unknown',
  modelFromCodex: (name) => `${name} (from Codex config)`,
  // The model label: the model name (without the provider prefix) · how it's reached · effort
  channel: { codex: 'Codex CLI', api: 'API', opencode: 'opencode CLI', pi: 'pi CLI' },
  modelLabel: (model, channel, effort, fromConfig) => `${model} · ${channel} · effort ${effort ?? 'default'}${fromConfig ? ' · model from Codex config' : ''}`,
  busyHint: (command, min) => `Queue check: run ${command} in the background (once per group). It exits when a participant has been queued over ${min} min; then decide whether to stop that participant as the skill's "When an API participant is busy" says, and tell the user afterwards`,
  started: (mode, who, level, dir) =>
    `${mode} started · ${who} · ${level ? `level ${level}` : 'effort set directly'} · run dir ${dir}`,
  trackingUnavailable: (err) => `Change tracking unavailable: ${err}`,
  trackingFailed: (err) => `Change tracking failed: ${err}`,
  readonlyViolated: (kind, n) => `The ${kind === 'discuss' ? 'discussion' : 'review'} should be read-only, but the agent changed ${n} file${n === 1 ? '' : 's'} (shown by its tool events or its own report), so this run is marked failed. The files are listed in readonly_violation and the diff is in diff.patch. Nothing was reverted automatically: revert only what's provably its change, and leave anything unclear to the user`,
  auditedNoSnapshot: (kind) => `This ${kind === 'discuss' ? 'discussion' : 'review'} has no read-only sandbox (readonly is audited), so writes can only be caught by comparing snapshots afterwards; --no-snapshot isn't allowed`,
  auditedSnapshotFailed: (err) => `Couldn't take the change snapshot (${err}). There's no read-only sandbox this time, so writes couldn't be caught without a snapshot; the run didn't start`,
  warnReadonlyAudited: (name, modes) => `${name} has no read-only sandbox for ${modes} (readonly is audited): only the rules hold it back, and a snapshot comparison afterwards marks any write as a failure. To have writes blocked outright, set those task types to "read-only" in agents.${name}.sandbox (if Codex's read-only sandbox won't start on Windows, set sandbox = "unelevated" under [windows] in ~/.codex/config.toml)`,
  groupScopeChanges: (n, runs) => `${n} other files changed during the run, all inside the write scope of run ${runs} in the same group, so most likely that run changed them (marked with group_run in changes); review them with that run`,
  unattributedChanges: (n) => `${n} other files changed in the working directory during the run: no tool event shows the agent changed them, and its report doesn't mention them. They may come from Claude or another session, or the agent wrote them with a command and didn't report it. Don't revert them before finding out who changed them`,
  reportedNotTracked: (paths) => `Codex reported changing these files, but they are outside tracking (probably excluded by ignore rules) and are not in diff.patch: ${paths.join(', ')}. Pass them with --track to track them`,
  quotaExhausted: (resets) => `The Codex quota is used up${resets ? `; it should reset at ${resets}` : ''}. Don't retry; the session is kept and can be resumed once the quota resets`,
  lastMessageTruncated: (file) => `last_message keeps only the first 8000 characters; the full text is in ${file}`,
  badReport: 'The final report is not valid JSON; see last_message',
  trackNote: 'Only changes inside the working directory are tracked',
  // meta.json held open by another program without write sharing (backup or sync software, or .NET's File.OpenRead)
  metaWriteGaveUp: (file, sec, err) => `Couldn't write ${file} for ${sec}s (${err}); another program is probably holding it open and not letting others write. Gave up on this write: meta.json keeps the last content written, and the result is in result.json as usual`,
  metaUnreadable: (file) => `Can't read ${file}: another program is holding it open and not letting others read. Close that program (backup or sync software, for example) and try again`,

  // ---------- constraints sent to Codex ----------
  footer: (cwd, addDirs) => `---
## Standing rules (added by the dispatcher)
- Working directory: ${cwd}${addDirs.length ? `; you may also change: ${addDirs.join(', ')}` : ''}. Only change the files and scope listed in the brief. Things written in the brief's "Allowed adaptations" section may be done directly; say in the report what you did and why it is equivalent. Don't go beyond the scope in any other way.
- Before starting, do a cheap preflight: the interpreter and dependencies work, tests can be discovered, and the inputs the task needs exist. Only check; don't run a long full verification for this.
- Nobody can answer you while you run: don't ask a question mid-run and wait for a reply. Questions go only in the final report.
- In these cases, don't decide the item yourself: you would need to go beyond the scope or authorization above; the research definitions, out-of-sample discipline or acceptance criteria would change; an irreversible operation is needed; or different answers would make later time-consuming work wasted. Leave that item undone, or take the most conservative, reversible option; finish everything it doesn't affect as usual. At the end, put the question in the report's decision_requests and set status to blocked. In recommendation, say which option you recommend and which one you've already gone with, or that the item is still undone.
- For anything else you are unsure about, take the conservative, reversible option, keep going and note it in the report; don't stop for every small doubt.
- Only write tests the brief asks for, or that are really needed to verify this change; don't add tests for small changes. Don't code defensively: no extra argument checks, try/catch, fallback branches or duplicate tests.
- Keep to the size the brief describes; don't turn it into a bigger project. Don't add command-line options, settings, abstraction layers or compatibility branches the task didn't ask for, and use existing functions instead of writing new ones where you can. If your change ends up clearly bigger than the size the brief expects, ask yourself whether you've overdone it; if it really is needed, say why in the report.
- Follow the brief for names, comments and user-facing text; if it gives exact wording, use it as is. Otherwise, follow the project's existing naming style and pick plain names that show what things are for. Comment only where something isn't obvious, with one short sentence on why. No long explanations, no line-by-line comments.
- Don't run git commit / git push / git reset --hard or anything that rewrites history. Don't delete files outside the scope. Don't read or change keys, credentials, .env or other secrets.
- Don't install global dependencies or change system settings. If the project really needs a new dependency, say so in the report.
- When done, output the final report in the given JSON schema, in English. Be honest: anything not done or not verified goes in open_issues.`,
  resumeFooter: `---
(Note from the dispatcher: the standing rules above still apply. When done, output the final report in the same JSON schema.)`,
  discussFooter: (cwd) => `---
## Discussion rules (added by the dispatcher)
- This is a design discussion, not a task to carry out. You may read the code and data under ${cwd} and run read-only commands to back up your points, but don't change, create or delete any files.
- Nobody can answer you while you run: don't ask and wait. Put information you need, or anything someone else has to decide, in open_questions.
- Think for yourself; don't just agree. If you disagree, say so and give your reasons. If you agree, say why.
- Lead with the conclusion. Use short, plain sentences, as if explaining to a colleague face to face. No jargon piles, no filler.
- Back every point with evidence: a code location, data or clear reasoning. Mark anything you're unsure about.
- Finish with output in the given JSON schema, in English.`,
  discussResumeFooter: `---
(Note from the dispatcher: the discussion rules above still apply: read-only, don't just agree, speak plainly, back it up; nobody can answer you while you run. Finish with output in the same JSON schema.)`,
  reviewFooter: `---
## Review rules (added by the dispatcher)
- Review only. Don't change, create or delete any files, and don't run commands that change files.
- The material may well have no problems; report only issues you can point to evidence for.
- Report only real problems: correctness bugs, logic errors, edge cases, concurrency and data consistency, security issues, clear performance problems. Not style preferences.
- For each problem give: the location (file:line, or where in the material), the problem, when it goes wrong (what input or state triggers it), the evidence and a suggested fix. Order by severity, most severe first, numbered F1, F2, …
- If you find nothing, leave findings empty and set verdict to no_issues; don't pad the list. If you couldn't finish, set verdict to incomplete. Use coverage to say what you checked and what you didn't, and put anything you're unsure of or couldn't verify in unverified.
- Nobody can answer you while you run, so don't ask and wait.
- Write the review in English.
- Finish with output in the given JSON schema.`,
  reviewTargetChoices: (list) => `--target must be one of ${list}`,
  reviewTargetNeedsFile: (target) => `--target ${target} needs --file to say which files to review (repeat it for several)`,
  reviewScopeDiffOnly: '--uncommitted, --base and --commit only go with --target diff',
  reviewVisualNotImage: (file) => `With --target visual, --file must be an image (png, apng, jpg, jpeg, gif, webp) without a line range: ${file}`,
  readsImagesRequired: (name, type) => `${name} (${type}) can't read images, so it can't do a visual review. Visual reviews only go to agents that can (capabilities.reads_images is true; for now only Codex CLI)`,
  planReviewOnly: '--target, --file, --uncommitted, --base and --commit are only for review plans (--module review)',
  planMaterialFlags: (id) => `Plan ${id} already fixes what to review and the material; don't pass --target, --file, --uncommitted, --base or --commit when starting a seat`,
  planMaterialChanged: (id) => `The material for plan ${id} has changed since the plan was created (its fingerprint no longer matches), so this seat wasn't started. Recreate the plan for the current material`,
  reviewScopeTarget: { files: (n) => `${n} existing file${n === 1 ? '' : 's'} (listed with --file)`, claims: (n) => `the claims in the review brief, with ${n} evidence file${n === 1 ? '' : 's'}`, visual: (n) => `${n} image${n === 1 ? '' : 's'}` },
  reviewPromptFiles: (cwd) => `Please review, in ${cwd}, the files listed under "Key files" below. They are existing files, not changes; review them as they are now.`,
  reviewPromptClaims: (cwd) => `Please review the claims listed one by one in the review brief below: is the evidence enough, does a claim go further than its evidence, are there confounders left uncontrolled, does it hold up statistically. The evidence files are listed under "Key files" (working directory: ${cwd}).`,
  reviewPromptVisual: (cwd) => `Please check the images listed under "Key files" below (screenshots, playback files or renders): open each one with the image viewer tool (view_image), find the problems the review brief asks about, and give each location as the image file name plus where in the picture. Working directory: ${cwd}.`,
  apiReviewPrompt: {
    diff: (scope) => `Please review the changes attached below: ${scope}.`,
    files: () => 'Please review the files attached under "File contents" below. They are existing files, not changes; review them as they are now.',
    claims: () => 'Please review the claims listed in the review brief one by one: is the evidence enough, does a claim go further than its evidence, are there confounders left uncontrolled, does it hold up statistically. The evidence files are attached under "File contents" below.',
  },
  reviewSchemaFooter: (schema) => `Finish with a single JSON object that matches the JSON schema below. No text outside the JSON, and don't wrap it in a code block.

JSON schema:
${schema}`,
  apiReviewSystem: (schema) => `You are doing an independent review. Several reviewers each review the same material, and Claude checks every finding afterwards.
Rules:
- Nobody can answer you while you run: don't ask and wait.
- Work only from the review brief and the attached material in the user message. Don't guess at code or data that isn't in the material, and don't pretend you've seen it; list what you'd need but didn't get in coverage.not_checked.
- When you cite code, give the file path and line number (each line of the file contents starts with its line number; for the patch, use its own positions).
- The material may well have no problems; report only issues you can point to evidence for. Report only real problems: correctness bugs, logic errors, edge cases, concurrency and data consistency, security issues, clear performance problems. Not style preferences.
- For each problem give: the location, the problem, when it goes wrong (what input or state triggers it), the evidence and a suggested fix. Order by severity, most severe first, numbered F1, F2, …
- If you find nothing, leave findings empty and set verdict to no_issues; don't pad the list. If you couldn't finish, set verdict to incomplete. Put anything you're unsure of or couldn't verify in unverified.
- Answer in the language of the review brief, in short, plain sentences.
- Output a single JSON object that matches the JSON schema below. No text outside the JSON, and don't wrap it in a code block.

JSON schema:
${schema}`,
  watchReview: {
    issues_found: (n, parts) => `Review: ${n} issue${n === 1 ? '' : 's'} found${parts ? ` (${parts})` : ''}`,
    no_issues: () => 'Review: no issues found',
    incomplete: (n) => `Review: incomplete${n ? `, ${n} issue${n === 1 ? '' : 's'} found so far` : ''}`,
  },
  severityNames: { high: 'high', medium: 'medium', low: 'low' },
  watchFinding: (f, severity) => `${f.id} [${severity}] ${f.location}: ${f.issue}`,
  watchUnverified: 'Not verified',
  reviewScopeBase: (base, mergeBase) => `the changes relative to ${base}: from the merge-base ${mergeBase} to the current working tree, both committed and uncommitted (git diff ${mergeBase})`,
  reviewScopeCommit: (sha) => `the changes introduced by commit ${sha} (git show ${sha})`,
  reviewScopeUncommitted: 'all uncommitted changes: staged and unstaged changes plus untracked new files (git status, git diff HEAD)',
  opencodeReviewPrompt: (cwd, scope) => `You are doing a code review: review only, don't change any files. Project directory: ${cwd}. Scope: ${scope}. "Changes to review" below is the full set of changes, computed by the dispatcher with git; for more context, use the read and search tools to look at the code under ${cwd}. Nobody can answer you while you run, so don't ask and wait.`,
  reviewMaterial: (fileList, patch, fence) => `---\n## Changes to review (computed by the dispatcher with git)\n### Files\n${fileList}\n### Patch\n${fence}diff\n${patch}\n${fence}`,
  reviewFileBinary: ' (binary, contents not shown)',
  reviewFileTooLarge: ' (over 1 MB, contents not shown)',
  reviewEmpty: (scope) => `${scope}: nothing to review`,
  reviewTooLarge: (chars, max) => `The changes to review come to ${chars} characters, over the limit of ${max}. Review them commit by commit (--commit), or give the review to Codex, which reads the changes itself and has no such limit`,
  reviewScopeChanged: 'What was under review changed while the review ran (the fingerprints at start and end differ), so the review may not cover the latest version; the result is marked stale',
  baseNotFound: (base) => `Couldn't find branch ${base}, or its merge-base with the current branch`,
  reviewPromptGit: (cwd, scope) => `Please review, in ${cwd}, ${scope}.`,
  reviewPromptPlain: (cwd) => `Please review the following (working directory: ${cwd}):`,

  // ---------- status ----------
  // The live view, status and the start line show these English texts in both plugins (format.mjs exports them as D).
  noEvents: 'No events yet',
  stepCommand: (cmd) => `Running: ${cmd}`,
  stepSaid: (text) => `Just said: ${text}`,
  stepFileChanged: 'Just changed files, deciding what to do next',
  stepImageGenerated: 'Just generated an image, deciding what to do next',
  stepCommandDone: 'Command just finished, deciding what to do next',
  stepReadDone: 'Just read a file, deciding what to do next',
  stepSearchDone: 'Just searched, deciding what to do next',
  stepLastEvent: (ev) => `Last event: ${ev}`,
  // The parts of a line are separated by " · "
  dots: (parts) => parts.filter(Boolean).join(' · '),
  statusActivity: (min, step) => `last activity ${min} min ago · ${step}`,
  // Token counts below 10,000 get thousands separators; from 10,000 on they're written as 58k or 1.2M
  tokenCount: (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e4 ? Math.round(n / 1e3) >= 1000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k` : Number(n).toLocaleString('en-US')),
  tokenSummary: (u, last, fmt, sessionTotal) => en.dots([
    `tokens: in ${fmt(u.input_tokens)} (cached ${u.input_tokens ? Math.round((u.cached_input_tokens / u.input_tokens) * 100) : 0}%)`,
    `out ${fmt(u.output_tokens)}${sessionTotal ? ' (session total)' : ''}`,
    last && en.lastRequestNow(last, fmt)]),
  lastRequestNow: (last, fmt) => `last request ${fmt(last.tokens)} / window ${fmt(last.window)}`,
  rateLimit: (r) => `Codex quota: ${r.used_percent}% of the ${r.window_minutes >= 1440 ? `${Math.round(r.window_minutes / 1440)}-day` : `${Math.round(r.window_minutes / 60)}-hour`} window used`,

  // ---------- watch ----------
  watchFallback: 'No run in progress; showing the most recent one:',
  watchWaiting: 'Waiting for a run to start…',
  modeNames: { run: 'run', resume: 'resume', discuss: 'discussion', review: 'review', image: 'image' },
  // The start of the timeline: the title line (mode and level as they are), then the detail lines; a model with a provider prefix is written in full here
  watchHeaderLines: (mode, title, level, cwd, dir, model) => [`${mode} · ${title}${level ? ` · level ${level}` : ''}`, ...(model ? [`Model ${model}`] : []), `Working dir ${cwd}`, `Run dir ${dir}`],
  statusNames: { running: 'running', done: 'done', completed: 'done', partial: 'partly done', blocked: 'questions returned', needs_input: 'waiting for an answer, stopped', failed: 'failed', stalled: 'stalled, stopped', timeout: 'timed out', quota_exhausted: 'out of quota', interrupted: 'interrupted', cancelled: 'stopped' },
  statusName: (s) => en.statusNames[s] ?? s,
  duration: (sec) => {
    const s = Math.round(sec), m = Math.floor(s / 60);
    return s < 60 ? `${s}s` : m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  },
  took: (duration) => `took ${duration}`,
  watchSession: (id) => `Session ${id}`,
  watchTurnFailed: (msg) => `Turn failed: ${msg}`,
  watchTokens: (u) => `tokens: in ${en.tokenCount(u.input_tokens)} (cached ${en.tokenCount(u.cached_input_tokens)}) · out ${en.tokenCount(u.output_tokens)}`,
  watchOpinion: (text) => `Position: ${text}`,
  watchReport: (status, summary) => `Report: ${status} · ${summary}`,
  watchExit: (code, tail) => `exit code ${code}${tail ? ` → ${tail}` : ''}`,
  watchToolFailed: (tail) => `failed${tail ? ` → ${tail}` : ''}`,
  fileKinds: { add: 'added', update: 'changed', delete: 'deleted' },
  // Reading files and searching don't count as commands
  actionRead: (file) => `read ${file}`,
  actionSearch: (query) => `search ${query}`,
  watchChanged: (n, unknown, group) => `${n} file${n === 1 ? '' : 's'} changed${unknown || group ? `, plus ${en.list([unknown && `${unknown} of unknown origin`, group && `${group} from other runs in the group`].filter(Boolean))}` : ''}`,
  watchNotTracked: 'changes not tracked',
  watchFinished: (status, duration, changed) => `${status} · took ${duration}${changed ? ` · ${changed}` : ''}`,
  watchInterrupted: 'The dispatcher process has exited; the run may have been interrupted',
  watchEnded: (status) => `Finished: ${en.statusName(status)}`,
  watchMoreLines: (n) => `(${n} more lines; add --verbose to see everything)`,
  watchPlan: (done, total) => `Plan ${done}/${total}`,
  watchImage: (file) => `Generated image ${file}`,
  // Folded actions are counted by kind
  foldKinds: { command: (n) => `${n} more command${n === 1 ? '' : 's'}`, read: (n) => `${n} more read${n === 1 ? '' : 's'}`, search: (n) => `${n} more search${n === 1 ? '' : 'es'}`, edit: (n) => `${n} more change${n === 1 ? '' : 's'}`, image: (n) => `${n} more image${n === 1 ? '' : 's'}`, other: (n) => `${n} more message${n === 1 ? '' : 's'}` },
  watchFolded: (parts, hint) => `… ${parts}${hint ? ' (add --verbose to see them)' : ''}`,
  watchReconnect: (n, total) => `Connection dropped, reconnecting (${n}/${total})`,
  // The counts after "running 12:03" on the bottom status line and on the right of a group panel's heading
  liveCounts: ({ commands, reads, searches, files, plan }) => [commands && `commands ${commands}`, reads && `reads ${reads}`, searches && `searches ${searches}`, files && `changed files ${files}`, plan && `plan ${plan}`].filter(Boolean),
  watchApiLive: (answering, time, n) => `${answering ? en.apiPhases.answering : en.apiPhases.thinking} ${time} · ${n} characters so far`,
  watchApiThought: (duration, n) => `Thought for ${duration} (${n} characters), now writing the answer`,
  watchThinking: (text) => `thinking: ${text}`,
  watchReplay: (command) => `replay: ${command}`,
  watchKeys: '↑↓ scroll · q quit',
  watchKeysQueued: '↑↓ scroll · x stop · q quit',
  watchCancelConfirm: (model) => `Press x again to stop ${model}, or any other key to cancel`,
  watchCancelSent: 'Asked it to stop; waiting…',
  runCancelled: (model, by) => ({ command: `${model} was stopped by the cancel command`, watch: `${model} was stopped by the user in the live view`, signal: `${model} was stopped: the dispatcher got a termination signal` })[by] ?? `${model} was stopped`,
  cancelForced: "The dispatcher didn't stop by itself in time and was killed; the cancel command wrote this result, so it has no change tracking or report",
  cancelNotStopped: (pid) => `Couldn't stop the dispatcher (pid ${pid}); the run's records weren't changed. End it in Task Manager (or with kill -9), then run cancel again`,
  cancelledUsageMissing: "No request finished before the cancel, so the provider never reported usage; the tokens this run spent can't be recorded (usage is null)",
  cancelledUsagePartial: "Usage only counts requests that finished before the cancel; the provider reports no usage for the request that was in flight, so it isn't counted",
  planStates: { complete: 'complete', pending: 'in progress', incomplete: 'incomplete' },
  watchPlanState: (id, state, detail) => `Plan ${id}: ${en.planStates[state]}${detail ? `; ${detail}` : ''}`,
  watchPlanMissing: (list) => `missing required: ${list}`,
  watchPlanNotStarted: (list) => `required seats not started yet: ${list}`,
  watchPlanSeat: (agent, seat, label) => `${agent} (seat ${seat}${label ? `, ${label}` : ''})`,
  watchPlanNoResult: 'no valid result',
  watchScrolled: (n) => `scrolled back ${n} lines, End to jump to the latest`,
  watchDetached: 'Stopped watching; the run keeps going',
  watchOpenIssues: 'Open issues',
  watchDecisions: 'Questions to decide (Claude decides, then resumes)',
  watchDeniedPrefix: 'Denied action: ',
  watchInputPromptPrefix: 'Waiting for input: ',
  watchAskedMidRun: 'Asked mid-run (no one answered; it carried on with its own judgement)',
  watchRecommendation: (text) => `Recommended: ${text}`,
  needsDecisionNote: (n) => `${n} question(s) need a decision (see questions). The run has finished; it isn't stuck. Decide what Claude can decide, then resume or do it yourself; ask the user only about what needs their call`,
  inputWaitDetected: (min, line) => `It printed what looks like a prompt waiting for an answer and then went quiet for ${min} min; the run was stopped and the question handed back to Claude: ${line}`,
  // The watch intro. In the jokes, {n} becomes the model's short name (GPT, DeepSeek…) and {m} the model name
  introStarting: (who) => `Starting ${who}`,
  introGathering: (n, models) => (models ? `Gathering ${n} models: ${models.join(', ')}` : `Gathering ${n} models`),
  introDispatching: (n, models) => (models ? `Sending out ${n} runs: ${models.join(', ')}` : `Sending out ${n} runs`),
  introDone: 'The run has already finished; straight to the result',
  introCountdown: (s) => `${s}s · any key to skip`,
  introEnded: 'finished',
  introJokes: {
    run: ['Claude is cracking the whip over {n}…', 'Claude is cutting the spec into bite-size pieces for {n}…', 'Reminding {n}: no 300-test suites this time…', '{n} is signing a pledge to stay in scope…', '{n} is reading the family tree (git log)…', 'Claude is highlighting the key points for {n}…', 'Brewing a cup of coffee for {n}…'],
    review: ['{n} is putting on reading glasses…', "Refilling {n}'s red pen…", '{n} is picking nits in the diff…', 'Claude is pretending not to be nervous…'],
    discuss: ['Claude is handing out the debate notes…', 'Arranging the meeting-room chairs in a circle…', "Collecting phones so nobody peeks at anyone else's proposal…", 'Claude announces the rules: attack the idea, not the model…', '{n} is clearing its throat…', 'Claude is pouring everyone a glass of water…'],
  },
  introModelJokes: {
    claude: ['Claude is checking itself in the mirror…'],
    chatgpt: ['GPT is cranking the effort all the way up…', 'GPT is cracking its knuckles…'],
    gemini: ["The Gemini twins are playing rock-paper-scissors for today's shift…", 'Gemini flashes a peace sign: got it…'],
    deepseek: ['DeepSeek is thinking deeply about whether to think deeply…', 'The little whale is diving into the depths of the code…'],
    mimo: ['MiMo is pumping both fists…', 'MiMo is straightening the M hair clip…'],
    glm: ['GLM is straightening the cube hair clip…', 'GLM mutters: read the code first, talk later…'],
    kimi: ['Kimi is reading the whole repo in one sitting…', 'Kimi is polishing the K hair clip…'],
    qwen: ['Qwen is asking question number one thousand…', 'Qwen gives you a wink…'],
    minimax: ['MiniMax is tuning the sound-wave hair clip…', 'MiniMax is clearing its throat for the mic…'],
    unknown: ['A mystery guest is arriving…', "Checking the mystery guest's ticket…", 'Printing a temporary badge for {m}…'],
  },
};

export const MESSAGES = { zh, en };
