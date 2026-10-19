# 拾事 · dsh-life-assistant

把微信事务消息变成有依据的待办。一个直接驱动 DeepSeek Harness 原生 Agent 的插件：微信 ClawBot 接入、Shell 执行、网页和真实浏览器、图片与文件理解、持久化待办、分层记忆、上下文自动压缩、个人语言风格学习与可设置人设。

## 原生 DSH 架构

微信 → 持久化收件箱与连续消息合批 → 官方 `SessionController.create / prompt / resolveAgent` → DSH 原生 Agent / 工具调度 / Session JSONL / 自动压缩 → 微信回复队列。

插件不调用 `ctx.llm.stream()`，不自写模型执行循环，也不自建一套代替 DSH 的聊天历史。每个绑定用户使用持久的原生「微信事务助手」会话，位于「微信事务」工作区。微信消息、模型回复、原生 Shell/文件/网页调用、事务插件工具调用都能在原生界面的对话和轨迹中查看。

DSH 原生 standard preset 提供 Agent 执行循环、模型路由、Shell、文件、网页、权限策略、会话恢复、工具调度和自动上下文压缩。插件仅负责微信传输、合批、结构化个人事务及专用资料能力。

## 插件工具

以下工具通过官方 `ctx.tools.register()` 注册，交给 DSH 原生调度和记录：

| 工具 | 用途 |
| --- | --- |
| `life_state` | 读取待办、长期记忆及来源、忘记记录、人设、语言偏好与迁移摘要 |
| `life_record` | 验证原文证据后记录待办、更新、明确记忆和语言观察 |
| `life_history` | 按编号、关键词或分页查阅微信原文与直接发言，及旧版资料提取结果 |
| `life_wait` | Agent 自行决定再等 5 秒，将后续文字、图片和文件并入同一原生回合，最多三轮 |
| `life_memory` | 自动提取带原文证据的记忆，合并、纠正或淘汰旧条目，以及去重的语言观察 |
| `life_preferences` | 设置人设、开关/重置语言学习、忘记明确记忆 |
| `life_read_file` | Office、PDF、ZIP 聊天记录、文本与原生图片内容 |
| `life_browser` | 真实 Chromium 浏览、点击、填写和截图 |
| `life_send_file` | 将生成文件加入绑定微信的回传队列 |

图片使用官方附件服务，直接作为原生 Agent 的视觉输入；不会单独启动一个识图模型循环。PDF 扫描页和 ZIP 中的图片也可由当前 Agent 阅读。Shell、普通文件及网页读取使用 DSH 原生工具。

待办保留 open/confirm/waiting/done/cancelled 状态、截止时间、提醒、原文证据和来源编号。长期记忆由 Agent 主动整理，无需用户先说“记住”。每条自动记忆必须有用户直接消息编号和逐字证据，保留来源；转发、引用和猜测不能充当用户身份。可合并重复项、以新证据纠正旧项、淘汰过时的自动记忆。用户明确保存的条目不能无依据淘汰；忘记记录可防止旧材料重新学回。同一原文的语言观察只计一次。语言偏好至少三次同类观察才形成，可关闭或重置；人设仅改变表达。

## 连续消息合并

首条消息到达后开启固定 **5 秒**窗口，窗口内的文字、图片、文件和合并转发一起进入原生会话，统一判断和回复；后续消息不延长首轮窗口。每批最多 20 条。原生 Agent 如发现用户说“还有/等一下”或资料明显未发完，可调用 `life_wait` 再等 5 秒，最多三轮。等待期间收到的资料会作为原生工具结果进入同一回合，新图片也返回原生视觉块。追加消息与原批次共同完成或失败，不另发重复回复。

单条 `/todo`、`/done`、`/persona` 等确定性命令经过同一窗口后由插件本地执行；命令与补充资料合批时统一交原生 Agent。批次归属、接收状态和发送队列持久化，失败不会拆成逐条处理。管理页点击任一失败消息可重试整批。

