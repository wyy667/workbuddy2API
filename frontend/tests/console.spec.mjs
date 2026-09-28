import { test, expect } from "@playwright/test";
import fs from "node:fs";
async function chooseSelect(page,label,value) {
 await page.getByRole("combobox",{name:label}).click();
 await page.locator(`.ui-select-option[data-value="${value}"]`).click();
}
const pages = [
  "overview",
  "accounts",
  "tasks",
  "checkin",
  "usage",
  "logs",
  "models",
  "keys",
  "ext",
  "backup",
];
const labels = [
  "服务概览",
  "账号管理",
  "任务中心",
  "每日签到",
  "用量分析",
  "请求日志",
  "模型广场",
  "API 密钥",
  "多反代聚合",
  "备份恢复",
];
const screenshots = new URL("../test-results/screenshots/", import.meta.url);
test.beforeAll(() => fs.mkdirSync(screenshots, { recursive: true }));
test.beforeEach(async ({ request }) => {
  await request.post("/__reset");
});
async function open(page, id = "overview", key = "fixture") {
  await page.goto(`/admin?key=${key}#sec-${id}`);
  await expect(page.locator(".sync-state")).toContainText("已同步");
  await expect(page.locator("h1")).toBeVisible();
}
async function nav(page, id) {
  await page.locator(`.nav-link[href="#sec-${id}"]`).click();
  await expect(page.locator("h1")).toHaveText(labels[pages.indexOf(id)] + ".");
}
test("all ten pages render without errors, emoji, or desktop overflow", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  for (const id of pages) {
    await nav(page, id);
    await page.waitForTimeout(120);
    await expect(page.locator(".main-content")).toBeVisible();
    const emoji = await page
      .locator("body")
      .innerText()
      .then((t) => t.match(/\p{Extended_Pictographic}/gu) || []);
    expect(emoji, `${id}: emoji`).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      `${id}: overflow`,
    ).toBe(false);
    await page.screenshot({
      path: new URL(`${id}-light.png`, screenshots).pathname.replace(
        /^\/(\w:)/,
        "$1",
      ),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});
test("night mode, alternate palettes and mobile navigation", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "选择日间配色" }).click();
  await page.getByRole("button", { name: "熔岩与深海" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "lava");
  await page.screenshot({
    path: new URL("overview-lava.png", screenshots).pathname.replace(
      /^\/(\w:)/,
      "$1",
    ),
  });
  await page.getByRole("button", { name: "选择日间配色" }).click();
  await page.getByRole("button", { name: "帝王紫与柠檬" }).click();
  await page.screenshot({
    path: new URL("overview-violet.png", screenshots).pathname.replace(
      /^\/(\w:)/,
      "$1",
    ),
  });
  for (const [id, name] of [["lime", "青柠与炭黑"], ["lava", "熔岩与深海"], ["violet", "帝王紫与柠檬"], ["magenta", "甜酷粉与黑曜石"], ["neon", "霓虹蓝与电光紫"], ["mint", "冰薄荷与樱桃红"], ["cosmic", "晶石紫与电光荧"], ["electric", "霓虹赤与电光蓝"]]) {
    await page.getByRole("button", { name: "选择日间配色" }).click();
    await expect(page.locator(".palette-menu button")).toHaveCount(8);
    await page.getByRole("button", { name, exact:true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-palette", id);
    await page.screenshot({path:new URL(`palette-${id}.png`,screenshots).pathname.replace(/^\/(\w:)/,"$1")});
  }
  await page.getByRole("button", { name: "切换夜间模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page
      .locator("html")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
  ).toBe("rgb(11, 12, 11)");
  expect(
    await page.locator("h1").evaluate((e) => getComputedStyle(e).color),
  ).toBe("rgb(240, 241, 233)");
  await page.screenshot({
    path: new URL("overview-dark.png", screenshots).pathname.replace(
      /^\/(\w:)/,
      "$1",
    ),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of pages) {
    await page.getByRole("button", { name: "打开导航" }).click();
    await nav(page, id);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      id,
    ).toBe(false);
  }
  await page.getByRole("button", { name: "打开导航" }).click();
  await nav(page, "overview");
  await page.screenshot({
    path: new URL("overview-mobile-dark.png", screenshots).pathname.replace(
      /^\/(\w:)/,
      "$1",
    ),
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换日间模式" }).click();
  await page.screenshot({
    path: new URL("overview-mobile-light.png", screenshots).pathname.replace(
      /^\/(\w:)/,
      "$1",
    ),
    fullPage: true,
  });
});
test("key creation, permissions, disable and deletion honor API contracts", async ({
  page,
  request,
}) => {
  await open(page, "keys");
  await page
    .getByRole("button", { name: "创建密钥", exact: true })
    .first()
    .click();
  await page.getByLabel("密钥名称").fill("验收密钥");
  await page.getByLabel("每日请求上限").fill("200");
  await page.getByLabel("每日 Token 停用阈值").fill("300000");
  await page.getByLabel("每日积分停用阈值").fill("24.5");
  await page.getByRole("button", { name: "模型权限", exact: false }).click();
  await page
    .getByRole("checkbox", { name: "claude-sonnet-4.6", exact: true })
    .check();
  await page.getByRole("button", { name: "账号范围", exact: false }).click();
  await page.getByRole("checkbox", { name: /小懿的主账号/ }).check();
  await page
    .locator(".modal-footer")
    .getByRole("button", { name: "创建密钥" })
    .click();
  await expect(page.locator(".secret-reveal")).toHaveText(
    "sk-fixture-created-test",
  );
  await page.getByRole("button", { name: "完成", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "验收密钥" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "停用密钥" }).click();
  await expect(row).toContainText("已停用");
  await row.getByRole("button", { name: "删除密钥" }).click();
  await page
    .locator(".modal-footer")
    .getByRole("button", { name: "删除密钥" })
    .click();
  await expect(row).toHaveCount(0);
  const calls = await (await request.get("/__requests")).json();
  const call = calls.findLast((c) => c.path === "/keys/create");
  expect(call.body).toMatchObject({
    name: "验收密钥",
    dailyLimit: 200,
    dailyTokenLimit: 300000,
    dailyCreditLimit: 24.5,
    models: ["claude-sonnet-4.6"],
    accounts: ["uid00000"],
  });
});
test("accounts settings, health, tasks, checkin and connection details work", async ({
  page,
  request,
}) => {
  await open(page, "accounts");
  await page.getByRole("button", { name: "运行策略" }).click();
  await page.getByLabel("积分巡检间隔").fill("60");
  await page.getByRole("button", { name: "保存策略" }).click();
  await expect(page.locator(".toast-stack")).toContainText("轮换策略已保存");
  await chooseSelect(page, "选择体检模型", "gpt-5.4");
  await page.getByRole("button", { name: "体检所选模型" }).click();
  await expect(page.locator(".toast-stack")).toContainText("模型体检已完成");
  await nav(page, "tasks");
  await page.getByRole("button", { name: "扫描任务" }).click();
  await expect(page.getByText("与模型完成对话", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "领取奖励", exact: true }).click();
  await expect(page.getByText("执行结果", { exact: true })).toBeVisible();
  await nav(page, "checkin");
  await page.getByRole("button", { name: "全部账号立即签到" }).click();
  await page.getByRole("button", { name: "查询今日状态" }).click();
  await expect(page.getByText("已签到", { exact: true }).first()).toBeVisible();
  await nav(page, "ext");
  await page
    .getByRole("button", { name: "查看详情", exact: true })
    .first()
    .click();
  await expect(page.getByText("账户额度", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "刷新额度" }).click();
  await expect(page.getByText("8,400 积分", { exact: true })).toBeVisible();
  const calls = await (await request.get("/__requests")).json();
  expect(calls.findLast((c) => c.path === "/settings").body.pollMin).toBe(60);
  expect(
    calls.findLast((c) => c.path === "/checkup" && c.method === "POST").body
      .model,
  ).toBe("gpt-5.4");
});
test("provider creation persists mappings and protocol credentials", async ({
  page,
  request,
}) => {
  await open(page, "ext");
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await page.getByLabel("连接名称").fill("验收连接");
  await page.getByLabel("模型前缀").fill("acceptance");
  await page.getByLabel("上游 API 地址").fill("https://example.com/v1");
  await page
    .getByLabel("API Key", { exact: true })
    .fill("fixture-upstream-key");
  await page.getByLabel("指定模型").fill("model-a\nmodel-b");
  await page.getByLabel("模型名称映射").fill("alias = model-a");
  await page.getByRole("button", { name: "保存连接" }).click();
  await expect(page.getByText("验收连接", { exact: true })).toBeVisible();
  const calls = await (await request.get("/__requests")).json();
  expect(calls.findLast((c) => c.path === "/ext/save").body).toMatchObject({
    prefix: "acceptance",
    models: ["model-a", "model-b"],
    modelMap: { alias: "model-a" },
    key: "fixture-upstream-key",
  });
});
test("usage filters and server exports, SSE freeze and modal keyboard behavior", async ({
  page,
  request,
}) => {
  await open(page, "usage");
  const lines = page.locator(".line-chart .chart-line");
  const strokes = await lines.evaluateAll(nodes => nodes.map(n => getComputedStyle(n).stroke));
  expect(strokes.length).toBeGreaterThan(3);
  expect(new Set(strokes).size).toBe(strokes.length);
  await page.locator(".chart-legend button").nth(1).hover();
  await expect(lines.nth(1)).toHaveAttribute("stroke-width", "3.8");
  await expect(lines.nth(2)).toHaveAttribute("opacity", "0.16");
  await page.locator("h1").hover();

  await chooseSelect(page, "用量账号筛选", "uid00000");
  await chooseSelect(page, "用量模型筛选", "gpt-5.4");
  await page.getByRole("button", { name: "今日", exact: true }).nth(1).click();
  await expect(page.locator(".chart-note").first()).toContainText("小时采集");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前筛选" }).click();
  expect((await download).suggestedFilename()).toContain("usage-");
  await nav(page, "logs");
  await page.getByRole("button", { name: "冻结显示" }).click();
  await request.get("/__sse");
  await expect(
    page.getByText("live-fixture-event", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "继续更新", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("live-fixture-event", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("backup export and restore validates file and confirmation", async ({
  page,
  request,
}) => {
  await open(page, "backup");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载完整备份" }).click();
  expect((await downloading).suggestedFilename()).toContain("workbuddy-backup");
  await page.getByLabel("选择备份文件").setInputFiles({
    name: "restore.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        accounts: { "restore.json": { auth: { fixture: true } } },
      }),
    ),
  });
  await page.getByRole("button", { name: "恢复此备份" }).click();
  await expect(page.getByRole("dialog")).toContainText("1 个账号");
  await page
    .locator(".modal-footer")
    .getByRole("button", { name: "恢复备份" })
    .click();
  await expect(page.locator(".toast-stack")).toContainText("已恢复 1 个账号");
});
test("empty state and unauthorized response are explicit, never fabricated", async ({
  page,
}) => {
  await open(page, "overview", "empty");
  await expect(page.locator(".connection-count")).toContainText("00");
  for (const id of ["models", "accounts", "keys", "ext", "usage"]) {
    await nav(page, id);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  await page.goto("/admin?key=invalid");
  await expect(page.getByRole("alert")).toContainText("管理密钥无效");
  await expect(page.locator(".sync-state")).toContainText("连接异常");
});

test("OAuth QR authorization completes and modal traps focus", async ({
  page,
  request,
}) => {
  await open(page);
  await page.getByRole("button", { name: "连接账号", exact: true }).click();
  await chooseSelect(page, "账号区域", "intl");
  await page.getByRole("checkbox", { name: "仅用于签到" }).check();
  await page.getByRole("button", { name: "生成授权链接", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "账号授权二维码" }),
  ).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(
    page.getByRole("link", { name: "打开官方授权页" }),
  ).toHaveAttribute("href", "https://example.com/authorize?fixture=1");
  const close = page.getByRole("button", { name: "关闭弹窗", exact: true });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(
      () => document.activeElement.closest("[role=dialog]") !== null,
    ),
  ).toBe(true);
  await expect(page.getByText("连接成功", { exact: true })).toBeVisible({
    timeout: 8000,
  });
  await page.getByRole("button", { name: "开始使用" }).click();
  const calls = await (await request.get("/__requests")).json();
  expect(calls.find((c) => c.path === "/login/start").body).toEqual({
    site: "intl",
    checkinOnly: true,
  });
});

test("SSE clear survives refresh, failures are visible, all async buttons recover", async ({
  page,
}) => {
  await open(page, "logs");
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.getByRole("button", { name: "刷新当前数据" }).click();
  await expect(page.getByText("暂无请求记录", { exact: true })).toBeVisible();
  await nav(page, "overview");
  await page.route("**/admin/api/test*", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, message: "测试上游不可用" }),
    }),
  );
  await page.getByRole("button", { name: "连通测试", exact: true }).click();
  await expect(page.locator(".toast-stack")).toContainText("测试上游不可用");
  await expect(
    page.getByRole("button", { name: "连通测试", exact: true }),
  ).toBeEnabled();
  await page.route("**/admin/api/status?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "服务暂时离线" }),
    }),
  );
  await page.getByRole("button", { name: "刷新当前数据" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "当前显示上次成功同步的数据",
  );
});

