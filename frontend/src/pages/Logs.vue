<script setup>
import { ref, computed } from "vue";
import { state, toggleLive, notify } from "../store.js";
import { csv, download, dateTime } from "../utils.js";
import RequestTable from "../components/RequestTable.vue";
const search = ref(""),
  status = ref(""),
  account = ref(""),
  errOnly = ref(false),
  paused = ref(false),
  snapshot = ref([]);
const rows = computed(() =>
  (paused.value ? snapshot.value : state.live).filter((r) => {
    const err = String(r.err || "");
    return (
      (!search.value ||
        String(r.model || "")
          .toLowerCase()
          .includes(search.value.toLowerCase())) &&
      (!account.value || (r.name || r.uid8) === account.value) &&
      (!errOnly.value || !!err) &&
      (!status.value ||
        (status.value === "200"
          ? !err
          : status.value === "other"
            ? !!err && !/403|429/.test(err)
            : err.includes(status.value)))
    );
  }),
);
const accounts = computed(() => [
  ...new Set(state.live.map((r) => r.name || r.uid8).filter(Boolean)),
]);
function freeze() {
  paused.value = !paused.value;
  if (paused.value) snapshot.value = [...state.live];
}
function clear() {
  state.live = [];
  snapshot.value = [];
  notify("当前日志缓冲已清空");
}
function exportCsv() {
  const cols = [
    { key: "t", label: "时间" },
    { key: "name", label: "账号" },
    { key: "model", label: "模型" },
    { key: "ttft", label: "首字(ms)" },
    { key: "durMs", label: "耗时(ms)" },
    { key: "prompt", label: "输入" },
    { key: "cached", label: "缓存" },
    { key: "completion", label: "输出" },
    { key: "credit", label: "积分" },
    { key: "err", label: "错误" },
    { key: "msg", label: "信息" },
  ];
  download(
    csv(
      rows.value.map((r) => ({
        ...r,
        t: dateTime(r.t),
        name: r.name || r.uid8,
      })),
      cols,
    ),
    "requests.csv",
    "text/csv;charset=utf-8",
  );
  notify("已导出当前筛选日志");
}
</script>
<template>
  <div class="stack">
    <div class="toolbar">
      <div class="inline">
        <span class="badge" :class="state.liveConnected ? 'success' : 'orange'"
          ><span class="tiny-dot"></span
          >{{
            !state.liveEnabled
              ? "监听已暂停"
              : state.liveConnected
                ? "实时监听中"
                : "正在连接"
          }}</span
        ><span class="muted text-small"
          >{{ rows.length }} / {{ state.live.length }} 条</span
        >
      </div>
      <div class="inline">
        <button class="btn" @click="toggleLive">
          <Icon :name="state.liveEnabled ? 'pause' : 'play'" :size="16" />{{
            state.liveEnabled ? "暂停监听" : "继续监听"
          }}</button
        ><button class="btn" @click="clear">
          <Icon name="trash" :size="15" />清空</button
        ><ActionButton :action="exportCsv" icon="download"
          >导出 CSV</ActionButton
        >
      </div>
    </div>
    <div class="toolbar">
      <div class="search-input">
        <Icon name="search" :size="16" /><input
          v-model="search"
          aria-label="搜索请求模型"
          placeholder="搜索模型名称"
        />
      </div>
      <div class="inline">
        <UiSelect v-model="status" aria-label="日志状态筛选">
          <option value="">全部状态</option>
          <option value="200">成功</option>
          <option value="403">403 受限</option>
          <option value="429">429 限流</option>
          <option value="other">其他错误</option></UiSelect
        ><UiSelect v-model="account" aria-label="日志账号筛选">
          <option value="">全部账号</option>
          <option v-for="a in accounts" :key="a" :value="a">
            {{ $clean(a) }}
          </option></UiSelect
        ><label class="checkbox"
          ><input type="checkbox" v-model="errOnly" />仅错误</label
        >
      </div>
    </div>
    <div v-if="paused" class="paused-banner">
      <Icon name="pause" :size="16" /><span style="flex: 1"
        >显示已冻结，新请求仍在后台接收。</span
      ><button class="text-link" @click="freeze">继续更新</button>
    </div>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>实时请求流水</h2>
          <p>最近保留 600 条 · SSE 实时推送</p>
        </div>
        <button class="btn small" @click="freeze">
          <Icon :name="paused ? 'play' : 'pause'" :size="14" />{{
            paused ? "继续更新" : "冻结显示"
          }}
        </button>
      </header>
      <RequestTable :rows="rows" />
    </section>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>服务端事件</h2>
          <p>运行事件与系统诊断信息，每 10 秒更新</p>
        </div>
        <Icon name="terminal" :size="18" class="muted" />
      </header>
      <DataTable
        :columns="[
          { key: 't', label: '时间' },
          { key: 'msg', label: '事件' },
        ]"
        :rows="state.status?.logs || []"
        ><template #t="{ value }"
          ><span class="mono muted">{{ dateTime(value) }}</span></template
        ><template #msg="{ value }"
          ><span class="event-message">{{ $clean(value) }}</span></template
        ></DataTable
      >
    </section>
  </div>
</template>
