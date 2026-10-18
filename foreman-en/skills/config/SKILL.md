---
name: config
description: Show or change foreman settings (agents, who gets each level, model and effort, sandbox, time limits, etc.)
argument-hint: [setting to change, e.g. "switch complex tasks to gpt-6.1-sol with ultra"]
disable-model-invocation: true
---

The user wants to see or change the foreman settings. Arguments:

$ARGUMENTS

1. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/dispatch/scripts/cli.mjs" config --cwd "<current project dir>"` to see the settings in effect and the config file paths. `references/config.md` in the `foreman-en:dispatch` skill folder explains each setting.
2. With no arguments, show the user a short table of:
   - `summary.levels`: who each level of each task type goes to, with model and effort;
   - `summary.agents` and `agents_status`: which agents there are, the cells each is used in, and whether each API agent's key is set;
   - `summary.warnings`: things worth noting, passed on one by one in plain words;
   - the settings under `dispatch`, and where each one comes from (built-in default, user config or project config).
   Then stop.
3. With arguments, change the config file as asked:
   - Change the user config by default. If the user says it's for this project only, change the project config instead, but project config only accepts `dispatch.timeout_min`, `dispatch.stall_min`, `dispatch.busy_ask_min` and `levels`, and each cell can only be tightened: set to `"claude code"`, or narrowed to agents the user config already has in that cell, with a different effort if wanted.
   - Change only the settings the user mentioned and leave the rest as they are.
   - Before changing a model or effort, run `models` to see the lists, and use only efforts that model supports; for API models, check the provider's official docs for efforts.
   - When adding an API agent, the key can go in `api_key` in the user config (plain text, takes effect immediately) or in an environment variable named by `api_key_env` (needs a Claude Code restart). Let the user choose, and have them fill in the key or set the variable themselves; don't ask them to paste the key into the chat. Keys only work in the user config; a project config can't set them.
4. Run `config` again to confirm, and tell the user what changed. If agents, models or efforts changed, also run `check` and use its `summary` to show the level table and warnings after the change.
