# Script reference: check, models and result fields

SKILL.md keeps only the decision process and the common commands. Read this when troubleshooting the environment, helping the user pick models, or looking up what a field in the result JSON means.

## check
Tests whether the environment works: Node.js, Git, and every agent in the config, with results under `agents.<ID>`.
- **Codex CLI**: whether it starts and is signed in; then the efforts the cells configure are checked against Codex's own model list (no requests sent), with results under `efforts`; and for each sandbox mode the task types actually use, `codex sandbox` runs an echo inside the sandbox (no model call), with results under `sandbox`; `danger-full-access` doesn't use a sandbox and isn't tested. When the sandbox won't start on Windows, it also tries the unelevated sandbox and says so in `fix` when that works.
- **API**: whether the key is set, plus a tiny request to confirm it connects.
- **opencode**: whether it starts, whether `opencode models` lists the model, plus a tiny request to confirm it works; each reasoning effort (variant) the cells configure for it is first checked against opencode's model list, failing at once if it isn't there, and every other one gets one more tiny request; results are under `variants`.
- **pi**: whether it starts, whether its model list has the model, plus a tiny request to confirm it works; efforts are only checked against the model list (pi doesn't report an unsupported level; it quietly switches to the nearest one, so a request can't reveal it), with results under `efforts`.

The overall `ok` only counts Node.js and the agents the cells use (image cells included); a failure in an unused agent is reported but doesn't block anything. For each failed item, `fix` in the result says what to do; pass it on to the user.

`summary` in the result is the overview of the whole config: `modules` gives each cell's candidates with their model, effort, whether they're required (`required`) and whether they passed (with a `problem` if not), `agents` gives the cells each agent is used in (`used_at` is written `modules.<module>.<cell>[index]`), and `warnings` lists things worth noting (unused agents, keys written in plain text in the config, shell access for hands-on work or drawing, stale old IDs). After `check`, tell the user with a table of cells and the warnings, as in the last step of `/foreman-en:setup`. `config` also outputs `summary`, without check results.

## plan and status --plan
To hand one task to several seats, create a dispatch plan first:

```bash
node "<script path>" plan --cwd "<project dir>" --module <discuss|run|review> --cell <simple|normal|complex> --group <name> --seat "<agent>[=<role>]" [--seat …] [--why "<reasons>"]
```

- Every check runs before any request goes out: the cell is open (not `"claude code"`); every seat is one of the cell's candidates (old IDs are mapped to new ones); every required agent has a seat; hands-on seats can do hands-on work; the seats don't exceed `dispatch.max_seats`. The image module can't have plans in this version.
- Once it passes, the plan is written to `plans/<plan_id>.json` in the run directory and printed: `plan_id`, `module`, `cell`, `group`, `seats` (each seat's number `seat`, `agent`, `role`, `model`, `effort`, `required`), `required`, `why`, plus `file` (the plan file) and `commands` (the start command for each seat; replace the placeholders for the brief, title and scope with the real ones).
- Start each seat with `run / discuss / review --plan <plan_id> --seat <n> --brief …`: the agent, effort, directory, level and group all come from the plan, and `--agent` isn't allowed; add `--effort` to change the effort or `--model` to change the model (same rules as a single-seat handoff); hands-on seats still need `--scope`. At start the whole plan is checked again against the current config, so a changed config (including a changed model or effort for that seat), changed required agents or a cell the project closed means it's refused, and you create a new plan. Each seat can be started only once; rework uses `resume`, which keeps the plan and seat, and a seat from a plan can't change level on resume.
- A plan takes no parallel slot; each seat counts against its agent's limit as usual when it starts.
- `status --plan <plan_id>` prints JSON: for each seat its `run_id` (the latest round), `runs` (all its rounds), `status` (`not_started` if never started) and `ok` (only once it has ended: it finished normally and returned a valid result); `state` is `complete` (every required seat returned a valid result; with no required seats, every seat has ended and at least one is valid), `incomplete` (a required seat ended without a valid result, for example failed, cancelled, out of quota or waiting for an answer) or `pending`; `missing_required` lists the required seats with no valid result yet and their status.

## models
Lists the model lists built into the local Codex, opencode and pi (with the efforts each model supports) and the model names each API agent's endpoint lists (without efforts), and checks whether the configured models are listed, suggesting the closest names when not. Read-only; it sends no model requests. Use it when the user asks which models are available, or wants to change a model or effort.

## Result fields
The results of `run`, `resume`, `discuss` and `review` are printed to stdout as JSON. The main fields:
- `report`: the agent's structured report. Reviews have no structured report: `report` is `null` and the findings are the text in `last_message`. When the report from hands-on work or a discussion isn't valid JSON, there's only `last_message` too.
- `last_message`: when there's no `report`, the text of the agent's last reply, cut to the first 8000 characters; the full text is in `run_dir/last-message.txt`.
- `changes`: changes inside the working directory, as tracked by the script. Each file has `by`: `agent` means a tool event shows the agent doing the work changed it (records from before the rename say `codex`); `reported` means only its report claims the change, which is common for files written by commands or scripts; `unknown` means it isn't known who did. Files marked `group_run` are inside the write scope of another run in the same group.
- `notes`: informational messages, such as changes of unknown origin, files the agent reported but tracking didn't see, or Codex's sandbox being unable to start commands.
- `warnings`: problems to look at, such as files changed during a discussion or review, or changes that moved while a review ran.
- `questions` and `needs_decision`: things the agent needs answered; see "When an agent needs an answer" in SKILL.md.
- `session_id`, `run_dir`: the full diff is in `run_dir/diff.patch`, and a review's patch in `run_dir/review.patch`.
- Token use: `usage` is this call's input, cached and output tokens (when `usage_scope` is `session_total`, it's the whole session's total); `last_request` is the size of the latest request and the model's context window; `rate_limit` is how much of the Codex quota is used; `quota_resets_at` is when the quota is expected to reset.
- `agent`, `model_shown`, `effort`: which agent this call went to, and the model and effort actually used. `model_overridden` is `true` when `--model` changed the model this time; `outside_cell` is `true` when the cell is `"claude code"` and the call named an agent with `--agent`.
- `module`, `cell`, `plan`, `seat`, `role`: the module and cell this call belongs to; for a call started from a plan, also the plan's `plan_id`, the seat number and the role (`null` when not started from a plan). Discussion results from API, opencode and pi agents have no change tracking (`changes.available` is `false`); for API agents `files` lists the files that were attached, and opencode and pi agents add `cost_usd`.
- `isolation`, `run_access`: for hands-on work by opencode or pi, these say there's no OS sandbox (`tools`) and which access level was used.
- `generated_images`: the original files of the images that appeared in the Codex image folder during this round.
- `image_calls`: the arguments and outcome of each image call in this round, read from the Codex session log: `transparent_background`, `referenced_image_paths` (null when not passed; "unknown" when passed through a variable that can't be read, or when several calls can't be matched to their images), `num_last_images_to_include` (can also be "unknown"), `status` ("not_run" for a call written in the code that never ran), `saved_path`, `failure`. When the brief mentions `referenced_image_paths` but none of the calls in this round passed reference images, `warnings` says so.
- `review_scope`: a review's scope, file count and fingerprint.
