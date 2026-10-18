---
name: run
description: Hand a task off to the configured agent (pick a level by task complexity; who gets it, the model and effort come from the config)
argument-hint: '<task> [--level simple|normal|complex | --effort <effort>] [--model <model>]'
disable-model-invocation: true
---

The user wants this task handed off to an agent:

$ARGUMENTS

Follow the `foreman-en:dispatch` skill (load it first if it isn't loaded). The user asked for it to be handed off, so don't decide again who should do the work, and skip the level 0 check:

1. Get clear on the goal, scope and what counts as done. If key information is missing and can't be worked out from the code, ask the user first.
2. Write the brief file using the skill's structure, and decide the working directory and task level: if the user gave `--level` or `--effort`, use it; otherwise pick `--level` from levels 1–3 by the skill's criteria for hands-on work; add any `--model` the user gave. If that level is `"claude code"` in the config, still hand it off, since the user asked for it: add `--agent <agent ID>`, picking one that can do hands-on work (`capabilities.modes` includes `run`; see "Who does what" in the skill), or the one the user named. If names, comments or messages are involved, settle them in the brief.
3. Run `cli.mjs run` in the background, tell the user in the chat which model and effort it uses (taken from the first line the script prints), then open the live view as in the skill's "Live view".
4. When it finishes, follow the skill's checking steps: review the diff, actually run it, send it back for rework if needed; then level the review to decide whether to have it reviewed, and report to the user.
