# Script reference: check, models and result fields

SKILL.md keeps only the decision process and the common commands. Read this when troubleshooting the environment, helping the user pick models, or looking up what a field in the result JSON means.

## check
Tests whether the environment works: Node.js, Git, and every agent in the config, with results under `agents.<ID>`.
- **Codex CLI**: whether it starts and is signed in; then the efforts the levels configure are checked against Codex's own model list (no requests sent), with results under `efforts`; and for each sandbox mode the task types actually use, `codex sandbox` runs an echo inside the sandbox (no model call), with results under `sandbox`; `danger-full-access` doesn't use a sandbox and isn't tested. When the sandbox won't start on Windows, it also tries the unelevated sandbox and says so in `fix` when that works.
- **API**: whether the key is set, plus a tiny request to confirm it connects.
- **opencode**: whether it starts, whether `opencode models` lists the model, plus a tiny request to confirm it works; each reasoning effort (variant) the levels configure for it is first checked against opencode's model list, failing at once if it isn't there, and every other one gets one more tiny request; results are under `variants`.
- **pi**: whether it starts, whether its model list has the model, plus a tiny request to confirm it works; efforts are only checked against the model list (pi doesn't report an unsupported level; it quietly switches to the nearest one, so a request can't reveal it), with results under `efforts`.

The overall `ok` only counts Node.js and the agents the levels use; a failure in an unused agent is reported but doesn't block anything. For each failed item, `fix` in the result says what to do; pass it on to the user.

`summary` in the result is the overview of the whole config: `levels` gives each cell's agent, model, effort and whether it passed (with a `problem` if not), `agents` gives the cells each agent is used in, and `warnings` lists things worth noting (unused agents, keys written in plain text in the config, shell access for hands-on work, stale old IDs). After `check`, tell the user with a level table and the warnings, as in the last step of `/foreman-en:setup`. `config` also outputs `summary`, without check results.

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
- `agent`, `model_shown`, `effort`: which agent this call went to, and the model and effort actually used. Discussion results from API, opencode and pi agents have no change tracking (`changes.available` is `false`); for API agents `files` lists the files that were attached, and opencode and pi agents add `cost_usd`.
- `isolation`, `run_access`: for hands-on work by opencode or pi, these say there's no OS sandbox (`tools`) and which access level was used.
- `generated_images`: the original files of the images that appeared in the Codex image folder during this round.
- `image_calls`: the arguments and outcome of each image call in this round, read from the Codex session log: `transparent_background`, `referenced_image_paths` (null when not passed; "unknown" when passed through a variable that can't be read, or when several calls can't be matched to their images), `num_last_images_to_include` (can also be "unknown"), `status` ("not_run" for a call written in the code that never ran), `saved_path`, `failure`. When the brief mentions `referenced_image_paths` but none of the calls in this round passed reference images, `warnings` says so.
- `review_scope`: a review's scope, file count and fingerprint.
