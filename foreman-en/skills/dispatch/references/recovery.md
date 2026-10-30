# Questions, failures and resumes

Read this before deciding anything in these cases: the result has `needs_decision` set to `true` or holds `questions`; the status is `stalled`, `interrupted`, `timeout`, `quota_exhausted`, `needs_input` or `failed`; Codex reports a sandbox error; a discussion or review has an API participant (the queue check starts as soon as it does); you're about to resume a run and pick its `--reason`.

## When an agent needs an answer
Runs are unattended: nobody can answer an agent while it runs. The script makes sure no agent gets stuck waiting: Codex needs no approvals by default; opencode gets no question tool and no permissions that need confirming; pi has no question tool, and the guard extension foreman injects only allows the tools the task needs; foreman's global guard blocks agy's question tool; a CLI added later that prints a "(y/n)"-style prompt and then goes quiet is stopped after 3 minutes with the status `needs_input`.

Every question is collected in the result's `questions`. When `needs_decision` is `true`, something needs deciding; the run has finished, it isn't stuck.

**Claude decides these directly, without asking the user.** Write the decision into the resume brief and continue with `resume --reason answer`; Claude can also do a small finishing step itself.
- Technical approaches and trade-offs within the user's existing authority and the task's scope;
- Contradictions or gaps in the brief: these are usually Claude's own brief, so clarify what was meant;
- Missing material or information: Claude looks it up and passes it on.

**Leave these to the user,** with the question, the options and Claude's recommendation: business trade-offs and preferences, risk tolerance, widening scope or authority, extra spending, irreversible steps.

By `source`:
- `decision_request`: a question returned in a hands-on report. `recommendation` says which option it already went with. If Claude agrees, nothing changes; if not, say what to change in the resume brief (the resume then asks for changes to the work, so use `--reason rework`).
- `permission_denied`: an action the tool tried was blocked by permissions, for example opencode reading a file outside the project, or a pi or agy action stopped by foreman's guard. The permissions are a deliberate boundary, so don't change the config to let it through; read the material it needs yourself and put it in the resume brief, or attach it with `--file`.
- `final_question`: the final answer is a question, not a report. Claude answers it and resumes with `--reason answer`, asking for the report in the required format.
- `input_prompt` (status `needs_input`): the tool is waiting for terminal input. Look at the prompt: if Claude can decide it under the rules above, resume with `--reason answer` and write the answer in the brief; otherwise leave it to the user.
- `asked_mid_run`: a question asked mid-run that nobody answered; it carried on with its own judgement. When checking the work, compare the approach it chose against the report, and treat it as a rework if it's wrong. These don't count toward `needs_decision`.
- `open_question`: an open question in a discussion report; handle it as part of the discussion process.

## Which --reason to resume with
Run and image resumes say why they continue with `--reason` (discussion resumes leave it out), and the rework rate in `stats` follows it:
- `answer`: only answers questions, adds material or gives a decision, then the work goes on. Doesn't count as a rework.
- `recover`: the previous round didn't end normally (stalled, timed out, failed, interrupted, out of quota, or cancelled by Claude with `cancel`) and continues from where it stopped, with nothing to fix. Doesn't count as a rework.
- `rework`: asks to fix or complete the previous round's work (not good enough, finishing a partial result, problems found in checking or review). Use `rework` also when the resume both answers questions and asks for changes. The limit and moving up a level are under "Rework" in `references/acceptance.md`.
- A new requirement beyond the original task is not a rework and not a resume: level it as a new task and hand it off on its own.

When the declared reason doesn't match the previous round (say, `answer` when the previous round asked nothing), the script records it as declared and only adds a line to the result's `notes`.

