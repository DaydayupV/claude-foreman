---
name: config
description: 查看或修改 foreman 的配置（协作方、各格子的候选和必选、模型和推理强度、沙箱、超时等）
argument-hint: '[要改的设置，例如"复杂任务换成 gpt-6.1-sol、ultra"]'
disable-model-invocation: true
---

用户要查看或修改 foreman 的配置。参数：

$ARGUMENTS

1. 运行 `node "${CLAUDE_PLUGIN_ROOT}/skills/dispatch/scripts/cli.mjs" config --cwd "<当前项目目录>"`，查看实际生效的配置和配置文件路径。字段含义见 `foreman:dispatch` skill 目录下的 `references/config.md`。
2. 没有参数时，用简短的中文表格向用户展示：
   - `summary.modules`：讨论、执行、审查各三级和图像两格，每一格有哪些候选、谁是必选、什么模型和推理强度；带了 `--cwd` 时，`project_config.cells` 里的格子注明"项目配置改的"；`image_configured` 为 `false` 时，图像两格注明"还没配置"，不说成关掉；
   - `summary.agents` 和 `agents_status`：有哪些协作方、各用在哪几格，API 协作方的 key 是否已设置；
   - `summary.warnings`：值得注意的地方，用人话逐条转告；
   - `dispatch` 里的各项，以及每项的来源（内置默认、用户配置或项目配置）。
   展示完就结束。
3. 有参数时，按用户要求修改配置文件：
   - 默认改用户配置。用户说只对当前项目生效时，改项目配置 `<项目目录>/.claude/foreman.json`：它覆盖用户配置，只认 `modules`（含 `seats`、`gap`）和 `dispatch` 的 `discuss_max_rounds`、`timeout_min`、`stall_min`、`busy_ask_min`，写了的格子整格替换；协作方要先在用户配置的 `agents` 里定义。
   - 用户要按场景分开席位数或补漏席时，按 `references/config.md` 的"场景"做：偏好文件里的场景块和 `seats`、`gap` 的场景名要一致，改完看 `config` 输出的 `scenes.problems` 为空。
   - 用户配置还是旧的 `levels` 写法时，第 1 步运行 `config` 时脚本已经把它改写成 `modules`，直接在新写法上改；改写后文件里的 `levels` 是一行说明文字（让旧版插件报错用的），保留不动。每一格写成候选列表，必选的条目加 `"required": true`；执行、出图、手画一格最多一个必选。
   - 只改用户提到的字段，其余保持原样。
   - 要换模型或推理强度时，先运行 `models` 看清单，推理强度只用清单里这个模型支持的档位；API 模型的推理强度查厂商的官方文档。
   - 新增 API 协作方时，key 可以写在用户配置的 `api_key` 里（明文，立即生效），也可以放在环境变量里、配置只写 `api_key_env`（设置后要重启 Claude Code）。让用户选，并请用户自己填 key 或设环境变量，不要让用户把 key 发到对话里。key 只能写在用户配置，项目配置里写了也不生效。
4. 改完再运行一次 `config` 确认生效，告诉用户改了什么。改了协作方、模型或推理强度的，再运行 `check`，用它的 `summary` 给出改后的格子表和提醒。