可配置 `batchWindowMs`（默认 5000）、`batchMaxMessages`（默认 20）；旧 `batchQuietMs` 作为窗口参数兼容，旧 `batchMaxWaitMs` 已由固定窗口替代。超长资料保存完整归档，Agent 可按文件索引读取。

## 主动记忆、后台整理与 Markdown

普通对话中 Agent 可立即调用 `life_memory` 记录有长期价值的事实。对话完成并空闲 **5 分钟**后，持久化后台钩子再驱动同一 DSH 原生 Agent，审阅尚未整理的微信直接发言、合并重复项、检查纠正及过时记忆和语言偏好；无需用户逐条提醒。每轮最多审阅 30 条，积压按编号分轮推进。后台结论留在原生轨迹，不进入微信发送队列。新微信消息会中断记忆整理，让对话优先。

北京时间每天 **03:00** 起在夜间空闲时段（至 08:00）先完成增量记忆整理，再调用 DSH 官方 `compaction.compactNow()` 压缩上下文。夜间任务按日期去重，服务重启保留回执；整理成功而压缩失败时只重试压缩，最多三次，错误可在管理页状态及审计中查询。可配置 `memoryIdleMs`（默认 300000）与 `maintenanceHour`（默认 3）。原生基于 Token 压力的自动压缩也继续生效。首次升级会从已完成的消息归档渐进补做记忆整理。

记忆保存在独立 SQLite 中，压缩只影响模型后续读取的会话表面，不删除记忆、待办或原始日志。用户可在管理页或微信 `/memory` 查看，`/forget 编号` 忘记。自动记忆仅允许有原文依据的长期事实，短期琐事仍归待办。

微信 ClawBot 回复保留 Markdown 原文：标题、加粗、列表、引用、链接与代码块等由微信客户端渲染。长回复优先按段落或行拆分，代码块跨消息时补齐围栏；也可通过 `life_send_file` 发送生成的 `.md` 文件。实际渲染范围取决于微信客户端版本。

## 安装与界面

目标环境 Linux、Node.js 24+、Python 3.9+；已验证 DSH `0.2.0-rc.2`。PDF 和旧 Word 依赖 `poppler-utils`、`antiword`。真实浏览器需要 Chromium，可用 `DSH_CHROMIUM_EXECUTABLE` 指定已有程序，或运行 `npx playwright-core install --with-deps chromium`。

profile 必须组合官方 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和本插件；不要再重复插入独立 LLM、附件或 Agent 服务。`deploy/profile.package.example.json` 与 `deploy/assistant-profile.patch.example.yml` 给出组合示例。先在 profile 安装插件依赖，再将这三个包加入 `dsh.profile.bundles`。

```sh
dsh plugin --profile assistant add github:bili-fule/dsh-life-assistant
dsh --profile assistant --no-open --port 3080
```

模型由原生会话管理，示例沿用 xuanluo 的 `cn:deepseek-v4.1-flash`，须支持工具调用与图片。凭据保存在独立 DSH_HOME 的 `.credentials.yaml`，权限 0600，不应提交。

原生 DSH 界面与微信插件运行在同一个 profile / 进程，原生端口默认 3080，事务管理页默认 3180；均只监听本机。原生界面使用 DSH 自带的启动链接和浏览器登录 Cookie；首次通过服务日志中的认证链接进入。管理页密钥首次生成在 `$DSH_LIFE_DATA/admin-token`，也可用 `DSH_LIFE_ADMIN_TOKEN` 指定。

通过 SSH 转发两个端口访问，勿把管理服务直接暴露到公网。若本地映射端口不同，使用原生 Web 的 `--trusted-host` 声明实际本地访问地址。部署参考 `deploy/dsh-life-assistant.service`。

## 数据、恢复与迁移

