# QQ 连续主体：实施状态与证据

日期：2026-10-21。基线：`bd2231b`（0.38.0）之后的 0.39.0 工作区。

本文件只记录**已经落地的东西和可以复查的证据**，不描述愿望。三档标记沿用仓库约定：

- **已实现**：代码在 `src/`，有确定性测试并在 `npm test` 中通过。
- **已验证**：用真实模型/真实环境回放过，有轨迹或回执可查。
- **已部署**：生产升级到该版本并留档。

## 1. 读取权属于主体，窗口只是位置（已实现）

计划里最关键的修正是把「按窗口裁剪主体上下文」拆成两件事：

| 概念 | 现在的实现 | 位置 |
| --- | --- | --- |
| 读取权 | 视图范围 = 该窗口所属平台的**全部已授权范围** + `public` | `SocialStore.subjectScopes()`、`open()` |
| 当前窗口 | `focus` 字段，只决定阅读/发信等工具作用在哪个收件人 | `SocialStore.open()`、`SocialAgent.state().focus` |
| 另一个主体 | 同一数据库里另一平台的窗口**不在**本主体视图内 | `SocialStore.platformOf()` |
| 视图过期 | `view(id)` 把存储范围与主体当前范围取并集，新授权的窗口立刻可读 | `SocialStore.view()` |

直接后果：切到别的群不再重写原生请求视图，主会话历史按主体读取权投影（`SocialAgent.applyView()` 使用 `readView()`），`state()` 里的活动、关切、计划、记忆、学习全部按主体读取权返回，`focus` 与 `currentWindow` 单独给出。

## 2. 发言权与内容边界分开（已实现）

`mayPublish` / `assertPublish`（要求「本轮读过的范围必须等于目标范围」）已删除，换成主体边界校验：

- `scope.mjs` 的 `assertOutbound(scopes,targetScope,platformOf)`：目标必须已授权；`public` 永远可以；其余来源必须与目标同平台，否则报「不能把另一个独立主体的资料发到这个窗口」。
- `SocialStore.assertOutbound(scopes,targetHandle)` 由 store 解析平台，撤权目标解析为 null，因而被拒绝。
- 出站队列 `enqueue` 不再要求 `target===view.focus`：收件人在调用时显式绑定（`yoyo_send` 可选 `target`），异步切窗不会改收件人；同一原生动作仍不可更换收件人或正文，`uncertain` 仍不自动重发。

内容是否得体由提示词约束（`POLICY` 明确「连续主体、别处发言是经历、不把私聊当当前群已知内容、发信绑定明确收件人」），不增加隔离发言生成器或审核 Agent。

## 3. 活动索引：换窗口不忘为什么来（已实现）

新增两张表，旧表不搬家，只挂接：

- `yoyo_activities(activity_id, revision, goal, why, state, step, done_when, stop_when, review_at, origin, scopes, branch, owner_version, created_at, updated_at)`
- `yoyo_activity_links(activity_id, kind, ref)` —— `kind` 目前支持 `concern / plan / task / memory_intent / receipt / document`

接口：`startActivity`（同目标重复创建会合并成一条）、`updateActivity`（带 `revision` 比较，过期写入报「活动已更新到第 N 版」）、`activities`（按状态排序，默认最多 12 条）、`linkActivity`。工具面是 `yoyo_activity` 的 `goal / activityId / revision / why / step / doneWhen / stopWhen / origin / activityState`；`yoyo_concern` 与 `yoyo_plan` 新建时自动挂到当前活动。

`yoyo_activity` 指针记录在 `yoyo_activity.body.activityId` 与 `yoyo_current_activity`，重启后仍在：`state().currentActivityId` 与 `state().activities` 一起恢复。`yoyo_open` 可以携带 `activityId`，把「换窗口」记成同一活动里的位置变化。

**打开窗口不等于完成**：`yoyo_open` 不写任何完成状态，0 未读也不会让活动变成 `done`；完成仍要看 `done_when` 或明确的主观决定。

