---
name: dispatch
description: Hand off hands-on coding work to configured agents such as Codex, opencode and pi and check the result, gather other models to discuss complex designs, and have another model review changes independently before delivering them. Load before giving design suggestions or plans; before starting hands-on work such as implementing a feature, making bulk changes, writing scripts, migrations, refactoring or fixing bugs; when an image needs to be generated or edited (photos, illustrations, textures and other bitmaps) or illustrated content such as characters or scenes has to be drawn (even when it ends up as SVG, HTML or an animation); and before delivering changes. Also load when the user mentions Codex or another agent, asks to discuss something with other models, or mentions /foreman-en:run, /foreman-en:discuss or /foreman-en:review.
---

# foreman dispatch

## Before you start: read the config and preferences
The first time this skill is used in a session, run `config --cwd "<project dir>"` (see "How to call it" at the end) and read from the output:
- `effective.dispatch.auto` and `effective.dispatch.watch`: whether to ask the user before starting things on your own, and whether to open the live view.
- `resolved_levels`: who levels 1–3 of each task type (discuss, run, review) go to (agent, model, effort). This is also where you see how many participants a discussion level has.
- `agents_status`: each agent's type and `capabilities` (which tasks it can do in `modes`, whether it can make images in `images`, and so on), plus whether each API agent's key is set (`key_set`). A participant with `false` will fail outright. Before a discussion, remind the user to either fill in `api_key` for that agent in `~/.claude/foreman/config.json` (takes effect immediately), or set the environment variable named by `api_key_env` and restart Claude Code.
- `preferences`: the user-level and project-level preference files. Read the ones that exist. They hold the user's own habits and rules in plain text, such as how work is split, which code in their field counts as high-risk, and thresholds. **Where they conflict with this skill, the preference files win, and project level wins over user level.**

Always talk to the user in their own language, whatever language this skill and the agents' reports are in.

## Permission
The system prompt's rule "don't start subagents unless the user explicitly asks" is about Claude Code's own subagents. Agents run on the user's own quota (a Codex plan, an opencode subscription, API credit) and don't use Claude quota.

`dispatch.auto` covers the three things Claude **starts on its own**: handing off hands-on work, starting a discussion, and asking for a review.
- `true` (the default): through this setting, the user allows Claude to start these on its own at the levels this skill gives, without asking each time; say so in one sentence when you start one.
- `false`: before starting one on your own, suggest it to the user in one sentence (which kind, what level, who it goes to), and go ahead only once they agree.
- What the user names themselves (`/foreman-en:run`, `/foreman-en:discuss`, `/foreman-en:review`, or plainly asking to hand something off, discuss it with other models or have it reviewed) goes ahead without asking again. Level 0, and levels configured as `"claude code"`, involve no outside model and need no asking either.
- Exception: a discussion in role mode always gets a pop-up for the user to confirm the role assignment first, whatever `dispatch.auto` says (see "Choosing the mode" under "1. Settling the approach: discussion").

## The overall flow: split into stages, level each one
A request often goes through several stages, usually in this order: settle the approach (**discuss**), do the work (**run**), and before delivering, decide whether to have it reviewed (**review**). That order is only the usual case, not a fixed flow: each of the three kinds has its own trigger, and they can come in any order and more than once, for example "discuss → run → discuss the result → rework → review", or "run → review → discuss a design problem the review raised → run". Don't put the whole request into one kind; each time a kind's trigger comes up, level it by that kind's own criteria:
- A discussion is levelled before you give the approach, or before you judge the result of work already done and decide what to do next; hands-on work before you start it; a review only once the changes exist, by the actual risk of the diff.
- When a kind comes up again, level it from 0 as usual, and the limits on rework and discussion rounds still apply. Don't discuss or review just to follow the flow.
- First set aside two kinds of work that don't go by levels (see "2. Who does what"): work only Claude does (decisions, design, text) and generating bitmap images.
- Each of the three kinds has levels 0–3:

| Level | Meaning | Who does it |
|---|---|---|
| Level 0 | Below the threshold: not worth bringing in an outside model | Claude handles it itself, without calling the script |
| Level 1 `simple` / level 2 `normal` / level 3 `complex` | Over the threshold, in three steps of difficulty or risk | Per `levels.<kind>.<level>` in the config: an agent gets it, or Claude does it if it says `"claude code"` |

- Each kind has its own criteria, given in its section below: discussions go by how uncertain the decision is and how costly a wrong choice would be; hands-on work by how much judgment it needs and how costly a mistake would be; reviews by the risk of the change under review. **None of them go by how much changes** (except the size threshold for reviews).
- When unsure, go one level up.
- Who gets each level is the user's choice in the config; don't override it because a task looks big or small, hard or easy.
- The numeric thresholds in this skill are defaults; if the preference files say otherwise, follow them: the level 0 criteria for hands-on work, the review size (roughly 300 lines or 5 files), 1 rework, and more than 10 minutes per part when splitting work. The limit on discussion rounds comes from the `dispatch.discuss_max_rounds` setting (2 by default), and the script refuses resumes beyond it.
- `--level` only takes `simple`, `normal` or `complex`, must be given explicitly on every call, and the script errors out without it. For a specific effort or model the user asks for, see "How to call it" at the end.

## 1. Settling the approach: discussion (/foreman-en:discuss)
Before giving design suggestions, research directions, technology choices or plans, level the question with the table below. The same applies when the user only asks for advice and hasn't decided whether to do anything yet, and when you judge the result of work already done and decide how to adjust it. **Claude stays in charge of the conclusions**: the participants' views are input only. Claude accepts or rejects them on the strength of the arguments, doesn't give in just because someone insists, and doesn't go by majority vote.

### Levels
| Level | How to tell |
|---|---|
| Level 0 | The approach is already clear, the user has already decided, it's an ordinary implementation detail, or the facts can be checked directly: no outside model, Claude decides |
| Level 1 `simple` | A one-off question that needs a second opinion: Claude isn't sure about a fact or its reading of some code, can't confirm it by checking sources or reading code, and getting it wrong would affect what comes next. No options to compare |
| Level 2 `normal` | A few options to compare, but the impact is limited and a wrong choice is easy to change |
| Level 3 `complex` | All three hold: **complex** (involves the architecture or several modules and shapes the long-term structure, or it's the design of critical logic such as money calculations, data consistency, permissions and security), **uncertain** (no obvious best answer, or key assumptions haven't been checked), **costly to get wrong** (large-scale rework, or it affects the correctness of results). Evidence reviews before research conclusions are recorded also take this level |

