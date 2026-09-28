<script setup>
import { ref } from "vue";
import { notify } from "../store.js";
const props = defineProps({
  action: Function,
  icon: String,
  variant: { default: "secondary" },
  disabled: Boolean,
});
const busy = ref(false);
async function run() {
  if (busy.value || !props.action) return;
  busy.value = true;
  try {
    await props.action();
  } catch (e) {
    notify(e.message, "error");
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <button
    class="btn"
    :class="[variant, { busy }]"
    :disabled="disabled || busy"
    :aria-busy="busy"
    @click="run"
  >
    <Icon
      v-if="busy || icon"
      :name="busy ? 'loading' : icon"
      :class="{ spin: busy }"
      :size="16"
    /><slot />
  </button>
</template>
