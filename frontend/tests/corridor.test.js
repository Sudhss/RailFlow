/**
 * Tests for the corridor's pure geometry and physics.
 *
 * These modules decide where every train is drawn, so their invariants are
 * worth asserting: arc-length parameterisation (a train must not speed up
 * through a curve), dead reckoning matching the server's own integrator, and
 * the layout wave agreeing between its JS and GLSL forms.
 *
 * Uses the Node test runner. No test dependency is installed for this.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildBases, corridorCoordinates, mercator, panDelta } from "../src/corridor/projection.js";
import { buildAlignment, sampleAt, sampleSection, throughAxis } from "../src/corridor/alignment.js";
import { attitude, createTrainMotion, integrate, reconcile, simMinutes } from "../src/corridor/physics.js";
import { corridorAt, waveAt, WAVE_SPREAD, WAVE_GLSL } from "../src/corridor/wave.js";

const STATIONS = [
  { id: "A", name: "A", lat: 28.64, lng: 77.22, x: 5, y: 45, type: "terminal", dwell_base: 5 },
  { id: "B", name: "B", lat: 28.67, lng: 77.45, x: 20, y: 42, type: "junction", dwell_base: 4 },
  { id: "C", name: "C", lat: 28.73, lng: 77.78, x: 37, y: 32, type: "junction", dwell_base: 3 },
  { id: "D", name: "D", lat: 26.83, lng: 80.92, x: 195, y: 67, type: "terminal", dwell_base: 5 },
];

const EDGES = [
  { id: "A-B", from: "A", to: "B", distance_km: 16, avg_speed: 55, capacity: 3 },
  { id: "B-C", from: "B", to: "C", distance_km: 35, avg_speed: 80, capacity: 2 },
  { id: "C-D", from: "C", to: "D", distance_km: 400, avg_speed: 75, capacity: 2 },
];

/* ------------------------------------------------------------- projection */

test("mercator is monotonic in latitude and clamps at the poles", () => {
  assert.ok(mercator(30, 0).my > mercator(20, 0).my);
  assert.ok(Number.isFinite(mercator(90, 0).my));
  assert.ok(Number.isFinite(mercator(-90, 0).my));
});

test("both bases are built and stay finite", () => {
  const bases = buildBases(STATIONS);
  for (const id of ["A", "B", "C", "D"]) {
    for (const basis of [bases.geographic, bases.schematic]) {
      assert.ok(Number.isFinite(basis[id].x), `${id}.x finite`);
      assert.ok(Number.isFinite(basis[id].z), `${id}.z finite`);
    }
  }
});

test("the two bases genuinely differ, which is what the morph reveals", () => {
  const { geographic, schematic } = buildBases(STATIONS);
  const moved = ["A", "B", "C", "D"].some(
    (id) => Math.hypot(geographic[id].x - schematic[id].x, geographic[id].z - schematic[id].z) > 1
  );
  assert.ok(moved, "at least one station must sit somewhere different in each basis");
});

test("empty input does not throw", () => {
  const bases = buildBases([]);
  assert.deepEqual(bases.order, []);
});

test("corridor coordinates span 0..1", () => {
  const { geographic, order } = buildBases(STATIONS);
  const corridor = corridorCoordinates(geographic, order);
  const values = order.map((id) => corridor[id]);
  assert.equal(Math.min(...values), 0);
  assert.equal(Math.max(...values), 1);
});

/* -------------------------------------------------------------- alignment */

test("through axis of a mid-corridor station follows its two neighbours", () => {
  const positions = { A: { x: 0, z: 0 }, B: { x: 10, z: 0 }, C: { x: 20, z: 0 } };
  const axis = throughAxis("B", ["A", "C"], positions);
  assert.ok(Math.abs(Math.abs(axis.x) - 1) < 1e-6, "axis runs along the corridor");
  assert.ok(Math.abs(axis.z) < 1e-6);
});

