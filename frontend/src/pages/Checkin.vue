<script setup>
import { ref, computed } from "vue";
import { state, api, refresh, notify, showResult } from "../store.js";
import { dateTime, cleanText } from "../utils.js";
const manual = ref(null),
  statuses = ref(null);
const data = computed(() => state.status?.checkin || {});
const results = computed(() => manual.value || data.value.lastResults || []);
async function runAll() {
  const d = await api("/checkin/all", { body: {}, timeout: 600000 });
  manual.value = d.results || d.lastResults || [];
  await refresh();
  notify("全部账号签到已完成");
  if (!manual.value.length) showResult("签到结果", d);
}
async function status() {
  statuses.value =
    (await api("/checkin/status", { timeout: 600000 })).accounts || [];
  notify("签到状态已更新");
}
const nickname = (id) =>
  [...(state.status?.accounts || []), ...(state.status?.pool || [])].find(
    (a) => a.id === id,
  )?.nickname || id;
function signed(a) {
  const d = a.data?.data || a.data?.result || a.data || {},
    v = d.isSign ?? d.signed ?? d.hasSigned ?? d.todaySigned ?? d.isCheckin;
  return v === true || v === 1
    ? "已签到"
    : v === false || v === 0
      ? "未签到"
      : a.ok
        ? "查询成功"
        : "查询失败";
}
function field(a, keys) {
  const d = a.data?.data || a.data?.result || a.data || {};
  return (
    keys.map((k) => d[k]).find((v) => v !== undefined && v !== null) ?? "—"
  );
}
const cols = [
  { key: "id", label: "账号" },
  { key: "ok", label: "状态" },
  { key: "detail", label: "签到结果" },
  { key: "action", label: "" },
];
</script>
<template>
  <div class="stack">
    <section class="checkin-banner">
      <div class="inline">
        <span class="checkin-banner-icon"
          ><Icon name="calendar" :size="34"
        /></span>
        <div>
          <h2>每日积累，自有回响。</h2>
          <p>每天 {{ data.at || "—" }} 自动签到，也可以随时手动领取。</p>
        </div>
      </div>
      <ActionButton :action="runAll" icon="check" variant="dark"
        >全部账号立即签到</ActionButton
      >
    </section>
    <div class="grid grid-3">
      <div class="plain-stat">
        <span class="label">自动签到时间</span
        ><strong>{{ data.at || "—" }}</strong>
        <p>按服务器配置时区执行</p>
      </div>
      <div class="plain-stat">
        <span class="label">上次执行日期</span
        ><strong>{{ data.lastRunDate || "尚未执行" }}</strong>
        <p>{{ dateTime(data.lastRunAt) }}</p>
      </div>
      <div class="plain-stat">
        <span class="label">上次成功账号</span
        ><strong
          >{{ (data.lastResults || []).filter((r) => r.ok).length }}
          <span class="muted"
            >/ {{ (data.lastResults || []).length }}</span
          ></strong
        >
        <p>执行结果以服务器返回为准</p>
      </div>
    </div>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>签到记录</h2>
          <p>{{ manual ? "本次手动签到结果" : "最近一次自动签到结果" }}</p>
        </div>
        <span class="badge outline">{{ results.length }} 个账号</span>
      </header>
      <DataTable :columns="cols" :rows="results"
        ><template #id="{ row }"
          ><strong>{{ $clean(nickname(row.id)) }}</strong>
          <div class="table-sub mono">{{ row.id }}</div></template
        ><template #ok="{ row }"
          ><span class="badge" :class="row.ok ? 'success' : 'danger'">{{
            row.ok ? "成功" : "失败"
          }}</span></template
        ><template #detail="{ row }"
          ><span
            class="truncate"
            style="display: block"
            :title="$clean(JSON.stringify(row.data || row.msg))"
            >{{ $clean(row.msg || JSON.stringify(row.data || {})) }}</span
          ></template
        ><template #action="{ row }"
          ><button
            class="icon-button"
            aria-label="查看签到详情"
            @click="showResult('签到详情', row)"
          >
            <Icon name="arrowUpRight" :size="16" /></button></template
      ></DataTable>
    </section>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>今日状态</h2>
          <p>从上游查询各个账号的签到进度</p>
        </div>
        <ActionButton :action="status" icon="refresh"
          >查询今日状态</ActionButton
        >
      </header>
      <div class="panel-body" v-if="statuses">
        <div class="grid grid-2">
          <article v-for="a in statuses" :key="a.id" class="account-card">
            <div class="account-card-head">
              <span class="avatar purple"
                ><Icon name="calendar" :size="20"
              /></span>
              <div>
                <h3>{{ $clean(nickname(a.id)) }}</h3>
                <p>{{ a.id }}</p>
              </div>
              <span class="badge" :class="a.ok ? 'success' : 'danger'">{{
                signed(a)
              }}</span>
            </div>
            <div class="divider"></div>
            <div class="system-metric">
              <span>连续签到</span
              ><b
                >{{
                  field(a, [
                    "continuousDays",
                    "continuous_days",
                    "continueDays",
                    "signDays",
                    "sign_days",
                    "days",
                    "totalSignDays",
                  ])
                }}
                <small>天</small></b
              >
            </div>
            <div class="system-metric">
              <span>今日积分</span
              ><b>{{
                field(a, [
                  "todayCredit",
                  "credit",
                  "credits",
                  "points",
                  "reward",
                  "integral",
                ])
              }}</b>
            </div>
            <div class="system-metric">
              <span>补签卡</span
              ><b>{{
                field(a, ["cardNum", "card", "supplementNum", "leftSignCard"])
              }}</b>
            </div>
            <details style="margin-top: 16px">
              <summary>查看详情</summary>
              <pre>{{
                $clean(JSON.stringify(a.data || a.msg || {}, null, 2))
              }}</pre>
            </details>
          </article>
        </div>
        <EmptyState
          v-if="!statuses.length"
          title="暂无账号状态"
          description="连接账号后再查询。"
        />
      </div>
      <EmptyState
        v-else
        icon="calendar"
        title="查询今天的签到状态"
        description="此查询会请求上游服务，按需获取最新状态。"
      />
    </section>
  </div>
</template>
