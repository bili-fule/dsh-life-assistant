# 编排优先：现场审计、实现状态与验收

更新：2026-10-21。对应 `docs/plans/orchestration-first-plan.md`（当前编排架构的最高优先级计划）。本文区分**已设计 / 已实现 / 已测试 / 已部署 / 未验证**，并且只把有测试或真实运行回执的东西标成已验证。生产运行的是 0.39.0（`13e98e4`，20:22 部署，含连续主体与显式结束）；本文的编排改造提交都在那之后，**尚未部署**，上线清单见 `deploy/RELEASE-0.40.md`。

## 0. 结论速览

| 阶段（计划 §10） | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| 1. 现场审计与基线 | 已实现、已核对 | 本文 §1；基线 `npm test` 257/257（提交 `ffb1b8f`） |
| 2. 默认委派（工具面 + 接管例外） | 已实现、已测试、未部署 | `test/orchestration.test.mjs`（默认隐藏重执行工具、陈旧工具列表不能执行、接管需理由、到期/归还后失效） |
| 2b. 后续聊天消息直达执行者 | 已实现、已测试、未部署 | `test/chat-routing.test.mjs`（挂起释放进程与租约、真实新消息才唤醒、突发一次唤醒、身份与 Session 复用、游标不重复、并发满排队、过期取消） |
| 3. 意图队列 | 已实现、已测试、未部署 | `test/team-intents.test.mjs`（能力映射到角色、去重与修订、优先级 + 等待提升、依赖与开始时间、并发排队、尝试记录） |
| 4. 活动图与按需观察 | 已实现、已测试、未部署 | `test/activity-graph.test.mjs`（为什么做、方向变更、谁验证、还缺什么、依赖什么；裁定不静默变成支持；跨平台不可见） |
| 5. 冷分支与反思 | 已实现、已测试、未部署 | `test/branch-folding.test.mjs`（热链路保留未完成工作/承诺/未解决冲突；折叠只留摘要与引用、可展开回原记录；折叠不删数据） |
| 6. 真实模型验收与上线 | 真实模型部分已跑通（默认委派、并行、同级问答、意图队列驱动执行者、聊天挂起续接、成本实测）；**未部署** | HEAD 复跑：`team-native-real` 串行 61.4 s / 并行 13.0 s（37,371 / 26,123 Token）、`team-native-intent` 8.2 s / 9,787 Token、`team-native-chat` 两提示 18,757 Token，均 `PASS`；记录见 [real-model-run-2026-10-21.md](real-model-run-2026-10-21.md) |

## 1. 审计基线（本轮动手前的真实现场）

- 版本：工作树 HEAD `ffb1b8f`，包版本 0.39.0；当时生产 0.38.0（现已升到 0.39.0）。测试 257/257 通过，`npm run check` 通过。
- **主体工具面（改动前）**：`COMMON_TOOLS` + `TEAM_TOOLS` + 动机 + 记忆 + `mcp__playwright-mcp__browser_*` + `yoyo_execute/yoyo_job/yoyo_projects` + `yoyo_debug*`。主体只要愿意，就能自己开隔离浏览器、跑代码、进排障容器——「尽量少做具体执行」当时只是一句提示词。
- **后续消息路径（改动前）**：`SocialData.attention()` → `SocialAgent.choose()` → 唤醒主体。只有在该窗口另有执行者持有发言租约（`TeamHost.activeWindow`）时，主体才不会被这条消息唤醒；而执行者本身只在**它自己那次原生运行期间**用 `wait` 看到新消息。执行者的原生轮次一旦结束，同一话题的后续消息又回到主体，由主体重新分派或自己回复。
- **并发**：`TeamHost` 的 `maxConcurrent` 默认 2，`deploy/README.md` 写 2；生产 0.38 的 `team` 段并未启用。计划 §4 要求「先测容量再逐步启用两个分支」，这一点仍未在服务器上验证。
- **意图队列（改动前）**：`yoyo_team_intents` 只记录 task ↔ concern 的分工理由（`rationale/done_when/stop_when`），没有优先级、依赖、去重、领取状态、饥饿提升。`yoyo_team_tasks.depends_on` 存在，但没有「先建意图、再按优先级领取」的队列。
- **活动图（改动前）**：有任务证据板 `yoyo_team_evidence`、来源登记 `sourceRegistry`、矛盾裁定 `yoyo_team_source_decisions`、事件总线 `yoyo_team_events`；没有节点/边，没有「为什么做这件事、哪项发现改变了方向、当前结论依赖什么」的图检索。
- **冷分支折叠（改动前）**：主体 `state()` 直接注入全部 activities、concerns、plans、recent feedback，没有热链路选择，也没有已结束分支的折叠与展开。
- **计量（改动前）**：只有 step/token 计数，且 token 缺失时写 0；没有「主体亲自执行占比」「事件投递延迟 / 模型响应延迟」的分开记录。

