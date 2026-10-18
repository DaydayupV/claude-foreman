---
description: Talk a complex plan, design or idea through with other configured models, such as Codex (discussion only, nothing is carried out; Claude Code decides)
argument-hint: <topic> [--level simple|normal|complex | --effort <effort>] [--model <model>] [--agent <agent>]
---

The user wants to start a discussion on this topic:

$ARGUMENTS

Follow "1. Settling the approach: discussion" in the `foreman-en:dispatch` skill (load it first if it isn't loaded). The user asked for it, so skip the level 0 check:

1. Get clear on the topic, constraints and the questions to answer. If no topic is given, the topic is the question the conversation was just on. If key information is missing and can't be worked out from the code or context, ask the user first.
2. Pick the level: if the user gave `--level` or `--effort`, use it; otherwise pick `--level` from levels 1–3 by the skill's discussion criteria; add any `--model` the user gave. The participants come from `resolved_levels.discuss.<level>` in the `config` output; if the user gave `--agent`, send it only to that one. At level 1 (a one-off question), follow the short version in the skill and skip writing your own proposal, the critique round and the decision record below.
3. Choose the mode: follow "Choosing the mode" in the skill to pick the normal mode or role mode; if the user asks for role mode or names roles, use role mode at levels 2 and 3 (level 1 always uses the normal mode). In role mode, work out the assignment as in `references/roles.md` and have the user confirm it in a pop-up first; if they choose a normal discussion instead, use the normal mode.
4. Write the round 1 topic brief (without your own leaning; in role mode, every seat gets the same shared body plus its own role card), write down your own proposal first, then start one `cli.mjs discuss` per participant in the background together (with several participants, use the same `--group` and `--agent` for each; name the relevant files with `--file`: API agents get their contents, Codex, opencode and pi agents get only the paths and read them themselves). Tell the user in the chat which model and effort each one uses (taken from the first line the script prints), and open the live view as in the skill's "Live view"; when there are API participants, also start the queue check `await-busy` in the background.
5. Critique each other following the process, up to the round limit in `dispatch.discuss_max_rounds` (2 by default).
6. Rule on each participant's points, report to the user in the decision record format, then follow "After the discussion" to decide whether to stop there or carry on.
