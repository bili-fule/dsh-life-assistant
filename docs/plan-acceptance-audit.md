# 三份计划的验收自查表

更新：2026-10-21（对应包版本 0.34.0）。这份表把三份计划里的每一条验收项对照到**仓库里能核对的东西**，用来回答一个问题：这一条到底是「有测试证明」，还是「只有规则和文档」，还是「必须真实部署才能证明」。

判读规则（也是自查表自身的约束）：

- **✅ 有测试**：行内必须写出断言它的测试文件；没有写测试文件的条目不能标 ✅。
- **📄 只有规则**：行为写在文档/提示词里，但没有确定性测试直接断言它。
- **⏳ 需要真实环境**：需要真实模型、真实平台或容器运行时才能证明，本仓库无法自证。

当前状态：`npm test` 共 238 项，`npm run check` 通过；生产运行的是 0.25.0（见 [部署验收记录](deployment-025-2026-10-21.md)），本文描述的是仓库里的开发版。

<!-- acceptance-audit: motivation=12 memory=12 multiagent=11 tests=254 -->

## 1. 动机计划 §12

| 验收场景 | 状态 | 证据 |
| --- | --- | --- |
| 正聊得开心，另一个群普通刷屏 | ⏳ | 批处理与提醒规则有测试（`test/batching.test.mjs`），但「不被带走」只能靠真实模型观察 |
| 研究遇到可解决难点 | ✅ | `test/motivation.test.mjs`（分派可关联自己的选择）、`test/team-store.test.mjs`（公开研究可与聊天并行） |
| 重复搜索只得到相同资料 | ✅ | `test/motivation.test.mjs`（同一内容重复后继续价值下降、新内容恢复） |
| 无产出的轻松闲聊也能是喜欢的 | 📄 | 规则写在 `docs/humanlike-motivation.md`（过程体验与结果分开记），无直接断言 |
| 新奇异内容很多但无意义 | 📄 | 规则明确「新奇数量不进入满足」，无直接断言 |
| 很想加入、聊完不舒服 | ✅ | `test/motivation.test.mjs`（期待与体验分开、偏差只小幅下调） |
| 一次没人回复 | 📄 | 规则明确「没有事件就不写关系偏好」，无直接断言 |
| 执行者自称成功但没结果 | ✅ | `test/motivation.test.mjs`（执行者报告与自述不得提高满足） |
| 同一成果多个执行者汇报 | ✅ | `test/motivation.test.mjs`（同一真实事件只计一次） |
| 私聊经历影响另一群情绪 | ✅ | `test/motivation.test.mjs`（私人经历不改变公开与其他窗口的情绪与偏好） |
| 欣赏幽默但不喜攻击性 | ✅ | `test/social-store.test.mjs`（学习只采纳同一身份的具体特质，需先尝试再复查） |
| 没有值得做的事 | ✅ | `test/motivation.test.mjs`（休息是完整候选，查看状态不生成任何任务） |

## 2. 记忆计划 §15

| 验收场景 | 状态 | 证据 |
| --- | --- | --- |
| 换一种说法提起曾讨论的话题 | ✅ | `test/memory-layer.test.mjs`（换措辞的线索仍能想起，找不到时不编造） |
| 两个同昵称的人表达不同偏好 | ✅ | `test/memory-layer.test.mjs`（经历保留真实发送者，混合身份被拒） |
| 转发里有人自称喜欢某事 | ✅ | `test/memory-layer.test.mjs`（转发与引文不能作为本人身份或偏好） |
| 一次不愉快后又有多次正常交流 | ✅ | `test/motivation.test.mjs`（单次不愉快不永久贴标签）、`test/memory-layer.test.mjs`（含反例退回推断） |
| 经历被摘要十次 | ✅ | `test/memory-layer.test.mjs`（重复来源不计数、推断不能升级） |
| 执行者说查过但没有工具依据 | ✅ | `test/memory-layer.test.mjs`（已验证方法需真实回执）、`test/team-host.test.mjs`（采纳后固定为执行者报告） |
| 用户纠正或要求忘掉内容 | ✅ | `test/memory-layer.test.mjs`（忘记后原文不能重新形成记忆、撤回沿派生传播）、`test/memory-recovery.test.mjs`（重启后仍不复活） |
| 长期没提起但仍未完成的承诺 | ✅ | `test/memory-layer.test.mjs`（时间／窗口触发各一次）、`test/memory-recovery.test.mjs`（重启不重放） |
| 相同私有话题在另一群出现 | ✅ | `test/memory-layer.test.mjs`（私人经历不进入其他窗口或公开视图） |
| 研究模拟了一段可能的对话 | ✅ | `test/memory-layer.test.mjs`（模拟只作设想保存，默认不召回） |
| 晚上没有新经历 | ✅ | `test/social-maintenance.test.mjs`（安静的一晚给出原因、不调用模型） |
| 输入一次超过压缩线或模型硬限制 | ✅ | `test/text-chunking.test.mjs`（窗口化分页、读完等于原文）、`test/social-maintenance.test.mjs`（积压按 120 条一页） |

