<script setup>
defineProps({
  icon: { default: "layers" },
  title: { default: "暂无数据" },
  description: { default: "数据将在这里呈现。" },
});
</script>
<template>
  <div class="empty-state">
    <span class="empty-icon"><Icon :name="icon" :size="26" /></span>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>
