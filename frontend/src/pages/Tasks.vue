<script setup>
import { ref, onActivated, onDeactivated, onBeforeUnmount, watch } from "vue";
import { state, api, notify } from "../store.js";
import { fmt, dateTime } from "../utils.js";
const accounts = ref([]),
  account = ref(""),
  tasks = ref([]),
  school = ref(null),
  result = ref(null),
  queue = ref(null),
  scanned = ref(false);
let timer,
  active = false,
  scanVersion = 0;
const columns = [
  { key: "title", label: "任务" },
  { key: "progress", label: "进度" },
  { key: "reward", label: "奖励" },
  { key: "status", label: "状态" },
  { key: "action", label: "操作" },
];
async function scan() {
  const version = ++scanVersion,
    id = account.value;
  const d = await api("/tasks/list", { query: { id } });
  if (version === scanVersion) {
    tasks.value = d.tasks || [];
    scanned.value = true;
  }
  const sc = await api("/tasks/school", { query: { id }, allowFalse: true });
  if (version === scanVersion) school.value = sc;
}
watch(account, () => {
  scanVersion++;
  tasks.value = [];
  school.value = null;
  result.value = null;
  scanned.value = false;
});
async function run(action, extra = {}) {
  const d = await api("/tasks/" + action, {
    body: { id: account.value, ...extra },
    timeout: 600000,
  });
  result.value = d;
  notify("任务操作已完成");
  await scan();
}
let queueFlight = null;
function queuePoll() {
  clearTimeout(timer);
  if (!active) return Promise.resolve();
  if (queueFlight) return queueFlight;
  queueFlight = (async () => {
    if (!document.hidden) {
      try {
        const next = await api("/tasks/queue", { timeout: 30000 });
        if (active) queue.value = next;
      } catch (e) { if (active) notify(e.message, "error"); }
    }
  })().finally(() => {
    queueFlight = null;
    if (active) timer = setTimeout(queuePoll, queue.value?.running ? 2000 : 15000);
  });
  return queueFlight;
}
async function startQueue(action) {
  await api("/tasks/queue", { body: { action } });
  notify("跨账号任务队列已启动");
  await queuePoll();
}
onActivated(async () => {
  active = true;
  queuePoll();
  try {
    accounts.value = (await api("/tasks/accounts")).accounts || [];
  } catch (e) {
    notify(e.message, "error");
  }
});
onDeactivated(() => {
  active = false;
  clearTimeout(timer);
});
onBeforeUnmount(() => {
  active = false;
  clearTimeout(timer);
});
const name = (id) => accounts.value.find((a) => a.id === id)?.nickname || id;
</script>
<template>
  <div class="stack">
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>账号成长任务</h2>
          <p>按需扫描，查看可领取奖励与可自动完成的任务。</p>
        </div>
        <span class="badge purple">GROWTH</span>
      </header>
      <div class="panel-body">
        <div class="toolbar">
          <div class="inline">
            <UiSelect v-model="account" aria-label="选择任务账号">
              <option value="">当前服务账号</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">
                {{ $clean(a.nickname) }} · {{ a.uid }}
              </option></UiSelect
            ><ActionButton :action="scan" icon="search">扫描任务</ActionButton>
          </div>
          <div class="inline">
            <ActionButton :action="() => run('accept')" icon="check"
              >一键接受</ActionButton
            ><ActionButton :action="() => run('daily')" icon="calendar"
              >一键日常</ActionButton
            ><ActionButton
              :action="() => run('run_all')"
              icon="play"
              variant="primary"
              >执行全部任务</ActionButton
            >
          </div>
        </div>
        <div class="info-strip">
          <Icon
            name="clock"
            :size="17"
          />任务不会自动扫描。选择账号后，点击「扫描任务」拉取最新进度。
        </div>
      </div>
      <DataTable
        v-if="scanned"
        :columns="columns"
        :rows="tasks"
        row-key="code"
        empty="该账号暂无成长任务"
        ><template #title="{ row }"
          ><strong>{{ $clean(row.title || row.name || row.code) }}</strong>
          <div class="table-sub mono">{{ row.code }}</div></template
        ><template #progress="{ row }"
          ><div class="task-progress">
            <span>{{ row.current || 0 }} / {{ row.target || 0 }}</span>
            <div class="progress-track">
              <div
                class="progress-fill"
                :style="{
                  width:
                    Math.min(
                      100,
                      ((row.current || 0) / (row.target || 1)) * 100,
                    ) + '%',
                }"
              ></div>
            </div></div></template
        ><template #reward="{ row }"
          ><span class="text-success">{{
            row.credit ? "+" + fmt(row.credit) + " 积分" : ""
          }}</span>
          <div class="table-sub" v-if="row.energy">
            +{{ row.energy }} 能量
          </div></template
        ><template #status="{ row }"
          ><span
            class="badge"
            :class="row.claimed ? 'success' : row.claimable ? 'orange' : ''"
            >{{
              row.claimed
                ? "已领取"
                : row.claimable
                  ? "可领取"
                  : row.locked
                    ? "未解锁"
                    : row.acceptStatus === "accepted"
                      ? "进行中"
                      : "待接受"
            }}</span
          ></template
        ><template #action="{ row }"
          ><ActionButton
            v-if="row.claimable && !row.claimed"
            :action="() => run('claim', { code: row.code, mp: !!row.mp })"
            class="small"
            variant="primary"
            >领取奖励</ActionButton
          ><ActionButton
            v-else-if="row.autoKind && !row.claimed && !row.locked"
            :action="() => run('auto', { code: row.code, mp: !!row.mp })"
            class="small"
            >自动完成</ActionButton
          ><span v-else class="muted">—</span></template
        ></DataTable
      ><EmptyState
        v-else
        icon="checks"
        title="准备好，开始今天的成长"
        description="扫描账号任务，集中查看进度和奖励。"
      />
    </section>
    <section v-if="result" class="panel">
      <header class="panel-head">
        <h2>执行结果</h2>
        <button
          class="icon-button"
          aria-label="收起执行结果"
          @click="result = null"
        >
          <Icon name="x" :size="16" />
        </button>
      </header>
      <div class="panel-body">
        <div
          v-for="(r, i) in result.steps || result.results || []"
          :key="i"
          class="step-row"
          :class="{ fail: r.ok === false }"
        >
          <Icon :name="r.ok === false ? 'error' : 'check'" :size="15" />
          <div>
            <strong>{{ $clean(r.name || r.code || r.title) }}</strong>
            {{ $clean(r.msg || r.message || "") }}
          </div>
        </div>
        <details>
          <summary>完整结果</summary>
          <pre>{{ $clean(JSON.stringify(result, null, 2)) }}</pre>
        </details>
      </div>
    </section>
    <section v-if="school" class="panel">
      <header class="panel-head">
        <div>
          <h2>开学季活动</h2>
          <p>随账号任务扫描同步更新</p>
        </div>
      </header>
      <div class="panel-body">
        <div class="info-strip">
          <Icon name="calendar" :size="18" /><span>{{
            !school.ok
              ? school.message
              : !school.inPeriod
                ? "当前活动已结束"
                : "活动进行中 · " +
                  (school.tasks?.length || 0) +
                  " 个活动任务 · 剩余抽奖机会 " +
                  (school.chances ?? "—")
          }}</span>
        </div>
        <details v-if="school.tasks?.length" style="margin-top: 16px">
          <summary>查看活动任务</summary>
          <pre>{{ $clean(JSON.stringify(school.tasks, null, 2)) }}</pre>
        </details>
      </div>
    </section>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>跨账号执行队列</h2>
          <p>逐账号运行任务，离开页面后服务器继续执行。</p>
        </div>
        <span class="badge" :class="queue?.running ? 'orange' : 'outline'">{{
          queue?.running ? "执行中" : "就绪"
        }}</span>
      </header>
      <div class="panel-body">
        <div class="inline" style="flex-wrap: wrap">
          <ActionButton
            :action="() => startQueue('daily')"
            :disabled="queue?.running"
            icon="calendar"
            >全账号一键日常</ActionButton
          ><ActionButton
            :action="() => startQueue('tasks')"
            :disabled="queue?.running"
            icon="workflow"
            variant="primary"
            >全账号执行任务</ActionButton
          ><ActionButton :action="queuePoll" icon="refresh" variant="ghost"
            >刷新队列</ActionButton
          >
        </div>
        <div v-if="queue?.items?.length" style="margin-top: 20px">
          <div class="inline-note">
            开始时间 {{ dateTime(queue.startedAt) }} ·
            {{ queue.items.filter((i) => i.status === "done").length }} /
            {{ queue.items.length }} 完成
          </div>
          <article
            class="queue-item"
            v-for="item in queue.items"
            :key="item.id"
          >
            <div class="queue-item-head">
              <strong>{{ $clean(name(item.id)) }}</strong
              ><span
                class="badge"
                :class="
                  item.status === 'done'
                    ? 'success'
                    : item.status === 'running'
                      ? 'orange'
                      : item.status === 'error'
                        ? 'danger'
                        : ''
                "
                >{{
                  {
                    done: "已完成",
                    running: "执行中",
                    pending: "等待中",
                    error: "失败",
                    failed: "失败",
                  }[item.status] || item.status
                }}</span
              >
            </div>
            <div
              v-for="(step, i) in item.steps || []"
              :key="i"
              class="step-row"
              :class="{ fail: !step.ok }"
            >
              <Icon :name="step.ok ? 'check' : 'error'" :size="14" /><span
                >{{ $clean(step.name) }} · {{ $clean(step.msg) }}</span
              >
            </div>
          </article>
        </div>
        <EmptyState
          v-else
          icon="workflow"
          title="队列中暂无任务"
          description="启动全账号任务，处理过程会在这里实时更新。"
        />
      </div>
    </section>
  </div>
</template>
