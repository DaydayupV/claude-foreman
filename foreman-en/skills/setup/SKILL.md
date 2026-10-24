---
name: setup
description: Setup guide - detect this machine's tools, list the models and efforts available, show the current config and suggested changes, and change the config as you choose
argument-hint: '[optional: just one part, e.g. "add DeepSeek", "use GLM through opencode", "use DeepSeek through pi" or "add a model to discussions"]'
disable-model-invocation: true
---

The user wants to set up foreman. Arguments:

$ARGUMENTS

The script is `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/scripts/cli.mjs`. The config format is described in `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/config.md`; read it before changing the config.

## Output structure
The reply always has the six parts below, each under a level 2 heading copied as shown. The script lays out ①, ② and ③: **paste them as they are, without rewording, dropping rows or reordering**. Claude writes ④ and ⑥ in the format given here. The confirmation pop-up comes once, after ④, so the user has seen everything before it.

| Part | Heading | Comes from |
|---|---|---|
| ① | `## ① Environment` | the environment part of `check --format md` |
| ② | `## ② Models available on this machine` | the output of `models --format md` |
| ③ | `## ③ Current configuration` | the configuration part of `check --format md` |
| ④ | `## ④ Suggested changes` | written by Claude: two numbered tables |
| ⑤ | (pop-up) | AskUserQuestion |
| ⑥ | `## ⑥ Result` | written by Claude: backup location, change tables, check result, summary |

When pasting script output, replace the script's own level 1 and 2 headings with the headings above and copy the rest. If the arguments ask for just one part, ④ only suggests changes for that part; every other part is given in full as usual.

## Steps

1. **Check the environment**: run `node "<script path>" config --cwd "<current project dir>"` (JSON, for the decisions below) and `node "<script path>" check --cwd "<current project dir>" --format md`. Both take `--cwd`, so ③ and ④ see the same config as it applies in this project.
   - "The config file" below always means `user_config` from the config output (the user may have pointed `FOREMAN_CONFIG` elsewhere), and `agent-aliases.json` is the one in the same folder.
   - Paste the environment part of the check output as ①.
   - If Node.js fails, the plugin can't be used: paste ①, pass on the fix and stop. If Git fails, carry on; change tracking won't work. If the live view fails, it only affects opening live progress automatically in the desktop app's terminal panel, so carry on. The table in ① also has "Memory" and "Web board" rows; when the web board is on and memory is low there is an extra ⚠ note. Whether the web board goes into ④ is described under "Web board" in "How to recommend". If the Codex sandbox fails, every task handed to Codex will fail: the user picks the fix, and it goes into ④.
   - If either command printed "First run: created config file" (only the first one to run prints it), say in a sentence or two after ① what it found and what it generated.
   - If either command printed that it wrote the number of external seats for each level into the config file, say in one sentence after ① what it added and where the backup is.
   - If either command printed that it rewrote levels as modules, say so in one sentence after ① and add it to ④ by the old-list rule under "How to recommend".

2. **Read the model lists**: run `node "<script path>" models --format md` and paste it as ②. Run `models` once more without `--format` (JSON) and read `agents.<ID>` to see whether each configured model is in its list: `listed: false` means the model name is wrong or the model was retired, and `closest` has the nearest names; put these into ④.
   - If an opencode or pi model the user wants isn't in ②, the end of ② already says how to sign in; don't repeat it.
   - pi doesn't report an unsupported level and quietly switches to another, so pick efforts only from the ones listed in ②.

3. **Check the docs when adding an API model**: only when the user wants a new API model, or wants to put an API agent that isn't in any cell yet into a cell. API agents already in use keep their current effort; don't look them up again.
   - Search the provider's **official docs** (on the provider's own domain), not third-party articles. Find: the model name, the address of the OpenAI-compatible API (`base_url`), whether it accepts `reasoning_effort`, and which values.
   - For a model that only has a thinking switch and no effort setting, use `null` (for example Xiaomi MiMo). If you can't find it, use `null` and tell the user it uses the model's default.
   - Check the model name against the API table in ② as well. Link the docs in ④.

4. **Current configuration**: paste the configuration part of the check output from step 1 as ③.

