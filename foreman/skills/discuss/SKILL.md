---
name: discuss
description: 就复杂的计划、方案或想法与配置的其他模型（比如 Codex）讨论（只讨论不执行，由 Claude Code 主导结论）
argument-hint: '<议题> [--level simple|normal|complex] [--effort <推理强度>] [--model <模型>] [--agent <协作方>]'
disable-model-invocation: true
---

用户要求就下面的议题发起讨论：

$ARGUMENTS

按 `foreman:dispatch` skill 和它的 `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/discuss.md` 执行（如果尚未加载，先加载 skill）。用户已明确要求，所以不做 0 级判断：

1. 弄清议题、约束和要回答的问题。没写议题时，议题就是对话里刚才在谈的问题。缺少关键信息且无法从代码或上下文推断时，先问用户。
2. 确定等级：用户写了 `--level` 就照用，否则按 skill 的"定级"里讨论的标准从 1–3 级里判断 `--level`（`--level` 总要写）；用户写的 `--effort` 和 `--model` 一起加上。参与方按 `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/seats.md` 从 `config` 输出的 `resolved_modules.discuss.<等级>` 里挑，必选的一定参加；用户写了 `--agent` 就只发给那一方（只能是这一格的候选；这一格还有别的必选时，要把它们一起放进计划）。1 级（一次性问答）按 discuss.md 里的从简做法：照样先提交 Claude Code 席的短报告，跳过交叉挑错和决策记录。
3. 选模式：按 discuss.md 的"选模式"决定用普通模式还是角色模式；用户要求用角色模式或指定了角色时，2、3 级用角色模式（1 级只用普通模式）。角色模式按 `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/roles.md` 排好分配，先弹窗让用户确认，用户选了改用普通讨论就按普通模式。
4. 写第 1 轮的议题说明（不写自己的倾向；角色模式下每个席位是相同的公共主干加自己的角色卡），用 `plan` 建计划（只有一个外部参与方也要建）。按 seats.md 的"Claude Code 席"写好自己的报告，用 `cli.mjs submit` 提交，写报告时发现议题缺的事实先补进议题。再给每个外部参与方各发一次 `cli.mjs discuss --plan <plan_id> --seat <序号>`（用 `--file` 指明相关文件：API 协作方会收到文件内容，Codex、opencode 和 pi 协作方只收到路径、自己去读），在后台一起启动。在对话里告诉用户每一方的模型和推理强度（以脚本启动时输出的第一行为准），并附上看板链接（见 skill 的"派出时"）；网页看板关着时按 `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/watch.md` 打开终端实时查看；有 API 参与方时同时在后台启动排队检查 `await-busy`。
5. 按流程进行交叉挑错，轮数上限见配置 `dispatch.discuss_max_rounds`（默认 2）：先提交 Claude Code 席这一轮的报告，再续接外部席，匿名池里包括 Claude Code 席的方案。
6. 逐条裁决各参与方的观点（包括 Claude Code 席自己的），用 `judge` 记下每条的去留（2、3 级），用决策记录的格式向用户汇报，再按 discuss.md 的"讨论之后"决定停在这里还是接着做。
