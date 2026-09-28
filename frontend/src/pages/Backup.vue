<script setup>
import { ref, watch, onActivated } from "vue";
import {
  state,
  api,
  apiUrl,
  authHeaders,
  confirmAction,
  refresh,
  saveSettings,
  notify,
} from "../store.js";
import { download, dateTime } from "../utils.js";
const backupStatus = ref(null),
  at = ref("05:30"),
  file = ref(null),
  payload = ref(null),
  busy = ref(false);
let initialized = false;
watch(
  () => state.status,
  (s) => {
    if (s && !initialized) {
      at.value = s.settings?.backupAt || "05:30";
      initialized = true;
    }
  },
  { immediate: true },
);
async function load() {
  backupStatus.value = await api("/backup/status");
}
async function exportBackup() {
  const r = await fetch(apiUrl("/backup"), { headers: authHeaders(), credentials: "same-origin" });
  if (!r.ok) throw Error("备份下载失败");
  const d = await r.json();
  if (!d.accounts) throw Error("备份响应缺少账号数据");
  download(
    JSON.stringify(d, null, 2),
    "workbuddy-backup-" + new Date().toISOString().slice(0, 10) + ".json",
  );
  notify("备份已下载");
}
async function selectFile(e) {
  const f = e.target.files?.[0];
  file.value = null;
  payload.value = null;
  if (!f) return;
  try {
    const d = JSON.parse(await f.text()),
      p = d.payload || d;
    if (
      !p.accounts ||
      typeof p.accounts !== "object" ||
      Array.isArray(p.accounts)
    )
      throw Error("不是有效的 WorkBuddy 备份：缺少 accounts");
    file.value = f;
    payload.value = d;
  } catch (error) {
    notify(error.message, "error");
  } finally {
    e.target.value = "";
  }
}
async function restore() {
  if (!payload.value) return;
  if (
    !(await confirmAction(
      "从备份恢复数据",
      `将导入「${file.value.name}」中的 ${Object.keys((payload.value.payload || payload.value).accounts).length} 个账号，并恢复文件中包含的用量、签到、附加密钥、服务商、设置和轮换配置。同名账号及已包含的配置会被覆盖。备份含登录凭据，请仅导入可信文件。`,
      "恢复备份",
    ))
  )
    return;
  const d = await api("/restore", { body: payload.value });
  await refresh();
  notify(`已恢复 ${d.restored} 个账号`);
  file.value = null;
  payload.value = null;
}
async function runBackup() {
  const d = await api("/backup/run", { body: {} });
  await load();
  await refresh();
  notify(d.message || "服务器备份已生成");
}
onActivated(() => load().catch((e) => notify(e.message, "error")));
</script>
<template>
  <div class="stack">
    <div class="grid grid-2">
      <section class="panel backup-card">
        <span class="backup-icon"><Icon name="download" :size="26" /></span>
        <h2>把安心，保存在本地。</h2>
        <p>
          导出账号、用量、签到、密钥、服务商及工作空间设置，可用于迁移或恢复。
        </p>
        <ActionButton :action="exportBackup" variant="primary" icon="download"
          >下载完整备份</ActionButton
        >
        <div class="divider"></div>
        <div class="inline-note">
          <Icon name="shield" :size="14" /> 备份包含账号凭据，请存放在可信位置。
        </div>
      </section>
      <section class="panel backup-card restore">
        <span class="backup-icon"><Icon name="upload" :size="26" /></span>
        <h2>随时回到熟悉的状态。</h2>
        <p>选择之前导出的 JSON 备份，检查文件后即可恢复到当前工作空间。</p>
        <label class="restore-zone"
          ><Icon :name="file ? 'file' : 'upload'" :size="23" /><span>{{
            file ? file.name : "选择备份文件"
          }}</span
          ><small>{{
            file
              ? Math.round(file.size / 1024) + " KB · 已验证基本格式"
              : "支持 WorkBuddy JSON 备份"
          }}</small
          ><input
            type="file"
            accept=".json,application/json"
            aria-label="选择备份文件"
            @change="selectFile" /></label
        ><ActionButton
          v-if="payload"
          :action="restore"
          icon="database"
          variant="primary"
          style="margin-top: 15px; width: 100%"
          >恢复此备份</ActionButton
        >
      </section>
    </div>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>自动备份</h2>
          <p>
            服务器每日定时保存，滚动保留最近 {{ backupStatus?.keep || 7 }} 份。
          </p>
        </div>
        <ActionButton :action="runBackup" icon="database"
          >立即备份到服务器</ActionButton
        >
      </header>
      <div class="panel-body">
        <div class="toolbar">
          <div class="inline">
            <label for="backup-time" class="text-small">每日备份时间</label
            ><input
              id="backup-time"
              type="time"
              v-model="at"
              style="width: 125px"
            /><ActionButton
              :action="
                async () => {
                  await saveSettings({ backupAt: at });
                  await load();
                }
              "
              variant="primary"
              icon="check"
              >保存时间</ActionButton
            >
          </div>
          <span class="inline-note"
            >最近备份：{{
              dateTime(
                backupStatus?.last?.at ||
                  state.status?.settings?.autoBackupLast?.at,
              )
            }}</span
          >
        </div>
        <div
          v-for="(name, i) in backupStatus?.files || []"
          :key="name"
          class="backup-file-row"
        >
          <span
            class="avatar"
            style="width: 32px; height: 32px; border-radius: 8px"
            ><Icon name="file" :size="16" /></span
          ><span class="mono">{{ $clean(name) }}</span
          ><span v-if="i === 0" class="badge success">最新</span
          ><span v-else class="badge outline">已保存</span>
        </div>
        <EmptyState
          v-if="!backupStatus?.files?.length"
          icon="database"
          title="暂无服务器备份"
          description="点击立即备份，或等待下一次自动任务。"
        />
      </div>
    </section>
    <div class="info-strip">
      <Icon name="database" :size="17" /><span
        >完整备份包含附加密钥和外部平台登录凭据，请妥善保存。服务器环境变量、主密钥及地理数据库不包含在内；旧版备份缺少的配置会保留当前值。</span
      >
    </div>
  </div>
</template>
