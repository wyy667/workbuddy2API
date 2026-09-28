<script setup>
import {
  ref,
  computed,
  watch,
  onMounted,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  nextTick,
} from "vue";
import { apiUrl, authHeaders } from "../store.js";
import boundaries from "../assets/world-map.json";
import { route, project, fitBounds, WORLD } from "./request-map-geometry.js";
import {
  Maximize2,
  Minimize2,
  LocateFixed,
  Plus,
  Minus,
  Radio,
  ArrowUpRight,
  X,
  MapPin,
  KeyRound,
  Globe2,
  Pause,
  Play,
  Power,
} from "lucide-vue-next";
defineProps({ disabling: Boolean });
const emit = defineEmits(["disable", "disabled"]);

const root = ref(null),
  canvas = ref(null),
  origin = ref(null),
  requests = ref([]),
  database = ref({});
const connected = ref(false),
  loaded = ref(false),
  full = ref(false),
  manual = ref(false);
const selectedId = ref(""),
  pinned = ref(false),
  pointer = ref({ x: 24, y: 70 });
const size = ref({ w: 1100, h: 460 }),
  camera = ref({ x: 0, y: -80, w: 1440, h: 602 });
const now = ref(Date.now()),
  reduced = ref(false);
const motion = ref(true);
let target = { ...camera.value },
  instance = "",
  sequence = -1,
  source,
  reconnect,
  poll,
  clock,
  frame;
let alive = false,
  visible = true,
  observer,
  resize,
  media,
  lastMessage = 0,
  controller,
  epoch = 0;
const heads = new Map(),
  touches = new Map();
let drag = null,
  gesture = null,
  moved = false,
  pressedId = "";
