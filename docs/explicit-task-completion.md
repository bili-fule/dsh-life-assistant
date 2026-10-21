# 显式任务结束

2026-10-21：固定提交 `13e98e4` 已推送并部署，版本 0.39.0。257 项自动测试通过；目标服务器真实模型只读验收成功读取证据板后显式 finish(completed)，未发送外部消息。

主 Agent 使用 `yoyo_finish({decision: completed|abandoned, reason, activityId?})`，将当前或指定活动记录为 done/abandoned。普通回复不能代替这个决定。`yoyo_sleep`、`yoyo_wait` 和切窗只让出当前原生轮次，不完成活动。后台记忆整理沿用其独立作业完成契约。

执行分支使用 `team_finish({decision: completed|abandoned, reason})`。宿主先保存决定与理由，原生执行返回后才提交任务终态；completed 映射为 completed，abandoned 兼容现有 cancelled 状态并在报告中保留区别。普通 finalResponse 或 team_report 不会完成任务。完成决定之后拒绝新的业务工具，仍允许宿主记用量与报告。

使用 DSH 原生 `agent/turn-stopping` 与 `agent.steer`：未明确决定时提醒继续实际工作或明确结束，最多补充两次；持续未决定抛出中断，保留活动，分支记为 blocked。超时、取消、撤权、预算限制继续有效，不为等待一个决定无限运行。这不是新增模型循环。

完成表示模型明确判断完成，尚不代表宿主已独立验证全部目标；判断依据应包含实际工具回执。不得宣称仅调用 finish 就客观证明工作完成。

验证：全量 257 项测试通过，包括普通回复不完成分支、明确放弃与完成不同、主活动等待不完成，以及原生停止钩子的有界继续。服务器 DSH 存在原生停止钩子，真实模型执行记录为 step/pack/board/step/events/step/finish/usage。尚未对真实 QQ 对话进行额外发信验收，长期行为需继续观察。

部署后服务 active/running、NRestarts=0，数据库 integrity_check=ok，QQ 保留 paused=false、observeOnly=false、dailySteps=300；管理端 HTTP 200，原生界面未认证 HTTP 401。备份为 `/var/backups/yoyo-explicit-20261021-202154/before.tgz`。回滚时停服务，只恢复旧插件代码和配置，保留当前数据库新增消息；备份同时包含当时的数据快照，不能直接覆盖现有数据。生产 release.json 记录提交、归档哈希和验收信息。
