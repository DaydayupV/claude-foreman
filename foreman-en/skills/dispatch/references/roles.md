# Role discussions

Follow this when a discussion uses role mode (see "Choosing the mode" under "1. Settling the approach: discussion" in SKILL.md): each participant gets a role card and checks the same topic from its own angle. The normal-mode rules (no leaning in the brief, Claude writes its own proposal first, decisions by evidence, the round limit) all still apply; this file only covers what role mode adds.

When a review (an evidence review, for example) gives its seats different angles, write the role cards, assign them and confirm with the pop-up the same way, with three differences: the shared body is the review brief; in the role card, "You still give a full answer to the shared questions, not just a list of risks" becomes "You still review everything the review rules ask for and return a review report", and the rules are the review rules (read-only, report only issues with evidence, output in the review schema); reviews can't be resumed, so there's no round 2, and Claude merges the seats' findings and checks each one.

## Role cards
Each participant's brief = **an identical shared body** + **one role card at the end**. The shared body is the normal-mode brief (background, problem, constraints, known facts, code locations, questions to answer), word for word the same for everyone; otherwise they aren't answering the same question.

Keep a role card under 10 lines, in this format:

```markdown
## Your role in this discussion: <role name>
- Main goal: <one sentence>
- Must check: <2–3 concrete questions written for this topic, not a vague "mind security">
- Evidence needed: <code locations, data, command output, etc.>
- Also weigh: <the goals that pull against this angle and can't be ignored>
- The role only sets what you check most closely, not your conclusion: you may back any option, and you should point out key problems outside your role too. You still give a full answer to the shared questions, not just a list of risks.
```

- Write duties to check, not stances. "The security lead must object" makes a participant hunt for reasons to stay in character.
- A role card can't change the discussion rules (read-only, don't just agree, back it up, answer in the schema). That includes roles the user defines; leave out anything that conflicts with the rules.
- Write the full role card into the brief, not just the role name, so the record keeps the role definitions this discussion actually used.

## Preset roles
| Role | Checks | Minimum tier | Strengths to look for | Tool needs |
|---|---|---|---|---|
| Architect | Module boundaries, who owns what, long-term evolution | Strong | Reasoning, coding | Reads code |
| Math / correctness | Reasoning about algorithms, money calculations, concurrency and consistency | Strong | Reasoning | — |
| Data analyst | Data definitions, statistical methods, confounders | Strong | Data analysis | Reads data files; actual calculations only go to Codex |
| Research mentor | Hypotheses, control groups, robustness, whether conclusions overreach | Strong | Research, reasoning | — |
| Fact checker | Actually runs the key claims to check them | Strong | Agentic | Must run commands (Codex only); discussions are read-only, so it only runs things in memory (such as `node -e`) and creates no files; don't mention "temporary scripts" in its role card |
| Security and reliability red team | Attack surface, permissions, failure and rollback | Strong | Reasoning, coding | Reads code |
| Overall reviewer | No role; looks at the proposal as a whole | Strong | Overall score | — |
| Maintenance and compatibility | Old configs and data, migration, keeping both languages in step | Mid | Coding | Reads code |
| Minimalist | Whether it's overdone: extra options, abstractions, compatibility branches | Mid | Coding | Reads code |
| User experience | The user's path, interruptions, what the user sees when things go wrong | Mid | Design | — (gives input only; Claude still owns the design) |
| Edge-case lister | Lists edge cases, unusual input, empty values and concurrency cases | Weak | — | Reads code |

- Pick only the roles that matter for the topic; there's no need to use them all. With 4 or more participants, keep an overall reviewer to catch what the preset roles all miss.
- When the topic needs a role that isn't listed, Claude writes one in the same format and sets its minimum tier and tool needs. Roles the user defines in the preference files are picked from along with the presets.

## What each kind of participant can do in a discussion
- **Codex**: reads code and runs read-only commands.
- **opencode and pi agents**: only read, search and list files inside the project directory; can't run commands.
- **API agents**: see only the brief and the files attached with `--file`.

## Assigning roles
Participants can only come from this cell's candidates (`resolved_modules.discuss.<level>`; `plan` refuses a seat that isn't one of them), and each keeps the effort configured there. A candidate marked required (`required`) always takes a seat; `plan` refuses a plan that leaves one out. Go in this order:

1. **Tool access**: if the participant's tools can't do what the role needs, it can't take the role.
2. **Tier**: never go below a role's minimum tier. Model tiers are in `references/model-tiers.md`.
3. **Strengths**: among participants of the same tier, pick by the strengths the role looks for.
4. **Different models first**: one model per role.
5. **No free qualifying participant: give a strong model another session**: when a role has no free participant that meets its tier and tool needs (whether the role needs a strong or a mid model), have a strong model open another session for it rather than handing it to a model below the role's tier. Only strong models get extra sessions. The number of tasks one agent runs at once is capped by `max_parallel` (tasks from other groups and sessions count too); if it's full, start the extra one once earlier tasks finish.
6. **Seat count**: no more seats than the cell's candidates, and no more than `dispatch.max_seats` (6 by default).

