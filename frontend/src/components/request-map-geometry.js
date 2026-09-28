export const WORLD = 1440;
export function project(location, anchor) {
  let x = (location.lon + 180) * 4;
  if (Number.isFinite(anchor)) x += Math.round((anchor - x) / WORLD) * WORLD;
  const lat = Math.max(-80, Math.min(84, location.lat));
  return [
    x,
    360 -
      (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 720) / Math.PI,
  ];
}
export function hash(value) {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function route(origin, destination, id) {
  const start = project(origin),
    end = project(destination, start[0]);
  const dx = end[0] - start[0],
    dy = end[1] - start[1],
    distance = Math.hypot(dx, dy);
  const seed = hash(id),
    offset = 0.16 + (seed % 11) / 40;
  let controls;
  if (distance < 2) {
    const r = 10 + (seed % 17),
      direction = seed % 2 ? 1 : -1;
    controls = [
      [start[0] - r * direction, start[1] - r * 2],
      [end[0] + r * direction, end[1] - r * 2],
    ];
  } else {
    const bend = Math.min(130, distance * offset),
      nx = dy / distance,
      ny = -dx / distance;
    controls = [
      [start[0] + dx * 0.3 + nx * bend, start[1] + dy * 0.3 + ny * bend],
      [start[0] + dx * 0.7 + nx * bend, start[1] + dy * 0.7 + ny * bend],
    ];
  }
  const points = [start, ...controls, end];
  const at = (t) => {
    const k = 1 - t,
      weights = [k ** 3, 3 * k * k * t, 3 * k * t * t, t ** 3];
    return [0, 1].map((axis) =>
      points.reduce((sum, point, i) => sum + weights[i] * point[axis], 0),
    );
  };
  return {
    id,
    start,
    end,
    points,
    at,
    duration: 5000 + Math.min(5000, distance * 10),
    phase: (seed % 10000) / 10000,
    d: `M${start}C${controls[0]} ${controls[1]} ${end}`,
  };
}
export function fitBounds(points, aspect = 2.5) {
  if (!points.length) return { x: 0, y: -80, w: WORLD, h: WORLD / aspect };
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const xmin = Math.min(...xs),
    xmax = Math.max(...xs),
    ymin = Math.min(...ys),
    ymax = Math.max(...ys);
  const w = Math.max(130, (xmax - xmin) * 1.3, (ymax - ymin) * 1.3 * aspect),
    h = w / aspect;
  return { x: (xmin + xmax - w) / 2, y: (ymin + ymax - h) / 2, w, h };
}
