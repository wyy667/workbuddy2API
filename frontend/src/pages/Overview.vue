<script setup>
import { computed, ref, onActivated } from "vue";
import {
  state,
  accounts,
  todayTotals,
  totalBalance,
  usage,
  go,
  copy,
  loadCredits,
  loadUsage,
  notify,
  showResult,
} from "../store.js";
import { fmt, compact, shiftDay, sum, duration } from "../utils.js";
import StatCard from "../components/StatCard.vue";
import LineChart from "../components/LineChart.vue";
import RequestTable from "../components/RequestTable.vue";
import RequestMapPanel from "../components/RequestMapPanel.vue";
onActivated(() => {
  if (!state.credits.length)
    loadCredits().catch((e) => notify(e.message, "error"));
});
const expiring = computed(() => {
  const buckets = {};
  for (const c of state.credits) {
    const a = accounts.value.find((a) => a.id === c.id);
    if (!a || a.checkinOnly) continue;
    for (const p of c.packs || []) {
      if (
        p.left > 0 &&
        p.expireAt > Date.now() &&
        p.expireAt < Date.now() + 7 * 86400000
      ) {
        const day = new Date(p.expireAt).toLocaleDateString("zh-CN");
        buckets[day] = (buckets[day] || 0) + p.left;
      }
    }
  }
  return Object.entries(buckets).sort(
    (a, b) => Date.parse(a[0]) - Date.parse(b[0]),
  );
});
const reveal = ref(false),
  metric = ref("total");
