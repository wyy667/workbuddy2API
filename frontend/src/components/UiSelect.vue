<script setup>
import {
  ref,
  computed,
  useSlots,
  useAttrs,
  nextTick,
  onBeforeUnmount,
  onDeactivated,
  watch,
  Fragment,
  Text,
} from "vue";
import { ChevronDown, Check, Search } from "lucide-vue-next";
import { cleanText } from "../utils.js";
defineOptions({ inheritAttrs: false });
const props = defineProps({
  modelValue: [String, Number, Boolean],
  modelModifiers: Object,
  disabled: Boolean,
});
const emit = defineEmits(["update:modelValue", "change"]);
const slots = useSlots(),
  attrs = useAttrs();
const trigger = ref(null),
  menu = ref(null),
  open = ref(false),
  active = ref(-1),
  query = ref(""),
  placement = ref({});
const id = "select-" + Math.random().toString(36).slice(2);
const textOf = (children) =>
  Array.isArray(children)
    ? children
        .map((n) =>
          typeof n === "string"
            ? n
            : n.type === Text
              ? n.children
              : textOf(n.children),
        )
        .join("")
    : typeof children === "string"
      ? children
      : "";
const options = computed(() => {
  const result = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === Fragment) walk(node.children);
      else if (node.type === "option") {
        const label = cleanText(textOf(node.children).trim());
        result.push({
          label,
          value:
            node.props && "value" in node.props
              ? node.props.value
              : textOf(node.children).trim(),
          disabled:
            node.props?.disabled === true || node.props?.disabled === "",
        });
      }
    }
  };
  walk(slots.default?.());
  return result;
});
const selected = computed(() =>
  options.value.find((o) => String(o.value) === String(props.modelValue ?? "")),
);
const filtered = computed(() =>
  options.value.filter((o) =>
    o.label.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
const searchable = computed(() => options.value.length > 8);
function position() {
  const b = trigger.value?.getBoundingClientRect();
  if (!b) return;
  const below = innerHeight - b.bottom - 12,
    above = b.top - 12,
    up = below < 220 && above > below;
  const max = Math.max(90, Math.min(330, up ? above : below)),
    width = Math.min(innerWidth - 24, Math.max(b.width, 220));
  placement.value = {
    position: "fixed",
    left: Math.min(innerWidth - width - 12, Math.max(12, b.left)) + "px",
    width: width + "px",
    maxHeight: max + "px",
    ...(up
      ? { bottom: innerHeight - b.top + 6 + "px" }
      : { top: b.bottom + 6 + "px" }),
  };
}
function outside(e) {
  if (!trigger.value?.contains(e.target) && !menu.value?.contains(e.target))
    close();
}
function scrolled(e) {
  if (!menu.value?.contains(e.target)) position();
}
function close() {
  open.value = false;
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", position);
  window.removeEventListener("scroll", scrolled, true);
}
async function show() {
  if (props.disabled) return;
  query.value = "";
  open.value = true;
  active.value = options.value.findIndex((o) => o === selected.value);
  position();
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", scrolled, true);
  await nextTick();
  reveal();
}
function reveal() {
  menu.value
    ?.querySelector('[data-active="true"]')
    ?.scrollIntoView({ block: "nearest" });
}
function choose(option) {
  if (!option || option.disabled) return;
  let value = option.value;
  if (
    props.modelModifiers?.number &&
    value !== "" &&
    !Number.isNaN(Number(value))
  )
    value = Number(value);
  emit("update:modelValue", value);
  emit("change", { target: { value } });
  close();
  trigger.value?.focus();
}
function step(direction) {
  const list = filtered.value;
  if (!list.length) return;
  let i = active.value;
  for (let n = 0; n < list.length; n++) {
    i = (i + direction + list.length) % list.length;
    if (!list[i].disabled) {
      active.value = i;
      nextTick(reveal);
      return;
    }
  }
}
async function keydown(e) {
  if (e.key === "Escape" && open.value) {
    e.preventDefault();
    e.stopPropagation();
    close();
    trigger.value?.focus();
    return;
  }
  if (e.key === "Tab") {
    close();
    return;
  }
  if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(e.key)) {
    if (e.target?.tagName === "INPUT" && e.key === " ") return;
    e.preventDefault();
    e.stopPropagation();
    if (!open.value) {
      await show();
      if (e.key === "ArrowUp") active.value = filtered.value.length - 1;
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp")
      step(e.key === "ArrowDown" ? 1 : -1);
    else if (e.key === "Home" || e.key === "End") {
      active.value = e.key === "Home" ? 0 : filtered.value.length - 1;
      nextTick(reveal);
    } else choose(filtered.value[active.value]);
  } else if (
    e.key.length === 1 &&
    !e.ctrlKey &&
    !e.metaKey &&
    e.target?.tagName !== "INPUT"
  ) {
    e.preventDefault();
    if (!open.value) await show();
    query.value += e.key;
    active.value = 0;
  }
}
watch(query, () => {
  active.value = filtered.value.findIndex((o) => !o.disabled);
});
watch(
  () => props.disabled,
  (v) => {
    if (v) close();
  },
);
onDeactivated(close);
onBeforeUnmount(close);
</script>
<template>
  <span class="ui-select" :class="attrs.class" :style="attrs.style">
    <button
      ref="trigger"
      v-bind="
        Object.fromEntries(
          Object.entries(attrs).filter(
            ([k]) => !['class', 'style'].includes(k),
          ),
        )
      "
      type="button"
      role="combobox"
      class="ui-select-trigger"
      :class="{ 'is-open': open }"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-controls="id"
      :aria-activedescendant="
        open && active >= 0 ? id + '-' + active : undefined
      "
      @click="open ? close() : show()"
      @keydown="keydown"
    >
      <span>{{ selected?.label || "请选择" }}</span
      ><ChevronDown :size="15" />
    </button>
    <Teleport to="body"
      ><Transition name="select-pop"
        ><div
          v-if="open"
          ref="menu"
          class="ui-select-menu"
          :style="placement"
          @keydown="keydown"
          @click.stop
        >
          <div v-if="searchable" class="ui-select-search">
            <Search :size="14" /><input
              v-model="query"
              aria-label="搜索选项"
              placeholder="搜索选项…"
              autocomplete="off"
              @keydown.tab="trigger?.focus()"
            />
          </div>
          <div
            :id="id"
            role="listbox"
            :aria-label="attrs['aria-label'] || '可选项'"
            class="ui-select-options"
          >
            <div
              v-for="(option, index) in filtered"
              :id="id + '-' + index"
              :key="String(option.value)"
              role="option"
              :aria-selected="String(option.value) === String(modelValue ?? '')"
              :aria-disabled="option.disabled"
              :data-active="index === active"
              :data-value="option.value"
              class="ui-select-option"
              @pointermove="active = index"
              @mousedown.prevent
              @click="choose(option)"
            >
              <span>{{ option.label }}</span
              ><Check
                v-if="String(option.value) === String(modelValue ?? '')"
                :size="15"
              />
            </div>
            <div v-if="!filtered.length" class="ui-select-empty">
              没有匹配的选项
            </div>
          </div>
        </div></Transition
      ></Teleport
    >
  </span>
</template>
<style>
.ui-select {
  display: inline-flex;
  vertical-align: middle;
  min-width: 140px;
  max-width: 100%;
  font-size: 12px;
  text-align: left;
}
.ui-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  width: 100%;
  min-height: 38px;
  padding: 9px 12px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  font: inherit;
  cursor: pointer;
  transition:
    border-color 0.18s,
    box-shadow 0.18s,
    background 0.18s;
}
.ui-select-trigger > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.ui-select-trigger > svg {
  flex: none;
  color: var(--muted);
  transition: transform 0.2s;
}
.ui-select-trigger:hover {
  border-color: var(--muted);
  background: var(--surface-hover);
}
.ui-select-trigger.is-open {
  border-color: var(--accent-dark);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.ui-select-trigger.is-open > svg {
  transform: rotate(180deg);
}
.ui-select-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ui-select-menu {
  z-index: 12000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 5px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow:
    0 12px 35px #0002,
    0 2px 6px #0001;
  font-size: 12px;
}
.ui-select-options {
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 2px;
}
.ui-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 36px;
  padding: 9px 10px;
  border-radius: 7px;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
  overflow-wrap: anywhere;
}
.ui-select-option[data-active="true"] {
  background: var(--surface-hover);
}
.ui-select-option[aria-selected="true"] {
  background: var(--accent-soft);
  color: var(--accent-dark);
}
.ui-select-option[aria-disabled="true"] {
  opacity: 0.4;
  cursor: not-allowed;
}
.ui-select-option > svg {
  flex: none;
}
.ui-select-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 5px 6px;
  padding: 0 7px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.ui-select-search input {
  width: 100%;
  min-width: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 9px 0;
  font-size: 12px;
  box-shadow: none !important;
  outline: none;
}
.ui-select-empty {
  padding: 18px;
  text-align: center;
  color: var(--muted);
}
.select-pop-enter-active,
.select-pop-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
}
.select-pop-enter-from,
.select-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.985);
}
label > .ui-select {
  width: 100%;
}
.toolbar .ui-select {
  min-width: 150px;
  max-width: 260px;
}
.health-toolbar .ui-select {
  max-width: 300px;
}
.ui-select-trigger:focus-visible {
  outline: 2px solid var(--accent-dark);
  outline-offset: 3px;
}
@media (max-width: 700px) {
  .toolbar .ui-select {
    max-width: 100%;
    flex: 1;
  }
  .ui-select {
    min-width: 120px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .select-pop-enter-active,
  .select-pop-leave-active {
    transition: none;
  }
}
</style>