## 4. 分支与同一主体（已实现：连续性 + 增量事件 + 同级问答）

- `team-store.create()` 现在为 `research` / `engineer` **自建 public 视图**（不再要求主体先切到 public 窗口），这两个角色仍拿不到任何私有材料；`chat` / `reader` / `peer` 沿用调用方视图，因此分支与本主体共享同一套读取权。
- 幂等比较改为 `role / goal / focus_key / expiresAt`（`focus_key` = 任务窗口句柄），新增列 `focus_key`、`activity_id`，旧库任务按 `yoyo_views.focus` 回填。
- `create({activityId})` 会把任务挂到活动索引上（`yoyo_activity_links.kind='task'`）。
- `takeover(viewId,agentId,expiresAt,target)` 与 `TeamHost.mainEnqueue(view,key,target)` 支持显式收件窗口，接管与发言租约仍按 generation 生效。

**分支之间的增量事件（`yoyo_team_events` + `yoyo_team_cursors`）**

| 项 | 实现 |
| --- | --- |
| 事件类型 | `finding / question / answer / progress / direction_changed / blocked / completed / cancel` |
| 事件字段 | `event_id`、`topic`、`from_task`、`to_task`、`activity_id`、`kind`、`body`、`ref`、`base_revision`、`dedupe_key`、`expires_at`、`delivered_count` |
| 订阅 | 分支自动订阅自己的信箱 `task:<id>`、所属活动 `activity:<id>` 与主体频道 `subject` |
| 投递 | 分支在原生 `step` 边界取一次（`TeamCoordinator` 的 `step` 返回 `events`），随后推进游标；进程重启从游标续接，不重放 |
| 去重 | `dedupe_key` 唯一；同一 finding/progress 重复写入只留一行 |
| 过期 | `expires_at` 到期后不再投递（迟到的提问不会被当成新任务） |
| 同级问答 | `team_ask` / `team_answer`（主体与 `peer`/`chat`/`reader` 分支都可）；答复的 `ref` 指向原问题 `event_id`，不经过主 Agent 转述 |
| 自动事件 | 报告 → `progress`；证据 `finding` → `finding`；任务结束 → `completed`；取消 → `cancel`；主体改目标 → `direction_changed`（`announceDirection`，按 revision 去重，运行中的分支在下一个边界收到） |
| 主体侧可观察 | `team_events`（事件流 + 仍未回答的问题）、`team_sources`（含裁定）、`state().team`（并发数、分支状态与等待原因、未答问题数、最近 5 条事件元数据，不含正文） |
| 冲突裁定 | `team_source_decide` 追加 `verified / refuted / unresolved` 与理由，原始说法全部保留，裁定写成 `finding` 事件送到运行中的分支；只有能看见该来源的视图才能裁 |

**三个不同状态**：事件已写入（行存在）、已送达（游标推进、`delivered_count` 增加）、据此行动（分支自己的下一份 report/evidence）。控制台与状态分别显示，不把「写了」当成「收到」。

## 5. 测试证据（已验证：确定性）

