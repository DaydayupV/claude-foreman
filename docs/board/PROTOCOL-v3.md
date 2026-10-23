# Board protocol v3: every Claude Code conversation on this machine

Everything in PROTOCOL.md and PROTOCOL-v2.md still holds unless a section here replaces it. `hello.v` becomes 3.

v2 shows one conversation. v3 adds a second level above it: a summary of every recent conversation (the "universe"), and the agents' parallel slots across all of them. The detailed stream stays as it is and is now opened per conversation.

## 1. Starting

```
node server.mjs [--runs <dir>] [--claude-dir <dir>] [--config <file>] [--window-h <hours>] [--port <n>] [--idle-min <m>]
node server.mjs --replay <conversation | run id | group | all> [--speed <N>] [--maxgap <sec>] [--idle-min <m>] …
```

- `--window-h`: how far back a conversation's last activity may be and still be listed. Default 24.
- `--config`: foreman's config file, default `~/.claude/foreman/config.json`. Only `agents.<id>.type` and `agents.<id>.max_parallel` are read from it (see §6). Nothing else from that file, keys included, ever reaches the page.
- There is one front end: every printed address opens the universe (`level=all`). `--group` / `--run` only add a conversation to fly into once the page is open.
- **Live server** (no `--replay`): the shared board, one per machine, holding `board.lock.json`. It is live only: `stream`, `snapshot` and `sessions` answer 400 to any `replay` or `from` parameter, so no request can make it build a replay.
- **Debug replay server** (`--replay`, started by `board --replay`): a separate short-lived process. It never reads or writes `board.lock.json` or `board.err`, picks a random port and token, and exits after `--idle-min` minutes (default 10) without connections, also when nobody ever connected.
  - The target resolves to conversations from run `meta.json`: a run id gives the conversation that dispatched it; a group gives every conversation with a run in that group; anything else is a conversation id. Only conversations whose transcript file still exists are kept (a replay is built from transcripts); none left is `NOT_FOUND`. `all` is every conversation within the window, up to the 200 limit of §3.
  - It builds the replay once, before it listens: `universe.replay({ speed, maxgap, sessions })`, plus every conversation's detail. The size of everything the build will read is added up first: the transcripts, each selected run's `meta.json`, `result.json`, `events.jsonl` and `verdict.json`, and the plans those runs belong to. Above 256 MiB the build is refused (`REPLAY_TOO_LARGE`) before any transcript, result, event, verdict or plan file is opened; only run `meta.json` files and file sizes have been read by then.
  - It also serves the v2 single-scope replays, `stream` / `snapshot` with `replay=<group or run id>` (and their own `speed`, `maxgap`), built on first request and cached; a scope with no runs is 404. The front-end demo uses these (§10).
  - It then writes one JSON line to stdout: `{"url": "…?level=all&replay=all&lang=…[&s=<id>]"}`. `s` is added only when the target is a single conversation. A failure writes `{"error", "code", "bytes", "limit"}` instead and exits 1.
  - It serves only `replay=all` requests (others 400), and 404 for conversations outside the replay.
- The page learns which server it talks to from `window.__BOARD_MODE__` (`'live'` or `'replay'`), substituted into `index.html` like `__LANG__`.
- Old links: on the live server, a `replay` / `from` in the address is dropped before connecting, and a one-line notice says replay is a debugging tool (`board --replay`).
  - A `group`, `run` or `replay=<id>` value is resolved once through `snapshot?run=<id>` (values shaped like a run id) or `snapshot?group=<id>`, and the page flies into the matching conversation: the run's own conversation, or the latest run's conversation for a group.
  - A value with no runs is taken as a conversation id; `replay=all` resolves nothing, while `group=all` is an ordinary group name.
  - Any click, wheel or key before the answer arrives cancels the fly-in. After flying in, the address keeps only `s` (old scope parameters are removed, `replay=all` stays on the replay server).
  - When the conversation is not on the map 2 s after the first universe arrives (outside the window or the 200 limit), a notice says so and the page stays on the universe.

## 2. Routes (all under `/<token>/`, security rules unchanged)

| Route | Answer |
|---|---|
| `GET /sessions[?replay=all&t=<sec>]` | One JSON object, the universe: `{ "v": 3, "now", "window_h", "projects": [project…], "sessions": [summary…], "agents": [agent…] }`. With `replay=all` (replay server only), the state at replay time `t` (§8). |
| `GET /stream?level=all[&replay=all]` | Server-sent events for the universe (§7). `replay=all` only on the replay server. |
| `GET /stream?session=<id>[&replay=all&from=]` | The detailed v2 stream for one conversation (§9). |
| `GET /snapshot?session=<id>[&replay=all&t=]` | v1 snapshot, for the same scope. The live server also answers `snapshot?group=` / `snapshot?run=`, which the page uses once to resolve old links (§1). |
| `GET /image?run=<run id>&n=<index>` | The `n`-th image of that run (§11). |
| `GET /health` | `{ ok, v: 1, pid, build }`; the replay server adds `sessions`, the number of conversations in its replay. |

