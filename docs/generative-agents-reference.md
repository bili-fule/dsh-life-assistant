# Generative Agents 参考记录

查阅日期：2026-10-19。参考 [joonspk-research/generative_agents](https://github.com/joonspk-research/generative_agents)，固定提交 `fe05a71d3e4ed7d10bf68aa4eda6dd995ec070f4`。以下为机制借鉴，当前未复制其源码或运行其模拟环境。

| 查阅模块 | 实际机制 | 本项目对应与区别 |
| --- | --- | --- |
| cognitive_modules/plan.py 的 plan、_long_term_planning、_should_react | 计划细化；选择所感知事件；判断是否反应并调整活动 | 持续关切与下一步、注意事件、原生 Agent 自选行动；不采用城镇日程与每角色独立 Agent |
| cognitive_modules/reflect.py 的 generate_insights_and_evidence、reflection_trigger | 反思引用经历节点；达到条件才整理并重置触发计数 | 有原文来源的分层记忆、增量整理范围与冷却；不让模型生成的原因猜测变成事实 |
| cognitive_modules/retrieve.py 的 new_retrieve | 综合最近访问、重要性与相关性排序，并更新访问时间 | 当前仍是有范围的有界检索，不宣称已实现其 embedding 排序；后续若增加语义检索，先过滤权限再排序 |

源码根目录为 `reverie/backend_server/persona/`。可沿固定提交查看上述模块，例如 [plan.py](https://github.com/joonspk-research/generative_agents/blob/fe05a71d3e4ed7d10bf68aa4eda6dd995ec070f4/reverie/backend_server/persona/cognitive_modules/plan.py)。

## 不直接采用的部分

模拟时钟、地图移动、城镇物件和多人物世界不是 QQ 的事实来源；不能把模拟经历当成真实交往。它的实验不能证明本项目的隐私边界、长期稳定性或真实人格。当前也没有照搬其小时日程、重要性常数或模型提示模板。

本项目继续使用 DSH 原生执行、计量、压缩与轨迹；引用机制不代表另建 Generative Agents 循环。微信与 QQ 两主体的隔离是本项目明确要求。

## 许可证

查阅版本 LICENSE 为 Apache-2.0，版权为 Joon Sung Park。当前仅参考机制，未引入代码或模型资产。如后续复制实现，须逐文件记录来源、改动和适用许可证，并维护第三方声明；不能把上游文件直接改标 MIT。

## 后续文档

维护 [动机与学习契约](motivation.md)、配置及工具参考、部署和回退步骤、故障排查、验收记录。每次行为机制变化说明设计、已实现和已实测各到哪一层；不以 README 的愿景代替验收。
