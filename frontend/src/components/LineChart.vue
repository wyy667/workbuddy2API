<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { fmt, compact, cleanText } from "../utils.js";
const props = defineProps({
  labels: { default: () => [] },
  series: { default: () => [] },
  height: { default: 240 },
  legend: { default: true },
  label: { default: "用量趋势" },
});
const root = ref(null),
  width = ref(760),
  hover = ref(-1),
  hidden = ref([]),
  focused = ref(null);
const left = 44,
  right = 16,
  top = 16,
  bottom = 30;
const max = computed(
  () =>
    Math.max(
      1,
      ...props.series
        .filter((s) => !hidden.value.includes(s.name))
        .flatMap((s) => s.values.filter((v) => v !== null)),
    ) * 1.15,
);
const x = (i) =>
  left +
  (width.value - left - right) *
    (props.labels.length <= 1 ? 0.5 : i / (props.labels.length - 1));
const y = (v) => top + (props.height - top - bottom) * (1 - v / max.value);
const path = (s) => {
  let previous = false;
  return s.values
    .map((v, i) => {
      if (v === null || v === undefined) {
        previous = false;
        return "";
      }
      const p =
        (previous ? "L" : "M") + x(i).toFixed(2) + "," + y(v).toFixed(2);
      previous = true;
      return p;
    })
    .join(" ");
};
const hasData = computed(() =>
  props.series.some((s) => s.values.some((v) => v !== null && v > 0)),
);
const labelsStep = computed(() =>
  Math.ceil(props.labels.length / (width.value < 500 ? 5 : 8)),
);
const currentRows = computed(() =>
  props.series
    .filter((s) => !hidden.value.includes(s.name))
    .map((s) => ({ ...s, value: s.values[hover.value] })),
);
function point(e) {
  const b = e.currentTarget.getBoundingClientRect();
  hover.value = Math.max(
    0,
    Math.min(
      props.labels.length - 1,
      Math.round(
        ((((e.clientX - b.left) / b.width) * width.value - left) /
          (width.value - left - right)) *
          (props.labels.length - 1),
      ),
    ),
  );
}
function toggle(name) {
  hidden.value = hidden.value.includes(name)
    ? hidden.value.filter((n) => n !== name)
    : [...hidden.value, name];
}
let observer;
onMounted(() => {
  observer = new ResizeObserver(
    (entries) => (width.value = Math.max(250, entries[0].contentRect.width)),
  );
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <div ref="root" class="line-chart">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      :style="{ height: height + 'px' }"
      role="img"
      :aria-label="label"
      @pointermove="point"
      @pointerleave="hover = -1"
      tabindex="0"
      @keydown.right.prevent="hover = Math.min(labels.length - 1, hover + 1)"
      @keydown.left.prevent="hover = Math.max(0, hover - 1)"
      @blur="hover = -1"
    >
      <g v-for="g in 5" :key="g">
        <line
          :x1="left"
          :x2="width - right"
          :y1="y((max * (g - 1)) / 4)"
          :y2="y((max * (g - 1)) / 4)"
          class="chart-grid"
        />
        <text
          :x="left - 10"
          :y="y((max * (g - 1)) / 4) + 3"
          text-anchor="end"
          class="chart-label"
        >
          {{ compact((max * (g - 1)) / 4) }}
        </text>
      </g>
      <template v-for="s in series" :key="s.name">
        <path
          v-if="!hidden.includes(s.name)"
          :d="path(s)"
          fill="none"
          :stroke="s.color || 'var(--accent-dark)'"
          :stroke-width="focused === s.name ? 3.8 : s.total ? 2 : 2.8"
          :opacity="focused && focused !== s.name ? 0.16 : s.total ? 0.65 : 1"
          :stroke-dasharray="s.total ? '5 4' : undefined"
          stroke-linejoin="round"
          stroke-linecap="round"
          class="chart-line"
        />
        <template v-if="!hidden.includes(s.name) && labels.length < 10">
          <circle
            v-for="(v, i) in s.values"
            :key="i"
            :cx="x(i)"
            :cy="y(v)"
            :r="v === null ? 0 : 3"
            :fill="s.color || 'var(--accent-dark)'"
            stroke="var(--surface)"
            stroke-width="1.5"
          />
        </template>
      </template>
      <template v-for="(l, i) in labels" :key="i">
        <text
          v-if="i % labelsStep === 0 || i === labels.length - 1"
          :x="x(i)"
          :y="height - 7"
          text-anchor="middle"
          class="chart-label"
        >
          {{ l }}
        </text>
      </template>
      <g v-if="hover >= 0">
        <line
          :x1="x(hover)"
          :x2="x(hover)"
          :y1="top"
          :y2="height - bottom"
          class="chart-crosshair"
        />
        <circle
          v-for="s in currentRows"
          :key="s.name"
          :cx="x(hover)"
          :cy="y(s.value)"
          :r="s.value === null ? 0 : 4"
          :fill="s.color || 'var(--accent-dark)'"
          stroke="var(--surface)"
          stroke-width="2"
        />
      </g>
    </svg>
    <div
      v-if="hover >= 0"
      class="chart-tooltip"
      :style="{
        left:
          Math.min(Math.max(x(hover) - 80, 0), Math.max(0, width - 220)) + 'px',
      }"
    >
      <strong>{{ labels[hover] }}</strong>
      <div v-for="s in currentRows" :key="s.name">
        <i :style="{ background: s.color || 'var(--accent-dark)' }"></i
        ><span>{{ $clean(s.name) }}</span
        ><b>{{ s.value === null ? "未采集" : fmt(s.value) }}</b>
      </div>
    </div>
    <div v-if="!hasData && hover < 0" class="chart-no-data">
      暂无可绘制的用量记录
    </div>
    <div v-if="legend" class="chart-legend">
      <button
        v-for="s in series"
        :key="s.name"
        :class="{ off: hidden.includes(s.name) }"
        :aria-pressed="!hidden.includes(s.name)"
        @click="toggle(s.name)"
        @pointerenter="focused = s.name"
        @pointerleave="focused = null"
        @focus="focused = s.name"
        @blur="focused = null"
      >
        <i :style="{ background: s.color || 'var(--accent-dark)' }"></i
        >{{ $clean(s.name) }}
      </button>
    </div>
  </div>
</template>
