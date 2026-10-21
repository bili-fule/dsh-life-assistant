# 0.39.0 上线前清单与回滚办法

日期：2026-10-21。基线：生产 0.38.0（`16b71e3`）。本版本在仓库内已实现并通过确定性测试，**尚未部署**；本文只写操作步骤与核对点，不把"准备好"当成"已上线"。

## 1. 冻结什么

| 项 | 值 |
| --- | --- |
| 待上线提交 | 本轮最后一个提交（`4f0cfe9` 之后如有文档修正，以推送后的 `main` 顶端为准） |
| 版本号 | `package.json` 0.39.0 |
| 测试 | `npm run check` 通过；`npm test` 251/251 |
| 原生验证（可选，需要本机 SDK） | `node test/team-native-events.mjs`、`node test/team-native-smoke.mjs` 均 `PASS` |

上线前把实际提交 SHA 写进 `deploy/STATUS.md` 顶部的"生产最新"段落，不要用"最新代码"这种说法。

## 2. 数据库迁移（全部是增量）

启动即自动执行，无需手工脚本；旧库打开只加东西：

- 新增表：`yoyo_activities`、`yoyo_activity_links`、`yoyo_team_events`、`yoyo_team_cursors`、`yoyo_team_source_decisions`。
- 新增列：`yoyo_team_tasks.focus_key`、`yoyo_team_tasks.activity_id`（旧任务按 `yoyo_views.focus` 回填 `focus_key`）。
- 语义变化（不是结构变化）：窗口视图的 `scopes` 现在包含同一平台的全部已授权范围；`yoyo_concerns` / `yoyo_plans` / `yoyo_memories` / `yoyo_learning` / `yoyo_activity` 新写入记录的范围取"主体当前范围"。
- 旧记录不动：历史行保留原有 `scopes`，因为它们都包含 `public` 或本主体范围，仍然可读。

回滚到 0.38.0 时这些表和列可以留着（旧代码不会读它们），**不要**用旧数据库备份覆盖线上库，否则会丢掉上线后新增的消息与活动。

## 3. 部署前备份

1. 复制 SQLite（含 `qq-social/social.sqlite`）与配置（`cordis.patch.yml`、`.dsh/.credentials.yaml` 不导出）。
2. 记录 `deploy/STATUS.md` 当时的版本与 SHA。
3. 保留最后一次成功发送的 `yoyo_outbox` 行（核对发送去重与 uncertain 语义）。

## 4. 部署后立刻核对（只读）

1. `GET /api/yoyo/diagnostics`：进程、调度、`autonomy.team`、`memoryMaintenance` 都有值。
2. 管理页「yoyo 的活动」：预算、观察/暂停、窗口授权与部署前一致；「团队编排」面板显示并发上限与等待原因。
3. 打开一个已授权窗口，确认 `state()` 里 `activities`、`concerns`、`plans` 与部署前一致（不是空的、也没有跨到微信）。
4. 管理页发一条测试消息到**自己的**私聊或既有授权窗口，确认 `sent` 回执；不要在陌生群做测试。
5. 观察一次真实巡检：切一次窗口后 `activities[0].goal` 仍然是原来的目标（这是本版本的核心修复）。

## 5. 回滚

- 代码回滚：`git revert` 或部署 0.38.0 的冻结 SHA，重启服务。
- 回滚后行为变化：窗口视图重新按单窗口裁剪、发布恢复"读过的范围必须等于目标范围"。**不要**同时回滚数据库，否则会丢消息。
- 已写入的 `direction_changed` / `question` / `answer` 事件会成为无人读取的历史行，可以保留；`yoyo_team_source_decisions` 同理。
- 若回滚后出现发送失败（预期：跨窗口发言被旧规则拒绝），先切到目标窗口再让主体重说一次，不要盲目重发（`uncertain` 不自动重发是既有约束）。

## 6. 上线后仍需观察（不在本次验收内）

1. 真实模型是否愿意用 `team_ask` / `team_events`，而不是干等或自己猜（本版本只有脚本模型与确定性测试）。
2. 串行与并行的真实耗时、调用数、Token 对照；未上报的 Token 仍显示"未上报"，不记为 0。
3. 263K 压缩后的真实会话：目标与未完成事项是否按预期恢复。
4. 免打扰、实时关注与承诺复查在统一上下文下的实际频率是否变得吵人。
