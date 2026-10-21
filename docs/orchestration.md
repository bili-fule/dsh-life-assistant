# 编排优先：现场审计、实现状态与验收

更新：2026-10-21。对应 `docs/plans/orchestration-first-plan.md`（当前编排架构的最高优先级计划）。本文区分**已设计 / 已实现 / 已测试 / 已部署 / 未验证**，并且只把有测试或真实运行回执的东西标成已验证。生产仍是 0.38.0（提交 `16b71e3`），仓库改动尚未部署。

## 0. 结论速览

| 阶段（计划 §10） | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| 1. 现场审计与基线 | 已实现、已核对 | 本文 §1；基线 `npm test` 257/257（提交 `ffb1b8f`） |
| 2. 默认委派（工具面 + 接管例外） | 已实现、已测试、未部署 | `test/orchestration.test.mjs`（默认隐藏重执行工具、陈旧工具列表不能执行、接管需理由、到期/归还后失效） |
| 2b. 后续聊天消息直达执行者 | 已实现、已测试、未部署 | `test/chat-routing.test.mjs`（挂起释放进程与租约、真实新消息才唤醒、突发一次唤醒、身份与 Session 复用、游标不重复、并发满排队、过期取消） |
| 3. 意图队列 | 已设计、未实现 | §4.2 |
| 4. 活动图与按需观察 | 已设计、未实现（证据板/来源登记/裁定已存在） | §4.3 |
| 5. 冷分支与反思 | 已设计、未实现 | §4.4 |
| 6. 真实模型验收与上线 | 未完成（既有真实回放见 `docs/real-model-run-2026-10-21.md`，不是本计划的验收） | §4.5 |

## 1. 审计基线（本轮动手前的真实现场）

- 版本：工作树 HEAD `ffb1b8f`，包版本 0.39.0；生产 0.38.0。测试 257/257 通过，`npm run check` 通过。
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
- `event_delivery`：事件写入 → 在执行者原生安全边界交付的耗时（**程序传递延迟**）。
- `worker_run`：一次执行者原生运行的耗时（**模型响应延迟**）。
- `subject_turn`：主体一轮原生运行的耗时。
- 未上报的量（例如运行时不提供 token 计量）写 `reported=0, value=null`，读取为「未测量」，不记成 0。

## 2b. 已实现：后续聊天消息直达执行者（计划 §5）

| 环节 | 现在怎么做 | 代码 | 证据 |
| --- | --- | --- | --- |
| 起点 | 聊天任务创建时记录该窗口的消息游标 `chat_through`，已有消息不算这个执行者的新工作 | `TeamStore.create()` | `test/chat-routing.test.mjs`「a new chat task starts after what is already there」 |
| 挂起 | 执行者要等对方接着说时用 `team_pause`；宿主把任务置为 `suspended`、写挂起原因与一条进展、释放进程并交回发言租约 | `TeamStore.pause()`、`TeamCoordinator.start()` 的 `pause` 分支 | 同文件（`paused_reason`、租约 `expires_at=0`、只有聊天类角色可以挂起） |
| 唤醒 | `TeamHost.tick()` → `routeChatMessages()`：按 `quietMs` 合并突发、只对真有新消息的挂起任务启动；开场是 `{kind:'new_messages',after,through,count}` 的真实投递 | `TeamHost.routeChatMessages()`、`TeamNativeAdapter` | 「the burst wakes the executor」+ 断言 `count/after/through` |
| 身份与 Session | agentId 由任务编号派生，唤醒复用同一身份 → 同一原生 Session，不重复 `create` | `TeamCoordinator.start()` | 「the same executor identity, so the same native session」 |
| 不重复投递 | 游标在**交付**时前进；运行期间到达的消息最多多花一次唤醒，不会丢 | `TeamStore.ackChatThrough()` | 「a new message that arrives during the run costs one more wake」 |
| 容量 | 并发满时不启动、消息保持排队，下一轮 tick 再试；主体不会被默默拉来代做 | `routeChatMessages()` 的 capacity 分支 | 「no free executor slot leaves the message queued」 |
| 过期 | 过期挂起先在 `tick()` 里置为 `cancelled`，不再路由 | `TeamHost.tick()` | 「an expired suspension ends the activity」 |
| 主体侧 | `choose()` 用 `ownsWindow()` 跳过有聊天执行者（运行中或挂起）的窗口；主体仍可用 `team_takeover` 亲自发言，接管会让旧任务发送失效 | `TeamHost.ownsWindow()`、`SocialAgent.choose()` | 「follow-up messages in an owned window…」 |
| 取消 | 取消现在也覆盖 `suspended`（此前只覆盖 ready/running/waiting） | `TeamCoordinator.cancel()` | 同上测试的取消分支 |

唤醒提示不是「继续当前活动」的固定句子：它带窗口与消息编号区间，且执行者被要求用 `team_read` 从 `after` 之后接着读。空窗口不产生任何唤醒，因此没有固定空提示驱动，也没有模型侧轮询。



## 3. 验收口径