## 2. 已实现：默认委派（计划 §3、§10.2）

有执行者时，主体的默认工具面是编排，而不是执行：

| 能力 | 改动前 | 现在 | 证据 |
| --- | --- | --- | --- |
| 重执行工具可见性 | 默认可见 | 有 `team` 时默认从工具面移除：隔离浏览器（`mcp__playwright-mcp__browser_*`）、`yoyo_execute/yoyo_job/yoyo_projects`、`yoyo_debug/yoyo_debug_status/yoyo_debug_patch` | `test/orchestration.test.mjs`「default delegation removes the heavy execution tools」 |
| 陈旧工具列表 / 重放调用 | 无检查 | `tools/pre-execute` 在派发时再查一次，缺失授权直接拒绝并提示 `yoyo_takeover` | 同上（`preExecute('yoyo_execute')` 被拒） |
| 亲自执行的例外 | 隐式、可随时发生 | `yoyo_takeover`：必须写理由（1–1000 字），默认 10 分钟、最多 60 分钟，写入 `yoyo_takeovers` 审计表，到期或 `yoyo_handback` 后失效 | 同上（grant/release/过期三条断言 + `takeoverLog()` 的 `released_by`） |
| 没有执行者时 | — | 主体保留完整工具面（`mode: self`），不会因为没有可委派对象而残废 | 同上「without executors the subject keeps its whole surface」 |
| 提示词 | 只说「可以分派」 | `TEAM_POLICY` 开头写明默认分工、可用例外、以及「后续消息由宿主直接交给执行者、不经你逐句批准」和「哪些变化才需要主体决定」 | `src/team-host.mjs`；`test/documented-defaults.test.mjs` 校验角色与配置 |
| 主体状态 | 无编排字段 | `state().orchestration = {mode, executionGrant, heavyToolsHidden, guidance, metrics}` | 同上 |

审计与计量落库（新 `src/orchestration-metrics.mjs`，表 `yoyo_metric_counters / yoyo_metric_timings / yoyo_metric_samples`）：

- `subject_exec`：主体真正调用了重执行工具的次数（每次派发计一次）。
- `executor_step`：执行者真正走了一步的次数。
- `subject_takeover`：接管次数。
- `chat_routed_to_executor`：后续消息被宿主直接交给执行者的次数。
- `subject_planned_message`：一条消息真的让主体开始规划的次数（被路由到执行者的消息不计）。
- `event_delivery`：事件写入 → 在执行者原生安全边界交付的耗时（**程序传递延迟**）。
- `worker_run`：一次执行者原生运行的耗时（**模型响应延迟**）。
- `subject_turn`：主体一轮原生运行的耗时。
- `reply_latency`：分支真正回话时，距该窗口最近一条入站消息的时间（含读取与生成）。
- `reply_latency`：分支真正回话时，距该窗口最近一条入站消息的时间（含读取与生成）。
- `tokens_used`（样本）：每次执行者运行上报的 Token；未上报写 `reported=0, value=null`，读取为「未测量」，不记成 0。用量按**尝试**记账，所以聊天分支挂起后仍会记下这次花费。

