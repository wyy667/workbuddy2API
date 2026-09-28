<script setup>
import { computed, ref, watch } from "vue";
const props = defineProps({
  columns: { default: () => [] },
  rows: { default: () => [] },
  pageSize: { default: 15 },
  empty: { default: "暂无记录" },
  rowKey: { default: "id" },
});
const page = ref(1);
const count = computed(() =>
  Math.max(1, Math.ceil(props.rows.length / props.pageSize)),
);
const visible = computed(() =>
  props.rows.slice(
    (page.value - 1) * props.pageSize,
    page.value * props.pageSize,
  ),
);
watch(count, () => (page.value = Math.min(page.value, count.value)));
</script>
<template>
  <div class="data-table">
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th v-for="c in columns" :key="c.key" :class="c.class">
              {{ c.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in visible" :key="row[rowKey] ?? i">
            <td v-for="c in columns" :key="c.key" :class="c.class">
              <slot :name="c.key" :row="row" :value="row[c.key]">{{
                $clean(row[c.key] ?? "—")
              }}</slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <EmptyState
      v-if="!rows.length"
      :title="empty"
      description="调整筛选条件，或在有新数据后刷新。"
    />
    <div v-if="rows.length" class="table-footer">
      <span
        >{{ rows.length }} 条记录
        <span class="muted">/ {{ page }} · {{ count }} 页</span></span
      >
      <div class="inline">
        <button
          class="icon-button"
          aria-label="上一页"
          :disabled="page === 1"
          @click="page--"
        >
          <Icon name="chevronLeft" :size="16" /></button
        ><button
          class="icon-button"
          aria-label="下一页"
          :disabled="page === count"
          @click="page++"
        >
          <Icon name="chevronRight" :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>
