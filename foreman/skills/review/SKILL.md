---
name: review
description: 请配置的协作方（比如 Codex）独立审查代码改动、已有文件、结论和证据，或者截图和播放文件
argument-hint: '[--target diff|files|claims|visual] [--file <路径>]... [--base <分支> | --commit <sha>] [--level simple|normal|complex] [--effort <推理强度>] [--model <模型>] [--agent <协作方>] [审查重点]'
disable-model-invocation: true
---

用户要求请协作方审查。参数：

$ARGUMENTS

按 `foreman:dispatch` skill 里"五、审查"执行（如果尚未加载，先加载它）。用户已明确要求，所以不做 0 级判断：

1. 确定工作目录和审查对象（`--target`）：用户给了就照用。没给时按要审的东西选：代码改动用 `diff`（默认审未提交的改动，参数里给了 `--base` 或 `--commit` 就照用）；没改过的文件、写好的设计文档用 `files`；结论和证据用 `claims`；截图、播放文件、渲染结果用 `visual`（只能交给能看图的协作方）。`diff` 以外的对象用 `--file` 列出要审的文件；目录不是 git 仓库时审已有文件用 `files`。
2. **总是写一份审查说明**，通过 `--brief` 传入：写明被审内容的来由和意图、风险点，以及参数里给的审查重点；`claims` 逐条列出结论，每条写明证据的位置和关键数字。Codex 审 `diff` 时，只有带审查说明（或 `--file`），结果才是结构化报告、遵守审查要求；不带的话会走 Codex 原生审查，输出是英文文字。
3. 确定等级：用户写了 `--level` 就照用，否则按 skill 里审查的定级标准从 1–3 级里判断 `--level`（`--level` 总要写）；用户写的 `--effort` 和 `--model` 一起加上。审查方按 skill 的"一格有多个候选时"从 `resolved_modules.review.<等级>` 里挑，用户点了某个协作方就用它（只能是这一格的候选）。挑了几个审查方时先用 `plan` 建计划，审查对象、`--file` 和范围参数写在 `plan` 上，每席各发一次 `review --plan <plan_id> --seat <序号> --brief …`。用 `cli.mjs review` 在后台运行，在对话里告诉用户这次用的模型和推理强度（以脚本启动时输出的第一行为准），再按 skill 的"实时查看"打开实时查看；有 API 审查方时同时在后台启动排队检查 `await-busy`。
4. 拿到结果后逐条核实 `report.findings` 里的问题（没有 `report` 时看 `last_message`）：确实存在的列出来，并说明打算怎么修；误报说明为什么不成立。结果标了 `stale`、`verdict` 为 `incomplete`，或者审查方越界写了文件（`readonly_violation`）时告诉用户。用户只要了审查，修复前先问用户是否要修，除非用户已经说过要修。审查方和被审内容的作者是同一个模型时，在汇报里注明。
