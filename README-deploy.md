# 部署与维护指南

[项目首页](README.md) · [图文介绍](docs/PROJECT.md) · [地图配置](backend/REQUEST-MAP.md)

本文对应当前 Node.js 后端和 Vue 3 管理台。首次部署用 `setup-server.sh`，已有服务升级用 `upgrade.sh`。不要仅上传 `admin.html`：它只是入口，页面还依赖 `admin-ui/` 中的脚本、样式、字体和地图资源。

## 1. 部署前准备

| 项目 | 要求 |
| --- | --- |
| 一键脚本环境 | Linux、systemd、root 权限；自动安装 Node 的分支支持 apt-get / yum |
| 运行时 | Node.js 22 或更新版本 |
| 下载工具 | Git、curl、OpenSSL；安装依赖和可选地理库需要出站网络 |
| 账号 | 自己有权使用的 CodeBuddy / WorkBuddy 账号，或自己配置的外部服务 |
| 存储 | 程序目录及运行数据目录可写；地理库首次下载需预留额外磁盘和内存 |
| 端口 | 默认 8787，可在首次安装时指定；公网使用建议通过 HTTPS 反向代理 |

无地图时资源消耗较低；开启地图会加载本地 City 库，下载解压和更新期间还有额外开销。请根据并发、上下文和库体积观察实际资源占用，不把固定最低配置当作容量保证。

仓库已经包含可运行的前端构建产物，普通部署不需要 `npm ci`。自动安装脚本还会安装 `@tencent-ai/codebuddy-code` CLI；CLI 不是这个项目的模型推理引擎。

## 2. 首次安装：Linux + systemd

以拥有 sudo 权限的用户执行：

```bash
git clone https://github.com/wyy667/workbuddy2API.git
cd workbuddy2API
sudo bash setup-server.sh
```

如需首次指定端口：

```bash
sudo env PORT=8787 bash setup-server.sh
```

脚本会：

1. 检查 Node.js 版本，必要时通过 NodeSource 安装 Node.js 22。
2. 安装 CodeBuddy CLI。
3. 把程序复制到 `/opt/codebuddy-proxy`。
4. 在 `.env` 不存在时生成主密钥，写入权限为 `600` 的环境文件；已有 `.env` 保留。
5. 创建并启动 `codebuddy-proxy.service`，设置开机启动。

脚本会修改系统软件和 systemd 配置，请先阅读源码。安装结束时保存输出的主密钥，不要把终端输出截图公开。

```bash
sudo systemctl status codebuddy-proxy --no-pager
curl --fail http://127.0.0.1:8787/health
```

`/health` 正常表示 HTTP 服务运行，并不保证账号已登录或某个上游模型一定可用。

## 3. 登录与客户端接入

首次打开：

```text
http://YOUR_SERVER_IP:8787/admin?key=YOUR_MASTER_KEY
```

- 在“账号管理”连接自己的账号，按管理台给出的链接或二维码完成授权。
- 在“模型广场”确认当前可用模型。
- 在“API 密钥”创建附加 Key，按需设置模型、账号和用量限制。
- 客户端填写 Base URL `https://api.example.com/v1`、附加 Key 和实际模型 ID。

主 Key 可访问管理接口；附加 Key 仅用于模型 API。首次登录后页面会清除地址栏 Key，管理请求使用请求头或 HttpOnly Cookie。初始 URL 仍可能被浏览器历史及访问日志记录，建议仅在受信任环境中使用管理入口。

如果账号登录回调使用的访问地址不通，应先检查域名、端口、反向代理和上游授权页面，不要反复导入未知来源的凭据。

## 4. 手动运行：不使用安装脚本

已有 Node.js 22+ 时，可直接从完整仓库启动。下面的参数值均为示例。

Linux / macOS：

```bash
export HOST=127.0.0.1
export PORT=8787
export CB_API_KEY='REPLACE_WITH_A_LONG_RANDOM_SECRET'
node server.js
```

