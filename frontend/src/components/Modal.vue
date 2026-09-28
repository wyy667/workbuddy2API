<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from "vue";
import { closeModal } from "../store.js";
defineProps({
  title: String,
  wide: Boolean,
  eyebrow: { default: "WORKBUDDY CONSOLE" },
});
const root = ref(null);
let previous;
function keydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeModal();
  }
  if (e.key === "Tab") {
    const nodes = [
      ...root.value.querySelectorAll(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
      ),
    ].filter((e) => e.offsetParent !== null);
    if (!nodes.length) {
      e.preventDefault();
      return;
    }
    const first = nodes[0],
      last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
onMounted(async () => {
  previous = document.activeElement;
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", keydown);
  await nextTick();
  root.value?.querySelector("input,button")?.focus();
});
onBeforeUnmount(() => {
  document.body.style.overflow = "";
  document.removeEventListener("keydown", keydown);
  previous?.focus?.();
});
</script>
<template>
  <div class="modal-backdrop" @mousedown.self="closeModal()">
    <section
      ref="root"
      class="modal"
      :class="{ wide }"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <header class="modal-header">
        <div>
          <span class="eyebrow">{{ eyebrow }}</span>
          <h2>{{ title }}</h2>
        </div>
        <button class="icon-button" aria-label="关闭弹窗" @click="closeModal()">
          <Icon name="x" />
        </button>
      </header>
      <div class="modal-body"><slot /></div>
      <footer v-if="$slots.footer" class="modal-footer">
        <slot name="footer" />
      </footer>
    </section>
  </div>
</template>
