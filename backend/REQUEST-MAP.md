# 实时请求地图

管理台服务概览底部的 Vue / SVG 地图只显示通过鉴权、校验和额度预留后的活动模型请求。原生、Custom、OpenCode、Trae、Qoder 共用入口；请求结束、响应关闭和 AbortSignal 都幂等清理。模块不收集输入 token、消息正文或完整密钥，也不新增历史请求日志。

## 部署与地理库

与其他运行时一起部署 `server.js`、`admin.html`、`admin-ui/`、`ext-assets.js`、所有 `backend/*.cjs`。服务器无需 npm install；`geo-ip.cjs` 和 `geo-worker.cjs` 已包含所需依赖及许可证。源码修改后在 `frontend` 执行 `npm ci`、`npm run build:geo`、`npm run build`。

DB-IP City Lite 的 CC BY 4.0 数据在 `data/dbip-city-lite.mmdb`，未提交到源码。首次启动 worker 自动下载安装；以后每天检查官方月度版本。下载限时、限大小，使用 HTTPS，校验官方解压后文件 SHA1，验证 MMDB 元数据，然后同文件系统原子替换。更新失败保留旧库；无库仅地图不能定位，模型调用正常。服务用户必须能写 `data/`。额外常驻内存约为地理库大小加 reader 缓存，更新时短暂同时持有新旧库。

可预安装：在项目目录执行 `node backend/geo-worker.cjs`，检查输出 `ready: true` 后再启动服务。只手动更新时可关闭自动更新。已有文件不会因为前端升级而覆盖。

配置：

| 环境变量 | 默认与含义 |
| --- | --- |
| `CB_ORIGIN_IP` | 可选，明确指定源站公网 IPv4 / IPv6。缺省优先唯一公网网卡地址，否则 HTTPS 查询本机公网出口；出口标注为“公网出口”。 |
| `CB_TRUSTED_PROXIES` | 缺省为空。逗号分隔可信代理 CIDR；仅当直接连接方可信时，从右向左检查 X-Forwarded-For，停在首个不可信地址。不配置时忽略转发头。 |
| `CB_GEO_DB` | 可选，地理数据库绝对路径，缺省项目 `data/dbip-city-lite.mmdb`。 |
| `CB_GEO_AUTO_UPDATE` | 缺省开启；`0` 关闭自动下载和更新。 |
| `CB_GEO_DISABLED` | 缺省关闭；`1` 禁用定位进程和公网出口检测，适合离线测试。 |

查询在 worker 中本地执行。客户端 IP 不发送给第三方；出站流量仅下载库、检查版本或识别本机公网出口。IP 的真实物理位置不能保证；有省州数据时展示省州级估算，否则降级；内网、保留地址及未知地址不伪造坐标。国家名称优先中文，中国省份补充固定中文名称映射。

## 管理接口

以下接口都沿用主密钥管理鉴权，附加密钥不可访问，响应不可缓存：

- `GET /admin/api/request-map`：`instance`、单调 `seq`、`now`、`origin`、`database`、`requests` 快照，同时返回 `enabled`。
- `GET /admin/api/request-map/live`：独立 SSE，先发 `snapshot`，后发 `upsert`、`remove`、`origin`，每 15 秒 `heartbeat`。关闭时推送 `disabled` 并断开。最多 32 个订阅者，慢客户端有界断开，前端重连并每 10 秒对账。

请求字段为 `id, startedAt, ip, model, stream, keyName, keyMasked, location, locationStatus`。密钥信息来自已鉴权上下文。长 Key 显示前五后四；不足十二位只显示末两位，只有一两位时全部遮盖。主密钥名称固定“主密钥”。数据库信息只包含就绪状态、版本时间及可读错误，不暴露本地路径。

- `POST /admin/api/request-map/settings`：`{"enabled":false}` 关闭或 `true` 开启。配置持久化到 `settings.json` 的 `requestMapEnabled`，影响所有管理端。关闭会终止定位 worker、释放数据库及缓存、停用追踪与后台更新，并卸载浏览器地图组件。重新开启只追踪随后新发起的请求。写盘失败返回 503，保留原状态。

## 地图和维护

地图由 Natural Earth 公共领域国家及省州数据简化而来，已打包为管理台异步资源，无瓦片请求。重建运行 `python frontend/scripts/build-map.py`（需要 requests）；来源和校验值见 `frontend/licenses/Natural-Earth.json`。页面持续显示 DB-IP 和 Natural Earth 链接。

静态边界与活动流星分为独立 SVG 渲染层，单一 requestAnimationFrame 更新头部与渐隐尾迹。支持日期变更线最短路线、同点局部环线、手动/自动镜头、键盘详情、鼠标拖动缩放、触摸双指缩放、浏览器全屏及视口全屏后备。响应结束最多 220ms 淡出，断线隐藏流星。离屏停止更新，隐藏页面或离开概览关闭订阅及动画，系统减少动态效果时放慢流星并停用镜头过渡；地图右上角可单独暂停流星，保留静态轨迹。

测试：`node --test backend/tests/*.test.cjs`、`node backend/tests/regression.cjs`；在 frontend 执行 `npm test` 和 `npm run test:e2e`。隔离测试必须设置 `CB_GEO_DISABLED=1` 或传入假的定位服务，避免后台下载。`FIXTURE_PORT` 可指定独立浏览器测试端口。
