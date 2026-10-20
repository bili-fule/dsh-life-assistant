# 隔离浏览器：DSH 原生集成与 Playwright MCP

## 采用的现成实现

采用 DSH `@deepseek-ai/dsh-browser-use` 和 `@deepseek-ai/dsh-experimental-browser-use-runtime` 0.2.0-rc.2 的 `mountSessionMcp`，由官方代码负责每个原生 Agent 的 MCP 连接、工具发现、串行调用和关闭。浏览器操作直接使用微软 `@playwright/mcp` 0.0.80（依赖 Playwright 1.63.0-alpha-2026-08-31），未重写 DOM、点击或截图工具。

官方 Playwright 插件的默认启动器在宿主启动进程；这里用十余行 `browser-provider.mjs` 启动适配器替换该进程入口，复用同一个官方会话集成库。它是官方集成的隔离部署适配，不是未经修改安装官方默认启动插件，也不是另一套 Agent。

## 部署组成

- browser-provider.mjs：DSH provider，调用官方 mountSessionMcp。
- browser-stdio.mjs：原生 MCP 子进程，把标准输入输出连接到 Unix socket。
- browser-broker.mjs：root 管理的固定启动器，每个连接一个独立容器。客户端不能选择镜像、参数、宿主目录或网络。
- browser-network.py：只处理专用 Docker bridge 的出口规则，不修改 QQ 的 Docker 网络。
- browser-mcp/：固定版本的上游依赖和 lockfile、构建文件。
- yoyo-browser*.service：网络初始化和 broker 生命周期。

浏览器容器非 root、只读根文件系统、移除 capabilities、不挂载 Docker socket、聊天库、模型密钥、QQ 配置或用户浏览器 profile。唯一宿主挂载是固定 Chromium 二进制且只读。每连接独立内存 profile 和临时文件；断开后删除容器，broker 重启时清理自己的旧容器而不接管。

每容器上限 320 MiB 内存、576 MiB 内存加交换、0.4 CPU、128 PID。Chromium 用容器边界而非内置 Chromium sandbox；`--no-sandbox` 并不表示允许宿主执行。DSH 子进程只获得普通 Unix socket 访问，不获得 Docker 管理权限。

## 网络范围

专用 bridge 为 br-yoyo-browser，IPv6 关闭。出口先拒绝环回、内网、链路本地、云元数据、保留地址及配置中的宿主公网地址；仅允许公开网络的 TCP 80/443/53 和 UDP 53。发往宿主的 bridge INPUT 同样拒绝。DNS 重绑定解析为内网 IP 后仍受实际 IP 规则约束。

它可以访问互联网并产生真实网站副作用；这些网络规则不等于网站级只读权限。登录、提交、发送和上传仍须遵守用户授权和产品执行政策。不同主体不共享登录态。不要配置用户本机 Chrome 的 profile 或 remote-debugging endpoint 来绕过隔离。

网络重载先构建完整新规则链再接入，避免空链短暂放行。Docker 或服务重启后要核对规则、MCP 生命周期与实际请求；不把进程存活当作隔离证明。

## 生产配置要点

1. 准备与所选 Chromium 兼容的基础镜像，固定镜像 ID/digest，再使用 browser-mcp 的 lockfile 构建。BASE_IMAGE 必填，Dockerfile 不从 latest 猜版本。当前服务使用经过本机实测的已有兼容基础镜像；该镜像未随开源插件分发，干净机器镜像重建仍需验证。拉取官方 Node 基础镜像的尝试遇到 registry 连接超时，不据此改变生产网络策略。
2. root 创建 /etc/yoyo-browser/policy.json（0600），包含固定 image、固定 chromium 路径、maxSessions 与 denyHosts。denyHosts 要包括宿主对外 IP；不能由模型修改。
3. 安装网络和 broker unit，核对 socket 组为 dsh-life、模式 0660，目录 0750。先单独测试 MCP 和出口边界。
4. 安装上述两个官方 DSH 包到现有运行时，保持版本匹配，不重新安装覆盖已有原生 Session/压缩补丁。
5. 将 provider 作为 dsh-yoyo-browser 包安装在运行时，配置中先加载 browser-use 和 provider，再加载会创建 Agent 的事务插件。官方集成不会补接已经创建的活跃 Agent，需要完成当前回合后重启/恢复原生激活。
6. QQ 插件 autonomy.publicBrowser=true 才提供对应工具。正常私聊、总览（含私聊范围）和后台整理都不提供浏览器，实际 pre-execute 再校验；需 yoyo_open public 后才能操作。

现有生产 profile 包含自定义 YAML tag 和模型配置，升级只增补所需条目，不用普通 YAML 序列化器重写整份配置。保留配置、代码和完整停机数据备份；升级插件包时不要覆盖生产 cordis.patch.yml。

## 使用与限制

原生工具名前缀为 mcp__playwright-mcp__browser_。先 navigate，再 snapshot 获取内联控件引用；上游导航结果可能只给容器中的快照文件链接，该路径不在宿主上。take_screenshot 可返回原生图像；任务结束使用 close 释放 Chromium，MCP 连接仍随原生 Session 保留。

临时下载和文件仅在当前容器里，尚未接入 QQ 文件回传资产索引。无头服务不提供人与 Agent 同页接管面板。上游断连不自动重连，修复后需重新激活 Session；不要重复创建 Agent 以掩盖错误。此版本未提供可靠网页搜索后端，浏览器不替代搜索索引。

## 验收记录

独立 MCP 实测通过：初始化和工具发现、真实 HTTPS 导航、内联 DOM 快照、PNG 图像；两个同时连接的浏览器 localStorage 隔离；容器 UID=65534，宿主数据/凭据路径和 Docker socket 不可见；测试的两类元数据地址、宿主 bridge 管理地址和公网管理端口不可达。工具权限单测覆盖 public 放行、私聊与含私聊总览拒绝、后台整理拒绝。

这些结果只覆盖所列样本和配置，不宣称已经穷举所有网络或浏览器漏洞。接入后的实际原生 Agent 调用结果见 deploy/STATUS.md。

## 原生结果与记忆证据

插件观察 DSH tools/result 的最终结果，将浏览器文本结果按真实原生回合、调用编号和资料范围建立 native-browser 回执。图像本体留在 DSH 附件系统，不复制 base64 到证据表。yoyo_evidence 返回当前可见的有限条数、原文预览及 receipt；引用其中逐字结果才可记为执行经验。错误结果保留错误标志，不能据此宣称动作成功。

活动、关切、反馈、学习意图和记忆整理这些模型自述不作为实际执行证据，避免“先说做过、再引用自己的话证明做过”。索引不另起模型调用，也不改变原生浏览器工具的执行结果。
