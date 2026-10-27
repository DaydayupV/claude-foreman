# Model tiers

Role discussions (see `references/roles.md`) use this table when assigning roles to participants: the tier decides whether a model may take a role that needs hard thinking; strengths and weaknesses decide which model fits better within the same tier.

- **Updated**: 2026-10-18
- **Source**: LiveBench (https://livebench.ai), with an overall score and seven category scores (Agentic, Reasoning, Coding, Browser use, Data analysis, Research, Design). This table keeps only the tier and the standout strengths and weaknesses, not the raw scores.
- **Upkeep**: leaderboards change within months. Update this table against the latest results before each release, and change the date above.

## How to use it
- **Tiers go by the overall score**: strong ≥ 84, mid 75–84, weak < 75. Tiers are a guide, not a condition for taking part: roles that need hard thinking go to strong models first (each role's suggested tier is in `references/roles.md`); a model below the suggested tier can still take the role, but only as a breadth seat in round 1.
- **Compare strengths only within a tier**: if two strong models both suit "Data analyst", pick the one stronger at data analysis. Don't give a core role's only seat to a weak model just because one of its category scores is high.
- **Agentic scores depend on how the model is reached**: the same model can do differently through Codex, opencode or pi. In discussions only Codex can run commands, so for roles like "Fact checker" look at tool access first and this score second.
- **Matching model names**: drop the provider prefix from the model name in the `config` output (such as `opencode-go/` or `xiaomi/`), ignore case, treat hyphens and spaces alike, then look it up below. A name with an extra suffix (such as `-contributor`) counts as its base model.
- **Models not in the table**: if a newer model of the same family is weak here, treat it as weak; otherwise treat it as mid. Mark it "unrated" in the pop-up so the user can correct it.
- **The user's view wins**: if the preference files say something about a model (such as "treat kimi-k2.6 as strong"), go by them. The preference files can point to local results (`cli.mjs stats`: points confirmed and false positives, points only that model found, rework rate) to change a tier; the script only sums things up and never ranks models or changes tiers itself.

## Strong (overall ≥ 84)
| Model | Strengths | Weaknesses |
|---|---|---|
| Claude Fable 5.1 | Coding, browser use, reasoning | — |
| Claude Opus 5.5 | Agentic, design, research, reasoning | — |
| GPT-6 Astra | Reasoning, agentic, data analysis, research | — |
| GPT-6.1 Sol | Coding, reasoning, data analysis | Agentic on the weak side |
| Gemini 4 Argon | Reasoning (top of the board), data analysis (top of the board), browser use | Design, agentic on the weak side |

## Mid (overall 75–84)
| Model | Strengths | Weaknesses |
|---|---|---|
| Claude Fable 5 | Coding, research | Agentic weak |
| Claude Sonnet 5.5 | Reasoning, design, agentic | Data analysis weak |
| Claude Opus 5 | Research, reasoning | Agentic, data analysis on the weak side |
| GPT-6 Sol | Coding, browser use | Research, agentic on the weak side |
| DeepSeek V4.1 Flash 1017 (API name `deepseek-flash`, also written `deepseek-v4.1-flash`) | Coding, reasoning | Agentic weak |
| Muse Wonder 1.0 | Research, reasoning | Agentic weak |
| Claude Opus 4.8 | Browser use, reasoning | Agentic, data analysis weak |
| GPT-5.6 Sol | Reasoning, coding | Research, agentic weak |
| GPT-5.6 Terra | Reasoning | Research, agentic weak |

## Weak (overall < 75)
| Model | Strengths | Weaknesses |
|---|---|---|
| MiMo V2.6 Pro | Browser use, design | Agentic, reasoning on the weak side |
| Muse Spark 1.3 | Coding, reasoning | Agentic, research weak |
| Grok 4.6 | Reasoning, research | Agentic, browser use weak |
| Claude Sonnet 5 | Reasoning, research | Agentic weak |
| Claude Haiku 5.5 | Browser use, design | Data analysis weak |
| Grok 4.7 | Research | Browser use weak |
| GLM-5.3 Flash | Browser use | Agentic very weak, reasoning on the weak side |
| Grok 4.5 | Coding, research | Agentic, browser use very weak |
| GPT-6 Luna | Design | Research very weak |
| Qwen3.8 Flash | Coding, reasoning | Browser use weak |
| GPT-5.5 | Reasoning, data analysis | Browser use weak |
| Gemini 3.8 Flash | Reasoning | Agentic, data analysis weak |
| Gemini 3.7 Flash | Reasoning | Agentic very weak |
| GPT-5.6 Luna | Data analysis | Research weak |
| Claude Sonnet 4.6 | Reasoning | Agentic very weak |
| Qwen3.8 Max | Reasoning, design | Coding, browser use weak |
| DeepSeek V4 Flash Vision | Data analysis | Coding very weak |
| Kimi K3 | Reasoning, research | Browser use, coding very weak |
| Qwen3.8 27B | Coding | Browser use weak |
| Muse Spark 1.2 | Reasoning | Agentic very weak |
| Step 5 (Preview) | Coding | Browser use very weak |
