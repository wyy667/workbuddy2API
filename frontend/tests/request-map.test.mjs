import test from "node:test";
import assert from "node:assert/strict";
import {
  project,
  route,
  fitBounds,
} from "../src/components/request-map-geometry.js";
test("routes cross antimeridian by the short side and include the entire curve in fitted bounds", () => {
  const r = route({ lat: 35, lon: 179 }, { lat: 40, lon: -179 }, "request-a");
  assert.ok(Math.abs(r.end[0] - r.start[0]) < 10);
  const box = fitBounds(r.points, 2);
  for (let i = 0; i <= 100; i++) {
    const [x, y] = r.at(i / 100);
    assert.ok(
      x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h,
    );
  }
});
test("coincident endpoints make visible local loops and duplicate destinations have distinct routes", () => {
  const a = { lat: 31, lon: 104 },
    b = { lat: 40, lon: 116 };
  const loop = route(a, a, "loop");
  assert.notDeepEqual(loop.at(0.5), project(a));
  assert.deepEqual(loop.start, loop.end);
  assert.notEqual(route(a, b, "first").d, route(a, b, "second").d);
});
test("idle and polar cameras stay finite across mobile and desktop aspect ratios", () => {
  for (const aspect of [0.7, 3])
    for (const points of [[], [project({ lat: 90, lon: 0 })]]) {
      const box = fitBounds(points, aspect);
      assert.ok(Object.values(box).every(Number.isFinite));
      assert.equal(box.w / box.h, aspect);
    }
});