test("slow initial load shows a skeleton, and malicious labels remain plain text without emoji", async ({
  page,
}) => {
  await page.route("**/admin/api/status?*", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    const response = await route.fetch();
    const data = await response.json();
    data.accounts[0].nickname = "<img src=x onerror=alert(1)>\u{1F680}";
    data.modelsDetail[0].name = "<script>alert(1)</script>\u{1F680}";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/admin?key=fixture#sec-accounts");
  await expect(
    page.getByRole("status", { name: "正在加载工作空间" }),
  ).toBeVisible();
  await expect(
    page.getByText("<img src=x onerror=alert(1)>", { exact: true }).first(),
  ).toBeVisible();
  expect(await page.locator("img[src=x]").count()).toBe(0);
  await nav(page, "models");
  await expect(
    page.getByRole("heading", {
      name: "<script>alert(1)</script>",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await page.locator("body").innerText()).match(
      /\p{Extended_Pictographic}/gu,
    ) || [],
  ).toEqual([]);
});

test("five native model brands load local SVG logos in both themes and filter correctly", async ({
  page,
}) => {
  await open(page, "models");
  for (const [id, brand] of [
    ["hy4-preview", "混元 Hunyuan"],
    ["glm-5.2", "GLM"],
    ["minimax-m3-pay", "MiniMax"],
    ["kimi-k3", "Kimi"],
    ["deepseek-v4.1-flash", "DeepSeek"],
  ]) {
    const card = page
      .locator(".model-card")
      .filter({ has: page.getByRole("heading", { name: id, exact: true }) });
    const logo = card.getByRole("img", { name: brand + " 标识" });
    await expect(logo).toHaveAttribute("src", /^\/admin-ui\/assets\/.+\.svg$/);
    expect(
      await logo.evaluate((img) => img.complete && img.naturalWidth > 0),
    ).toBe(true);
  }
  await page.screenshot({
    path: new URL("models-brands-light.png", screenshots).pathname.replace(
      /^\/(\w:)/,
      "$1",
    ),
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换夜间模式" }).click();
  await page.screenshot({
    path: new URL("models-brands-dark.png", screenshots).pathname.replace(
      /^\/(\w:)/,
      "$1",
    ),
    fullPage: true,
  });
  await page
    .locator(".model-vendor-filter")
    .getByRole("button", { name: /GLM/ })
    .click();
  await expect(page.locator(".model-card")).toHaveCount(1);
  await expect(page.locator(".model-card h3")).toHaveText("glm-5.2");
});
