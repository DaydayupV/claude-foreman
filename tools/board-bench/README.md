# 回放构建验证记录

2026-10-23，Windows，Node v24.21.0。全部规模数据由本目录的 `gen.mjs` 写入系统临时目录；不使用真实 Claude/Codex 记录。未安装依赖、提交或切换分支，未运行全量测试、网页构建或同步。

## 金标准与定向验证

修改实现前，以固定 `now = 2026-10-22T09:03:30Z`、`tests/fixtures/board/prices-test.json` 和当前实现生成 SHA256，已固化在 `tests/board-replay-build.test.mjs`。覆盖：

- `tests/fixtures/board/universe` 的完整 `hello`、`initial`、`timeline`、时钟起止/速度/间隔与原始记录时刻的映射、全部九个对话的 `detail`。
- 每个对话单独 `buildReplay` 的完整结果；`tests/fixtures/board/runs` 按 `skills-roles-1018` 组构建的完整结果。
- `universeAt` / `snapshotAt` 的起始、中间和最终快照。

只对完整 JSON 序列化取摘要，没有删除费用、浮点数、事件顺序或时间字段。优化后全部摘要一致。补充测试检查选中范围、每份任务文件只打开一次、detail 零读取并固定构建时数据、完整字节估算与超限拒绝、旧对话显式选择、usage 替换/撤回/未知价格和精确阈值；额外覆盖小数毫秒压缩时钟。

执行命令：

```powershell
node --test tests/board-replay-build.test.mjs tests/board-feed.test.mjs tests/board-universe.test.mjs
```

最终 50 项测试通过（约 12.1 秒）；已有测试文件中的直播和回放用例均保留，`tests/board-universe.test.mjs` 未由本任务修改。`tests/board-feed.test.mjs` 只新增用量前缀的输出比较，没有削弱断言，工作区原有 200k 行测试也保留。

## 性能数据

秒；内存为 MiB。`bench.mjs` 的 `peak` 来自 `process.resourceUsage().maxRSS`，包括此前直播预热和 detail 的整个进程峰值。小数据改前脚本没有 peak 字段，列出当时的 RSS；真实峰值至少为这个数。中数据改前采用任务给定的压力测试数字，没有再重复 1602 秒的构建。

| 数据/操作 | 改前耗时 | 改后耗时 | 改前内存 | 改后进程峰值 |
| --- | ---: | ---: | ---: | ---: |
| 20 任务 / 2 对话，universe.replay | 55.9924 | 0.2273 | RSS 218 | 151 |
| 同数据，首次 detail | 2.9772 | 0.0155 | 同上 | 同上 |
| 1000 任务 / 40 对话，universe.replay | 1602（任务给定） | 3.7281 | RSS 560（任务给定） | 517 |
| 同数据，首次 detail | 未提供 | 0.0148 | 同上 | 同上 |
| 单对话 16,777,600 字节，buildReplay | 131.9180 | 0.0682 | peak 219 | 151 |
| 单对话 33,554,503 字节，buildReplay | 529.0201 | 0.1400 | peak 351 | 251 |

小/中数据末轮复测在相同量级：0.2412 / 3.6470 秒，峰值 151 / 521 MiB。16/32 MiB 数据在修改前就已生成，修改后复用同一文件；扩展生成器保持原来的行结构、usage 密度与时间步长，仅增加行数直到达到指定字节数。这与任务背景中 16/32 MB 的旧样本内容不完全相同，因此列出本次实测基线，没有把背景中的 42.5/21 秒混作同样本比较。16→32 MiB 时 buildReplay 改前约四倍、改后约两倍。

中数据原始文件共 129,256,890 字节；40 个窗口内对话共 103,925,400 字节，生成器把 100 个近期任务分给这些对话，其余 900 个任务属于旧对话。因此实际预检构建量为 106,465,354 字节。基准通过 `createUniverse({ replayLimitBytes: Number.MAX_SAFE_INTEGER })` 测构建能力；产品默认上限会拒绝这组数据。该覆盖只在基准脚本内，不增加产品配置项或命令行参数。

每次 replay 的任务 meta 仅扫描一次；只有选中对话的 result/events 被读取。小数据 replay 的同步读取计数是 `readFileSync:22, openSync:6`（含两个旧项目头），detail 是 `fs {}`。中数据为 `readFileSync:1100, openSync:160`（1000 份 meta、100 份 result、40 份对话、100 份 events、20 份旧项目头），detail 也是 `fs {}`。

## 默认上限

`replayLimitBytes = 256 * 1048576 = 268,435,456` 字节。最初按下面的合成实测定为 32 MiB；集成时用本机真实对话复测：43 MB 的 1.6 秒、峰值 180 MB，112 MB 的 2.1 秒、峰值 380 MB（真实记录的用量没有合成数据那么密），而真实的长对话常有一百多 MB，所以提高到 256 MiB。回放在独立的调试进程里构建，不影响直播。选中对话文件，加其任务的 `meta.json`、`result.json`、`events.jsonl` 的 stat 大小；超限抛出原文 `replay too large`，附 `code: 'REPLAY_TOO_LARGE'` 和数值 `bytes` / `limit`。

