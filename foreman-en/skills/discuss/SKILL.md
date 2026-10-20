---
name: discuss
description: Talk a complex plan, design or idea through with other configured models, such as Codex (discussion only, nothing is carried out; Claude Code decides)
argument-hint: '<topic> [--level simple|normal|complex] [--effort <effort>] [--model <model>] [--agent <agent>]'
disable-model-invocation: true
---

The user wants to start a discussion on this topic:

$ARGUMENTS

Follow "1. Settling the approach: discussion" in the `foreman-en:dispatch` skill (load it first if it isn't loaded). The user asked for it, so skip the level 0 check:

1. Get clear on the topic, constraints and the questions to answer. If no topic is given, the topic is the question the conversation was just on. If key information is missing and can't be worked out from the code or context, ask the user first.
2. Pick the level: if the user gave `--level`, use it; otherwise pick `--level` from levels 1–3 by the skill's discussion criteria (`--level` is always needed); add any `--effort` or `--model` the user gave. Pick the participants from `resolved_modules.discuss.<level>` in the `config` output per "When a cell has several candidates" in the skill, always including the required ones; if the user gave `--agent`, send it only to that one (it must be one of the cell's candidates; if the cell has other required agents, put them in a plan together). At level 1 (a one-off question), follow the short version in the skill and skip writing your own proposal, the critique round and the decision record below.
3. Choose the mode: follow "Choosing the mode" in the skill to pick the normal mode or role mode; if the user asks for role mode or names roles, use role mode at levels 2 and 3 (level 1 always uses the normal mode). In role mode, work out the assignment as in `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/roles.md` and have the user confirm it in a pop-up first; if they choose a normal discussion instead, use the normal mode.
4. Write the round 1 topic brief (without your own leaning; in role mode, every seat gets the same shared body plus its own role card), write down your own proposal first, then start one `cli.mjs discuss` per participant in the background together (with several participants, create a plan with `plan` first, then start each seat with `--plan <plan_id> --seat <n>`; name the relevant files with `--file`: API agents get their contents, Codex, opencode and pi agents get only the paths and read them themselves). Tell the user in the chat which model and effort each one uses (taken from the first line the script prints), and open the live view as in the skill's "Live view"; when there are API participants, also start the queue check `await-busy` in the background.
5. Critique each other following the process, up to the round limit in `dispatch.discuss_max_rounds` (2 by default).
6. Rule on each participant's points, record each verdict with `judge` (levels 2 and 3), report to the user in the decision record format, then follow "After the discussion" to decide whether to stop there or carry on.