## 2b. 已实现：后续聊天消息直达执行者（计划 §5）

| 环节 | 现在怎么做 | 代码 | 证据 |
| --- | --- | --- | --- |
| 起点 | 聊天任务创建时记录该窗口的消息游标 `chat_through`，已有消息不算这个执行者的新工作 | `TeamStore.create()` | `test/chat-routing.test.mjs`「a new chat task starts after what is already there」 |
| 挂起 | 执行者要等对方接着说时用 `team_pause`；宿主把任务置为 `suspended`、写挂起原因与一条进展、释放进程并交回发言租约 | `TeamStore.pause()`、`TeamCoordinator.start()` 的 `pause` 分支 | 同文件（`paused_reason`、租约 `expires_at=0`、只有聊天类角色可以挂起） |
| 唤醒 | `TeamHost.tick()` → `routeChatMessages()`：按 `quietMs` 合并突发、只对真有新消息的挂起任务启动；开场是 `{kind:'new_messages',after,through,count}` 的真实投递 | `TeamHost.routeChatMessages()`、`TeamNativeAdapter` | 「the burst wakes the executor」+ 断言 `count/after/through` |
| 身份与 Session | **常驻会话**：聊天/peer 任务在一个进程里保持同一个原生 Session，挂起时不关闭、唤醒时用同一个 Session 再提一次；SDK 实测「同进程可续、跨进程拒绝已存在的 id」（`test/team-native-resume-probe.mjs`），所以常驻是唯一诚实的复用方式；会话数有上限、闲置 15 分钟回收，进程重启后退化为「新会话 + 续接简报」（如实记录的残余限制） | `TeamCoordinator.resident`、`TeamNativeAdapter.open()` | 「a chat branch keeps one resident native session…」+ 真实运行 `test/team-native-chat.mjs` |
| 唤醒投递 | 唤醒简报直接带新消息原文（最多 10 条、每条 800 字），不必猜游标；`team_read` 仍可从游标回看更早内容 | `TeamStore.chatWakeCandidates()`、`TeamNativeAdapter.opening()` | 真实运行里第二次 `team_read` 的 `after` 正是上次游标 |
| 不重复投递 | 游标在**交付**时前进；运行期间到达的消息最多多花一次唤醒，不会丢 | `TeamStore.ackChatThrough()` | 「a new message that arrives during the run costs one more wake」 |
| 容量 | 并发满时不启动、消息保持排队，下一轮 tick 再试；主体不会被默默拉来代做 | `routeChatMessages()` 的 capacity 分支 | 「no free executor slot leaves the message queued」 |
| 过期 | 过期挂起先在 `tick()` 里置为 `cancelled`，不再路由 | `TeamHost.tick()` | 「an expired suspension ends the activity」 |
| 主体侧 | `choose()` 用 `ownsWindow()` 跳过有聊天执行者（运行中或挂起）的窗口；主体仍可用 `team_takeover` 亲自发言，接管会让旧任务发送失效 | `TeamHost.ownsWindow()`、`SocialAgent.choose()` | 「follow-up messages in an owned window…」 |
| 取消 | 取消现在也覆盖 `suspended`（此前只覆盖 ready/running/waiting） | `TeamCoordinator.cancel()` | 同上测试的取消分支 |

唤醒提示不是「继续当前活动」的固定句子：它带窗口与消息编号区间，且执行者被要求用 `team_read` 从 `after` 之后接着读。空窗口不产生任何唤醒，因此没有固定空提示驱动，也没有模型侧轮询。



## 2c. 已实现：意图队列（计划 §4）

