<div align="center">

# WorkBuddy2API

**统一模型接口，一处管理账号、用量与请求。**

Node.js 后端 · Vue 3 管理台 · OpenAI 兼容接口 · SSE 流式输出

[部署指南](README-deploy.md) · [界面与功能](docs/PROJECT.md) · [前端开发](frontend/README.md) · [实时地图](backend/REQUEST-MAP.md)

</div>

![WorkBuddy2API 日间服务概览](docs/images/overview-light.png)

> 模型广场与任务中心为项目维护者提供的实际界面截图；服务概览、用量与地图图片使用隔离演示数据生成。模型目录和任务状态以实际账号与上游返回为准，截图不构成固定可用性、奖励或价格承诺。

## 项目介绍

WorkBuddy2API 将自己的 CodeBuddy / WorkBuddy 账号接入 OpenAI 兼容的聊天接口，并提供网页控制台。你可以集中管理多个账号、附加 API Key、外部模型服务商、用量统计和请求日志，也可以在兼容客户端中使用同一个 Base URL。

项目不是独立模型推理引擎，也不提供账号、积分或上游服务。模型目录、额度、能力和活动规则以实际账号与上游返回为准。请使用自己有权使用的账号，并遵守上游服务条款。

## 功能一览

| 模块 | 能力 |
| --- | --- |
| API 代理 | `GET /v1/models`、`POST /v1/chat/completions`；支持流式输出和非流式聚合 |
| 账号管理 | 登录入库、当前服务账号、账号切换、可配置轮换、凭据刷新和异常账号观察 |
| 请求调度 | 账号在途限制、总并发准入、重试与错误分类冷却；模型回退遵守密钥权限 |
| 密钥权限 | 附加 Key 可限制模型、账号、每日请求数及 Token / 积分阈值；没有管理台权限 |
| 用量与日志 | 模型 / 账号 / 日期筛选、趋势图、缓存用量、请求明细与导出 |
| 全自动任务与签到 | 自动接受支持的成长任务、执行并回查领奖；全账号任务队列、一键日常、定时签到 |
| 多反代聚合 | 自定义 OpenAI 兼容服务，以及 OpenCode、Trae、Qoder 适配入口 |
| 完整备份 | 账号、用量、签到、附加 Key、外部服务商、设置及轮换配置；兼容旧备份 |
| 实时请求地图 | 可选 SVG 地图，仅显示活动请求；支持拖动、缩放、全屏和脱敏详情 |
| 管理界面 | Vue 3、八套日间配色、黑色夜间模式、响应式布局、SVG 图标与按需加载 |

外部协议适配器受上游变化影响，各客户端的工具调用或扩展字段支持也可能不同；不能将“OpenAI 兼容”理解为完整实现所有 OpenAI API。

## 核心特色：全自动任务中心

**从接受任务、自动执行到进度回查与领奖，在管理台中完成整套流程。** 全自动任务是本项目重点打造的特色能力：既能对单项支持的任务点击“自动完成”，也能启动“全账号执行任务”，由服务器逐账号处理，无需守着页面逐项操作。

![任务中心：成长任务进度、奖励与自动完成入口](docs/images/tasks-center.png)

- **单项自动完成**：扫描当前账号任务，查看进度、积分和能量奖励，对支持的任务直接执行；已达标且可领取的任务直接领奖。
- **全账号执行任务**：批量接受任务，逐项执行已适配的任务动作，回查进度并尝试领取奖励，展示各步骤结果。
- **全账号一键日常**：串联签到与已适配的日常活动流程，减少账号间反复切换。
- **服务器后台队列**：离开任务页面后继续执行，返回即可查看队列进度与步骤反馈；服务重启会中断内存中的队列。

“全自动”指已适配任务的执行流程，不代表所有上游活动都能自动完成。需要人工操作、尚未适配或账号未解锁的任务不会因此变成可自动执行；实际达标和奖励以上游回查为准。部分任务会发起真实模型请求或活动操作，可能消耗账号额度。

