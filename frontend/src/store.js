import { reactive, computed } from "vue";
import { cleanText, readPreference, savePreference, sum } from "./utils.js";

export const navigation = [
  {
    id: "overview",
    label: "服务概览",
    en: "Overview",
    icon: "dashboard",
    group: "工作空间",
    desc: "每个请求，都尽在掌握。",
  },
  {
    id: "accounts",
    label: "账号管理",
    en: "Accounts",
    icon: "users",
    group: "工作空间",
    desc: "让每个账号，保持最佳状态。",
  },
  {
    id: "tasks",
    label: "任务中心",
    en: "Tasks",
    icon: "checks",
    group: "工作空间",
    desc: "日常有序，成长不停。",
  },
  {
    id: "checkin",
    label: "每日签到",
    en: "Check-in",
    icon: "calendar",
    group: "工作空间",
    desc: "积少成多，让每一天都有回报。",
  },
  {
    id: "usage",
    label: "用量分析",
    en: "Analytics",
    icon: "audio",
    group: "观察与管理",
    desc: "看见消耗，也看见效率。",
  },
  {
    id: "logs",
    label: "请求日志",
    en: "Live requests",
    icon: "terminal",
    group: "观察与管理",
    desc: "从一次请求，洞察整个链路。",
  },
  {
    id: "models",
    label: "模型广场",
    en: "Models",
    icon: "box",
    group: "观察与管理",
    desc: "为每个想法，找到合适的模型。",
  },
  {
    id: "keys",
    label: "API 密钥",
    en: "API keys",
    icon: "key",
    group: "连接与配置",
    desc: "精细授权，让协作有边界。",
  },
  {
    id: "ext",
    label: "多反代聚合",
    en: "Connections",
    icon: "workflow",
    group: "连接与配置",
    desc: "连接更多可能，统一一个入口。",
  },
  {
    id: "backup",
    label: "备份恢复",
    en: "Backups",
    icon: "database",
    group: "连接与配置",
    desc: "为重要数据，留一份安心。",
  },
];
const initialPage =
  location.hash.replace("#sec-", "").replace("#", "") ||
  readPreference("page", "overview");
