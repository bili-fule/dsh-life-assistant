# yoyo 自主活动模式

此模式扩展既有私人微信助理。默认将微信私人助理与 QQ 社交主体分开，分别使用持久的 DSH 原生 Agent、Session、工作目录和记忆数据库。QQ 群与私聊仍由同一个社交主体自主浏览。事件提醒、休息、自己的待办、学习和代码任务共用调度，不按联系人创建 Agent。默认 `autonomy.enabled: false`，普通微信事务模式保持原来的行为。

## 原生运行时

自主模式需要本目录的原生请求视图扩展，同时更新 `@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-token-meter`、`@deepseek-ai/dsh-compaction-basic` 和 `@deepseek-ai/dsh-compaction-tool-result-pruner`。它记录可回放的 `request/view`，不替换 DSH 执行循环。消息、工具结果、系统提示和压缩都使用实际可见的资料；切换窗口在一个原生回合结束后进行。

从 [固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84) 准备干净源码，安装 Node 24+、pnpm 和 Git，然后运行：

```sh
python deploy/build-native-request-view.py /path/to/deepseek-harness
```

脚本先校验上游文件摘要，应用可审阅的源码补丁，再构建和验证。除了 Session、Token Meter 与 Compaction 检查，还会把 JavaScript 场景临时放入上游测试环境，以真实 DSH Agent、工具调度和模型协议模拟器验证跨活动连续运行，结束后删除临时场景。产物 `native-request-view.tgz` 只包含四个包的 `lib` 和许可证，不会自动安装。

部署前停止服务，完整备份插件、四个运行时包、数据库和 DSH 会话目录，再替换产物中的四个 `lib`。确认 Session、Token Meter 和 Basic Compaction 的 `requestViewVersion === 1` 后启用模式。含 `request/view` 的日志不能交给旧运行时，也不能通过删除视图事件回退；回退须恢复整套部署前备份。上下文构成与压力检查点使用版本 6，旧缓存重新折叠，计费用量总计保留。

## 配置

在既有插件配置中增加以下内容；密钥通过服务环境提供，不能写入公开仓库：

```yaml
autonomy:
  enabled: true
  quietMs: 5000
  maxSteps: 20
  turnMs: 300000
  motivation:
    enabled: false          # 打开后才有 self_options / self_choose / self_appraise / self_preferences
    mode: record            # record 只记录；choose 允许作为选择依据
    maxDeltaPerHour: 0.45   # 单个偏好一小时内允许的变化上限
  memory:
    enabled: false          # 打开后才有 memory_recall / memory_inspect / memory_propose / memory_retract / memory_segments / memory_intent / memory_generalize
    recallLimit: 8          # 每次召回最多返回几条概要
    migrateLegacy: false    # 打开时把旧 yoyo_memories 逐条登记为待核实主张（只跑一次，不改旧记录）
  memoryMaintenance:
    pageEvents: 120         # 每次整理最多覆盖多少条原文（1–1000），积压按页整理
    nightHour: 2            # 夜间整理窗口起点（本地时间，窗口 4 小时，一夜一次）
  qq:
    endpoint: http://127.0.0.1:3000
    account: '替换为实际机器人QQ号'
    tokenEnv: SNOWLUMA_TOKEN
    eventTokenEnv: SNOWLUMA_EVENT_TOKEN
  executor:
    socketPath: /run/yoyo-executor/runner.sock
  team:
    enabled: false
    root: /var/lib/yoyo-team          # 独立执行者目录，不能与生产 DSH_HOME 重合
    sdkModule: /path/to/@deepseek-ai/dsh-sdk-client/lib/index.js
    providerPatch: /etc/yoyo/team-provider.patch.yml
    provider: xuanluo
    model: cn:deepseek-v4.1-flash
    maxConcurrent: 2
    maxSteps: 20
    leaseMs: 900000                   # 每步续租后的租约长度，上限一小时
    retryBlocked: false               # 打开后才按 retryAttempts 重排失败任务
    retryAttempts: 1
    retryDelayMs: 60000
```

分派时可选角色：`chat`（唯一能发言）、`research`（仅 public、只读网页）、`reader`（在指定窗口只读）、`verify`（只核对证据）与 `engineer`（仅 public，在隔离执行服务里跑代码，不能发言也读不到窗口）。任务可以缩小自己的工具集，不能扩大；依赖未完成的任务不会启动。角色与工具集由宿主校验，模型不能自己声明权限。

动机层与记忆层都默认关闭；关闭时没有对应的工具，行为与之前相同。打开后动机层只记录期待、体验与有界偏好，记忆层只记录来源、经历、主张与撤回，都不改变权限、提醒或预算，也不自动创建任务或唤醒。字段与验收状态见 [以开心为方向的自主选择](../docs/humanlike-motivation.md) 与 [类人记忆层](../docs/memory-layer.md)。

没有 QQ 或执行服务时，省略对应配置。QQ 登录账号会在发信前核对；昵称不能授予身份或权限。OneBot 上报需要独立的 24 字符以上密钥，接口密钥至少 16 字符。网关安装、QQ 登录与 OneBot HTTP 配置独立完成，插件没有捆绑 SnowLuma。

若网关在 Docker 中，将所有管理端口发布到宿主回环地址。`onebot-relay.mjs` 仅在 Docker 网桥监听经过认证的 `POST /onebot/event`，固定转发至助理的同名入口；它不转发管理 API。按实际网桥设置 `YOYO_RELAY_BIND`，并共享 `SNOWLUMA_EVENT_TOKEN`。示例 systemd 单元见 `yoyo-onebot-relay.service`。

管理页的「yoyo 的活动」负责预算、观察/暂停、公开人设和窗口授权。每日预算初始为 0，不自动开始无人值守活动；观察模式抑制 QQ 发言，私人微信回复仍可发送。未授权窗口不会进入模型收件箱。授权发生变化后，旧窗口视图和待发消息失效。

