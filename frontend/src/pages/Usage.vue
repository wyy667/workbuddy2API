<script setup>
import { computed, reactive, ref, watch, onActivated } from "vue";
import { state, usage, loadHealth, notify, apiUrl, authHeaders } from "../store.js";
import {
  fmt,
  compact,
  shiftDay,
  sum,
  modelColor,
  readPreference,
  savePreference,
  dateTime,
  download,
  csv,
} from "../utils.js";
import {
  dayMap,
  periodDates,
  mergeMaps,
  trendData,
  usageRows,
  filterModels,
  matchPlatform,
} from "../analytics.js";
import StatCard from "../components/StatCard.vue";
import LineChart from "../components/LineChart.vue";
import RequestTable from "../components/RequestTable.vue";
const filter = reactive(
    readPreference("usageFilters", { account: "", model: "", platform: "all" }),
  ),
  offset = ref(0),
  chosen = ref(""),
  period = ref("week"),
  metric = ref("total"),
  summaryPeriod = ref("total");
watch(filter, () => savePreference("usageFilters", filter));
const today = computed(
  () => usage.value.todayDate || new Date().toISOString().slice(0, 10),
);
const day = computed(() =>
  offset.value === null
    ? chosen.value || today.value
    : shiftDay(today.value, -offset.value),
);
const selected = computed(() =>
  dayMap(usage.value, day.value, filter, state.providers),
);
const totals = computed(() => sum(selected.value));
const dates = computed(() => periodDates(today.value, period.value, day.value));
const hourly = computed(() =>
  ["today", "yesterday", "date"].includes(period.value),
);
const trend = computed(() =>
  trendData(usage.value, dates.value, filter, state.providers, hourly.value),
);
const merged = computed(() =>
  mergeMaps(
    dates.value.map((d) => dayMap(usage.value, d, filter, state.providers)),
  ),
);
const names = computed(() => [
  ...new Set([
    ...Object.keys(merged.value),
    ...trend.value.flatMap((p) => Object.keys(p.map)),
  ]),
]);
const series = computed(() => [
  {
    name: "总量",
    total: true,
    color: "var(--text)",
    values: trend.value.map((p) =>
      p.available ? sum(p.map)[metric.value] : null,
    ),
  },
  ...names.value.map((n) => ({
    name: n,
    color: modelColor(n),
    values: trend.value.map((p) =>
      p.available ? p.map[n]?.[metric.value] || 0 : null,
    ),
  })),
]);
const distribution = computed(() => {
  const rows = usageRows(merged.value).filter((r) => r.total > 0),
    total = rows.reduce((s, r) => s + r.total, 0);
  let start = 0;
  return rows.map((r) => {
    const fraction = r.total / total,
      result = { ...r, fraction, offset: start };
    start += fraction;
    return result;
  });
});
const topRequests = computed(() =>
  usageRows(merged.value)
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 10),
);
const columns = [
  { key: "model", label: "模型" },
  { key: "requests", label: "请求数" },
  { key: "prompt", label: "输入 Tokens" },
  { key: "cached", label: "缓存" },
  { key: "completion", label: "输出 Tokens" },
  { key: "total", label: "总 Tokens" },
  { key: "credit", label: "消耗积分" },
];
const rows = computed(() => usageRows(selected.value));
const modelOptions = computed(() =>
  [
    ...new Set([
      ...Object.keys(usage.value.total || {}),
      ...Object.keys(usage.value.today || {}),
    ]),
  ].sort(),
);
const summaryMap = computed(() => {
  if (!filter.account)
    return filterModels(
      usage.value[summaryPeriod.value],
      filter,
      state.providers,
    );
  if (summaryPeriod.value === "total") {
    const cross = usage.value.cross?.find((a) => a.uid8 === filter.account);
    return filterModels(
      Object.fromEntries(
        Object.entries(cross?.models || {}).map(([m, v]) => [
          m,
          {
            total: v.total,
            requests: v.reqAll,
            credit: v.credit,
            cached: v.cached,
          },
        ]),
      ),
      filter,
      state.providers,
    );
  }
  const days =
    summaryPeriod.value === "today"
      ? [today.value]
      : Array.from({ length: 7 }, (_, i) => shiftDay(today.value, -i));
  return mergeMaps(
    days.map((d) => dayMap(usage.value, d, filter, state.providers)),
  );
});
const recent = computed(() =>
  (state.status?.recentRequests || [])
    .filter(
      (r) =>
        (!filter.account || r.uid8 === filter.account) &&
        (!filter.model || r.model === filter.model) &&
        matchPlatform(r.model || "", filter.platform, state.providers),
    )
    .slice(0, 10),
);
const accountRows = computed(() =>
  (usage.value.cross || [])
    .filter((a) => !filter.account || a.uid8 === filter.account)
    .map((a) => {
      const models = filterModels(a.models, filter, state.providers);
      return {
        id: a.uid8,
        name: a.name,
        ...Object.values(models).reduce((s, v) => {
          for (const k of [
            "today",
            "week",
            "total",
            "reqT",
            "reqAll",
            "creditT",
            "credit",
          ])
            s[k] = (s[k] || 0) + (v[k] || 0);
          return s;
        }, {}),
      };
    }),
);
const accountColumns = [
  { key: "name", label: "账号" },
  { key: "today", label: "今日 Tokens" },
  { key: "week", label: "近 7 天 Tokens" },
  { key: "total", label: "累计 Tokens" },
  { key: "reqT", label: "今日请求" },
  { key: "reqAll", label: "累计请求" },
  { key: "creditT", label: "今日积分" },
  { key: "credit", label: "累计积分" },
];
const healthCols = [
  { key: "source", label: "来源" },
  { key: "model", label: "模型" },
  { key: "status", label: "状态" },
  { key: "latencyMs", label: "延迟" },
  { key: "lastCheck", label: "上次检测" },
  { key: "msg", label: "信息" },
];
async function exportAll() {
  const r = await fetch(apiUrl("/usage/export", { days: 31 }), { headers: authHeaders(), credentials: "same-origin" });
  if (!r.ok) throw Error("导出失败，请检查连接和密钥");
  download(await r.text(), "workbuddy-usage-31d.csv", "text/csv;charset=utf-8");
  notify("已导出全部平台近 31 天用量");
}
onActivated(() => loadHealth().catch((e) => notify(e.message, "error")));
</script>
<template>
  <div class="stack">
    <div class="toolbar">
      <div class="segmented">
        <button
          v-for="(name, id) in {
            all: '全部平台',
            codebuddy: 'CodeBuddy',
            opencode: 'OpenCode',
            qoder: 'Qoder',
            trae: 'Trae',
          }"
          :key="id"
          :class="{ active: filter.platform === id }"
          @click="filter.platform = id"
        >
          {{ name }}
        </button>
      </div>
      <ActionButton :action="exportAll" icon="download"
        >导出 31 天用量</ActionButton
      >
    </div>
    <div class="toolbar">
      <div class="inline">
        <div class="segmented">
          <button
            v-for="(label, i) in ['今日', '昨日', '前日']"
            :key="label"
            :class="{ active: offset === i }"
            @click="offset = i"
          >
            {{ label }}
          </button>
        </div>
        <input
          type="date"
          :value="day"
          :max="today"
          aria-label="统计日期"
          @change="
            chosen = $event.target.value;
            offset = null;
          "
        />
      </div>
      <div class="inline">
        <UiSelect v-model="filter.account" aria-label="用量账号筛选">
          <option value="">全部账号</option>
          <option
            v-for="a in usage.accounts || []"
            :key="a.uid8"
            :value="a.uid8"
          >
            {{ $clean(a.name) }}
          </option></UiSelect
        ><UiSelect v-model="filter.model" aria-label="用量模型筛选">
          <option value="">全部模型</option>
          <option v-for="m in modelOptions" :key="m">{{ m }}</option>
        </UiSelect>
      </div>
    </div>
    <div class="grid grid-4">
      <StatCard
        label="所选日请求"
        :value="totals.requests"
        icon="switch"
        :note="day"
      /><StatCard
        label="所选日 Tokens"
        :value="totals.total"
        short
        tone="purple"
        icon="layers"
        :note="
          '输入 ' +
          compact(totals.prompt) +
          ' / 输出 ' +
          compact(totals.completion)
        "
      /><StatCard
        label="消耗积分"
        :value="totals.credit"
        tone="orange"
        icon="zap"
        :note="day + ' · 按用量统计'"
      /><StatCard
        label="缓存命中率"
        :value="totals.prompt ? (totals.cached / totals.prompt) * 100 : 0"
        suffix="%"
        tone="blue"
        icon="gauge"
        :note="compact(totals.cached) + ' 缓存 Tokens'"
      />
    </div>
    <div class="usage-layout">
      <section class="panel">
        <header class="panel-head">
          <div>
            <h2>用量趋势</h2>
            <p>
              {{ dates[0] }} — {{ dates.at(-1) }} ·
              {{ hourly ? "每小时" : "按日" }}
            </p>
          </div>
          <UiSelect
            v-model="metric"
            aria-label="趋势指标"
            style="width: auto; font-size: 11px"
          >
            <option
              v-for="(name, key) in {
                total: 'Tokens',
                requests: '请求数',
                credit: '积分',
                prompt: '输入 Tokens',
                completion: '输出 Tokens',
                cached: '缓存 Tokens',
              }"
              :key="key"
              :value="key"
            >
              {{ name }}
            </option>
          </UiSelect>
        </header>
        <div class="panel-body">
          <div class="segmented" style="margin-bottom: 18px">
            <button
              v-for="(label, id) in {
                today: '今日',
                yesterday: '昨日',
                week: '本周',
                month: '本月',
                date: '所选日期',
              }"
              :key="id"
              :class="{ active: period === id }"
              @click="period = id"
            >
              {{ label }}
            </button>
          </div>
          <LineChart
            :labels="trend.map((p) => p.label)"
            :series="series"
            :height="260"
          />
          <div class="chart-note">
            时区 {{ usage.timezone || "服务器时间" }} ·
            本周从周一开始。点击图例可隐藏曲线，总量始终包含全部筛选模型。{{
              hourly ? "小时采集开始前与未来时段留空，首个小时可能不完整。" : ""
            }}
          </div>
        </div>
      </section>
      <section class="panel">
        <header class="panel-head">
          <div>
            <h2>模型消耗分布</h2>
            <p>当前趋势时间范围 · Tokens</p>
          </div>
          <Icon name="layers" :size="17" class="muted" />
        </header>
        <div class="panel-body">
          <div class="donut-wrap">
            <svg
              viewBox="0 0 200 200"
              role="img"
              aria-label="各模型 Token 消耗占比"
            >
              <circle
                cx="100"
                cy="100"
                r="76"
                fill="none"
                stroke="var(--border)"
                stroke-width="18"
              />
              <circle
                v-for="r in distribution"
                :key="r.model"
                cx="100"
                cy="100"
                r="76"
                fill="none"
                :stroke="modelColor(r.model)"
                stroke-width="18"
                :stroke-dasharray="
                  Math.max(0, r.fraction * 477.52 - 3) +
                  ' ' +
                  (477.52 - Math.max(0, r.fraction * 477.52 - 3))
                "
                :stroke-dashoffset="-r.offset * 477.52"
              />
            </svg>
            <div class="donut-center">
              <strong>{{ compact(sum(merged).total) }}</strong
              ><span>TOTAL TOKENS</span>
            </div>
          </div>
          <div
            v-for="r in distribution"
            :key="r.model"
            class="distribution-row"
          >
            <span
              ><i :style="{ background: modelColor(r.model) }"></i
              ><span class="name" :title="r.model">{{
                $clean(r.model)
              }}</span></span
            ><b>{{ (r.fraction * 100).toFixed(1) }}%</b>
          </div>
          <p
            v-if="!distribution.length"
            class="muted text-small"
            style="text-align: center"
          >
            当前范围暂无用量
          </p>
        </div>
      </section>
    </div>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>日期用量明细</h2>
          <p>{{ day }} · 跟随平台、账号和模型筛选</p>
        </div>
        <ActionButton
          :action="
            () =>
              download(
                csv(rows, columns),
                'usage-' + day + '.csv',
                'text/csv;charset=utf-8',
              )
          "
          icon="download"
          class="small"
          >导出当前筛选</ActionButton
        >
      </header>
      <DataTable :columns="columns" :rows="rows" row-key="model"
        ><template #model="{ row }"
          ><span class="mono">{{ $clean(row.model) }}</span></template
        ><template v-for="c in columns.slice(1)" #[c.key]="{ value }"
          ><span class="mono">{{ fmt(value) }}</span></template
        ></DataTable
      >
      <div class="model-limit-note">
        此表仅统计返回 usage 的请求，不包含失败调用。历史日明细约保留 31 天。
      </div>
    </section>
    <div class="grid grid-2">
      <section class="panel">
        <header class="panel-head">
          <div>
            <h2>请求量排行</h2>
            <p>趋势范围内调用最多的 10 个模型</p>
          </div>
        </header>
        <div class="panel-body">
          <div v-for="r in topRequests" :key="r.model" class="rank-row">
            <span :title="r.model">{{ $clean(r.model) }}</span>
            <div class="progress-track">
              <div
                class="progress-fill"
                :style="{
                  width:
                    (r.requests / (topRequests[0]?.requests || 1)) * 100 + '%',
                  background: modelColor(r.model),
                }"
              ></div>
            </div>
            <span class="mono text-right">{{ fmt(r.requests) }}</span>
          </div>
          <EmptyState v-if="!topRequests.length" title="暂无请求排行" />
        </div>
      </section>
      <section class="panel">
        <header class="panel-head">
          <div>
            <h2>累计统计</h2>
            <p>独立于上方所选日期，跟随平台与账号筛选</p>
          </div>
          <div class="segmented">
            <button
              v-for="(label, id) in {
                today: '今日',
                week: '近 7 天',
                total: '累计',
              }"
              :key="id"
              :class="{ active: summaryPeriod === id }"
              @click="summaryPeriod = id"
            >
              {{ label }}
            </button>
          </div>
        </header>
        <div class="panel-body">
          <div
            v-for="(label, key) in {
              requests: '请求数量',
              total: 'Tokens 总量',
              cached: '缓存 Tokens',
              credit: '消耗积分',
            }"
            :key="key"
            class="system-metric"
          >
            <span>{{ label }}</span
            ><b>{{ fmt(sum(summaryMap)[key]) }}</b>
          </div>
          <p
            v-if="filter.account && summaryPeriod === 'total'"
            class="chart-note"
          >
            账号累计基于服务端交叉聚合，统计范围受历史明细保留窗口影响。
          </p>
        </div>
      </section>
    </div>
    <section class="panel">
      <header class="panel-head">
        <h2>模型累计明细</h2>
        <span class="badge outline">{{
          { today: "今日", week: "近 7 天", total: "累计" }[summaryPeriod]
        }}</span>
      </header>
      <DataTable
        :rows="usageRows(summaryMap)"
        :columns="
          filter.account && summaryPeriod === 'total'
            ? columns.filter((c) => !['prompt', 'completion'].includes(c.key))
            : columns
        "
        row-key="model"
        ><template #model="{ row }"
          ><span class="mono">{{ $clean(row.model) }}</span></template
        ><template v-for="c in columns.slice(1)" #[c.key]="{ value }">{{
          fmt(value)
        }}</template></DataTable
      >
    </section>
    <section class="panel">
      <header class="panel-head"><h2>账号用量汇总</h2></header>
      <DataTable :rows="accountRows" :columns="accountColumns"
        ><template v-for="c in accountColumns.slice(1)" #[c.key]="{ value }">{{
          fmt(value)
        }}</template></DataTable
      >
    </section>
    <section class="panel">
      <header class="panel-head">
        <h2>最近请求明细</h2>
        <span class="muted text-small">当前筛选下最近 10 条</span>
      </header>
      <RequestTable :rows="recent" />
    </section>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>模型健康历史</h2>
          <p>受限记录与外部平台探测结果</p>
        </div>
        <ActionButton :action="loadHealth" icon="refresh" class="small"
          >刷新</ActionButton
        >
      </header>
      <DataTable :columns="healthCols" :rows="state.health"
        ><template #source="{ row }">{{
          $clean(row.provider || row.account || row.source)
        }}</template
        ><template #status="{ row }"
          ><span
            class="badge"
            :class="row.blocked ? 'orange' : row.ok ? 'success' : 'danger'"
            >{{
              row.blocked
                ? "受限至 " + dateTime(row.blockedUntil)
                : row.ok
                  ? "正常"
                  : "异常"
            }}</span
          ></template
        ><template #lastCheck="{ value }">{{ dateTime(value) }}</template
        ><template #latencyMs="{ value }">{{
          value != null ? fmt(value) + " ms" : "—"
        }}</template
        ><template #msg="{ value }"
          ><span
            class="truncate"
            style="display: block"
            :title="$clean(value)"
            >{{ $clean(value) || "—" }}</span
          ></template
        ></DataTable
      >
    </section>
  </div>
</template>