const days = computed(() => {
  const today = usage.value.todayDate || new Date().toISOString().slice(0, 10);
  return Array.from({ length: 7 }, (_, i) => shiftDay(today, i - 6));
});
const trend = computed(() => [
  {
    name: metric.value === "total" ? "总 Tokens" : "请求数",
    color: "var(--accent-dark)",
    values: days.value.map((d) =>
      usage.value.daysRaw?.[d]
        ? sum(usage.value.daysRaw[d])[metric.value]
        : null,
    ),
  },
]);
const topModels = computed(() =>
  Object.entries(usage.value.today || {})
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 4),
);
const health = computed(() => state.metrics?.requests || {});
const active = computed(() => accounts.value.find((a) => a.serving));
</script>
<template>
  <div class="overview stack">
    <div class="overview-hero-grid">
      <section class="welcome-card">
        <div class="welcome-content">
          <span class="hero-kicker"
            ><span class="tiny-dot"></span> YOUR MODELS. YOUR WORKSPACE.</span
          >
          <h2>
            让灵感畅行，<br />让连接无界<span class="hero-period">。</span>
          </h2>
          <p>
            聚合模型、管理账号、追踪每一次请求。<br />专注创造，其余交给
            WorkBuddy。
          </p>
          <button class="hero-link" @click="go('models')">
            探索模型广场 <span><Icon name="arrowUpRight" :size="18" /></span>
          </button>
        </div>
        <div class="hero-art" aria-hidden="true">
          <svg viewBox="0 0 300 250" fill="none">
            <defs>
              <pattern
                id="hero-dots"
                x="0"
                y="0"
                width="18"
                height="18"
                patternUnits="userSpaceOnUse"
              >
                <circle
                  cx="1"
                  cy="1"
                  r=".65"
                  fill="currentColor"
                  opacity=".23"
                />
              </pattern>
            </defs>
            <rect width="300" height="250" fill="url(#hero-dots)" />
            <g class="orbit-stroke" stroke="currentColor" stroke-width="1">
              <ellipse
                cx="165"
                cy="124"
                rx="111"
                ry="44"
                transform="rotate(-38 165 124)"
              />
              <ellipse
                cx="165"
                cy="124"
                rx="111"
                ry="44"
                transform="rotate(38 165 124)"
              />
            </g>
            <g class="hero-core">
              <path
                d="M164 56l66 38v74l-66 38-66-38V94z"
                fill="var(--hero-ink)"
              />
              <path
                d="M98 94l66 38 66-38M164 132v74"
                stroke="var(--hero)"
                stroke-width="1"
                opacity=".45"
              />
              <path
                d="M139 91l10 18 14-7 11 6 15-17"
                stroke="var(--hero)"
                stroke-width="4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M116 143l27 16m-27-8l16 10"
                stroke="var(--hero)"
                stroke-width="2"
                opacity=".8"
              />
              <circle cx="209" cy="147" r="4" fill="var(--hero)" />
            </g>
            <circle cx="251" cy="73" r="15" fill="var(--surface)" />
            <path
              d="M246 73h10m-5-5v10"
              stroke="var(--hero-ink)"
              stroke-width="1.5"
            />
            <circle cx="77" cy="190" r="10" fill="var(--hero-ink)" />
            <path d="M73 190h8" stroke="var(--hero)" />
            <path
              d="M243 201h9m-4.5-4.5v9"
              stroke="currentColor"
              stroke-width="1.3"
            /></svg
          ><span class="hero-art-label">CONNECTED BY DESIGN</span>
        </div>
      </section>
      <section class="connection-card">
        <div class="inline connection-card-heading">
          <span
            class="status-dot"
            :class="{ offline: !state.status || !!state.error }"
          ></span
          ><span>{{
            state.status && !state.error ? "工作空间在线" : "等待服务连接"
          }}</span
          ><Icon name="arrowUpRight" :size="16" />
        </div>
        <div class="connection-count">
          {{ accounts.length.toString().padStart(2, "0")
          }}<span>个已连接账号</span>
        </div>
        <div class="connection-avatars">
          <span
            v-for="(a, i) in accounts.slice(0, 4)"
            :key="a.id"
            class="connection-avatar"
            :style="{ '--i': i }"
            >{{
              $clean(a.nickname || a.uid || "W")
                .slice(0, 1)
                .toUpperCase()
            }}</span
          ><button
            aria-label="连接新账号"
            @click="state.modal = { type: 'login', title: '连接一个新账号' }"
          >
            <Icon name="plus" :size="16" />
          </button>
        </div>
        <div class="connection-bottom">
          <span>当前服务账号</span
          ><strong>{{ $clean(active?.nickname || "尚未连接") }}</strong
          ><button aria-label="管理账号" @click="go('accounts')">
            <Icon name="arrowRight" :size="17" />
          </button>
        </div>
      </section>
    </div>
    <div class="grid grid-4">
      <StatCard
        label="今日请求"
        :loading="!state.status?.usage"
        :pending-text="state.usageError ? '加载失败，可点击刷新重试' : '正在加载用量'"
        :value="todayTotals.requests"
        icon="switch"
        :note="(usage.todayDate || '今日') + ' · 已返回用量的请求'"
      /><StatCard
        label="今日 Tokens"
        :loading="!state.status?.usage"
        :pending-text="state.usageError ? '加载失败，可点击刷新重试' : '正在加载用量'"
        :value="todayTotals.total"
        icon="layers"
        tone="purple"
        short
        :note="
          '输入 ' +
          compact(todayTotals.prompt) +
          ' / 输出 ' +
          compact(todayTotals.completion)
        "
      /><StatCard
        label="可用积分"
        :loading="!state.status"
        :value="totalBalance"
        icon="zap"
        tone="orange"
        :note="
          accounts.filter((a) => !a.checkinOnly).length +
          ' 个服务账号的缓存余额'
        "
      /><StatCard
        label="缓存命中率"
        :loading="!state.status?.usage"
        :pending-text="state.usageError ? '加载失败，可点击刷新重试' : '正在加载用量'"
        :value="
          todayTotals.prompt
            ? (todayTotals.cached / todayTotals.prompt) * 100
            : 0
        "
        suffix="%"
        icon="gauge"
        tone="blue"
        :note="compact(todayTotals.cached) + ' Tokens 来自缓存'"
      />
    </div>
    <div v-if="expiring.length" class="credit-expiry-strip">
      <span class="credit-expiry-icon"><Icon name="clock" :size="18" /></span>
      <div>
        <strong>近期积分到期提醒</strong>
        <p>
          未来 7 天内，有
          {{ fmt(expiring.reduce((s, r) => s + r[1], 0)) }} 积分即将到期。
        </p>
      </div>
      <div class="expiry-dates">
        <span v-for="row in expiring.slice(0, 3)" :key="row[0]"
          >{{ row[0] }} <b>{{ fmt(row[1]) }} pt</b></span
        >
      </div>
      <button class="text-link" @click="go('accounts')">
        管理账号 <Icon name="arrowRight" :size="14" />
      </button>
    </div>
    <div class="overview-data-grid">
      <section class="panel">
        <header class="panel-head">
          <div>
            <h2>
              流量走势 <span class="section-slash">/</span>
              <span class="muted section-en">Traffic</span>
            </h2>
            <p>最近 7 天的工作空间活动</p>
          </div>
          <div class="segmented">
            <button
              :class="{ active: metric === 'total' }"
              @click="metric = 'total'"
            >
              Tokens</button
            ><button
              :class="{ active: metric === 'requests' }"
              @click="metric = 'requests'"
            >
              请求数
            </button>
          </div>
        </header>
        <div class="panel-body">
          <div v-if="!state.status?.usage" class="module-placeholder" role="status">{{ state.usageError || "正在加载流量走势…" }}<ActionButton v-if="state.usageError" :action="loadUsage" icon="refresh">重试</ActionButton></div>
          <LineChart v-else
            :labels="days.map((d) => d.slice(5))"
            :series="trend"
            :height="220"
            :legend="false"
          />
          <div class="chart-caption">
            <span><i></i>实际用量 · 未采集日期留空</span
            ><button class="text-link" @click="go('usage')">
              查看分析 <Icon name="arrowRight" :size="13" />
            </button>
          </div>
        </div>
      </section>
      <section class="panel endpoint-card">
        <header class="panel-head">
          <div>
            <h2>即刻接入</h2>
            <p>一个地址，连接你的开发工具</p>
          </div>
          <span class="endpoint-icon"><Icon name="code" :size="19" /></span>
        </header>
        <div class="panel-body">
          <label class="endpoint-label">API BASE URL</label>
          <div class="copy-field">
            <code>{{ state.status?.service?.baseUrl || "等待服务连接" }}</code
            ><button
              class="icon-button"
              aria-label="复制接口地址"
              :disabled="!state.status"
              @click="copy(state.status.service.baseUrl)"
            >
              <Icon name="copy" :size="15" />
            </button>
          </div>
          <label class="endpoint-label">MASTER KEY</label>
          <div class="copy-field">
            <code>{{
              reveal
                ? state.status?.service?.apiKeyFull
                : state.status?.service?.apiKeyMasked || "••••••••••••••••"
            }}</code
            ><button
              class="icon-button"
              :aria-label="reveal ? '隐藏主密钥' : '显示主密钥'"
              @click="reveal = !reveal"
            >
              <Icon :name="reveal ? 'eyeOff' : 'eye'" :size="15" /></button
            ><button
              class="icon-button"
              aria-label="复制主密钥"
              :disabled="!state.status"
              @click="copy(state.status.service.apiKeyFull)"
            >
              <Icon name="copy" :size="15" />
            </button>
          </div>
          <div class="endpoint-note">
            <Icon name="shield" :size="14" /><span
              >主密钥拥有管理权限。协作时请创建附加密钥。</span
            >
          </div>
          <button
            class="btn endpoint-code"
            @click="
              state.modal = {
                type: 'snippet',
                title: '开始你的第一次调用',
                model: state.status?.service?.models?.[0] || 'auto',
              }
            "
          >
            <Icon name="terminal" :size="15" />获取调用代码<Icon
              name="arrowUpRight"
              :size="15"
            />
          </button>
        </div>
      </section>
    </div>
    <div class="overview-data-grid">
      <section class="panel">
        <header class="panel-head">
          <div>
            <h2>最近请求</h2>
            <p>每一次调用，都有迹可循</p>
          </div>
          <button class="text-link" @click="go('logs')">
            全部日志 <Icon name="arrowUpRight" :size="14" />
          </button>
        </header>
        <div v-if="!state.status" class="module-placeholder" role="status">正在加载最近请求…</div>
        <RequestTable v-else
          :rows="(state.status?.recentRequests || []).slice(0, 5)"
          short
        />
      </section>
      <section class="panel system-panel">
        <header class="panel-head">
          <h2>运行脉搏</h2>
          <span class="badge outline">LIVE</span>
        </header>
        <div class="panel-body">
          <p v-if="!state.metrics" class="muted" role="status">{{ state.metricsError || "正在加载运行指标…" }}</p>
          <div class="system-metric">
            <span>运行时长</span><b>{{ duration(state.status?.uptimeSec) }}</b>
          </div>
          <div class="system-metric">
            <span>处理中</span
            ><b>{{ state.metrics ? fmt(health.admitted) : "—" }} <small>请求</small></b>
          </div>
          <div class="system-metric">
            <span>近期请求速率</span
            ><b>{{ state.metrics ? fmt(health.reqPerMin) : "—" }} <small>/ min</small></b>
          </div>
          <div class="system-metric">
            <span>进程错误率</span
            ><b :class="{ 'text-danger': health.errorRate > 0.05 }"
              >{{ state.metrics ? fmt((health.errorRate || 0) * 100) : "—" }}<small>%</small></b
            >
          </div>
          <div class="system-metric">
            <span>内存占用</span
            ><b
              >{{
                state.metrics
                  ? fmt(state.metrics.memory?.rss / 1024 / 1024, 0)
                  : "—"
              }}
              <small>MB</small></b
            >
          </div>
          <div class="system-foot">
            <Icon name="activity" :size="14" />运行指标每 30 秒更新<button
              class="text-link"
              style="margin-left: auto"
              @click="showResult('服务运行指标', state.metrics)"
            >
              运行详情 <Icon name="arrowUpRight" :size="13" />
            </button>
          </div>
        </div>
      </section>
    </div>
    <RequestMapPanel />
  </div>
</template>
