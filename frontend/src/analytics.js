import { shiftDay, sum } from "./utils.js";
export function matchPlatform(model, platform, providers = []) {
  if (!platform || platform === "all") return true;
  const p = providers.find((p) => model.startsWith((p.prefix || p.id) + "/"));
  return platform === "codebuddy"
    ? !p
    : p?.type === platform || p?.id === platform;
}
export function filterModels(map, filter, providers) {
  return Object.fromEntries(
    Object.entries(map || {}).filter(
      ([m]) =>
        (!filter.model || m === filter.model) &&
        matchPlatform(m, filter.platform, providers),
    ),
  );
}
export function dayMap(usage, day, filter, providers, hour) {
  let map;
  if (hour !== undefined) {
    const bucket = usage.hoursRaw?.[day + "T" + String(hour).padStart(2, "0")];
    map = filter.account ? bucket?.accounts?.[filter.account] : bucket?.models;
  } else
    map = filter.account
      ? usage.accountDaysRaw?.[filter.account]?.days?.[day]
      : usage.daysRaw?.[day];
  return filterModels(map, filter, providers);
}
export function mergeMaps(maps) {
  const out = {};
  for (const map of maps)
    for (const [model, v] of Object.entries(map || {})) {
      const slot = (out[model] ||= {
        requests: 0,
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
        credit: 0,
      });
      for (const k of Object.keys(slot)) slot[k] += Number(v[k]) || 0;
    }
  return out;
}
export function periodDates(today, period, selected) {
  let start =
      period === "yesterday"
        ? shiftDay(today, -1)
        : period === "date"
          ? selected
          : today,
    end = start;
  if (period === "week") {
    start = shiftDay(
      today,
      -((new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7),
    );
    end = today;
  }
  if (period === "month") {
    start = today.slice(0, 8) + "01";
    end = today;
  }
  const list = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || "")) return list;
  for (let day = start; day <= end && list.length < 62; day = shiftDay(day, 1))
    list.push(day);
  return list;
}
export function hourKey(t, timezone) {
  try {
    const p = {};
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(t))
      .forEach((v) => (p[v.type] = v.value));
    return `${p.year}-${p.month}-${p.day}T${p.hour}`;
  } catch {
    return "";
  }
}
export function trendData(usage, dates, filter, providers, hourly) {
  const now = Date.parse(usage.serverNow) || Date.now(),
    first = hourKey(usage.hourlySince || now, usage.timezone),
    last = hourKey(now, usage.timezone);
  if (hourly) {
    return Array.from({ length: 24 }, (_, h) => ({
      label: String(h).padStart(2, "0") + ":00",
      map: dayMap(usage, dates[0], filter, providers, h),
      available:
        !!usage.hourlySince &&
        dates[0] + "T" + String(h).padStart(2, "0") >= first &&
        dates[0] + "T" + String(h).padStart(2, "0") <= last,
    }));
  }
  const earliest = Object.keys(usage.daysRaw || {}).sort()[0];
  return dates.map((d) => ({
    label: d.slice(5),
    map: dayMap(usage, d, filter, providers),
    available: !!earliest && d >= earliest,
  }));
}
export function usageRows(map) {
  return Object.entries(map)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.total - a.total);
}
