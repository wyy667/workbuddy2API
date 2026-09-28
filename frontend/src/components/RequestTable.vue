<script setup>
import { fmt, time } from "../utils.js";
import { showResult } from "../store.js";
defineProps({ rows: { default: () => [] }, short: Boolean });
const columns = [
  { key: "t", label: "时间" },
  { key: "model", label: "模型 / 账号" },
  { key: "tokens", label: "输入 / 缓存 / 输出" },
  { key: "ttft", label: "首字延迟" },
  { key: "durMs", label: "耗时" },
  { key: "credit", label: "积分" },
  { key: "status", label: "状态" },
  { key: "detail", label: "" },
];
</script>
<template>
  <DataTable
    :columns="
      short
        ? columns.filter((c) => !['ttft', 'credit'].includes(c.key))
        : columns
    "
    :rows="rows"
    :page-size="short ? 5 : 15"
    empty="暂无请求记录"
    ><template #t="{ row }"
      ><span class="muted mono">{{ time(row.t) }}</span></template
    ><template #model="{ row }"
      ><div class="table-model mono">{{ $clean(row.model) }}</div>
      <div class="table-sub">
        {{ $clean(row.name || row.uid8 || "—") }}
      </div></template
    ><template #tokens="{ row }"
      ><span class="mono"
        >{{ fmt(row.prompt) }}
        <span class="muted">/ {{ fmt(row.cached) }} /</span>
        {{ fmt(row.completion) }}</span
      ></template
    ><template #ttft="{ row }"
      ><span class="mono">{{
        row.ttft != null ? fmt(row.ttft) + " ms" : "—"
      }}</span></template
    ><template #durMs="{ row }"
      ><span class="mono">{{
        row.durMs != null ? (row.durMs / 1000).toFixed(2) + " s" : "—"
      }}</span></template
    ><template #credit="{ row }">{{ fmt(row.credit) }}</template
    ><template #status="{ row }"
      ><span
        class="badge"
        :class="row.err ? 'danger' : 'success'"
        :title="$clean(row.msg)"
        ><span class="tiny-dot"></span
        >{{ row.err ? $clean(row.err) : $clean(row.finish || "成功") }}</span
      ><span v-if="row.filter" class="badge orange">审核</span
      ><span v-if="row.tools" class="badge"
        >{{ row.tools }} tools</span
      ></template
    ><template #detail="{ row }"
      ><button
        class="icon-button"
        aria-label="查看请求详情"
        @click="showResult('请求详情', row)"
      >
        <Icon name="arrowUpRight" :size="15" /></button></template
  ></DataTable>
</template>
