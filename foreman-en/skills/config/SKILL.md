---
name: config
description: Show or change foreman settings (agents, each cell's candidates and required agents, model and effort, sandbox, time limits, etc.)
argument-hint: '[setting to change, e.g. "switch complex tasks to gpt-6.1-sol with ultra"]'
disable-model-invocation: true
---

The user wants to see or change the foreman settings. Arguments:

$ARGUMENTS

1. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/dispatch/scripts/cli.mjs" config --cwd "<current project dir>"` to see the settings in effect and the config file paths. `references/config.md` in the `foreman-en:dispatch` skill folder explains each setting.
2. With no arguments, show the user a short table of:
   - `summary.modules`: in `default`, for the three levels of discussions, hands-on work and reviews and the two image cells, each cell's candidates, which are required, and their model and effort; with `--cwd`, mark the cells in `project_config.cells` as "set by the project config"; when `image_configured` is `false`, mark both image cells as "not set up yet" rather than off;
   - `summary.agents` and `agents_status`: which agents there are, the cells each is used in, and whether each API agent's key is set;
   - `summary.warnings`: things worth noting, passed on one by one in plain words;
   - the settings under `dispatch`, and where each one comes from (built-in default, user config or project config).
   Then stop.
3. With arguments, change the config file as asked:
   - Change the user config by default. If the user says it's for this project only, change the project config `<project dir>/.claude/foreman.json` instead: it overrides the user config, only accepts `modules` (including `seats` and `gap`) and `discuss_max_rounds`, `timeout_min`, `stall_min`, `busy_ask_min` under `dispatch`, and a cell it writes is replaced as a whole; agents have to be defined in the user config's `agents` first.
   - If the user wants some kind of scene to use different models, efforts, required agents, seat counts or gap switches, follow "Scenes" in `references/config.md`: define the scene in the preference file's scene block, add a scene block with the same name under `modules`, and write only what differs from `default`; after the change, check that `scenes.problems` in the `config` output is empty.
   - If the user config still used the old `levels` format, the script already rewrote it as `modules` when `config` ran in step 1; edit the new format, and leave the one-line `levels` note it left in the file alone (it makes old versions of the plugin stop with an error). Write each cell as a list of candidates, adding `"required": true` to required entries; hands-on, generate and draw cells can have at most one required agent.
   - Change only the settings the user mentioned and leave the rest as they are.
   - Before changing a model or effort, run `models` to see the lists, and use only efforts that model supports; for API models, check the provider's official docs for efforts.
   - When adding an API agent, the key can go in `api_key` in the user config (plain text, takes effect immediately) or in an environment variable named by `api_key_env` (needs a Claude Code restart). Let the user choose, and have them fill in the key or set the variable themselves; don't ask them to paste the key into the chat. Keys only work in the user config; a project config can't set them.
4. Run `config` again to confirm, and tell the user what changed. If agents, models or efforts changed, also run `check` and use its `summary` to show the cell table and warnings after the change.
