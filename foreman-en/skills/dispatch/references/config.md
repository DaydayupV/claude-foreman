# Configuration reference

The config is JSON. These layers are applied in order, later ones overriding earlier ones:
1. the script's built-in defaults;
2. the user config `~/.claude/foreman/config.json` (the environment variable `FOREMAN_CONFIG` changes the path);
3. the project config `<project dir>/.claude/foreman.json` (it can only tighten; see the end).

It has three parts:

| Part | What it answers |
|---|---|
| `dispatch` | How the plugin hands off work: whether to do it on its own, discussion rounds, time limits and so on |
| `agents` | Which agents there are and how to reach them |
| `modules` | Which candidates each cell of each task type has, who is required, and with what effort |

How to reach an agent goes only in `agents`; who gets what goes only in `modules`.

Example:

```json
{
  "agents": {
    "gpt-6.1-sol": { "type": "codex cli", "model": "gpt-6.1-sol" },
    "gpt-6-astra": { "type": "codex cli", "model": "gpt-6-astra" },
    "glm-5.3":     { "type": "opencode cli", "model": "opencode-go/glm-5.3" },
    "deepseek-v4-pro": { "type": "api", "base_url": "https://api.deepseek.com", "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-v4-pro" }
  },
  "modules": {
    "discuss": {
      "simple":  "claude code",
      "normal":  [{ "agent": "gpt-6.1-sol", "effort": "high" }, { "agent": "glm-5.3" }],
      "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }, { "agent": "glm-5.3" }, { "agent": "deepseek-v4-pro", "effort": "max" }],
      "seats":   { "simple": 2, "normal": 4, "complex": 3 }
    },
    "run":    { "simple": "claude code", "normal": "claude code", "complex": [{ "agent": "gpt-6.1-sol", "effort": "max" }] },
    "review": { "simple": [{ "agent": "gpt-6.1-sol", "effort": "medium" }], "normal": [{ "agent": "gpt-6.1-sol", "effort": "high" }], "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }],
                "seats": { "simple": 1, "normal": 2, "complex": 2 } },
    "image":  { "generate": [{ "agent": "gpt-6.1-sol", "effort": "medium" }], "draw": [{ "agent": "gpt-6-astra", "effort": "max" }] }
  }
}
```

## dispatch

| Setting | What it does | Default |
|---|---|---|
| `auto` | Whether Claude asks before starting handoffs, discussions and reviews on its own: `true` goes ahead and says so, `false` asks first (see "Permission" in the skill) | `true` |
| `watch` | The two live-view switches, written as `{ "terminal": true, "web": false }`; write both:<br>`terminal`: the terminal live view while the web board is off. With `web` `false` and `terminal` `true`, a terminal tab opens and the terminal panel comes up once work goes to another model (hands-on work, resumes, discussions, reviews) and has started; with `terminal` `false` nothing opens by itself. With `web` `true` only the web board is used, and no terminal live view opens by itself. Either way, `/foreman-en:watch` shows the terminal view when you want it.<br>`web`: the web board, a star map in the browser of every Claude Code conversation on this computer and its handoffs. When `true`, every handoff first gives a web link in the conversation, then starts the work, and you open the link in your default browser; `/foreman-en:watch` gives one too. One board server is shared by every conversation on this computer; it starts in the background the first time it's needed, exits after 30 minutes with nobody looking and nothing running, and also when the plugin is removed or updated. It takes about 100–130 MB of memory, and its browser tab about 60–90 MB; `/foreman-en:setup` decides from the memory (off when under 8 GB in total or under 2 GB available).<br>The old form (`watch` as `auto` or `off`, plus a separate `web`) still reads; the first load backs the file up and rewrites it in this form | `{ "terminal": true, "web": false }` |
| `intro` | The first time the live view opens for a newly dispatched conversation, play a short intro first: the model's pixel avatar, "Starting …" and a few jokes, 5 seconds for one model and 10 for a discussion. Any key skips it, and it wraps up at once if the run finishes early. Resumes (the next round of a discussion, a rework) don't get one. The avatar is picked by keywords in the model name (gpt, deepseek, glm, kimi, qwen, mimo, minimax, gemini, claude and so on), with a ??? avatar for anything else. `false` turns it off | `true` |
| `discuss_max_rounds` | The most rounds one discussion can have (round 1 plus later resumes), counted per participant; the script refuses resumes beyond it | `2` |
| `timeout_min` | Total time limit for one run, in minutes | `480` |
| `stall_min` | How long without activity counts as stuck, in minutes (0 turns it off). Codex: no events and no command running; API: no data at all in the stream; opencode: no events at all; pi: no events and no tool running | `40` |
| `busy_ask_min` | Once an API agent has been queued this many minutes because its service is busy, Claude decides whether to stop it (0 turns this off) | `2` |
| `runs_dir` | Run directory (or the environment variable `FOREMAN_RUNS_DIR`). Dispatch plans are kept in its `plans/` folder | `~/.claude/foreman/runs` |

