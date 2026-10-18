---
name: discuss
description: 就复杂的计划、方案或想法与配置的其他模型（比如 Codex）讨论（只讨论不执行，由 Claude Code 主导结论）
argument-hint: <议题> [--level simple|normal|complex | --effort <推理强度>] [--model <模型>] [--agent <协作方>]
disable-model-invocation: true
---

用户要求就下面的议题发起讨论：

$ARGUMENTS

按 `foreman:dispatch` skill 里"一、方案阶段：讨论"执行（如果尚未加载，先加载它）。用户已明确要求，所以不做 0 级判断：

1. 弄清议题、约束和要回答的问题。没写议题时，议题就是对话里刚才在谈的问题。缺少关键信息且无法从代码或上下文推断时，先问用户。
2. 确定等级：用户写了 `--level` 或 `--effort` 就照用，否则按 skill 里讨论的定级标准从 1–3 级里判断 `--level`；用户写的 `--model` 一起加上。参与方按 `config` 输出的 `resolved_levels.discuss.<等级>`；用户写了 `--agent` 就只发给那一方。1 级（一次性问答）按 skill 里的从简做法，跳过下面先写自己的方案、交叉挑错和决策记录这几步。
3. 选模式：按 skill 里的"选模式"决定用普通模式还是角色模式；用户要求用角色模式或指定了角色时，2、3 级用角色模式（1 级只用普通模式）。角色模式按 `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/roles.md` 排好分配，先弹窗让用户确认，用户选了改用普通讨论就按普通模式。
4. 写第 1 轮的议题说明（不写自己的倾向；角色模式下每个席位是相同的公共主干加自己的角色卡），先把自己的方案写下来，再给每个参与方各发一次 `cli.mjs discuss`（多方时用同一个 `--group`，每次用 `--agent` 指定；用 `--file` 指明相关文件：API 协作方会收到文件内容，Codex、opencode 和 pi 协作方只收到路径、自己去读），在后台一起启动。在对话里告诉用户每一方的模型和推理强度（以脚本启动时输出的第一行为准），并按 skill 的"实时查看"打开实时查看；有 API 参与方时同时在后台启动排队检查 `await-busy`。
5. 按流程进行交叉挑错，轮数上限见配置 `dispatch.discuss_max_rounds`（默认 2）。
6. 逐条裁决各参与方的观点，用决策记录的格式向用户汇报，再按"讨论之后"决定停在这里还是接着做。
