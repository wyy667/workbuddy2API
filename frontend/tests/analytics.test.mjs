import test from "node:test";
import assert from "node:assert/strict";
import {
  dayMap,
  periodDates,
  trendData,
  matchPlatform,
  mergeMaps,
} from "../src/analytics.js";
import { csv, cleanText, safeUrl, vendor } from "../src/utils.js";
test("model brands recognize native and prefixed identifiers without matching unrelated hy strings", () => {
  for (const [id, expected] of Object.entries({
    "hy4-preview": "Hunyuan",
    "hy3-preview-agent": "Hunyuan",
    "trae/hy4-preview": "Hunyuan",
    "hunyuan-t1": "Hunyuan",
    "glm-5.2": "GLM",
    "zhipu/glm-5v": "GLM",
    "minimax-m3-pay": "MiniMax",
    "kimi-k2.7": "Kimi",
    "moonshot-v1": "Kimi",
    "DeepSeek-V4-Flash": "DeepSeek",
    "physics-model": "Other",
  }))
    assert.equal(vendor(id), expected, id);
});
test("calendar week begins Monday, crosses month boundary", () =>
  assert.deepEqual(periodDates("2026-10-01", "week"), [
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
  ]));
test("single date, yesterday, leap day and month preserve dates", () => {
  assert.deepEqual(periodDates("2024-03-01", "yesterday"), ["2024-02-29"]);
  assert.equal(periodDates("2024-02-29", "month").length, 29);
  assert.deepEqual(periodDates("2026-09-27", "date", "2026-09-20"), [
    "2026-09-20",
  ]);
});
test("account and platform filters select correct raw day and hour maps", () => {
  const u = {
    daysRaw: {
      "2026-09-27": { gpt: { total: 50 }, "custom/gpt": { total: 30 } },
    },
    accountDaysRaw: { a: { days: { "2026-09-27": { gpt: { total: 12 } } } } },
    hoursRaw: { "2026-09-27T08": { accounts: { a: { gpt: { total: 4 } } } } },
  };
  assert.deepEqual(
    dayMap(u, "2026-09-27", { account: "a", platform: "all" }, [], 8),
    { gpt: { total: 4 } },
  );
  assert.deepEqual(
    dayMap(u, "2026-09-27", { platform: "codebuddy" }, [
      { prefix: "custom", type: "custom" },
    ]),
    { gpt: { total: 50 } },
  );
  assert.deepEqual(dayMap(u, "2026-09-27", { account: "missing" }, []), {});
});
test("uncollected and future hours are gaps, collected idle hour is zero", () => {
  const u = {
    timezone: "Asia/Shanghai",
    hourlySince: Date.parse("2026-09-27T08:15:00+08:00"),
    serverNow: "2026-09-27T10:30:00+08:00",
    hoursRaw: {},
  };
  const d = trendData(u, ["2026-09-27"], {}, [], true);
  assert.equal(d[7].available, false);
  assert.equal(d[8].available, true);
  assert.equal(d[10].available, true);
  assert.equal(d[11].available, false);
  assert.deepEqual(d[9].map, {});
});
test("aggregation preserves fractional credits and cache tokens", () =>
  assert.equal(
    mergeMaps([
      { a: { total: 2, credit: 0.2 } },
      { a: { total: 3, credit: 0.3 } },
    ]).a.credit,
    0.5,
  ));
test("emoji display sanitizer and link restrictions", () => {
  assert.equal(cleanText("成功\u{1F680}\u{1F1E8}\u{1F1F3}"), "成功");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("https://example.com"), "https://example.com/");
});
test("CSV quotes newlines and neutralizes spreadsheet formulas", () => {
  const s = csv(
    [{ m: '=HYPERLINK("a")' }, { m: "line\none" }],
    [{ key: "m", label: "模型" }],
  );
  assert.ok(s.includes("'=HYPERLINK"));
  assert.ok(s.includes('"line\none"'));
});
