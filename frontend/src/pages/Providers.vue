<script setup>
import { ref, computed, onActivated, watch, onBeforeUnmount, onDeactivated } from "vue";
import {
  state,
  api,
  loadProviders,
  notify,
  confirmAction,
  go,
  showResult,
} from "../store.js";
import { fmt, dateTime, safeUrl } from "../utils.js";
import RequestTable from "../components/RequestTable.vue";
const selected = ref(""),
  detail = ref(null),
  testing = ref(false),
  testResults = ref([]),
  testProgress = ref(""),
  cancelTest = ref(false),
  detailLoading = ref(false);
const providers = computed(() =>
  state.providers.filter(
    (p) => state.extFilter === "all" || p.type === state.extFilter,
  ),
);
let version = 0;
async function loadDetail(id = selected.value) {
  if (!id) return;
  selected.value = id;
  const v = ++version;
  detailLoading.value = true;
  try {
    const d = await api("/ext/status", { query: { id } });
    if (v === version) detail.value = d;
  } finally {
    if (v === version) detailLoading.value = false;
  }
}
function body(p, extra) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    prefix: p.prefix,
    baseUrl: p.baseUrl,
    note: p.note || "",
    enabled: p.enabled,
    models: p.models || [],
    modelMap: p.modelMap || {},
    ...extra,
  };
}
async function update(p, extra, message) {
  await api("/ext/save", { body: body(p, extra) });
  await loadProviders();
  if (selected.value === p.id) await loadDetail();
  notify(message);
}
async function probe(p) {
  const d = await api("/ext/probe", { body: { id: p.id } });
  await loadProviders();
  await loadDetail(p.id);
  notify("目录探测已完成");
  return d;
}
async function remove(p) {
  if (
    !(await confirmAction(
      "删除外部连接",
      `删除「${p.name}」后，该前缀下的模型将不再可用。`,
      "删除连接",
    ))
  )
    return;
  await api("/ext/delete", { body: { id: p.id } });
  if (selected.value === p.id) {
    selected.value = "";
    detail.value = null;
    version++;
  }
  await loadProviders();
  notify("连接已删除");
}
async function quota() {
  const id = selected.value,
    v = version;
  const d = await api("/ext/quota", { query: { id } });
  if (v === version && detail.value) detail.value.quota = d.quota;
  notify("额度已更新");
}
async function test(m) {
  const d = await api("/ext/test", { body: { id: selected.value, model: m } });
  await loadDetail();
  showResult("模型测试结果", d.result);
}
async function testAll() {
  if (testing.value) return;
  const id = selected.value,
    models = detail.value?.models || [];
  testing.value = true;
  cancelTest.value = false;
  testResults.value = [];
  try {
    for (const m of models) {
      if (cancelTest.value) break;
      testProgress.value = `${testResults.value.length + 1} / ${models.length} · ${m.name}`;
      try {
        const d = await api("/ext/test", { body: { id, model: m.name } });
        testResults.value.push({ model: m.name, ...d.result });
      } catch (e) {
        testResults.value.push({ model: m.name, ok: false, msg: e.message });
      }
    }
    if (id === selected.value) await loadDetail();
    notify(cancelTest.value ? "已停止后续测试" : "全部模型测试已完成");
  } finally {
    testing.value = false;
    testProgress.value = "";
  }
}
watch(
  () => state.extFilter,
  () => {
    if (
      selected.value &&
      !providers.value.some((p) => p.id === selected.value)
    ) {
      selected.value = "";
      detail.value = null;
      version++;
    }
  },
);
watch(
  () => state.refreshVersion,
  () => {
    if (state.page === "ext")
      loadDetail().catch((e) => notify(e.message, "error"));
  },
);
onActivated(() => loadProviders().catch((e) => notify(e.message, "error")));
onDeactivated(() => (cancelTest.value = true));
onBeforeUnmount(() => (cancelTest.value = true));
const modelCols = [
  { key: "name", label: "对外模型" },
  { key: "upstream", label: "上游模型" },
  { key: "health", label: "可用状态" },
  { key: "usage", label: "累计 Tokens" },
  { key: "action", label: "操作" },
];
</script>
<template>
  <div class="stack">
    <div class="toolbar">
      <div class="segmented">
        <button
          v-for="(label, id) in {
            all: '全部连接',
            codebuddy: 'CodeBuddy',
            opencode: 'OpenCode',
            qoder: 'Qoder',
            trae: 'Trae',
            custom: '自定义',
          }"
          :key="id"
          :class="{ active: state.extFilter === id }"
          @click="state.extFilter = id"
        >
          {{ label }}
        </button>
      </div>
      <ActionButton :action="loadProviders" icon="refresh" class="small"
        >刷新连接</ActionButton
      >
    </div>
    <section v-if="state.extFilter === 'codebuddy'" class="panel">
      <header class="panel-head">
        <div>
          <h2>CodeBuddy 主反代</h2>
          <p>内置多账号服务，通过统一的 OpenAI 兼容接口提供模型。</p>
        </div>
        <span class="badge success">内置</span>
      </header>
      <div class="panel-body">
        <div class="grid grid-3">
          <div class="plain-stat">
            <span class="label">连接账号</span
            ><strong>{{ state.status?.accounts?.length || 0 }}</strong>
          </div>
          <div class="plain-stat">
            <span class="label">原生模型</span
            ><strong>{{ state.status?.modelsDetail?.length || 0 }}</strong>
          </div>
          <div class="plain-stat">
            <span class="label">运行请求</span
            ><strong>{{ fmt(state.status?.stats?.total) }}</strong>
          </div>
        </div>
        <div class="inline" style="margin-top: 22px">
          <button class="btn primary" @click="go('accounts')">
            <Icon name="users" :size="16" />账号与模型体检</button
          ><button class="btn" @click="go('usage')">
            <Icon name="audio" :size="16" />用量分析
          </button>
        </div>
      </div>
    </section>
    <template v-else
      ><div v-if="providers.length" class="grid grid-3">
        <article
          v-for="p in providers"
          :key="p.id"
          class="provider-card"
          :class="{ active: selected === p.id }"
        >
          <div class="provider-card-top">
            <span
              class="avatar"
              :class="
                {
                  trae: 'orange',
                  qoder: 'purple',
                  opencode: 'accent',
                  custom: 'blue',
                }[p.type]
              "
              ><Icon :name="p.type === 'custom' ? 'globe' : 'box'" :size="22"
            /></span>
            <div>
              <h3>{{ $clean(p.name) }}</h3>
              <p class="mono">{{ p.prefix }} /</p>
            </div>
            <span
              class="badge"
              :class="
                !p.enabled
                  ? ''
                  : p.downUntil > Date.now()
                    ? 'orange'
                    : 'success'
              "
              >{{
                !p.enabled ? "停用" : p.downUntil > Date.now() ? "冷却" : "启用"
              }}</span
            >
          </div>
          <p :title="p.baseUrl">{{ p.baseUrl }}</p>
          <div class="provider-card-meta">
            <span
              >{{ p.models?.length || p.knownModels?.length || 0 }} 个模型</span
            ><span>{{
              {
                custom: "OpenAI 兼容",
                trae: "Trae SOLO",
                qoder: "Qoder",
                opencode: "OpenCode Zen",
              }[p.type] || p.type
            }}</span>
          </div>
          <div class="provider-card-actions">
            <ActionButton
              :action="() => loadDetail(p.id)"
              variant="primary"
              class="small"
              >查看详情</ActionButton
            ><ActionButton
              :action="() => probe(p)"
              class="small"
              icon="activity"
              >探测</ActionButton
            ><button
              class="btn small"
              @click="
                state.modal = {
                  type: 'provider',
                  title: '编辑连接',
                  provider: JSON.parse(JSON.stringify(p)),
                }
              "
            >
              编辑</button
            ><ActionButton
              :action="() => remove(p)"
              class="icon-only"
              variant="ghost"
              icon="trash"
              aria-label="删除连接"
            />
          </div>
        </article>
      </div>
      <section v-else class="panel">
        <EmptyState
          icon="workflow"
          title="让你的模型服务，汇聚于此"
          description="接入 OpenCode、Trae、Qoder，或任何兼容 OpenAI 的服务。"
          ><div class="inline" style="flex-wrap: wrap; justify-content: center">
            <button
              v-for="(label, id) in {
                opencode: 'OpenCode',
                trae: 'Trae SOLO',
                qoder: 'Qoder',
                custom: '自定义 API',
              }"
              :key="id"
              class="btn"
              @click="
                state.modal = {
                  type: 'provider',
                  title: '添加连接',
                  preset: id,
                }
              "
            >
              <Icon name="plus" :size="15" />{{ label }}
            </button>
          </div></EmptyState
        >
      </section></template
    >
    <section v-if="selected && detail" class="panel" :aria-busy="detailLoading">
      <header class="panel-head">
        <div>
          <h2>
            {{ $clean(detail.provider?.name) }}
            <span class="section-slash">/</span
            ><span class="section-en muted">连接详情</span>
          </h2>
          <p>{{ $clean(detail.label) }}</p>
        </div>
        <div class="inline">
          <ActionButton
            :action="() => loadDetail()"
            icon="refresh"
            class="small"
            :disabled="detailLoading"
            >刷新</ActionButton
          ><ActionButton
            :action="
              () =>
                update(
                  detail.provider,
                  { enabled: !detail.provider.enabled },
                  '连接状态已更新',
                )
            "
            :icon="detail.provider.enabled ? 'pause' : 'play'"
            class="small"
            >{{ detail.provider.enabled ? "停用" : "启用" }}</ActionButton
          ><button
            class="icon-button"
            aria-label="关闭连接详情"
            @click="
              selected = '';
              detail = null;
              version++;
            "
          >
            <Icon name="x" :size="17" />
          </button>
        </div>
      </header>
      <div class="panel-body">
        <div
          v-if="detail.policy?.cooling"
          class="info-strip warning"
          style="margin-bottom: 20px"
        >
          <Icon name="clock" :size="17" /><span style="flex: 1"
            >冷却至 {{ dateTime(detail.policy.until) }} ·
            {{ $clean(detail.policy.reason) }}</span
          ><ActionButton
            :action="
              () => update(detail.provider, { clearDown: true }, '冷却已清除')
            "
            class="small"
            >清除冷却</ActionButton
          >
        </div>
        <div class="provider-detail-grid">
          <div>
            <div class="toolbar">
              <h3>账户额度</h3>
              <ActionButton
                :action="quota"
                class="small"
                variant="ghost"
                icon="refresh"
                >刷新额度</ActionButton
              >
            </div>
            <div
              v-for="(line, i) in detail.quota?.lines || []"
              :key="i"
              class="system-metric"
            >
              <span>{{ $clean(line.k) }}</span
              ><b :class="{ 'text-danger': line.bad }">{{ $clean(line.v) }}</b>
            </div>
            <p v-if="!detail.quota?.lines?.length" class="muted text-small">
              上游暂未提供额度信息。
            </p>
            <a
              v-if="detail.provider?.traeLoginUrl"
              class="btn small"
              :href="safeUrl(detail.provider.traeLoginUrl)"
              target="_blank"
              rel="noopener noreferrer"
              style="margin-top: 18px"
              ><Icon name="external" :size="14" />打开 Trae 登录页</a
            >
            <div v-if="detail.provider?.credsSummary" style="margin-top: 15px">
              <details>
                <summary>凭据状态</summary>
                <pre>{{
                  $clean(JSON.stringify(detail.provider.credsSummary, null, 2))
                }}</pre>
              </details>
            </div>
          </div>
          <div>
            <h3 style="margin-bottom: 15px">用量摘要</h3>
            <div
              v-for="(label, id) in {
                today: '今日',
                week: '近 7 天',
                total: '累计',
              }"
              :key="id"
              class="system-metric"
            >
              <span>{{ label }}</span
              ><b
                >{{ fmt(detail.stat?.[id]?.total) }}
                <small
                  >Tokens · {{ fmt(detail.stat?.[id]?.requests) }} 次</small
                ></b
              >
            </div>
            <div class="system-metric">
              <span>累计缓存</span
              ><b
                >{{ fmt(detail.stat?.total?.cached) }} <small>Tokens</small></b
              >
            </div>
            <p class="chart-note">未返回 usage 的请求不会计入用量。</p>
          </div>
        </div>
      </div>
      <div class="panel-head">
        <h2>模型可用性</h2>
        <div class="inline">
          <ActionButton
            :action="() => probe(detail.provider)"
            class="small"
            icon="refresh"
            >刷新目录</ActionButton
          ><ActionButton
            :action="testAll"
            :disabled="testing || !detail.models?.length"
            class="small"
            icon="play"
            >逐个测试全部</ActionButton
          ><button
            v-if="testing"
            class="btn small danger"
            @click="cancelTest = true"
          >
            停止后续测试
          </button>
        </div>
      </div>
      <div v-if="testing" class="info-strip" style="margin: 0 25px 18px">
        <Icon name="loading" class="spin" :size="16" />{{ testProgress }}
      </div>
      <DataTable :columns="modelCols" :rows="detail.models || []" row-key="name"
        ><template #name="{ row }"
          ><span class="mono">{{
            $clean(detail.provider.prefix + "/" + row.name)
          }}</span></template
        ><template #health="{ row }"
          ><span
            class="badge"
            :class="row.health ? (row.health.ok ? 'success' : 'danger') : ''"
            :title="$clean(row.health?.msg)"
            >{{
              !row.health ? "未测试" : row.health.ok ? "可用" : "异常"
            }}</span
          ><span
            v-if="row.health?.latencyMs"
            class="table-sub"
            style="margin-left: 6px"
            >{{ row.health.latencyMs }} ms</span
          ></template
        ><template #usage="{ row }">{{ fmt(row.usage?.total) }}</template
        ><template #action="{ row }"
          ><ActionButton
            :action="() => test(row.name)"
            class="small"
            :disabled="testing"
            >测试模型</ActionButton
          ></template
        ></DataTable
      >
      <div
        v-if="testResults.length"
        class="panel-body"
        style="padding-top: 20px"
      >
        <details>
          <summary>本轮批量测试结果 · {{ testResults.length }} 个模型</summary>
          <pre>{{ $clean(JSON.stringify(testResults, null, 2)) }}</pre>
        </details>
      </div>
      <div class="panel-head"><h2>最近请求</h2></div>
      <RequestTable :rows="detail.recent || []" />
    </section>
  </div>
</template>