必须先扫描一次任务 meta 才能识别 `claude_session` 归属。扫描期间不读 result、events 或对话正文；算完全部候选字节并通过检查后才打开这些文件。meta 不会为每个对话重读。没有指定 sessions 时仍按 mtime 取窗口候选，正文解析后保持 last_at 过滤及 200 对话上限；预检因此可能保守高估最终选入的量。指定 sessions 时仅考虑列出的对话，也允许显式选择旧对话；空数组生成空回放。

默认上限依据：生成器产生 33,449,674 字节的单对话（31.9 MiB），用默认 createUniverse 直接构建，耗时 9.8471 秒、进程峰值 326.625 MiB、55,667 条时间线消息。更大的 33,554,503 字节样本在基准中绕过上限测得 universe.replay 9.5235 秒。保留约五秒余量；字节限额只是本机这些合成负载的估算，不是任意输入的硬性时间保证。

## 复杂度变化

记 U 为 Claude usage 数，E 为归一化事件数，R 为全部任务数，S 为对话数，T 为时间步数，D 为最终输出消息量，r_i 为对话 i 的任务数。

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| buildReplay 的 host 用量/计价 | 每条 usage 扫描前缀，O(U²) | 按原顺序增量求和 O(U)，整体仍有 O(E log E) 时间排序 |
| 元数据发现与任务详情读取 | O(S×R) 元数据扫描，每个任务 events 二读 | 一次 O(R) 元数据发现，按 session 分组，选中的 result/events 各一次；车道排序仍使用现有 selectScope |
| 宇宙摘要 | 每步全部活跃对话，且每个摘要过滤全部任务、重加全部 usage | 只处理本步来源、阈值到期的对话；任务索引按对话，usage 常见追加 O(1)，复用未变摘要/任务字段 |
| 项目/agents/差量比较 | 每步全量派生并 stringify 全对象 | 项目在加入/归属/过期影响时派生；agents 只更新涉及的 agent；只比较受影响摘要，不 stringify 整份宇宙 |
| detail | 重新扫描全部任务、读正文、再构建 | 使用已整理数据；首次 O(E_i log E_i) 构建，后续 O(1)，零文件读取 |
| addClaude 的起止时刻 | map 数组加大参数展开，O(R) 时间/空间，可能栈溢出 | 循环取 min/max，O(R) 时间、O(1) 额外空间 |

常见只追加 usage 的负载接近 O(输入 + 排序 + D)，内存 O(输入的归一化记录 + D)，已完成的来源及时释放。没有宣称任意输入严格线性：现有任务车道排序、单对话任务摘要扫描，以及下面为精确输出保留的重算路径仍可能超线性。

## 为保持输出保留的行为

- 明细解析只对同一 message id 的末行计 usage；宇宙摘要按播放时刻保留 Map 中最新版本，没有 usage 的新行撤回旧值。两者中间状态原本就不同。
- 重复/撤回消息，或 usage 跨出窗口时，按 Map 原顺序重加当前窗口，避免用减法增量改变 IEEE 浮点结果。此路径仍是 O(当前 usage 数)，连续替换或很长时间跨度的数据不保证严格线性。
- 某条 host usage 无法计价时，host 前缀费用保持未知；宇宙摘要仍可累加可计价任务，并用 cost_partial 标记不完整。null 和零不互换。
- 保留每个来源原有的五种 tick、压缩到同一时刻时的 original 排序，以及先 project、再 session、最后 agents 的输出顺序。小数时钟的严格失效条件在下一现有时间步生效，不提前到等号边界。
- 保留状态判定先截取最近十分钟/最多 16 个任务再判断 dispatching 的行为；failure alert、90 秒思考、10 分钟工具、30 分钟告警和窗口阈值照旧。
- 不给 sessions 时，仍按文件 mtime 决定读取候选、按内容 last_at 过滤、最多 200 对话；旧项目的初始信息和 older 计数继续保留。项目从活跃列表消失时也没有新增删除事件。
- 明细的 host idle 取整份对话记录的 latest_at，并使用构建时固定的全局 clock。构建后追加的记录留给下一次回放。

## 复现

以下 `$env:TEMP` 是系统临时目录。gen 会清空其目标子目录，gen/bench 都拒绝临时目录以外的路径。

```powershell
node tools/board-bench/gen.mjs "$env:TEMP/foreman-replay-bench-small" 20 2 1 2
node tools/board-bench/bench.mjs "$env:TEMP/foreman-replay-bench-small" replay
node tools/board-bench/gen.mjs "$env:TEMP/foreman-replay-bench-medium" 1000 40 30 1000
node tools/board-bench/bench.mjs "$env:TEMP/foreman-replay-bench-medium" replay
node tools/board-bench/gen.mjs "$env:TEMP/foreman-replay-bench-16" 0 1 1 0 16
node tools/board-bench/bench.mjs "$env:TEMP/foreman-replay-bench-16" build
node tools/board-bench/gen.mjs "$env:TEMP/foreman-replay-bench-32" 0 1 1 0 32
node tools/board-bench/bench.mjs "$env:TEMP/foreman-replay-bench-32" build
```

最终全量 `npm test` 及集成构建、同步由调度方执行。本任务只运行上述指定定向测试与合成基准。