5. **Suggested changes**: write ④. Start with one sentence (such as "The current setup mostly stays; 3 suggestions"), then two tables, numbered on from 1 across both so the user can say "change item 3 to …". If a table would be empty, write "none" instead.
   - **Cells and agents**: columns "# | Item | Now | Suggested | Reason". The item is a cell ("discuss complex") or an agent ID; the suggestion names the candidates (agent, model, effort) and whether they're required; the reason is one sentence, and for a new model it names the efforts it can take and where that list came from (which table in ②, or a docs link). New agents, model names to fix, unused agents (ask which cell to put them in or whether to remove them; keep them if the user doesn't mind) and where the key goes for a new API agent all go in this table. After the table, write "All other cells stay as they are".
   - **Left over from older versions**: from the entries in `summary.warnings` of the step 1 config output whose kind is `obsolete_max_seats`, `obsolete_key_env`, `old_backups`, `legacy_levels_note` or `stale_alias` (details such as file names are in those entries' fields; ③ only has the note text). Columns "# | Where | What | Suggested | Reason". Suggest:
     - `dispatch.max_seats`: remove.
     - `api_key_env` (set together with `api_key`): remove it; if the user would rather use the environment variable, remove `api_key` instead.
     - Old backups: remove, keeping the backup made this time; when `contain_keys` is `true`, say in the reason that they hold API keys in plain text.
     - The `levels` note: keep. Reason: an old plugin version stops with an error on reading it instead of quietly handing everything to Claude Code; remove it only once every computer is upgraded.
     - A stale old ID (`stale_alias`): which current ID it should point to, the one from the same provider and the same type; if unsure, list the candidates for the user to choose. It can also be removed if tasks from before the upgrade won't be resumed.

6. **Confirm (pop-up)**: once ① to ④ are all shown, use AskUserQuestion to ask "What should I do with the suggestions above?", with:
   - "Apply the suggestions (recommended)": the description says which items change, which are removed and which stay, such as "change items 1 and 2, remove items 4–6; items 3 and 7 stay";
   - "Adjust items": the description says "reply with item numbers and changes, such as 'change item 1 to …' or 'keep item 5'";
   - "Not now".
   - "Adjust items": with 4 items or fewer, ask again with AskUserQuestion, offering candidates for each (recommended first; efforts only from ②), at most 4 items per question; with more, ask the user to reply with the item numbers and the changes. When the user changes an item, redo the suggestions that depend on it (for example, a new model means picking the effort from the new model's levels).
   - "Not now": go to step 8 and only write the summary.

7. **Change the config**:
   - Back up first: copy the config file to `<file name>.setup-<YYYYMMDD-HHMMSS>.bak` in the same folder; if `agent-aliases.json` will change this time, copy it to `agent-aliases.json.setup-<YYYYMMDD-HHMMSS>.bak` too.
   - Change `agents` and `modules` in the user config, writing each cell as a list of candidates; keep all three levels of `seats` for `discuss` and `review` in the file, change the seat numbers there, and when adding required agents raise that level to at least the required count. Leave the one-line `levels` note in the file alone unless the user chose to remove it in ④. Use the model name as the ID (for opencode and pi, the part after `/`); if that ID is taken, add the type as a suffix, such as `deepseek-flash-api`, `deepseek-flash-opencode-cli` or `deepseek-flash-pi`. Fix stale old IDs in `agent-aliases.json`, changing or removing only that entry, never the whole file: resuming pre-upgrade runs and old IDs in project configs depend on it.
   - The two live-view switches: write both `terminal` and `web` in the user config's `dispatch.watch`. Keep `terminal` as it is (the plugin already rewrote the old form when it loaded, so it is usually there; if not, write `true`); write `web` as `true` or `false` as the user confirmed in ④, or keep it as it is when ④ has no such item.
   - Remove what was left over from older versions, only the items the user confirmed. Remove only the old backups listed in ④, never the one made this time.
   - Where the API key goes:
     - **In the config file** (takes effect immediately): tell the user to open the config file (give the full `user_config` path) and add a line `"api_key": "<key>"` to that agent themselves. Remind them the key is stored in plain text, so the file shouldn't be committed or shared.
     - **In an environment variable**: write `"api_key_env": "<name>"` in the config and tell the user to set it themselves: on Windows, add a user variable under "System Properties → Environment Variables", or run `[Environment]::SetEnvironmentVariable('<name>', '<key>', 'User')` in PowerShell; on macOS and Linux, put it in the shell's startup file. Claude Code must be restarted to see it.
     - **Don't ask the user to paste the key into the chat.** If the user has already pasted one and explicitly asks for it to be written into the config, you may put it in `api_key` in the user config (never a project config), and remind them that the key is now in the conversation history and should be replaced with a new one later.
   - Run `config --cwd "<current project dir>"` to validate. If it reports an error, fix it as the error says (it gives the closest valid name); if you can't, restore the backup and tell the user why.
   - Then run `check --cwd "<current project dir>" --format md`. For anything that fails: for an unsupported effort, pick again from ② and go back to step 6. A key in an environment variable can only be seen after the user restarts, so "key not set" is expected then; ask the user to run `/foreman-en:setup` again after restarting.

8. **Result**: write ⑥, in this order:
   - Where the backup is (when the config changed).
   - **Changes this time**: columns "Cell | Agent | Before → after" (effort, required, added or removed). Leave it out if nothing changed.
   - **Removed**: columns "Where | What". Leave it out if nothing was removed.
   - **Check result**: if the check in step 7 passed and the notes have no new ❌ or ⚠, write one line "✅ Validation and checks passed."; otherwise paste the new ❌ and ⚠ lines as they are and say what to do about them. Don't paste the whole configuration again; end with "Say if you'd like to see the full updated configuration".
   - **Summary**: two or three sentences: what works now and what's still missing; day to day, just ask Claude Code to do things: each thing gets a level for discussion, hands-on work and review, Claude Code handles small things itself and hands off what crosses the threshold to agents it picks from the configured candidates, and `/foreman-en:run`, `/foreman-en:discuss` and `/foreman-en:review` name a task type directly. When the web board is on, add one sentence: from now on every handoff first gives a web link, which opens every conversation on this computer in the default browser, and the terminal live view no longer opens by itself; `/foreman-en:watch` shows the terminal view or gives the link again at any time.

## How to recommend
- Keep the current setup by default. Only suggest a change when: a cell's model or effort isn't in its list; a new tool was installed this time, or the user wants to add a model; a review or discussion level is `"claude code"` and a suitable agent is now available; the config has no image cells yet and this machine has an image-capable agent; the discussion lists were rewritten from the old format and nobody has decided who is required; a Codex agent has no read-only sandbox for discussions or reviews (`readonly_audited` among the notes); a discussion or review level has clearly fewer candidates than seats (the "fewer than" rows under "Seats and required agents" in ③). Hands-on work at simple and normal going to Claude Code is the default; don't change it on your own.
- **Web board** (`dispatch.watch.web`, off by default): a star map in the browser of every conversation on this computer and its handoffs; when it's on, every handoff first gives a web link in the conversation, then starts the work, and the terminal live view no longer opens by itself. Whether to turn it on depends on this computer's memory, from the "Web board" row in ①:
  - "off (enough memory to turn it on)": list it in ④ and recommend turning it on. As the reason, give this computer's memory (the "Memory" row in ①) and the cost: about 100–130 MB for the board server and 60–90 MB for its browser tab.
  - "off (low memory; better left off)": nothing to change, so don't list it in ④; mention in the summary that memory is low (under 8 GB in total or under 2 GB available), so the web board isn't recommended for now. If the user asks for it anyway, turn it on and warn that things may get sluggish.
  - "on · low memory": recommend turning it off, for the same reason.
  - On with enough memory: don't list it.
- Pick efforts only from the levels listed in ②, in two ways depending on the model's tier in `references/model-tiers.md` (a model not in the table counts as mid):
  - **Weak and mid models get their highest level at all three levels** (such as `max` or `xhigh`; a model with a single level uses that one). They mostly serve as breadth seats that draft independently in round 1, where thinking harder is what catches what others missed; these models are cheap, so the top level costs little more. A noticeably expensive weak model still uses its top level, but by the rule below it only goes in complex.
  - **Strong models follow the level**: a lower one for simple (such as `medium`), the default or one above for normal (such as `high`), and the highest usual one for complex (such as `max`). Suggest a level above that only when the user asks, if its description says it's much slower or costlier.
- Hands-on work can only go to a `codex cli` agent or an `opencode cli` / `pi cli` agent with `run_access`. For reviews prefer Codex (it can run read-only commands to verify, and for now it's the only agent that can read images for screenshot checks); opencode and pi can review too. API agents can join discussions and reviews, reviewing text material only (patches, file contents), never screenshots.
- Suggest a read-only sandbox for Codex discussions and reviews: set `review` and `discuss` to `"read-only"` in `agents.<ID>.sandbox`, so the OS blocks writes (the result's read-only level is `sandbox`); without it, only the rules and a snapshot comparison afterwards hold it back (`audited`). On Windows, look at the Codex sandbox in ① first: if the read-only sandbox won't start, follow the fix from `check` and set `sandbox = "unelevated"` under `[windows]` in `~/.codex/config.toml`. Don't change the sandbox for hands-on work here.
- Prefer a different model for reviews than for hands-on work: a model reviewing its own changes repeats its own blind spots. If the only agent that can review uses the same model as hands-on work, suggest it anyway and say so in the reason (Claude Code will then note in its reports that the same model reviewed the work).
- One provider account may be shared by opencode, pi and API agents, and concurrency limits are per account (some Moonshot accounts, for example, allow only 1 request at a time): don't put two participants that use the same limited account in the same discussion level.
- Each cell lists candidates, not everyone who takes part: `seats` sets how many outside models each level of discussions and reviews uses (defaults under "Candidates and required agents" in `references/config.md`; the numbers in use and how they're filled are under "Seats and required agents" in ③), and when there are fewer candidates than that, all of them take part. When the user wants more agents or a fixed set, suggest changing `seats` (for a fixed set, set it to the number of candidates). Discussion and review cells can hold several candidates, preferably from different providers for a wider range of views. The same model reached through api, pi or opencode counts as one base model. Premium models with small limits (such as Kimi K3 or Qwen Max on OpenCode Go) only at complex. Mention that API candidates receive the attached code or patches.
- **Required** (`"required": true`): an agent that always takes part when the cell is used, counted within the seats. Suggest marking one strong, reliable model (such as Codex's strong tier) as required in each of the level 3 discussion and review cells, so the important work always has it; other cells usually don't need one. Hands-on, generate and draw cells can have at most one required agent. A required agent uses its quota every time, so don't mark many, and don't mark models with tight limits.
- If the config was rewritten from the old `levels` format: the old discussion lists used to mean everyone takes part, and now they're candidates. Ask whether the user wants to keep everyone taking part (mark them all required) or let Claude Code pick and mark only the key models required; suggest the latter. When marking them all required, raise that level's `seats` to at least the required count too, or the config won't load.
- **The two image cells**: `generate` only takes image-capable agents (only `codex cli` for now); suggest gpt-6.1-sol at `medium`, since image quality mostly depends on the image model and a higher effort only costs more. `draw` takes a strong model that can do hands-on work; suggest gpt-6-astra at `max`, since tracing bending pieces from the final image and writing their deformation takes careful work. Without Codex, set both to `null`; if the user doesn't want image generation, set `generate` to `null`, and if they don't want drawing handed off, set `draw` to `null` (Claude Code draws instead).
- **Don't suggest opencode or pi for hands-on work by default.** If the user wants it, explain the two levels, and write `run_access` only after the user clearly agrees and picks one:
  - `"edit"`: only changes files in the project and can't run commands; Claude Code runs the tests afterwards;
  - `"shell"`: can also run commands. Neither opencode nor pi has an OS sandbox, so the commands run with the user's account permissions and can reach the whole machine. Ask the user to explicitly confirm they accept "no OS sandbox".

## Special cases
**Only API, no Codex, opencode or pi**: before ④, explain that hands-on work can only be done by Claude Code itself, while discussions and reviews can go to API agents (reviews of text material only, no screenshots); for an outside agent to do work or look at images, Codex, opencode or pi is needed (only Codex reads images for now).

**Nothing at all**: give only ①, then explain that Claude Code currently does all the work itself. To bring in outside models, the user can install the Codex CLI (`npm install -g @openai/codex`, then run `codex login`), install opencode (`npm install -g @opencode/cli`), install pi (`npm install -g @earendil-works/pi-coding-agent`), or get an API key. Then run `/foreman-en:setup` again.
