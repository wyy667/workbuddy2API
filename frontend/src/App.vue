<script setup>
import { computed, onMounted, onBeforeUnmount, watch, ref } from "vue";
import {
  state,
  navigation,
  go,
  applyTheme,
  refreshAll,
  refresh,
  loadMetrics,
  startLive,
  stopLive,
  notify,
  closeModal,
  testConnection,
} from "./store.js";
import { time } from "./utils.js";
import Overview from "./pages/Overview.vue";
import Accounts from "./pages/Accounts.vue";
import Tasks from "./pages/Tasks.vue";
import Checkin from "./pages/Checkin.vue";
import Usage from "./pages/Usage.vue";
import Logs from "./pages/Logs.vue";
import Models from "./pages/Models.vue";
import Keys from "./pages/Keys.vue";
import Providers from "./pages/Providers.vue";
import Backup from "./pages/Backup.vue";
import Dialogs from "./components/Dialogs.vue";
import InitialState from "./components/InitialState.vue";
import ProjectLinks from "./components/ProjectLinks.vue";
import projectVersion from "../../backend/project-version.json";
const pages = {
  overview: Overview,
  accounts: Accounts,
  tasks: Tasks,
  checkin: Checkin,
  usage: Usage,
  logs: Logs,
  models: Models,
  keys: Keys,
  ext: Providers,
  backup: Backup,
};
const current = computed(() => navigation.find((n) => n.id === state.page));
const groups = [...new Set(navigation.map((n) => n.group))];
const paletteOpen = ref(false);
const palettes = [
  { id: "lime", name: "青柠与炭黑", a: "#bfff00", b: "#222222" },
  { id: "lava", name: "熔岩与深海", a: "#ff5a1f", b: "#001f54" },
  { id: "violet", name: "帝王紫与柠檬", a: "#6a0dad", b: "#fff000" },
  { id: "magenta", name: "甜酷粉与黑曜石", a: "#e93f80", b: "#1e1e22" },
  { id: "neon", name: "霓虹蓝与电光紫", a: "#00f0ff", b: "#9d00ff" },
  { id: "mint", name: "冰薄荷与樱桃红", a: "#98ff98", b: "#d2042d" },
  { id: "cosmic", name: "晶石紫与电光荧", a: "#690dad", b: "#34ff1a" },
  { id: "electric", name: "霓虹赤与电光蓝", a: "#f5011a", b: "#0247fe" },
];
let poll, metricsTimer;
applyTheme();
watch(() => [state.theme, state.palette, state.density], applyTheme);
function hashChange() {
  const id = location.hash.replace("#sec-", "").replace("#", "");
  if (navigation.some((n) => n.id === id)) go(id);
}
function keydown(e) {
  if (e.key === "Escape") {
    state.sidebar = false;
    paletteOpen.value = false;
  }
  if (
    state.modal ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.target.closest("input,textarea,select,[contenteditable]")
  )
    return;
  if (e.key === "?") {
    state.modal = { type: "help", title: "键盘快捷键" };
  } else if (e.key.toLowerCase() === "r") {
    e.preventDefault();
    refreshAll().catch((e) => notify(e.message, "error"));
  } else if (/^[0-9]$/.test(e.key)) {
    go(navigation[e.key === "0" ? 9 : Number(e.key) - 1].id);
  }
}
function outsidePalette(e) {
  if (!e.target.closest(".palette-wrap")) paletteOpen.value = false;
}
function visible() {
  if (document.hidden) {
    stopLive();
  } else {
    refresh().catch(() => {});
    startLive();
  }
}
onMounted(() => {
  document.addEventListener("click", outsidePalette);
  refreshAll().catch(() => {});
  refresh().then(startLive).catch(() => {});
  poll = setInterval(() => {
    if (!document.hidden) refresh().catch(() => {});
  }, 10000);
  metricsTimer = setInterval(() => {
    if (!document.hidden) loadMetrics().catch(() => {});
  }, 30000);
  window.addEventListener("hashchange", hashChange);
  document.addEventListener("keydown", keydown);
  document.addEventListener("visibilitychange", visible);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", outsidePalette);
  clearInterval(poll);
  clearInterval(metricsTimer);
  stopLive();
  window.removeEventListener("hashchange", hashChange);
  document.removeEventListener("keydown", keydown);
  document.removeEventListener("visibilitychange", visible);
});
</script>
<template>
  <a href="#main-content" class="skip-link">跳转到主要内容</a>
  <div class="app-shell">
    <Transition name="fade"
      ><div
        v-if="state.sidebar"
        class="sidebar-scrim"
        @click="state.sidebar = false"
      ></div
    ></Transition>
    <aside class="sidebar" :class="{ open: state.sidebar }" aria-label="主导航">
      <a class="brand" href="#sec-overview" @click.prevent="go('overview')"
        ><span class="brand-mark"
          ><svg viewBox="0 0 32 32" fill="none">
            <path
              d="M5 8l5 16 6-11 6 11 5-16"
              stroke="currentColor"
              stroke-width="3.5"
              stroke-linecap="square"
              stroke-linejoin="miter"
            /></svg></span
        ><span>workbuddy<span class="brand-sub">THE PROXY WORKSPACE</span></span
        ><span class="brand-version">3</span></a
      >
      <div class="workspace-selector">
        <span class="workspace-avatar"><Icon name="layers" :size="19" /></span>
        <div><strong>我的工作空间</strong><span>Personal workspace</span></div>
        <span class="workspace-dot"></span>
      </div>
      <nav>
        <div v-for="group in groups" :key="group" class="nav-group">
          <div class="nav-label">{{ group }}</div>
          <a
            v-for="item in navigation.filter((n) => n.group === group)"
            :key="item.id"
            :href="'#sec-' + item.id"
            :class="['nav-link', { active: state.page === item.id }]"
            :aria-current="state.page === item.id ? 'page' : undefined"
            @click.prevent="go(item.id)"
            ><Icon :name="item.icon" :size="18" /><span>{{ item.label }}</span
            ><span
              v-if="item.id === 'accounts' && state.status"
              class="nav-count"
              >{{ state.status.accounts?.length || 0 }}</span
            ><span
              v-if="item.id === 'logs'"
              class="nav-live"
              :class="{ on: state.liveConnected }"
            ></span
            ><Icon
              v-if="item.id === state.page"
              name="chevronRight"
              :size="14"
              class="nav-arrow"
          /></a>
        </div>
        <ProjectLinks />
      </nav>
      <div class="sidebar-bottom">
        <div class="sidebar-note">
          <span class="eyebrow">BUILT FOR YOUR FLOW</span
          ><strong>一个入口，无限可能。</strong>
          <div class="inline">
            <span
              class="status-dot"
              :class="{ offline: state.error || !state.status }"
            ></span
            ><span>{{
              state.error
                ? "连接异常"
                : state.status
                  ? "服务已连接"
                  : "等待连接"
            }}</span>
          </div>
        </div>
        <button
          class="sidebar-help"
          @click="state.modal = { type: 'help', title: '使用与快捷键' }"
        >
          <Icon name="help" :size="17" /><span>帮助与快捷键</span><kbd>?</kbd>
        </button>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="inline">
          <button
            class="icon-button mobile-menu"
            aria-label="打开导航"
            @click="state.sidebar = true"
          >
            <Icon name="menu" /></button
          ><span class="breadcrumb-root">工作空间</span
          ><span class="breadcrumb-divider">/</span
          ><span class="breadcrumb-current">{{ current.label }}</span>
        </div>
        <div class="topbar-right">
          <div class="sync-state">
            <span
              class="status-dot"
              :class="{ offline: state.error || !state.status }"
            ></span
            >{{
              state.error
                ? "连接异常"
                : state.loading
                  ? "正在同步"
                  : state.lastUpdated
                    ? "已同步 " + time(state.lastUpdated)
                    : "正在连接"
            }}
          </div>
          <div class="theme-tools">
            <div class="palette-wrap">
              <button
                class="icon-button palette-trigger"
                aria-label="选择日间配色"
                :aria-expanded="paletteOpen"
                @click="paletteOpen = !paletteOpen"
              >
                <span class="palette-symbol"></span></button
              ><Transition name="popover"
                ><div v-if="paletteOpen" class="palette-menu">
                  <span class="eyebrow">DAYLIGHT PALETTES</span
                  ><button
                    v-for="p in palettes"
                    :key="p.id"
                    @click="
                      state.palette = p.id;
                      paletteOpen = false;
                    "
                  >
                    <span
                      class="swatch"
                      :style="{
                        background:
                          'linear-gradient(135deg,' +
                          p.a +
                          ' 50%,' +
                          p.b +
                          ' 50%)',
                      }"
                    ></span
                    ><span>{{ p.name }}</span
                    ><Icon
                      v-if="state.palette === p.id"
                      name="check"
                      :size="16"
                    />
                  </button></div
              ></Transition>
            </div>
            <button
              class="icon-button"
              :aria-label="
                state.theme === 'dark' ? '切换日间模式' : '切换夜间模式'
              "
              @click="state.theme = state.theme === 'dark' ? 'light' : 'dark'"
            >
              <Icon :name="state.theme === 'dark' ? 'sun' : 'moon'" /></button
            ><ActionButton
              class="icon-only"
              icon="refresh"
              aria-label="刷新当前数据"
              :action="refreshAll"
              variant="ghost"
            />
          </div>
          <span class="topbar-avatar">W</span>
        </div>
      </header>
      <main id="main-content" tabindex="-1" class="main-content">
        <div v-if="state.status?.storageErrors?.length" class="connection-alert" role="alert">
          <Icon name="alert" /><div><strong>服务器保存异常</strong><p>部分数据尚未写入磁盘，请检查磁盘空间与文件权限。待保存数据会自动重试。</p></div>
        </div>
        <div v-if="state.error" class="connection-alert" role="alert">
          <Icon name="alert" />
          <div>
            <strong>数据暂时无法同步</strong>
            <p>
              {{ state.error
              }}<span v-if="state.status"> · 当前显示上次成功同步的数据</span>
            </p>
          </div>
          <ActionButton :action="refreshAll" icon="refresh">重试</ActionButton>
        </div>
        <div class="page-heading">
          <div>
            <div class="eyebrow">
              {{ current.en.toUpperCase() }}
              <span class="eyebrow-line"></span> WORKBUDDY
            </div>
            <h1>{{ current.label }}<span class="heading-period">.</span></h1>
            <p>{{ current.desc }}</p>
          </div>
          <div class="heading-actions">
            <button
              class="icon-button density-toggle"
              :aria-label="
                state.density === 'compact' ? '舒适表格密度' : '紧凑表格密度'
              "
              @click="
                state.density =
                  state.density === 'compact' ? 'comfortable' : 'compact'
              "
            >
              <Icon name="sliders" :size="18" /></button
            ><ActionButton
              v-if="state.page === 'overview'"
              icon="activity"
              :action="testConnection"
              >连通测试</ActionButton
            ><button
              v-if="['overview', 'accounts'].includes(state.page)"
              class="btn primary"
              @click="state.modal = { type: 'login', title: '连接一个新账号' }"
            >
              <Icon name="plus" :size="17" />连接账号</button
            ><button
              v-if="state.page === 'keys'"
              class="btn primary"
              @click="state.modal = { type: 'key', title: '创建 API 密钥' }"
            >
              <Icon name="plus" :size="17" />创建密钥</button
            ><button
              v-if="state.page === 'ext'"
              class="btn primary"
              @click="state.modal = { type: 'provider', title: '添加连接' }"
            >
              <Icon name="plus" :size="17" />添加连接
            </button>
          </div>
        </div>
        <InitialState v-if="!state.status && (state.page !== 'overview' || state.error)" />
        <Transition v-else name="page" mode="out-in"
          ><KeepAlive
            ><component :is="pages[state.page]" :key="state.page" /></KeepAlive
        ></Transition>
        <footer class="app-footer">
          <span
            ><span class="footer-brand">workbuddy</span>
            <span class="muted">/</span> 为流畅的工作而设计</span
          ><span>PROXY CONSOLE <span class="footer-version">V{{ projectVersion.version }}</span></span>
        </footer>
      </main>
    </div>
    <Teleport to="body"
      ><Transition name="modal"
        ><Dialogs v-if="state.modal" :key="state.modal.type"
      /></Transition>
      <div class="toast-stack" aria-live="polite">
        <TransitionGroup name="toast"
          ><div
            v-for="t in state.toasts"
            :key="t.id"
            class="toast"
            :class="t.type"
          >
            <Icon :name="t.type === 'error' ? 'alert' : 'success'" /><span>{{
              t.message
            }}</span
            ><button
              class="icon-button"
              aria-label="关闭通知"
              @click="state.toasts = state.toasts.filter((x) => x.id !== t.id)"
            >
              <Icon name="x" :size="14" />
            </button></div
        ></TransitionGroup></div
    ></Teleport>
  </div>
</template>