const scale = computed(() => camera.value.w / size.value.w);
const routes = computed(() =>
  origin.value?.location
    ? requests.value
        .filter((r) => r.location)
        .map((r) => ({
          ...route(origin.value.location, r.location, r.id),
          request: r,
        }))
    : [],
);
const unknown = computed(() =>
  requests.value.filter((r) => !r.location || !origin.value?.location),
);
const selected = computed(() =>
  requests.value.find((r) => r.id === selectedId.value),
);
const originPoint = computed(() =>
  origin.value?.location ? project(origin.value.location) : null,
);
const tooltipStyle = computed(() =>
  pinned.value
    ? { right: "18px", top: "18px" }
    : {
        left:
          Math.max(
            8,
            Math.min(
              size.value.w - Math.min(300, size.value.w - 16) - 8,
              pointer.value.x + 18,
            ),
          ) + "px",
        top:
          Math.max(8, Math.min(size.value.h - 258, pointer.value.y - 36)) +
          "px",
      },
);
const statusText = computed(() =>
  !loaded.value
    ? "正在连接"
    : !connected.value
      ? "同步中断 · 正在重连"
      : requests.value.length
        ? "实时连接"
        : "等待新的请求",
);
const shortNames = {
  中华人民共和国: "中国",
  中华民国: "台湾",
  大韩民国: "韩国",
  朝鲜民主主义人民共和国: "朝鲜",
  俄罗斯联邦: "俄罗斯",
  美利坚合众国: "美国",
};
const mapLabels = computed(() =>
  camera.value.w < 450 && size.value.w > 700
    ? boundaries.labels.map((label) => [
        shortNames[label[0]] || label[0],
        label[1],
        label[2],
      ])
    : [],
);
const elapsed = (start) => {
  const s = Math.max(0, Math.floor((now.value - start) / 1000));
  return s < 60 ? s + " 秒" : Math.floor(s / 60) + " 分 " + (s % 60) + " 秒";
};
function apply(message) {
  if (message.type === "disabled" || message.enabled === false) {
    stop();
    emit("disabled");
    return;
  }
  if (message.type === "snapshot") {
    if (message.instance === instance && message.seq < sequence) return;
    instance = message.instance;
    sequence = message.seq;
    requests.value = message.requests;
    origin.value = message.origin;
    database.value = message.database;
    loaded.value = true;
  } else {
    if (message.instance !== instance) {
      reconcile();
      return;
    }
    if (message.type === "heartbeat") return;
    if (message.seq <= sequence) return;
    if (message.seq > sequence + 1) reconcile();
    sequence = message.seq;
    if (message.type === "upsert") {
      const index = requests.value.findIndex(
        (r) => r.id === message.request.id,
      );
      if (index < 0) requests.value.push(message.request);
      else requests.value[index] = message.request;
    } else if (message.type === "remove")
      requests.value = requests.value.filter((r) => r.id !== message.id);
    else if (message.type === "origin") {
      origin.value = message.origin;
      database.value = message.database;
    }
  }
  if (
    selectedId.value &&
    !requests.value.some((r) => r.id === selectedId.value)
  ) {
    selectedId.value = "";
    pinned.value = false;
  }
}
async function reconcile() {
  if (!alive || controller) return;
  const ctl = (controller = new AbortController()),
    current = epoch;
  const timeout = setTimeout(() => ctl.abort(), 8000);
  try {
    const response = await fetch(apiUrl("/request-map"), {
      signal: ctl.signal,
      cache: "no-store",
      headers: authHeaders(),
      credentials: "same-origin",
    });
    if (!response.ok) throw Error("unavailable");
    const data = await response.json();
    if (alive && epoch === current) apply({ ...data, type: "snapshot" });
  } catch {
  } finally {
    clearTimeout(timeout);
    if (controller === ctl) controller = null;
  }
}
function connect() {
  if (!alive || document.hidden) return;
  source?.close();
  const stream = (source = new EventSource(apiUrl("/request-map/live")));
  stream.onmessage = (event) => {
    if (source !== stream || !alive) return;
    try {
      apply(JSON.parse(event.data));
      connected.value = true;
      lastMessage = Date.now();
    } catch {}
  };
  stream.onerror = () => {
    if (source !== stream) return;
    connected.value = false;
    stream.close();
    source = null;
    clearTimeout(reconnect);
    reconnect = setTimeout(connect, 3000);
  };
}
function desired() {
  const points = routes.value.flatMap((r) => r.points);
  if (originPoint.value) points.push(originPoint.value);
  return fitBounds(points, size.value.w / size.value.h);
}
function focus() {
  manual.value = false;
  target = desired();
}
function autoFit() {
  if (manual.value) return;
  const wanted = desired();
  if (!originPoint.value || (!routes.value.length && !requests.value.length)) {
    target = wanted;
    return;
  }
  const points = routes.value
    .flatMap((r) => r.points)
    .concat([originPoint.value]);
  if (
    target.w >= WORLD ||
    points.some(
      ([x, y]) =>
        x < target.x + target.w * 0.07 ||
        x > target.x + target.w * 0.93 ||
        y < target.y + target.h * 0.07 ||
        y > target.y + target.h * 0.93,
    )
  )
    target = wanted;
}
watch([routes, originPoint], autoFit);
function zoom(factor, position = { x: size.value.w / 2, y: size.value.h / 2 }) {
  manual.value = true;
  const old = camera.value,
    w = Math.max(32, Math.min(2400, old.w * factor)),
    ratio = w / old.w;
  target = {
    x: old.x + (position.x / size.value.w) * old.w * (1 - ratio),
    y: old.y + (position.y / size.value.h) * old.h * (1 - ratio),
    w,
    h: (w * size.value.h) / size.value.w,
  };
}
const point = (e) => {
  const box = canvas.value.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
};
function wheel(e) {
  e.preventDefault();
  zoom(Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.002), point(e));
}
function down(e) {
  if (e.button !== 0 && e.pointerType !== "touch") return;
  e.preventDefault();
  touches.set(e.pointerId, point(e));
  moved = false;
  pressedId =
    e.target.closest?.("[data-request-id]")?.getAttribute("data-request-id") ||
    "";
  canvas.value.setPointerCapture(e.pointerId);
  if (touches.size === 1)
    drag = { point: point(e), camera: { ...camera.value } };
  else if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    gesture = {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      camera: { ...camera.value },
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }
}
function move(e) {
  if (!pinned.value) pointer.value = point(e);
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, point(e));
  if (touches.size === 2 && gesture) {
    const [a, b] = [...touches.values()],
      center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const w = Math.max(
      32,
      Math.min(
        2400,
        (gesture.camera.w * gesture.distance) /
          Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      ),
    );
    const old = gesture.camera,
      h = (w * size.value.h) / size.value.w;
    camera.value = target = {
      x:
        old.x +
        (gesture.center.x / size.value.w) * old.w -
        (center.x / size.value.w) * w,
      y:
        old.y +
        (gesture.center.y / size.value.h) * old.h -
        (center.y / size.value.h) * h,
      w,
      h,
    };
    moved = true;
    manual.value = true;
  } else if (drag) {
    const p = point(e),
      dx = p.x - drag.point.x,
      dy = p.y - drag.point.y;
    if (Math.hypot(dx, dy) > 3) {
      moved = true;
      manual.value = true;
      if (!pinned.value) selectedId.value = "";
    }
    if (moved)
      camera.value = target = {
        ...drag.camera,
        x: drag.camera.x - dx * scale.value,
        y: drag.camera.y - dy * scale.value,
      };
  }
}
function up(e) {
  if (!moved && pressedId && e.type !== "pointercancel") pin(pressedId);
  touches.delete(e.pointerId);
  if (!touches.size) {
    drag = null;
    gesture = null;
  } else {
    const p = [...touches.values()][0];
    drag = { point: p, camera: { ...camera.value } };
    gesture = null;
  }
}
function hover(id, e) {
  if (!pinned.value && !drag) {
    selectedId.value = id;
    pointer.value = point(e);
  }
}
function pin(id) {
  selectedId.value = id;
  pinned.value = true;
}
function leave() {
  if (!pinned.value) selectedId.value = "";
}
async function fullscreen() {
  if (full.value) {
    if (document.fullscreenElement === root.value)
      await document.exitFullscreen().catch(() => {});
    full.value = false;
  } else {
    full.value = true;
    await root.value.requestFullscreen?.().catch(() => {});
  }
  nextTick(() => resizeMap());
}
function fullscreenChanged() {
  full.value = document.fullscreenElement === root.value;
  nextTick(resizeMap);
}
function escape(e) {
  if (e.key === "Escape") {
    if (document.fullscreenElement === root.value)
      document.exitFullscreen().catch(() => {});
    full.value = false;
    pinned.value = false;
    selectedId.value = "";
    nextTick(resizeMap);
  }
}
function resizeMap() {
  if (!canvas.value) return;
  const box = canvas.value.getBoundingClientRect();
  if (!box.width || !box.height) return;
  size.value = { w: box.width, h: box.height };
  if (!manual.value) target = desired();
  else target = { ...target, h: (target.w * box.height) / box.width };
}
function animate(time) {
  if (!alive) return;
  if (visible && !document.hidden) {
    const current = camera.value,
      next = {};
    let changed = false;
    for (const k of ["x", "y", "w", "h"]) {
      next[k] = reduced.value
        ? target[k]
        : current[k] + (target[k] - current[k]) * 0.12;
      if (Math.abs(next[k] - current[k]) > 0.0005) changed = true;
    }
    if (changed) camera.value = next;
    if (connected.value && motion.value)
      for (const r of routes.value) {
        const t =
            (time / (r.duration * (reduced.value ? 1.35 : 1)) + r.phase) % 1,
          p = r.at(t),
          before = r.at(Math.max(0, t - 0.002)),
          after = r.at(Math.min(1, t + 0.002));
        const angle =
          (Math.atan2(after[1] - before[1], after[0] - before[0]) * 180) /
          Math.PI;
        heads
          .get(r.id)
          ?.setAttribute(
            "transform",
            `translate(${p}) rotate(${angle}) scale(${scale.value})`,
          );
      }
  }
  frame = requestAnimationFrame(animate);
}
function start() {
  if (alive) return;
  alive = true;
  epoch++;
  connect();
  reconcile();
  poll = setInterval(() => {
    if (!document.hidden) reconcile();
  }, 10000);
  clock = setInterval(() => {
    now.value = Date.now();
    if (connected.value && Date.now() - lastMessage > 35000) {
      connected.value = false;
      connect();
    }
  }, 1000);
  frame = requestAnimationFrame(animate);
}
function stop() {
  alive = false;
  epoch++;
  connected.value = false;
  source?.close();
  source = null;
  controller?.abort();
  controller = null;
  clearTimeout(reconnect);
  clearInterval(poll);
  clearInterval(clock);
  cancelAnimationFrame(frame);
  touches.clear();
  drag = null;
  gesture = null;
  full.value = false;
}
function visibility() {
  if (document.hidden) stop();
  else start();
}
function motionChange() {
  reduced.value = media.matches;
}
onMounted(() => {
  document.addEventListener("visibilitychange", visibility);
  start();
  media = matchMedia("(prefers-reduced-motion: reduce)");
  motionChange();
  media.addEventListener("change", motionChange);
  resize = new ResizeObserver(resizeMap);
  resize.observe(canvas.value);
  observer = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
  });
  observer.observe(root.value);
  document.addEventListener("fullscreenchange", fullscreenChanged);
  document.addEventListener("keydown", escape);
  resizeMap();
});
onActivated(() => {
  document.addEventListener("visibilitychange", visibility);
  start();
  nextTick(resizeMap);
});
onDeactivated(() => {
  document.removeEventListener("visibilitychange", visibility);
  stop();
});
onBeforeUnmount(() => {
  stop();
  resize?.disconnect();
  observer?.disconnect();
  media?.removeEventListener("change", motionChange);
  document.removeEventListener("visibilitychange", visibility);
  document.removeEventListener("fullscreenchange", fullscreenChanged);
  document.removeEventListener("keydown", escape);
});
</script>

