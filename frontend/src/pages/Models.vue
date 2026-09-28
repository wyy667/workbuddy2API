<script setup>
import { ref, computed, onActivated } from "vue";
import ModelLogo from "../components/ModelLogo.vue";
import { state, mutate, copy, loadProviders, notify } from "../store.js";
import { vendor, dateTime, readPreference, savePreference } from "../utils.js";
const search = ref(""),
  group = ref(readPreference("modelVendor", "全部")),
  source = ref("all"),
  page = ref(1);
const models = computed(() => {
  const all = (state.status?.modelsDetail || []).map((m) => ({
    ...m,
    name: m.name || m.id,
    source: "codebuddy",
    vendor: vendor(m.id),
  }));
  for (const p of state.providers) {
    const names = p.models?.length ? p.models : p.knownModels || [];
    for (const m of [...new Set([...names, ...Object.keys(p.modelMap || {})])])
      all.push({
        id: p.prefix + "/" + m,
        name: m,
        source: p.type,
        vendor: vendor(m),
        tags: [p.name],
        disabled: !p.enabled,
      });
  }
  return [...new Map(all.map((m) => [m.id, m])).values()];
});
const vendors = computed(() => [
  "全部",
  ...new Set(models.value.map((m) => m.vendor)),
]);
const filtered = computed(() =>
  models.value.filter(
    (m) =>
      (group.value === "全部" || m.vendor === group.value) &&
      (source.value === "all" || m.source === source.value) &&
      (m.id + " " + m.name).toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const shown = computed(() => filtered.value.slice(0, page.value * 24));
onActivated(() => loadProviders().catch((e) => notify(e.message, "error")));
async function refreshModels() {
  await mutate("/models/refresh", {}, "模型目录已更新");
  await loadProviders();
}
function setGroup(g) {
  group.value = g;
  page.value = 1;
  savePreference("modelVendor", g);
}
</script>
<template>
  <div class="stack">
    <div class="toolbar">
      <div class="search-input">
        <Icon name="search" :size="16" /><input
          v-model="search"
          aria-label="搜索模型"
          placeholder="搜索模型名称、系列…"
          @input="page = 1"
        />
      </div>
      <div class="inline">
        <UiSelect v-model="source" aria-label="模型平台筛选">
          <option value="all">全部来源</option>
          <option value="codebuddy">CodeBuddy</option>
          <option value="opencode">OpenCode</option>
          <option value="qoder">Qoder</option>
          <option value="trae">Trae</option>
          <option value="custom">自定义反代</option></UiSelect
        ><ActionButton :action="refreshModels" icon="refresh"
          >更新模型目录</ActionButton
        >
      </div>
    </div>
    <div class="toolbar">
      <div class="model-vendor-filter">
        <button
          v-for="v in vendors"
          :key="v"
          :class="{ active: group === v }"
          @click="setGroup(v)"
        >
          <ModelLogo v-if="v !== '全部'" :vendor="v" compact />{{
            v === "Hunyuan" ? "混元" : v
          }}
          <span class="muted">{{
            v === "全部"
              ? models.length
              : models.filter((m) => m.vendor === v).length
          }}</span>
        </button>
      </div>
      <span class="muted text-small">{{ filtered.length }} 个模型</span>
    </div>
    <div v-if="shown.length" class="model-grid">
      <article v-for="m in shown" :key="m.id" class="model-card">
        <div class="model-card-header">
          <ModelLogo :vendor="m.vendor" />
          <span class="badge outline">{{
            m.vendor === "Hunyuan" ? "混元 · Hunyuan" : m.vendor
          }}</span>
        </div>
        <h3>{{ $clean(m.name) }}</h3>
        <div class="model-id mono">{{ $clean(m.id) }}</div>
        <div class="model-tags">
          <span
            class="badge"
            :class="m.source === 'codebuddy' ? '' : 'purple'"
            >{{ m.source === "codebuddy" ? "原生直连" : "聚合模型" }}</span
          ><span v-for="t in m.tags || []" :key="String(t)" class="badge">{{
            $clean(typeof t === "string" ? t : t.name || t.label || "")
          }}</span
          ><span v-if="m.disabled" class="badge orange">连接已停用</span>
        </div>
        <div class="model-card-footer">
          <span class="model-rate">{{
            m.credits != null && m.credits !== ""
              ? "× " + String(m.credits).replace(/^x/i, "")
              : "按上游计费"
          }}</span
          ><button
            class="icon-button"
            :aria-label="'复制模型名称 ' + $clean(m.id)"
            @click="copy(m.id)"
          >
            <Icon name="copy" :size="15" /></button
          ><button
            class="icon-button"
            :aria-label="'查看调用代码 ' + $clean(m.id)"
            @click="
              state.modal = { type: 'snippet', title: '调用模型', model: m.id }
            "
          >
            <Icon name="code" :size="17" />
          </button>
        </div>
      </article>
    </div>
    <section v-else class="panel">
      <EmptyState
        icon="box"
        title="没有匹配的模型"
        description="尝试更换平台、厂商或搜索关键词。外部模型可在连接页探测后获取。"
      />
    </section>
    <div v-if="shown.length < filtered.length" style="text-align: center">
      <button class="btn" @click="page++">
        加载更多模型 <Icon name="chevronDown" :size="15" />
      </button>
    </div>
    <div class="info-strip">
      <Icon name="clock" :size="16" /><span
        >CodeBuddy 目录更新于
        {{
          dateTime(state.status?.modelsFetchedAt)
        }}。倍率与活动信息来自上游目录，实际积分以返回用量为准。</span
      >
    </div>
  </div>
</template>
