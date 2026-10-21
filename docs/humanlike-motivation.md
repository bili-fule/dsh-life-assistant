# 以开心为方向的自主选择：实现与边界

状态：0.12.0 完成 [Plan](plans/humanlike-motivation-plan.md) 的阶段 1–4 机制，阶段 5 的真实运行验收尚未完成。默认关闭，当前没有修改任何生产配置。

此文档记录已经写在代码里的行为，不把工具存在当成“它已经会自然开心”。所有数值是本项目的设计取舍，不是被验证过的心理学定律。

## 与 Plan 的对应

| Plan | 实现位置 |
| --- | --- |
| §3 四层状态 | `yoyo_motivation_affect`（当前状态、按范围）、`yoyo_motivation_preferences`（情境偏好）、人设与 `yoyo_persona`（稳定自我，未改）、`self_options.recent`（近期满足的原始材料） |
| §4 核心循环 | 原生 Agent 继续负责理解与选择；宿主只提供状态、去重和写入约束，不新增循环 |
| §5 想做／喜欢分开 | 选择记录 `expected`，经历记录 `liked / worth / progress`；偏好同时保存 `wanting` 与 `liking` |
| §6 连续性、饱和、挫折、休息 | `satiation` 重复折扣、`load` 模拟负荷、`kind='rest'` 的完整休息候选 |
| §7 多 Agent | `team_delegate` 可关联自己的选择；经历按真实事件去重，执行者数量不增加满足 |
| §8 选择性模仿 | 仍由 `yoyo_learning` 负责，动机层不复制一套 |
| §9 防刷分 | 见下文“防刷分清单” |
| §10 状态与接口 | 五张表 + 四个工具 `self_options / self_choose / self_appraise / self_preferences` |
| §11 分阶段 | 阶段 1–4 已实现并有测试；阶段 5 见“已知缺口” |

## 开关

```yaml
autonomy:
  motivation:
    enabled: true
    mode: record          # record：只记录，不参与行动；choose：允许作为选择依据
    maxDeltaPerHour: 0.45 # 单个偏好在 1 小时内的变化上限
```

未配置时行为与之前完全相同：没有这四个工具，也没有动机状态。`mode` 只影响提示与 `self_options.stateNote`，宿主从不自行唤醒、生成任务或修改权限；两种模式都必须由主体自己调用工具。

## 四个工具

### self_options

无参数查看当前范围的状态，或给 `activity` 让返回只保留相关项。返回 `affect`（情绪基调、valence、模拟负荷、事件数）、`current`/`open` 未结束的选择、`preferences`、`proposals` 待定修订、`recent` 最近经历、`repeat` 重复饱和折扣和 `guidance`。

它只读：不产生候选、不创建任务、不改变提醒或预算。

### self_choose

记录一次选择。`activity` 与 `chosen` 必填，`candidates` 可选（最多 6 个，每个含 `appeal / expectedPleasure / expectedSatisfaction / effort / uncertainty / repeated / relation / commitment / continueWhen / exitWhen`）。可选 `concern` 关联当前范围内已有的关切，普通闲聊不必创建研究式项目。`rest:true` 或直接选择休息、不做，会记成 `kind='rest'`，可附 `returnWhen` 返回条件。

轻量路径允许不填候选：期待值从已有偏好推断，或标为 `medium`。同一活动在同一范围再次选择时，上一条未结束的选择标为 `superseded`，不会并行累积。

### self_appraise

对照期待记录实际发生的事：`choice`、`outcome`、`liked`（liked/neutral/disliked）、`worthAfter`（worth/unsure/not_worth）、`progress`、`explanation`、`confidence`、`repeatKey`、`evidence.messages/receipts`、`laterOf`、`end`。

返回值包含 `credit`（`observed` / `unverified`）、`evidence` 类型、`affect`、`preference` 和 `revision`。同一事件重放返回 `duplicate:true`，偏好不再变化。

### self_preferences

- 无参数：当前范围的偏好、待定修订和最近 10 条修订链。
- `revision` + `decision`：接受或拒绝一条待定修订（`apply` / `reject`，可附 `reason`）。
- `revert`：撤销最近一次已应用的修订，恢复 `before` 值。
- `activity` + `evidence`（经历编号）+ `liking`/`wanting`：手动提出一次修订。单次最多移动 0.12，必须引用当前范围内属于该活动的真实经历，同一条经历只能支撑一次手动修订。

