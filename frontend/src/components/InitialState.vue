<script setup>
import { state, refreshAll } from "../store.js";
</script>
<template>
  <section v-if="state.error" class="panel">
    <EmptyState
      icon="globe"
      title="连接工作空间后开始"
      description="请检查管理密钥和后端服务，再重新加载数据。"
      ><ActionButton :action="refreshAll" icon="refresh" variant="primary"
        >重新连接</ActionButton
      ></EmptyState
    >
  </section>
  <div
    v-else
    class="initial-skeleton"
    role="status"
    aria-label="正在加载工作空间"
  >
    <div class="skeleton-hero"></div>
    <div class="grid grid-4">
      <div v-for="i in 4" :key="i" class="skeleton-card"></div>
    </div>
    <div class="skeleton-chart"></div>
    <span class="sr-only">正在同步工作空间数据</span>
  </div>
</template>
