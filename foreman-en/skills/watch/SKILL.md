---
name: watch
description: Watch a run live in a terminal
argument-hint: '[run_id | last | group name]'
disable-model-invocation: true
---

Open the live progress view. The argument is `$ARGUMENTS`.

Run the watch launcher as described in the "Live view" section of the `foreman-en:dispatch` skill: if the `run_in_terminal` tool is available, use it to open the view in the terminal panel; otherwise send the user the command and ask them to run it in another terminal. Arguments:
- No argument: if this conversation has a discussion or task group in progress, follow the whole group with `--group <name>`; otherwise follow the run in progress, or show the most recent one if none is running
- A run_id or `last`: add `--run <argument>` to the command
- A group name: add `--group <argument>` to follow the whole group at once: one window with a block per seat, each showing its latest progress; scroll with the mouse wheel when there are many seats, press a seat's number to open its full timeline, and Esc to go back
- If the user wants every detail (reasoning, each command and its output, token usage), also add `--verbose`. The default view is a timeline: the model and task lines stay at the top, then what the model says, folded commands, file changes and the final result, with the latest reasoning on the bottom line. The view re-flows when the window is resized; scroll back with ↑↓, PgUp/PgDn or the mouse wheel, press End to jump to the latest, and q to stop watching; when a model is queued because its service is busy, press x to stop it. When the run ends the view stays on screen and can still be scrolled; after q the full record stays in the terminal. Once the run is resumed, a line above the bottom one names the new run, and n switches to it.
- The first time the view opens for a newly dispatched conversation, a few seconds of intro play first (the model's pixel avatar); any key skips it. Add `--no-intro` if the user doesn't want it this time; to turn it off for good, set `dispatch.intro` to `false` in the config.

If it was opened in the terminal panel, send the user the tab link.
