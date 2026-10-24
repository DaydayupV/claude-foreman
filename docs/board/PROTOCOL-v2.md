# Board protocol v2: additions to PROTOCOL.md

Everything in PROTOCOL.md still holds unless a section here replaces it. `hello.v` becomes 2.

## 1. The Claude Code lane

The board shows the Claude Code session that dispatched the runs as one more lane, with lane id `cc`.

### Finding the transcript

- `--transcript <file>`: use that JSONL file.
- Otherwise `--session <id>`: the first match of `<claude-dir>/*/<id>.jsonl`.
- Otherwise `meta.claude_session` of the newest run in the scope, looked up the same way.
- Otherwise (live recent scope only) the most recently modified `*.jsonl` directly under any `<claude-dir>/*/`.
- `<claude-dir>` is `--claude-dir`, else `~/.claude/projects`.
- No transcript found: there is no `cc` lane; everything else works as before.

### Time window

- **replay and group/run scopes:** entries from (earliest `started_at` of the scope's runs − `--lead` minutes, default 10) to (latest end + `--tail` minutes, default 5).
- **live recent scope:** entries from the last 30 minutes, then everything appended.
- The transcript is read in place and never copied. Live: tail it like events.jsonl, using the same offset, decoder and partial-line rules.

### `run` message for the lane

Sent on connect, and again whenever its totals change. Live updates are coalesced to at most one per second.

```
{ "id": "cc", "lane": "cc", "kind": "host", "agent": "claude code", "agent_type": "host",
  "model": <message.model of the latest assistant entry>, "session": <session id>,
  "title": <latest `custom-title` entry's title, else null>, "cwd": <latest entry's cwd>,
  "status": "running" | "idle",            // live: idle after 90 s without a new entry; replay: running until the window end
  "started_at": <first entry in the window>, "ended_at": null,
  "usage": { "input", "cached", "cache_write", "output" },   // sums over the window, see §3
  "cost_usd": <number|null>, "cost_source": "api_price" | "unknown" }
```

### Events (`ev` with `lane: "cc"`, `run: "cc"`)

Read from transcript entries in file order:
- `ts` is the entry's `timestamp`.
- Skip entries with `isSidechain: true`, which belong to subagents.
- Skip entry types other than `user` and `assistant`.

| `k` | Source | Fields |
|---|---|---|
| `prompt` | `user` entry whose `message.content` is a string, or has a `text` block, and is not only tool results. Skip text that starts with `<` and is a system or command wrapper (`<system-reminder>`, `<command-`, `<local-command`, `<task-notification>`). | `t`: first non-empty line |
| `think` | assistant `thinking` block | `t`: first non-empty line, when the text is not empty |
| `msg` | assistant `text` block | `t`: first non-empty line |
| `read` | `tool_use` Read / NotebookRead | `t`: path (see Paths) |
| `search` | `tool_use` Grep / Glob | `t`: `pattern` |
| `web` | `tool_use` WebSearch (`t`: `query`) / WebFetch (`t`: `url` without the scheme) | |
| `edit` | `tool_use` Edit / MultiEdit / NotebookEdit (`update`) / Write (`write`) | `t`: `<kind> <path>` |
| `cmd` | `tool_use` Bash / PowerShell that is not a dispatch or collect (below) | `t`: the command, one line, via `plainCommand`; `aid`: `tool_use.id` (string, when available) |
| `cmd_done` | `tool_result` answering a `cmd` (matched by `tool_use_id`) | `ok`: `!is_error`; `aid`: the matching `cmd`'s `aid`, when available |
| `dispatch` | Bash / PowerShell whose command runs foreman's `cli.mjs` with subcommand `run`, `discuss`, `review`, `resume`, `image`, `plan` or `submit` | `t`: `<subcommand> <title or plan/seat/run>`; `target` (see Linking) |
| `collect` | Claude Code reading results: a Read whose path is inside the runs directory, or `cli.mjs status` / `watch` / `stats` / `judge` | `t`: short label; `target` (see Linking) |
| `tool` | any other `tool_use` | `t`: tool name with a leading `mcp__<server>__` removed |
| `usage` | assistant message, once per `message.id`, at the timestamp of its last entry, using that entry's `usage` | `n`: output tokens, `t`: model, `u` (§3) |

**Paths:** paths inside the lane's `cwd` are made relative to it. Other paths stay absolute with `\` turned into `/`. Every path is cut to its last 120 characters.

### Linking (`target`)

`target` is an array of lane ids, or absent.

**Recognising a dispatch.** The command contains `cli.mjs` (optionally followed by a closing quote), then whitespace, then one of the subcommands. Regex: `/cli\.mjs["']?\s+(run|discuss|review|resume|image|plan|submit)\b/`. The command often starts with a variable assignment and the path is quoted, for example:
`S="C:/…/scratchpad/roles"; node "C:/…/skills/dispatch/scripts/cli.mjs" discuss --cwd "$S/pack" --brief "$S/pack/议题.md" --title "…" --level normal --agent gemini-4-argon-contributor --group skills-roles-1018`

**`dispatch` targets:**
- `--plan P --seat S`: the lane of the run with `meta.plan === P && meta.seat === S` that started within 120 s after the event.
- `resume --run R`: R's lane.
- `run` / `discuss` / `review` / `image` without a plan: the first run that started within 30 s after the event, isn't linked yet, and has `meta.mode` equal to the subcommand. If the command has `--agent A`, prefer a run with `meta.agent === A`.
- `plan` / `submit`: no target.

**Background tasks.** Claude Code usually runs dispatches in the background and later reads their output. When a dispatch's `tool_result` text matches `/running in background with ID: (\w+)/`, remember that task id → the dispatch's target lanes.

**`collect` targets.** Any later `tool_use` counts as a `collect` (instead of `cmd`, `read` and so on) when its input contains, anywhere in its string values:
- a remembered background task id;
- a run id of a run in the scope (`/\d{8}-\d{6}-[a-z0-9]{4}/`, for example inside `…/foreman/runs/<run_id>/…`);
- `cli.mjs` followed by `status`, `watch`, `stats` or `judge`.

Its `target` is the union of the lanes those ids give. For `status`/`watch`/`judge` with `--group G` or `--plan P`, it is every scope lane in that group or plan. With none of those, `target` is absent. Real examples: a `cat`/Python script over `tasks/<taskid>.output` for five task ids (target = five lanes), or `Read` of `…/tasks/<taskid>.output`.

**`returned`** (new `k`). A `user` entry whose text contains `<task-notification>` with `<task-id>X</task-id>`, where X is a remembered dispatch task id. `t`: the `<status>` value, `target`: that dispatch's lanes. This is the moment a seat's result reaches Claude Code. It is not a `prompt`.

**Unresolved targets.** A target lane that isn't on the board is dropped. In live mode, a link is resolved when the target run appears. Until then the event goes out without `target`, and it is re-sent once as `ev_link` `{ run: "cc", ts, k, target }` when the link resolves.

### Claude Code's own seat answers

Runs with `meta.participant === 'host'`, which `submit` writes, belong to lane `cc`. They get an ordinary `run` message with `kind: "answer"`, `lane: "cc"`, and `report_head` (§4). They never count as running.

## 2. Event additions for every lane

- `cmd` and `cmd_done` carry the same optional string `aid`, scoped to their `run`: the item's `id` for Codex and the adapted opencode/pi events, or `tool_use.id` for Claude Code. Paired `read`/`search` item events also retain it. Omit `aid` when no id is available; the page then keeps the legacy pairing with the most recent command.
- `usage` events carry `u: { "in", "cached", "cache_write", "out" }` whenever the source has those numbers. See §3 for what they mean; a missing number is `null`.
- `think` and `answer` events from streaming sources keep `n` as the running character total. The page turns it into an estimate at about 4 characters per token.

## 3. Usage and cost

`u.in` is input tokens that were not read from cache. `u.cached` is cache reads. `u.cache_write` is cache creation. `u.out` is output, reasoning included.
- **Claude transcript:** `in = input_tokens`, `cached = cache_read_input_tokens`, `cache_write = cache_creation_input_tokens`, `out = output_tokens`.
- **Codex / opencode / pi / API `result.json` `usage`:** `input_tokens` includes the cached reads and the cache writes, so `in = input_tokens − cached_input_tokens − cache_write_input_tokens`, `cached = cached_input_tokens`, `cache_write = cache_write_input_tokens` (opencode, pi and API runs record it when the provider reports cache writes; Codex records 0), `out = output_tokens`.

The `run.usage` object uses the same four names (`input`, `cached`, `cache_write`, `output`) with the same meanings. This replaces v1's `{ input, cached, output }`.

**Cost:**
- Every run is priced at the model's official API price from `prices.json` (`cost_source: "api_price"`), whatever the tool reported; a tool's own figure is kept only as `reported_cost_usd` in `result.json`. The price is `(in·input + cached·cached + cache_write·cache_write + out·output) / 1e6`, each rate in USD per million tokens. A missing `cache_write` rate falls back to `input`, and a missing `cached` rate falls back to `input`.
- A model with no price entry: `cost_usd: null`, `cost_source: "unknown"`.

`prices.json`:

```
{ "as_of": "YYYY-MM-DD",
  "models": [ { "match": ["claude-opus-5"], "input": 0, "cached": 0, "cache_write": 0, "output": 0, "source": "<where the numbers come from>" } ] }
```

- The first entry with any `match` string contained in the lower-cased model name wins.
- The model name has any `provider/` prefix stripped before matching.
- The file is read at startup.

## 4. Run message additions

- `report_head`: the first 160 characters of the run's result:
  - discussion: `report.position`, else the first line of `last_message`;
  - review: `<verdict> · <n> findings`;
  - exec and image: `report.summary`, else the first line of `last_message`;
  - otherwise null.
- `changed`: up to 40 files from `result.json` `changes.files`, as `[{ "path", "kind", "added", "removed" }]`, using whichever of those fields the record has.
- `cost_source`, as in §3.
- `usage_scope`: copied from `result.json` when the record has it. A Codex resume whose usage is the session's running total (`session_total`) is turned into this round's increment before it is sent: the server subtracts the previous round's total along the resume chain (adding up `this_run` rounds back to the root, or stopping at an earlier `session_total`), and then sends `usage_scope: "this_run"`. A root round with a session total counts from zero. When the baseline can't be worked out (a missing ancestor, another session, a total that went down), `usage` is `null` and `usage_unattributed: true`; the page shows "—" for that run's input, output and average, with a hover note.
- `display`: what the shared display rules (`scripts/display.mjs`) need to draw the same seat block as `foreman watch`. `null` while the run has no result. Fields:
  - `status`, `valid`, `needs_decision`, `stale`, `duration_s`, `native_review`, `review_target`;
  - `report`: `status`, `position`, `summary`, `verdict`, `findings` (`id`, `severity`, `location`, `issue`), `decision_requests` (`source`, `question`, `why_it_matters`, `recommendation`, `options`), `open_issues`, `open_questions`, `unverified`;
  - `questions` (same shape as `decision_requests`), `errors` (with transient reconnect notes left out for runs that finished normally, as in the terminal);
  - `usage` (the four `result.json` token fields as recorded), `usage_scope`, `last_request` (`tokens`, `window`), `output_tokens_per_s`, `cost_usd`, `cost_source`;
  - `changes`: `available`, `files_total`, `agent_total`, `reported_total`, `unknown_total`, `group_total`;
  - `last_message`.
  Every text is cut at 4000 characters and every list at 30 items.
- `display_round`: the round number, counting resumes back along the chain (execution and image resumes have no `round` of their own).
- `module`, `participant`, `submitted_at`, `author`, `model_name`, `display_model`, `cell`, `route`: copied from the record, for the same seat lines as the terminal.
- `dispatch_queue`: dispatches of the same group and conversation that are still waiting for a slot (`agent`, `title`, `plan`, `seat`, `queued_at`, `position`), at most 30. They have no run yet, so they have no seat number.

The terminal live views and the web board's terminal section draw seat blocks with the same functions from `scripts/display.mjs`; `board/build.mjs` inlines that file into the page as a `Display` object. Labels in that section are English in both plugins, like the terminal.

## 5. Rates

The board and `foreman` show two different speeds. They are measured differently and can't be compared with each other.

- **Run average** (`output_tokens_per_s` in `result.json` and `stats`, `run avg N tok/s` in the terminal): this round's output tokens (reasoning included) divided by its `duration_s`, which includes snapshots, commands, waiting for the provider and report repair requests, but not time spent queueing locally for a slot. Cancelled, timed-out and stalled rounds only count requests that finished, so they are marked `(partial usage)`.
- **Board estimates** (cards `now ≈ N tok/s · gen avg ≈ M`, table columns `now ≈tok/s`, `last 2 min`, `gen avg ≈tok/s`), built from output segments:
  - A `usage` event covers the time since the previous usage event of the same run (or the run's start). `step.usage` events carry one request's usage; `end` marks the last one of a turn; a turn total (`tot`) only fills what per-request usage didn't cover. opencode's final request often has no `step_finish`, so after its session export the adapter sends the rest as one more `step.usage` with `usage_from` and `usage_to` giving the interval it covers.
  - Between usage events, `think` and `answer` character counts are turned into tokens at 4 characters per token.
  - Recognised command periods (Codex command events) are taken out of the generation time. opencode and pi have no command start events, so their tool time can't be taken out.
  - A single gap counts as generation time for at most 5 minutes.
  - `now`: an estimate over the last 10 seconds; it may borrow earlier samples of the same model. `last 2 min`: a curve of 40 points, each one the output in about 6 seconds divided by that time. `gen avg`: the seat's total output divided by its estimated generation time.
- **Completeness:** the page keeps statistics events (no text, up to 20000 per lane) apart from the 600-event display cache, and the server sends that compact history as `rate_events` with every snapshot, first connect, reconnect and backlog reset. When a finished run's segments don't add up to its final output (within a relative tolerance), its average shows "—" instead of a wrong number. The Claude Code lane is exempt, because its usage comes from the transcript's messages.
- **Replays:** a replay still plays on the compressed clock (`maxgap`), but every replayed message keeps its record times as `original_ts`, `original_started_at` and `original_ended_at`, and `hello.replay.time_map` maps play time back to record time. Speeds, generation time, durations and the clock use record time, so a replay shows the same numbers as the live board whatever `--maxgap` and `--speed` are. The replay top-up (final output minus what the segments counted) only goes into the part of the run's time that no segment covers.