没有可以直接设置快乐总分、修改权重或清空历史的入口。

## 记录

| 表 | 内容 |
| --- | --- |
| `yoyo_motivation_affect` | 每个资料范围一行：`valence`、`mood`、`load`、`satiation`、`events`、`updatedAt` |
| `yoyo_motivation_choices` | 活动、归一化键、`kind`（activity/rest）、状态（open/done/superseded）、候选、期待、理由、预算、退出条件 |
| `yoyo_motivation_experiences` | 选择编号、活动键、`dedup` 唯一键、实际结果、感受、事后评价、证据类型、重复标识、事后复查 |
| `yoyo_motivation_preferences` | 活动 + 情境 + 范围唯一：`wanting`、`liking`、`samples`、`stable`、`note`、`evidence`、`counter`、`window`、版本 |
| `yoyo_motivation_revisions` | 更新前后、依据（经历或手动）、置信度、状态（proposed/applied/rejected/withheld/reverted）、撤销链 |

每条记录继承调用视图的资料范围；在同一活动中同时看到私人窗口和公开资料的更新，会把所有涉及范围一起记在经历上，因此私人经历不会因为“顺便公开”而出现在公开视图。`self_options`、`self_choose`、`self_appraise`、`self_preferences` 属于自述类工具，不能作为执行证据引用（`yoyo_memory`、`yoyo_evidence`、`yoyo_feedback` 都会拒绝）。

## 有界更新规则

这些常量集中在 `src/motivation.mjs` 顶部，便于按行为回放调整。

- **证据等级**：`tool_receipt` > `message` > `worker_report` > `self_report`。只有前两种会更新偏好；执行者转述和自述仍会记成经历，但 `credit='unverified'`，不提高满足。
- **单次变化**：`0.18 × 置信权重（low 0.5 / medium 1 / high 1.5）× 方向`，再乘重复折扣。
- **试用期夹紧**：样本少于 3 次时，`liking` 被夹在 `[-0.25, 0.5]`；因此一次不愉快最多让偏好轻微下降，不能把某个群或某人永久判为讨厌。
- **稳定条件**：样本 ≥ 3 且 `|liking| ≥ 0.4`。
- **相反证据**：已稳定的偏好遇到反向的真实经历时，只产生 `proposed` 修订，需要主体自己接受；拒绝则保持原值。
- **小时预算**：单个偏好在 1 小时内累计变化超过 `maxDeltaPerHour` 后的更新记为 `withheld`，保留轨迹但不生效。
- **期待误差**：事先预计“高”却不喜欢会小幅下调 `wanting`；预计“低”却喜欢会小幅上调，避免“想做”和“真喜欢”混成一个数。
- **重复折扣**：同一活动、同一 `repeatKey`（如同一批资料、同一个梗）重复出现时，继续价值按 `1 - min(0.65, 0.2×重复次数)` 递减；换成新内容即重置。
- **情绪惯性**：`valence = 0.7×旧值 + 0.3×方向`，`mood` 只在超过 ±0.35 时改变（`frustrated` 需要高负荷加上不喜欢）；每次只小幅更新。
- **负荷**：按选择记录的投入（low/medium/high）增加，选择休息则减少；这是模拟工作负荷，不是生理指标。
- **事后复查**：`laterOf` 会保留原经历、写回 `later` 字段，只在新结论为“不值得”时才提出一条需要确认的修正，不重复计入奖励。

## 防刷分清单

- 没有 `set_happiness` 一类接口；`self_preferences` 的手动修订单次上限 0.12 且必须引用真实经历。
- 同一事件、同一复查、同一内容重放都按 `dedup` 唯一键拒绝；同一活动拆给多个执行者时，报告仍落在同一个事件上。
- 执行者自称成功、主体自述开心都不提高满足（`credit='unverified'`）。
- 自述类工具（含这四个新工具）的回执不能作为 `observed` 证据。
- 每小时偏好变化上限与试用期夹紧共同限制单轮剧烈变化。
- 没有新事件时不产生记录；`self_options` 只读，不制造任务或额外执行者。
- 休息是完整候选，不是失败状态；`rest` 选择同样会被评价。

## 与其它机制的关系

