# 三份计划的验收自查表

更新：2026-10-21（对应包版本 0.34.0）。这份表把三份计划里的每一条验收项对照到**仓库里能核对的东西**，用来回答一个问题：这一条到底是「有测试证明」，还是「只有规则和文档」，还是「必须真实部署才能证明」。

判读规则（也是自查表自身的约束）：

- **✅ 有测试**：行内必须写出断言它的测试文件；没有写测试文件的条目不能标 ✅。
- **📄 只有规则**：行为写在文档/提示词里，但没有确定性测试直接断言它。
- **⏳ 需要真实环境**：需要真实模型、真实平台或容器运行时才能证明，本仓库无法自证。

当前状态：`npm test` 共 236 项，`npm run check` 通过；生产运行的是 0.25.0（见 [部署验收记录](deployment-025-2026-10-21.md)），本文描述的是仓库里的开发版。

<!-- acceptance-audit: motivation=12 memory=12 multiagent=11 tests=236 -->

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

## 4. 汇总

- 动机计划：12 条里 8 条有测试、2 条只有规则、2 条需要真实观察。
- 记忆计划：12 条全部有测试（含重启、撤权、整理失败与夜间策略的恢复验收）。
- 多 Agent 计划：11 条里 10 条有测试，1 条（容器级隔离）需要部署环境。

三份计划里仍属「未完成」的实质项只有三类，且都不是本仓库能单独证明的：

1. **语义向量检索**（记忆）：需要外部嵌入服务，前置条件是私有文本外发评审。
2. **容器级资源隔离与执行者排障能力**（多 Agent）：需要容器运行时，并且要不要把排障容器开放给执行者属于安全取舍。
3. **阶段 5 的真实运行验收与数值校准**（动机／记忆／多 Agent 共有）：需要真实模型、真实群与持续观察；0.25.0 在上线验收里只证明了链路可用。
