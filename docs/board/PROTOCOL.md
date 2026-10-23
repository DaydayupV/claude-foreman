# Board protocol (prototype v1)

Local web board for foreman runs. `server.mjs` reads the runs directory and pushes what it sees; `index.html` draws it on a canvas. Read-only: nothing on this page can change a run.

## Starting

```
node server.mjs [--runs <dir>] [--port <n>] [--idle-min <m>]
                [--group <name> | --run <run_id> | --replay <group|run_id> [--speed <N>] [--maxgap <sec>]]
```

- Runs directory: `--runs`, else `dispatch.runs_dir` in `~/.claude/foreman/config.json`, else `~/.claude/foreman/runs`.
- Prints exactly one line to stdout, then keeps serving:
  `board: http://127.0.0.1:<port>/<token>/?<query>` where `<query>` carries the scope options given (`group=…`, `run=…`, `replay=…&speed=…&maxgap=…`), empty for the default scope.
- One server per machine. Lock file `<runs>/board.lock.json`: `{ "v": 1, "pid", "port", "token", "started_at", "build" }`, created with exclusive create and mode 0600; the port is filled in later by writing a temporary file and renaming it over the lock. `build` is the first 16 hex digits of a sha256 over the board files (`build-id.mjs`), so two installs with the same files share one server and an upgraded plugin can tell an old server apart. A second start that finds a lock whose server answers `GET /<token>/health` prints the same line with that port and token followed by ` (reused pid <pid>)` and exits 0.
- A lock is stale when its pid is dead, when its port refuses connections, when it can't be parsed and is older than 3 s, or when its server has not answered for 15 s (a server busy reading records for a few seconds is not stale). Stale locks are removed by renaming them to a unique name first and checking the content; a lock another process just wrote is put back (by hard link, or by renaming back on drives without hard links).
- Every 15 s the server checks that the lock is still its own: if the lock is gone it writes it again, and if another server's lock is there it exits. So a server that was taken over while busy, or lost its lock in a race, leaves within 15 s and one server remains.
- If the server fails to start it writes `{"pid", "error"}` to `<runs>/board.err`; `board` reports the error only when the pid is the one it started. `board` removes the file before starting a server, and a successful start removes it too.
- `--port` defaults to 0 (a free port). `--idle-min` defaults to 5.

## Security

- Listen on `127.0.0.1` only.
- Token: 32 hex characters (`crypto.randomBytes(16)`). Every route is under `/<token>/`; any other path answers 404 with an empty body.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; otherwise 403 (guards against DNS rebinding).
- Only `GET` and `HEAD`; anything else answers 405. No CORS headers.
- Every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- `index.html` also gets `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: 'self'; base-uri 'none'; form-action 'none'`.

## Routes (all under `/<token>/`)

| Route | Answer |
|---|---|
| `GET /[?lang=…]` | `index.html` from the server's own directory, read on every request (a rebuild shows on reload), with the page language set from `lang` (else the language of the plugin that started the server). Missing file: a one-line placeholder page. |
| `GET /health` | `{"ok":true,"v":1,"pid":<pid>,"build":"<build id>"}` |
| `GET /stream?<scope>` | Server-sent events, see Messages. |
| `GET /snapshot?<scope>[&t=<sec>]` | One JSON object `{ "hello", "runs": [run…], "events": [ev…] }`, then the response ends. For headless screenshots, where a never-ending stream would hold the page. |

Scope parameters: `group=<name>`, `run=<run_id>`, `replay=<group|run_id>` with `speed=<N>` (default 1) and `maxgap=<sec>` (default 20). None of these: the live recent scope.

## Which runs a scope covers

- **Lane**: one seat on the board. A run's lane id is the root of its `meta.parent` chain (follow `parent` while that run directory exists). Round 2 of a discussion and a resumed task land in the same lane as the run they continue.
- **Recent** (no scope parameter): lanes that have a run with status `running`, or a run that ended within the last 30 minutes; at most 8 lanes, most recently active first. Re-evaluated on every poll, so a newly started run appears without reconnecting.
- **group**: runs whose `meta.group` equals the name. When several Claude sessions used the same name, only the batch of the newest run's `meta.claude_session` counts (as foreman's `groupRuns`). Whole lanes are included.
- **run**: the lane containing that run.
- **replay**: the same selection as `group` (when a group of that name exists) or `run`, played back from the records instead of watched.

Run status is settled the way foreman's `settleMeta` does it: a meta still saying `running` while `result.json` holds a final status takes the result's status, and `ended_at` from `started_at + duration_s`.

## Messages

Stream framing: `event: <name>\ndata: <one-line JSON>\n\n`. A comment line `: ping` every 15 s. A snapshot carries the same objects. Times are milliseconds since the epoch.

### `hello` (first message)

```
{ "v": 1, "mode": "live" | "replay", "scope": { "kind": "recent" | "group" | "run", "value": <string|null> },
  "now": <server time>, "replay": { "start", "end", "speed", "maxgap" } | null }
```

### `run` (one per run: on connect, and again whenever its meta.json or result.json changes)