## 3. Conversation index

- **Which files.** Every `<claude-dir>/<folder>/<id>.jsonl` directly inside a project folder is one conversation, with `id` = the file name without `.jsonl`. Files in deeper folders (subagents) are skipped.
- **Window.** Files whose mtime is older than `window_h` are not read. They are only counted per project as `older` (§4).
- **Limit.** At most 200 conversations, newest `last_at` first.
- **Reading.** Each file is read once from the start, then tailed like events.jsonl (offset, streaming UTF-8 decoder, partial last line held back). For a conversation that is not opened in detail, keep only the running summary state, not the entries.
- **Entries used.** Same as v2: `user` and `assistant` entries without `isSidechain: true`, plus `custom-title` entries.
- **A new file** appearing in a project folder is picked up within 2 s.
- **Removal.** A conversation whose file disappears, or whose `last_at` falls out of the window, is removed (§7 `session_gone`).

## 4. Project

```
{ "key", "cwd", "name", "older": <number of conversations of this project outside the window> }
```

- A conversation belongs to the folder it started in: its earliest entry's `cwd`. Later entries follow the shell's `cd` and do not move it. A git worktree counts as its main repository: Claude Code's `<repo>/.claude/worktrees/<name>` is recognised from the path (any case, also after the worktree is deleted), other worktrees from the `gitdir:` line of their `.git` file. Network paths (`\\server\share`) are taken as they are, without reading `.git`.
- `cwd`: that project folder, as spelled by the newest conversation in it. The same folder spelled with different case or slashes on Windows is one project.
- `key`: that folder lower-cased, with `\` turned into `/` and no trailing slash.
- `name`: the last path segment of `cwd`.
- A conversation with no `cwd` at all goes into a project with key `?` and name `(unknown)`.

## 5. Conversation summary

```
{ "id", "project": <project key>, "cwd", "title", "model",
  "state": "waiting" | "dispatching" | "thinking" | "idle",
  "started_at", "last_at",
  "waiting": { "tool", "since", "header" } | null,
  "runs": [ { "id", "lane", "kind", "agent", "model", "group", "plan", "seat", "role", "title", "status", "started_at", "ended_at", "queued" } ],
  "counts": { "running", "done", "failed" },
  "usage": { "input", "cached", "cache_write", "output" },
  "cost_usd": <number|null>,
  "alert": { "kind", "run", "model", "at" } | null }