## Runs that didn't finish normally
- A `stalled` result (stuck: no activity for over `dispatch.stall_min` minutes and no command running, so the script stopped it; the minutes are in the `config` output) is usually a temporary network or service problem. `resume --reason recover` once to continue from where it stopped; if it stalls again, Claude takes over. `--stall <minutes>` changes the threshold and `--stall 0` turns it off. The total time limit is `dispatch.timeout_min`; change it with `--timeout`.
- If you suspect a run is stuck, run `status` and look at "last activity X min ago" and the current step instead of guessing. Long gaps between events are normal while a command is running (such as a big computation). `interrupted` means the dispatcher process is gone (for example the session or app was closed); Claude won't get a completion notice, so check `status --run <run_id>` by hand and decide whether to resume or start over.
- A `quota_exhausted` status means the quota is used up: the plan quota for Codex, or the account balance for an API agent. Don't retry, and don't switch to Claude redoing the work on your own. Tell the user the quota is used up and when it should reset (`quota_resets_at`), and let them decide whether to `resume --reason recover` once it resets or have Claude take over.
- When Claude takes over a run, or the user decides to drop it, and its status is `interrupted`, `stalled`, `timeout`, `quota_exhausted` or `needs_input`, run `cancel --run <run_id>` to mark it handled: the session-start reminder only lists hands-on runs that haven't been handled.
- If the reminder at the start of the session lists runs that didn't finish normally, mention it to the user at a suitable moment and handle them as the user wants.
- When a handoff or discussion fails because of the environment (a command not found, not signed in, a 401 from an API, and so on), run `check` first to confirm the cause and pass on the `fix` in its result.
- When looking into agy: `agy.log` in the run folder often starts with a series of "You are not logged into Antigravity" lines, even on successful runs; it does not mean you are signed out. Check the result's `errors` and `check` to see whether sign-in is really the problem.
- When `check` says agy's own sandbox fails to start (the original text looks like `exebox: creating sandbox: …`): agy cannot create its sandbox on this machine. It is not a network or project-path problem, and testing again gives the same result. agy still takes part in discussions and reviews, but reads files only and runs no commands; it is tested again automatically after agy updates. The probe's run folder is deleted afterwards, so to see what agy did, read `~/.gemini/antigravity-cli/brain/<conversation ID>/.system_generated/logs/transcript_full.jsonl`.

## Stop on sandbox problems
If the sandbox stops Codex from starting commands or it errors (`notes` in the result says Codex's sandbox couldn't start commands; typical errors are `windows sandbox failed` and `setup refresh had errors`), don't retry, and don't switch the sandbox, edit config files or look for a way around the script yourself. Run `check` first: it tests the sandbox without calling a model, and its `fix` lists the possible fixes. Tell the user the exact error, your assessment and those options, and let them decide. Don't suggest changing `approval`: nobody can approve in a handed-off task, so `never` is right; the problem is the sandbox. Codex's read-only sandbox on Windows is covered in `references/config.md`.

## When an API participant is busy
When an API agent's service is busy, the request waits in the server's queue without starting, and the server may eventually drop it. Don't leave the user waiting:
- When a discussion you start (or resume), or a review you start, has an API participant and `effective.dispatch.busy_ask_min` is above 0, also start `await-busy --group <name>` in the background right away (use `--run <run_id>` to watch a single seat). It sends no requests; it exits when a participant has been queued longer than `busy_ask_min` minutes, or when they've all finished, and you're notified when it does. The "Queue check" line the script prints at startup gives the full command.
- When it exits, read its output. If `busy` is empty, there's nothing to do. Otherwise Claude decides directly, without asking the user:
  - If the other participants already have usable results, or this one has been queued for over 10 minutes: run `cancel --run <run_id>` to stop it and go ahead with the other results. Its result is marked `cancelled`; say it's missing when you decide.
  - Otherwise wait 5 more minutes: start `await-busy --run <run_id> --after <minutes queued so far + 5>` in the background, and stop it if it's still queued then.
  - Afterwards, tell the user in one sentence which participant was stopped and why.
- The user can also press x in the live view to stop a queued model, which does the same as `cancel`. Carry on as usual when a result comes back `cancelled`.