test("a terminal points at its only neighbour", () => {
  const positions = { A: { x: 0, z: 0 }, B: { x: 0, z: 5 } };
  const axis = throughAxis("A", ["B"], positions);
  assert.ok(Math.abs(axis.z - 1) < 1e-6);
});

test("an isolated station does not produce NaN", () => {
  const axis = throughAxis("A", [], { A: { x: 0, z: 0 } });
  assert.ok(Number.isFinite(axis.x) && Number.isFinite(axis.z));
});

test("sampleAt is arc-length parameterised, not parameter-uniform", () => {
  // A deliberately curved section: uniform Bezier parameter would bunch the
  // samples through the bend. Equal fractions must cover equal distance.
  const section = sampleSection(
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: 1 },
    0.9
  );

  const steps = 20;
  const lengths = [];
  let previous = sampleAt(section, 0).position;
  for (let i = 1; i <= steps; i += 1) {
    const point = sampleAt(section, i / steps).position;
    lengths.push(Math.hypot(point.x - previous.x, point.z - previous.z));
    previous = point;
  }

  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  // Within a few percent across a strongly curved section.
  assert.ok(max / min < 1.06, `equal-fraction steps must cover equal distance (ratio ${max / min})`);
});

test("sampleAt clamps outside 0..1 instead of running off the section", () => {
  const section = sampleSection({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 0 }, 0.2);
  const start = sampleAt(section, -5).position;
  const end = sampleAt(section, 5).position;
  assert.ok(Math.abs(start.x - 0) < 1e-6);
  assert.ok(Math.abs(end.x - 10) < 1e-6);
});

test("a straight section reports ~zero curvature, a bent one does not", () => {
  const straight = sampleSection({ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 0 }, 0.3);
  // Opposed station axes give a single C-shaped bend. (Parallel axes would give
  // an S, whose midpoint is an inflection with genuinely zero curvature.)
  const bent = sampleSection({ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }, 0.9);

  const peak = (section) => {
    let max = 0;
    for (let i = 0; i <= 20; i += 1) {
      max = Math.max(max, Math.abs(sampleAt(section, i / 20).curvature));
    }
    return max;
  };

  assert.ok(peak(straight) < 1e-4, `straight section curvature ${peak(straight)}`);
  assert.ok(peak(bent) > 1e-3, `bent section curvature ${peak(bent)}`);
});

test("an S-bend changes the sign of its curvature", () => {
  // Parallel station axes produce a reverse curve, which a train leans through
  // one way then the other. The sign must actually flip.
  const s = sampleSection({ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 0, z: 1 }, { x: 0, z: 1 }, 0.9);
  const early = sampleAt(s, 0.2).curvature;
  const late = sampleAt(s, 0.8).curvature;
  assert.ok(early * late < 0, `expected a sign change, got ${early} and ${late}`);
});

test("alignment covers every edge with usable endpoints", () => {
  const { schematic } = buildBases(STATIONS);
  const sections = buildAlignment(STATIONS, EDGES, schematic);
  for (const edge of EDGES) {
    assert.ok(sections[edge.id], `${edge.id} has an alignment`);
    assert.ok(sections[edge.id].length > 0, `${edge.id} has positive length`);
  }
});

test("alignment skips edges whose endpoints are missing rather than throwing", () => {
  const { schematic } = buildBases(STATIONS);
  const sections = buildAlignment(
    STATIONS,
    [...EDGES, { id: "X-Y", from: "X", to: "Y", distance_km: 5, avg_speed: 60, capacity: 1 }],
    schematic
  );
  assert.equal(sections["X-Y"], undefined);
});

test("section endpoints land exactly on their stations in both bases", () => {
  const bases = buildBases(STATIONS);
  for (const key of ["schematic", "geographic"]) {
    const sections = buildAlignment(STATIONS, EDGES, bases[key]);
    for (const edge of EDGES) {
      const start = sampleAt(sections[edge.id], 0).position;
      const end = sampleAt(sections[edge.id], 1).position;
      const from = bases[key][edge.from];
      const to = bases[key][edge.to];
      assert.ok(Math.hypot(start.x - from.x, start.z - from.z) < 1e-6, `${key} ${edge.id} start`);
      assert.ok(Math.hypot(end.x - to.x, end.z - to.z) < 1e-6, `${key} ${edge.id} end`);
    }
  }
});

