<script setup>
import { computed, defineAsyncComponent, ref } from "vue";
import { Globe2, Power } from "lucide-vue-next";
import { state, api, notify } from "../store.js";
const RequestMap = defineAsyncComponent(() => import("./RequestMap.vue"));
const pending = ref(false);
const enabled = computed(
  () => !!state.status && state.status.settings?.requestMapEnabled !== false,
);
function disabled() {
  if (state.status) {
    state.status.settings ||= {};
    state.status.settings.requestMapEnabled = false;
  }
}
async function toggle(value) {
  if (pending.value) return;
  pending.value = true;
  try {
    const result = await api("/request-map/settings", {
      body: { enabled: value },
    });
    state.status.settings ||= {};
    state.status.settings.requestMapEnabled = result.enabled;
    notify(value ? "实时地图已开启" : "地图已关闭，定位进程和缓存已释放");
  } catch (e) {
    notify(e.message, "error");
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <section v-if="!state.status" class="panel map-disabled-panel" role="status">正在读取地图设置…</section>
  <RequestMap
    v-else-if="enabled"
    :disabling="pending"
    @disable="toggle(false)"
    @disabled="disabled"
  />
  <section v-else class="panel map-disabled-panel" aria-label="实时地图开关">
    <span class="map-disabled-icon"><Globe2 :size="22" /></span>
    <div>
      <h2>实时请求地图 <span>已关闭</span></h2>
      <p>定位进程、请求追踪与动画已停用。开启后展示新发起的请求。</p>
    </div>
    <button
      class="btn"
      :disabled="pending || !state.status"
      @click="toggle(true)"
    >
      <Power :size="15" />{{ pending ? "正在开启…" : "开启地图" }}
    </button>
  </section>
</template>
<style scoped>
.map-disabled-panel {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 22px 24px;
}
.map-disabled-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--surface-subtle);
  color: var(--muted);
}
h2 {
  font-size: 14px;
}
h2 span {
  font-size: 10px;
  font-weight: 400;
  margin-left: 9px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted);
}
p {
  font-size: 11px;
  color: var(--muted);
  margin-top: 6px;
}
.btn {
  margin-left: auto;
  flex: none;
}
@media (max-width: 700px) {
  .map-disabled-panel {
    flex-wrap: wrap;
    padding: 18px;
  }
  .map-disabled-icon {
    display: none;
  }
}
</style>
