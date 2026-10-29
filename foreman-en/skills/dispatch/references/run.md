# Hands-on work (/foreman-en:run)

Read this when hands-on work is levelled 1 or higher, before writing a brief or splitting work into packages. The levels are under "Levels" in SKILL.md; when the cell has several candidates or a required agent, also read `references/seats.md`; for research tasks, also read `references/research.md`; checking and rework of what comes back are in `references/acceptance.md`.

## Who gets it
- Levels 1–3 go by `resolved_modules.run.<level>`: if it says `"claude code"`, Claude does the task itself (the script also refuses to hand off that level); if it lists candidates, pick one per seats.md and hand the task off. When the level is configured per scene (see "Scenes" in `references/config.md`), first pick the scene by the scene routing in the preferences and add `--scene <scene> --scene-why "<reason>"` when handing it off; the cell that counts is that scene's merged cell, and a resume keeps the original scene. When Claude does it, still think through the scope and the "done when" as the brief below would, and check the result per acceptance.md.
- When the user explicitly wants it handed off (for example by naming it with `/foreman-en:run`), skip the level 0 check and hand it off even if the level is `"claude code"`: add `--agent <agent ID>`, picking one whose `capabilities.modes` includes `run`, with the built-in default effort unless you give `--effort` (the result is marked `outside_cell`). When the level lists candidates, `--agent` can only pick one of them. To use another model, add `--model`; it can only switch to another model from the same provider.
- Mixed tasks: when a piece of work has parts only Claude does (design decisions, copy, names) and parts that can be handed off, Claude settles the former first and writes them into the brief, then hands off the rest. In front-end work, decisions about layout, color, type, spacing, motion and how interactions feel are Claude's; only the logic built to a settled design or to existing component patterns (state, data fetching, form validation, API wiring, tests) is handed off.

## Writing the brief
The more specific, the better the agent does. Use this structure:

```markdown
# Goal
What to build and why (a sentence or two of background).

# Scope
- May change: specific files or directories
- Read-only reference: related files
- Don't touch: …

# Size
Roughly how many lines and files the change should be, and what isn't needed this time, such as command-line options, settings, compatibility with old data, or tests.

# Requirements and constraints
Interface signatures, data formats, existing patterns and helpers to reuse, performance needs, compatibility, etc.

# Allowed adaptations
Things the agent may handle without stopping to ask. For example:
- If the given test entry point won't run, use an equivalent one that covers the same tests
- May fix a particular test fixture, but must not weaken any assertion
(Write "none" if there are none.)

# Names and text
- Names: what new files, classes, functions, key parameters and settings are called
- Comments: where they're needed and what they say
- Messages: exact wording or templates for logs, errors, help text and output headers (to be used as is)
(Leave this section out if the task doesn't involve any of these.)

# Don't
Things off-limits for this particular task.

# Done when
What counts as finished. Write verification as two items, each with the actual commands:
- Agent checks: the targeted tests and checks the agent runs, covering only what this change touches
- Final check: the full test suite or script Claude runs on the final version; the agent doesn't run this one

# Report
Anything that needs special mention in the report.
```

Agents tend to do everything and do it heavy: even simple tasks get extra options, settings, abstraction layers, compatibility branches and lots of tests. The "Size" section is there to prevent this: state the expected size and what isn't needed, and check against it when reviewing. The standing rules the script appends also say "keep to the size, only necessary tests, don't code defensively"; repeat it in the brief when the task invites overdoing it. Keep the brief itself in proportion too; don't write pages for a simple task.

Grant "Allowed adaptations" by meaning, not by size: a one-line change can move an out-of-sample boundary, a fee rate or an assertion. Anything beyond the scope that isn't in this section makes the standing rules tell the agent to stop and ask in the report's `decision_requests`. Write foreseeable environment problems (such as a same-named `tests` package in the project) into this section up front to save a stop.

Verification is split along the two items of "Done when", so the full suite runs only once on the same code: the agent runs targeted tests, rerunning the affected ones after it changes code; Claude runs the full suite on the final version. The standing rules tell the agent not to run the full suite unless the brief explicitly asks for it; when it really needs to see the full results itself (for example, the task is to fix failures the full suite shows), say so under "Agent checks".

**Names and text** are Claude's to set: outside models write weakly, with piles of jargon and stiff phrasing. Give the names of new files, modules, classes, functions, key parameters and settings as a list, and anything not on the list follows the project's existing style; say where comments go and what they say, in the same language the project uses; for logs, error messages, command-line help, output headers and other text people will see, give the exact wording or a template and require it to be used as is.