/* ---------------------------------------------------------------- physics */

test("simulated minutes follow the tick interval", () => {
  assert.equal(simMinutes(1, 1), 1);
  assert.equal(simMinutes(1, 0.5), 2);
  assert.equal(simMinutes(0.5, 2), 0.25);
  assert.ok(Number.isFinite(simMinutes(1, 0)), "a zero interval must not divide by zero");
});

test("dead reckoning matches the server integrator over a tick", () => {
  // The backend moves a train speed/60 km per simulated minute. One real second
  // at a 1 s tick interval is one simulated minute, so the client must advance
  // by exactly the same distance.
  const sectionKm = 60;
  const motion = createTrainMotion({ id: "T", edge_id: "A-B", edge_progress: 0, current_speed: 60, status: "moving" });
  motion.speed = 60; // already at line speed

  let elapsed = 0;
  const dt = 1 / 60;
  while (elapsed < 1 - 1e-9) {
    integrate(motion, dt, { tickIntervalSeconds: 1, sectionKm, paused: false, reducedMotion: false });
    elapsed += dt;
  }

  // 60 km/h for one simulated minute = 1 km of a 60 km section.
  assert.ok(
    Math.abs(motion.progress - 1 / 60) < 1e-3,
    `expected ~${1 / 60}, got ${motion.progress}`
  );
});

test("a paused simulation does not advance a train", () => {
  const motion = createTrainMotion({ id: "T", edge_id: "A-B", edge_progress: 0.4, current_speed: 90, status: "moving" });
  integrate(motion, 0.5, { tickIntervalSeconds: 1, sectionKm: 20, paused: true, reducedMotion: false });
  assert.equal(motion.progress, 0.4);
});

test("only moving trains advance", () => {
  for (const status of ["dwelling", "stopped", "scheduled", "arrived"]) {
    const motion = createTrainMotion({ id: "T", edge_id: "A-B", edge_progress: 0.3, current_speed: 0, status });
    integrate(motion, 1, { tickIntervalSeconds: 1, sectionKm: 20, paused: false, reducedMotion: false });
    assert.equal(motion.progress, 0.3, `${status} must not move`);
  }
});

test("reconcile snaps on a section change and eases within a section", () => {
  const motion = createTrainMotion({ id: "T", edge_id: "A-B", edge_progress: 0.5, current_speed: 60, status: "moving" });

  reconcile(motion, { id: "T", edge_id: "B-C", edge_progress: 0.1, current_speed: 60, status: "moving" });
  assert.equal(motion.progress, 0.1, "a new section is a hard cut");
  assert.equal(motion.error, 0);

  reconcile(motion, { id: "T", edge_id: "B-C", edge_progress: 0.14, current_speed: 60, status: "moving" });
  assert.equal(motion.progress, 0.1, "same section keeps the prediction");
  assert.ok(Math.abs(motion.error - 0.04) < 1e-9, "and records the drift to bleed off");
});

test("prediction error converges to zero rather than snapping", () => {
  const motion = createTrainMotion({ id: "T", edge_id: "A-B", edge_progress: 0.5, current_speed: 0, status: "dwelling" });
  motion.error = 0.1;
  const first = motion.progress;
  integrate(motion, 1 / 60, { tickIntervalSeconds: 1, sectionKm: 20, paused: false, reducedMotion: false });
  assert.ok(motion.progress > first, "moves toward the authority");
  assert.ok(motion.error < 0.1 && motion.error > 0, "but does not arrive in one frame");

  for (let i = 0; i < 240; i += 1) {
    integrate(motion, 1 / 60, { tickIntervalSeconds: 1, sectionKm: 20, paused: false, reducedMotion: false });
  }
  assert.ok(Math.abs(motion.error) < 1e-3, "and converges");
});

