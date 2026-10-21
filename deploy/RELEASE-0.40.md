# 0.40.0 上线前清单与回滚办法（编排优先改造）

日期：2026-10-21。基线：生产 0.39.0（`13e98e4`，20:22 部署，含连续主体与显式结束）。本版本在仓库内已实现并通过确定性测试与有界真实模型验证，**尚未部署**。本文只写操作步骤与核对点，不把「准备好」当成「已上线」。

## 1. 冻结什么

| 项 | 值 |
| --- | --- |
| 待上线提交 | 推送后的 `main` 顶端（最后一次文档/修复提交；编排改造的主体提交为 `f7e8535`、`1755c6d`、`cd1cd0e`、`18ec1cd`、`34df8e4`） |
| 版本号 | `package.json` 0.40.0 |
| 测试 | `npm run check` 通过；`npm test` 281/281 |
| 原生验证（需要本机 SDK） | `node test/team-native-smoke.mjs`、`node test/team-native-events.mjs` 均 `PASS` |
| 真实模型验证（可选、需要密钥） | `node test/team-native-real.mjs`（串行/并行对照）、`node test/team-native-intent.mjs`（意图队列 → 真实执行者）、`node test/team-native-chat.mjs`（聊天挂起与唤醒，常驻会话）、`node test/team-native-resume-probe.mjs`（SDK 会话续接能力探测）均 `PASS`，见 [真实模型运行记录](../docs/real-model-run-2026-10-21.md) |

上线前把实际提交 SHA 写进 `deploy/STATUS.md` 顶部的「生产最新」段落，不要用「最新代码」这种说法。

## 2. 数据库迁移（全部是增量）

启动即自动执行，无需手工脚本；旧库打开只加东西：

- 新增表：`yoyo_takeovers`、`yoyo_intents`、`yoyo_intent_attempts`、`yoyo_graph_nodes`、`yoyo_graph_edges`、`yoyo_folded_branches`、`yoyo_metric_counters`、`yoyo_metric_timings`、`yoyo_metric_samples`、`yoyo_team_reads`、`yoyo_team_fetches`。
- 新增列：`yoyo_team_tasks.chat_through`（聊天续接游标，旧任务默认 0）、`yoyo_team_tasks.wake_count`、`yoyo_team_tasks.paused_reason`、`yoyo_team_evidence.read_verified`（旧证据默认 0 = 自述）。
- 新增 `yoyo_activity_links.kind` 取值 `intent`。
- 旧记录不动；0.39.0 已有的表与列保持原样。

回滚到 0.39.0 时这些表和列可以留着（旧代码不会读它们），**不要**用旧数据库备份覆盖线上库，否则会丢掉上线后新增的消息、活动与意图。

## 3. 行为变化（上线后立刻会看到的）

1. **主体默认工具面变小**：启用 `team` 时，隔离浏览器、`yoyo_execute`/`yoyo_job`/`yoyo_projects`、`yoyo_debug*` 默认不出现在主体工具里，需要 `yoyo_takeover`（写理由、默认 10 分钟、最多 60 分钟、记入 `yoyo_takeovers`）才临时恢复。没有 `team` 时不改变。
2. **聊天续接**：聊天任务可 `team_pause` 挂起（交回发言租约）；窗口有新消息时宿主用真实游标与消息原文唤醒**同一个常驻会话**。被执行者拥有的窗口不再唤醒主体。常驻会话默认最多 4 个，闲置 15 分钟回收；任务结束、取消或过期时关闭；服务重启后旧会话不再续接，改为新会话 + 续接简报（当前 SDK 不支持跨进程复用同一 session id，已在文档标注）。
3. **意图队列**：主体可用 `team_intent` 排队；宿主按优先级 + 等待提升 + 依赖 + 并发启动。没有空位时排队并可见，不会自动推回主体。
4. **新增只读视图**：`team_graph`、`team_expand`；主体 `state()` 增加 `orchestration`、`folded`。

## 4. 部署后立刻核对（只读）

1. `systemctl status` 为 active/running、`NRestarts=0`。
2. 数据库 `PRAGMA integrity_check` 为 `ok`；上面九张新表存在。
3. 管理端 `/api/yoyo/status`：`settings.paused=false`、`observeOnly=false`、`dailySteps` 保持原值；`team.status()` 能返回 `intents` 与 `timeline`。
4. 主体工具面核对：未接管时重执行工具不在列表；`yoyo_takeover` 后出现，`yoyo_handback` 后消失（可直接看一次原生日志或用 `state().orchestration.heavyToolsHidden`）。
5. 真实模型冒烟（可选，按既有授权）：只读执行者读一个已授权窗口并把原话放到证据板，不向任何群发送。

## 5. 回滚

1. 先把服务停掉，避免新表写入与旧代码混跑。
2. 代码回滚到 `13e98e4`（0.39.0），重启；数据库保留（新表新列留着）。
3. 若必须回到 0.38.0（`16b71e3`），同样保留数据库，不要恢复旧备份覆盖。
4. 回滚后确认：QQ 设置（paused/observeOnly/dailySteps）不变，聊天窗口与活动仍可读。

## 6. 上线后仍需观察（不在本次验收内）

- 真实模型是否稳定先写意图再分派，以及是否会在合适时机 `team_pause` 并接着读。
- 无空闲额度时的排队在真实负载下是否合理（饥饿提升每 5 分钟 +1、上限 +20）。
- 冷分支折叠阈值（6 小时）是否合适；被折叠内容是否会被误当新事实。
- 常驻会话的数量与内存占用（默认上限 4、闲置 15 分钟回收），以及服务重启后「新会话 + 续接简报」是否会让多轮话题显得突然失忆。
- Token/成本计量仍缺接口：未上报显示「未测量」，不记 0。
- 真实 QQ 下的社交判断与内容边界（提示词层面）仍需观察。