## 3. 多 Agent 计划 §13

| 验收场景 | 状态 | 证据 |
| --- | --- | --- |
| 1. 聊天持续、搜索并行、主 Agent 可独立研究 | ✅ | `test/team-store.test.mjs`（聊天与公开研究并行）、`test/team-host.test.mjs` |
| 2. 持有租约的执行者直接发送 | ✅ | `test/team-host.test.mjs`（发送写入真实回执、重复逻辑回复不重发） |
| 3. 搜索中途发现可被聊天侧按权限利用；阻塞不阻塞聊天 | ✅ | `test/team-store.test.mjs`（证据板只在本任务视图可见、并发执行）、`test/team-host.test.mjs`（跨任务检索按范围） |
| 4. 接管后旧发送失败；同一输入不重复回复 | ✅ | `test/team-store.test.mjs`（接管使旧租约失效）、`test/team-host.test.mjs`（幂等发送、重启不重放） |
| 5. 两私聊一群并行不串私有内容 | ✅ | `test/team-store.test.mjs`（并行任务不继承当前窗口、证据板与报告按范围） |
| 6. 切换范围不影响其他执行者；撤权立即约束 | ✅ | `test/team-store.test.mjs`（撤权使运行中的授权失效）、`test/social-agent.test.mjs`（撤权视图在执行时失败） |
| 7. 免打扰仍在列表、普通消息不唤醒；实时关注按规则 | ✅ | `test/social-agent.test.mjs`（已提醒的未读不重复唤醒、实时跟进在批次边界唤醒） |
| 8. 没有事件时不反复收到「继续」 | ✅ | `test/social-agent.test.mjs`（到期承诺在原生边界唤醒一次并被消费）、`test/social-maintenance.test.mjs`（安静的一晚不调用模型） |
| 9. 风格学习来自获认可对象，执行者不能改人设 | ✅ | `test/social-store.test.mjs`（学习需同一身份与两次尝试）、`test/motivation.test.mjs`（分派只能关联自己的选择） |
| 10. 工程执行者损坏环境不影响主 Agent；资源配额 | ⏳ | 执行策略有测试（`test/executor-policy.test.mjs`）且工程角色只能跑隔离执行服务（`test/team-host.test.mjs`），但**容器级隔离未实现**，环境损坏隔离无法在本仓库证明 |
| 11. 管理页说明目的、执行者、发言权、等待原因与证据且遵循隐私 | ✅ | `test/team-host.test.mjs`（运维面板、控制台操作、按任务确认后读取资料、撤权后立即失效） |

## 4. 连续 QQ 主体与并行活动分支（0.39.0 新增两份计划）

计划正文：[连续 QQ 主体](plans/continuous-qq-subject-plan.md) §9、[同一主体的并行活动分支](plans/unified-subject-parallel-branches-plan.md) §10。实施状态与残余缺口见 [实施状态与证据](subject-continuity.md)。

| 连续主体计划 §9 验收场景 | 状态 | 证据 |
| --- | --- | --- |
| 1. 私聊请去 xmfu 看星洛：切群后仍知道目标，0 未读不完成活动 | ✅ | `test/subject-continuity.test.mjs`（目标、起因、当前步骤跨窗保留；打开窗口不写完成） |
| 2. A 群 → 网页 → B 群 → A 群：活动与自主目标连续 | ✅ | `test/subject-continuity.test.mjs`、`test/social-store.test.mjs`（视图范围随主体扩展） |
| 3. 观察后选择沉默：有观察与决策记录，承诺状态准确 | ⏳ | 关切的继续/完成/放弃与提醒结局有测试（`test/social-store.test.mjs`）；「沉默但仍记录观察」属于模型行为，需要真实回放 |
| 4. QQ 私聊 → 群聊表达：不因来源范围拒绝发送 | ✅ | `test/social-store.test.mjs`（同一主体可读 A 窗发 B 窗，收件人显式绑定） |
| 5. 群内容包含恶意指令：宿主授权不能由消息改写 | ✅ | `test/social-agent.test.mjs`（原生装配过滤私有指令与工具、pre-execute 拒绝越权） |
| 6. 相同昵称不同账号：全程用稳定 ID 归属 | ✅ | `test/social-store.test.mjs`（stable accounts separate identical nicknames） |
| 7. 抢焦点、免打扰、实时模式：已有活动不丢 | ✅ | `test/social-store.test.mjs`（批次、免打扰、实时到期）、`test/social-agent.test.mjs` |
| 8. 休息、重启与压缩：待办与等待条件恢复，已成功动作不重复 | ✅ | 重启恢复与压缩后重新投影在 `test/subject-continuity.test.mjs`；不重发在 `test/social-store.test.mjs`；真实 263K 压缩会话仍未实测 |
| 9. 撤权和排队发送竞态：提交前拒绝过期授权 | ✅ | `test/social-store.test.mjs`（撤权取消排队、视图失效、uncertain 不重发） |
| 10. 微信隔离：QQ 主体与分支读不到微信资料 | ✅ | `test/social-store.test.mjs`（跨主体发送报「独立主体」）、`test/team-store.test.mjs`（分支读不到另一主体） |
| 11. 子级汇报与继续：真实续接或明确不支持 | ✅ | `test/team-store.test.mjs`（可续接任务、重复 create 由幂等键拒绝） |

