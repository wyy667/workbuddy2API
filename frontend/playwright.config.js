import { defineConfig } from "@playwright/test";
const port = process.env.FIXTURE_PORT || 8950;
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.mjs",
  workers: 1,
  timeout: 45000,
  webServer: {
    command: "node tests/fixture-server.mjs",
    url: `http://127.0.0.1:${port}/admin?key=fixture`,
    reuseExistingServer: true,
    timeout: 15000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  },
  reporter: "list",
});
