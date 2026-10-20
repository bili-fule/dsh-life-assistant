# 微信私人账本

账本使用微信助手私人 `assistant.sqlite` 中的独立表，不依靠聊天摘要做加减。QQ 社交数据库、状态及工具权限不包含账本。

## 数据与统计口径

- 仅支持人民币；金额存整数分，输入最多两位小数，不做隐式四舍五入。
- income 为收款流水但不含退款；expense 保留支出流水，refund 单列；净支出 = expense − refund；收支结余 = income + refund − expense。
- transfer 表示自有账户充值、提现等中性交易，不算收支。向他人的转账按账单原方向处理，不能仅因交易类型叫“转账”就当中性交易。
- 按北京时间日期归月，退款按实际退款入账月抵减；收支结余不是账户余额，也不能说明所有银行卡或其他平台的完整收入。
- 原交易状态、对方、商品、支付方式、交易号、源文件摘要和行号保留在私人明细。分类初始为未分类，不把商户名称推断成确定的消费用途。
- `ledger_changes` 保留更正前后值及原因，revision 防止覆盖别人刚完成的修改；作废不会硬删除原记录。

## 原生 Agent 工具

`life_ledger_import` 从工作目录导入微信支付 XLSX；`life_ledger_query` 查询数据库明细和月度汇总；`life_ledger_record` 保存带绑定微信用户直接原文依据的收支；`life_ledger_amend` 按编号、revision 和原因更正或作废。后台记忆整理不能写账，QQ Agent 无权调用这些工具。

手动记录必须明确已发生，不将待收款、借款计划或模糊数字猜成收入。DSH 界面可查询及导入现有附件；手动新增工具当前要求已落库的微信直接原文 sourceId/quote。

XLSX 导入使用 Python 标准库，不执行公式或宏，限制文件及解压规模。原文件 SHA-256 防整文件重导，原交易号防交叠账期重复；同号金额、日期或方向冲突拒绝覆盖。每次将原方向的笔数和金额与微信文件顶部的收入、支出、中性交易汇总核对，不一致整批回滚。退款对账时仍归原账单收入方向，展示时单列。

运营者可在停止服务并备份后运行：

```sh
node deploy/import-wechat-bill.mjs /private/assistant.sqlite /private/wechat-bill.xlsx
```

重复的微信口述与另一个平台账单目前不会自动模糊合并；需要按编号核对后作废重复条目。交易号不同的两笔相同金额不能当成重复。

## 页面与登录

`/ledger/` 提供独立展示页。未登录只访问 `/api/ledger/public`，默认不公开；运营者启用后仅返回最近六个有记录月份的收入和净支出准确汇总，不返回笔数、分类、交易对象或任何原文。公开接口不接受缩小时间、商户等查询条件，避免用差分查询拼出明细。

登录后 `/api/ledger/details` 返回准确月汇总及明细，支持月份筛选与游标翻页。退出会撤销服务器会话并清空页面明细。认证为独立账本密码（scrypt 存储）及随机会话；数据库只存会话摘要。Cookie 使用 HttpOnly、Secure、SameSite=Strict，七天失效。修改密码使旧会话全部失效；登录限速、JSON 写请求和 Origin 校验在服务端执行。生产网站必须使用 HTTPS，不能只在前端隐藏明细。

管理密钥可调用 `POST /api/ledger/settings`，设置 `password` 或 `published`；不要把管理密钥放进网站源码。账本 Cookie 不能授权助手的其他管理接口。

## 接入已有网站

可以把 `/ledger/`、`/ledger.js`、`/ledger.css` 和 `/api/ledger/` 通过同源反向代理连接到现有网站，后端保持监听 127.0.0.1:3180。代理保留 Host，禁用这些 API 的缓存，公网只暴露所需路径，不能把助手的 `/api/state`、附件下载、Shell 等管理面一起映射出去。原站登录若要复用，需做经过验证的服务端身份衔接，不能接受前端自报“已登录”。

公开粒度由用户确认；当前配置为准确月度汇总，对接 www.xmfu.cn。页面、账本及登录可先在本地隧道使用；账单、数据库、密码和带真实数据的截图不得提交公开仓库。

## www.xmfu.cn 接入

Vue 页面 /ledger 使用同源 /api/ledger/*，EdgeOne 的 edge-functions/api/ledger/[[path]].js 仅转发五个固定路由到独立 HTTPS 源站。源站 yoyo-ledger-gateway.service 使用 ledger-web 独立账号，通过 systemd LoadCredential 读取既有 IP 证书，不能读取助手数据目录；仅转发账本 Cookie，不转发管理 Authorization 或网站其他 Cookie。明细仍由私人服务验证会话。公网不提供助手管理接口。

既有证书由原有 ACME cron 续期；yoyo-ledger-cert.path 监控实际安装的 fullchain 更新，重启网关载入新证书，不改动其他服务的续期配置。
