<script setup>
import { ref, watch, onBeforeUnmount } from "vue";
import { fmt, compact } from "../utils.js";
const props = defineProps({
  label: String,
  loading: Boolean,
  pendingText: { type: String, default: "正在加载" },
  value: { default: 0 },
  suffix: String,
  note: String,
  icon: String,
  tone: String,
  short: Boolean,
});
const shown = ref(Number(props.value) || 0);
let frame;
watch(
  () => props.value,
  (v) => {
    cancelAnimationFrame(frame);
    const start = shown.value,
      end = Number(v) || 0,
      t = performance.now();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shown.value = end;
      return;
    }
    function tick(now) {
      const p = Math.min(1, (now - t) / 650);
      shown.value = start + (end - start) * (1 - Math.pow(1 - p, 3));
      if (p < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  },
);
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>
<template>
  <article class="stat-card" :class="tone">
    <div class="stat-top">
      <span>{{ label }}</span
      ><Icon v-if="icon" :name="icon" :size="18" />
    </div>
    <div class="stat-value" :aria-busy="loading">
      <span v-if="loading" class="stat-pending">—</span>
      <template v-else>
      {{ short ? compact(shown) : fmt(shown, suffix === "%" ? 1 : 0)
      }}<span v-if="suffix">{{ suffix }}</span></template>
    </div>
    <div class="stat-note"><span class="tiny-dot"></span>{{ loading ? pendingText : note }}</div>
  </article>
</template>
