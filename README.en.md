# claude-foreman

[中文](README.md)

![Claude Code × all models: Claude Code commands GPT, Claude, DeepSeek, Gemini and more](docs/images/banner.en.png)

A Claude Code plugin that makes Claude Code the foreman: it plans, decides and checks the results, and hands off hands-on coding work to CLI agents such as Codex, opencode and pi according to your config. It can also ask them for independent code reviews, or gather several models to weigh in on a complex design before Claude Code decides.

- **Claude Code checks the work**: Claude Code reviews every diff an agent hands back, runs it to verify, and sends it back for rework if needed. In discussions, the other models' views are input only; Claude Code accepts or rejects each point on its merits.
- **Your own quota**: agents run on your Codex plan, opencode subscription or API credit, not on your Claude Code quota.
- **Visible all the way**: every handoff says who got it, with which model and reasoning effort, and a terminal view shows each model's progress live.

**Intro video**: [watch on Bilibili](https://www.bilibili.com/video/BV16XJv6pE2S/)

## How it works

The plugin has three modules: **discuss**, **run** and **review**. They have no fixed order: after each step Claude Code decides what comes next and goes into whichever module it needs, so one request can use them in any order and more than once. For example "discuss the approach → run → discuss the result → rework → review", or "run → review → discuss a design problem the review raised → run again".

```mermaid
flowchart LR
    start(["A request comes in"]) --> hub{"Claude Code<br/>decides the next step"}
    hub -- "settle an approach or judge a result" --> discuss["Discuss"]
    hub -- "do the work" --> run["Run"]
    hub -- "deliver changes" --> review["Review"]
    discuss --> hub
    run --> hub
    review --> hub
    hub -- "done" --> report(["Report"])

    classDef claude fill:#EEEDFE,stroke:#534AB7,color:#3C3489
    classDef module fill:#E1F5EE,stroke:#0F6E56,color:#085041
    class hub claude
    class discuss,run,review module
```

Each time it enters a module, Claude Code levels that step by the module's own criteria. Small things not worth an outside model are level 0, which Claude Code does itself; the rest are simple, normal or complex (`simple` / `normal` / `complex`). Which candidate models levels 1–3 have, who is required, and with what effort is up to you in the config, and Claude Code picks from the candidates each time; a level set to `"claude code"` is done by Claude Code itself too. Once something is handed off, a live view in the terminal shows each step the model takes, and at the end Claude Code reports which model did the work and how many tokens it used.

Inside each module (purple steps are done by Claude Code; green ones involve an agent):

**Discuss**

```mermaid
flowchart TD
    d0{"Level the discussion"} -- "Level 0" --> dself["Claude Code thinks it through"]
    d0 -- "Level 1" --> dqa["One model gives a second opinion"]
    d0 -- "Levels 2–3" --> dmode{"Choose the mode"}
    dmode -- "Normal" --> dnormal["Same brief for everyone<br/>independent proposals"]
    dmode -- "Role mode" --> droles["Roles assigned by ability<br/>you confirm in a pop-up"]
    droles --> dcards["Each proposes from its role"]
    dnormal --> dcross["Round 2 critique<br/>when they really disagree"]
    dcards --> dcross
    dcross --> ddecide["Claude Code rules on each point<br/>writes the decision record"]

    classDef claude fill:#EEEDFE,stroke:#534AB7,color:#3C3489
    classDef agent fill:#E1F5EE,stroke:#0F6E56,color:#085041
    class d0,dself,dmode,droles,ddecide claude
    class dqa,dnormal,dcards,dcross agent
```

**Run**

```mermaid
flowchart TD
    r0{"Who does what"} -- "Decisions, design, text" --> rself["Claude Code does it"]
    r0 -- "Drawing (incl. illustrations used whole in SVG animations)" --> rroute["You choose the route<br/>in a pop-up"]
    rroute --> rimg["Image module:<br/>generate and draw cells"]
    r0 -- "Other hands-on work" --> rlevel{"Level the work"}
    rlevel -- "Level 0" --> rself
    rlevel -- "Levels 1–3" --> rrun["Handed off per the config"]
    rrun --> rcheck["Check: read the diff<br/>run it"]
    rimg --> rasset["assets removes backgrounds,<br/>splits and names parts, checks"]
    rasset --> rimgcheck["Claude Code looks at<br/>the contact sheet"]
    rimgcheck -- "Not good enough" --> rimgredo["Change something and regenerate<br/>your call after three tries<br/>with no improvement"]
    rcheck -- "Not good enough" --> rrework["One rework<br/>then Claude Code takes over"]
    rrework --> rcheck

    classDef claude fill:#EEEDFE,stroke:#534AB7,color:#3C3489
    classDef agent fill:#E1F5EE,stroke:#0F6E56,color:#085041
    class r0,rself,rroute,rlevel,rcheck,rasset,rimgcheck claude
    class rimg,rrun,rrework,rimgredo agent
```

**Review**

```mermaid
flowchart TD
    v0{"Level by the change's risk"} -- "Level 0" --> vself["Claude Code's check is enough"]
    v0 -- "Levels 1–3" --> vnew["Another model reviews<br/>in a new session"]
    vnew --> vfix["Claude Code verifies each finding<br/>fixes, checks again"]

    classDef claude fill:#EEEDFE,stroke:#534AB7,color:#3C3489
    classDef agent fill:#E1F5EE,stroke:#0F6E56,color:#085041
    class v0,vself,vfix claude
    class vnew agent
```

## What it does

| Command | What it does |
|---|---|
| `/foreman-en:run <task>` | Hands a task to the configured agent. When it finishes, Claude Code reviews the diff, runs it to verify, and sends it back for rework if needed |
| `/foreman-en:review` | Has an agent review uncommitted changes, a branch or a commit, or existing files, research conclusions with their evidence, and screenshots or playback files. The agent returns a structured list of issues; Claude Code checks each finding and filters out false positives |
| `/foreman-en:discuss <topic>` | Several models each propose an approach to a complex design and critique each other's; Claude Code rules on each point and writes up a decision record; topics with competing goals can use role mode, see below |
| `/foreman-en:watch` | Shows what each model is doing, live, in a terminal, plus a link to the web board when it is on; see below |
| `/foreman-en:status` | Lists recent runs, or shows the details of one, including token use and Codex quota |
| `/foreman-en:setup` | Setup guide: detects this machine's tools, lists the models available, shows the current config and suggested changes, and changes the config the way you choose |
| `/foreman-en:config` | Shows or changes the config |

You can also just ask Claude Code to "check the environment" (`check`: whether each agent works, whether its model supports the configured efforts, and whether Codex's sandbox can start) or to "list the available models" (`models`).

### Without commands

The bundled skill has Claude Code level each discussion, piece of hands-on work and review as it comes up, and start what crosses the threshold on its own:

- Before giving an approach, and when judging the result of work already done to decide what to adjust, talk complex, uncertain questions through with other models first; Claude Code rules on the conclusion.
- Before starting work, hand off hands-on work as the levels and config say; work only Claude Code does (decisions, design, text) and level 0 small things aren't handed off.
- Before delivering, decide by the risk of the change whether another model should review it.
- When a big task splits into parts that don't touch each other, hand them to several sessions at once to cut the wait (each agent's limit is `max_parallel`).

If you'd rather Claude Code didn't start these on its own, set `dispatch.auto` to `false`: it asks you before handing off work, starting a discussion or asking for a review.

Only you type the commands in the table above; Claude Code doesn't call them itself. They mean "you asked for this by name" and skip the level 0 check. When Claude Code starts something on its own, it goes through the plugin's skill, which still levels the step and follows `dispatch.auto`.

### Role-mode discussions

When a topic has several goals pulling against each other (such as security and convenience, implementation cost and user experience, compatibility and a rewrite), a level 2 or 3 discussion can use role mode: each model gets a role card and checks the same topic from one angle, such as architect, math / correctness, fact checker, maintenance and compatibility, user experience or edge-case lister, plus an overall reviewer with no role.

- **Assigned by ability**: first whether the tools can do it (the fact checker has to run commands, so only Codex can take it), then strengths and the model tier: roles that need hard thinking go to strong models first, but the tier is only a guide, not a condition for taking part. Models are sorted into strong, mid and weak tiers from a third-party leaderboard; see [references/model-tiers.md](foreman-en/skills/dispatch/references/model-tiers.md).
- **One model per role first**: when there aren't enough qualifying models, a strong model opens another session for another role; each extra session takes a parallel slot, and its agreeing conclusions still count as one piece of evidence. Mid and weak models can take "breadth seats" that only join round 1, with Claude checking each of their points.
- **Core roles are never merged**: the angles a topic needs most get a seat each, and at level 3 one core role can be played by two different models. The number of seats follows the level's `seats`, and required models always get one.
- **You always confirm first**: before it starts, a pop-up lists the "model → role" assignment, even with `dispatch.auto` on; you can start as suggested, adjust it, or use a normal discussion instead.
- A role only sets what each model checks most closely, not its conclusion; decisions still go by evidence, and several roles agreeing doesn't count as more evidence.
- Custom roles, using role mode by default for some kinds of topics, and a different view of a model's tier can all go in the preference files. The role table and assignment rules are in [references/roles.md](foreman-en/skills/dispatch/references/roles.md).

So that Claude Code doesn't forget (easy when a project has its own skills), the plugin reminds it once at the start of every session and includes your preference files.

### Image assets

Bitmaps are drawn by Codex's built-in image tool, then Claude Code turns them into assets ready for downstream use with the `assets` subcommand on your machine: transparent PNG parts, a manifest listing them by name, a contact sheet, and SVG for flat assets with few colors (one layer per part, which opens in Figma or Illustrator).

- **You choose the route before work starts**: before each new graphic deliverable, Claude Code asks you in a pop-up: ① bitmap, ② bitmap + vector mix (a final image plus hand-drawn pieces that bend), ③ pure vector (a reference image first to set the style), or ④ pure vector / code (no image generation). The pop-up says which model generates and which hand-draws, whether reference images get uploaded, and the rework rule. It asks even with `dispatch.auto` on; rework and partial regeneration of the same deliverable don't ask again, while switching routes, adding a deliverable, widening the scope or changing the model vendor does. The plugin's hook records the route you chose, and the script checks it before an image task goes out: if you cancelled, didn't choose, or chose something else, nothing goes out. This was tested in the desktop app; the CLI hasn't been tested yet.
- **Generating and drawing are the two cells of the image module**: `generate` makes the final image, background plates, local variants and standalone assets; `draw` hand-draws the pieces that bend from the final image, or draws the whole thing on the pure vector routes. There are no levels; a plan made with `plan --module image` goes out with the `image` command. If images get generated outside the image module by a plain hands-on task, the result points it out, and so does an SVG on a pure vector route that embeds a bitmap.
- **In SVG, HTML and animations, every piece comes from one image**: Codex draws only the whole final image (nothing goes further until you've seen and approved it), then edits it into a background plate with the subject removed; every piece of the work comes from that final image. Pieces that move as a whole (a head, a torso, props, a counter) are cut out where they are by Claude Code with `assets layers`; pieces that bend themselves or must touch things drawn in code exactly (bending limbs, tails) go to Codex, which hand-draws them as SVG traced from the final image and writes their deformation, while Claude Code writes the brief and checks the result with its own screenshots (in a comparison the two tied on the metrics, and in a blind review Codex's version looked more natural); shapes simulated by physics every frame, things tied to mechanics, text and UI controls are drawn in code. In testing, the image model couldn't place joint pivots and contact points accurately, and pieces it took out on their own came back enlarged (up to twice the size) with redrawn proportions; pieces cut from the same image meet exactly, with the same line weight. Claude Code tells you before starting which pieces move as a whole and which go to Codex to be traced and bent.
- **Expressions are only patches**: a blink or an open mouth is a local edit of the final image, and only the changed region is laid over, instead of swapping the whole image, which would flicker.
- **Detailed images such as characters aren't turned into SVG by default**: they come out large and banded, so they stay PNG, embedded in the page.
- **Several parts are named by slot**: Codex gets a numbered slot template and draws part N in slot N, and the cut names parts by slot, so a model reshuffling the layout can't mislabel them.
- **Edits and images from a reference**: the brief says to pass the reference through `referenced_image_paths`; if it wasn't passed, `image_calls` in the result shows it and a warning points it out. A partial change replaces only the part that changed.
- **Measured thresholds for regenerating**: when the background plate or an expression edit measures more than 3 pixels off or more than 1% scaled against the final image, when the plate still shows traces of the subject, or when a moving piece in the final image is covered by another, the image is regenerated with a different approach, not patched up later or worked around with a custom registration script. There's no fixed number of generations; it stops to ask you only when three tries in a row don't improve the same problem.
- **Patches, tracing, screenshots and playback checks also run locally**: `assets patch` takes only the changed region of an edited image (a blink, an open mouth), `assets trace` traces a piece that bends from the final image (curved outlines with an even line weight; Codex starts from it when hand-drawing), `assets capture` takes screenshots at given moments with your local Chrome or Edge, and `assets playback` captures one loop of the animation, checks flicker and the loop seam, and makes an APNG you can play.
- **Backgrounds**: transparent by default, with the script cleaning the faint halo at the edges; a flat magenta background when the subject is white or pale.
- **Turning flat assets into SVG needs nothing extra**: the plugin's own tracer draws straight edges as lines and curves as Bézier curves, and the contact sheet shows the SVG rendered back.
- Not supported: pixel art, exact pixel sizes, high-resolution images above about 1.57 megapixels, having the model draw separate jointed parts, and big turns or changes of viewpoint that need a side the final image doesn't show.

Prompt templates, command options and the checks are in [references/image-assets.md](foreman-en/skills/dispatch/references/image-assets.md).

### The live view

- Every run keeps two lines at the top: the model, written like "gpt-6.1-sol max · Codex CLI" (model and effort · how it's reached), colored by status, with the status and elapsed time on the right, such as "running 37:51"; and the task, written like "run · title · complex", starting with the module (run, discuss, review, image), with the round for a resume, and the cell and route instead of the level for image tasks.
- Below that is a timeline: times down the left, with what the model says, commands, file reads and searches, file changes and images generated or opened in order. Only the first few actions between two messages are shown and the rest fold into one line such as "… +9 commands"; files changed one after another share one line; a failed command is marked "✗ exit 1" at the end of its line, and a search that found nothing says "no match". The bottom line shows the latest thinking summary and the keys.
- The view re-flows when the window is resized. Scroll back with ↑↓, PgUp/PgDn or the mouse wheel and press End to jump to the latest; while the run is going, q stops watching and the run keeps going. When the run ends the view stays on screen and can still be scrolled, with the status, duration, changes, token use, cost (at official API prices) and conclusion at the end; after q the full record stays in the terminal. Once the run is resumed (a rework, a discussion's next round), a line above the bottom one names the new run, and n switches to it.
- Discussions, reviews and split hands-on work are shown in one window, one block per seat. The heading reads "discuss · panel · title · normal": the module, the mode (panel for several plain seats, roles for role mode, split for parallel parts), the title, the level and the round, with the count of each status on the right, such as "●2 ✔1". Each block starts with the seat number and a line with the model and its status; role mode puts the role on the next line, and split work puts that part's title and level there. While a seat is working its body shows what it last said, its thinking summary and its latest actions; once it's done, its conclusion. The Claude Code seat comes first (seat 0) and shows its report's conclusion like any other seat.
- Blocks get more lines when the window has room, and you scroll with the mouse wheel when they don't fit. Press a seat's number to open its full timeline and Esc to go back. When an API model is queued because its service is busy, press x to stop it. When the plan is missing a required seat, the gap seat hasn't finished, or the material under review changed during the review, one extra line under the heading says so. When everything has finished the view stays on screen; after q a summary is left behind, with each seat's conclusion, token use and run_id, and one last line with the command to replay a seat.
- The fields the plugin writes itself in the live view, `status` and the start line (status words, durations, model labels, token use, labels and hints) are in English in both plugins, so they look the same; what the models and Claude Code write, task titles included, is shown as written.
- Color only means status: cyan for running, green for done, yellow for questions returned, waiting for an answer or queued, red for anything else that didn't finish. Task lines and model lines are bold, and the model line takes the status color; roles and the titles of split parts are bold; paths, token use, hints and times are dim.
- Add `--verbose` for every detail: the raw reasoning, each command and its output, token use.
- The first time it opens for a newly dispatched conversation, a few seconds of intro play first: the model's pixel avatar, "Starting …" and a few jokes (5 seconds for one model, 10 for a discussion). Any key skips it, and setting `dispatch.intro` to `false` turns it off. The avatar is picked by the model name, with a ??? avatar for anything it doesn't recognize.
- In the Claude desktop app, the live view opens in the terminal panel by itself after each handoff; in the CLI, Claude Code sends you the command to run in another terminal.

### The web board

A second way to watch, alongside the terminal live view, off by default: set `dispatch.web` to `true` in the config, or turn it on with `/foreman-en:setup`.

- **Opening it**: when it's on, every handoff and every `/foreman-en:watch` gives a link besides the terminal tab. It opens in your default browser: you see the star map first, then fly into that conversation's board on your own (a reload goes straight back to the board); it never opens inside the Claude app.
- **The star map**:
  - Every Claude Code conversation on this computer from the last 24 hours is a galaxy, and conversations of the same project gather into a nebula.
  - Agents at work are stars circling their galaxy; a conversation waiting for you has an amber ring; one with a failure keeps a red dot.
  - The table below has one row per conversation: hover a row to highlight its galaxy, click it to fly into that conversation. Each agent's parallel slots are at the top right, each slot lit in the color of the conversation using it.
- **One conversation's board**: click a galaxy or a row in the table, or keep scrolling in on a galaxy, to fly into that conversation's board; Esc, clicking FOREMAN at the top left or zooming all the way out takes you back to the star map. The board shows:
  - cards for Claude Code and each seat, with light paths between the models;
  - animations for the dispatch plan, the cross-check and the verdict;
  - the usage table below (scroll on it when there are many rows) and each seat's terminal (keep scrolling past the end of the usage table).
- **Cost**: the usage table always prices each model at its official API price (hover over it to see this), to compare what the models cost; it may differ from what you're actually charged: Codex and Claude Code on a subscription aren't charged per token, and opencode and pi bill through their own accounts. Claude Code's reports in the conversation and `stats` use the same price table (the plugin's `prices.json`); models missing from it aren't counted, and the total gets a `+`.
- **The board server**:
  - One local process shared by every conversation on this computer, reachable only on 127.0.0.1 with a one-time token.
  - It only reads your conversation records and run records.
  - It exits after 30 minutes with nobody looking and nothing running.
- **Replay (for debugging)**: every link the plugin gives is live. To play a finished conversation back in time to look into a problem, run `node <the plugin's scripts folder>/cli.mjs board --replay <conversation id, run id, group or all>` in a terminal. Add `--speed <N>` to speed it up and `--maxgap <sec>` to shorten idle gaps.
  - It starts a separate, temporary replay server and prints a link. The server exits after ten minutes with no one watching, and leaves the live page alone.
  - Records over 256 MB in total are refused, with the size given.
  - Opening an old-style replay link on the live page shows live data, with a line at the top saying how to replay.
- **Resources**: the server takes about 100–130 MB of memory, and the browser tab about 60–90 MB. On a computer low on memory (under 8 GB in total or under 2 GB available), `/foreman-en:setup` suggests keeping it off.
- **Browser**: it needs a recent browser: Chrome or Edge 111, Firefox 113, Safari 16.2 or later.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 18 or later. If you run Claude Code inside WSL, Node.js must be installed inside WSL too, or the plugin's hooks will error before every command
- Git 2.25 or later, used to track which files the agents changed
- Agents, as many as you like (with none, the plugin still installs and Claude Code does all the work itself):
  - The [Codex CLI](https://github.com/openai/codex), installed and signed in. Recommended; image generation can only go to Codex
  - [opencode](https://opencode.ai) 2.x or [pi](https://github.com/earendil-works/pi), to reach models from many providers
  - API keys for models with an OpenAI-compatible API (such as DeepSeek, Kimi or MiMo); these can join discussions and reviews (text only, no screenshots)

## Install and setup

**We recommend the Code tab of the Claude desktop app.** The plugin is mainly developed and tested there: after each handoff the live view opens in the terminal panel and comes to the front by itself, and the intro is tuned for the desktop app's terminal. The CLI works too, with the same handoffs, reviews and discussions; the only difference is that you run the live-view command Claude Code gives you in another terminal yourself.

In Claude Code, run:

```
/plugin marketplace add DaydayupV/claude-foreman
/plugin install foreman-en@claude-foreman
```

Then run `/foreman-en:setup`. Its output always has the same structure: which tools this machine has, every model available and the efforts each supports, then the current config (who gets each level of each task type, how many outside models each level uses, who is required, which agents aren't used, and anything to watch out for), then suggested changes (including leftovers from older versions that can be removed). After reading it all you confirm or adjust the suggestions in a pop-up at the end, and it changes the config and reports what changed. Run it again after installing a new tool or to change models.

Upgrading from codex-bridge? See [below](#upgrading-from-codex-bridge).

## Configuration

The user config is `~/.claude/foreman/config.json`, and a project config is `<project dir>/.claude/foreman.json`. Edit the file directly, or tell Claude Code something like "use `/foreman-en:config` to switch complex tasks to ultra". Every setting is described in [references/config.md](foreman-en/skills/dispatch/references/config.md).

### First run

On first run, the plugin checks what this machine has, then generates a config:

| Found | Resulting setup |
|---|---|
| A usable Codex (installed and signed in) | Claude Code does simple and normal hands-on tasks itself, and complex ones go to Codex's `gpt-6.1-sol`. Reviews and discussions go to Codex, with `gpt-6-astra` for complex ones. Images are generated by `gpt-6.1-sol`, and pieces that bend are hand-drawn by `gpt-6-astra` |
| No Codex | Claude Code does every task itself for now, and both image cells are off |
| API key environment variables (DeepSeek, Kimi, MiMo) | Added to the config, but not to any discussion yet |
| opencode, pi | Not added automatically; you pick the models |

Choices that cost money or affect safety are never made automatically; `/foreman-en:setup` goes through them with you.

### How the config is laid out

It has three parts:

| Part | What it covers |
|---|---|
| `dispatch` | How the plugin hands off work: whether to do it on its own, the live view, the intro, discussion rounds, time limits, the run directory |
| `agents` | Which agents there are and how to reach them |
| `modules` | Which candidates each cell of each task type has, who is required, and with what effort |

A minimal example: Codex does complex hands-on work and every review, complex discussions add one model from opencode, and Codex also generates images and hand-draws pieces. Anything left out uses its default.

```json
{
  "agents": {
    "gpt-6.1-sol": { "type": "codex cli", "model": "gpt-6.1-sol" },
    "gpt-6-astra": { "type": "codex cli", "model": "gpt-6-astra" },
    "glm-5.3":     { "type": "opencode cli", "model": "opencode-go/glm-5.3" }
  },
  "modules": {
    "discuss": { "simple": "claude code", "normal": [{ "agent": "gpt-6.1-sol", "effort": "high" }], "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }, { "agent": "glm-5.3" }] },
    "run":     { "simple": "claude code", "normal": "claude code", "complex": [{ "agent": "gpt-6.1-sol", "effort": "max" }] },
    "review":  { "simple": [{ "agent": "gpt-6.1-sol", "effort": "medium" }], "normal": [{ "agent": "gpt-6.1-sol", "effort": "high" }], "complex": [{ "agent": "gpt-6-astra", "effort": "max" }] },
    "image":   { "generate": [{ "agent": "gpt-6.1-sol", "effort": "medium" }], "draw": [{ "agent": "gpt-6-astra", "effort": "max" }] }
  }
}
```

- Each key under `agents` is the agent's **ID**, which `modules` and `--agent` refer to. Naming it after its model works best; IDs may use letters, digits, `.`, `-` and `_`.
- Each of the three task types (`discuss`, `run` for hands-on work, `review`) has three levels, plus a level 0 that isn't in the config (see "Task levels" below); images (`image`) have no levels, just two cells: `generate` for image generation and `draw` for hand-drawing.
- Each cell lists candidates. When a cell has several, Claude Code picks by its rules each time: for discussions and reviews, `seats` sets how many per level (defaults in ["Candidates and required agents" in `config.md`](foreman-en/skills/dispatch/references/config.md), not counting Claude Code itself), using different models where possible and all of them when there are fewer candidates; for hands-on work, one agent per piece of work. An entry marked `"required": true` is required and always takes part when the cell is used.
- `"claude code"` means Claude Code does it itself; for reviews and discussions, that cell uses no outside model. `null` turns an image cell off.
- `effort` is the reasoning effort; leave it out for the default. For Codex it's `low` to `ultra`; for opencode, the model's variant; for pi, its thinking level; for API models it's sent as `reasoning_effort` as is.
- Image tasks start with a pop-up where you choose the route, and the route decides which cells are used: a pure vector route that only draws never touches the generate cell, so that cell's required agents don't take part.

The old `levels` form still works: the first time the plugin reads it, it rewrites it as `modules`, keeping every cell's agents, efforts and order, and backs up the original as `config.json.bak`. One thing changes: the models at a discussion level used to all take part, and after the rewrite they're candidates Claude Code picks from. To keep everyone taking part, mark them all `"required": true`; `/foreman-en:setup` can mark them, and it adds the two image cells too.

### The four kinds of agents

| `type` | What it is | Tasks it can do | Reads code itself | Isolation | Whose quota |
|---|---|---|---|---|---|
| `codex cli` | The Codex CLI on this machine | Hands-on work, reviews, discussions, images | Yes | Codex's own sandbox | Your Codex plan or OpenAI API |
| `opencode cli` | opencode on this machine, with the models it can reach | Reviews and discussions; hands-on work once `run_access` is set | Yes | Limited tools only, no OS sandbox | Providers you signed in to in opencode, or an OpenCode Go subscription |
| `pi cli` | pi on this machine, with the models it can reach | Same as opencode | Yes | Same as opencode, with file paths checked by a guard the plugin injects | Providers you signed in to in pi |
| `api` | A model with an OpenAI-compatible API | Discussions, reviews (text only) | No; Claude Code attaches the relevant files | Not applicable | The provider's API balance |

You can have several agents of one type, each with a different model. Codex isn't required.

### Task levels

Each time Claude Code enters a discussion, hands-on work or a review, it levels that step by the kind's own criteria; when the same kind comes up again in one request, it's levelled again. The criteria differ by kind:

| Level | Discussion (how uncertain, how costly a wrong choice) | Hands-on work (how much judgement, how costly a mistake) | Review (risk of the change) |
|---|---|---|---|
| 0 | The approach is clear or you've decided: no outside model | A small change done in one place, quicker to make than to brief | Small changes, docs, styling, config, or low-risk changes with tests: Claude Code's check is enough |
| 1 `simple` | A one-off question that needs a second opinion | The method is settled, little judgement needed | Large but mechanical changes |
| 2 `normal` | A few options to compare, limited impact | There's a spec, details need designing | Larger ordinary features and fixes |
| 3 `complex` | Complex, uncertain and costly to get wrong | Unknown cause, costly mistakes, cross-module | High-risk code: money, data, concurrency, auth |

Level 0 is always done by Claude Code and isn't in the config; which candidates levels 1–3 have, who is required and with what effort is up to you in `modules`, and Claude Code only picks from the cell's candidates. Levels go by judgement and risk, not by how much changes: renaming across 20 files from a list is simple, while changing an interface between modules is complex. Every call that goes out must carry a level; if it's missing, the script errors out rather than quietly picking one.

- To choose on the spot, tell Claude Code "run it with ultra" or "use such-and-such model"; Claude Code adds `--effort` (it only changes the effort) or `--model` (only another model from the same provider).
- When a level is `"claude code"`, you can still explicitly ask for a task to be handed off, and Claude Code names an agent with `--agent`; but not for a cell the project config closed.
- To hand one task to several seats (say, several models discussing one topic), Claude Code first creates a dispatch plan; the script checks that every required agent is in it and that a discussion or review has as many external seats as `seats` says, then each seat is started. If a required model fails or runs out of quota, the task counts as unfinished; another model doesn't stand in for it.
- Level 0 is only for small changes done in one place. By default Claude Code also does `simple` itself; give `simple` to an agent and everything except level 0 changes gets handed off.

### Adding API models

1. **Add the agent**: `{ "type": "api", "base_url": "...", "model": "..." }`. Any OpenAI-compatible API works, such as DeepSeek, Kimi, MiMo, GLM, Qwen or OpenRouter; provider-specific parameters go in `extra_body` and are merged into the request as is.
2. **Fill in the key**, either way:
   - Environment variable: write `"api_key_env": "DEEPSEEK_API_KEY"`, then set that variable. On Windows, add a user variable under "System Properties → Environment Variables"; on macOS and Linux, put it in your shell's startup file. Restart Claude Code so it can see it.
   - Config file: write `"api_key": "sk-..."`. It takes effect immediately but is stored in plain text, so don't commit or share the file. If both are set, the one in the config file wins.
3. **Add it to discussions or reviews**: list it in the cells you want under `modules.discuss` or `modules.review`.

You can also leave this to `/foreman-en:setup`, for example `/foreman-en:setup add DeepSeek`; you fill in the key yourself, with no need to paste it into the chat. API models can't look through your code themselves, so Claude Code sends the relevant files along with the topic or review brief (the patch, when reviewing changes; up to about 300,000 characters each time) and checks what they say about the code against the source.

### Adding opencode

With opencode 2.x installed, any model it can use can join discussions and do reviews, for example GLM, Kimi, Qwen, MiniMax or DeepSeek from an [OpenCode Go](https://opencode.ai/docs/go/) subscription. They read your project's code themselves; the trade-off is that every file they read is another request, which uses more quota.

1. **Sign in**: run `opencode` in a terminal and sign in with `/connect` (choose OpenCode Go for a Go subscription), then run `opencode models` to see which models you can use. Don't configure the free models (names ending in `-free`): OpenCode now only allows them inside its own app, and calls from the command line are refused with "OpenCode's free tier can only be used from within OpenCode".
2. **Add them to the config**: one entry per model, `{ "type": "opencode cli", "model": "opencode-go/glm-5.3" }`, then add it to the cells you want. `/foreman-en:setup` can do this for you.

For discussions and reviews, the plugin gives opencode a read-only agent with only the read, search and list tools; for a review, the plugin works out the changes with git and attaches them. Keys and sign-in stay in opencode. The result's cost (`cost_usd`) is priced at the model's official API price like every other agent's; the cost opencode reports itself (what OpenCode Go quota is charged by) is kept in `reported_cost_usd`. Go's limits are per model, and premium models have small limits, so keep them for complex discussions.

### Adding pi

With pi installed (`npm install -g @earendil-works/pi-coding-agent`), it works like opencode.

1. **Sign in**: run `pi` in a terminal and sign in to the providers you want with `/login` (or set the provider's API key environment variable), then run `pi --list-models` to see which models you can use.
2. **Add them to the config**: one entry per model, `{ "type": "pi cli", "model": "deepseek/deepseek-flash" }`, then add it to the cells you want.

- The effort is pi's thinking level (`off` to `max`), and each model supports its own set. **If you set a level the model doesn't support, pi doesn't report an error; it quietly switches to the nearest one**, so run `check` after a change: it says which level would be used instead.
- pi has no permission system of its own. Every call from the plugin enables only the tools the task needs and injects a guard extension that keeps file reads and writes inside the project directory; your own extensions, skills and MCP servers aren't loaded. The project's AGENTS.md / CLAUDE.md are read as usual, and sessions stay in pi's default location.

### Letting opencode or pi do hands-on work

Give the agent `run_access` in the user config, then put it in a `modules.run` cell (or the image `draw` cell); a project config can't turn this on:

- `"edit"`: reads and writes files in the project directory only, with no commands. Claude Code runs the tests afterwards.
- `"shell"`: can also run commands, such as tests. There's no OS sandbox: its commands run with your account's permissions and can reach the whole machine, so use this only for projects and models you trust.

Both take a change snapshot first, and Claude Code reviews the diff file by file afterwards.

### A complete example

<details>
<summary>Expand: a complete config using all four kinds of agents</summary>

```json
{
  "dispatch": {
    "auto": true,
    "watch": "auto",
    "intro": true,
    "discuss_max_rounds": 2,
    "timeout_min": 240,
    "stall_min": 20,
    "busy_ask_min": 2
  },
  "agents": {
    "gpt-6-astra":        { "type": "codex cli", "model": "gpt-6-astra" },
    "gpt-6.1-sol":        { "type": "codex cli", "model": "gpt-6.1-sol" },
    "deepseek-flash":     { "type": "opencode cli", "model": "deepseek/deepseek-flash" },
    "glm-5.3":            { "type": "opencode cli", "model": "opencode-go/glm-5.3" },
    "mimo-v2.6-pro":      { "type": "pi cli", "model": "xiaomi/mimo-v2.6-pro" },
    "kimi-k2.6":          { "type": "api", "base_url": "https://api.moonshot.cn/v1", "api_key_env": "KIMI_API_KEY", "model": "kimi-k2.6" }
  },
  "modules": {
    "discuss": {
      "simple": [
        { "agent": "gpt-6-astra", "effort": "medium" },
        { "agent": "glm-5.3" }
      ],
      "normal": [
        { "agent": "gpt-6-astra", "effort": "high" },
        { "agent": "deepseek-flash", "effort": "high" },
        { "agent": "glm-5.3" }
      ],
      "complex": [
        { "agent": "gpt-6-astra", "effort": "max", "required": true },
        { "agent": "deepseek-flash", "effort": "max" },
        { "agent": "kimi-k2.6" },
        { "agent": "mimo-v2.6-pro", "effort": "high" },
        { "agent": "glm-5.3" }
      ],
      "seats": { "simple": 2, "normal": 4, "complex": 8 }
    },
    "run": {
      "simple":  "claude code",
      "normal":  "claude code",
      "complex": [{ "agent": "gpt-6.1-sol", "effort": "max" }]
    },
    "review": {
      "simple":  [{ "agent": "gpt-6-astra", "effort": "medium" }],
      "normal":  [{ "agent": "gpt-6-astra", "effort": "high" }, { "agent": "deepseek-flash", "effort": "high" }],
      "complex": [{ "agent": "gpt-6-astra", "effort": "max", "required": true }, { "agent": "deepseek-flash", "effort": "max" }, { "agent": "glm-5.3" }],
      "seats":   { "simple": 1, "normal": 2, "complex": 2 }
    },
    "image": {
      "generate": [{ "agent": "gpt-6.1-sol", "effort": "medium" }],
      "draw":     [{ "agent": "gpt-6-astra", "effort": "max" }]
    }
  }
}
```

| ID | Reached through | Used for |
|---|---|---|
| `gpt-6.1-sol` | Codex CLI | Complex hands-on work, image generation |
| `gpt-6-astra` | Codex CLI | A candidate for every review and discussion, required for complex ones; hand-drawing pieces that bend |
| `glm-5.3` | opencode (OpenCode Go subscription) | A candidate for discussions at all three levels and for complex reviews |
| `deepseek-flash` | opencode | A candidate for normal and complex discussions and reviews |
| `mimo-v2.6-pro` | pi | A candidate for complex discussions |
| `kimi-k2.6` | API, with the key in the `KIMI_API_KEY` environment variable | A candidate for complex discussions |

Claude Code does simple and normal hands-on work itself. Discussions and reviews get more candidates as the level rises: each time Claude Code picks a few seats from them (as many as `seats` says, with all three levels written in the config), and `gpt-6-astra` is required for complex discussions and reviews, so it always takes part.

Fields this config doesn't use but that are often adjusted:

```json
"gpt-6.1-sol":        { "type": "codex cli", "model": "gpt-6.1-sol", "sandbox": { "run": "workspace-write" }, "max_parallel": 2 },
"glm-5.3":            { "type": "opencode cli", "model": "opencode-go/glm-5.3", "run_access": "edit" },
"deepseek-v4-pro":    { "type": "api", "base_url": "https://api.deepseek.com", "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-v4-pro", "extra_body": { "temperature": 0.3 } }
```

- `sandbox`: the sandbox Codex uses for each task type (`run`, `review`, `discuss`): `read-only`, `workspace-write` or `danger-full-access`. Left out, Codex's own config applies. Don't use `read-only` on Windows.
- `max_parallel`: how many runs this agent may have at once; 4 by default. When it's full, new dispatches queue for a slot in arrival order (for up to 60 minutes by default; `--queue-timeout` changes that, and 0 refuses right away instead of queueing), across all conversations.
- `run_access`: lets opencode or pi do hands-on work; see above.
- `extra_body`: extra parameters to send with API requests.
- `bin`: the full path to the executable, if the command can't be found.

</details>

### Project config

A project config can only tighten, never loosen:

- it only accepts `timeout_min`, `stall_min`, `busy_ask_min` under `dispatch`, plus `modules` (the old `levels` form too);
- time and seat limits take the stricter of the two values: the smaller time limit and per-level seat count win; for stall detection and the queue check, 0 means "don't check", which is the loosest, so a project 0 has no effect when you set a positive number;
- each cell can only be closed as a whole (`"claude code"` for a graded cell, `null` for an image cell), drop optional entries your user config has in that cell, or lower the effort (only for Codex and pi, whose efforts have a clear order);
- it can't add agents, swap models or change who is required, and it can't drop only the required agents while keeping others handing work out (that's an error). Claude Code can't name an agent with `--agent` for a cell the project closed either.

This way a repository you cloned can't use its project config to swap the agent doing the work, send your code to a new provider, skip a required review, or stretch time limits and raise efforts to spend more of your quota. For a sensitive project, drop the API candidates, or set discussions and reviews to `"claude code"` as a whole.

### Preference files

Some habits don't fit in JSON, such as which code in your project counts as high-risk, or what you never want handed off. Write those in plain text in a preference file. Claude Code reads it the first time it uses the plugin in a session:

- User level: `~/.claude/foreman/preferences.md`
- Project level: `<project>/.claude/foreman.md`

Preference files only adjust how things are done within the plugin's hard rules: the config files themselves, required agents, whether material may go to a given provider, read-only discussions and reviews, the things that need a confirmation pop-up, and each level's seat count can't be changed by preference files. Within that, they win over the plugin's built-in rules. Project-level preferences come from the project repository (possibly someone else's) and can only make things stricter: if one asks to skip confirmations, review less or swap out the models you configured, Claude Code won't follow it and will tell you. For example:

```markdown
# foreman preferences

- Treat billing and reconciliation code in this project as high-risk: hand it off as complex, and always have Codex review the changes.
- Don't hand off database migration scripts; Claude Code writes them.
- Ask Codex for a review when a change is over 200 lines.
- Use role mode for discussions where performance and maintainability pull against each other; treat kimi-k2.6 as a strong model.
- Local results from stats show deepseek-v4.1-flash finding many issues no one else does in reviews; treat it as strong for reviews.
```

Custom roles for role-mode discussions go here too; the format is under "Custom roles" in [references/roles.md](foreman-en/skills/dispatch/references/roles.md).

## Safety notes

- **Claude Code can only call agents through the plugin.** The plugin includes a hook that blocks Claude Code's commands that run `codex exec`, `codex review`, `opencode run` or a pi task directly, so every call is recorded, has its changes tracked, and uses an explicit model and effort. Running them yourself in a terminal isn't affected.
- **Codex is isolated by its own sandbox.**
  - The sandbox is whatever Codex is configured with. With `danger-full-access`, Codex can read and write any directory on your machine; the task brief limits what it should touch and Claude Code reviews the diff afterwards, but that is not isolation. For isolation, set `agents.<ID>.sandbox` to `workspace-write` or `read-only`. `read-only` is recommended for discussions and reviews: the OS blocks writes (the result's `readonly` is `sandbox`); without it, only the rules and a snapshot comparison afterwards hold it back (`audited`), and any write marks the run failed. On Windows the read-only sandbox may fail to start even file-reading commands; then follow `check` and switch to `[windows] sandbox = "unelevated"`.
  - Codex's default elevated sandbox on Windows needs a one-time setup with administrator rights, and if that setup is broken, every command fails (with `windows sandbox failed`). After changing the sandbox, have Claude Code run `check`: it tests the sandbox without calling a model and lists fixes if it's broken, such as switching to `[windows] sandbox = "unelevated"`.
  - Leave `approval` at the default `never`: nobody can approve in a handed-off task, and a broken sandbox needs fixing at the sandbox.
- **opencode and pi have no OS sandbox when doing hands-on work.** At `edit` they can't write outside the project or run commands; at `shell` their commands can reach the whole machine. It's off by default; only you can turn it on, in the user config, and a project config can't.
- **Your code goes to the providers behind your agents.** Work handed to Codex goes to OpenAI; opencode, pi and API models send it to their providers, and API models also receive the files Claude Code attaches. Check that this is acceptable for sensitive projects, and tighten things with a project config if needed.
- **API keys can go in the user config or in environment variables.** In the config they're plain text, so don't commit or share `~/.claude/foreman/config.json`; keys in a project config are ignored. The `config` command never shows keys, and the script never writes them into run records.
- **Pay-as-you-go means real costs.** Codex with API-key billing, API models, and pay-as-you-go providers reached through opencode or pi all cost money for each handoff or discussion. Set `dispatch.auto` to `false` if you don't want Claude Code starting handoffs, discussions and reviews on its own; it asks you first instead.
- **Agents don't get stuck waiting for an answer.** Codex needs no approvals by default, opencode gets no way to ask questions or request confirmable permissions, and pi has no question tool. Anything they need answered is collected in the result, and Claude Code decides: within the authority you've already given, it decides and resumes; it only asks you about business trade-offs, wider scope, extra cost and irreversible steps.

## Run records

Each call is recorded in `~/.claude/foreman/runs/<run_id>/`: the brief, the event stream, the diff and the final report. Runs by API models have no diff, but add the conversation history `messages.json`, which a resume continues from. `/foreman-en:status` reads them.

- Change tracking uses a separate git repository inside the record folder and never touches your project's `.git`. It compares the whole working directory at the start and end of a run, so files that you, Claude Code or another session change at the same time are seen too: files with evidence that the agent changed them are marked separately from files of unknown origin, and Claude Code won't simply revert changes of unknown origin.
- Paths ignored by `.gitignore` aren't tracked unless you pass them with `--track` when handing off.
- When the Codex quota runs out or an API balance is too low, the run is marked `quota_exhausted` and isn't retried automatically; for Codex it includes the expected reset time.
- Runs whose dispatcher exited unexpectedly, got stuck or timed out are flagged to Claude Code the next time you start a session in that project.
- After a review or discussion ends and Claude Code has checked it, it records what happened to each point in that run's `verdict.json`. `cli.mjs stats` sums these records up by model and module: seats, points confirmed and false positives, points only that model found, rework rate, time, usage and cost, with missing usage shown as missing rather than 0. You can point to these figures in the preference files to adjust model tiers; the plugin never ranks models itself.

## Platforms

Mainly developed and tested in the Claude desktop app on Windows (including the Microsoft Store version); the CLI has been tested too, and loads the plugin, commands and hooks the same way. The macOS and Linux code paths are written but not yet tested in practice; issue reports are welcome.

- **The live view in the desktop app** opens in the terminal panel, which only accepts ASCII commands. If the run directory (`~/.claude/foreman/runs` by default) has non-English characters in its path (for example a Windows user name in Chinese), `/foreman-en:setup` will point it out; set `dispatch.runs_dir` in the config to a plain-English path. The CLI isn't affected.
- **Programs started from a graphical app** (such as the macOS desktop app) may have a PATH without Homebrew, nvm and similar directories. If the script can't find a command, it also looks in the directory node runs from, `/opt/homebrew/bin`, `/usr/local/bin` and other common places; if it's still not found, set `bin` on that agent to the executable's full path. The plugin's hooks run `node`, so it also needs to be on the PATH.
- **The live view** redraws the whole screen. Windows Terminal, macOS Terminal and iTerm2, the VS Code terminal and common Linux terminals all support this; simple terminals such as `TERM=dumb` get line-by-line output instead. The intro uses 24-bit color and switches to 256 colors in macOS's built-in Terminal; it has mainly been seen in the Claude desktop app's terminal, so if it looks wrong elsewhere, turn it off with `dispatch.intro: false`.

## Upgrading from codex-bridge

This plugin used to be called codex-bridge. Claude Code doesn't upgrade a plugin to a new name on its own, so switch over once by hand:

1. Uninstall the old plugin: `/plugin uninstall codex-bridge-en@claude-codex-bridge`. With both installed, their hooks block and remind twice.
2. Add the new marketplace and install `foreman-en` as in [Install and setup](#install-and-setup).
3. If you installed the old plugin through "My Uploads" in the desktop app, delete it there.

Your settings move over automatically the first time the new plugin runs:

| Before | Now |
|---|---|
| Plugins `codex-bridge` / `codex-bridge-en`, marketplace `claude-codex-bridge` | `foreman` / `foreman-en`, marketplace `claude-foreman` |
| `/codex-bridge-en:rescue` | `/foreman-en:run`; other commands only change their prefix |
| Config `~/.claude/codex-bridge.json` | `~/.claude/foreman/config.json` (copied automatically) |
| Preferences `~/.claude/codex-bridge.md` | `~/.claude/foreman/preferences.md` (copied automatically) |
| Run records `~/.claude/codex-runs` | `~/.claude/foreman/runs` (moved as a whole; if runs are still in progress there, it moves on a later run) |
| A project's `.claude/codex-bridge.json` and `.claude/codex-bridge.md` | `.claude/foreman.json` and `.claude/foreman.md` (the old names are still read, with a suggestion to rename) |
| Environment variables `CODEX_BRIDGE_CONFIG`, `CODEX_RUNS_DIR`, `CODEX_BRIDGE_LANG` | `FOREMAN_CONFIG`, `FOREMAN_RUNS_DIR`, `FOREMAN_LANG` (the old names still work for now) |

The config is also rewritten in the new format: `type` becomes `codex cli` / `opencode cli` / `api`, `"claude"` becomes `"claude code"`, agent IDs are renamed after their models (for example `codex` becomes `gpt-6-astra`), and `levels` is rewritten as `modules` (see "How the config is laid out" above). The model and effort each cell actually uses stay the same, and the original is backed up as `config.json.bak`. The old config and preferences files are kept; delete them yourself once everything works.

## English and Chinese versions

The marketplace has two plugins that differ only in the language of their rules and output:

- `foreman-en`: English, commands are `/foreman-en:…`
- `foreman`: Chinese, commands are `/foreman:…`

Install just one. Both share the same config file, preference files and run records, so switching doesn't mean setting things up again.

## Development

Both plugins use the same scripts: everything under `skills/dispatch/scripts/` except `language.json` (the entry point is `cli.mjs`), plus the two hooks under `hooks/`. Only edit the copy in `foreman/`, then run the sync tool to copy it into the English plugin:

```bash
node tools/sync-shared.mjs
```

- Before committing, `node tools/sync-shared.mjs --check` checks that both copies of the scripts, the structure of both sets of schemas and both plugin versions match.
- Tests: `npm test` (Node built-ins only, nothing to install); see [tests/README.md](tests/README.md).
- Terminal messages, the rules and prompts sent to agents and other text live in `messages.mjs`, with a Chinese and an English set; each plugin has its own skill `SKILL.md` files (slash commands are skills too, in `skills/<command>/SKILL.md`), `references/` and schemas.
- The model tiers in `references/model-tiers.md` come from a third-party leaderboard that changes within months; update them against the latest results before each release.
- The intro's avatar data is generated by `node tools/make-avatars.mjs` from `tools/avatars/source.webp`.
- The web board's server is in `skills/dispatch/scripts/board/`, shared by both plugins; the page's source is in `board/` at the repo root. After changing it, run `node board/build.mjs` to generate `index.html` (one file for both languages, shown in the plugin's language), then the sync tool. The protocol and design notes are in `docs/board/`.

## License

[MIT](LICENSE)