Windows PowerShell：

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '8787'
$env:CB_API_KEY = 'REPLACE_WITH_A_LONG_RANDOM_SECRET'
node .\server.js
```

`node server.js` 不自动读取 `.env`。如自己准备了环境文件，可使用 Node 的 `node --env-file=.env server.js`；systemd 部署则由 `EnvironmentFile` 加载文件。绑定 `0.0.0.0` 等非回环地址必须配置主 Key。

不要将演示 fixture 当作生产服务，也不要用 Vite 开发服务器对外承载管理台。

## 5. HTTPS 与反向代理

已有 Nginx 和有效证书时，可参考下列站点片段。替换域名和证书路径后执行 `nginx -t`，验证成功再重载 Nginx。以下不包含证书申请与 DNS 配置。

```nginx
server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate     /etc/nginx/certs/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/api.example.com/privkey.pem;

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-Proto $scheme;
        # Single trusted edge: discard client-supplied forwarding information.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 660s;
        proxy_send_timeout 660s;
    }
}
```

这里的 660 秒为两次网络读写之间的等待，不是整条 SSE 的总时长；比应用的十分钟空闲限制略宽。SSE 不需要 WebSocket Upgrade。CDN、网关和客户端仍可能有独立限制，不能只改 Node 参数。

使用同机 Nginx 时，建议在 `/opt/codebuddy-proxy/.env` 设置 `HOST=127.0.0.1`，然后重启服务；只对外开放 HTTPS 端口。地图需要识别真实客户端 IP 时，还要显式设置信任代理，例如：

```dotenv
CB_TRUSTED_PROXIES=127.0.0.1/32,::1/128
```

只填写实际受控代理地址，不能直接信任所有来源。多级代理链应按实际网络拓扑配置。[详细规则](backend/REQUEST-MAP.md)

## 6. 关键环境变量

安装脚本使用 `/opt/codebuddy-proxy/.env`。修改后执行 `sudo systemctl restart codebuddy-proxy`。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOST` | 手动运行 `127.0.0.1`；安装脚本写 `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | HTTP 监听端口 |
| `CB_API_KEY` | 无 | 主密钥，管理台及模型 API 鉴权 |
| `CB_AUTH_FILE` | 自动查找 | 显式凭据文件路径 |
| `CB_REQ_BUDGET_MS` | `600000` | 收到请求到成功上游响应头的总预算，包含选号、刷新和重试 |
| `CB_UPSTREAM_HEADERS_TIMEOUT` | `600000` | 单次上游响应头等待上限 |
| `CB_UPSTREAM_STREAM_IDLE` | `600000` | 上游连续无字节的空闲上限 |
| `CB_STREAM_MAX_MS` | `1800000` | 成功上游响应后的流式总时长上限；`0` 表示不设此上限 |
| `CB_MAX_BODY_MB` | `16` | 聊天请求体大小上限 |
| `CB_MAX_INFLIGHT` | `128` | 模型请求准入上限，超出返回 429 |
| `CB_ACCT_MAX_INFLIGHT` | `4` | 单账号并发上限 |
| `CB_ORIGIN_IP` | 自动识别 | 可选源站公网 IP，供地图展示 |
| `CB_TRUSTED_PROXIES` | 空 | 允许读取转发链的受信任代理 CIDR |
| `CB_GEO_DISABLED` | 未启用 | `1` 禁用定位进程和出口检测 |
| `CB_GEO_AUTO_UPDATE` | 开启 | `0` 禁用地理库自动下载与更新 |
| `CB_GEO_DB` | `data/dbip-city-lite.mmdb` | 自定义地理库路径 |

更多运行参数以 `server.js` 顶部注释和实际配置常量为准。十分钟设置只是本代理的等待窗口，无法延长客户端已取消或上游已关闭的连接。

## 7. 地图与数据库

地理库不随仓库或分享包分发。定位功能启用时，worker 按配置自动下载和更新 DB-IP City Lite；也可从项目目录执行 `node backend/geo-worker.cjs` 预安装，检查输出是否就绪。

- 首次下载可能较慢，页面先显示定位状态；不会阻塞正常聊天。
- `data/` 必须允许服务用户写入，已有库会保留，更新失败保留旧库。
- 页面右上角的地图全局开关关闭时，会释放定位 worker 和数据库缓存。
- IP 库不保证真实物理位置，代理和 NAT 常定位到出口地址。
- 定位查询在本地执行，不把请求 IP 发送给第三方；库下载和出口探测仍需要出站网络。

## 8. 升级现有服务

管理台导航最下方的 **workbuddy2API** 分类提供项目 GitHub 链接、当前安装版本与“检查更新”。只有点击检查时，服务器才访问 GitHub 主分支的 `backend/project-version.json`，与本地语义版本比较；结果缓存一分钟。检查失败会明确提示，不会误报为最新版。它不会自动安装或重启服务，发现新版本后按本节升级。

版本文件必须随 `backend/` 一起部署。发布程序更新时维护者需同步递增 `backend/project-version.json` 和前端包版本，再重新构建；仅修改文档不会触发新版本提示。

在最初克隆的源码目录更新，而不是在运行数据目录强行覆盖：

```bash
cd /path/to/workbuddy2API
git pull --ff-only
sudo bash upgrade.sh
```

如果本地有自己的代码改动，先审查并合并，不要用强制重置覆盖。如果选择手动上传，必须包含完整程序资源：

```bash
# 先在服务器上创建 /root/cb-update
scp -r upgrade.sh server.js admin.html admin-ui ext-assets.js backend \
  root@YOUR_SERVER_IP:/root/cb-update/