| 环节 | 现在怎么做 | 代码 | 证据 |
| --- | --- | --- | --- |
| 三层权威 | 活动（持续目标，`yoyo_activities`）→ 意图（可委派的一段工作，`yoyo_intents`）→ 任务（一次尝试，`yoyo_team_tasks`）。意图是队列的唯一权威，任务仍是一次尝试的唯一权威 | `src/team-intents.mjs` | `test/team-intents.test.mjs` |
| 能力→角色 | 主体只写能力（chat/read/web/research/verify/code/engineer/peer），宿主映射到最窄的固定角色；「读私聊窗口 + 读公开网页」这类组合只能是 peer，不会被猜成 reader | `TeamIntents.roleFor()` | 「reading a window and browsing public pages needs a peer」 |
| 去重 | 同窗口、同活动、同能力、同目标 = 一个意图；已结束的意图可以被重新尝试，届时 `revision` 自增、`dedupe_key` 加后缀，历史保留 | `create()` | 「the same purpose is one intent」+ 修订断言 |
| 排序与饥饿 | 有效优先级 = 主体给的优先级 + 每等待 5 分钟 +1（上限 +20）；依赖未完成、`not_before` 未到的不进候选 | `effectivePriority()`、`ready()` | 「priority orders the queue…」+ 老化提升断言 |
| 领取与租约 | 宿主插入任务后 `claim()` 记 `claimed_by/task_id/lease_expires/attempts+1`，并写 `yoyo_intent_attempts` 一行 | `claim()`、`note()` | 「the host starts queued work…」 |
| 尝试状态映射 | 任务状态镜像到意图：completed→completed、cancelled→abandoned、blocked→blocked、suspended→waiting；反向不成立，意图不会偷偷改回 running | `syncFromTasks()` | 同上（任务完成后意图 completed） |
| 并发与排队 | 没有空位时不建任务、不起进程，意图保持 ready，等待原因可观察；有空位后下一轮 tick 启动 | `TeamHost.startIntent()`、`tick()` | 「a full slot leaves the intent queued…」 |
| 放弃 | `team_intent{id, cancel:true}` 先取消其任务（发言权一并失效）再把意图置为 abandoned 并写理由 | `TeamHost.cancelIntent()` | 「an abandoned intent cancels its branch…」 |

主体工具面：`team_intent`（不放 goal 即列出队列，带 id 可调优先级/开始时间或放弃）。队列摘要同时进入 `team_overview`/`state().team.queue` 与运维状态 `intents`，因此「无空闲额度时工作排队且可观察」是可检查的。



## 2d. 已实现：活动图与冷分支折叠（计划 §6、§9）

**活动图是索引，不是第二个权威。** `ActivityGraph` 每次查询都从活动、意图、任务、证据、裁定、方向变更与作业重新派生节点与边（activity/intent/task/observation/decision/artifact；derived_from/depends_on/produced/supports/contradicts/supersedes），所以撤权或改状态后图不会留下过期的旧样子。`team_graph` 用一个范围内的读回答五件事：为什么做、哪次改变改变了方向、谁验证过、还缺什么（未答问题、排队/受阻意图）、结论依赖什么（依赖意图、分支状态、证据条数）。`refuted` 与 `unresolved` 的裁定不会变成 `supports` 边，冲突保持可见。

**冷分支只折叠注意力，不删记录。** `BranchFolding.hotChain()` 算出热链路：未完成意图与其起因、刚产生的事实、未解决的冲突、未兑现的承诺。`fold()` 只处理「活动已结束 + 意图终态且安静 6 小时以上 + 工作里没有未解决裁定」的整段工作，写一条摘要与引用（任务、报告、证据、事件编号）到 `yoyo_folded_branches`；`team_expand` 可以回到真实记录，并明确摘要不是新事实。主体的 `state()` 增加 `folded` 列表与热链路入口；底层活动、任务、报告、证据一条不删。这与 DSH 原生压缩是两回事：原生压缩缩短模型上下文（263K 触发），折叠缩短主体被要求关注的范围。

