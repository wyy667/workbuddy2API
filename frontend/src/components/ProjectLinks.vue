<script setup>
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import { api } from '../store.js';

const repository = 'https://github.com/wyy667/workbuddy2API';
const version = ref(''), busy = ref(false), result = ref(null), error = ref('');
const resultElement = ref(null);
watch([result, error], async () => {
  await nextTick();
  if (alive && (result.value || error.value)) resultElement.value?.scrollIntoView({ block: 'nearest' });
});
const controller = new AbortController();
let alive = true;
async function loadVersion() {
  try {
    const data = await api('/project/version', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    if (alive) version.value = data.version;
  } catch { if (alive) error.value = '版本读取失败，可点击检查更新重试。'; }
}
async function checkUpdate() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  result.value = null;
  try {
    const data = await api('/project/check-update', { body: {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    if (!alive) return;
    version.value = data.version;
    result.value = data;
  } catch (e) { if (alive) error.value = e.message; }
  finally { if (alive) busy.value = false; }
}
onMounted(loadVersion);
onBeforeUnmount(() => { alive = false; controller.abort(); });
</script>

<template>
  <section class="nav-group project-links" aria-label="workbuddy2API 项目信息">
    <div class="nav-label">workbuddy2API</div>
    <a class="nav-link" :href="repository" target="_blank" rel="noopener noreferrer">
      <Icon name="code" :size="18" /><span>GitHub 项目</span><Icon name="external" :size="13" class="nav-arrow" />
    </a>
    <div class="nav-link project-version"><Icon name="box" :size="18" /><span>当前版本</span><span class="project-version-value">{{ version ? `v${version}` : error ? '未获取' : '读取中' }}</span></div>
    <button class="nav-link project-check" :disabled="busy" @click="checkUpdate">
      <Icon :name="busy ? 'loading' : 'refresh'" :size="18" :class="{ 'project-spin': busy }" /><span>{{ busy ? '正在检查更新' : '检查更新' }}</span>
      <span v-if="result?.status === 'available'" class="project-update-dot"></span>
    </button>
    <div v-if="result || error" ref="resultElement" class="project-update-result" role="status" aria-live="polite">
      <template v-if="error">{{ error }}</template>
      <template v-else-if="result.status === 'error'">{{ result.message }}</template>
      <template v-else-if="result.status === 'available'">
        <strong>发现新版本 v{{ result.latestVersion }}</strong>
        <a :href="repository + '/blob/main/README-deploy.md#8-升级现有服务'" target="_blank" rel="noopener noreferrer">查看更新说明 <Icon name="arrowUpRight" :size="12" /></a>
      </template>
      <template v-else-if="result.status === 'ahead'">当前版本领先于 GitHub 主分支。</template>
      <template v-else>已是最新版本 v{{ result.latestVersion }}</template>
      <small v-if="result">检查时间 {{ new Date(result.checkedAt).toLocaleTimeString() }}</small>
    </div>
  </section>
</template>

<style scoped>
.project-links { border-top: 1px solid #ffffff12; padding-top: 20px; }
.project-version { cursor: default; }
.project-version:hover { transform: none; background: transparent; }
.project-version-value { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; color: #d5decf; }
.project-check { width: 100%; text-align: left; color: inherit; }
.project-check:disabled { opacity: .65; cursor: wait; }
.project-update-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--side-active); margin-left: auto; }
.project-update-result { margin: 8px 10px 0; padding: 12px; border: 1px solid #ffffff14; border-radius: 8px; background: #ffffff05; color: #d5decf; font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
.project-update-result strong, .project-update-result small { display: block; }
.project-update-result small { opacity: .6; margin-top: 5px; }
.project-update-result a { display: inline-flex; gap: 5px; align-items: center; text-decoration: underline; text-underline-offset: 3px; }
.project-spin { animation: project-spin 1.2s linear infinite; }
@keyframes project-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .project-spin { animation: none; } }
</style>
