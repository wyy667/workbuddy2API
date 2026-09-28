export const cleanText = (v) =>
  String(v ?? "")
    .replace(
      /[\p{Extended_Pictographic}\uFE0F\u200D\u20E3\u{1F1E6}-\u{1F1FF}]/gu,
      "",
    )
    .trim();
export const fmt = (n, digits = 2) =>
  Number(n || 0).toLocaleString("zh-CN", { maximumFractionDigits: digits });
export const compact = (n) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(n || 0));
export const dateTime = (t) =>
  t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "尚无记录";
export const time = (t) =>
  t ? new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
export const duration = (s) =>
  !Number.isFinite(Number(s))
    ? "—"
    : s >= 86400
      ? `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`
      : s >= 3600
        ? `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
        : `${Math.floor(s / 60)} 分`;
export const sum = (map) =>
  Object.values(map || {}).reduce(
    (a, v) => {
      for (const k of [
        "requests",
        "total",
        "prompt",
        "completion",
        "cached",
        "credit",
      ])
        a[k] += Number(v[k]) || 0;
      return a;
    },
    { requests: 0, total: 0, prompt: 0, completion: 0, cached: 0, credit: 0 },
  );
export const shiftDay = (day, n) => {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const vendor = (id) =>
  /claude/i.test(id)
    ? "Anthropic"
    : /gpt|o[134](?:-|$)|codex/i.test(id)
      ? "OpenAI"
      : /gemini/i.test(id)
        ? "Google"
        : /deepseek/i.test(id)
          ? "DeepSeek"
          : /qwen/i.test(id)
            ? "Qwen"
            : /(?:^|[\/\s_-])hy(?:\d|[-_]|$)|hunyuan|混元/i.test(id)
              ? "Hunyuan"
              : /glm|zhipu|智谱/i.test(id)
                ? "GLM"
                : /minimax/i.test(id)
                  ? "MiniMax"
                  : /kimi|moonshot|(?:^|[\/\s_-])k[23](?:[.\s_-]|$)/i.test(id)
                    ? "Kimi"
                    : "Other";
// Allocate colors by model identity, never by a collision-prone name hash.
// Keep the registry for the session so filters, rankings and theme changes do
// not reassign an existing model. Additional series get unique hue values.
const modelColors = new Map();
export const modelColor = (name) => {
  if (!modelColors.has(name)) {
    const index = modelColors.size;
    modelColors.set(name, index < 12 ? `var(--chart-${index + 1})` : `hsl(${((index - 12) * 137.508 + 24) % 360} 76% var(--chart-extra-lightness))`);
  }
  return modelColors.get(name);
};
export function download(content, name, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csv(rows, columns) {
  const cell = (v) => {
    let s = cleanText(v);
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      columns.map((c) => c.label),
      ...rows.map((r) => columns.map((c) => r[c.key] ?? "")),
    ]
      .map((r) => r.map(cell).join(","))
      .join("\r\n")
  );
}
export const safeUrl = (value) => {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
};
export function readPreference(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem("wb3:" + key)) ?? fallback;
  } catch {
    return fallback;
  }
}
export function savePreference(key, value) {
  try {
    localStorage.setItem("wb3:" + key, JSON.stringify(value));
  } catch {}
}