test("progress never leaves 0..1", () => {
  const motion = createTrainMotion({ id: "T", edge_id: "A-B", edge_progress: 0.99, current_speed: 200, status: "moving" });
  motion.speed = 200;
  for (let i = 0; i < 200; i += 1) {
    integrate(motion, 1 / 60, { tickIntervalSeconds: 0.2, sectionKm: 1, paused: false, reducedMotion: false });
  }
  assert.ok(motion.progress <= 1 && motion.progress >= 0);
});

test("reduced motion shows the authoritative value with no prediction", () => {
  const motion = createTrainMotion({ id: "T", edge_id: "A-B", edge_progress: 0.2, current_speed: 0, status: "moving" });
  motion.targetSpeed = 80;
  motion.error = 0.1;
  integrate(motion, 1 / 60, { tickIntervalSeconds: 1, sectionKm: 20, paused: false, reducedMotion: true });
  assert.ok(Math.abs(motion.progress - 0.3) < 1e-9, "the correction is applied at once");
  assert.equal(motion.error, 0);
  assert.equal(motion.speed, 80, "and speed does not ease");
  assert.equal(motion.cant, 0, "no cant under reduced motion");
});

test("cant follows v^2/r and is capped at real superelevation", () => {
  const slow = createTrainMotion({ id: "S", current_speed: 20, status: "moving" });
  slow.speed = 20;
  const fast = createTrainMotion({ id: "F", current_speed: 120, status: "moving" });
  fast.speed = 120;

  const curvature = 0.02;
  const a = attitude(slow, curvature, 0.84);
  const b = attitude(fast, curvature, 0.84);

  assert.ok(Math.abs(b.targetCant) >= Math.abs(a.targetCant), "faster leans harder");
  assert.ok(Math.abs(b.targetCant) <= 0.105 + 1e-9, "never beyond ~6 degrees");
  assert.equal(attitude(fast, 0, 0.84).targetCant, 0, "a straight section has no cant");
});

test("cant flips with the direction of the curve", () => {
  const motion = createTrainMotion({ id: "T", current_speed: 90, status: "moving" });
  motion.speed = 90;
  const left = attitude(motion, 0.02, 0.84).targetCant;
  const right = attitude(motion, -0.02, 0.84).targetCant;
  assert.ok(left * right < 0, "opposite curves lean opposite ways");
});

/* ------------------------------------------------------------------- wave */

test("the wave starts at its origin and finishes everywhere", () => {
  assert.equal(waveAt(0.5, 0.5, 0), 0);
  assert.equal(waveAt(0, 0.5, 1), 1);
  assert.equal(waveAt(1, 0.5, 1), 1);
});

test("the change reaches the origin before it reaches the far end", () => {
  const mid = 0.45;
  const atOrigin = waveAt(0.5, 0.5, mid);
  const atEdge = waveAt(0.0, 0.5, mid);
  assert.ok(atOrigin > atEdge, "propagation, not a cross-fade");
});

test("the wave is monotonic in progress", () => {
  let previous = -1;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const value = waveAt(0.2, 0.7, p);
    assert.ok(value >= previous - 1e-9, "never goes backwards");
    previous = value;
  }
});

test("the GLSL form embeds the same spread constant as the JS form", () => {
  assert.ok(
    WAVE_GLSL.includes(WAVE_SPREAD.toFixed(3)),
    "shader and CPU must share one definition or trains drift off the rails mid-morph"
  );
});

test("corridor coordinate interpolates linearly across a section", () => {
  assert.equal(corridorAt(0.2, 0.6, 0), 0.2);
  assert.equal(corridorAt(0.2, 0.6, 1), 0.6);
  assert.ok(Math.abs(corridorAt(0.2, 0.6, 0.5) - 0.4) < 1e-12);
});