```
{ "id", "lane", "parent", "kind": "discuss" | "review" | "exec" | "image", "mode",
  "model": meta.model_shown || meta.model, "agent", "agent_type", "level", "effort",
  "group", "round", "plan", "seat", "role", "title", "status",
  "started_at", "ended_at" | null, "duration_s" | null,
  "usage": { "input", "cached", "output" } | null,          // result.json usage: input_tokens, cached_input_tokens, output_tokens
  "cost_usd" | null,
  "review": { "verdict", "findings": [{ "severity", "where", "title" }] } | null,   // review runs: result.json report, at most 8 findings, texts ≤120 chars
  "files": [{ "path", "chars" }],                            // result.json files, at most 12
  "queued": true | false }                                   // latest api event is api.queued with nothing streamed after it
```

`kind` comes from `meta.kind`, else from `meta.mode` (`discuss`, `review`, otherwise `exec`); `meta.module === 'image'` gives `image`.

### `ev` (one per normalized event)

```
{ "run", "lane", "ts", "k", "t"?: <one line, ≤160 chars>, "n"?: <number>, "ok"?: <bool> }
```

| `k` | From events.jsonl | Fields |
|---|---|---|
| `start` | synthetic, at `started_at` | `t`: kind |
| `end` | synthetic, at `ended_at` | `t`: status |
| `turn` | `thread.started`, `turn.started` | |
| `msg` | `item.completed` / `agent_message` whose text is not a JSON object | `t`: first line |
| `report` | `item.completed` / `agent_message` whose text parses as a JSON object | `n`: text length |
| `think` | `item.completed` / `reasoning` (`t`: first line, `**` removed); `api.reasoning`, `pi.progress` phase `thinking` (`n`: total_chars) | |
| `answer` | `api.content`, `pi.progress` other phases | `n`: total_chars |
| `cmd` | `item.started` / `command_execution` whose `category` is not `read` or `search` | `t`: the command, one line, a PowerShell `-Command "…"` wrapper removed |
| `cmd_done` | `item.completed` / `command_execution`, same filter | `ok`: exit code 0 or null |
| `read` | `command_execution` with `category: read`, on completion (or start when no completion follows) | `t`: `label`, else the command without the tool name |
| `search` | `command_execution` with `category: search`; `item.completed` / `web_search` | `t`: label or query |
| `edit` | `item.completed` / `file_change`, one per change | `t`: `<kind> <path relative to meta.cwd>` |
| `plan` | `item.completed` / `todo_list` | `t`: `<done>/<total>` |
| `req` | `api.request` | `t`: model, `n`: attempt |
| `queued` | `api.queued` | |
| `retry` | `api.retry` | `t`: reason |
| `usage` | `api.usage`; `step.usage` (one model request: opencode `step_finish`, pi assistant `message_end`, Codex `token_usage_record` from its own session file, merged per 2 s scan); `turn.completed` with usage | `n`: total tokens, `t`: `<in>/<out>`, `u`: `{in, cached, cache_write, out}`; `tot: 1` on `turn.completed` (the turn's total, thread-cumulative on Codex resume: ignored when the turn has `step.usage`, else capped by the run's own output); `end: 1` when `step.usage` carries `final` (the request that ended the turn) |
| `error` | `api.error`, `turn.failed`, `error`, `item.completed` / `error` | `t`: message |
| `image` | `image.generated`, `image.viewed` | `t`: file name |

Other event types are skipped. Streaming sources (`api.reasoning`, `api.content`, `pi.progress`) are coalesced to at most one `think` or `answer` per 400 ms per run, keeping the latest `n`.

### `backlog` (live scopes, once per run on connect)

`{ "run", "events": [ev…] }`: the last 200 normalized events of that run, synthetic `start` included. Replay sends no backlog.

### `done` (replay only)

`{}` after the last scheduled message. The connection stays open.

## Replay timing

All messages of the selected runs (each run's `run` message at its start with status `running` and no usage, review or files; its final `run` message at its end; every `ev`) are put on one timeline. Gaps longer than `maxgap` seconds of record time are shortened to `maxgap`, and every time field (`ts`, `started_at`, `ended_at`, `hello.replay.start/end`) is rewritten through that same mapping, so the page never sees two clocks. `start` is the first mapped time minus 2 s, `end` the last plus 2 s. Each message is sent `(time − start) / speed` after the connection opened.

Snapshot with `t` in a replay scope: the state at mapped time `start + t × speed`: runs not yet started are left out, started but unfinished runs show status `running` with no usage, and only events up to that time are included. In a live scope `t` is ignored.

## Watching and idle exit

- `fs.watch` on the runs directory notices new run directories; a 1 s poll over the runs in some open scope picks up meta.json and result.json changes (size or mtime) and new bytes at the end of events.jsonl (kept offset, streaming UTF-8 decoder, partial last line held back). With no open stream the poll pauses.
- A meta.json that fails to parse or a read that fails with `EPERM`, `EBUSY` or `EACCES` is retried on the next poll.
- Idle exit: every 15 s, if there is no open stream and no run started in the last 24 h is still `running`, and that has held for `--idle-min` minutes, remove the lock (only when it still holds this server's pid and token) and exit 0.