<template>
  <section
    ref="root"
    class="request-map panel"
    :class="{
      'map-full': full,
      'map-disconnected': !connected,
      'map-reduced': reduced,
      'map-paused': !motion,
    }"
    aria-label="实时请求地图"
  >
    <header class="panel-head map-header">
      <div class="map-heading">
        <span class="map-heading-icon"><Globe2 :size="21" /></span>
        <div>
          <h2>
            实时请求地图 <span class="section-slash">/</span>
            <span class="muted section-en">Live connections</span>
          </h2>
          <p>从此刻出发，连接正在发生</p>
        </div>
      </div>
      <div class="map-controls">
        <button
          aria-label="关闭地图并释放内存"
          title="关闭地图并释放内存"
          :disabled="disabling"
          @click="emit('disable')"
        >
          <Power :size="16" />
        </button>
        <span class="map-live" :class="{ online: connected }"
          ><i></i>{{ connected ? "LIVE" : "SYNC" }}</span
        >
        <button
          :aria-label="motion ? '暂停流星动画' : '播放流星动画'"
          :aria-pressed="!motion"
          @click="motion = !motion"
        >
          <component :is="motion ? Pause : Play" :size="16" />
        </button>
        <button
          aria-label="聚焦当前请求"
          :class="{ selected: !manual }"
          @click="focus"
        >
          <LocateFixed :size="17" />
        </button>
        <button aria-label="放大地图" @click="zoom(0.75)">
          <Plus :size="17" /></button
        ><button aria-label="缩小地图" @click="zoom(1.333)">
          <Minus :size="17" />
        </button>
        <button
          :aria-label="full ? '退出地图全屏' : '全屏查看地图'"
          @click="fullscreen"
        >
          <component :is="full ? Minimize2 : Maximize2" :size="17" />
        </button>
      </div>
    </header>
    <div
      ref="canvas"
      class="map-canvas"
      @wheel="wheel"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @pointerleave="leave"
    >
      <svg
        class="map-background"
        :viewBox="`${camera.x} ${camera.y} ${camera.w} ${camera.h}`"
        aria-hidden="true"
      >
        <defs>
          <pattern
            id="request-map-grid"
            width="30"
            height="30"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M30 0H0V30"
              fill="none"
              class="map-grid"
              vector-effect="non-scaling-stroke"
            />
          </pattern>
        </defs>
        <rect
          :x="camera.x"
          :y="camera.y"
          :width="camera.w"
          :height="camera.h"
          fill="url(#request-map-grid)"
        />
        <g
          v-for="offset in [-WORLD, 0, WORLD]"
          :key="offset"
          :transform="`translate(${offset} 0)`"
          aria-hidden="true"
        >
          <path
            :d="boundaries.countries"
            class="map-land"
            vector-effect="non-scaling-stroke"
          />
          <path
            :d="boundaries.regions"
            class="map-regions"
            vector-effect="non-scaling-stroke"
          />
          <g
            v-for="label in mapLabels"
            :key="label[0]"
            :transform="`translate(${label[1]} ${label[2]}) scale(${scale})`"
          >
            <text class="map-label">{{ label[0] }}</text>
          </g>
        </g>
      </svg>
      <svg
        class="map-svg"
        :viewBox="`${camera.x} ${camera.y} ${camera.w} ${camera.h}`"
        aria-label="源站与活动请求位置"
        role="img"
      >
        <defs>
          <linearGradient
            id="request-meteor-gradient"
            x1="-38"
            y1="0"
            x2="0"
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stop-color="var(--map-green)" stop-opacity="0" />
            <stop
              offset=".65"
              stop-color="var(--map-green)"
              stop-opacity=".55"
            />
            <stop offset="1" stop-color="var(--map-head)" stop-opacity="1" />
          </linearGradient>
        </defs>
        <TransitionGroup name="map-route-fade" tag="g">
          <g
            v-for="r in routes"
            :key="r.id"
            class="map-route"
            :class="{ 'is-selected': selectedId === r.id }"
            :data-request-id="r.id"
          >
            <path
              :d="r.d"
              class="map-route-base"
              vector-effect="non-scaling-stroke"
            />
            <g :transform="`translate(${r.end}) scale(${scale})`">
              <circle class="map-destination-halo" r="9" />
              <circle class="map-destination" r="3" />
            </g>
            <g
              :ref="(el) => (el ? heads.set(r.id, el) : heads.delete(r.id))"
              :transform="`translate(${r.at(r.phase)}) scale(${scale})`"
              class="map-meteor-head"
              @pointerenter="hover(r.id, $event)"
              @pointermove="hover(r.id, $event)"
              @pointerleave="leave"
            >
              <path
                d="M-38-.3Q-20-1.5-2-1.5L1 0-2 1.5Q-20 1.5-38 .3Z"
                fill="url(#request-meteor-gradient)"
              />
              <circle r="6" class="map-head-glow" />
              <circle r="2" class="map-head-core" />
            </g>
            <path
              :d="r.d"
              class="map-hit"
              vector-effect="non-scaling-stroke"
              tabindex="0"
              role="button"
              :aria-label="`${$clean(r.request.model)}，${$clean(r.request.keyName)}，查看请求详情`"
              @pointerenter="hover(r.id, $event)"
              @pointermove="hover(r.id, $event)"
              @pointerleave="leave"
              @keydown.enter.prevent="pin(r.id)"
              @focus="
                selectedId = r.id;
                pinned = true;
              "
            />
          </g>
        </TransitionGroup>
        <g
          v-if="originPoint"
          :transform="`translate(${originPoint}) scale(${scale})`"
          class="map-origin"
        >
          <circle r="20" class="map-origin-halo" />
          <circle r="9" class="map-origin-ring" />
          <path d="M0-5L5 0 0 5-5 0Z" class="map-origin-core" />
          <text y="-29" text-anchor="middle">{{ origin.kind }}</text>
        </g>
      </svg>
      <div class="map-topline" @pointerdown.stop>
        <span><Radio :size="13" />{{ statusText }}</span
        ><span
          >{{ requests.length }} 处理中 <b>/</b>
          {{ routes.length }} 已连线</span
        >
      </div>
      <div v-if="!origin?.location" class="map-empty" @pointerdown.stop>
        <Globe2 :size="30" /><strong>{{
          origin?.ip ? "源站位置暂不可用" : "正在识别源站位置"
        }}</strong
        ><span>{{
          database.error || origin?.status || "正在加载本地地理数据"
        }}</span>
      </div>
      <div v-else-if="!requests.length" class="map-idle" @pointerdown.stop>
        <span class="map-idle-line"></span>连接就绪，等待下一次请求
      </div>
      <div class="map-origin-caption" @pointerdown.stop>
        <span class="map-caption-kicker">ORIGIN</span
        ><strong>{{
          origin?.location?.label || origin?.status || "正在定位"
        }}</strong
        ><code>{{ origin?.ip || "—" }}</code>
      </div>
      <div class="map-navigation-hint" @pointerdown.stop>
        {{ manual ? "自由浏览 · 点击定位按钮恢复聚焦" : "自动聚焦"
        }}<span>拖动平移 · 滚轮缩放</span>
      </div>
      <Transition name="map-detail"
        ><aside
          v-if="selected"
          class="map-detail"
          :style="tooltipStyle"
          @pointerdown.stop
          @wheel.stop
          @pointerenter="pinned = true"
        >
          <div class="map-detail-heading">
            <span><i></i>正在处理</span
            ><button
              aria-label="关闭请求详情"
              @click="
                selectedId = '';
                pinned = false;
              "
            >
              <X :size="15" />
            </button>
          </div>
          <h3>{{ $clean(selected.model) }}</h3>
          <p class="map-detail-location">
            <MapPin :size="13" />{{
              selected.location?.label || selected.locationStatus
            }}
          </p>
          <dl>
            <dt>请求 IP</dt>
            <dd>{{ selected.ip || "未知" }}</dd>
            <dt>密钥名称</dt>
            <dd class="map-key-name">
              <KeyRound :size="12" />{{ $clean(selected.keyName) }}
            </dd>
            <dt>简写 Key</dt>
            <dd>{{ selected.keyMasked }}</dd>
            <dt>持续时间</dt>
            <dd>{{ elapsed(selected.startedAt) }}</dd>
            <dt>响应方式</dt>
            <dd>{{ selected.stream ? "流式响应" : "非流式响应" }}</dd>
            <dt>定位精度</dt>
            <dd>{{ selected.location?.precision || "未定位" }}</dd>
          </dl>
        </aside></Transition
      >
    </div>
    <div v-if="unknown.length" class="map-unlocated">
      <span
        >待定位请求 <b>{{ unknown.length }}</b></span
      ><button v-for="r in unknown" :key="r.id" @click="pin(r.id)">
        {{ $clean(r.model) }}<span>{{ $clean(r.keyName) }}</span
        ><ArrowUpRight :size="12" />
      </button>
    </div>
    <footer class="map-footer">
      <span
        ><i></i>绿色流星仅示意活动请求，不代表真实传输路径；位置基于 IP
        估算。</span
      ><span
        ><a href="https://db-ip.com" target="_blank" rel="noopener noreferrer"
          >IP Geolocation by DB-IP</a
        ><span class="map-attribution-dot">·</span
        ><a
          href="https://www.naturalearthdata.com/about/"
          target="_blank"
          rel="noopener noreferrer"
          >Natural Earth</a
        ></span
      >
    </footer>
  </section>