证据：`test/activity-graph.test.mjs`、`test/branch-folding.test.mjs`。



## 3. 验收口径

本计划的验收必须可重复观察「主体决定与协调、执行者实际推进」，并且保持一个连续身份和活动图。判读规则：

### 3a. 指标（每个都由宿主自己观测，模型不能自造）

| 指标 | 定义 | 现状 |
| --- | --- | --- |
| 主体重执行占比 | `subject_exec` / (`subject_exec` + `executor_step`) | 标准委派场景预期 0；真实模型意图队列运行中实测 `subject_exec=0`、`executor_step=6` |
| 每条聊天消息触发的主体规划次数 | 每次消息导致主体规划计 1（`subject_planned_message`） | 有确定性测试：被执行者拥有的窗口为 0，活动结束后为 1 |
| 事件延迟 vs 模型响应 | `event_delivery`（写入→原生边界）与 `worker_run` / `subject_turn` 分开记 p50/p95 | 有测试；真实运行记录 `worker_run` 一次 21.5 s 级 |
| 分支运行重叠 | 两个任务在同一时间窗内都有原生运行 | `test/team-events.test.mjs`；真实模型复跑并行 39.0 s vs 串行 146.5 s |
| 队列等待 | 意图 `waitedMs` 与等待原因（依赖/开始时间/无空位） | `test/team-intents.test.mjs` |
| 首回复/回话延迟 | `reply_latency`（距最近入站消息） | `test/chat-routing.test.mjs` |
| 调用/Token/成本 | `yoyo_team_usage`（steps、tokens、tokens_reported）按**尝试**记账，暂停后仍记录本次花费 | 真实运行已测得 token（见下表）；未上报的尝试仍标为 `tokensReported=false`，不记 0 |

真实模型实测（`deepseek-flash`，本地夹具，不连 QQ）：

| 场景 | 墙钟 | 步数 | Token |
| --- | --- | --- | --- |
| 两分支串行 | 61.4 s | 5 / 6 | 37,371 |
| 两分支并行 | 13.0 s | 5 / 5 | 26,123 |
| 意图队列 → 单个执行者 | 8.2 s | 4 | 9,787 |
| 聊天挂起 → 唤醒（两次提示） | 约 30 s | 7 | 18,757 |

（2026-10-21 23:50 在 HEAD 上复跑；更早一次同样方向的对照见 [真实模型运行记录](real-model-run-2026-10-21.md) 的表格。）


- ✅ 有确定性测试：行内写测试文件与关键断言。
- 📄 只有规则：写在文档/提示词里，没有确定性断言。
- ⏳ 需真实环境：真实模型/真实 QQ/服务器容量才能证明。
- ⬜ 未实现。

计划 §11 的十项验收，当前状态：