[查看任务中心操作说明 →](docs/PROJECT.md#全自动任务中心)

## 界面预览

### 黑色夜间模式

![黑色夜间模式](docs/images/overview-dark.png)

### 模型广场与用量分析

| 模型广场 | 用量分析 |
| --- | --- |
| ![模型广场](docs/images/models.png) | ![用量分析](docs/images/usage.png) |

### 实时请求地图

![活动请求地图](docs/images/request-map.png)

绿色流星只是活动请求示意，**不是网络包的真实位置或传输路径**。位置基于本地 IP 库估算，详情显示模型、时长、请求 IP、密钥名称与脱敏 Key，不采集地图用的输入 Token。关闭全局开关会停用追踪并释放定位 worker；地理库缺失不阻塞模型调用。

[查看更多配色、页面介绍和架构说明 →](docs/PROJECT.md)

## 快速部署

首次部署脚本适用于 **Linux + systemd**，需要 root 权限。运行环境为 **Node.js 22+**。仓库已包含构建后的管理台，无需先构建前端。

```bash
git clone https://github.com/wyy667/workbuddy2API.git
cd workbuddy2API
sudo bash setup-server.sh
```

脚本会检查 / 安装 Node.js、安装 CodeBuddy CLI，将程序放入 `/opt/codebuddy-proxy`，生成主密钥并建立 `codebuddy-proxy` 服务。**它会修改系统软件和 systemd 配置；已有部署应使用升级脚本。**

1. 保存脚本输出的主密钥。
2. 在可信网络中打开 `http://YOUR_SERVER_IP:8787/admin?key=YOUR_MASTER_KEY`。
3. 在管理台连接自己的账号，按登录流程完成授权。
4. 从模型广场选择实际可用的模型，在“API 密钥”中新建客户端专用 Key。
5. 客户端填写 Base URL `http://YOUR_SERVER_IP:8787/v1` 与附加 Key。公网使用时建议配置 HTTPS。

主密钥拥有管理权限，不要当作分享密钥。首次 URL 登录可能留在浏览器历史或代理访问日志中；进入页面后地址栏会移除密钥，后续使用管理会话。

**[完整部署指南：首次安装、手动运行、HTTPS、升级、回滚、备份和排障](README-deploy.md)**

## API 示例

先在自己的终端设置环境变量，示例不包含有效凭据：

```bash
export WORKBUDDY_BASE_URL='https://api.example.com/v1'
export WORKBUDDY_API_KEY='YOUR_ADDITIONAL_API_KEY'
export WORKBUDDY_MODEL='MODEL_ID_FROM_YOUR_MODEL_LIST'

curl "$WORKBUDDY_BASE_URL/models" \
  -H "Authorization: Bearer $WORKBUDDY_API_KEY"

curl -N "$WORKBUDDY_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $WORKBUDDY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$WORKBUDDY_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"stream\":true}"
```

默认允许等待上游响应 **10 分钟**、连续无数据 **10 分钟**；成功响应后的流式总时长上限为 **30 分钟**。客户端、上游和反向代理也可能有独立超时，配置见部署指南。

## 开发与验证

```bash
# 后端模块测试与隔离回归
node --test backend/tests/*.test.cjs
node backend/tests/regression.cjs

# 前端
cd frontend
npm ci
npm run build
npm test
npm run test:e2e
```

浏览器测试需要可用的 Chrome，见 [前端文档](frontend/README.md)。前端构建会更新根目录 `admin.html` 和 `admin-ui/`；上线时必须与 `server.js`、`backend/`、`ext-assets.js` 一起部署。

## 数据与运行边界

- 账号和服务商凭据存储在自己的服务器，完整 JSON 备份包含敏感数据，请妥善保存。
- 主密钥、环境变量和地理数据库不进入管理台备份；地理库由服务按配置下载。
- 配额预占、账号租约及活动请求状态在单进程内管理。不要直接启用多实例 / PM2 cluster 来共享同一数据目录。
- 请求数按入站预占；Token / 积分按上游实际返回结算，属于结算后阈值，单次请求可能超过阈值。
- 部分统计采用合批持久化，强制断电可能丢失最后一批。恢复具备运行中写入失败回滚，但不保证断电下的跨文件原子性。

## 项目结构

```text
server.js                 Node HTTP 服务、管理接口与上游适配
backend/                  请求、配额、持久化、地理查询等模块
frontend/src/             Vue 3 管理台源码
admin.html + admin-ui/    可直接部署的前端构建产物
ext-assets.js             内置适配器资源
setup-server.sh           首次部署
upgrade.sh                保留数据的程序升级与回滚
README-deploy.md           部署与维护指南
docs/                     图文介绍和演示截图
```

## 许可与第三方资源

目前尚未选择项目级许可证；公开仓库不等于授予任意再分发或商用权限。第三方资源保留各自许可，见 [前端资源许可](frontend/licenses/)、[Undici 许可](backend/vendor-source/UNDICI-LICENSE) 和 [地图说明](backend/REQUEST-MAP.md)。品牌图标仅用于识别对应服务，不表示官方关联或背书。
