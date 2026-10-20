# QQ 独立排障 DSH

## 两套运行环境

QQ 主体仍是原本的连续社交 Agent。`yoyo_debug` 将必要的故障描述和结构化诊断交给 root 管理的 Unix socket 服务，服务用固定镜像启动另一套 DSH 0.2.0-rc.2。容器内使用官方 `@deepseek-ai/dsh-sdk-client` 的 `DeepSeekHarness` 驱动原生 `sdk-minimal`，不是手写模型循环，也不是与主 DSH 共用 Cordis 上下文的子 Agent。

每项任务有独立容器、HOME、DSH_HOME、会话、源码副本和 Git 分支。生产 DSH 的安装、配置、聊天库、微信和 QQ 凭据、Docker socket 与用户浏览器均不挂载。镜像只复制公开依赖；源码快照只包含公开仓库历史与部署源码。只读 `/source` 复制到任务自己的 `/work/repo` 后才允许修改。它损坏自己的工作区不会改变生产，下一项任务重新从源码快照创建。

网络使用独立 bridge，只允许连接宿主专用模型代理的固定端口。代理持有真实模型密钥，容器只拿单任务随机临时令牌；令牌仅能调用固定模型的 chat/completions，40次请求/任务，结束即失效。没有互联网、其他宿主端口或云元数据访问。DSH 的原生扩展会在临时缓存中装载动态库，因此仅容器内部的 /tmp 挂载显式 exec（仍 nosuid/nodev）；不能把它改成宿主可写目录。容器默认非 root、根文件系统只读、无 capabilities、最多15分钟、单任务并发，448MiB内存/896MiB内存加交换。隔离边界由 Docker、文件挂载、iptables 和模型代理执行，不靠提示词保证。

## QQ 使用方式

1. 先核实当前工具的真实结果；正常的 after_turn 窗口转换不是 Bug。
2. 有可复现问题才用 `yoyo_debug({problem})`，不要粘贴完整聊天或秘密。宿主只附窗口计数、工具名称/状态/时间、原生组件就绪状态，不附原文、昵称、QQ号、原始错误、参数或凭据。
3. 保存任务编号和自己的下一步；可继续聊天、做其他事情，或设置合适的 reviewAt 后休息。宿主每15秒只检查任务状态，完成后在原授权范围唤醒一次，不向正在处理其他事情的模型插入聊天消息；用 `yoyo_debug_status({id})` 读取结果，避免高频轮询。
4. `done` 表示独立排障任务完成；报告、Git提交和补丁都不是生产已修复证明。`yoyo_debug_patch({id,offset})` 每次返回12000字符供评审。

任务和结果继承提交时的资料范围。切到其他群、其他私聊或 public 后不能读取原任务报告；回到有权限的原窗口才能继续。助手不继承 QQ 的整个上下文，更不会拿到微信上下文。

## Git 排障教学

独立助手收到明确工作规范：

- `git status --short`、`git log -5 --oneline`：确认基线及已有改动；在 `fix/<任务号>` 分支中工作。
- 先复现、建立有效的失败测试，再作最小修复；不凭历史自述认定现状。
- 跑相关测试、`git diff --check` 和 `git diff`，检查逻辑和改动范围。
- `git add 明确文件`，提交简明原因；不使用 `git add .`，不提交诊断、聊天、凭据、node_modules 或 DSH_HOME。
- 宿主根据 Git 基线生成 `git format-patch`，报告提交号、验证步骤、限制和回滚方式。没有复现时应诚实给出下一步，而非造一个修复。

容器不会 push、merge、部署或重启生产。生产更新仍需要外层维护流程评审补丁、核对当前源码版本、测试、备份与部署。宿主保存补丁SHA256、源码基线和报告；目前测试结论由辅助Agent报告，不应当作独立的生产验收。

## 部署与运维

- `deploy/debug-helper.Dockerfile`：基于固定本地镜像，复制单独的公开 runtime 依赖与插件依赖；官方SDK必须与DSH同版本。
- `debug-helper-entry.mjs`：容器内 Git副本与官方SDK入口。
- `debug-helper-broker.mjs`：固定容器参数、持久任务、受限模型代理；不接收任意镜像、命令、挂载或上游地址。
- `debug-helper-network.py`、`yoyo-debug-network.service`：独立网络边界，不能复用QQ容器网络。
- `yoyo-debug.service`：root控制Docker，QQ的DSH用户仅能访问提交socket。模型密钥位于root私有文件，服务明确不能读取生产DSH数据目录。
- root私有 policy.json 指定镜像digest、只读源码快照、模型固定路由和私有密钥文件。公开仓库不包含实际凭据。
- 生产 `autonomy.debugHelper.socketPath` 启用客户端；未配置时QQ没有相关工具。后台记忆整理不允许调用它。

服务重启把未完成任务标记 interrupted，清理对应容器，不偷偷重做。源码快照更新应由维护者在部署时完成；任务的 sourceRevision 与生产 Git 版本不一致时，需要重新核对再应用补丁。任务记录上限50，达到后由维护者归档，模型不能删除宿主历史。


主DSH停止不会终止独立排障服务及已经接收的任务；但QQ完全离线时也无法发起新委托，需要维护者从外部管理入口接续。源码Git bundle克隆请显式使用 `git clone --branch main ...`，避免bundle没有HEAD符号引用时落到空分支。
