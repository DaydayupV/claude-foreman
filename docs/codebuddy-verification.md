# CodeBuddy review follow-up verification

Verified on 2026-11-16 with Windows, Node 24 and CodeBuddy CLI 2.180.0,
`deepseek-v4.1-flash`, effort `low`. All model tasks used disposable projects.
The table below replaces the original PR's `-y` end-to-end results.

## Flags and isolation

Read-only calls use `--permission-mode dontAsk --setting-sources user
--strict-mcp-config` and `--tools Read,Glob,Grep` (plus `StructuredOutput` when
requesting a report). Edit calls retain `dontAsk`, add `Write`/`Edit`, scoped
`--allowedTools 'Write(./**),Edit(./**)'`, and the injected edit path guard.

Two CLI behaviors required care:

- An empty `--setting-sources ''` still loaded the disposable project's settings
  and executed its `SessionStart` hook. It is not a way to disable settings in
  2.180.0. With `user`, that same project hook did not run.
- Scoped edit allow rules alone denied both the inside and outside `Write`
  attempts on Windows. Separate rule arguments, relative file paths, and
  absolute rule paths did not fix this. The adapter therefore uses its own
  `PreToolUse` guard to authorize only safe project paths while retaining the
  scoped rules and `dontAsk`. There is no fallback to `acceptEdits` or `-y`.
  The guard resolves existing symlinks/junctions and parents of new paths and
  protects `.git`/`.codebuddy` settings. It grants nothing if it fails.

Before model startup, non-empty user `permissions.allow`,
`permissions.additionalDirectories` or `hooks` refuse the call with the exact
settings path. Custom `CODEBUDDY_CONFIG_DIR` is checked too. Edit calls also
refuse user `permissions.deny`/`ask`, because hook approvals would otherwise
override them. These files are not changed by foreman.
Real `check` calls using three separate disposable user configurations confirmed
that allow rules, additional directories and hooks each refuse startup and name
the offending file.

## Real boundary tool results

The project contained settings that attempted to trust the sibling directory,
allow all file tools and run a `SessionStart` marker command. Final probes used
only `--setting-sources user`; those project settings did not take effect.

| Tool and target | Actual tool result |
|---|---|
| `Read` project marker | Success; returned `FOREMAN_INSIDE_72194` |
| `Read` absolute sibling marker path | `is_error: true`, permission denied in non-interactive mode |
| `Grep` with an absolute sibling directory as `path` | `is_error: true`, permission denied |
| `Glob` with an absolute sibling directory as `path` | `is_error: true`, permission denied |
| `Write` project file, with the final edit guard | Success; disk content was `FINAL_INSIDE_42861` |
| `Write` absolute sibling file, with the final edit guard | `is_error: true`, `PreToolUse:Write hook blocked this tool call: foreman guard: path is outside the project or changes protected settings`; no file created |
| Project `SessionStart` hook during the final write probe | Marker timestamp unchanged; hook did not run |

Both writes were issued by the model and had matching tool results. These are
permission outcomes, not a model refusing to attempt the requested action.

## End-to-end through foreman's `cli.mjs`

The agent configuration used the explicit, extensionless npm entry
`@tencent-ai/codebuddy-code/bin/codebuddy`, exercising the Windows `bin` fix.

| Path | Result | Elapsed |
|---|---|---|
| `check --agent cb` | Version/model/effort detected; tiny probe replied `OK` | 6.7 s |
| `run`, `run_access: edit` | `done`; created `add.mjs` with `Write`; change attributed to `agent`; valid native structured report | 8.9 s |
| `review --target diff --uncommitted` | `done`; `no_issues`; native structured review report; read-only tools | 16.6 s |
| `discuss` | `done`; read `add.mjs`; valid native structured discussion report | 32.8 s |
| `resume` that discussion | `done`; same session ID; recalled `DISCUSS_RESUME_72419`; valid native structured report | 12.4 s |

Every report above appeared in the real `result.structured_output` field.

## Real resumed usage

This 2.180.0 run did **not** attach `_meta["codebuddy.ai/turnUsage"]` to
`result`. The discussion's result usage was 55,364 input / 3,825 output; the
resumed result was session-cumulative at 70,063 input / 5,200 output. Foreman
reported only the resumed call's 14,699 input / 1,375 output with
`usage_scope: this_run`, matching both the unique assistant message's usage and
the difference between the session totals.

The resumed response had two assistant fragments with the same message ID
(thinking and `StructuredOutput` tool use). The thinking fragment carried zero
usage and the tool fragment carried the final numbers. The adapter keeps the
latest usage record and emits one `step.usage` after the message completes, so
the board neither loses the final numbers nor counts a response twice.
Regression scenarios also cover resumed calls
without turn metadata, native turn snapshots overriding cumulative totals,
and a report-repair call with cumulative result usage.

A further real discuss/resume probe with the final event translation reported
26,778 input / 1,594 output both in the run result and in the sum of its two
`step.usage` events, and recalled its previous-round marker.

## Automated checks

- Full `npm test`: 1,442 passed, 0 failed, 1 skipped (1,443 total), before
  the last live-usage refinement and its additional regression case.
