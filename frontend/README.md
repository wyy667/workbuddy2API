# WorkBuddy Console · Vue 3

新版管理台源码。构建产物为根目录的轻量 `admin.html` 与 `admin-ui/` 静态资源目录，沿用现有 Node 服务、管理密钥和 `/admin/api` 接口。

## 开发与构建

建议使用 Node.js 22 或 24。在本目录执行：

```sh
npm ci
npm run dev
```

开发地址 `http://127.0.0.1:5173/admin-ui/admin?key=你的管理密钥`。Vite 将 `/admin/api` 代理到 `http://127.0.0.1:8787`；需要先启动已有后端。后端地址可用环境变量 `API_TARGET` 改写。

```sh
npm run build
```

构建会生成 `dist/index.html` 并发布到项目根目录 `admin.html`。脚本、样式、SVG 标识和字体独立打包，无 CDN 依赖；地图以异步模块加载，关闭时不下载。带内容哈希的静态资源启用长期缓存和预压缩，升级时保留旧哈希以兼容已打开页面和回滚。中文使用系统字体。Manrope 使用 SIL OFL 1.1，完整许可保存在 `licenses/Manrope-OFL.txt` 并随 `admin-ui/Manrope-OFL.txt` 一并提供。

请一并部署根目录 `server.js`、`admin.html`、`admin-ui/`、`ext-assets.js` 和 `backend/`（包括 `.cjs` 模块与 `project-version.json`）。服务启动时会读取管理台 HTML，因此替换后需要重启已有服务。升级脚本可直接使用；不需要在生产服务器安装前端依赖。

## 验证

```sh
npm test
npm run test:e2e
```

单元测试验证日期区间、小时缺口、用量筛选、CSV、防注入文本及品牌识别。后端测试在系统临时目录启动隔离服务，拦截上游网络，验证实际管理鉴权与密钥保留逻辑，不读取工作区账号或配置。

Playwright 使用本机 Chrome，自动启动端口 8950 的隔离模拟 API，覆盖十个页面、桌面/手机、三种配色、黑色主题、账号授权、密钥、任务、签到、用量、日志流、反代配置及备份。截图输出在 `test-results/screenshots/`。如需使用 Playwright 自带 Chromium，可调整 `playwright.config.js` 的 channel 并自行准备浏览器。

## 无真实账号预览

```sh
npm run fixture
```

打开 `http://127.0.0.1:8950/admin?key=fixture`。这是明确隔离的演示数据，只监听本机，不连接真实上游，不发送真实签到或任务。无数据预览使用 `?key=empty`。`npm run preview` 仅预览构建静态文件，实际 API 联调请使用上述开发代理或现有后端。

## 源码结构

- `src/App.vue`：导航、主题、移动端抽屉、全局快捷键。
- `src/pages/`：十个业务页面。
- `src/components/`：表格、图表、异步按钮、弹窗与品牌标识。
- `src/store.js`：API、刷新与 SSE 生命周期、操作确认、通知。
- `src/analytics.js`：统计计算与时间区间。
- `src/assets/models/`：用户项目与混元官网的原始 SVG，附来源记录。
- `src/style.css` / `src/pages.css`：设计变量、主题、响应式与动效。
- `MIGRATION.md`：功能迁移清单和验证边界。

日间支持八套撞色方案，完整配色和截图见 [项目图文介绍](../docs/PROJECT.md)。夜间固定黑色底。尊重系统减少动画偏好，支持键盘焦点、弹窗焦点约束及加载/失败/空状态。界面不使用 Emoji，后台动态显示文本也会清理 Emoji。

## 文档截图

在仓库根目录运行 `node frontend/scripts/capture-docs.mjs`，使用隔离演示数据生成 `docs/images/` 中的五张预览图。模型广场 `models.png` 和任务中心 `tasks-center.png` 使用维护者提供的实际截图，脚本不会覆盖。脚本使用 Playwright Chromium；首次可在 frontend 目录执行 `npx playwright install chromium`。常规 E2E 配置使用系统 Chrome。