`npm test` 全绿（248 项），其中与本改造直接相关：
| 证据 | 测试文件 |
| --- | --- |
| 切窗后仍知道目标、起因、当前步骤；同一目标不重复建活动 | `test/subject-continuity.test.mjs` |
| 重启后恢复同一活动与未完成步骤 | `test/subject-continuity.test.mjs` |
| 过期 revision 被拒绝而不是覆盖 | `test/subject-continuity.test.mjs` |
| 打开窗口不写完成、未知活动被拒绝 | `test/subject-continuity.test.mjs` |
| 压缩后重新投影同一个主体视图，活动与步骤仍在 | `test/subject-continuity.test.mjs` |
| 两个分支同时运行；发现的投递发生在作者发布完成事件之前 | `test/team-events.test.mjs` |
| 分支直接问答：问题 → 答复，`ref` 关联，未答问题清空 | `test/team-events.test.mjs` |
| 事件去重、过期不投递、非法类型被拒 | `test/team-events.test.mjs` |
| 结束与取消都成为兄弟分支可见的事件 | `test/team-events.test.mjs` |
| 重启后从已确认游标续接，不重放 | `test/team-events.test.mjs` |
| 同一主体跨窗口可读可发，另一个主体不可读写 | `test/social-store.test.mjs` |
| 关切/计划/记忆/学习跟随主体、不进 public 与另一主体 | `test/social-store.test.mjs` |
| 撤权、去重、uncertain、附件摘要钉住 | `test/social-store.test.mjs` |
| 分支继承主体视图、public 角色仍只有 public | `test/team-store.test.mjs` |
| 网页与隔离浏览器不再要求先切 public；后台整理仍无浏览器 | `test/social-agent.test.mjs`、`test/text-chunking.test.mjs` |
| 主体改目标 → `direction_changed` 送到运行中的分支，同版本只写一次 | `test/team-events.test.mjs` |
| 相反发现保留并标冲突，主体裁定追加不覆盖、理由进事件 | `test/team-events.test.mjs` |

## 6. 已验证：两个真实 DSH 子进程直接问答

`node test/team-native-events.mjs`（可选运行，需要本机已安装的 DSH SDK：

```
node test/team-native-events.mjs
PASS: two real DSH worker processes exchanged a question and an answer through the event bus.
```

`TeamNativeAdapter` 启动两个真实 DSH 进程（独立 HOME/DSH_HOME/工作目录、独立插件实例、独立工具桥），脚本模型分别扮演提问分支与答复分支：

- 提问分支（`chat`）通过 `team_ask` 写入 `question` 事件，收件人是另一个任务的编号——它在自己的任务目标里读到的那个编号；
- 另一个进程（`reader`）只能从自己的任务目标里知道问题编号，用 `team_answer` 回答；
- 断言：问题与答复各一行、`answer.ref === question.event_id`、`answer.from_task` 是宿主认定的答复者、答复内容可见、`openQuestions` 清空、两个任务都自己结束（`completed`）。

它证明的是：真实原生进程 + 真实工具桥 + 真实 SQLite 游标下的**同级问答不需要主 Agent 转述**。它仍然不是「真实模型」验证：模型部分是脚本，没有真实 QQ 连接，也没有测模型延迟与 Token。运行时若需要看宿主拒绝原因，可设置 `YOYO_TEAM_DEBUG=1`。

既有的原生冒烟测试 `test/team-native-smoke.mjs` 在本轮改动之后仍然 `PASS`（两个独立原生 DSH 进程、角色工具集、工具桥、进展与清洗过的环境变量），说明事件总线与角色方法表的改动没有破坏原生链路。

## 7. 还没做的（不要当成已完成）

1. **真实模型上的分支闭环**：已用 `deepseek-flash` 跑过一次有界回放（见 [真实模型运行记录](real-model-run-2026-10-21.md)）：真实模型会读材料、写证据、用 `team_ask` 提问，串行 28.6 s / 并行 9.7 s；但答复分支查一次事件就结束，**缺少「等兄弟分支事件」的宿主原语**，同级问答在真实并行调度下还没闭环。
2. **真实运行的重叠计量**：需要记录提交事件到投递的 p95、模型响应耗时、串行与并行的总耗时／调用数／Token，并与「无改善」的情形对比。现在只有逻辑顺序证明（事件序号、完成事件晚于投递）与双进程功能验证，没有计时对照。
3. **压缩后的真实会话验证**：压缩后的投影与活动恢复有确定性测试（表面变化即重新投影，目标不依赖被压缩的历史），但真实 263K 压缩会话、真实摘要内容对活动叙述的影响没有实测。
4. **部署**：生产是 `16b71e3` 的 0.38.0（见 `deploy/STATUS.md` 头部与 `docs/deployment-038-2026-10-21.md`），本改造在其之后，未上线，不能写成「已部署」。