test("the morph phase genuinely differs along a section while the wave passes", () => {
  // This is the invariant that keeps trains on the rails mid-transition. The
  // GPU interpolates each vertex's corridor coordinate across the section, so
  // the head and tail of a section are at different points in the morph. A
  // train must be placed with the phase at its own position, not the phase at
  // the station it left.
  const from = 0.10;
  const to = 0.60;
  const origin = 0.10;
  const progress = 0.35;

  const atStart = waveAt(corridorAt(from, to, 0), origin, progress);
  const atMid = waveAt(corridorAt(from, to, 0.5), origin, progress);
  const atEnd = waveAt(corridorAt(from, to, 1), origin, progress);

  assert.ok(atStart > atMid, "the near end of the section is further through the morph");
  assert.ok(atMid > atEnd, "and the far end is behind it");
  assert.ok(
    atStart - atEnd > 0.2,
    `the section must be visibly mid-deformation (got ${atStart - atEnd})`
  );
});

test("once the wave has passed, every point on a section agrees", () => {
  const settled = [0, 0.25, 0.5, 0.75, 1].map((f) => waveAt(corridorAt(0.1, 0.6, f), 0.1, 1));
  for (const value of settled) assert.equal(value, 1);
});

/* -------------------------------------------------------------------- pan */

test("dragging moves the ground with the cursor, not against it", () => {
  // Looking straight down with the camera on +Z: screen-right is world +X and
  // into-the-screen is world -Z. Grab the map and pull it right, and the view
  // must travel left so the grabbed point stays under the pointer.
  const right = panDelta(10, 0, 0, Math.PI / 2, 1);
  assert.ok(right.x < 0, `dragging right must move the focus west (got ${right.x})`);
  assert.ok(Math.abs(right.z) < 1e-9, "and not north or south");

  const down = panDelta(0, 10, 0, Math.PI / 2, 1);
  assert.ok(down.z < 0, `dragging down must move the focus into the scene (got ${down.z})`);
  assert.ok(Math.abs(down.x) < 1e-9, "and not east or west");
});

test("pan follows the camera's heading", () => {
  // Turned a quarter turn, a horizontal drag has to move along a different
  // world axis or the map slides sideways under the cursor.
  const straight = panDelta(10, 0, 0, Math.PI / 2, 1);
  const turned = panDelta(10, 0, Math.PI / 2, Math.PI / 2, 1);
  assert.ok(Math.abs(straight.x) > 9 && Math.abs(straight.z) < 1e-9);
  assert.ok(Math.abs(turned.z) > 9 && Math.abs(turned.x) < 1e-6);
});

test("pan scales with the viewing distance", () => {
  const near = panDelta(10, 0, 0, Math.PI / 2, 0.001);
  const far = panDelta(10, 0, 0, Math.PI / 2, 0.5);
  assert.ok(Math.abs(far.x) > Math.abs(near.x) * 100, "one pixel covers more ground when zoomed out");
});

test("a low camera pans further vertically to match the foreshortening", () => {
  // Near the ground the vertical axis is compressed, so the same drag has to
  // cover more ground or panning feels stuck.
  const overhead = panDelta(0, 10, 0, Math.PI / 2, 1);
  const shallow = panDelta(0, 10, 0, 0.1, 1);
  assert.ok(Math.abs(shallow.z) > Math.abs(overhead.z));
});

test("the foreshortening correction is capped", () => {
  // sin(pitch) approaches zero as the camera lies down; without a floor the
  // first pixel of drag would throw the view to the other side of the region.
  const flat = panDelta(0, 1, 0, 0.0001, 1);
  assert.ok(Number.isFinite(flat.z) && Math.abs(flat.z) <= 4.000001, `got ${flat.z}`);
});

test("no drag, no movement", () => {
  // Magnitude, not identity: the trig legitimately yields -0 on one axis, and
  // strict equality treats that as a different value from 0.
  const still = panDelta(0, 0, 1.2, 0.8, 1);
  assert.ok(Math.abs(still.x) < 1e-12, `x drifted by ${still.x}`);
  assert.ok(Math.abs(still.z) < 1e-12, `z drifted by ${still.z}`);
});
