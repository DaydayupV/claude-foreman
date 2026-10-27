# Model tiers

Tiers are used when picking seats for discussions and reviews, assigning roles in role mode (see `references/roles.md`), and choosing efforts in `/foreman-en:setup`: the tier decides whether a model may take a role that needs hard thinking; strengths and weaknesses decide which model fits better within the same tier.

## Where to get tiers
- In the `config` output, every candidate in `resolved_modules` has a `tier`: `strong`, `mid`, `weak`, or `null` when the model isn't rated. Look at it first when picking seats.
- For strengths, weaknesses and the overall score, run `node "<script path>" tiers`: without options it lists the models the current config uses; `--model <name>` looks up any model (for the Claude Code seat, use the model ID from the system prompt, such as `tiers --model claude-opus-5-5`); `--all` lists them all; `--format md` prints a table.
- The script normalizes model names (provider prefixes, case, aliases, faster and free variants) with the identity table in `scripts/models.json`, so there's no need to match names yourself.

## Where the data comes from
- Scores come from LiveBench (https://livebench.ai): an overall score and seven category scores (Agentic, Design, Coding, Browser use, Data analysis, Research, Reasoning). The data is in `scripts/model-tiers.json`; `source` and `checked` in the `tiers` output say which edition.
- A few models aren't on the current leaderboard and keep the tier, strengths and weaknesses from the old tier table (`source` is legacy), without scores.

## How to use it
- **Tiers go by the overall score**: strong ≥ 84, mid 75–84, weak < 75. Tiers are a guide, not a condition for taking part: roles that need hard thinking go to strong models first (each role's suggested tier is in `references/roles.md`); a model below the suggested tier can still take the role, but only as a breadth seat in round 1.
- **Strengths and weaknesses are relative to the same tier**: a category 5 points or more above the median of the models in the same tier is a strength, 5 points or more below is a weakness, and 15 or more below is "very weak". So compare strengths only within a tier: if two strong models both suit "Data analyst", pick the one stronger at data analysis. Don't give a core role's only seat to a weak model just because one of its category scores is high. `top` lists the categories where the model is first on the whole leaderboard.
- **Agentic scores depend on how the model is reached**: the same model can do differently through Codex, opencode or pi. In discussions only Codex can run commands, so for roles like "Fact checker" look at tool access first and this score second.
- **Unrated models** (`tier` is `null`): if a newer model of the same family (`family` in the `tiers` output) is weak, treat it as weak; otherwise treat it as mid. Mark it "unrated" in the pop-up so the user can correct it.
- **The user's view wins**: if the preference files say something about a model (such as "treat kimi-k2.6 as strong"), go by them. The preference files can point to local results (`cli.mjs stats`: points confirmed and false positives, points only that model found, rework rate) to change a tier; the script only provides the data, and never ranks models or picks for you.

## Upkeep
LiveBench changes within months, so update before each release: copy the whole table from the LiveBench page into a text file and run `node tools/import-livebench.mjs --input <file> --date <date>`, then look at what it lists as added, updated, tier changes and unmatched names. To include an unmatched name, first add that model to `scripts/models.json` (or add `board_names` to an existing model), then import again.