## agents

- Each key is the agent's **ID**, used by `modules` and `--agent`. Naming it after its model works best.
- IDs may only use letters, digits, `.`, `-` and `_`, must start with a letter or digit, and can't be `claude` or `claude code`.
- `type` decides how it's reached and which settings it takes. There are four types, and you can have several agents of one type, each with a different model.
- Codex isn't required. With no agents at all, Claude does everything itself.

**`type: "codex cli"`** (the Codex CLI on this machine)

| Setting | What it does | Default |
|---|---|---|
| `model` | Model | If not set, uses `~/.codex/config.toml` |
| `bin` | Path to the codex executable or `codex.js` (or the environment variable `CODEX_BIN`) | Found automatically |
| `max_parallel` | How many runs this agent may have going at once, across all groups and sessions (see "Splitting work to run in parallel" in `references/run.md`) | `4` |
| `sandbox` | Sandbox for each of `run` / `review` / `discuss`: `read-only` / `workspace-write` / `danger-full-access`. With `read-only` for discussions and reviews, the OS sandbox blocks writes (the result's `readonly` is `sandbox`); otherwise only the rules and a snapshot comparison afterwards hold it back (`audited`). On Windows, Codex's default elevated read-only sandbox may fail to start even file-reading commands; see below | All `null` (use Codex config) |
| `approval` | Approval policy: `never` or `on-request` | `never` when not set: runs are unattended, so nobody can approve. A command blocked by the sandbox fails straight back to the model; a broken sandbox needs fixing, see "When Codex's sandbox won't start" below |

### When Codex's sandbox won't start
Symptoms: every command in a task handed to Codex fails with `windows sandbox failed`, `helper_unknown_error`, `setup refresh had errors` or `Failed to create unified exec process`, and `notes` in the result says the sandbox is broken. The most common cause is that Codex's default elevated sandbox on Windows has a broken setup (it needs a one-time setup with administrator rights).

Run `check`: for each sandbox mode the task types actually use, it runs an echo with `codex sandbox`, with no model call and no cost, and fails with the fixes listed if the sandbox is broken. Pick one:
1. On Windows, set `sandbox = "unelevated"` under `[windows]` in `~/.codex/config.toml`. `check` tries this too and says so when it works.
2. Redo the setup per Codex's Windows sandbox instructions (usually needs administrator rights).
3. In the foreman config, set the matching task under `agents.<ID>.sandbox` to `"danger-full-access"`: no sandbox, Codex can read and write the whole machine, held only by the brief and the diff review afterwards.

Don't fix it by changing `approval`. Codex 0.162 has two approval values: `never` (a blocked command's failure goes straight back to the model) and `on-request` (the model decides when to ask for approval). Nobody can approve in a handed-off task, so foreman uses `never` by default; with a broken sandbox neither value can run commands. Also, `workspace-write` has no network access by default, so tasks that install dependencies fail; if needed, turn on `network_access = true` under `[sandbox_workspace_write]` in the Codex config.

**`type: "opencode cli"`** (the Opencode CLI on this machine)