## Handing it off
- Write the brief to a UTF-8 file first (in the scratchpad directory if there is one, otherwise in the system temp directory), then start `run` in the background (Bash `run_in_background`); you get notified when it finishes. Do other things meanwhile; don't poll. The script appends standing rules: stay in scope, do a preflight check, run only the targeted checks given to it, when to stop and ask, only necessary tests, no commit/push, no secrets, report in the schema.
- After starting, tell the user the model and effort and add the board link as "When you hand off" in SKILL.md says, and see to the live view.
- Several runs can go in parallel, but their file scopes must not overlap. **Claude doesn't touch files an agent is changing.**
- If the allowed scope includes paths ignored by `.gitignore` (such as `tests/` or a results folder), pass them with `--track "<path>"` (can be given more than once); otherwise change tracking can't see those files. Resume keeps the previous round's `--track`.
- When Codex's sandbox isn't `read-only` / `workspace-write` (for example `danger-full-access`), `--cwd` **doesn't limit what Codex can write**. The scope is then held only by the brief and by reviewing the diff afterwards.

## Splitting work to run in parallel
Most of the time an agent's run takes goes into the model thinking, and only a small part into running commands. So splitting a big task across several sessions running at once noticeably cuts the wait. The cost is more tokens in total (each session reads the background on its own), and Claude has to write more briefs and check more results.

**When to split**: only when **all** of these hold; otherwise hand it off as one task:
1. It splits into 2 or more parts, no more than that agent's parallel limit (`agents_status.<ID>.max_parallel`, 4 by default; that agent's runs from other sessions take slots too); the parts **write to no shared files** and **don't depend on each other's output**.
2. Claude can settle the interfaces between the parts (function signatures, data formats, file paths) before handing off, and write them into every brief. If they can't be settled, don't split.
3. Each part is expected to take more than 10 minutes. For small tasks, the fixed overhead outweighs the time saved.

**Don't split**: bugs with an unknown cause that need investigating; refactors that touch shared core files; research stages that build on each other; work that needs one consistent design; tasks that are mostly heavy computation (running them at once fights over the CPU; have the agent write a batch script that runs them in parallel instead). Good cases: several independent scripts or modules; once the interface is set, one part writes the implementation and another the tests; bulk changes split by folder.

**How to hand it off**:
- Level each part by its own difficulty. If a part is level 0 or its level is `"claude code"` in the config, Claude does that part itself, also staying out of the other parts' files; hand off the rest as usual. When the parts have different levels and one of those levels has another required agent, create one plan per level under the same group name.
- Give the group a name (an ASCII code name plus the date, such as `factor-scripts-1013`, used only on command lines; the live view shows each part's `--title`; use a different name for each group within a conversation; names repeated across conversations are fine, since the view only counts runs from the current conversation; only letters, digits and `. _ -`, because the live view puts it on a terminal command line, and the script rejects other characters) and hand off each part with `run --level <level> --group <name> --scope <path it may change>`; `--scope` can be given more than once. When parts go to different agents in the same cell and the cell has a required agent, handing them off one by one is refused: first create a plan with `plan --module run --cell <level> --group <name> --seat <agent>=<part name> …`, then hand off each part with `run --plan <plan_id> --seat <n> --scope …`. Start the parts together in the background, in the same message.
- The script refuses two cases: the agent already has as many runs in progress as its limit allows (counted across all groups and sessions), or the write scope overlaps with a hands-on run in progress in the same group (discussions and reviews don't write files, so their scopes aren't checked). If refused, split the scope again as the error says, or wait for an earlier run to finish.
- Besides the general structure, each brief says: what the other parts of the group do and which files they change (those files are off-limits); the shared interface agreements (copied word for word into every brief); how to verify this part on its own.
- The terminal live view (while the web board is off) gets just one tab: `watch.mjs --group <name>`, titled "Run: <short title>".
- Tell the user how many parts there are and what each does, with the model and effort of each.
- **Checking**: check each part on its own (its diff and its targeted checks, not the full suite: the other parts aren't merged in yet, so the full suite can't pass anyway), and send back only the parts that fail (resume keeps the group and scope). Once all pass and any needed integration steps are done, Claude does an **overall check**: run the full tests or scripts on the combined final version. In the report, list each part's run_id and token use, then the total.