| 用例 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| 请去 xmfu 看星洛 | ✅ | `test/team-intents.test.mjs`：主体只写意图（读窗口 + 读网页 → peer），宿主建任务并由执行者推进，主体 `subject_exec` 为 0；意图与活动通过 `yoyo_activity_links` 相连 |
| 持续普通聊天 | ✅ | `test/chat-routing.test.mjs`：后续消息由宿主按真实游标唤醒同一个执行者；窗口被执行者拥有时主体不会被唤醒（`test/orchestration.test.mjs`）；挂起即暂停，不是完成；常驻会话跨挂起只创建一次。真实模型：`test/team-native-chat.mjs`（两次提示同一常驻会话、唤醒带 2 条原文、游标推进到 5、回复编号去重） |
| 聊天同时研究 | ✅ | `test/team-events.test.mjs`「two generic peer branches on two windows overlap and share a finding mid-run」：两个**通用 peer** 分支同时运行，finding 在作者仍在运行时被兄弟分支在边界收到；主体侧 `test/orchestration.test.mjs` 断言执行者占用一个窗口时，另一个窗口的消息仍会唤醒主体；真实模型 HEAD 复跑并行 13.0 s vs 串行 61.4 s（同一次对照，Token 26,123 vs 37,371） |
| 方向变更 | ✅ | `test/team-events.test.mjs`（`direction_changed` 带活动版本送达，旧结果不算完成新目标） |
| 无空闲额度 | ✅ | `test/team-intents.test.mjs`：并发满时意图保持 ready、不建任务、等待原因可见；有空位后下一轮 tick 启动。主体没有「默默接手」的路径（重执行工具仍默认关闭） |
| 分支显式完成 | ✅ | `test/explicit-completion.test.mjs`、`test/team-events.test.mjs`（分支终态与活动终态分开） |
| 未完成活动跨压缩/重启 | ✅ | `test/subject-continuity.test.mjs`（重启恢复活动与步骤；压缩后重新投影）；「不重复 create Session」见 `test/team-store.test.mjs` 的 run_key/agentId 派生 |
| 冷分支展开 | ✅ | `test/branch-folding.test.mjs`：摘要 → 真实报告、证据与事件编号，并明确「不是新事实」；未解决冲突与未完成意图不会被折叠 |
| 闲置 | ✅ | 无固定「继续当前活动」提示：`test/subject-continuity.test.mjs`、`test/runtime-scheduling.test.mjs`（无事可用时 `choose()` 返回 null，不空转）；空轮询由宿主等待替代（`test/team-events.test.mjs` 的 `wait_event`） |
| QQ 与微信 | ✅ | `test/subject-continuity.test.mjs`、`test/social-store.test.mjs`（微信是独立主体：不同库、不同凭据、不同权限、不可跨主体读取） |
| 读取/浏览有真实回执 | ✅ | `test/team-events.test.mjs`：宿主记录分支真正读过的消息编号（`yoyo_team_reads`）与真正抓取的网址（`yoyo_team_fetches`），证据的 `readVerified` 只在这两项命中时为真；没读过/没抓过的来源仍留在证据板上，但标成自述 |

## 4. 未完成部分（按计划顺序）

### 4.1 后续聊天消息直达执行者（计划 §5）—— 已实现，见 §2b
机制已落地并被 `test/chat-routing.test.mjs` 断言。剩余的是观察项：真实模型是否会在合适的时候用 `team_pause` 挂起、被唤醒后是否从游标处接着读、以及频繁续接时的成本。

### 4.2 意图队列（计划 §4）—— 已实现，见 §2c
剩余的是真实模型观察项：主体是否会稳定地先写意图再分派、优先级是否被合理使用、饥饿提升是否在真实节奏下需要调整。

### 4.3 活动图与按需观察（计划 §6）—— 已实现，见 §2d

### 4.4 冷分支与反思（计划 §9）—— 已实现，见 §2d
剩余观察项：真实会话里折叠阈值（6 小时）是否合适，以及主体是否会在需要时主动展开，而不是凭摘要当作事实。

### 4.5 真实验收与上线（计划 §10.6）
需要在隔离夹具上用真实模型验证默认委派、并行与途中纠偏，记录主体重执行占比、每条聊天消息触发的主体规划次数、首回复与完成延迟、队列等待、分支重叠、事件延迟、调用/Token；随后按既有授权灰度，冻结 SHA + 备份 + 迁移 + 只读核对 + 保留新增消息的回滚策略。

## 5. 残余风险

- 隐藏工具面会让主体在「没有执行者可用」的窗口里更依赖分派；若某窗口角色受限（`research/engineer` 只能 public），主体可能反复分派失败。承接办法：`team_delegate` 的失败必须回到主体状态里可见，而不是静默。
- 接管是时间窗（默认 10 分钟），不是单轮：长任务可能在窗口中途过期。当前靠 `state().orchestration.executionGrant.expiresAt` 让主体看见剩余时间。
- 计量只覆盖宿主能看到的事实：模型内部轮次不做计量；token 依赖运行时上报，未上报即「未测量」。