| Setting | What it does |
|---|---|
| `model` | Required, written as `provider/model`, for example `opencode-go/glm-5.3`. Anything `opencode models` lists works |
| `bin` | Optional path to the opencode executable. Found automatically by default |
| `max_parallel` | Optional; `4` by default |
| `run_access` | Optional; lets it do hands-on work: `"edit"` reads and writes files in the project directory only, with no commands; `"shell"` can also run commands. Without it, the agent can't be in a `run` or `draw` cell or be named for hands-on work |

Sign-in and keys are handled by opencode itself (for OpenCode Go, sign in first by running `/connect` in opencode); the plugin doesn't touch them. For discussions and reviews the script gives opencode a read-only agent with only the read, search and list tools: it can look through the project's code itself, but can't run commands or change files. For a review of changes (`diff`), the script works out the changes with git and attaches them; for existing files it only gets the paths and reads them itself.

For hands-on work, the injected agent can write files, and at the `shell` level run commands too. opencode has **no OS sandbox**:
- at the `edit` level it can't write outside the project directory and has no tool for running commands;
- at the `shell` level its commands run with your account's permissions and can reach the whole machine.

Both levels take a change snapshot before starting (`--no-snapshot` isn't allowed), and reviewing the diff afterwards is the check.

**`type: "pi cli"`** (the Pi CLI on this machine, npm package `@earendil-works/pi-coding-agent`)

| Field | Meaning |
|---|---|
| `model` | Required, as `provider/model`, such as `deepseek/deepseek-flash`. Anything `pi --list-models` lists works |
| `bin` | Optional; path to the pi executable or its `cli.js`. Found automatically by default |
| `max_parallel` | Optional, default `4` |
| `run_access` | Optional, as for opencode: `"edit"` or `"shell"`, user config only. Without it, the agent can't be in a `run` or `draw` cell or be named for hands-on work |

Sign-in and keys are handled by pi itself (`/login` inside pi, or the provider's API key environment variable); the plugin doesn't touch them. pi has no permission system of its own, so every call from the script:
- enables only the tools the task needs: read, search and list for discussions and reviews; edit and write added for hands-on work at `edit`; running commands added at `shell`;
- injects foreman's guard extension, so file tools can't reach paths outside the project directory (commands at `shell` aren't limited by it);
- doesn't load your installed extensions, skills, prompt templates, MCP servers or the project's `.pi` settings; the project's AGENTS.md / CLAUDE.md are read as usual;
- keeps sessions in pi's default location, so `/resume` inside pi finds them too.

Like opencode it has no OS sandbox, and both levels take a change snapshot before starting.

**`type: "agy cli"`** (Agy CLI on this machine, that is Google Antigravity CLI, command `agy`)

| Field | What it does |
|---|---|
| `model` | Required, the model family, such as `gemini-3.8-flash`. agy puts the effort in the ID suffix (`gemini-3.8-flash-high`); the plugin splits it off for display and adds it back when dispatching, and the level goes in the cell's `effort`. A full ID with no `effort` still works |
| `bin` | Optional, the path to the agy executable. By default it's looked up on PATH, and on Windows also at `%LOCALAPPDATA%\agy\bin\agy.exe` |
| `max_parallel` | Optional, default `2`: the plan quota is counted in 5-hour windows, and many parallel calls tend to hit the limit together |

It can only take part in discussions and reviews: `run_access` isn't accepted, and it can't go into `run` or `draw` cells. agy handles its own sign-in; the plugin doesn't touch it. agy can't load an extension per call, so the plugin controls its tools through agy's global hooks:
- A guard must be installed first (`agy-guard install`; `/foreman-en:setup` asks for the user's consent first): it adds a `foreman-guard` entry to `~/.gemini/config/hooks.json` and writes a launcher and the guard script in the same folder. When no foreman run is active the guard answers `ask`, so the user's own agy use isn't affected;
- A self-check before every dispatch: if the project (from the working directory up to the repository root, plus each `--add-dir`) has agy hooks, MCP or plugin config in `.agents` or a similar folder, or the global `hooks.json` has hooks besides foreman's, agy isn't dispatched and the error names the file; if the guard files don't match the plugin's copy, they're rewritten under a lock;
- The guard allows only file reads (limited to the project directory and `--add-dir` folders) and the task list; when a probe confirms agy's sandbox works on this machine (Windows 11 24H2 or later), read access also allows commands inside the sandbox: they can't change files inside or outside the project or reach the network, but the system temp folder stays writable. Without the sandbox there's no shell, and discussion material gets a `git ls-files` list instead;
- Secret-like environment variables are removed before starting agy; during a run, a launch marker in the foreman state folder makes the guard block tool calls from agy without a policy in that folder; every guard decision goes to `agy-guard.jsonl` in the `run_dir`, and a round that used tools without any decision record fails;
- The user's own GEMINI.md and skills load as usual, and global MCP servers start but their tools are blocked; sessions show up in agy's history.

**`type: "api"`** (models with an OpenAI-compatible API)

| Setting | What it does |
|---|---|
| `base_url` | API address, for example `https://api.deepseek.com`; the script calls `<base_url>/chat/completions` |
| `api_key` | The API key itself. Stored in plain text in the config file and takes effect immediately; only allowed in the user config. An empty `""` means not filled in yet |
| `api_key_env` | Name of the environment variable that holds the API key; after setting it, restart Claude Code so it can see it. If both are set, `api_key` is used; an agent with neither can't take part in discussions or reviews, and listing it in those cells fails at run time |
| `model` | Required, the model |
| `max_parallel` | Optional; `4` by default |
| `extra_body` | Optional parameters merged into the request body as is, for example `{ "max_tokens": 65536 }` |

### What each type can do
`agents_status.<ID>.capabilities` in the `config` output lists what each agent can do, and config checks use it: putting an agent in a cell it can't do is an error.

| | codex cli | opencode cli | pi cli | agy cli | api |
|---|---|---|---|---|---|
| Tasks (`modes`) | hands-on work, reviews, discussions | hands-on work (needs `run_access`), reviews, discussions | hands-on work (needs `run_access`), reviews, discussions | reviews, discussions | discussions, reviews (text material only) |
| Isolation (`isolation`) | OS sandbox (`os`), per the sandbox setting | tool permissions only (`tools`) | tool permissions plus a guard extension (`tools`) | a guard in the global hooks (`tools`); read-only commands in agy's sandbox | none (`none`); text in and out only |
| Reads code itself (`reads_code`) | yes | yes | yes | yes | no; relies on attached files |
| Native report format (`native_schema`) | yes | no; prompt plus one repair | no; same | no; same | no; same |
| Native review (`native_review`) | yes | no | no | no | no |
| Images (`images`) | yes | no | no | no | no |
| Reads images (`reads_images`), which decides who can do a `visual` review | yes (view_image) | no for now (not verified yet) | no for now (not verified yet) | no for now (not verified yet) | no |
| How discussions and reviews stay read-only (the result's `readonly`) | `sandbox` (with a `read-only` sandbox) or `audited` | `tools` | `tools` | `tools` | `tools` |

## modules

Four modules, split by what they deliver:

| Module | Delivers | Cells |
|---|---|---|
| `discuss` | Options and trade-offs for something not decided yet (read-only) | `simple` / `normal` / `complex` |
| `run` | Changes | `simple` / `normal` / `complex` |
| `review` | A list of problems in something that already exists (read-only) | `simple` / `normal` / `complex` |
| `image` | Bitmaps and vector pieces | `generate` (image generation) and `draw` (hand-drawn vectors), no levels |

There is also a level 0 (below the threshold, not worth an outside model), which Claude always does itself and which isn't in the config. Each cell can be:
- `"claude code"` (discuss, run and review only): Claude does hands-on work itself; for reviews and discussions, that cell uses no outside agent.
- A list of candidates: `[{ "agent": "<ID>", "effort": "<effort>", "required": true }, …]`. A single object works the same as a one-item list. Each agent can appear only once per cell.
- `null` (image only): the cell is closed. With generate closed, no images are generated; with draw closed, Claude draws bending pieces and pure vector work itself. Claude can't produce bitmaps, so image cells can't be `"claude code"`.

`discuss` and `review` also take `seats`, how many external models each level uses, with all three levels written in the config file; change the numbers right there. New configs come with it; when a user config lacks some of it, the script fills in the defaults and writes them into the file the first time it reads it. The defaults and rules are under "Candidates and required agents" below.

What can go in a cell is checked against the capability table: discuss candidates must be able to discuss, review candidates to review; run candidates must be able to do hands-on work, and opencode and pi also need `run_access`; generate candidates must be able to generate images (the adapter declares `images` and implements image detection: which images appeared in this round and what each call passed; only codex cli for now); draw takes the same as run.

How image tasks go out: before work starts on each new graphic deliverable, Claude has the user choose the route in a pop-up (① bitmap, ② bitmap + vector mix, ③ pure vector with a reference image first, ④ pure vector / code), then creates a plan with `plan --module image --cell <generate|draw> --route <route number>` and starts it with `image --plan … --seat …`. The route decides which cells are used, and only those cells get plans, so required agents in an unused cell don't come into play (with route ④, for example, the generate cell's required agent isn't needed). The script checks the answer to the latest route pop-up in this session; see "plan, image and status --plan" in `references/cli.md`.

### Candidates and required agents
- When a cell has several candidates, Claude picks by the rules in `references/seats.md` (drop those that can't do it, add every required agent, fill discussion and review seats up to the configured number with different base models, one executor per work package) and says in a sentence whom it picked and why. The script only checks the hard rules a machine can check.
- `seats` (`discuss` and `review` only): the number of external seats at each level, not counting the Claude Code seat or a level 3 review's gap seat. The defaults (the only place in the plugin that states the numbers; other documents point here):

  | | simple | normal | complex |
  |---|---|---|---|
  | `discuss` | 2 | 4 | 8 |
  | `review` | 1 | 2 | 2 |

  Required agents count toward it, so it can't be lower than the cell's required count, or loading the config fails; it can be higher than the number of candidates, which means all of them take part. To always use a fixed set of agents at some level, list only those and set the seats to their number, or mark them all required. When `plan` creates a discussion or review plan, it checks that the external seats equal `min(seats, usable candidates)` (for a `visual` review only candidates that can read images count); otherwise it needs `--count-why "<reason>"`. Usable candidates are counted by agent ID, so one model reached two ways counts twice. When the user config leaves levels out, the first load writes the missing ones into the file with the defaults (never less than the cell's required count, so old configs with many required agents keep working; levels already written stay as they are), backs up the original as `<file name>.bak` (with a time and process ID appended if that backup exists), keeps the file's permissions, and says what it added; if the file can't be written (read-only, for example, or another process holds the rewrite lock for more than 10 seconds), the defaults are filled in memory only and a notice says the file wasn't updated. A wrong `seats` (bad format, fewer than the required count) isn't fixed automatically; loading fails as before. Project configs are never rewritten, and levels they leave out follow the user config. Older plugin versions that don't know `seats` fail on it, so upgrade every computer. The numbers in use are in `resolved_modules.<discuss|review>.seats` of the `config` output.
- `required: true` means this agent must take part whenever the cell is used; without it the entry is an ordinary candidate that Claude may or may not add. One agent may be required in reviews and only a candidate in discussions, so `required` goes on the cell's entry, not on the agent definition.
- To hand one task to several seats, Claude first creates a dispatch plan (`plan`); the script checks that every required agent has a seat and that a discussion or review has as many external seats as `seats` says, and then each seat is started. A single-seat hands-on handoff is refused when the cell has another required agent. Discussions and reviews always use a plan: it comes with the Claude Code seat, which submits its report with `submit` before the external seats can start.
- When a required agent is at its parallel limit, its dispatch command queues for a slot (see the parallel limit below). When a required agent fails, runs out of quota or is cancelled, the task counts as incomplete; another candidate doesn't stand in for it.
- `run`, `generate` and `draw` hand work to one executor at a time, so each of these cells can have at most one required entry.

### Effort
`effort` can be left out, which means the tool's or model's own default. What it takes depends on the type:
- `codex cli`: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Which ones a model supports comes from Codex's own model list (gpt-5.5, for example, goes up to `xhigh`); `check` checks against that list.
- `api`: sent as is as `reasoning_effort` (DeepSeek takes `low` / `high` / `max`), and `null` means don't send it. Use `null` for models with no reasoning effort parameter, such as Xiaomi MiMo (only a thinking on/off switch, on by default).
- `opencode cli`: the model's variant (for example `high`), passed to opencode as `-m model#variant`; `null` means the model's default. Each model has its own variants (the free DeepSeek model, for example, takes `low`, `high` and `max` but not `medium`), and opencode reports an error for a wrong one. `default` is the same as leaving it out. After a change, run `check`: variants missing from opencode's model list are reported at once, and the rest are tried one by one.
- `pi cli`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, passed to pi as `--thinking`. Each model supports its own set (deepseek-flash, for example, takes off / low / high / max), as pi's model list says. **pi doesn't report an unsupported level; it quietly switches to the nearest one** (looking upward first, so it may cost more). Always run `check` after a change; it checks against the list.
- `agy cli`: whichever of `minimal`, `low`, `medium`, `high`, `xhigh`, `max` the model has (`models` lists them; gemini-3.8-flash has low / medium / high), sent to agy as `<model>-<level>`. A model with one level uses it when `effort` is left out, a model with none (such as claude-sonnet-4-6) takes no `effort`, and a model with several needs it, or `check` and dispatch report an error. When `model` is already a full ID with a level, `effort` can't be set too.

When reporting to the user, describe a missing or `null` effort as "effort: default".

Run `models` to see which efforts each model takes: for Codex, opencode and pi it reads their built-in model lists; for API agents it can only list model names, so efforts come from the provider's official docs.

An entry can also set `model` to override the agent's model; old configs that do this still work. It isn't recommended for new configs, because the ID and the model actually used drift apart. To use another model, add another agent.

Built-in defaults: no agents, the nine discuss, run and review cells are `"claude code"`, and both image cells are `null`. The real setup comes from the config generated on first run (below).

## The config generated on first run
When there's no user config, the first run of the script (any subcommand) checks the machine before generating one. The `environment` field in the `config` output shows what it finds. It checks these:
- whether a usable Codex exists: it starts and is signed in;
- whether opencode exists: it starts, and how many models `opencode models` lists;
- whether pi exists: it starts, and how many models `pi --list-models` lists;
- whether agy exists: it starts;
- common API key environment variables: `DEEPSEEK_API_KEY`, `KIMI_API_KEY` / `MOONSHOT_API_KEY`, `MIMO_API_KEY`.

What gets generated (every cell is written as a list of candidates, none required):

| Found | What's generated |
|---|---|
| A usable Codex | Two `codex cli` agents, `gpt-6.1-sol` and `gpt-6-astra`. Hands-on work: Claude does simple and normal, complex goes to gpt-6.1-sol at max. Reviews: gpt-6.1-sol medium / high, complex on gpt-6-astra at max. Discussions: gpt-6.1-sol medium / high, complex on gpt-6-astra at max. Images: generate on gpt-6.1-sol at medium, draw on gpt-6-astra at max |
| No usable Codex | The nine discuss, run and review cells are `"claude code"`, and both image cells are `null` |
| API keys | One `api` agent per provider, with `api_key_env` pointing at the variable found and the model name as its ID, **not added to any cell** |
| opencode, pi, agy | Nothing added; `/foreman-en:setup` helps the user pick a model |

Choices that cost money or affect safety (which opencode or pi model to use, letting API models join discussions, who is required) are never made automatically; `/foreman-en:setup` asks the user. Running setup again later picks up newly installed tools.

## Upgrading an old config
- When upgrading from codex-bridge, the old `~/.claude/codex-bridge.json` is copied to the new location first.
- `dispatch.max_seats` is no longer used; `seats` decides how many agents each level uses. Leaving it in the user config does no harm: it is ignored when the config is read, doesn't show in the `config` output, and the file isn't changed. In a project config it is reported as ignored.
- The first time the script reads a config written with `levels`, it rewrites it as `modules` and backs up the original as `config.json.bak` (with a timestamp added if that already exists):
  - only the structure changes: every cell keeps its agents, efforts and order; single `run` and `review` objects become one-item lists;
  - no entry gets `required`, and no image block is added (run `/foreman-en:setup` to add it when you need it);
  - **behavior change**: the old discussion lists meant "everyone takes part"; after the rewrite they are "candidates Claude picks from". To keep everyone taking part, mark those entries `"required": true`; `/foreman-en:setup` can mark them.
  - Every rewritten file (the older formats below included) keeps `levels` as a one-line note (before `modules`); don't delete it. An old version of the plugin only knows `levels`, and reading a config with only `modules` doesn't fail there: it quietly has Claude do every task itself. With the note in place, the old version stops with an error ("Invalid config levels: must be an object"), reminding you to update. The new version skips the note and doesn't treat it as "both levels and modules".
- Older formats are converted in the same pass, with one write and one backup:
  - `type`: `codex` → `codex cli`, `opencode` → `opencode cli`, `openai-compatible` → `api`;
  - `"claude"` in cells → `"claude code"`;
  - agent IDs are renamed after their models, for example `codex` → `gpt-6-astra` and `deepseek` → `deepseek-flash`, and references in the cells (image cells included) are updated too;
  - an entry that overrode the model is split out into its own agent;
  - formats from before 0.10, such as `auto_dispatch` or top-level `model` and `sandbox`.
- The model and effort each cell actually uses stay the same.
- The old-to-new ID mapping is kept in `~/.claude/foreman/agent-aliases.json`. Resuming an old run, an old ID passed to `--agent`, and old IDs in a project config are all mapped to the new ID automatically.
- A file with both `levels` (an object) and `modules` is an error; the script doesn't guess which one counts. The note above doesn't count. `levels` in a project config isn't rewritten on disk; it's read as `modules` in memory, with a notice suggesting the new format. An old version of the plugin ignores `modules` in a project config, so a project that must also constrain people still on the old plugin can keep the `levels` form in its project config.

## Project config: can only tighten
- A project config only accepts `timeout_min`, `stall_min`, `busy_ask_min` under `dispatch`, plus `modules` (including `seats` under `discuss` and `review`; the old `levels` form is accepted too). Anything else, including the whole `agents` block, is ignored with a notice.
- Time and seat limits take the stricter value: `timeout_min` and each level's `seats` take the smaller one (lowering `seats` below the cell's required count is an error); for `stall_min` and `busy_ask_min`, 0 means no check, which is the loosest, so a project 0 has no effect when the user set a positive number, and when both are positive the smaller one wins.
- `modules` can contain just the cells to change. Each cell can only:
  - be closed as a whole: `"claude code"` for discuss, run and review, `null` for image;
  - drop some optional entries the user config already has in that cell (the user config's order is kept);
  - lower the effort, only for tools whose efforts have a clear order: Codex is low < medium < high < xhigh < max < ultra, pi is off < minimal < low < medium < high < xhigh < max, agy is minimal < low < medium < high < xhigh < max. opencode variants and api efforts have no common order, so a project can't change them; nor can it add an effort to an entry that has none in the user config.
- It can't add entries, swap agents or models, change `required`, or open a cell the user closed; those are ignored with a notice.
- It can't drop only the required agents while keeping others handing work out: that's an error; keep the required agents or close the whole cell. Dropping every candidate is an error too.
- Once a project writes `"claude code"` (or `null`) for a cell, nothing at that cell can be named with `--agent` in that project, even if the cell is already `"claude code"` in the user config; cells the project doesn't mention that are `"claude code"` in the user config can still be named. If the cell has required agents, that step counts as "not done", and Claude says so plainly instead of reviewing it itself and calling the requirement met. With `--cwd`, `closed_by_project` in the `config` output lists the cells a project closed.
- This way a cloned repository can't use its project config to swap the agent doing the work (say, from a sandboxed Codex to a tool without a sandbox), send your code to a new provider, skip a required review, or stretch time limits and raise efforts to spend more of your quota. For a sensitive project, drop the api candidates, or set discussions and reviews to `"claude code"` as a whole.

## Other rules
- Each agent's parallel limit counts its own running runs across all groups and sessions; at the limit, a dispatch queues in arrival order by default: it takes a ticket under `.state/queue/<agent>/` in the runs folder, checks once a second, and starts when it is first in line and a slot is free; stderr shows its place in line and the minutes it may still wait. `--queue-timeout <minutes>` changes the longest wait (60 by default, 1440 at most); 0 doesn't queue and refuses right away, listing the runs holding the slots. A queued process that ends removes its ticket; a ticket left by a killed process is reclaimed by the next checker once its process is gone or the ticket has expired. `status` lists the queued tickets. A dispatch plan itself holds no slot.
- Runs in the same group must not have overlapping write scopes; this only applies to runs that write files (hands-on work), not to discussions and reviews.
- When the sandbox isn't `read-only` / `workspace-write` (for example `danger-full-access`), Codex can write to any directory: `--cwd` only sets where it starts and **doesn't limit what it can write**. The scope is then held only by the brief and by reviewing the diff afterwards.
- After the user changes settings, run `config` to confirm:
  - `resolved_modules` shows each cell's final candidates, with each one's model, effort and whether it's required;
  - `closed_by_project` lists the cells closed by the project config (with `--cwd`);
  - `image_configured` says whether the user config has an image block: when it's `false`, the `null` image cells are just defaults, not something the user turned off;
  - `agents_status` shows each agent's type and capabilities, whether its key is set, and the executable it uses;
  - `summary` is the overview of the whole config: who each cell goes to, the cells each agent is used in, and warnings (unused agents, plaintext keys, shell access for hands-on work or drawing, old IDs in `agent-aliases.json` that point to IDs no longer there). `check` outputs it too, with check results.

## Passing on what the script prints about the config
- When the script prints "First run: created config file", pass on what it found (Codex, opencode, pi, API keys) and who now gets each kind of task, and suggest running `/foreman-en:setup` to choose models.
- When the script prints that it rewrote the config file in the new format, tell the user: the config uses the new format (`type` is now `codex cli` / `opencode cli` / `api`, `"claude"` is now `"claude code"`), agent IDs were renamed after their models (pass on the list the script printed), the models and efforts actually used are unchanged, and where the original was backed up.
- When the script prints that it rewrote levels as modules in the config file, tell the user: the config now uses `modules`, and every cell keeps its agents, efforts and order; one behavior change: the agents at a discussion level used to all take part, and now they are candidates Claude picks from, so to keep everyone taking part, mark them `"required": true`; the config has no image cells yet; `levels` is kept in the file as a one-line note, so an old version of the plugin stops with an error instead of quietly having Claude do everything; and where the original was backed up. Suggest running `/foreman-en:setup` to mark required agents and add the two image cells. Keep that `levels` note when editing the config.
- **Codex's read-only sandbox on Windows**: the default elevated sandbox may fail to start even file-reading commands in `read-only` mode. Before setting `read-only` for discussions and reviews, run `check`: if the sandbox won't start, follow its `fix` and set `sandbox = "unelevated"` under `[windows]` in `~/.codex/config.toml`. Without a read-only sandbox (`readonly` is `audited`), read-only is held by the rules and a snapshot comparison afterwards, and any write marks the run failed; see "Read-only" in `references/review.md`.
- When the user wants to change settings, edit the relevant JSON file, then run `config` to confirm.