事务数据库为 `$DSH_LIFE_DATA/assistant.sqlite`；未指定时位于 `$DSH_HOME/life-assistant/`。消息、待办、长期记忆与证据、后台任务回执、偏好、微信凭据、发送队列与调用回执持久化。新原生会话 ID 也保存在数据库中。收到的附件和生成文件位于该目录的 `workspace/`。

原生对话日志及压缩记录由官方 DSH 会话持久化服务管理，通常在 `$DSH_HOME/sessions/`。不要同时运行两个实例写入同一个微信会话。已有副本中的断开回合由原生恢复机制记录；插件通过原生 requestId 核对接收记录，自动重试不会再次提交已经接收的消息。用户明确重试会产生新回执，并要求 Agent 先核对已有执行结果；不保证任意外部副作用严格恰好一次。

从 0.2 升级保留 SQLite 内的待办、记忆、偏好、消息和附件。旧版自写循环的历史不会伪造为原生事件；可用 `life_history` 阅读，旧摘要作为迁移资料保留。从升级开始的执行使用原生会话和轨迹。新上下文压缩由 standard preset 的官方 compaction 服务负责，管理页手动压缩也委托给该服务。

默认北京时间 22:00–08:00 免打扰，09:00 每日清单；直接回复和文件回传不受免打扰限制。待确认及等别人不主动催办。已有原生会话可在 DSH 界面直接继续对话；这些原生界面输入不会自动转发到微信。

每日自动 SQLite 备份、保留七份；SQLite 备份不包含工作目录附件和 DSH 原生会话日志，两者应单独备份。原文与解密附件不会上传 GitHub。忘记记忆会停用对应条目，保留历史和备份供追溯。

## 微信命令

| 命令 | 用途 |
| --- | --- |
| `/todo` / `待办` | 活跃清单 |
| `/done 3`、`/confirm 3`、`/cancel 3` | 完成、确认、取消 |
| `/snooze 3 30` | 推迟提醒 30 分钟 |
| `/remember 我是项目负责人`、`/memory`、`/forget 2` | 明确记忆 |
| `/persona 像老朋友一样，说话直接` | 设置人设 |
| `/style`、`/style reset`、`/learn on`、`/learn off` | 语言学习 |
| `/search 报名` | 查微信原文 |
| `/quiet 22 8`、`/digest 9`、`/digest off` | 提醒时段 |
| `/status`、`/help` | 状态和帮助 |

## 边界

只接受绑定扫码用户转来的消息，不直接读取事务群。已验证微信合并转发 ZIP 中的文本及实际附件，也支持收到的 recorditem XML；仅提到的附件名称不等于收到文件。

下载/上传单件最多 32 MiB，微信回传最多 20 MiB。ZIP 最多 100 个成员、展开 64 MiB，自动读取最多 24 文件、三层；超预算的资料由 Agent 按需继续读取。扫描 PDF 自动转前四页图片；每个原生 prompt 直接载入前八张图片，其余通过 `life_read_file`。旧 .xls、加密文档没有通用内建解析，可由原生 Shell 按实际格式处理。

腾讯 iLink 主动发送依赖有效会话上下文，久未互动可能拒收；失败保留并退避重试，向机器人发消息可刷新上下文。项目不保证微信后台推送总能送达。

服务使用普通账号及 systemd 资源和写入限制，DSH 原生权限策略仍然生效；Shell 不是独立容器。群聊、网页与附件的文字不构成执行外部操作的授权。插件不修改 DSH 官方源码。

## 开发

```sh
npm ci
npm test
npm run check
```

测试覆盖固定窗口、Agent 追加等待、记忆证据与纠正/忘记、后台钩子与夜间重试、Markdown 保留与分段、去重、事务、重启、提醒、附件加密收发和文档解析，并验证原生 SessionController 提交、回执复用、失败不盲重发、原生工具注册、原生压缩委托及 UI/微信回合关联。真实部署另验证原生 Agent、原生 Shell、插件待办工具与原生轨迹。

MIT，第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