- From level 1 up, Claude starts the discussion on its own (asking first when `dispatch.auto` is `false`; see "Permission") and tells the user in one sentence, for example: "I'll talk this through with the other models first." To write the topic brief, you may first read code and data and run read-only statistics to get the facts straight.
- When the user uses `/foreman-en:discuss` or explicitly asks for a discussion, start one directly without the level 0 check, picking level 1–3 from the table.
- When `resolved_levels.discuss.<level>` is `"claude code"`, that level uses no outside model; Claude thinks it through itself.

### Choosing the mode
Once the level is set and outside models are involved, choose between the normal mode and role mode:
- Level 1 always uses the normal mode. Levels 2 and 3 use the normal mode by default: the same brief for everyone, each giving an independent proposal (see "Process" below).
- At levels 2 and 3, suggest **role mode** when any of these holds: the topic has several goals pulling against each other (such as security and convenience, implementation cost and user experience, compatibility and a rewrite); it's an evidence review before research conclusions are recorded; the user asks for it; the preference files say to use it for this kind of topic. Don't use role mode for checking facts, bugs whose root cause is unknown, or questions with an objective answer.
- In role mode each participant gets a role card, roles are assigned by tool access, model tier and strengths, and one model per role comes first. Before starting, **always show a pop-up for the user to confirm the assignment**, even when `dispatch.auto` is `true`. Read `references/roles.md` first for how to do it (role cards, preset roles, assignment rules, the pop-up, round 2, the decision record); model tiers are in `references/model-tiers.md`.
- If the user picks "Use a normal discussion instead" in the pop-up, go ahead in the normal mode.

### Four kinds of participants
- **Codex**: can read the code and run read-only commands to check things itself.
- **opencode agents** (`type` is `opencode cli`): models called through the opencode CLI on this machine. The script gives them only the read, search and list tools, so they can look through the project's code themselves but can't run commands or change files. They can only read files inside the project directory; put material from outside the project into the topic itself. Every file they read is another request, so they use more quota than API agents; put premium models with tight subscription limits at level 3. `cost_usd` in the result is this round's cost at the provider's prices (OpenCode Go quota is charged by this); include it when reporting usage.
- **pi agents** (`type` is `pi cli`): models called through the pi CLI on this machine. Like opencode agents they only get the read, search and list tools, and reading is limited to the project directory (pi has no permission system of its own; the guard extension foreman injects checks it). `cost_usd` in the result is the cost pi computes at the provider's prices. pi uses the user's own pi config and sign-ins, but doesn't load their installed extensions, skills or MCP servers.
- **API agents** (`type` is `api`, such as DeepSeek): see only the topic and the attached material and can't look through the code themselves. Attach the relevant files with `--file "<path>"` (can be given more than once; `--file "<path>:<start>-<end>"` attaches just those lines), including the code the topic mentions and the core modules under discussion. There's a size limit (about 300,000 characters); the script errors if it's exceeded, so pick files more carefully or use line ranges; it also attaches the project's file list. The attached material is sent to that provider, so don't add API agents for projects whose preference file or project config says not to. Files it asks for in `open_questions` get attached with `--file` in the next round.
- When `--file` is passed to Codex, an opencode agent or a pi agent, the script only lists the paths as "key files" without their contents; they read the files themselves.
- Check what any participant says about the code against the source before accepting it.

