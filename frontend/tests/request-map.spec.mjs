import { test, expect } from "@playwright/test";
import fs from "node:fs";
test.beforeAll(() =>
  fs.mkdirSync("test-results/screenshots", { recursive: true }),
);
test.beforeEach(async ({ request }) => {
  await request.post("/__reset");
});
async function open(page) {
  await page.goto("/admin?key=fixture#sec-overview");
  const map = page.locator(".request-map");
  await map.scrollIntoViewIfNeeded();
  await expect(map.locator(".map-route")).toHaveCount(5);
  return map;
}
test("real snapshot, masked key details, completion cleanup, idle and unknown states", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const map = await open(page);
  await map.locator(".map-hit").first().focus();
  await expect(map.locator(".map-detail")).toContainText("开发工具");
  await expect(map.locator(".map-detail")).toContainText("sk-de…efgh");
  await expect(map.locator(".map-detail")).not.toContainText("Token");
  await request.post("/__map", { data: { count: 0 } });
  await expect(map.locator(".map-route")).toHaveCount(0);
  await expect(map.locator(".map-detail")).toHaveCount(0);
  await expect(map.locator(".map-idle")).toBeVisible();
  await request.post("/__map", { data: { count: 6 } });
  await expect(map.locator(".map-unlocated")).toContainText("待定位请求");
  await map.locator(".map-unlocated button").click();
  await expect(map.locator(".map-detail")).toContainText("192.168.1.20");
  expect(errors).toEqual([]);
});
test("zoom, drag, focus, fullscreen and theme rendering", async ({ page }) => {
  const map = await open(page);
  const svg = map.locator(".map-svg");
  await page.waitForTimeout(400);
  const before = await svg.getAttribute("viewBox");
  await map.getByRole("button", { name: "放大地图", exact: true }).click();
  await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(before);
  const box = await map.locator(".map-canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width * 0.6 + 60,
    box.y + box.height * 0.6 + 20,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect(map.locator(".map-navigation-hint")).toContainText("自由浏览");
  await map.getByRole("button", { name: "聚焦当前请求" }).click();
  await expect(map.locator(".map-navigation-hint")).toContainText("自动聚焦");
  await map.getByRole("button", { name: "全屏查看地图" }).click();
  await expect(map).toHaveClass(/map-full/);
  await page.keyboard.press("Escape");
  await expect(map).not.toHaveClass(/map-full/);
  fs.mkdirSync("test-results/screenshots", { recursive: true });
  await map.screenshot({
    path: "test-results/screenshots/request-map-light.png",
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await map.screenshot({
    path: "test-results/screenshots/request-map-dark.png",
  });
  expect(
    await map.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--map-ocean").trim(),
    ),
  ).toBe("#080f1b");
});
test("all palettes, mobile and 128 active requests keep finite geometry without overflow", async ({
  page,
  request,
}) => {
  const map = await open(page);
  for (const palette of [
    "lime",
    "lava",
    "violet",
    "magenta",
    "neon",
    "mint",
    "cosmic",
    "electric",
  ]) {
    await page.evaluate(
      (p) => (document.documentElement.dataset.palette = p),
      palette,
    );
    expect(
      await map
        .locator(".map-route-base")
        .first()
        .evaluate((el) => getComputedStyle(el).stroke),
    ).toBe("rgb(0, 131, 72)");
  }
  await request.post("/__map", { data: { count: 128 } });
  await expect(map.locator(".map-route")).toHaveCount(107);
  await expect(map.locator(".map-topline")).toContainText("128 处理中");
  expect(
    await map
      .locator(".map-route-base")
      .evaluateAll((els) =>
        els.every((el) => !el.getAttribute("d").includes("NaN")),
      ),
  ).toBe(true);
  await request.post("/__map", { data: { count: 5 } });
  await page.setViewportSize({ width: 390, height: 844 });
  await map.scrollIntoViewIfNeeded();
  await expect(map.locator(".map-canvas")).toHaveCSS("height", "340px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await map.screenshot({
    path: "test-results/screenshots/request-map-mobile.png",
  });
});
test("animation progresses, disconnect pauses it and deactivation removes map subscription", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const map = await open(page);
  await page.waitForTimeout(800);
  const head = map.locator(".map-meteor-head").first();
  const before = await head.getAttribute("transform");
  await page.waitForTimeout(180);
  expect(await head.getAttribute("transform")).not.toBe(before);
  await request.post("/__map", { data: { disconnect: true } });
  await expect(map).toHaveClass(/map-disconnected/);
  await expect(head).toBeHidden();
  await page.locator('.nav-link[href="#sec-logs"]').click();
  await expect(map).toHaveCount(0);
  await page.locator('.nav-link[href="#sec-overview"]').click();
  await expect(page.locator(".request-map")).not.toHaveClass(
    /map-disconnected/,
  );
});
test("pointer tooltip pins, refresh restores active requests, and browser makes no geo calls", async ({
  page,
}) => {
  const external = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname !== "127.0.0.1") external.push(r.url());
  });
  const map = await open(page);
  await page.waitForTimeout(300);
  const point = await map
    .locator(".map-hit")
    .first()
    .evaluate((el) => {
      const p = el.getPointAtLength(el.getTotalLength() * 0.53);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM());
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.move(point.x, point.y);
  await expect(map.locator(".map-detail")).toBeVisible();
  await page.mouse.click(point.x, point.y);
  await page.mouse.move(point.x + 180, point.y + 80);
  await expect(map.locator(".map-detail")).toBeVisible();
  await map.screenshot({
    path: "test-results/screenshots/request-map-detail.png",
  });
  await page.reload();
  await expect(page.locator(".map-route")).toHaveCount(5);
  expect(external).toEqual([]);
});
test("touch pinch and viewport fallback fullscreen restore cleanly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const map = await open(page);
  await page.waitForTimeout(250);
  const session = await page.context().newCDPSession(page);
  const box = await map.locator(".map-canvas").boundingBox(),
    x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const touch = (type, d) =>
    session.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd"
          ? []
          : [
              { x: x - d, y, id: 0 },
              { x: x + d, y, id: 1 },
            ],
    });
  const before = await map.locator(".map-svg").getAttribute("viewBox");
  await touch("touchStart", 30);
  await touch("touchMove", 70);
  await touch("touchEnd", 0);
  await expect(map.locator(".map-navigation-hint")).toContainText("自由浏览");
  expect(await map.locator(".map-svg").getAttribute("viewBox")).not.toBe(
    before,
  );
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = undefined;
  });
  await map.getByRole("button", { name: "全屏查看地图" }).click();
  await expect(map).toHaveClass(/map-full/);
  await page.keyboard.press("Escape");
  await expect(map).not.toHaveClass(/map-full/);
  await expect(map.locator(".map-canvas")).toHaveCSS("height", "340px");
});
test("128 animated requests stay responsive and all SVG routes clear after completion", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const map = await open(page);
  const rows = Array.from({ length: 128 }, (_, i) => ({
    id: "stress-" + i,
    ip: "8.8.8.8",
    model: "test-model",
    stream: true,
    startedAt: Date.now(),
    keyName: "并发验证",
    keyMasked: "sk-te…test",
    location: {
      label: "中国 · 北京市",
      lat: 24 + (i % 20),
      lon: 106 + (i % 25),
      precision: "省 / 州级估算",
    },
  }));
  await request.post("/__map", { data: { requests: rows } });
  await expect(map.locator(".map-route")).toHaveCount(128);
  await page.waitForTimeout(500);
  const stats = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        function frame(t) {
          times.push(t - last);
          last = t;
          if (times.length < 90) requestAnimationFrame(frame);
          else {
            times.sort((a, b) => a - b);
            resolve({ median: times[45], p95: times[85] });
          }
        }
        requestAnimationFrame(frame);
      }),
  );
  console.log("Map 128-stream frame intervals:", JSON.stringify(stats));
  expect(stats.median).toBeLessThan(35);
  expect(stats.p95).toBeLessThan(80);
  await request.post("/__map", { data: { count: 0 } });
  await expect(map.locator(".map-route")).toHaveCount(0);
  await expect(map.locator(".map-meteor-head")).toHaveCount(0);
});