export const state = reactive({
  page: navigation.some((n) => n.id === initialPage) ? initialPage : "overview",
  theme: readPreference("theme", "light"),
  palette: readPreference("palette", "lime"),
  density: readPreference("density", "comfortable"),
  key: takeUrlKey(),
  status: null,
  metrics: null,
  usageLoading: false,
  usageError: "",
  metricsError: "",
  providers: [],
  credits: [],
  health: [],
  checkup: null,
  loading: false,
  error: "",
  lastUpdated: 0,
  sidebar: false,
  modal: null,
  toasts: [],
  refreshVersion: 0,
  live: [],
  liveConnected: false,
  liveEnabled: true,
  extFilter: "all",
});
export const accounts = computed(() => state.status?.accounts || []);
export const usage = computed(() => state.status?.usage || {});
export const todayTotals = computed(() => sum(usage.value.today));
export const totalBalance = computed(() =>
  accounts.value
    .filter(
      (a) => !a.checkinOnly && !a.flag403 && !(a.blockedUntil > Date.now()),
    )
    .reduce(
      (s, a) =>
        s +
        (Number(
          state.credits.find((c) => c.id === a.id)?.totalLeft ?? a.balance,
        ) || 0),
      0,
    ),
);
let toastSequence = 0;
export function notify(message, type = "success") {
  const id = `toast-${Date.now()}-${++toastSequence}`;
  state.toasts.push({ id, message: cleanText(message), type });
  setTimeout(() => {
    state.toasts = state.toasts.filter((t) => t.id !== id);
  }, 5500);
}
export function go(page) {
  if (!navigation.some((n) => n.id === page)) return;
  state.page = page;
  if (state.status && (page === "overview" || page === "usage")) loadUsage().catch(e => notify(e.message, "error"));
  state.sidebar = false;
  history.replaceState(null, "", "#sec-" + page);
  savePreference("page", page);
  window.scrollTo({ top: 0, behavior: "instant" });
}
export function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.palette = state.palette;
  document.documentElement.dataset.density = state.density;
  savePreference("theme", state.theme);
  savePreference("palette", state.palette);
  savePreference("density", state.density);
}
// 管理 key 不出现在 URL 里：打开页面时读取一次 ?key= 并立即从地址栏移除
// （服务端已在 /admin 响应里下发 HttpOnly 会话 cookie）。后续 fetch 带 X-Api-Key 头，
// EventSource 无法设置请求头，依靠同源 cookie 鉴权。
function takeUrlKey() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key") || "";
  if (key) {
    params.delete("key");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }
  return key;
}
export function authHeaders(extra = {}) {
  return state.key ? { ...extra, "X-Api-Key": state.key } : extra;
}
export function apiUrl(path, query = {}) {
  const u = new URL("/admin/api" + path, location.origin);
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.href;
}
export async function api(path, options = {}) {
  const { body, query, allowFalse = false, timeout = 180000, signal } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(apiUrl(path, query), {
      method: body !== undefined ? "POST" : "GET",
      headers: authHeaders(
        body !== undefined ? { "Content-Type": "application/json" } : {},
      ),
      credentials: "same-origin",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal || controller.signal,
    });
    const d = await r
      .json()
      .catch(() => ({ message: `服务器返回了无法读取的响应 (${r.status})` }));
    if (!r.ok || (d.ok === false && !allowFalse)) {
      const e = new Error(
        cleanText(
          d.message ||
            d.msg ||
            d.error?.message ||
            (r.status === 401 || r.status === 403
              ? "管理密钥无效或已失效"
              : "请求未完成"),
        ),
      );
      e.status = r.status;
      e.data = d;
      throw e;
    }
    return d;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("请求超时，请稍后重试");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
let refreshPromise = null,
  liveSeeded = false;
export async function refresh() {
  if (refreshPromise) return refreshPromise;
  state.loading = true;
  refreshPromise = (async () => {
    try {
      const previous = state.status;
      const next = await api("/status", { timeout: 30000, query: { detail: "light" } });
      state.status = { ...next, usage: next.usage || previous?.usage };
      if ((state.page === "overview" || state.page === "usage") && (!state.status.usage || next.usageVersion !== previous?.usageVersion || Date.now() - lastUsageAt > 30000)) loadUsage().catch(() => {});
      state.error = "";
      state.lastUpdated = Date.now();
      if (!liveSeeded) {
        seedLive(state.status.recentRequests || []);
        liveSeeded = true;
      }
    } catch (e) {
      state.error = e.message;
      throw e;
    } finally {
      state.loading = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}
let usagePromise = null, lastUsageAt = 0;
export function loadUsage() {
  if (!usagePromise) {
    state.usageLoading = true;
    state.usageError = "";
    usagePromise = api("/usage", { timeout: 30000 }).then(d => {
      if (state.status) state.status.usage = d.usage;
      lastUsageAt = Date.now();
    }).catch(e => { state.usageError = e.message; throw e; })
      .finally(() => { usagePromise = null; state.usageLoading = false; });
  }
  return usagePromise;
}
export async function loadMetrics() {
  try { state.metrics = await api("/metrics", { timeout: 30000 }); state.metricsError = ""; }
  catch (e) { state.metricsError = e.message; throw e; }
}
export async function loadProviders() {
  state.providers = (await api("/ext/list")).providers || [];
}
export async function loadCredits(force = false) {
  state.credits =
    (await api("/credits", { query: { force: force ? 1 : 0 } })).accounts || [];
}
export async function loadHealth() {
  state.health = (await api("/health/history")).items || [];
}
export async function loadCheckup() {
  state.checkup = await api("/checkup", { allowFalse: true });
}
export async function mutate(path, body = {}, message = "操作已完成") {
  const d = await api(path, { body });
  if (message) notify(message);
  await refresh().catch(() => {});
  return d;
}
export async function saveSettings(values) {
  return mutate(
    "/settings",
    { pollMin: 30, ...state.status?.settings, ...values },
    "设置已保存",
  );
}
export async function copy(value) {
  try {
    if (navigator.clipboard && window.isSecureContext)
      await navigator.clipboard.writeText(String(value));
    else {
      const el = document.createElement("textarea");
      el.value = String(value);
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.append(el);
      el.select();
      const ok = document.execCommand("copy");
      el.remove();
      if (!ok) throw Error("复制失败");
    }
    notify("已复制到剪贴板");
  } catch {
    notify("复制失败，请手动选择并复制", "error");
  }
}
let confirmResolve;
export function confirmAction(title, description, button = "确认操作") {
  if (confirmResolve) confirmResolve(false);
  state.modal = { type: "confirm", title, description, button };
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}
export function closeModal(result = false) {
  if (state.modal?.busy) return;
  state.modal = null;
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
}
export function showResult(title, data) {
  state.modal = { type: "result", title, data };
}
export async function testConnection() {
  const d = await api("/test", { body: {} });
  showResult("连通测试", d);
  return d;
}
const rowKey = (r) =>
  [r.t, r.model, r.uid8, r.name, r.ttft, r.durMs, r.err, r.finish].join("|");
function seedLive(rows) {
  const seen = new Set(state.live.map(rowKey));
  state.live = [...state.live, ...rows.filter((r) => !seen.has(rowKey(r)))]
    .sort((a, b) => b.t - a.t)
    .slice(0, 600);
}
let eventSource = null,
  reconnect = null;
export function startLive() {
  if (eventSource || !state.liveEnabled || document.hidden) return;
  eventSource = new EventSource(apiUrl("/live"));
  eventSource.onopen = () => {
    state.liveConnected = true;
  };
  eventSource.onmessage = (e) => {
    try {
      seedLive([JSON.parse(e.data)]);
    } catch {}
  };
  eventSource.onerror = () => {
    state.liveConnected = false;
    if (eventSource?.readyState === 2) {
      stopLive();
      reconnect = setTimeout(startLive, 5000);
    }
  };
}
export function stopLive() {
  eventSource?.close();
  eventSource = null;
  state.liveConnected = false;
  clearTimeout(reconnect);
}
export function toggleLive() {
  state.liveEnabled = !state.liveEnabled;
  state.liveEnabled ? startLive() : stopLive();
}
export async function refreshAll() {
  const results = await Promise.allSettled([
    refresh(),
    loadMetrics(),
    ...(["models", "ext"].includes(state.page) ? [loadProviders()] : []),
  ]);
  state.refreshVersion++;
  const errors = results.filter((r) => r.status === "rejected");
  if (errors.length) throw errors[0].reason;
}
