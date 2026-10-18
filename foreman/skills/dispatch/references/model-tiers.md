# 模型档位表

角色讨论（见 `references/roles.md`）给参与方分配角色时用这张表：先看档位，决定能不能扮需要复杂思考的角色；再看长处和短处，在同一档里挑更合适的。

- **更新日期**：2026-10-18
- **依据**：一份第三方综合评测榜，含综合分和八个单项（Agentic、推理、编程、浏览器操作、数据分析、研究、设计）。表里只记档位和突出的长处、短处，不记原始分数。
- **维护**：评测几个月就会变。每次发版前对照最新评测更新这张表，并改上面的日期。

## 怎么用
- **档位按综合分划分**：强 ≥ 84，中 75–84，弱 < 75。需要复杂思考的角色只给强档（每个角色要求的最低档位见 `references/roles.md`）。
- **长处只在同档里比较**：比如两个强档模型抢"数据分析师"，选数据分析更突出的那个。不要因为一个弱档模型某个单项高，就让它扮复杂角色。
- **Agentic 分受接入方式影响**：同一个模型经 Codex、opencode、pi 调用，表现可能不一样。讨论里只有 Codex 能跑命令，所以"实证核查"这类角色先看工具能力，再看这一项。
- **对照模型名**：去掉 `config` 输出里模型名前面的服务商前缀（比如 `opencode-go/`、`xiaomi/`），不分大小写，横线和空格视为相同，再和下表对照；名字带额外后缀（比如 `-contributor`）的，按去掉后缀的基础型号算。
- **表里查不到的模型**：同系列更新的版本在表里是弱档的，按弱档算；其他按中档算。弹窗里标明"未评级"，由用户更正。
- **用户的看法优先**：偏好文件里写了对某个模型的判断（比如"把 kimi-k2.6 当强档"），按偏好文件来。

## 强档（综合 ≥ 84）
| 模型 | 长处 | 短处 |
|---|---|---|
| Claude Fable 5.1 | 编程、浏览器操作、推理 | — |
| Claude Opus 5.5 | Agentic、设计、研究、推理 | — |
| GPT-6 Astra | 推理、Agentic、数据分析、研究 | — |
| GPT-6.1 Sol | 编程、推理、数据分析 | Agentic 偏弱 |
| Gemini 4 Argon | 推理（榜上最高）、数据分析（榜上最高）、浏览器操作 | 设计、Agentic 偏弱 |

## 中档（综合 75–84）
| 模型 | 长处 | 短处 |
|---|---|---|
| Claude Fable 5 | 编程、研究 | Agentic 弱 |
| Claude Sonnet 5.5 | 推理、设计、Agentic | 数据分析弱 |
| Claude Opus 5 | 研究、推理 | Agentic、数据分析偏弱 |
| GPT-6 Sol | 编程、浏览器操作 | 研究、Agentic 偏弱 |
| DeepSeek V4.1 Flash 1017 | 编程、推理 | Agentic 弱 |
| Muse Wonder 1.0 | 研究、推理 | Agentic 弱 |
| DeepSeek V4.1 Flash | 研究、编程 | Agentic 很弱 |
| Claude Opus 4.8 | 浏览器操作、推理 | Agentic、数据分析弱 |
| GPT-5.6 Sol | 推理、编程 | 研究、Agentic 弱 |
| GPT-5.6 Terra | 推理 | 研究、Agentic 弱 |

## 弱档（综合 < 75）
| 模型 | 长处 | 短处 |
|---|---|---|
| MiMo V2.6 Pro | 浏览器操作、设计 | Agentic、推理偏弱 |
| Muse Spark 1.3 | 编程、推理 | Agentic、研究弱 |
| Grok 4.6 | 推理、研究 | Agentic、浏览器操作弱 |
| Claude Sonnet 5 | 推理、研究 | Agentic 弱 |
| Claude Haiku 5.5 | 浏览器操作、设计 | 数据分析弱 |
| Grok 4.7 | 研究 | 浏览器操作弱 |
| GLM-5.3 Flash | 浏览器操作 | Agentic 很弱、推理偏弱 |
| Grok 4.5 | 编程、研究 | Agentic、浏览器操作很弱 |
| GPT-6 Luna | 设计 | 研究很弱 |
| Qwen3.8 Flash | 编程、推理 | 浏览器操作弱 |
| GPT-5.5 | 推理、数据分析 | 浏览器操作弱 |
| Gemini 3.8 Flash | 推理 | Agentic、数据分析弱 |
| Gemini 3.7 Flash | 推理 | Agentic 很弱 |
| GPT-5.6 Luna | 数据分析 | 研究弱 |
| Claude Sonnet 4.6 | 推理 | Agentic 很弱 |
| Qwen3.8 Max | 推理、设计 | 编程、浏览器操作弱 |
| DeepSeek V4 Flash Vision | 数据分析 | 编程很弱 |
| Kimi K3 | 推理、研究 | 浏览器操作、编程很弱 |
| Qwen3.8 27B | 编程 | 浏览器操作弱 |
| Muse Spark 1.2 | 推理 | Agentic 很弱 |
| Step 5 (Preview) | 编程 | 浏览器操作很弱 |