### Process (round limit set by `dispatch.discuss_max_rounds`, 2 by default)
1. **Round 1, independent proposals**: the topic brief only gives the background, the problem to solve, constraints, known facts, relevant code locations, and the specific questions to answer. **Don't include Claude's own leaning**, so the participants don't just go along with it. Before reading any participant's result, Claude writes its own proposal to a file (scratchpad directory or system temp directory), so it isn't swayed the other way either. Then, going by `resolved_levels.discuss.<level>`, start one `discuss` per participant: the same brief (in role mode, the same shared body with each participant's own role card at the end), the same `--group` (a short title plus the date, such as `config-rework-1013`; a different name for each discussion within a conversation, kept for its later rounds), and `--agent <name>` for each, all started in the background in the same message. When the level has only one participant, `--agent` and `--group` can be left out.
2. **Round 2, critique each other**: only when the proposals (Claude's included) really disagree, or a participant's conclusions include something Claude hasn't checked that would change the outcome; if they broadly agree, go straight to deciding (role mode has its own trigger, see `references/roles.md`). Label the proposals anonymously as "Proposal A / Proposal B / …" and continue each participant with `resume --run <that participant's round 1 run_id>` (again in parallel, in the same message), asking it to find the weakest points of the other proposals and compare them with its own. Send only summaries and the points of disagreement, not the full reports. Claude also writes up its challenges to each proposal.
3. **Round 3 and later (optional)**: only when a key disagreement is unresolved, another round could really change the conclusion, and the round limit isn't reached. If the script refuses the resume, rule on the results you have.
4. **Claude decides**: accept or reject each participant's points with reasons, and settle the final plan. Judge by evidence, constraints and reversibility; a conclusion all participants share can still be wrong.

- **Level 1 (a one-off question) keeps it short**: no need to write down your own proposal first, no round 2, and no decision record; check the participants' answers, then tell the user the conclusion and its basis plainly. Attachments, the live view and busy handling work as usual.
- Later rounds keep round 1's level. Each participant has its own run_id, and the round limit applies to each participant separately. Each participant takes one of its own agent's parallel slots; if one is refused because its agent is at the limit, start it again once that agent's running tasks finish rather than skipping it.
- If one participant fails (for example `quota_exhausted` from a low balance, an API error, a missing key, or `cancelled` because the user stopped it), the others carry on: tell the user which one failed and why, and continue with the other participants' results. Don't change the config just to get every participant in.
- Discussion is read-only: Codex can read code and run read-only commands to back up its points, but can't change files. If `warnings` says Codex changed files, check the diff and revert what Codex changed. Don't revert changes of unknown origin listed in `notes`; most likely someone else made them. API, opencode and pi agents can't change files.
- Discussions get the live view too (see "Live view" under "3. Hands-on work").

### When an API participant is busy
When an API agent's service is busy, the request waits in the server's queue without starting, and the server may eventually drop it. Don't leave the user waiting:
- When a discussion you start (or resume) has an API participant and `effective.dispatch.busy_ask_min` is above 0, also start `await-busy --group <name>` in the background right away (use `--run <run_id>` when the level has a single participant and no group). It sends no requests; it exits when a participant has been queued longer than `busy_ask_min` minutes, or when they've all finished, and you're notified when it does. The "Queue check" line the script prints at startup gives the full command.
- When it exits, read its output. If `busy` is empty, there's nothing to do. Otherwise Claude decides directly, without asking the user:
  - If the other participants already have usable results, or this one has been queued for over 10 minutes: run `cancel --run <run_id>` to stop it and go ahead with the other results. Its result is marked `cancelled`; say it's missing when you decide.
  - Otherwise wait 5 more minutes: start `await-busy --run <run_id> --after <minutes queued so far + 5>` in the background, and stop it if it's still queued then.
  - Afterwards, tell the user in one sentence which participant was stopped and why.
- The user can also press x in the live view to stop a queued model, which does the same as `cancel`. Carry on as usual when a result comes back `cancelled`.

### Reporting to the user: the decision record
Don't paste the raw exchange. Write it up plainly as follows (not needed for level 1 questions):
- **Topic**: one sentence
- **Options**: Claude's and each participant's, each with its core idea and trade-offs
- **Each participant's main points**: listed per participant, called by model name (such as gpt-6-astra, deepseek-v4-pro), each marked ✅ accepted / ❌ rejected / ⚠ partly accepted, with the reason
- **Final plan**: and what changed from Claude's original proposal
- **To confirm**: things the user needs to decide or that need checking first
- Each participant's run_id, model, effort and token use, so the user can look at the raw record
- Role mode adds the assignment table, the role cards and any missing viewpoints, and names each point "model [role]"; see `references/roles.md`

### After the discussion
- If the user only asked for advice: stop at the decision record and let them decide whether to go ahead.
- If the user wants the thing done: when the final plan has nothing the user needs to decide, carry on with the final plan into "2. Who does what" and "3. Hands-on work"; anything involving business trade-offs, preferences, risk tolerance, wider scope, extra spending or irreversible steps goes to the user first. Don't decide those for them.
- If the discussion was about the result of changes already made: when the conclusion is a different way to reach the same goal, `resume` the original agent for a rework (it counts as one, see "Rework and failures"); when the direction or goal changed, treat it as a new task and level it again; when the result is already good enough, level the review under "5. Review".

## 2. Who does what
Decide who does a piece of hands-on work in this order:
1. **Work only Claude does**: key decisions and overall planning (what to build, how to structure it), creative design (UI and visuals, copy, ideas), and the writing listed under "Claude owns all text meant for people" below. Outside models are weak at design, front-end polish and writing, so none of this is handed off, whatever its level.
   - **Drawing illustrations isn't part of this**: illustrated content that has to be drawn, such as characters, mascots, scenes and illustrated icons, goes to an image-capable agent under point 2 even when the deliverable is SVG, HTML, canvas or an animation, and is then used in the work. The exception is characters and objects that bend at joints, touch things drawn in code, or move as several parts put together: Claude draws those as SVG (see "The boundary" under "Generating images"). Claude decides the style and writes the code (layout, animation, interaction).
   - **The front-end line**: decisions about layout, color, type, spacing, motion and how interactions feel, and page work that needs tuning by eye, are Claude's; the logic built to a design Claude has settled or to existing component patterns (state, data fetching, form validation, API wiring, tests) is levelled as hands-on work.
   - **Mixed tasks**: when a piece of work has parts only Claude does (design decisions, copy, names) and parts that can be handed off, Claude settles the former first and writes them into the brief, then levels the rest as hands-on work.
2. **Work only an image-capable agent does**: visual content a model has to draw or redraw, such as photos, illustrations, textures, sprites, covers and hero images, characters and scenes, assets to be cut into single pieces or turned into SVG (including illustrations used as whole pieces in SVG, HTML and canvas work and animations), removing the background from an existing image, and changes to existing images. Only agents with `capabilities.images` set to `true` can make images (currently the `codex cli` type), so this work ignores who the config gives the level to and always goes out with `--agent <its ID>` (asking first when `dispatch.auto` is `false`). If the config has no such agent, tell the user it can't be done this time; don't patch it together some other way. Claude still decides what the image shows; the deterministic work after generation, such as removing backgrounds, splitting parts and vectorizing, Claude does with the `assets` subcommand instead of handing it out. See "Generating images" below.
3. **All other hands-on work**: give it level 0–3 by the criteria in "3. Hands-on work". Claude does level 0 itself; for levels 1–3 look at `resolved_levels.run.<level>`: if it says `"claude code"`, Claude does the task itself (the script also refuses to hand off that level); if it names an agent, hand the task off. When the user explicitly wants it handed off (for example by naming it with `/foreman-en:run`), skip the level 0 check and hand it off even if the level is `"claude code"`: add `--agent <agent ID>`, picking one whose `capabilities.modes` includes `run`; the effort uses the built-in default, and `--model` picks another model.

### Claude owns all text meant for people
Outside models write weakly: piles of jargon, stiff phrasing, roundabout sentences that readers struggle with. Claude is responsible for any text meant to be read by people:
- **Claude writes it, doesn't hand it off**: READMEs, usage guides, design docs, reports and summaries, user-facing UI text. This work is mostly writing, and reworking an agent's version costs more.
- **Settle it in the brief before handing off** (in the "Names and text" section):
  - Give the names of new files, modules, classes, functions, key parameters and settings as a list. Anything not on the list follows the project's existing style.
  - Say where comments go and what they say, in the same language the project uses.
  - For logs, error messages, command-line help, output headers and other text people will see, give the exact wording or a template and require it to be used as is.
- **Check it when reviewing**: are names plain and consistent; can comments and messages be understood at a glance; any wordiness, stiff phrasing or over-commenting? Fix small problems yourself without a rework. If there are many text problems, put the corrected wording in the rework brief.
- **Relay to the user**: digest the agents' reports, review findings and open issues, and tell the user in plain words. Don't paste them as is.

### Generating images
To split an image into parts, turn it into SVG, make transparent assets, edit an image or generate from a reference, read `references/image-assets.md` first (prompt templates, background choices, slot templates, whole image first or a parts sheet directly, partial rework).
- **Scope**: what a model has to draw comes here, whether the deliverable is a bitmap or SVG, HTML, canvas or an animation: photos, illustrations, textures, sprites, hero images, characters and mascots, scenes, illustrated icons, the visuals of UI components. When it goes into code, cut it after generation with `assets cut` into named single pieces (whether to turn them into SVG: see "Vectorizing"), which Claude then builds into the page or animation; don't generate a "reference only" image for Claude to redraw by hand.
- **The boundary: only images that stand on their own**: image models are good at pictures seen on their own and bad at pictures that must line up exactly with something else. Tests in October 2026: joint pivots, contact with things drawn in code (a foot on a pedal), seams between two generations, and one scale across separately drawn parts were often off by a sizable fraction of the part's length, and better prompts or pose guides didn't fix it. So:
  - Generated assets only move as whole pieces in the work: move, rotate, scale, fade, or swap for another complete image (a new background, a prop in another state). Don't split them at joints or into segments, don't put several generated assets together into one moving whole, and don't generate frames meant to line up with things drawn in code.
  - Characters and objects that bend at joints, touch things drawn in code, or move as several parts put together are drawn by Claude as SVG. Before starting, tell the user: the generated version looks more polished but can only move as a whole; for these motions it has to be hand-drawn. If the user picks the generated version, design the motion so it moves as a whole.
  - When the user explicitly wants frame-by-frame sprite animation (a looping motion that touches nothing else, like a desktop pet), it can be tried; say first that it's experimental. See "Using it in SVG, HTML and animations" in `references/image-assets.md`.
- **Decide per element**: in one piece of work, each visible element is decided on its own. These are not generated and everything else is: the characters and objects Claude draws as SVG under the point above; shapes the work needs simulated by physics every frame (simulated hair and cloth, procedural ropes); things tied to mechanics or physics (chains, gears, cranks turned by calculation); text; UI controls such as buttons and inputs; geometric line icons, charts and flowcharts. Elements that aren't generated follow the generated image's colors and line style so they match. When the user explicitly asks for hand-written SVG or pure code, don't generate images.
- **Who does what**: Claude decides what to draw: subject, style, purpose, aspect ratio, the parts list and names, the palette and the reference images; for any text in the image, give the exact wording and require it to be used as is. Codex only generates. Removing backgrounds, splitting parts, naming, reducing colors, vectorizing and checking are done by Claude running the `assets` subcommand locally (see "How to call it"), not handed out and not given to Codex. Never use a script to fake what the model should draw, but scripts may process what the model drew.
- **Level**: image quality depends on the image model, not much on reasoning effort, so `simple` usually fits. If the same task also changes code (such as wiring the image into a page), pick the level for the code part.
- **Brief**:
  - Spell out the call. A new image: `tools.image_gen__imagegen({prompt, transparent_background})`. Editing, generating from a reference, splitting or layering: also pass `referenced_image_paths: ["<absolute path>", …]` and refer to them in the prompt as "Image 1", "Image 2" in order. Without this argument the tool generates from scratch and the reference has no effect (even if Codex looked at it with view_image first). Use `num_last_images_to_include` only when a reference has no local file; never pass both. Reference images are uploaded to the model service, so don't use sensitive or unlicensed ones.
  - Don't give pixel sizes: the tool has no size argument and only produces a few sizes of about 1.57 megapixels. Give the aspect ratio (1:1, 3:2, 2:3, 3:1); for other sizes, use the SVG or scale when delivering.
  - For assets that need a transparent background, set `transparent_background: true`, and write the background, spacing, style and exclusions from the templates.
  - Two or more parts: generate a numbered slot template in the project with `assets template`, pass it as Image 1, and say "put X in slot N, don't draw the slots or numbers"; the cut then names parts by slot. Don't name parts by their order on the sheet: the model reshuffles them.
  - Give the path in the project for each image; copy the original as is, without converting or compressing. Unless the user asks for variants, generate each source image once.
- **Checking**:
  1. `generated_images` in the result lists the original files of the images that appeared in this round, and `image_calls` lists the arguments each image call actually passed (read from the Codex session log). If a step that needed a reference has no `referenced_image_paths` in `image_calls`, the reference had no effect, so rework it (`warnings` points this out). If both fields are missing, where the image came from is unverified; look at the run folder and output before concluding anything.
  2. For assets to be cut or vectorized, run `assets cut`: anything `fail` in its `checks` goes straight back for rework; Claude judges the `needs_review` items by looking.
  3. Open the image with Read (for cut assets, the `sheet.png` contact sheet): is each slot the right part, are details, style and colors right, is any text used as given.
- **Rework**: generate each source image at most twice (the first time plus one rework). If it still isn't right, stop and give the user the problem, what was tried and the options; images don't follow the "Claude takes over" rule in "Rework and failures", since Claude can't draw bitmaps. For a partial fix, pass the original as the reference and say "change only X, keep everything else"; when delivering, replace only the changed part and keep the files of the other parts from the previous version.
- **Vectorizing**: turn only flat assets with few colors (icons, props, flat illustrations) into SVG. Characters and images with gradients or much detail come out large and banded (one anime head measured 384 paths, 170 KB), so keep them as PNG by default, embedded with `<image>` in the SVG or page, and tell the user that part isn't pure paths. `assets cut --vector` needs two native packages. If they aren't installed, ask the user first; if they agree, run `assets setup` (it installs into `~/.claude/foreman/tooling` under the user folder, not the plugin folder or the user's project); if not, deliver PNG parts and the manifest only and say they weren't vectorized.
- An image takes tens of seconds, so the live view sitting on the previous step meanwhile is normal; once the image is ready, a "Generated image …" line appears in the timeline.

## 3. Hands-on work (/foreman-en:run)

### Levels
**The level depends on how much judgment the task needs and how costly a mistake would be, not on how much it changes**: changing 20 files by mechanically renaming from a list is `simple`; changing the interfaces between modules is `complex`; a bug with an unknown cause is `complex` even if the fix is a few lines.

| Level | How to tell | Examples |
|---|---|---|
| Level 0 | Done in one place with no design needed, where writing a brief and checking the result would take more effort than Claude making the change | Fixing a typo, changing one config line, renaming within one file, adding a missing import; small touch-ups during checking and rework |
| Level 1 `simple` | The method is already settled, almost no judgment is needed, and the result can be checked item by item | A small feature or script with a clear approach, a small fix whose change is already clear, filling in similar code from an existing pattern, bulk renames or replacements from a list, format or folder migrations, running existing scripts to tidy data |
| Level 2 `normal` | There's a spec or the cause is known, but the approach and local details need designing; mistakes show up easily in tests or when it runs | Implementing a feature to spec, writing scripts and tools, fixing a bug whose cause is known but whose fix needs designing, routine refactoring, adding tests |
| Level 3 `complex` | Any one of: the cause is unknown and needs investigating; a mistake wouldn't easily show up in tests and would be costly; the interfaces or contracts between modules change; performance or concurrency work that needs repeated trade-offs and checks | Bugs with an unknown cause, money and billing calculations, data migrations, permission checks, cross-module interface changes, performance work, concurrency |

- **Keep level 0 strict**: don't count level 1 work as level 0 just because handing it off is a hassle. If the user gives `simple` to an agent, they want small work handed off too. When unsure, use level 1.
- For a specific effort or model the user asks for, see "How to call it" at the end.

### Writing the brief
The more specific, the better the agent does. Use this structure:

```markdown
# Goal
What to build and why (a sentence or two of background).

# Scope
- May change: specific files or directories
- Read-only reference: related files
- Don't touch: …

# Size
Roughly how many lines and files the change should be, and what isn't needed this time, such as command-line options, settings, compatibility with old data, or tests.

# Requirements and constraints
Interface signatures, data formats, existing patterns and helpers to reuse, performance needs, compatibility, etc.

# Allowed adaptations
Things the agent may handle without stopping to ask. For example:
- If the given test entry point won't run, use an equivalent one that covers the same tests
- May fix a particular test fixture, but must not weaken any assertion
(Write "none" if there are none.)

# Names and text
- Names: what new files, classes, functions, key parameters and settings are called
- Comments: where they're needed and what they say
- Messages: exact wording or templates for logs, errors, help text and output headers (to be used as is)
(Leave this section out if the task doesn't involve any of these.)

# Don't
Things off-limits for this particular task.

# Done when
What counts as finished, and which commands to run to verify it (give the actual commands).

# Report
Anything that needs special mention in the report.
```

Agents tend to do everything and do it heavy: even simple tasks get extra options, settings, abstraction layers, compatibility branches and lots of tests. The "Size" section is there to prevent this: state the expected size and what isn't needed, and check against it when reviewing. The standing rules the script appends also say "keep to the size, only necessary tests, don't code defensively"; repeat it in the brief when the task invites overdoing it. Keep the brief itself in proportion too; don't write pages for a simple task.

Grant "Allowed adaptations" by meaning, not by size: a one-line change can move an out-of-sample boundary, a fee rate or an assertion. Anything beyond the scope that isn't in this section makes the standing rules tell the agent to stop and ask in the report's `decision_requests`. Write foreseeable environment problems (such as a same-named `tests` package in the project) into this section up front to save a stop.

### Splitting work to run in parallel
Most of the time an agent's run takes goes into the model thinking, and only a small part into running commands. So splitting a big task across several sessions running at once noticeably cuts the wait. The cost is more tokens in total (each session reads the background on its own), and Claude has to write more briefs and check more results.

**When to split**: only when **all** of these hold; otherwise hand it off as one task:
1. It splits into 2 or more parts, no more than that agent's parallel limit (`agents_status.<ID>.max_parallel`, 4 by default; that agent's runs from other sessions take slots too); the parts **write to no shared files** and **don't depend on each other's output**.
2. Claude can settle the interfaces between the parts (function signatures, data formats, file paths) before handing off, and write them into every brief. If they can't be settled, don't split.
3. Each part is expected to take more than 10 minutes. For small tasks, the fixed overhead outweighs the time saved.

**Don't split**: bugs with an unknown cause that need investigating; refactors that touch shared core files; research stages that build on each other; work that needs one consistent design; tasks that are mostly heavy computation (running them at once fights over the CPU; have the agent write a batch script that runs them in parallel instead). Good cases: several independent scripts or modules; once the interface is set, one part writes the implementation and another the tests; bulk changes split by folder.

**How to hand it off**:
- Level each part by its own difficulty. If a part is level 0 or its level is `"claude code"` in the config, Claude does that part itself, also staying out of the other parts' files; hand off the rest as usual.
- Give the group a name (a short title plus the date, such as `factor-scripts-1013`; use a different name for each group within a conversation; names repeated across conversations are fine, since the view only counts runs from the current conversation; only letters, digits and `. _ -`, because the live view puts it on a terminal command line, and the script rejects other characters) and hand off each part with `run --group <name> --scope <path it may change>`; `--scope` can be given more than once. Start the parts together in the background, in the same message.
- The script refuses two cases: the agent already has as many runs in progress as its limit allows (counted across all groups and sessions), or the write scope overlaps with a run in progress in the same group. If refused, split the scope again as the error says, or wait for an earlier run to finish.
- Besides the general structure, each brief says: what the other parts of the group do and which files they change (those files are off-limits); the shared interface agreements (copied word for word into every brief); how to verify this part on its own.
- Open just one live-view tab: `watch.mjs --group <name>`, titled "Group: <name>".
- Tell the user how many parts there are and what each does, with the model and effort of each.
- **Checking**: check each part on its own, and send back only the parts that fail (resume keeps the group and scope). Once all pass, Claude does an **overall check**: run the full tests or scripts on the combined result, since each part was only verified on its own. In the report, list each part's run_id and token use, then the total.

### Research and analysis tasks
Research tasks are work whose conclusions rest on experiments and data, such as strategy and factor research, data analysis, comparison experiments and performance investigations. The risk here isn't buggy code; it's conclusions that go beyond the evidence.

When handing research off, the brief must cover the items below on top of the general structure. If an item doesn't apply, say so and why instead of leaving it out. Questions and hypotheses already settled in a discussion go straight in; don't discuss them again.
- **Questions and hypotheses**: the questions to answer, and each hypothesis with the criteria for judging it. Fix the criteria in advance; don't change them after seeing results.
- **Controls**: which controls and baselines are needed, and what each one answers.
- **Robustness**: how to check that a result isn't a fluke of one parameter point or one period, for example parameter neighborhoods, splitting time periods, different starting points.
- **Confounders**: list what could distort the conclusions, and require each to be ruled out or explained as not applicable. Common ones: capital or size path (changing capital, round-lot limits), sample exposure (choosing after seeing results), multiple testing, survivorship bias, changes in how data is defined.
- **Statistics**: how to judge whether a difference is significant, and how to correct for comparing many groups.
- **Deliverables**: the evidence behind each conclusion (files, numbers, a way to recompute it), and anything that couldn't be verified.

**Evidence review before conclusions are recorded**: before research conclusions go into long-term records, reports or docs, or are handed to the user as settled, whoever did the research, start a level 3 discussion as an evidence review (in a new session, not the one that did the research): the topic brief lists each conclusion with where its evidence is and the key numbers; ask the participants to judge each one: is the evidence enough, does it overstate, are there uncontrolled confounders, does it hold up statistically; Claude rules on each point as in the discussion process and corrects the conclusions before recording them. If a conclusion already recorded is overturned, correct it with an appended revision rather than editing the original.

### Handing it off
- Write the brief to a UTF-8 file first (in the scratchpad directory if there is one, otherwise in the system temp directory), then start `run` in the background (Bash `run_in_background`); you get notified when it finishes. Do other things meanwhile; don't poll. The script appends standing rules: stay in scope, do a preflight check, when to stop and ask, only necessary tests, no commit/push, no secrets, report in the schema.
- **Tell the user in the chat which model and reasoning effort it uses**, for example "Handed off: gpt-6-astra (Codex CLI, effort max), level complex". Take it from the first line the script prints ("<mode> started | <model> (<channel>, effort …) | level … | run dir …"), not from your own reading of the config. If the model comes from Codex's config, say so. The same goes for discussions, reviews and resumes; for a discussion with several participants, list each one. Repeat it in the final report.
- **Your very next step after starting is the live view** (below), even for tests, small tasks and reviews.
- Several runs can go in parallel, but their file scopes must not overlap. **Claude doesn't touch files an agent is changing.**
- If the allowed scope includes paths ignored by `.gitignore` (such as `tests/` or a results folder), pass them with `--track "<path>"` (can be given more than once); otherwise change tracking can't see those files. Resume keeps the previous round's `--track`.
- When Codex's sandbox isn't `read-only` / `workspace-write` (for example `danger-full-access`), `--cwd` **doesn't limit what Codex can write**. The scope is then held only by the brief and by reviewing the diff afterwards.

### Live view (every handoff)
Whenever work goes to another model, that is, right after starting `run`, `resume`, `discuss` or `review` in the background, let the user see live progress. If `dispatch.watch` is `off`, skip this section and just tell the user they can check with `/foreman-en:watch`.
- **Open the terminal panel first, then the tab** (Claude desktop app): first call the tool that shows panes (its name contains `show_pane`; load it together with `run_in_terminal` in one ToolSearch) with `pane` set to `terminal` and no `tab_id`; once it returns, open the tab with `run_in_terminal`. While the panel is open, a newly opened tab comes to the front by itself, so the user sees watch's few-second intro from the start; the other way round, opening the tab first and showing the panel afterwards, there are often more than ten seconds between the two calls and the intro has finished by the time the panel appears. If there's no tool that shows panes, just open the tab.
- **Open it with `run_in_terminal`**: run `node <run dir>/watch.mjs --run <run_id>`, titled "<model>: <short title>". For a discussion with several participants in one group, open a single tab: `node <run dir>/watch.mjs --group <name>`, titled "Discussion: <short title>"; title a review's tab "<model>: review <scope>". The run directory defaults to `~/.claude/foreman/runs`, written as `C:\Users\<username>\.claude\foreman\runs` on Windows; go by the `config` output. The script generates this launcher so that `run_in_terminal`'s ASCII-only rule is met even when the plugin path has non-ASCII characters. If `watch_launcher_ascii` is `false` in the `config` output (the run directory path has non-ASCII characters), `run_in_terminal` will refuse the command: send the user the command in a code block instead, ask them to run it in their own terminal, and pass on the fix from `watch.fix` in the `check` output.
- The run_id is in the first line of the background output ("run dir …/<run_id>"). Without `--run`, watch follows whichever run is in progress, but other sessions may be running tasks too, so pass it when you can.
- Once the tab is open, call the tool that shows panes again with `pane` set to `terminal` and `tab_id` set to the tab_id you just got, so the panel stays on that tab (this brings it back if the user switched the panel away in the meantime or another panel covers it). Then send the user the tab link `[<title>](#terminal/<tab_id>)`.
- **If `run_in_terminal` isn't available** (for example in the Claude Code CLI), send the user the full watch command in a bash code block and ask them to run it in another terminal.
- When a discussion has API participants, also start the queue check `await-busy` in the background (see "When an API participant is busy").
- When the run ends, watch exits on its own and the tab stays for the user to look back at; don't close it. A tab whose watch has exited won't show new runs, so for every resume (a discussion's next round, a rework) open a new tab as above; a discussion's next round still uses `--group <name>`, titled "Discussion: <short title> (round N)".
- The default view is concise. Add `--verbose` when the user wants every detail.

### When an agent needs an answer
Runs are unattended: nobody can answer an agent while it runs. The script makes sure no agent gets stuck waiting: Codex needs no approvals by default; opencode gets no question tool and no permissions that need confirming; pi has no question tool, and the guard extension foreman injects only allows the tools the task needs; a CLI added later that prints a "(y/n)"-style prompt and then goes quiet is stopped after 3 minutes with the status `needs_input`.

Every question is collected in the result's `questions`. When `needs_decision` is `true`, something needs deciding; the run has finished, it isn't stuck.

**Claude decides these directly, without asking the user.** Write the decision into the resume brief and continue with resume; Claude can also do a small finishing step itself.
- Technical approaches and trade-offs within the user's existing authority and the task's scope;
- Contradictions or gaps in the brief: these are usually Claude's own brief, so clarify what was meant;
- Missing material or information: Claude looks it up and passes it on.

**Leave these to the user,** with the question, the options and Claude's recommendation: business trade-offs and preferences, risk tolerance, widening scope or authority, extra spending, irreversible steps.

By `source`:
- `decision_request`: a question returned in a hands-on report. `recommendation` says which option it already went with. If Claude agrees, nothing changes; if not, say what to change in the resume brief.
- `permission_denied`: an action the tool tried was blocked by permissions, for example opencode reading a file outside the project, or a pi action stopped by foreman's guard. The permissions are a deliberate boundary, so don't change the config to let it through; read the material it needs yourself and put it in the resume brief, or attach it with `--file`.
- `final_question`: the final answer is a question, not a report. Claude answers it and resumes, asking for the report in the required format.
- `input_prompt` (status `needs_input`): the tool is waiting for terminal input. Look at the prompt: if Claude can decide it under the rules above, resume and write the answer in the brief; otherwise leave it to the user.
- `asked_mid_run`: a question asked mid-run that nobody answered; it carried on with its own judgement. When checking the work, compare the approach it chose against the report, and treat it as a rework if it's wrong. These don't count toward `needs_decision`.
- `open_question`: an open question in a discussion report; handle it as part of the discussion process.

A resume to answer questions doesn't count as a rework.

## 4. Checking the result and rework

### Checking the result (every time)
1. Look at `status` and `report.status` first. If it isn't `completed`, read `open_issues` first.
2. Read `run_dir/diff.patch` and compare it with `changes.files`:
   - Any files changed outside the scope? Does `report.files_changed` match the actual changes?
   - For files with `by` set to `reported`, check the diff to confirm they are changes this task should have made. Files with `by` set to `unknown` may have been changed by Claude itself or another session, or written by the agent with a command it didn't report. Find out who changed them first; **don't just revert them**. Those marked with `group_run` are inside the write scope of another run in the same group, so most likely that run changed them; review them with it.
   - Is the logic right? Any defensive overkill, needless abstraction, redundant tests?
   - **Was it overdone?** The change is clearly bigger than the "Size" section expected (say, more than twice), or it adds options, settings, abstraction layers, compatibility branches or tests nobody asked for. Trim small things yourself; if there's a lot, use resume for a rework and list what to remove in the rework brief.
   - Do names, comments and messages follow the brief, and are they plain and readable (see "Claude owns all text meant for people")?
   - Only changes inside the working directory are tracked; if the task involved paths outside it, check those separately.
3. **Actually run it**: build, run the tests or the script itself. Don't rely on the agent saying it passed.
4. **Take a closer look at runs without an OS sandbox** (`isolation` is `tools` in the result; currently opencode and pi):
   - With `run_access` set to `edit`, it can't run commands: Claude runs every test and script itself, and a report saying "passed" counts for nothing.
   - With `run_access` set to `shell`, its commands can reach outside the working directory, where change tracking can't see. Go through the diff file by file; if the task touches outside paths, installs dependencies or goes online, check what it actually did (`opencode.jsonl` or `pi.jsonl` in `run_dir` has every command it ran).
   - Write-tool events count as evidence of who changed a file (`by: agent`); files the report merely claims don't.
5. Once it passes (including after any rework), you usually level the review under "5. Review" next; if the result still needs discussing with other models, level that discussion under "1. Settling the approach" first. If the review is level 0, report to the user.

### Rework and failures
- If it isn't good enough, use `resume` for one rework, with a brief that says exactly what's wrong and how to fix it. If the cause was underestimating the task, move up one level for the rework (simple → normal → complex); if that level is `"claude code"` in the config, don't resume, and Claude takes over instead. Otherwise keep the same level.
- If it still isn't good enough after the rework, or the agent times out or errors, Claude takes over and finishes it, and tells the user why. Images are the exception; see "Rework" under "Generating images".
- A `stalled` result (stuck: no activity for over `dispatch.stall_min` minutes and no command running, so the script stopped it; the minutes are in the `config` output) is usually a temporary network or service problem. `resume` once to continue from where it stopped; if it stalls again, Claude takes over. `--stall <minutes>` changes the threshold and `--stall 0` turns it off. The total time limit is `dispatch.timeout_min`; change it with `--timeout`.
- If you suspect a run is stuck, run `status` and look at "last activity X min ago" and the current step instead of guessing. Long gaps between events are normal while a command is running (such as a big computation). `interrupted` means the dispatcher process is gone (for example the session or app was closed); Claude won't get a completion notice, so check `status --run <run_id>` by hand and decide whether to resume or start over.
- When `needs_decision` is `true` (including `report.status` set to `blocked`, and the status `needs_input`), follow "When an agent needs an answer".
- A `quota_exhausted` status means the quota is used up: the plan quota for Codex, or the account balance for an API agent. Don't retry, and don't switch to Claude redoing the work on your own. Tell the user the quota is used up and when it should reset (`quota_resets_at`), and let them decide whether to resume once it resets or have Claude take over.
- When Claude takes over a run, or the user decides to drop it, and its status is `interrupted`, `stalled`, `timeout`, `quota_exhausted` or `needs_input`, run `cancel --run <run_id>` to mark it handled: the session-start reminder only lists hands-on runs that haven't been handled.
- If the reminder at the start of the session lists runs that didn't finish normally, mention it to the user at a suitable moment and handle them as the user wants.

## 5. Review (/foreman-en:review)
Before delivering changes, whether an agent or Claude made them, level the review by the risk of the change once it has passed checking:

| Level | How to tell |
|---|---|
| Level 0 | Small changes, docs, comments, styling, copy, pure configuration; one-off scripts or prototypes already run and checked; low-risk changes with test coverage. Claude's check is enough; no outside review |
| Level 1 `simple` | Large but mechanical changes, such as bulk renames and replacements or folder migrations |
| Level 2 `normal` | Larger ordinary features and fixes (roughly 300 lines or 5 files or more); level 3 hands-on work Claude did itself (including when the config gives that level to Claude) |
| Level 3 `complex` | High-risk code: money and billing, deleting or migrating data, concurrency, auth and security, irreversible operations; fixes for bugs whose cause was unknown |

- When several levels fit, take the highest. From level 1 up, Claude asks for the review on its own (asking the user first when `dispatch.auto` is `false`; see "Permission").
- When the user uses `/foreman-en:review` or explicitly asks for a review, do it directly without the level 0 check, picking level 1–3 from the table.
- When `resolved_levels.review.<level>` is `"claude code"`, that level gets no outside review; Claude reviews it carefully itself, and handles what it finds as in "After the review".
- Evidence reviews before research conclusions are recorded are done as a discussion; see "Research and analysis tasks".

### How to review
- Review changes an agent delivered with `review` in a **new session**; don't have it review its own work in the session that did it.
- When the reviewer and the agent that did the work use the same model (for example both are configured to the same model), review as usual without switching to another agent, and say in the report that it was the same model in a new session.
- Always pass a review brief with `--brief` (intent of the change, risky spots, what to focus on). Without one, Codex runs its built-in review, which is in English and doesn't follow these review rules; opencode and pi always review the patch the plugin computed.
- The script works out the review scope with git first, matching what Codex's native review means; with no changes at all, it stops with an error instead of handing anything off:
  - `--uncommitted` (the default): staged and unstaged changes plus untracked new files;
  - `--base <branch>`: from the merge-base with that branch to the current working tree, both committed and uncommitted, without untracked files;
  - `--commit <sha>`: the changes that commit introduced.
- The full patch is saved as `review.patch` in the run directory. `review_scope` in the result gives the scope, file count and fingerprint; if the changes moved while the review ran, `warnings` says so, and the review may not cover the latest changes.
- Codex reads the changes itself. opencode and pi get the patch the script computed, plus read-only tools for context, and can't run commands. If the patch is too large (about 200,000 characters), an opencode or pi review is refused: review commit by commit (`--commit`), or give the review to Codex.

### After the review
1. **Verify each finding**: the findings are in the result's `last_message` (reviews have no structured `report`). Only issues that really exist count; drop false positives and say briefly in the report why they don't hold.
2. **Who fixes them**:
   - A review Claude asked for on its own: Claude fixes small issues itself; if there are many, or they touch the logic, put the verified issues in a rework brief and `resume` the agent that did the work, which counts as one rework (see "Rework and failures"). If Claude made the change, Claude fixes it.
   - A review the user started with `/foreman-en:review`: the user only asked for a review, so first tell them the verified issues and how you plan to fix them, and fix once they agree (or if they already said to fix them).
3. **Check again after fixing**: rerun the build, tests or scripts. If the fix changed core logic and the change is level 3, review it once more (again in a new session), at most once; otherwise no second review.

## 6. Reporting to the user
- Which parts agents did: with run_ids, and the agent, model and effort of each call (from `agent`, `model_shown` and `effort` in the result).
- Each call's usage: this call's input and how much was cached, and output (say so when `usage_scope` is `session_total`); include `cost_usd` for opencode and pi.
- The level each stage got, saying which level 0 parts Claude handled itself; attach the decision record of any discussion.
- What Claude checked and how it was verified; whether a review was done and with what result (say so when the reviewer was the same model as the agent that did the work).
- Open issues.
- Digest the agents' reports and review findings and relay them in plain words; don't paste them as is.

## How to call it
The only entry point is `scripts/cli.mjs` in this skill's folder (that is, `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/scripts/cli.mjs`).

- **No exceptions**: tests, checks, trial runs and one-off questions all go through this script too; use `discuss` for read-only questions. The plugin includes a hook that blocks commands calling `codex exec`, `codex review`, `opencode run` or a pi task directly.
- **Stop on sandbox problems**: if the sandbox stops Codex from starting commands or it errors (`notes` in the result says Codex's sandbox couldn't start commands; typical errors are `windows sandbox failed` and `setup refresh had errors`), don't retry, and don't switch the sandbox, edit config files or look for a way around the script yourself. Run `check` first: it tests the sandbox without calling a model, and its `fix` lists the possible fixes. Tell the user the exact error, your assessment and those options, and let them decide. Don't suggest changing `approval`: nobody can approve in a handed-off task, so `never` is right; the problem is the sandbox.

```bash
node "<script path>" run    --cwd "<project dir>" --brief "<brief.md>" --title "<short title>" --level <simple|normal|complex> [--add-dir "<dir>"] [--track "<path>"] [--group <name> --scope "<path>"] [--timeout minutes]
node "<script path>" resume --run <run_id|last> --brief "<rework.md>" --level <simple|normal|complex> [--track "<path>"] [--file "<path>[:start-end]"]
node "<script path>" discuss --cwd "<project dir>" --brief "<topic.md>" --title "<short title>" --level <simple|normal|complex> [--agent <agent>] [--file "<path>[:start-end]"] [--group <name>]
node "<script path>" review --cwd "<project dir>" [--uncommitted | --base <branch> | --commit <sha>] [--brief "<review-focus.md>"] --level <simple|normal|complex>
node "<script path>" status [--run <run_id|last> | --group <name>] [--limit n]
node "<script path>" watch  [--run <run_id|last> | --group <name>]
node "<script path>" config [--cwd "<project dir>"]
node "<script path>" check  [--agent <agent>]
node "<script path>" models
node "<script path>" await-busy (--group <name> | --run <run_id>) [--after minutes]
node "<script path>" cancel --run <run_id>
node "<script path>" assets template --out "<template.png>" --cols <n> --rows <n> [--aspect 1:1|3:2|2:3|3:1] [--names "<name1,name2,…>"]
node "<script path>" assets cut --image "<image.png>" --out "<output dir>" [--slots "<template.slots.json>"] [--names "<name1,…>"] [--matte hard|soft] [--key auto|#rrggbb] [--palette "#rrggbb,…" [--snap]] [--colors <n>] [--vector]
node "<script path>" assets check --dir "<output dir>"
node "<script path>" assets diff --before "<old.png>" --after "<new.png>" [--slots "<template.slots.json>"]
node "<script path>" assets setup
```

- `--agent <agent>` picks which entry under `agents` in the config gets this call. Without it, the one configured for that level is used; it's required when a discussion level has several participants. Which tasks an agent can do is in `capabilities.modes`: `api` agents can only take part in `discuss`; `opencode cli` and `pi cli` agents can do `review` and `discuss`, and `run` too when the config gives them `run_access`. Old IDs from before the upgrade (such as `codex`) still work, and the script says what the new ID is.
- When the user asks for a specific effort ("run it with ultra"), use `--effort <effort>` instead of a level; the model is then that agent's default model under `agents`. Without `--agent`, the agent configured for that level is used; when the level is `"claude code"` or no level is given, the one agent that can do this kind of task is used, and if there are several, `--agent` is required. `--effort` can also go with `--level`: the run goes to the agent configured for that level, with the given effort instead.
- When the user asks for a specific model, add `--model <model>`. It overrides the configured model and works with either `--level` or `--effort`.
- On resume, the model is worked out again from the level you give, so moving up a level for a rework may switch models. If no model is configured anywhere, the previous round's model is kept.
- Who gets the work, the model, reasoning effort, sandbox, approval policy and time limits come from the config file; anything not configured for Codex comes from its own `~/.codex/config.toml`. If you're unsure of the current settings, run `config --cwd "<project dir>"` first.
- `check` tests the environment (Node.js, Git, whether each agent works, efforts, Codex's sandbox), and `models` lists the model lists built into each tool. When a handoff or discussion fails because of the environment (a command not found, not signed in, a 401 from an API, and so on), run `check` first to confirm the cause and pass on the `fix` in its result. For the details of both, how to relay the `summary` overview, and every field of the result JSON, see `references/cli.md`.
- `assets` is the deterministic processing after image generation and calls no model: `template` draws a numbered slot template, `cut` removes the background, splits parts, names them and writes the manifest and contact sheet (add `--vector` for SVG), `check` re-reads the verdict of an existing cut, `diff` compares each slot before and after an edit, and `setup` installs the native packages for vectorizing (ask the user first). Options and outputs are in `references/image-assets.md`.

## Configuration
The user config is `~/.claude/foreman/config.json` and the project config is `<project dir>/.claude/foreman.json`; the latter can only tighten the former. What each setting means and its default are in `references/config.md`; read it when the user asks about or wants to change settings.
- When the script prints "First run: created config file", pass on what it found (Codex, opencode, pi, API keys) and who now gets each kind of task, and suggest running `/foreman-en:setup` to choose models.
- When the script prints that it rewrote the config file in the new format, tell the user: the config uses the new format (`type` is now `codex cli` / `opencode cli` / `api`, `"claude"` is now `"claude code"`), agent IDs were renamed after their models (pass on the list the script printed), the models and efforts actually used are unchanged, and where the original was backed up.
- **On Windows, don't set Codex's `sandbox` to `read-only`**: Codex's Windows sandbox may fail to start even file-reading commands in read-only mode. The read-only requirement for discussions and reviews is held by the rules the script appends, and the script checks afterwards whether any files changed.
- When the user wants to change settings, edit the relevant JSON file, then run `config` to confirm.