# 登录服务器后执行
cd /root/cb-update
bash upgrade.sh
```

升级脚本会校验模块、备份旧程序与配置快照、先安装带哈希的静态资源，再替换入口并重启，最后检查健康状态。它保留运行中的账号、密钥、统计和配置，不把新包当成空数据覆盖。

**升级会重启服务，正在进行的请求可能中断，请选空闲时段执行。** 浏览器仍显示旧界面时可强制刷新；脚本保留旧哈希资源，便于旧页面与回滚使用。

自定义安装路径或服务名时：

```bash
sudo env INSTALL_DIR=/your/install/path SERVICE=your-service bash upgrade.sh
```

此覆盖仅适用于升级脚本；首次安装脚本默认固定安装到 `/opt/codebuddy-proxy`。

## 9. 回滚

升级成功后终端会输出实际备份目录和回滚命令，例如：

```bash
sudo bash /opt/codebuddy-proxy/.upgrade-backup-YYYYMMDD-HHMMSS/rollback.sh
```

请使用实际存在的目录，不要直接复制占位时间。回滚脚本恢复程序后重启，不自动恢复历史数据快照，避免覆盖升级后已刷新的登录凭据。

回滚到不支持管理会话 Cookie 的旧版本时，可能需要重新使用该版本的主密钥入口登录。

## 10. 备份与恢复

管理台“备份恢复”支持下载完整 JSON，以及在服务器生成自动备份。新版 `version: 2` 包含：

- 账号存档及当前账号凭据；
- 用量统计与签到状态；
- 附加 API Key、权限及记录的用量；
- 外部服务商、模型映射和服务商凭据；
- 工作空间设置与轮换配置。

主密钥、`.env`、systemd / Nginx 配置和地理库不包含其中，跨服务器迁移需另行安全保存或重新配置。下载文件包含明文敏感凭据，不要提交到 GitHub 或发送到公开群聊。

恢复会先校验整个文件。非法文件名、账号结构或配置会被拒绝；有模型请求或批量账号任务时会返回 409。写入先暂存，提交出错时尝试回滚已写文件，但不保证主机断电情况下跨文件原子性。

旧备份可导入，未包含的配置保留当前值。同名账号被覆盖，备份未列出的已有账号不会因此删除。建议迁移后再次检查模型权限、定时任务和客户端连通性。

## 11. 排障速查

| 现象 | 优先检查 |
| --- | --- |
| 管理台 401 | 主 Key 是否正确；附加 Key 不能进入管理台；更换主 Key 后重新登录 |
| 页面空白 / 静态资源 404 | 是否同时部署 `admin.html` 和 `admin-ui/`；路径与反向代理是否保留 `/admin-ui/` |
| 长思考仍被截断 | 客户端、CDN、Nginx 的独立超时；应用实际环境变量；上游是否主动报错 |
| 返回 429 | 总并发、单账号并发、密钥配额、账号 / 模型冷却状态 |
| 日志有磁盘写入失败 | 磁盘空间、目录权限、systemd 的 `ReadWritePaths`；不要忽略统计未落盘告警 |
| 地图没有定位 | 全局开关、库下载状态、目录写权限、IP 是否内网 / 保留地址 |
| 地图内存偏高 | 关闭地图全局开关，或禁用定位；观察 worker 与主进程分别占用 |
| 恢复返回 400 / 409 | 文件结构是否有效；是否有活动请求或批量账号任务 |
| 自定义服务商保存失败 | 默认使用 HTTPS；公网 HTTP 被拒绝；本机 / 私网需显式写 HTTP；不能含 URL 用户信息、查询或锚点 |

常用命令：

```bash
sudo systemctl status codebuddy-proxy --no-pager
sudo journalctl -u codebuddy-proxy -n 100 --no-pager
curl --fail http://127.0.0.1:8787/health
sudo systemctl restart codebuddy-proxy
```

查看日志和配置时避免公开完整 Key、token 或账号信息。健康接口正常后，仍应使用自己的客户端验证实际模型调用。

## 12. 开发和验证

```bash
node --test backend/tests/*.test.cjs
node backend/tests/regression.cjs
cd frontend
npm ci
npm run build
npm test
npm run test:e2e
```

浏览器测试使用隔离 fixture；后端回归使用模拟上游，不代表真实上游所有模型已测试。前端开发详见 [frontend/README.md](frontend/README.md)。随包 HTTP dispatcher 的版本、许可、构建与审计命令见 [backend/vendor-source/README.md](backend/vendor-source/README.md)。
