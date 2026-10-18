---
name: status
description: Show recent runs, or the details of one run
argument-hint: [run_id | last | group name]
disable-model-invocation: true
---

Run `node "${CLAUDE_PLUGIN_ROOT}/skills/dispatch/scripts/cli.mjs" status`. The argument is `$ARGUMENTS`: if it's a run_id or `last`, add `--run <argument>` to see that run's details; if it's a group name, add `--group <argument>` to see the whole group.

Show the user a short table or list: time, type, status, model, task level and effort, duration, title, working directory. For runs in progress, also show the last activity time and current step, and say whether it looks like it's working normally (for example running a long command) or might be stuck. For a single run's details, add the summary from Codex's report, the changed files and open issues.
