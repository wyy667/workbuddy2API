<script setup>
import { ref, reactive, computed, watch, onActivated } from "vue";
import {
  state,
  accounts,
  api,
  mutate,
  loadCredits,
  confirmAction,
  saveSettings,
  notify,
  showResult,
} from "../store.js";
import {
  fmt,
  dateTime,
  duration,
  readPreference,
  savePreference,
} from "../utils.js";
import HealthMatrix from "../components/HealthMatrix.vue";
const tab = ref("accounts"),
  view = ref(readPreference("accountView", "grid")),
  search = ref(""),
  settingsOpen = ref(false);
const settings = reactive({
    pollMin: 30,
    paidRoute: "expire",
    keepaliveEveryDays: 1,
    keepaliveAt: "06:00",
  }),
  rotation = ref(0);
let initialized = false;
watch(
  () => state.status,
  (s) => {
    if (s && !initialized) {
      Object.assign(settings, s.settings);
      rotation.value = s.rotation?.enabled ? s.rotation.intervalMin : 0;
      initialized = true;
    }
  },
  { immediate: true },
);
const pool = computed(() => state.status?.pool || []);
const list = computed(() =>
  (tab.value === "pool" ? pool.value : accounts.value).filter((a) =>
    [a.nickname, a.uid, a.siteLabel]
      .join(" ")
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const creditOf = (a) => state.credits.find((c) => c.id === a.id);
const balance = (a) => creditOf(a)?.totalLeft ?? a.balance;
const label = (a) =>
  a.flag403
    ? "观察池"
    : a.blockedUntil > Date.now()
      ? "暂时冷却"
      : a.serving
        ? "服务中"
        : a.checkinOnly
          ? "仅签到"
          : a.expiresSec <= 0
            ? "凭据过期"
            : "待命";
const tone = (a) =>
  a.flag403 || a.expiresSec <= 0
    ? "danger"
    : a.blockedUntil > Date.now()
      ? "orange"
      : a.serving
        ? "success"
        : "";
async function switchAccount(a) {
  if (
    a.checkinOnly &&
    !(await confirmAction(
      "临时启用签到账号",
      "该账号将临时参与服务，默认账号保持不变。重启或恢复默认后失效。",
      "临时启用",
    ))
  )
    return;
  await mutate(
    "/account/switch",
    { id: a.id, temporary: !!a.checkinOnly },
    "服务账号已切换",
  );
}
async function remove(a) {
  if (
    await confirmAction(
      "删除账号存档",
      `将删除「${a.nickname}」的账号凭据。${a.active ? "当前默认账号会被清除，服务可能暂停。" : "此操作无法撤销。"}`,
      "删除账号",
    )
  )
    await mutate("/account/delete", { id: a.id }, "账号已删除");
}
async function poolAction(a, action) {
  const d = await mutate(
    "/pool/" + action,
    { id: a.id },
    action === "release" ? "账号已移出观察池" : "观察池体检已完成",
  );
  if (action === "checkup") showResult("账号体检结果", d);
}
async function save() {
  await saveSettings(settings);
  await mutate(
    "/rotation/set",
    {
      enabled: Number(rotation.value) > 0,
      intervalMin: Number(rotation.value) || 30,
    },
    "轮换策略已保存",
  );
}
const cols = [
  { key: "account", label: "账号" },
  { key: "balance", label: "可用积分" },
  { key: "status", label: "状态" },
  { key: "expiry", label: "凭据有效期" },
  { key: "actions", label: "操作" },
];
onActivated(() => loadCredits().catch((e) => notify(e.message, "error")));
</script>
<template>
  <div class="stack">
    <div class="toolbar">
      <div class="segmented">
        <button
          :class="{ active: tab === 'accounts' }"
          @click="tab = 'accounts'"
        >
          服务账号
          <span class="account-tab-count">{{ accounts.length }}</span></button
        ><button :class="{ active: tab === 'pool' }" @click="tab = 'pool'">
          观察池 <span class="account-tab-count">{{ pool.length }}</span>
        </button>
      </div>
      <div class="inline">
        <ActionButton :action="() => loadCredits(true)" icon="refresh"
          >刷新积分</ActionButton
        ><button
          class="btn"
          :class="{ primary: settingsOpen }"
          @click="settingsOpen = !settingsOpen"
        >
          <Icon name="settings" :size="16" />运行策略
        </button>
      </div>
    </div>
    <section v-if="settingsOpen" class="panel">
      <header class="panel-head">
        <div>
          <h2>运行策略</h2>
          <p>自动轮换、余额巡检与凭据保活</p>
        </div>
        <span class="badge outline">自动化</span>
      </header>
      <div class="panel-body">
        <div class="settings-grid">
          <label class="field"
            >计费模型选号<UiSelect v-model="settings.paidRoute">
              <option value="expire">优先积分最早到期</option>
              <option value="balance">优先余额最多</option>
            </UiSelect></label
          ><label class="field"
            >积分巡检间隔 / 分钟<input
              type="number"
              min="5"
              max="1440"
              v-model.number="settings.pollMin" /></label
          ><label class="field"
            >定时轮换<UiSelect v-model.number="rotation">
              <option :value="0">关闭自动轮换</option>
              <option :value="15">每 15 分钟</option>
              <option :value="30">每 30 分钟</option>
              <option :value="60">每 60 分钟</option>
              <option :value="120">每 120 分钟</option>
            </UiSelect></label
          ><label class="field"
            >凭据刷新周期<UiSelect v-model.number="settings.keepaliveEveryDays">
              <option v-for="n in [1, 2, 3, 7, 14, 30]" :key="n" :value="n">
                每 {{ n }} 天
              </option>
            </UiSelect></label
          ><label class="field"
            >凭据刷新时间<input type="time" v-model="settings.keepaliveAt"
          /></label>
        </div>
        <div class="settings-footer">
          <span class="inline-note"
            >下次轮换：{{ dateTime(state.status?.rotation?.nextAt) }}</span
          >
          <div class="inline">
            <ActionButton
              :action="() => mutate('/rotation/now', {}, '轮换已执行')"
              icon="switch"
              >立即轮换</ActionButton
            ><ActionButton
              :action="
                async () =>
                  showResult(
                    '凭据刷新结果',
                    await mutate('/keepalive', {}, '凭据刷新已完成'),
                  )
              "
              icon="refresh"
              >刷新全部凭据</ActionButton
            ><ActionButton :action="save" variant="primary" icon="check"
              >保存策略</ActionButton
            >
          </div>
        </div>
      </div>
    </section>
    <div v-if="state.status?.servingOverride" class="info-strip warning">
      <Icon name="alert" /><span style="flex: 1"
        >当前使用临时服务账号，默认账号保持不变。</span
      ><ActionButton
        :action="() => mutate('/account/restore-default', {}, '已恢复默认账号')"
        class="small"
        >恢复默认</ActionButton
      >
    </div>
    <div v-if="tab === 'pool'" class="info-strip">
      <Icon name="shield" /><span
        >受限账号在此暂停服务与签到。可以手动体检或移出观察池；未恢复账号按服务端策略自动清理。</span
      >
    </div>
    <div class="toolbar">
      <div class="search-input">
        <Icon name="search" :size="16" /><input
          v-model="search"
          aria-label="搜索账号"
          placeholder="搜索昵称、UID 或区域"
        />
      </div>
      <div class="segmented">
        <button
          :class="{ active: view === 'grid' }"
          aria-label="卡片视图"
          @click="
            view = 'grid';
            savePreference('accountView', view);
          "
        >
          <Icon name="grid" :size="15" /></button
        ><button
          :class="{ active: view === 'table' }"
          aria-label="表格视图"
          @click="
            view = 'table';
            savePreference('accountView', view);
          "
        >
          <Icon name="list" :size="15" />
        </button>
      </div>
    </div>
    <div v-if="list.length && view === 'grid'" class="account-grid">
      <article
        v-for="(a, i) in list"
        :key="a.id"
        class="account-card"
        :class="{ serving: a.serving }"
      >
        <div class="account-card-head">
          <span
            class="avatar"
            :class="['accent', 'purple', 'orange', 'blue'][i % 4]"
            >{{
              $clean(a.nickname || a.uid)
                .slice(0, 1)
                .toUpperCase()
            }}</span
          >
          <div>
            <h3>{{ $clean(a.nickname) }}</h3>
            <p>{{ $clean(a.siteLabel) }} · {{ a.uid }}</p>
          </div>
          <span class="badge" :class="tone(a)">{{ label(a) }}</span>
        </div>
        <div class="account-balance">
          {{ balance(a) == null ? "—" : fmt(balance(a)) }}<span>可用积分</span>
        </div>
        <div class="account-details">
          <span>登录凭据</span
          ><span>{{ a.expiresSec ? duration(a.expiresSec) : "已过期" }}</span>
        </div>
        <div class="account-details">
          <span>刷新凭据</span
          ><span>{{
            a.refreshExpiresSec ? duration(a.refreshExpiresSec) : "—"
          }}</span>
        </div>
        <div class="account-details">
          <span>{{ a.flag403 ? "观察池剩余" : "积分最早到期" }}</span
          ><span>{{
            a.flag403
              ? a.flag403DaysLeft + " 天"
              : a.earliestExpire
                ? dateTime(a.earliestExpire).split(" ")[0]
                : "—"
          }}</span>
        </div>
        <div class="account-actions">
          <template v-if="tab === 'pool'"
            ><ActionButton
              :action="() => poolAction(a, 'checkup')"
              class="small"
              icon="shield"
              >体检</ActionButton
            ><ActionButton
              :action="() => poolAction(a, 'release')"
              class="small"
              >移出</ActionButton
            ></template
          ><template v-else
            ><ActionButton
              :action="() => switchAccount(a)"
              class="small"
              :variant="a.serving ? 'ghost' : 'primary'"
              :disabled="a.serving"
              icon="switch"
              >{{ a.serving ? "服务中" : "启用" }}</ActionButton
            ><ActionButton
              :action="
                () => mutate('/account/refresh', { id: a.id }, '账号凭据已刷新')
              "
              class="small"
              icon="refresh"
              >刷新</ActionButton
            ><ActionButton
              :action="
                async () =>
                  showResult(
                    '签到结果',
                    await mutate('/checkin', { id: a.id }, '签到已完成'),
                  )
              "
              class="small"
              >签到</ActionButton
            ></template
          ><ActionButton
            :action="() => remove(a)"
            variant="ghost"
            class="icon-only"
            icon="trash"
            :aria-label="'删除账号 ' + $clean(a.nickname)"
          />
        </div>
        <button
          v-if="creditOf(a)?.packs?.length"
          class="text-link"
          style="margin-top: 15px"
          @click="showResult('积分包明细', creditOf(a))"
        >
          查看积分包 <Icon name="arrowRight" :size="13" />
        </button>
      </article>
    </div>
    <section v-else-if="list.length" class="panel">
      <DataTable :columns="cols" :rows="list"
        ><template #account="{ row }"
          ><strong>{{ $clean(row.nickname) }}</strong>
          <div class="table-sub">
            {{ row.uid }} · {{ $clean(row.siteLabel) }}
          </div></template
        ><template #balance="{ row }"
          ><button
            class="text-link mono"
            @click="showResult('积分包明细', creditOf(row) || row)"
          >
            {{ balance(row) == null ? "—" : fmt(balance(row)) }}
          </button></template
        ><template #status="{ row }"
          ><span class="badge" :class="tone(row)">{{
            label(row)
          }}</span></template
        ><template #expiry="{ row }">{{ duration(row.expiresSec) }}</template
        ><template #actions="{ row }"
          ><div class="inline">
            <template v-if="tab === 'pool'"
              ><ActionButton
                :action="() => poolAction(row, 'checkup')"
                class="small"
                >体检</ActionButton
              ><ActionButton
                :action="() => poolAction(row, 'release')"
                class="small"
                >移出</ActionButton
              ></template
            ><template v-else
              ><ActionButton
                :action="() => switchAccount(row)"
                :disabled="row.serving"
                class="small"
                >启用</ActionButton
              ><ActionButton
                :action="() => mutate('/account/refresh', { id: row.id })"
                class="small"
                >刷新凭据</ActionButton
              ><ActionButton
                :action="
                  async () =>
                    showResult(
                      '签到结果',
                      await mutate('/checkin', { id: row.id }),
                    )
                "
                class="small"
                >签到</ActionButton
              ></template
            ><ActionButton
              :action="() => remove(row)"
              class="icon-only"
              icon="trash"
              variant="ghost"
              aria-label="删除账号"
            /></div></template
      ></DataTable>
    </section>
    <section v-else class="panel">
      <EmptyState
        icon="users"
        :title="tab === 'pool' ? '观察池为空' : '还没有匹配的账号'"
        :description="
          tab === 'pool'
            ? '当前没有被移入观察池的账号。'
            : '连接 CodeBuddy / WorkBuddy 账号，开始管理你的模型服务。'
        "
        ><button
          v-if="tab === 'accounts'"
          class="btn primary"
          @click="state.modal = { type: 'login', title: '连接一个新账号' }"
        >
          <Icon name="plus" :size="16" />连接账号
        </button></EmptyState
      >
    </section>
    <HealthMatrix />
  </div>
</template>
