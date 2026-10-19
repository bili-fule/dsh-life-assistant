# yoyo 自主活动模式

此模式扩展既有私人微信助理。默认将微信私人助理与 QQ 社交主体分开，分别使用持久的 DSH 原生 Agent、Session、工作目录和记忆数据库。QQ 群与私聊仍由同一个社交主体自主浏览。事件提醒、休息、自己的待办、学习和代码任务共用调度，不按联系人创建 Agent。默认 `autonomy.enabled: false`，普通微信事务模式保持原来的行为。

## 原生运行时

自主模式需要本目录的原生请求视图扩展，同时更新 `@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-token-meter`、`@deepseek-ai/dsh-compaction-basic` 和 `@deepseek-ai/dsh-compaction-tool-result-pruner`。它记录可回放的 `request/view`，不替换 DSH 执行循环。消息、工具结果、系统提示和压缩都使用实际可见的资料；切换窗口在一个原生回合结束后进行。

从 [固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84) 准备干净源码，安装 Node 24+、pnpm 和 Git，然后运行：

```sh
python deploy/build-native-request-view.py /path/to/deepseek-harness
```

脚本先校验上游文件摘要，应用可审阅的源码补丁，再构建和验证。除了 Session 与 Token Meter 检查，还会把 JavaScript 场景临时放入上游测试环境，以真实 DSH Agent、工具调度和模型协议模拟器验证跨活动连续运行，结束后删除临时场景。产物 `native-request-view.tgz` 只包含四个包的 `lib` 和许可证，不会自动安装。

部署前停止服务，完整备份插件、四个运行时包、数据库和 DSH 会话目录，再替换产物中的四个 `lib`。确认 Session、Token Meter 和 Basic Compaction 的 `requestViewVersion === 1` 后启用模式。含 `request/view` 的日志不能交给旧运行时，也不能通过删除视图事件回退；回退须恢复整套部署前备份。上下文构成与压力检查点使用版本 6，旧缓存重新折叠，计费用量总计保留。

## 配置

在既有插件配置中增加以下内容；密钥通过服务环境提供，不能写入公开仓库：

```yaml
autonomy:
  enabled: true
  quietMs: 5000
  maxSteps: 20
  turnMs: 300000
  qq:
    endpoint: http://127.0.0.1:3000
    account: '替换为实际机器人QQ号'
    tokenEnv: SNOWLUMA_TOKEN
    eventTokenEnv: SNOWLUMA_EVENT_TOKEN
  executor:
    socketPath: /run/yoyo-executor/runner.sock
```

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

QQ 支持文字、Markdown 文本、图片、文件读取与合并转发查看；媒体只从允许的腾讯媒体域下载。转发中的身份是引文，不是实际发送者。当前 QQ 出站队列仅发送文字；微信保留图片/文件回传。网页工具是文本读取，交互式浏览器尚未开放给 QQ 活动。

长消息先给预览，再按编号分页阅读；不把大量消息或附件一次性填满模型容量。263K 仍是既有原生压缩触发点，实际模型窗口按路由配置保留。个人微信的分层记忆和语言习惯解释沿用已有机制；社交记忆另保留逐字依据、置信类型、过期时间与忘记记录。

原始消息和原生日志属于私有数据。开源发布仅包含通用实现、补丁、测试和部署说明，不包含个人手稿、QQ/微信登录状态、模型密钥、数据库和会话档案。

默认不按固定分钟自动唤醒。到期计划消费一次，未读事件只提醒一次；继续活动必须由主体明确安排，避免重复注入调度提示。
