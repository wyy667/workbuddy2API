# CodeBuddy Proxy 工具包

把 CodeBuddy / WorkBuddy 订阅暴露成标准 **OpenAI 兼容接口**，自带可视化管理台：
多账号管理、手机号登录、每日自动签到、额度不足自动换号、Token 消耗统计。

> ⚠️ 仅供个人学习研究。使用前请自行评估官方服务条款风险。
>
> 📖 **首次部署或升级前，建议先读同目录的《使用与升级指南》。** 本篇是速查版，指南里有完整的分步说明、常见问题排查与安全建议。


## 环境要求

新版管理台使用 Vue 3，源码位于 `frontend/`。根目录 `admin.html` 已构建，可按原流程部署；如需修改前端，进入 `frontend` 执行 `npm ci`、`npm run build`。详见 `frontend/README.md`。本次升级请同时部署 `server.js`、`admin.html`、`admin-ui/`、`ext-assets.js` 和 `backend/*.cjs` 并重启服务。

实时请求地图使用本地 DB-IP City Lite 地理库，首次启动自动下载到 `data/`，可提前执行 `node backend/geo-worker.cjs` 安装。服务用户需要该目录写权限；数据库缺失不会阻塞模型调用。源站地址、可信代理配置和地理库更新说明见 [实时地图说明](backend/REQUEST-MAP.md)。

- 一台 Linux 服务器（1 核 1G 起即可）
- Node.js 22+（部署脚本会自动安装）
- 一个属于**你自己**的 CodeBuddy / WorkBuddy 账号

## 部署（3 步）

```bash
# 1. 把整个目录上传到你的服务器，例如 /root/codebuddy-deploy
scp -r 本目录 root@你的服务器:/root/codebuddy-deploy

# 2. 在服务器上执行一键部署（自动装 Node 22 + systemd 常驻 + 随机生成 API Key）
cd /root/codebuddy-deploy && bash setup-server.sh

# 3. 浏览器打开管理台（Key 是上一步脚本输出的那个）
http://服务器IP:8787/admin?key=你的Key
```

在管理台里：

1. 点「① 生成登录链接」→ 打开链接 → 用你自己的账号（手机号）登录
2. 登录成功，账号自动入库，OpenAI 接口立即可用
3. 客户端（ZCode / Cherry Studio / 任何 OpenAI 兼容工具）这样填：
   - Base URL：`http://服务器IP:8787/v1`
   - API Key：脚本生成的那把
   - 模型：`hy4-preview`（夜间 23:00-次日 8:00 免费）、`deepseek-v4.1-flash`（低价主力）等按管理台显示的倍率选

## 升级（已有旧版时）

**不要重跑 setup-server.sh**（它会保留 .env 但没必要）。用升级包：

```bash
# 1. 上传完整程序包（包含 backend 模块）
scp -r upgrade.sh server.js admin.html ext-assets.js backend root@你的服务器:/root/cb-update/

# 2. 执行升级（自动备份旧版 → 替换 → 语法检查 → 重启，失败自动回滚）
cd /root/cb-update && bash upgrade.sh
```

升级**只替换程序文件及 backend 模块**，账号存档（`auths/`）、`.env`、统计与配置全部保留。
脚本会先把旧版备份到 `/opt/codebuddy-proxy/.upgrade-backup-<时间戳>/`，并打印回滚命令。

升级后浏览器请按 **Ctrl+Shift+R** 强制刷新，否则可能看到旧界面。

## 主要功能

| 功能 | 说明 |
|---|---|
| 多账号管理 | 手机号登录、自动存档、一键切换；别名/备注 |
| 自动换号 | 额度不足/被限流时自动切换到可用账号 |
| **定时轮换** | 每 30/60 分钟自动换号，规避单号风控；可关闭 |
| **403 风控标记** | 账号被上游拦截时打标记并移入「观察池」，暂停签到、每天单独体检，7 天未恢复自动删除 |
| **每日签到** | 自动为所有账号签到领积分 |
| **Token 周期刷新** | 可设 1/2/3/7/14/30 天周期自动刷新登录态，避免凭证过期后无法重登 |
| **自动备份** | 每日定时打包账号与配置，保留最近 7 份 |
| **用量统计** | 按模型/账号筛选，含今日/本周/累计 token、缓存命中、积分消耗 |
| **请求明细** | 最近 10 条请求：账号、首字延迟、耗时、输入/缓存/输出、积分 |
| **附加 API Key** | 分享给朋友用：可限模型白名单、限账号、限每日请求次数、限每日 token 数；附加 Key 无管理台权限 |
| **模型总表** | 展示全部可用模型与计费倍率、活动标签（夜间免费/限时免费/独家优惠），支持手动拉取最新目录 |

## 文件说明

| 文件 | 用途 |
|---|---|
| `server.js` | 反代主程序（零依赖，Node 22+；**不含任何内置凭据**，Key 从环境变量读取） |
| `admin.html` | 可视化管理台 |
| `backend/*.cjs` | 请求生命周期、配额、凭据同步、持久化、调度与压缩模块（运行必需） |
| `ext-assets.js` | 内置反代协议资源 |
| `setup-server.sh` | 首次一键部署（Node/CLI/systemd/随机 Key） |
| `upgrade.sh` | 版本升级（保留数据，失败自动回滚） |
| `find-auth.sh` | CLI 登录后定位凭据文件 |