- **关切**：`yoyo_concern` 仍负责“想做什么、怎样算完成”。`self_choose` 记录当下这次选择；`team_delegate` 现在可以带 `choiceId` 把分工挂到某次选择上，`team_deliberate` 会显示该选择；选择结束后再分派会被拒绝。
- **学习**：`yoyo_learning` 继续负责欣赏对象的具体特质、尝试与采纳；动机层不做模仿。
- **记忆整理**：整理任务只有读、记忆、召回、退役工具，动机工具在宿主分发时被拒，整理不会顺手改偏好。
- **活动与提醒**：动机层不设置唤醒、不消费预算、不改变 `yoyo_activity`；休息仍由 `yoyo_sleep` 表达。

## 验证

`test/motivation.test.mjs`（11 项）：

1. 期待／经历／偏好分开保存，只有真实证据才更新偏好；
2. 同一事件重放或多执行者重复汇报只计一次；
3. 单次不愉快最多轻微下降，三次相符才稳定；
4. 私人经历不影响公开或其他窗口的情绪与偏好，跨范围评价被拒；
5. 重复内容降低继续价值，新内容恢复；
6. 执行者转述和自述不提高满足，但保留经历；
7. 休息是完整候选，查看状态不会生成任何任务；
8. 稳定偏好遇到相反证据需要确认，可撤销，拒绝保持原值；
9. 手动修订有界、需要真实经历、同一经历不能反复使用；
10. 事后复查保留原经历并只提出修正；
11. 分派可关联自己的选择，跨范围、已结束和未启用动机层的情形都被拒绝。

`test/social-agent.test.mjs` 另验证：未配置时没有这四个工具；配置后工具可见但在后台整理中被拒；自述类工具回执不进入证据索引；动态状态只暴露紧凑摘要。

`npm test` 全量 173 项通过；`npm run check` 通过。

## Plan §12 验收场景的当前落点

| 场景 | 宿主保证 | 仍需真实运行观察 |
| --- | --- | --- |
| 正聊得开心，另一个群普通刷屏 | 动机层不打断、不抢占；提醒仍走原批次与免打扰 | 是否真的留在原对话 |
| 研究遇到可解决难点 | 短期不喜欢只小幅调整，可继续、求助或分派 | 是否选择求助而不是放弃 |
| 重复搜索得到相同资料 | 同一 `repeatKey` 递减继续价值，`repeat` 直接可见 | 是否主动换方法或停止 |
| 无产出的轻松闲聊 | 过程体验与结果分开记，`progress='no'` 也能是 `liked` | 是否允许自己单纯玩 |
| 新奇内容很多但无意义 | 新奇数量本身不进入满足；只有事件与评价入库 | 是否把刷新奇当成进展 |
| 很想加入、聊完不舒服 | 期望与体验分开保存，偏差只小幅下调 | 下次是否真的更谨慎 |
| 一次没人回复 | 没有事件就不写关系偏好；沉默不产生负面记录 | 是否等待或做别的 |
| 执行者自称成功但没结果 | `worker_report` 记经历但不提高满足 | 是否在报告缺失时继续追证据 |
| 同一成果多个执行者汇报 | 事件级去重 | 协调成本是否被自己意识到 |
| 私聊经历影响另一群情绪 | 范围隔离，公开视图看不到私人偏好与情绪 | 跨范围语气是否真的没被带过去 |
| 欣赏幽默但不喜攻击性 | 动机层只记活动偏好，具体特质仍走 `yoyo_learning` | 是否只试学被欣赏的部分 |
| 没有值得做的事 | 不生成任务，`rest` 是完整选择 | 是否真的休息而不是制造活动 |

## 已知缺口（阶段 5 未完成）

- 没有在真实模型、真实授权群上连续观察这些机制；上述行为目前只有确定性测试和静态规则。
- 数值（权重、夹紧、折扣、稳定阈值、小时上限）尚未用行为回放校准。
- 管理页没有展示动机记录；`yoyo_motivation_*` 表只有工具与数据库可见。
- 偏好只按“活动 + 情境”索引，没有按关系或人聚合；关系价值仍由记忆与 `yoyo_learning` 表达。
- 压缩后的动态状态带一份紧凑摘要（情绪、负荷、当前选择、前 5 条偏好、最近 3 条经历和待定修订数量），但没有专门重写动机摘要的整理步骤，长周期仍可能丢失细节。
- 阶段 5 需要先在本人测试私聊和公开研究观察，再推广到已授权群，并记录真实效果与失败案例。