```

**Basic fields**
- `title`: the newest `custom-title` entry's title. Otherwise the first `prompt` (v2 rule) cut to 60 characters. Otherwise null.
- `model`: the newest assistant entry's `message.model`.
- `started_at` / `last_at`: timestamps of the first and the newest entry used.

**`runs`**
- Covers runs whose `meta.claude_session` is this id. Host answers (`meta.participant === 'host'`) are left out.
- Lists those still `running`, plus those that ended within the last 10 minutes, at most 16, newest first.
- Fields have the same meaning as in the v1 `run` message. `queued` is v1's flag.

**`counts`**: over all of this conversation's runs that started within the window.

**`usage` and `cost_usd`**
- `usage` is the transcript usage within the window, summed as in v2 §3.
- `cost_usd` is that usage priced as in v2, plus the cost of the runs counted in `counts`.
- Parts without a price (a run still running, a model missing from `prices.json`) count as 0, and `cost_partial` is then true.
- `cost_usd` is null only when no part has a price.

**`alert`**
- Set by the newest run that ended within the last 30 minutes with a final status other than `done`, as long as no `prompt` entry came after it ended.
- `kind` is that status (`failed`, `cancelled`, `quota_exhausted`, …), and `at` is its `ended_at`.

**What never goes out.** The summary carries no prompt or message text beyond `title` and `waiting.header`.

## 6. State and agents

### State

Rules in priority order; the first that holds wins.

1. **`waiting`**: an `AskUserQuestion` or `ExitPlanMode` `tool_use` has no `tool_result` yet.
   - `waiting.tool` is the tool name, and `waiting.since` is the `tool_use` entry's timestamp.
   - `waiting.header` is `input.questions[0].header` (at most 24 characters) for AskUserQuestion, otherwise null.
2. **`dispatching`**: one of `runs` has status `running`.
3. **`thinking`**: holds when either of these is true:
   - `now − last_at < 90 s`, unless the newest entry is an assistant entry with `message.stop_reason === "end_turn"`;
   - some other `tool_use` without a `tool_result` started less than 10 minutes ago.
4. **`idle`**: none of the above.

**Known limit.** A tool waiting for the user's permission looks like a running tool, because permission prompts are not written to the transcript.

### Agents (parallel slots)

```
{ "id", "type", "max_parallel", "running": [ { "run", "session" } ], "queued": [ { "run", "session", "since" } ] }
```

- **Which agents.** One entry per agent in the config, plus any agent seen in a running run but missing from the config (`type: null`, `max_parallel: 4`).
- **`running`**: every run of that agent with status `running`, from any conversation, the window not applied.
- **`queued`**: the subset whose v1 `queued` flag is set. `since` is the time of that `api.queued` event.
- **Order**: by config order, then by id.

## 7. Universe stream (`level=all`)

| Message | When | Data |
|---|---|---|
| `hello` | first | `{ "v": 3, "level": "all", "mode": "live" \| "replay", "now", "window_h", "replay": { "start", "end", "speed", "maxgap" } \| null }` |
| `universe` | right after `hello` | the full `/sessions` object |
| `session` | a summary changed | one summary. Live: at most once per second per conversation. A change in `now − last_at` alone does not count, but crossing the 90 s `thinking` limit does. |
| `session_gone` | a conversation left the index | `{ "id" }` |
| `project` | a project appeared or its `cwd` / `older` changed | one project |
| `agents` | any agent entry changed | `{ "agents": [agent…] }`, the whole list |
| `done` | replay only, after the last message | `{}` |

The page keeps the latest summary per id and rebuilds everything from `universe` after a reconnect.

## 8. Replaying everything on one clock (`replay=all`)

- Every conversation in the index and every run belonging to them is put on one timeline.
- Gaps are shortened with `maxgap` exactly as in v1, using one mapping for the whole timeline, so all conversations share the same clock.
- The universe stream sends each `session`, `project` and `agents` message at the mapped time at which its source entry or run event happened.
- Summary rules that depend on `now` use the mapped replay time.
- `GET /sessions?replay=all&t=<sec>` gives the state at `start + t × speed`, like a v1 snapshot.

## 9. One conversation in detail (`session=<id>`)

The v2 stream with a new scope kind, `{ "kind": "session", "value": <id> }`:
- **Lanes**: the lanes of every run whose `meta.claude_session` is the id, plus lane `cc` from that conversation's transcript.
- **Transcript window**: the v2 group/run rule over those runs. With no runs: the last 30 minutes, then everything appended.
- **Live**: as v2.
- **`replay=<id>`**: the conversation alone, on its own clock, as v2 today.
- **`replay=all&from=<ms>`**: uses the §8 mapping, so the page can switch between universe and detail without the clock jumping.
  - `from` is a mapped time.
  - Messages at or before `from` are sent at once, in order.
  - Later messages are sent on schedule, as if the replay had been opened at `from`.
  - `hello.replay` is the §8 one.

Only one detailed stream is expected per page. Opening another conversation closes the previous one.

## 10. Front-end demo (no server involved)

`?demo=universe` makes the page play a built-in scenario (`web/02-uni-demo.js`) that produces the same `hello` / `universe` / `session` / `agents` messages as §7.
- Summaries in the demo carry one extra field, `detail`: the v2 replay scope (for example `replay=skills-roles-1018`, from `fixtures/runs-multi`) that flying into that conversation opens. Real summaries don't have it.
- The live server refuses every replay parameter, so the details only play when the page comes from a debug replay server over those fixture runs, for example `node server.mjs --replay all --runs <fixtures>/runs-multi --claude-dir <an empty folder>`, opened with `&demo=universe` added to its address. The empty `--claude-dir` keeps the universe replay from reading real transcripts.
- `speed` applies, and the scenario loops every 210 s.
- This exists so the universe can be built before §3–§8 are implemented. It is not a server feature, and its numbers are made up.

## 11. Additions to the detail stream (step G)

- Two new `k` values on lane `cc`:
  - `ask`: an `AskUserQuestion` or `ExitPlanMode` `tool_use`. `t` is `input.questions[0].header`, else `计划审批` for ExitPlanMode, else the tool name.
  - `ask_done`: the `tool_result` that answers it, with the same `t`.
  - The board shows Claude Code as waiting for the user between the two.
- `run` messages carry `session`: the Claude Code conversation that dispatched the run (`meta.claude_session`), or `null`. The page uses it to turn an old-style address (`?group=`, `?run=`, `?replay=<id>`) into "open the universe and fly into that conversation"; there is only one front end, and the server always prints its address with `level=all`.
- `run` messages carry `scope`: up to 8 paths from `meta.scope` (each cut to 120 characters), `[]` when the run has none. These are the paths an exec run may write to.
- `run` messages carry `images`: how many images the run produced (the absolute paths in `result.generated_images`, plus image files in its change list, relative to its working folder). Only png, jpg, jpeg, webp and gif count.
- `GET /image?run=<run id>&n=<index>` returns one of those images. It takes only the run id (`yyyymmdd-hhmmss-xxxx`) and the index; the path always comes from that run's own records, never from the request. Files over 15 MB, missing files and other types get 404. The page CSP allows `img-src data: 'self'` for these thumbnails.