- Entire CodeBuddy regression file after that refinement: 29 passed, 0 failed.
- The final protected-path and command-guard changes: all 4 targeted tests passed.
- `node tools/sync-shared.mjs --check`: passed.
- `node board/build.mjs`: identical generated board page.
- `git diff --check`: passed.

Only this model and Windows were exercised against the live service. Native
extensionless executable selection and Node shebang selection have regression
coverage; a macOS/Linux live run was not performed.

## Maintainer follow-up after the merge

Re-checked on 2026-11-25 on Windows 11 with Node 24, CodeBuddy CLI 2.185.0,
`deepseek-v4.1-flash` and effort `low`, through foreman's `cli.mjs` with a
separate foreman config and a disposable project whose own
`.codebuddy/settings.json` tried to widen permissions.

The first pass found these gaps in the merged adapter:

- CodeBuddy's user `trustedDirectories` widened reads: with the home folder
  listed there, `Read` and `Grep` in discussion, review and `edit` runs read a
  marker file under the home folder.
- CodeBuddy strips a leading `@` or `file:` (and converts `/c/...` paths on
  Windows) after the hook has run, so `Write @../x` and `Write file:../x` were
  approved as project paths and landed outside the project.
- `.claude` in the project was writable.
- At `shell`, `-y` left `Write` and `Edit` unguarded, `.git` included.
- On Windows, `Grep` and `Glob` follow links: in a project with a junction to a
  sibling folder, `Grep` returned the sibling folder's marker.

The follow-up commits changed the adapter so that:

- one `PreToolUse` hook (`codebuddy-guard.mjs`) checks `Read`, `Glob`, `Grep`,
  `Write`, `Edit` and `WebFetch` in every mode. Reads and searches stay in the
  project. `edit` and `shell` writes stay in the project and out of `.git`,
  `.codebuddy`, `.claude`, linked protected folders, the folder a `.git` file
  points to, foreman's state and run records, and CodeBuddy's config folder;
  files with other hard links are refused. `@`, `file:` and `/c/`-style paths,
  `..` segments, write paths with `.` segments or names ending in a dot or
  space, and network shares are refused;
- the settings precheck also refuses enabled plugins; `trustedDirectories` no
  longer matters because the hook denies reads outside the project;
- the child process runs with the main-agent switch off and without
  `CODEBUDDY_PLUGIN_DIRS`, `CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED`,
  `CODEBUDDY_MCP_CONFIG` and `CODEBUDDY_PROJECT_CONFIG_DIR`;
- on Windows, `CODEBUDDY_CODE_GIT_BASH_PATH` is pinned to an existing
  `bash.exe`, and the call is refused without one: CodeBuddy would otherwise
  run hooks in PowerShell, where the guard doesn't apply;
- on Windows, a discussion, review or `edit` run in a project with a link
  pointing outside it gets no `Grep` or `Glob` and a `git ls-files` list
  instead, and its notes say so;
- `--add-dir` is refused;
- discussions and hands-on runs get `WebSearch` and `WebFetch`, reviews don't.
  In `-p` runs under `dontAsk`, `--allowedTools` didn't pre-approve `WebFetch`,
  so the hook approves http and https pages itself unless the user's settings
  deny or ask for `WebFetch`, and refuses other URLs;
- `check`'s probe runs with no tools.

Live results with the final adapter:

| Probe | Result |
|---|---|
| Discussion: `Read` of a project file | Returned the project marker |
| Discussion: `Read` of a sibling folder's file, of a file under the home folder, and via `@../` | Denied by the guard |
| Discussion: `Grep` with a `path` under the home folder | Denied by the guard |
| Discussion: `Glob` with a `~/...` pattern | `No files found` (the pattern isn't expanded) |
| Discussion in a project with a junction to a sibling folder | No `Grep` or `Glob`; file list attached; notes name the link; `Read` through the junction denied |
| `edit`: `Read`, `Edit` and `Write` inside the project | Succeeded |
| `edit`: `Write` to a sibling folder, under the home folder, into `.git`, `.codebuddy` and `.claude`, via `@../` and `file:../`, through the junction, and to `./name` | Denied by the guard |
| `edit`: `Read` of a file under the home folder | Denied by the guard |
| `shell`: `Bash` command | Ran |
| `shell`: `Write` to a sibling folder and into `.git` | Denied by the guard |
| Discussion: `WebSearch`, and `WebFetch` of an https page | Returned content; searches recorded as `web_search` events |
| Discussion: `WebFetch` of a `file:///` URL | Denied by the guard |
| `review --target diff --uncommitted` | Valid report; a `Read` under the home folder was denied and listed as a `permission_denied` question; asked to call `Bash`, the model said it had only `Read`, `Glob`, `Grep` and `StructuredOutput` |

CodeBuddy's `system/init` event lists every registered tool whatever
`--tools` says. CodeBuddy applies the `--tools` filter when it enables each
tool, so that event isn't the set the model can use; the review above had only
the tools foreman passed.

Still open: links that point to network shares, nested git metadata in unusual
layouts, Windows folders with case sensitivity turned on, the board's live
token rate briefly differing from the final total when `turnUsage` and message
usage disagree, and macOS and Linux, which haven't been run against the live
service.

Automated checks on the final tree: full `npm test` ran 1,513 tests, 1,512
passed, 0 failed, 1 skipped; `node tools/sync-shared.mjs --check` passed.
