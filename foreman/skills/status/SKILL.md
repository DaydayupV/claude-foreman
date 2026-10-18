---
name: status
description: 查看最近的任务记录，或某次任务的详细结果
argument-hint: [run_id | last | 组名]
disable-model-invocation: true
---

运行 `node "${CLAUDE_PLUGIN_ROOT}/skills/dispatch/scripts/cli.mjs" status`。参数是 `$ARGUMENTS`：如果给了 run_id 或 `last`，就加上 `--run <参数>` 查看那一次的详细结果；如果给的是任务组名，就加上 `--group <参数>` 查看整组。

用简短的中文表格或列表向用户展示：时间、类型、状态、模型、任务等级和推理强度、耗时、标题、工作目录。正在运行的任务还要展示最后活动时间和当前步骤，并据此说明它是在正常工作（比如正在执行长命令），还是可能卡住了。查看单次结果时，再加上 Codex 报告的摘要、改动文件和遗留问题。
