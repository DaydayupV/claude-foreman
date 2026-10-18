---
name: setup
description: Setup guide - detect this machine's tools, list the models and efforts available, give one complete recommendation, change the config as you choose, and finish with an overview of the whole config
argument-hint: '[optional: just one part, e.g. "add DeepSeek", "use GLM through opencode", "use DeepSeek through pi" or "add a model to discussions"]'
disable-model-invocation: true
---

The user wants to set up foreman. Arguments:

$ARGUMENTS

The script is `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/scripts/cli.mjs`. The config format is described in `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/config.md`; read it before changing the config. Go through these steps in order, and tell the user the result of each one briefly. If the arguments ask for just one part, step 4 only recommends that part; do the other steps as usual.

1. **Check the environment**: run `node "<script path>" check` and `node "<script path>" config --cwd "<current project dir>"`.
   - Use one table to show what this machine has, from `environment` in `config`: whether Codex is there and signed in; whether opencode and pi are there and how many models each has; which API key environment variables were found.
   - If Node.js fails, the plugin can't be used: pass on its `fix` and stop. If Git fails, tell the user change tracking won't work and suggest installing it, but carry on. If the live view (`watch`) fails, it only affects opening live progress automatically in the desktop app's terminal panel, so carry on. If anything under Codex's `sandbox` fails, its sandbox can't start on this machine and every task handed to it will fail: pass on the fixes in `fix` for the user to choose, and include this in the recommendation in step 4.
   - If the script printed "First run: created config file", pass on what it found and what it generated.
   - Don't list each agent's check result here; that goes into the overview in step 7.

2. **Read the model lists**: run `node "<script path>" models` (read-only; it sends no model requests).
   - `tools."codex cli"`, `tools."opencode cli"` and `tools."pi cli"`: the model lists built into the local tools. Each model has `efforts` (the efforts it supports), `default_effort` and `context`; opencode and pi models also have `cost` (US dollars per million tokens). If `ok` is `false`, say why the list couldn't be read (for example not installed or not signed in) and skip recommendations for that tool.
   - `api.<ID>`: the model names each API agent's endpoint lists. This list has no efforts.
   - `agents.<ID>`: whether each agent's model in the config is in its list (`listed`). `false` means the model name is wrong or the model was retired; `closest` has the nearest names. Put these into the recommendation in step 4.
   - Show the user the models they can choose from:
     - Codex: leave out models with `hidden` set to `true`. One line per model: name, supported efforts (mark the default) and context length.
     - opencode: only models whose `enabled` isn't `false`, grouped by provider, with their variants, context and price (write "free" for a price of 0). A model with empty `efforts` has no variants to choose, so its effort can only be left out. When there are many models, list only the ones in the recommendation and the ones the user asks about, and add "N more; say if you want to see them all".
     - pi: grouped by provider, with supported efforts, context and price. pi doesn't report an unsupported level and quietly switches to another, so pick efforts only from the ones listed here.
     - If the pi model the user wants isn't listed, ask them to run `pi` in their own terminal and sign in to that provider with `/login` there (or set its API key environment variable), then run `models` again.
     - If the opencode model the user wants isn't listed, ask them to run `opencode` in their own terminal and sign in with `/connect` there (choose OpenCode Go for a Go subscription), then run `models` again.

3. **Check the docs when adding an API model**: only when the user wants a new API model, or wants to put a generated API agent that isn't in any level yet into a level. API agents already in use keep their current effort; don't look them up again.
   - Search the provider's **official docs** (on the provider's own domain), not third-party articles. Find: the model name, the address of the OpenAI-compatible API (`base_url`), whether it accepts `reasoning_effort`, and which values.
   - For a model that only has a thinking switch and no effort setting, use `null` (for example Xiaomi MiMo). If you can't find it, use `null` and tell the user it uses the model's default.
   - Check the model name against the `api` list from step 2 as well. Link the docs in the recommendation in step 4.

