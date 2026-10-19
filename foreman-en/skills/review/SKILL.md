---
name: review
description: Have a configured agent (such as Codex) review code changes independently
argument-hint: '[--base <branch> | --commit <sha>] [--level simple|normal|complex] [--effort <effort>] [--model <model>] [--agent <agent>] [focus]'
disable-model-invocation: true
---

The user wants an agent to review code. Arguments:

$ARGUMENTS

Follow "5. Review" in the `foreman-en:dispatch` skill (load it first if it isn't loaded). The user asked for it, so skip the level 0 check:

1. Decide the working directory and what to review: uncommitted changes (`--uncommitted`) by default; use `--base` or `--commit` if given. If the directory isn't a git repository, put the files to review and what to look at in the review brief.
2. **Always write a review brief** and pass it with `--brief`: the intent of the change, the risky spots, and any focus given in the arguments. When Codex reviews, only a brief makes it follow the "review only, no changes, plain words" rules; without one, Codex's built-in review runs instead. opencode and pi always review the patch the plugin computed.
3. Pick the level: if the user gave `--level`, use it; otherwise pick `--level` from levels 1–3 by the skill's review criteria (`--level` is always needed); add any `--effort` or `--model` the user gave. Pick reviewers from `resolved_modules.review.<level>` per "When a cell has several candidates" in the skill; if the user named an agent, use it (it must be one of the cell's candidates). With several reviewers, create a plan with `plan` first and start one `review --plan <plan_id> --seat <n>` per seat. Run `cli.mjs review` in the background, tell the user in the chat which model and effort it uses (taken from the first line the script prints), then open the live view as in the skill's "Live view".
4. When the results are in, check each issue the reviewer raised: list the real ones and how you plan to fix them; for false positives, say why they don't hold. The user only asked for a review, so ask before fixing, unless they've already said to fix them. If the reviewer is the same model as the one that made the changes, say so in the report.
