<script setup>
import { ref, computed } from "vue";
import { state, mutate, confirmAction } from "../store.js";
import { fmt, dateTime } from "../utils.js";
const search = ref(""),
  filter = ref("all");
const keys = computed(() =>
  (state.status?.apiKeys || []).filter(
    (k) =>
      (k.name + " " + k.masked)
        .toLowerCase()
        .includes(search.value.toLowerCase()) &&
      (filter.value === "all" ||
        (filter.value === "active" ? !k.disabled : k.disabled)),
  ),
);
const columns = [
  { key: "name", label: "名称 / 密钥" },
  { key: "permissions", label: "授权范围" },
  { key: "requests", label: "今日请求" },
  { key: "tokens", label: "今日 Tokens" },
  { key: "credit", label: "今日积分" },
  { key: "status", label: "状态" },
  { key: "actions", label: "操作" },
];
async function remove(k) {
  if (
    await confirmAction(
      "删除 API 密钥",
      `删除「${k.name}」后，使用此密钥的客户端将无法继续请求。`,
      "删除密钥",
    )
  )
    await mutate("/keys/delete", { id: k.id, tail: k.tail }, "密钥已删除");
}
const percent = (v, limit) => (limit ? Math.min(100, (v / limit) * 100) : 0);
</script>
<template>
  <div class="stack">
    <div class="key-banner">
      <Icon name="shield" :size="27" />
      <div>
        <h3>权限恰到好处，协作才能放心。</h3>
        <p>
          附加密钥仅用于模型调用，可以分别限制模型、账号及每日额度，不具备管理台访问权限。请求次数入站预占；Token 与积分按实际返回结算，达到阈值后停用，单次请求可能超出阈值。
        </p>
      </div>
    </div>
    <div class="toolbar">
      <div class="search-input">
        <Icon name="search" :size="16" /><input
          v-model="search"
          placeholder="搜索密钥名称或尾号"
          aria-label="搜索密钥"
        />
      </div>
      <div class="segmented">
        <button
          v-for="(label, id) in {
            all: '全部',
            active: '已启用',
            disabled: '已停用',
          }"
          :key="id"
          :class="{ active: filter === id }"
          @click="filter = id"
        >
          {{ label }}
        </button>
      </div>
    </div>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>你的 API 密钥</h2>
          <p>{{ keys.length }} 个密钥 · 每日额度按服务器日期重置</p>
        </div>
        <Icon name="key" :size="19" class="muted" />
      </header>
      <DataTable
        v-if="keys.length"
        :rows="keys"
        :columns="columns"
        row-key="id"
        ><template #name="{ row }"
          ><strong>{{ $clean(row.name) }}</strong>
          <div class="table-sub mono">{{ row.masked }}</div>
          <div class="table-sub">
            创建于 {{ dateTime(row.createdAt) }}
          </div></template
        ><template #permissions="{ row }"
          ><div class="key-permissions">
            <span class="badge" :title="row.models.join(', ')">{{
              row.models.length ? row.models.length + " 个指定模型" : "全部模型"
            }}</span
            ><span class="badge" :title="row.accounts.join(', ')">{{
              row.accounts.length
                ? row.accounts.length + " 个指定账号"
                : "全部账号"
            }}</span>
          </div></template
        ><template #requests="{ row }"
          ><div class="key-limit mono">
            {{ fmt(row.usedToday) }}
            <span class="muted"
              >/ {{ row.dailyLimit ? fmt(row.dailyLimit) : "不限" }}</span
            >
            <div v-if="row.dailyLimit" class="progress-track">
              <div
                class="progress-fill"
                :style="{ width: percent(row.usedToday, row.dailyLimit) + '%' }"
              ></div>
            </div></div></template
        ><template #tokens="{ row }"
          ><div class="key-limit mono">
            {{ fmt(row.tokensToday) }}
            <span class="muted"
              >/
              {{
                row.dailyTokenLimit ? fmt(row.dailyTokenLimit) : "不限"
              }}</span
            >
            <div v-if="row.dailyTokenLimit" class="progress-track">
              <div
                class="progress-fill"
                :style="{
                  width: percent(row.tokensToday, row.dailyTokenLimit) + '%',
                }"
              ></div>
            </div></div></template
        ><template #credit="{ row }"
          ><div class="key-limit mono">
            {{ fmt(row.creditToday) }}
            <span class="muted"
              >/
              {{
                row.dailyCreditLimit ? fmt(row.dailyCreditLimit) : "不限"
              }}</span
            >
            <div v-if="row.dailyCreditLimit" class="progress-track">
              <div
                class="progress-fill"
                :style="{
                  width: percent(row.creditToday, row.dailyCreditLimit) + '%',
                }"
              ></div>
            </div></div></template
        ><template #status="{ row }"
          ><span class="badge" :class="row.disabled ? '' : 'success'"
            ><span class="tiny-dot"></span
            >{{ row.disabled ? "已停用" : "已启用" }}</span
          ></template
        ><template #actions="{ row }"
          ><div class="inline">
            <button
              class="icon-button"
              aria-label="编辑密钥权限"
              @click="
                state.modal = {
                  type: 'key',
                  title: '编辑密钥权限',
                  entry: JSON.parse(JSON.stringify(row)),
                }
              "
            >
              <Icon name="settings" :size="15" /></button
            ><ActionButton
              :action="
                () =>
                  mutate(
                    '/keys/update',
                    { id: row.id, tail: row.tail, disabled: !row.disabled },
                    row.disabled ? '密钥已启用' : '密钥已停用',
                  )
              "
              :icon="row.disabled ? 'play' : 'pause'"
              class="icon-only"
              variant="ghost"
              :aria-label="row.disabled ? '启用密钥' : '停用密钥'"
            /><ActionButton
              :action="() => remove(row)"
              icon="trash"
              class="icon-only"
              variant="ghost"
              aria-label="删除密钥"
            /></div></template></DataTable
      ><EmptyState
        v-else
        icon="key"
        title="为新的连接，创建一把密钥"
        description="设置合适的权限与额度，安全地分享给你的工具或协作者。"
        ><button
          class="btn primary"
          @click="state.modal = { type: 'key', title: '创建 API 密钥' }"
        >
          <Icon name="plus" :size="16" />创建密钥
        </button></EmptyState
      >
    </section>
  </div>
</template>