</template>

<style scoped>
.request-map {
  --map-ocean: #f1f6f5;
  --map-land: #e4edeb;
  --map-border: #9db9b4;
  --map-region: #b1c9c4;
  --map-ink: #506d67;
  --map-green: #008348;
  --map-head: #09ad61;
  overflow: hidden;
  isolation: isolate;
}
:global([data-theme="dark"] .request-map) {
  --map-ocean: #080f1b;
  --map-land: #0d1d32;
  --map-border: #2a5685;
  --map-region: #1e3e62;
  --map-ink: #7396b3;
  --map-green: #36e998;
  --map-head: #a2ffcf;
}
.map-header {
  gap: 15px;
}
.map-heading {
  display: flex;
  align-items: center;
  gap: 13px;
}
.map-heading-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--surface-subtle);
  color: var(--subtext);
}
.map-controls {
  display: flex;
  align-items: center;
  gap: 5px;
}
.map-controls button {
  background: transparent;
  width: 33px;
  height: 33px;
  border: 1px solid transparent;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--muted);
  transition:
    background 0.2s,
    color 0.2s,
    border-color 0.2s;
}
.map-controls button:hover,
.map-controls button.selected {
  background: var(--surface-subtle);
  color: var(--text);
  border-color: var(--border);
}
.map-live {
  font-size: 10px;
  letter-spacing: 1.4px;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 12px;
  color: var(--muted);
}
.map-live i,
.map-detail-heading i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.map-live.online {
  color: var(--map-green);
}
.map-canvas {
  user-select: none;
  -webkit-user-select: none;
  position: relative;
  height: 460px;
  background: var(--map-ocean);
  overflow: hidden;
  touch-action: none;
  cursor: grab;
  border-block: 1px solid var(--border);
  color: var(--map-ink);
}
.map-canvas:active {
  cursor: grabbing;
}
.map-svg,
.map-background {
  width: 100%;
  height: 100%;
  display: block;
  transform: translateZ(0);
}
.map-svg {
  position: absolute;
  inset: 0;
}
.map-grid {
  stroke: var(--map-border);
  stroke-width: 0.5;
  opacity: 0.17;
}
.map-land {
  fill: var(--map-land);
  stroke: var(--map-border);
  stroke-width: 0.8;
  fill-rule: evenodd;
}
.map-regions {
  fill: none;
  stroke: var(--map-region);
  stroke-width: 0.5;
  opacity: 0.8;
}
.map-label {
  font-size: 10px;
  fill: var(--map-ink);
  text-anchor: middle;
  opacity: 0.6;
  letter-spacing: 1px;
  pointer-events: none;
}
.map-route-fade-enter-active,
.map-route-fade-leave-active {
  transition: opacity 0.22s;
}
.map-route-fade-enter-from,
.map-route-fade-leave-to {
  opacity: 0;
}
.map-route-base {
  fill: none;
  stroke: var(--map-green);
  stroke-width: 0.65;
  opacity: 0.3;
}
.map-route.is-selected .map-route-base {
  opacity: 0.65;
  stroke-width: 0.85;
}
.map-head-glow {
  fill: var(--map-green);
  opacity: 0.15;
}
.map-head-core {
  fill: var(--map-head);
}
.map-destination-halo {
  fill: var(--map-green);
  opacity: 0.09;
}
.map-destination {
  fill: var(--map-green);
  opacity: 0.8;
}
.map-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 18;
  cursor: pointer;
  pointer-events: stroke;
  outline: none;
}
.map-hit:focus-visible {
  stroke: var(--map-green);
  stroke-width: 3;
  opacity: 0.5;
}
.map-origin-halo {
  fill: var(--map-green);
  opacity: 0.07;
}
.map-origin-ring {
  fill: var(--map-ocean);
  stroke: var(--map-green);
  stroke-width: 1;
  opacity: 0.9;
}
.map-origin-core {
  fill: var(--map-green);
}
.map-origin text {
  fill: var(--map-green);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 2px;
}
.map-disconnected .map-meteor-head {
  display: none;
}
.map-topline {
  position: absolute;
  top: 18px;
  left: 22px;
  right: 22px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  pointer-events: none;
}
.map-topline > span {
  display: flex;
  align-items: center;
  gap: 8px;
}
.map-topline b {
  font-weight: 400;
  opacity: 0.4;
  margin: 0 3px;
}
.map-origin-caption {
  position: absolute;
  bottom: 23px;
  left: 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
  text-shadow: 0 1px 6px var(--map-ocean);
}
.map-caption-kicker {
  font-size: 9px;
  letter-spacing: 2px;
  opacity: 0.65;
}
.map-origin-caption strong {
  font-size: 13px;
  font-weight: 500;
}
.map-origin-caption code {
  font-size: 11px;
  opacity: 0.75;
}
.map-navigation-hint {
  position: absolute;
  right: 22px;
  bottom: 22px;
  font-size: 10px;
  text-align: right;
  pointer-events: none;
}
.map-navigation-hint span {
  display: block;
  opacity: 0.6;
  margin-top: 5px;
}
.map-idle {
  position: absolute;
  top: 55px;
  left: 22px;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 8px;
  opacity: 0.8;
  pointer-events: none;
}
.map-idle-line {
  width: 20px;
  height: 1px;
  background: var(--map-green);
}
.map-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  pointer-events: none;
}
.map-empty strong {
  font-size: 14px;
  font-weight: 500;
}
.map-empty span {
  font-size: 11px;
}
.map-detail {
  user-select: text;
  -webkit-user-select: text;
  position: absolute;
  z-index: 4;
  width: 290px;
  max-width: calc(100% - 16px);
  padding: 17px 18px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  box-shadow: 0 12px 40px #0002;
  cursor: default;
}
.map-detail-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--map-green);
  font-size: 10px;
  letter-spacing: 0.6px;
}
.map-detail-heading > span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.map-detail-heading button {
  background: transparent;
  border: 0;
  display: grid;
  place-items: center;
  color: var(--muted);
}
.map-detail h3 {
  font-family: var(--font-mono, monospace);
  font-size: 14px;
  font-weight: 500;
  margin: 12px 0 5px;
  overflow-wrap: anywhere;
}
.map-detail-location {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 12px;
}
.map-detail dl {
  display: grid;
  grid-template-columns: 65px minmax(0, 1fr);
  gap: 8px 10px;
  margin: 0;
  border-top: 1px solid var(--border);
  padding-top: 12px;
  font-size: 11px;
}
.map-detail dt {
  color: var(--muted);
}
.map-detail dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.map-key-name {
  display: flex;
  gap: 5px;
  align-items: center;
  justify-content: flex-end;
}
.map-detail-enter-active,
.map-detail-leave-active {
  transition:
    opacity 0.16s,
    transform 0.16s;
}
.map-detail-enter-from,
.map-detail-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
.map-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 15px 22px;
  font-size: 10px;
  color: var(--muted);
}
.map-footer > span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.map-footer i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--map-green);
  flex: none;
}
.map-footer a {
  color: inherit;
  text-decoration: none;
}
.map-footer a:hover {
  text-decoration: underline;
}
.map-attribution-dot {
  opacity: 0.5;
}
.map-unlocated {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 22px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.map-unlocated > span {
  white-space: nowrap;
  color: var(--muted);
}
.map-unlocated button {
  display: flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.map-unlocated button span {
  color: var(--muted);
}
.request-map.map-full,
.request-map:fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  border-radius: 0;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  margin: 0;
  width: 100%;
  height: 100dvh;
}
.map-full .map-canvas,
:fullscreen .map-canvas {
  user-select: none;
  -webkit-user-select: none;
  flex: 1;
  height: auto;
  min-height: 0;
}
.map-full .map-header {
  flex: none;
}
.map-full .map-footer {
  flex: none;
}
@media (max-width: 700px) {
  .map-canvas {
    user-select: none;
    -webkit-user-select: none;
    height: 340px;
  }
  .map-header {
    flex-wrap: wrap;
    padding: 18px;
  }
  .map-heading-icon {
    display: none;
  }
  .map-header .section-en,
  .map-header .section-slash {
    display: none;
  }
  .map-controls {
    margin-left: auto;
  }
  .map-live {
    margin-right: 6px;
  }
  .map-controls button {
    background: transparent;
    width: 30px;
    height: 30px;
  }
  .map-topline {
    left: 14px;
    right: 14px;
    font-size: 10px;
  }
  .map-origin-caption {
    left: 15px;
    bottom: 17px;
    max-width: 65%;
  }
  .map-navigation-hint {
    right: 14px;
    bottom: 17px;
  }
  .map-navigation-hint span {
    display: none;
  }
  .map-footer {
    padding: 12px 15px;
    flex-wrap: wrap;
    line-height: 1.7;
  }
  .map-idle {
    left: 14px;
    font-size: 10px;
  }
  .map-detail {
    user-select: text;
    -webkit-user-select: text;
    padding: 14px;
  }
  .map-heading h2 {
    font-size: 14px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .map-detail-enter-active,
  .map-detail-leave-active {
    transition: none;
  }
}
</style>