## 安全说明

- 工具包内**不含任何账号、密码、token**——所有凭据在你自己登录后生成、只存在你自己的服务器上
- API Key 就是管理台门禁，请勿外传；泄露了就改 `.env` 里的 `CB_API_KEY` 后重启
- 建议在云安全组里把 8787 端口限制为仅你自己的 IP 可访问
- 给朋友分享时用「附加 API Key」，**不要给主 Key**（主 Key 能进管理台看到你所有账号）

## 后端可靠性升级

详见 `backend-review/IMPLEMENTATION.md`。默认整请求预算 120 秒，覆盖凭据刷新、重试与流式响应，可用 `CB_REQ_BUDGET_MS` 调整；`CB_ACCT_MAX_INFLIGHT` 默认 4，`CB_MAX_INFLIGHT` 默认 128，满载返回 429 和 Retry-After，不使用无界等待队列。

每日请求次数在入站预占，发起上游后即消耗一次（失败或断开也计数）；未发起则退还。Token 与积分是结算后的停用阈值，按上游提供的用量结算，单次请求可超过阈值；设置这类阈值的密钥串行处理，避免多个未结算请求同时超额。跨午夜请求按入站日期归属，不占新一天请求额度；未返回的用量无法凭空核算。高频统计与计费状态采用 5 秒合批写入，进程被强杀或主机掉电可能丢失最后一个批次；正常停机及致命异常会尽力冲刷。

管理台使用 `/admin/api/status?detail=light` 和 `/admin/api/usage` 分离状态与历史。旧版完整 `/status` 保持兼容。写入异常可在状态、指标接口和管理台告警查看。部署依然为单进程；并发租约与配额预占是进程内状态，多进程部署前需使用共享事务存储。

本地验证：

```sh
node --test backend/tests/modules.test.cjs
node backend/tests/regression.cjs
npm test --prefix frontend
npm run test:e2e --prefix frontend
```


## 请求超时与管理台会话（2026-09-27）

- `CB_REQ_BUDGET_MS`：请求接收、选号、凭据刷新和重试到成功上游响应头的预算，默认 600000 毫秒。
- `CB_STREAM_MAX_MS`：响应开始后独立时长上限，默认 1800000 毫秒；设为 0 时只保留空闲超时和客户端取消保护。
- `CB_UPSTREAM_STREAM_IDLE`：两次上游读取间空闲上限，默认 600000 毫秒。
- `CB_MAX_BODY_MB`：对话请求体上限，默认 16 MiB。超限返回 413。

首次使用原 `/admin?key=...` 地址进入后，地址栏移除 key；后续请求使用请求头和 HttpOnly 会话 Cookie。Cookie 默认 30 天，并在主密钥变化后失效。清除 Cookie 后需重新使用带 key 的入口地址。API 客户端仍沿用 Bearer / X-Api-Key 鉴权，管理 Cookie 不授予模型 API 权限。首次入口 URL 仍可能被访问日志记录。

模型故障降级仅在当前请求获授权的所有可用账号上原模型均不可用或受地区限制时触发；降级模型仍必须在密钥模型授权范围内，成功响应通过 `x-original-model` / `x-fallback-model` 告知切换。

### 长思考请求（十分钟等待）

`CB_UPSTREAM_HEADERS_TIMEOUT=600000`、`CB_UPSTREAM_STREAM_IDLE=600000`、`CB_REQ_BUDGET_MS=600000`。分别控制等响应头、连续无字节、请求到成功响应头的总预算；重试不会重置前置预算。输出开始后的总上限仍为 `CB_STREAM_MAX_MS=1800000`（30 分钟），避免持续正常输出在十分钟处被截断。客户端自行超时或上游主动断开不受这些参数控制。

HTTP dispatcher 已打包在 backend/http-dispatcher.cjs，无需 npm install；它关闭底层隐式的五分钟解析超时，由上述应用计时器接管。低时延管理接口原有短超时不变。反向代理若另行配置，应确保 read/send timeout 至少为 600 秒并关闭 SSE 缓冲。

### 完整备份与修复版

管理台导出及自动备份使用 version 2：包含账号凭据、当前账号、用量、签到、附加 API Key、外部服务商及其凭据、工作空间设置和轮换配置。备份包含明文凭据，请妥善保存。主密钥/环境变量和地理数据库不在文件内。

恢复兼容旧版备份，缺少的配置保留当前值。恢复前校验全部条目；格式错误拒绝整份文件。磁盘写入先暂存，提交失败时尝试回滚已写文件；这是运行中 I/O 失败保护，不保证主机断电期间的跨文件原子性。有模型请求或批量账号任务时返回 409，请稍后重试。

新建/编辑外部服务商地址默认 HTTPS，公网 HTTP 地址会被拒绝；本机或私网服务可显式写 http://。现有已保存地址不会自动改写。管理台配置上游属于管理员权限，不能将该接口开放给附加密钥。

新版前端为 Vue 3 构建产物，admin.html 是入口；请同时升级 admin-ui、backend 及 server.js。upgrade.sh 保留旧资源及回滚入口，勿仅替换 HTML。
