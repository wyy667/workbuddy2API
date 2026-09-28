<script setup>
import { ref, computed, onMounted } from "vue";
import { state, api, loadCheckup, mutate, notify } from "../store.js";
import { dateTime, vendor, readPreference, savePreference } from "../utils.js";
const model = ref(""),
  account = ref(""),
  search = ref(""),
  failed = ref(readPreference("healthFailed", false)),
  group = ref("全部");
const cols = computed(() =>
  (state.checkup?.accounts || []).filter(
    (a) => !account.value || a.id === account.value,
  ),
);
const models = computed(() =>
  (state.checkup?.models || []).filter(
    (m) =>
      m.toLowerCase().includes(search.value.toLowerCase()) &&
      (group.value === "全部" || vendor(m) === group.value) &&
      (!failed.value || cols.value.some((a) => !result(a, m)?.ok)),
  ),
);
const groups = computed(() => [
  "全部",
  ...new Set((state.checkup?.models || []).map(vendor)),
]);
const result = (a, m) => state.checkup?.results?.[a.uid + "|" + m];
const rate = computed(() => {
  const all = cols.value.length * models.value.length;
  const good = models.value.reduce(
    (sum, m) => sum + cols.value.filter((a) => result(a, m)?.ok).length,
    0,
  );
  return all ? Math.round((good / all) * 100) : 0;
});
async function scan(one = false) {
  if (one && !model.value) throw Error("请先选择要体检的模型");
  state.checkup = await api("/checkup", {
    body: one ? { model: model.value } : {},
    timeout: 600000,
  });
  notify("模型体检已完成");
}
onMounted(() => loadCheckup().catch((e) => notify(e.message, "error")));
</script>
<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h2>模型健康矩阵</h2>
        <p>
          {{
            state.checkup?.at
              ? "上次体检 " + dateTime(state.checkup.at)
              : "探测账号与模型的可用性"
          }}
          <span v-if="models.length"> · 当前通过率 {{ rate }}%</span>
        </p>
      </div>
      <ActionButton :action="() => scan()" icon="shield"
        >体检全部模型</ActionButton
      >
    </header>
    <div class="health-toolbar">
      <UiSelect v-model="model" aria-label="选择体检模型">
        <option value="">选择模型</option>
        <option
          v-for="m in state.status?.modelsDetail || []"
          :key="m.id"
          :value="m.id"
        >
          {{ $clean(m.id) }}
        </option></UiSelect
      ><ActionButton
        :action="() => scan(true)"
        icon="activity"
        :disabled="!model"
        class="small"
        >体检所选模型</ActionButton
      ><ActionButton
        :action="() => mutate('/models/refresh', {}, '模型目录已更新')"
        icon="refresh"
        class="small"
        >更新目录</ActionButton
      >
    </div>
    <div class="health-toolbar">
      <input
        v-model="search"
        aria-label="搜索体检结果"
        placeholder="搜索模型结果"
      /><UiSelect v-model="account" aria-label="体检账号筛选">
        <option value="">全部账号</option>
        <option
          v-for="a in state.checkup?.accounts || []"
          :key="a.id"
          :value="a.id"
        >
          {{ $clean(a.nickname) }}
        </option></UiSelect
      ><UiSelect v-model="group" aria-label="体检模型分组">
        <option v-for="g in groups" :key="g">{{ g }}</option></UiSelect
      ><label class="checkbox"
        ><input
          type="checkbox"
          v-model="failed"
          @change="savePreference('healthFailed', failed)"
        />仅异常 / 未测</label
      >
    </div>
    <div v-if="models.length && cols.length" class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>模型</th>
            <th v-for="a in cols" :key="a.id">
              {{ $clean(a.nickname || a.uid) }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in models" :key="m">
            <td class="mono">{{ $clean(m) }}</td>
            <td v-for="a in cols" :key="a.id">
              <span
                class="health-cell"
                :class="{ fail: result(a, m) && !result(a, m).ok }"
                :title="$clean(result(a, m)?.msg)"
                ><Icon
                  :name="
                    result(a, m)?.ok ? 'check' : result(a, m) ? 'x' : 'circle'
                  "
                  :size="14"
                />{{
                  result(a, m)?.ok
                    ? "可用"
                    : result(a, m)?.kind === "capped"
                      ? "限额"
                      : result(a, m)?.kind === "blocked403"
                        ? "403 受限"
                        : result(a, m)
                          ? "异常"
                          : "未测"
                }}<small v-if="result(a, m)?.until"
                  >至 {{ dateTime(result(a, m).until) }}</small
                ></span
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <EmptyState
      v-else
      icon="shield"
      title="暂无匹配的体检结果"
      description="选择模型或执行全量体检，查看每个账号的可用状态。"
    />
    <div class="model-limit-note">
      体检会向上游发送最小探测请求。完整体检可能需要几分钟，执行中请保持页面打开。
    </div>
  </section>
</template>