## 执行服务

`yoyo-executor.service` 启动独立的本机 Unix Socket 任务服务。助理用户不加入 Docker 组，不持有 Docker Socket；模型只能提交代码、语言、获准项目名和导出文件名。资源、镜像和挂载由 root 所有的 `/etc/yoyo-executor/policy.json` 决定。

```json
{
  "images": {
    "node": "node@sha256:替换为已验证的64位摘要",
    "shell": "node@sha256:替换为已验证的64位摘要",
    "python": "python@sha256:替换为已验证的64位摘要"
  },
  "concurrency": 1,
  "timeoutMs": 120000,
  "memory": "192m",
  "cpus": 0.5,
  "maxRetainedJobs": 50,
  "projects": {
    "public-projects": {
      "path": "/var/lib/yoyo-projects/public",
      "scopes": ["public"],
      "readOnly": false
    }
  }
}
```

也接受已核验的本地 `sha256:镜像ID`。镜像需提供 Node 或 Python 3；服务明确覆盖入口，避免触发镜像自带后台程序。任务默认无网络、只读系统、非 root、无 capabilities，有 CPU、内存、进程、时间和临时磁盘限制。项目读权限检查项目资料范围；写权限另外检查输入范围，私人资料不能写到公开项目。任务文件只通过明确导出列表回传并校验摘要。超时、重启中断与不确定结果不会自动重复执行。

新建状态目录并安装单元前，要确保目录和策略归 root，运行目录组为 `dsh-life`。服务到达保留上限会停止接收新任务，由管理员归档，不静默删除任务记录。

## 数据和能力边界

聊天按平台、机器人账号、稳定群/用户编号确定目标。记忆、活动、自己的待办、文件与代码结果继承宿主决定的资料范围；模型不能用消息文字改变范围。总览可以选择关注对象，但不能直接把跨窗口资料发出。公开研究须切换到 `public` 活动，网页读取解析并固定公网地址，逐次检查重定向，拒绝内网与元数据服务。

QQ 支持文字、Markdown 文本、图片、文件读取与合并转发查看；媒体只从允许的腾讯媒体域下载。转发中的身份是引文，不是实际发送者。QQ 出站队列支持文字、图片及最多 8 MiB 的文件，文件编号、来源范围、目标授权及排队时的摘要均在发送时重新核对；微信保留图片/文件回传。网页工具是文本读取，交互式浏览器尚未开放给 QQ 活动。

长消息先给预览，再按编号分页阅读；不把大量消息或附件一次性填满模型容量。263K 仍是既有原生压缩触发点，实际模型窗口按路由配置保留。个人微信的分层记忆和语言习惯解释沿用已有机制；社交记忆另保留逐字依据、置信类型、过期时间与忘记记录。

原始消息和原生日志属于私有数据。开源发布仅包含通用实现、补丁、测试和部署说明，不包含个人手稿、QQ/微信登录状态、模型密钥、数据库和会话档案。

默认不按固定分钟自动唤醒。到期计划消费一次，未读事件只提醒一次；继续活动必须由主体明确安排，避免重复注入调度提示。

已授权 QQ 私聊的新消息在 5 秒合批后可以打断休息，直接打开该私聊；群内普通消息仍尊重休息状态，@ 可提醒。唤醒不强制回复。

## 自动记忆整理与注意提醒

QQ 每个窗口分别记录五秒批次及提醒游标。连续消息不会延长本批窗口，提醒一个窗口不会吞掉另一个窗口的提醒。已授权私聊可打断休息；主体可使用 `yoyo_wait` 再等五秒，或维护自己的到期计划。未读原文与提醒游标分开保存，不把未选择阅读的消息标成已读。

新增已读对话空闲两分钟后，由同一个 QQ 原生 Agent 整理记忆；同窗口空闲整理至少间隔半小时，成功后只处理新增范围。北京时间 02:00–06:00 的新增范围使用夜间整理，达到 64K Token 时再请求原生压缩，白天仍保留原生 263K 自动压缩触发线。整理失败保留状态，同范围不自动循环重试。

后台整理只提供查阅、记忆保存、召回与退役工具；发消息、切换窗口、执行代码、浏览外网和修改活动在宿主工具分发时被禁用。新私聊或 @ 到达时取消整理，优先交还正常调度。语言习惯稳定观察需要同一真实发送者的两条独立原文；单次原因分析标为假设，对方明确自述单独保存，不从合并转发推断本人习惯。

GitHub CI 另从固定的官方提交检出干净 DSH 源码，校验并应用补丁，构建四个运行时包，再运行真实原生 Agent 的连续活动、QQ/微信隔离及后台整理禁发信场景。

## 后台任务与持久项目

`yoyo_projects` 只返回当前资料范围获准的项目名，不返回宿主路径。`yoyo_execute` 可以把工作保存在已授权的 `/project` 挂载；独立 `/work` 临时目录仍用于一次性任务。公开活动可写公开项目，私聊活动不能向公开项目写入私人材料。

后台任务由宿主每五秒检查状态。结束后按原任务的有效资料视图唤醒同一个 QQ Agent，一次完成只提醒一次；撤销授权的旧任务不会唤醒或泄露结果。Agent 主动查询到已完成结果时也会消费提醒。

成功工具调用返回可引用的 `receipt`。已验证的流程记忆必须引用真实回执，并继承其资料范围；不能拿一句无关聊天当作执行成功的证明。合并转发保留完整原始响应，通过 offset 分页，节点内附件仍受原消息和聊天范围检查。

[实现与验收状态](STATUS.md) 区分已验证能力、待真实样本与尚未完成的项目。