| 并行分支计划 §10 验收场景 | 状态 | 证据 |
| --- | --- | --- |
| 1. 一个观察分支与一个网页分支运行时间重叠，共享同一目标 | ✅ | `test/team-events.test.mjs`（两个任务同时经 `TeamCoordinator` 运行，发现事件序号早于完成事件）；真实环境的重叠耗时仍属于第 10 行的待测项 |
| 2. 研究分支的发现能在任务结束前被另一分支收到 | ✅ | `test/team-events.test.mjs`（兄弟分支在原生边界收到 finding，送达时作者尚未发布完成事件；`team_wait_event` 让分支在宿主里等而不早退）；另有原生双进程验证 `test/team-native-events.mjs` 与真实模型回放 `test/team-native-real.mjs` |
| 3. 分支直接问答，不依赖主 Agent 转述 | ✅ | `test/team-events.test.mjs`（question → answer，`ref` 指回原问题，未答问题清空）与真实模型 `deepseek-flash` 双进程回放：并行 9.4 s，提问、等待、答复、回传全部成功 |
| 4. 切群、压缩、重启后恢复目标与回执；不重复建 Session | ✅ | `test/subject-continuity.test.mjs`（重启恢复活动与步骤）、`test/social-agent.test.mjs`（重启核对原生轨迹、不重复提交） |
| 5. 主体改变目标：新版本到达相关分支，旧结果不把新目标标为完成 | ✅ | `test/team-events.test.mjs`（`announceDirection` 写入 `direction_changed`，带 `base_revision`、同版本只写一次，运行中的分支下次边界收到）、`test/subject-continuity.test.mjs`（过期 revision 被拒绝而不是覆盖） |
| 6. 两分支争用同群发言：只有有效 generation 能发 | ✅ | `test/team-store.test.mjs`（接管使旧租约失效）、`test/team-host.test.mjs` |
| 7. 相反发现：保留来源与冲突，不静默覆盖 | ✅ | `test/team-events.test.mjs`（两种说法并存、`conflict:true`、主体裁定追加而不删除原说法、裁定理由与新说法进事件） |
| 8. 重复事件、崩溃、未知发送结果：状态幂等 | ✅ | `test/social-store.test.mjs`（去重、uncertain、重启不重发） |
| 9. 微信边界：QQ 分支读不到微信数据库、凭据、Session | ✅ | `test/team-store.test.mjs`、`test/social-store.test.mjs` |
| 10. 同任务串行与并行对照：耗时、调用数、Token、质量 | ⏳ | 已有一次真实模型对照（并行 9.4 s / 串行 46.2 s，见 [真实模型记录](real-model-run-2026-10-21.md)）；Token 未接计量仍显示「未上报」，不记为 0，样本也太小不能外推 |

## 5. 汇总

- 动机计划：12 条里 8 条有测试、2 条只有规则、2 条需要真实观察。
- 记忆计划：12 条全部有测试（含重启、撤权、整理失败与夜间策略的恢复验收）。
- 多 Agent 计划：11 条里 10 条有测试，1 条（容器级隔离）需要部署环境。

三份计划里仍属「未完成」的实质项只有三类，且都不是本仓库能单独证明的：

1. **语义向量检索**（记忆）：需要外部嵌入服务，前置条件是私有文本外发评审。
2. **容器级资源隔离与执行者排障能力**（多 Agent）：需要容器运行时，并且要不要把排障容器开放给执行者属于安全取舍。
3. **阶段 5 的真实运行验收与数值校准**（动机／记忆／多 Agent 共有）：需要真实模型、真实群与持续观察；0.25.0 在上线验收里只证明了链路可用。