本计划的验收必须可重复观察「主体决定与协调、执行者实际推进」，并且保持一个连续身份和活动图。判读规则：

- ✅ 有确定性测试：行内写测试文件与关键断言。
- 📄 只有规则：写在文档/提示词里，没有确定性断言。
- ⏳ 需真实环境：真实模型/真实 QQ/服务器容量才能证明。
- ⬜ 未实现。

计划 §11 的十项验收，当前状态：

| 用例 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| 请去 xmfu 看星洛 | ⬜ | 需要意图队列（§4.2）才能把「观察意图 → 执行者读群+浏览 → 主体零重执行」做成可断言路径；主体零重执行的**工具面前提**已由 §2 提供 |
| 持续普通聊天 | ✅ | `test/chat-routing.test.mjs`：后续消息由宿主按真实游标唤醒同一个执行者身份与 Session；窗口被执行者拥有时主体不会被唤醒（`test/orchestration.test.mjs`）；挂起即暂停，不是完成 |
| 聊天同时研究 | ⏳ | 已有并行分支与事件（`test/team-events.test.mjs`）与真实回放（并行 9.4 s vs 串行 46.2 s），但「中途分享 + 主体仍能处理新要求」需在新的默认委派下重跑 |
| 方向变更 | ✅ | `test/team-events.test.mjs`（`direction_changed` 带活动版本送达，旧结果不算完成新目标） |
| 无空闲额度 | ⬜ | 需要 §4.2 的队列可观察性（ready/running/waiting 与等待原因） |
| 分支显式完成 | ✅ | `test/explicit-completion.test.mjs`、`test/team-events.test.mjs`（分支终态与活动终态分开） |
| 未完成活动跨压缩/重启 | ✅ | `test/subject-continuity.test.mjs`（重启恢复活动与步骤；压缩后重新投影）；「不重复 create Session」见 `test/team-store.test.mjs` 的 run_key/agentId 派生 |
| 冷分支展开 | ⬜ | 需要 §4.4 |
| 闲置 | ✅ | 无固定「继续当前活动」提示：`test/subject-continuity.test.mjs`、`test/runtime-scheduling.test.mjs`（无事可用时 `choose()` 返回 null，不空转）；空轮询由宿主等待替代（`test/team-events.test.mjs` 的 `wait_event`） |
| QQ 与微信 | ✅ | `test/subject-continuity.test.mjs`、`test/social-store.test.mjs`（微信是独立主体：不同库、不同凭据、不同权限、不可跨主体读取） |

## 4. 未完成部分（按计划顺序）

### 4.1 后续聊天消息直达执行者（计划 §5）—— 已实现，见 §2b
机制已落地并被 `test/chat-routing.test.mjs` 断言。剩余的是观察项：真实模型是否会在合适的时候用 `team_pause` 挂起、被唤醒后是否从游标处接着读、以及频繁续接时的成本。

### 4.2 意图队列（计划 §4）
目标：活动（持续目标）→ 意图（可委派的一段工作）→ 任务（执行尝试）三层权威，状态 `ready/claimed/running/waiting/blocked/completed/abandoned`，带优先级、依赖、去重（同活动同目的先检索）、领取与租约、等待时间提升、以及旧状态映射。
现状缺口：`yoyo_team_intents` 只有分工理由；没有队列与领取。

### 4.3 活动图与按需观察（计划 §6）
目标：节点 activity/intent/observation/decision/artifact，边 derived_from/depends_on/produced/supports/contradicts/supersedes，能回答「为什么做、什么改变了方向、谁验证过、还缺什么、当前结论依赖什么」；主体默认只消费变化摘要。
现状缺口：证据板与来源登记是平的，没有图与「为什么」检索。

### 4.4 冷分支与反思（计划 §9）
目标：热链路 = 未完成意图 + 起因与必要依赖 + 刚产生的事实 + 未解决冲突/未兑现承诺；已结束且不再支撑活跃工作的分支折叠成摘要并保留引用，可展开回到原记录。与 DSH 原生压缩分开，不能混为「删旧消息」。
现状缺口：主体状态注入全部活动与关切，无折叠。

### 4.5 真实验收与上线（计划 §10.6）
需要在隔离夹具上用真实模型验证默认委派、并行与途中纠偏，记录主体重执行占比、每条聊天消息触发的主体规划次数、首回复与完成延迟、队列等待、分支重叠、事件延迟、调用/Token；随后按既有授权灰度，冻结 SHA + 备份 + 迁移 + 只读核对 + 保留新增消息的回滚策略。

## 5. 残余风险

- 隐藏工具面会让主体在「没有执行者可用」的窗口里更依赖分派；若某窗口角色受限（`research/engineer` 只能 public），主体可能反复分派失败。承接办法：`team_delegate` 的失败必须回到主体状态里可见，而不是静默。
- 接管是时间窗（默认 10 分钟），不是单轮：长任务可能在窗口中途过期。当前靠 `state().orchestration.executionGrant.expiresAt` 让主体看见剩余时间。
- 计量只覆盖宿主能看到的事实：模型内部轮次不做计量；token 依赖运行时上报，未上报即「未测量」。