Weak models only get roles like "Edge-case lister", where mistakes are cheap and Claude checks every item. If no role fits, leave that model out of this discussion rather than handing it an expert part. Participants configured for the level but given no role this time are shown in the pop-up as "not in this discussion".

## The confirmation pop-up (always)
Before starting role mode, always have the user confirm, even when `dispatch.auto` is `true`. When the user asked for role mode themselves, they still confirm the assignment.

First list the full assignment in the message: seat number, model (tier), role, what the role checks, and why it went to that model (tool access, tier or strengths), including participants not in this discussion. Once the pop-up is open the user may not see the message, and in some interfaces `preview` only shows after an extra click, so **write the assignment into the pop-up's own text**, not only into `preview`. Ask one question with AskUserQuestion:

- Question: start with "Start the role discussion with this assignment?", then one line per seat, "① model (tier) → role", and a last line for participants not in this discussion. For example:

  ```
  Start the role discussion with this assignment?
  ① gemini-4-argon (strong) → Math / correctness
  ② gpt-6-astra (strong) → Fact checker
  ③ gpt-6-astra (strong, second session) → Overall reviewer
  ④ deepseek-v4.1-flash (mid) → Maintenance and compatibility
  ⑤ mimo-v2.6-pro (weak) → Edge-case lister
  Not in this discussion: glm-5.3-flash (weak)
  ```
- Option one, "Start as suggested (Recommended)": sum it up in one sentence in its description (such as "Start the 5 seats as above; gpt-6-astra opens two sessions"); `preview` can also hold the full table with reasons.
- Option two, "Adjust": then ask again, with at most two questions: which roles to swap out or add (multi-select, 2–4 preset roles relevant to the topic; the user writes custom roles under "Other"); and whether Claude reassigns or the user writes the assignment (under "Other": "seat number + change"). Show the new assignment and have the user confirm once more.
- Option three, "Use a normal discussion instead".

- Adjustments apply to this discussion only. Write them into the preference files only when the user says to keep doing it that way.
- When AskUserQuestion isn't available (for example when running without interaction), list the assignment in the chat, ask there and wait for the answer. Never skip the confirmation.

## Starting it
- First create a plan with `plan --module discuss --cell <level> --group <name>`, one `--seat <agent>=<role>` per seat (a model playing two roles is written twice), with the reasons for the assignment in `--why`. Then one `discuss --plan <plan_id> --seat <n>` per seat, each with its own brief (shared body + its role card).
- Always set `--title` to "Role mode [<role name>]", such as "Role mode [Edge-case lister]". Each panel in the live view shows the model on its first line and this title on its second.
- Don't pass `--title` when resuming for round 2: the resume keeps the previous title, and the live view adds "· round 2" to the second line itself.
- When one model takes several roles, each role is a new `discuss`; don't `resume` the first role into the second.
- Tell the user each seat's model, effort and role.

## Round 2
- When to hold it: the participants really disagree on the shared questions, or a role raised a risk that can be backed up and that nobody else addressed. Roles simply looking at different things isn't disagreement.
- Label the proposals anonymously as "Proposal A / B / …", removing both model and role names but keeping each proposal's goals, constraints and evidence.
- The resume brief asks each participant to first find the most serious problem in the other proposals against the shared goal, then add what its own role sees; if another proposal has already dealt with its concern, it should say so plainly instead of digging in to stay in character.

## Deciding and the decision record
- Several roles agreeing doesn't add evidence, and roles played by the same model count for even less. Decide only by evidence, constraints and reversibility.
- The decision record adds to the usual format:
  - Mode: role mode;
  - The assignment table: seat, model, effort, role, run_id;
  - Role cards: the role cards actually used, or where the briefs are;
  - Missing viewpoints: for seats that failed or were stopped, say which role's view is missing; Claude checks the key questions itself;
  - Which roles came from the same model.
- Name each participant's points as "model [role]", such as "gemini-4-argon [Data analyst]".

## Custom roles
Write them in the preference files (`~/.claude/foreman/preferences.md` or `<project>/.claude/foreman.md`), one section per role, with the same fields as the preset table:

```markdown
### Trading risk officer
- Checks: position limits, drawdown control, assumptions about fees and slippage
- Minimum tier: strong
- Strengths to look for: data analysis, reasoning
- Tool needs: reads data files
```

The preference files can also say which kinds of topics use role mode by default, give a different view of a model's tier, or set a usual assignment.