4. **Give one complete recommendation**: give all three parts below together, numbering every item so the user can say "change item 3 to …".
   - **Level table**: the three levels of hands-on work, reviews and discussions. For each cell give "now" and "recommended"; the recommendation names the agent, model and effort with a one-line reason. Write "unchanged" for cells that stay. Next to each model used, list the efforts it can take and where that list came from (the Codex list, the opencode list, the pi list or a docs link).
   - **Agents to add, change or remove**: new ones (ID, type, model), ones whose model name needs fixing, and ones not used at any level (ask which level to put them in or whether to remove them; keep them if the user doesn't mind).
   - **Other**: for a stale old ID in the overview warnings (`stale_alias`), recommend which current ID it should point to: the one from the same provider and the same type. If unsure, list the candidates for the user to choose, or remove the entry (if tasks from before the upgrade won't be resumed). When adding an API agent, where the key goes.

   Recommend by these rules:
   - Keep the current setup by default. Only recommend a change when: a cell's model or effort isn't in its list; a new tool was installed this time, or the user wants to add a model; a review or discussion level is `"claude code"` and a suitable agent is now available. Hands-on work at simple and normal going to Claude is the default; don't change it on your own.
   - Pick efforts only from the levels the list supports: a lower one for simple (such as `medium`), the default or one above for normal (such as `high`), and the highest usual one for complex (such as `max`). Recommend a level above that only when the user asks, if its description says it's much slower or costlier.
   - Hands-on work can only go to a `codex cli` agent or an `opencode cli` / `pi cli` agent with `run_access`. For reviews prefer Codex (native review, and it can run read-only commands to verify); opencode and pi can review too. API agents can only join discussions.
   - Prefer a different model for reviews than for hands-on work: a model reviewing its own changes repeats its own blind spots. If the only agent that can review uses the same model as hands-on work, recommend it anyway and say so in the reason (Claude will then note in its reports that the same model reviewed the work).
   - One provider account may be shared by opencode, pi and API agents, and concurrency limits are per account (some Moonshot accounts, for example, allow only 1 request at a time): don't put two participants that use the same limited account in the same discussion level.
   - Discussions: one participant or no outside model for simple; one or two for normal; two to four for complex, preferably from different providers for a wider range of views. Premium models with small limits (such as Kimi K3 or Qwen Max on OpenCode Go) only at complex. Mention that API participants receive the attached code.
   - **Don't recommend opencode or pi for hands-on work by default.** If the user wants it, explain the two levels, and write `run_access` only after the user clearly agrees and picks one:
     - `"edit"`: only changes files in the project and can't run commands; Claude runs the tests afterwards;
     - `"shell"`: can also run commands. Neither opencode nor pi has an OS sandbox, so the commands run with the user's account permissions and can reach the whole machine. Ask the user to explicitly confirm they accept "no OS sandbox".

5. **Let the user adjust item by item**: use AskUserQuestion with "Apply the recommendation" (first, as the recommended option), "Adjust items" and "Not now".
   - "Adjust items": ask which items to change (if there are more than 4 items, ask the user to reply with the item numbers and the changes), then offer candidates for each (recommended first; only efforts from the list), at most 4 items per question.
   - When the user changes an item, redo the recommendations that depend on it (for example, a new model means picking the effort from the new model's list).
   - "Not now": go to step 7 and only give the overview.

6. **Change the config and confirm**:
   - Back up first: copy `~/.claude/foreman/config.json` to `config.json.setup-<YYYYMMDD-HHMMSS>.bak` in the same folder, and tell the user where it is.
   - Change `agents` and `levels` in the user config. Use the model name as the ID (for opencode and pi, the part after `/`); if that ID is taken, add the type as a suffix, such as `deepseek-flash-api`, `deepseek-flash-opencode-cli` or `deepseek-flash-pi`. Fix stale old IDs in `~/.claude/foreman/agent-aliases.json`.
   - Where the API key goes:
     - **In the config file** (takes effect immediately): tell the user to open `~/.claude/foreman/config.json` and add a line `"api_key": "<key>"` to that agent themselves. Remind them the key is stored in plain text, so the file shouldn't be committed or shared.
     - **In an environment variable**: write `"api_key_env": "<name>"` in the config and tell the user to set it themselves: on Windows, add a user variable under "System Properties → Environment Variables", or run `[Environment]::SetEnvironmentVariable('<name>', '<key>', 'User')` in PowerShell; on macOS and Linux, put it in the shell's startup file. Claude Code must be restarted to see it.
     - **Don't ask the user to paste the key into the chat.** If the user has already pasted one and explicitly asks for it to be written into the config, you may put it in `api_key` in the user config (never a project config), and remind them that the key is now in the conversation history and should be replaced with a new one later.
   - Run `config --cwd "<current project dir>"` to validate. If it reports an error, fix it as the error says (it gives the closest valid name); if you can't, restore the backup and tell the user why.
   - Then run `check`. For anything that fails, follow its `fix`: for an unsupported effort, pick again from the list and go back to step 5. A key in an environment variable can only be seen after the user restarts, so "key not set" is expected then; ask the user to run `/foreman-en:setup` again after restarting.

7. **Overview of the whole config**: from `summary` in the `check` output of step 6 (or step 1 if nothing changed), give:
   - **Level table**: the three levels of hands-on work, reviews and discussions. Each cell gives the agent, model, effort (say "default" when it's left out or `null`) and the check result; before the table, say in one sentence that each kind also has a level 0 (small things not worth an outside model), which Claude always handles itself and which isn't in the config. for `ok: false`, give the `problem`. Describe `"claude code"` as "Claude does it itself" for hands-on work and "no outside model" for reviews and discussions.
   - **Agent table**: ID, type, model, the cells it's used in, hands-on access and the check result. For the hands-on access column:
     - `opencode cli` or `pi cli` with `run_access`: write `edit` (only changes files in the project, can't run commands) or `shell` (can also run commands, no OS sandbox);
     - `opencode cli` or `pi cli` without `run_access`: write "not enabled (edit or shell can be turned on)". Don't write "can't do hands-on work": they can, the user just has to turn it on first;
     - `codex cli`: write "no need to enable";
     - `api`: write "—", since API agents only join discussions.
   - **Warnings**: pass on each of `summary.warnings` in plain words, skipping ones already handled in step 4.
   - Finish in two or three sentences: what works now and what's still missing; day to day, just ask Claude to do things: each thing gets a level for discussion, hands-on work and review, Claude handles small things itself and hands off what crosses the threshold per the config, and `/foreman-en:run`, `/foreman-en:discuss` and `/foreman-en:review` name a task type directly.

**Only API, no Codex, opencode or pi**: explain that hands-on work and reviews can only be done by Claude itself; for an outside agent to do work or reviews, Codex, opencode or pi is needed.

**Nothing at all**: explain that Claude currently does all the work itself. To bring in outside models, the user can install the Codex CLI (`npm install -g @openai/codex`, then run `codex login`), install opencode (`npm install -g @opencode/cli`), install pi (`npm install -g @earendil-works/pi-coding-agent`), or get an API key. Then run `/foreman-en:setup` again.
