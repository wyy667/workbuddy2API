import { test, expect } from "@playwright/test";
import fs from "node:fs";
test.beforeEach(async ({ request }) => {
  await request.post("/__reset");
});
test.beforeAll(() =>
  fs.mkdirSync("test-results/screenshots", { recursive: true }),
);
test("task account custom menu uses keyboard selection and sends the selected identity", async ({
  page,
  request,
}) => {
  await page.goto("/admin?key=fixture#sec-tasks");
  const control = page.getByRole("combobox", { name: "选择任务账号" });
  await expect(control).toContainText("当前服务账号");
  await control.click();
  await expect(page.getByRole("option")).toHaveCount(5);
  await page.screenshot({
    path: "test-results/screenshots/task-account-menu.png",
    fullPage: true,
  });
  await control.press("ArrowDown");
  await control.press("Enter");
  await expect(control).toContainText("小懿的主账号");
  await page.getByRole("button", { name: "扫描任务", exact: true }).click();
  await expect
    .poll(async () =>
      (await (await request.get("/__requests")).json()).some(
        (r) => r.path === "/tasks/list" && r.query.id === "account-0.json",
      ),
    )
    .toBe(true);
  await control.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(control).toBeFocused();
  expect(await page.locator("select").count()).toBe(0);
});
test("large custom lists search and numeric strategy values retain their types", async ({
  page,
  request,
}) => {
  await page.goto("/admin?key=fixture#sec-accounts");
  await page.getByRole("combobox", { name: "选择体检模型" }).click();
  await page.getByRole("textbox", { name: "搜索选项" }).fill("gpt-5.4");
  await page.getByRole("option", { name: "gpt-5.4", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "选择体检模型" }),
  ).toContainText("gpt-5.4");
  await page.getByRole("button", { name: "运行策略" }).click();
  await page.getByRole("combobox", { name: /定时轮换/ }).click();
  await page.getByRole("option", { name: "每 60 分钟", exact: true }).click();
  await page.getByRole("button", { name: "保存策略" }).click();
  await expect
    .poll(async () => {
      const calls = await (await request.get("/__requests")).json();
      return calls.findLast((r) => r.path === "/rotation/set")?.body
        .intervalMin;
    })
    .toBe(60);
});
test("meteor remains visible under reduced motion, thin line hover works and dragging selects no text", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/admin?key=fixture#sec-overview");
  const map = page.locator(".request-map");
  await map.scrollIntoViewIfNeeded();
  await expect(map.locator(".map-route")).toHaveCount(5);
  const head = map.locator(".map-meteor-head").first();
  await expect(head).toBeVisible();
  const before = await head.getAttribute("transform");
  await page.waitForTimeout(220);
  expect(await head.getAttribute("transform")).not.toBe(before);
  expect(
    await map
      .locator(".map-route-base")
      .first()
      .evaluate((el) => getComputedStyle(el).strokeWidth),
  ).toBe("0.65px");
  const point = await map
    .locator(".map-hit")
    .first()
    .evaluate((el) => {
      const p = el.getPointAtLength(el.getTotalLength() * 0.5),
        q = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM());
      return { x: q.x, y: q.y };
    });
  await page.mouse.move(point.x, point.y);
  await expect(map.locator(".map-detail")).toBeVisible();
  await page.mouse.move(point.x - 90, point.y + 80);
  await expect(map.locator(".map-detail")).toHaveCount(0);
  const box = await map.locator(".map-canvas").boundingBox();
  await page.mouse.move(box.x + 15, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 150, { steps: 15 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection().toString())).toBe("");
  await expect(map.locator(".map-navigation-hint")).toContainText("自由浏览");
  await map.getByRole("button", { name: "暂停流星动画" }).click();
  await page.waitForTimeout(100);
  const paused = await head.getAttribute("transform");
  await page.waitForTimeout(200);
  expect(await head.getAttribute("transform")).toBe(paused);
  await map.getByRole("button", { name: "播放流星动画" }).click();
});
test("global disable unmounts SVG, stops stream reconnects and persists on reload", async ({
  page,
  request,
}) => {
  await page.goto("/admin?key=fixture#sec-overview");
  const map = page.locator(".request-map");
  await map.scrollIntoViewIfNeeded();
  await map.getByRole("button", { name: "关闭地图并释放内存" }).click();
  await expect(map).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开启地图" })).toBeVisible();
  const count = async () =>
    (await (await request.get("/__requests")).json()).filter(
      (r) => r.path === "/request-map/live",
    ).length;
  const before = await count();
  await page.waitForTimeout(3500);
  expect(await count()).toBe(before);
  await page.reload();
  await expect(page.locator(".map-disabled-panel")).toBeVisible();
  await expect(page.locator(".map-svg")).toHaveCount(0);
  await page.getByRole("button", { name: "开启地图" }).click();
  await expect(page.locator(".map-route")).toHaveCount(5);
});
