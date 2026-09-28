// Capture the isolated fixture only. No real account or upstream requests.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const output = new URL("../preview/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1040 },
    reducedMotion: "reduce",
  });
  await page.goto("http://127.0.0.1:8950/admin?key=fixture#sec-overview");
  await page.locator(".sync-state").filter({ hasText: "已同步" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const capture = async (name, fullPage = false) => {
    // Let CSS breakpoints and chart ResizeObservers settle after viewport changes.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    return page.screenshot({
      path: fileURLToPath(new URL(name + ".png", output)),
      fullPage,
    });
  };
  await capture("day");
  await page.getByRole("button", { name: "切换夜间模式" }).click();
  await capture("night");
  await page.getByRole("button", { name: "切换日间模式" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("mobile", true);
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.locator('.nav-link[href="#sec-models"]').click();
  await page.locator(".model-card").first().waitFor();
  await capture("models", true);
  await page.getByRole("button", { name: "切换夜间模式" }).click();
  await capture("models-dark", true);
  console.log(
    "Saved desktop, mobile and model-brand previews in frontend/preview",
  );
} finally {
  await browser.close();
}
