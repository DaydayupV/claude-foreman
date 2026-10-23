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
| `cmd` | `tool_use` Bash / PowerShell that is not a dispatch or collect (below) | `t`: the command, one line, via `plainCommand` |
| `cmd_done` | `tool_result` answering a `cmd` (matched by `tool_use_id`) | `ok`: `!is_error` |
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
