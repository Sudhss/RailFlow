/**
 * The corridor engine.
 *
 * One WebGL scene holds the whole Delhi-Lucknow region at every scale at once.
 * A single `altitude` control moves the operator continuously from the
 * control-room diagram, through the true geography of the corridor, down to
 * rail level behind one train. Nothing here is a mode: the same track, the same
 * trains and the same simulation clock run the entire way down.
 *
 * Three things make that work:
 *
 *   1. Every station exists in two bases -- the hand-drawn diagram (x/y) and
 *      Mercator (lat/lng) -- and both are baked into the track geometry as
 *      vertex attributes. Re-laying out the whole network costs one uniform,
 *      not a geometry rebuild.
 *
 *   2. The change propagates. It starts at the operator's focus and travels
 *      along the corridor (wave.js), so the network reorganises the way a state
 *      change moves through a railway, and the track is genuinely
 *      mid-deformation everywhere in between.
 *
 *   3. Trains are locked to arc length on that deforming track, so a train 63%
 *      along a section stays 63% along it while the section is moving between
 *      two coordinate systems.
 *
 * Budget: the whole network is one draw call. Per-section state (occupancy,
 * blocked, on-route, restricted) lives in a small data texture refreshed once
 * per tick. Nothing is rebuilt while the simulation runs.
 *
 * Units: corridor-local units, where 1 km of railway is UNITS_PER_KM. Geometry
 * is recentred on the focus inside the vertex shader, which is what keeps rail
 * level -- a 1.676 m gauge inside a 500 km network -- free of float32 jitter.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  FloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from "three";

import { buildBases, corridorCoordinates, panDelta, WORLD_WIDTH } from "./projection.js";
import { buildAlignment, sampleAt } from "./alignment.js";
import { attitude, createTrainMotion, integrate, reconcile } from "./physics.js";
import { corridorAt, waveAt, WAVE_GLSL } from "./wave.js";

/* ------------------------------------------------------------------ scale */

/** The corridor spans roughly 500 km of railway across WORLD_WIDTH units. */
export const UNITS_PER_KM = WORLD_WIDTH / 500;

const GAUGE = 0.001676 * UNITS_PER_KM; // 1676 mm Indian broad gauge
const RAIL_HEAD = 0.00011 * UNITS_PER_KM; // rail head plus the web that catches light
const FORMATION = 0.0045 * UNITS_PER_KM; // ~4.5 m formation width
const PLATFORM_KM = 0.55; // ~550 m platform
const COACH = 0.024 * UNITS_PER_KM; // ~24 m coach
const RAKE_COACHES = 14;
const SLEEPER_SPACING = 0.0006 * UNITS_PER_KM; // 600 mm

/** Diagram-altitude dimensions, chosen so the network reads as a drawing. */
const DIAGRAM = { ballastHalf: 1.05, railHalf: 0.17, marker: 2.9, platform: 2.3 };

// Trackside shot at the bottom of the descent, in corridor units.
// A film crew tracking a train does not stand a kilometre away: it runs
// alongside, close enough that the gauge, the sleepers and the speed read.
// The bottom of the descent: one train, the section under it, and the track
// ahead as far as the next station.
//
// It stops here deliberately. Going closer -- down to sleeper spacing and rail
// gauge -- looks impressive for a few seconds and then says nothing: a
// dispatcher cannot act on ballast. At this height the operator can still read
// the train's length, which section it occupies, how that section is running
// and what it is approaching, which is the whole point of descending at all.
const RAIL_SIDE = 0.18 * UNITS_PER_KM; //     ~180 m out from the running line
const RAIL_HEIGHT = 0.10 * UNITS_PER_KM; //   ~100 m above rail head
const RAIL_FORWARD = -0.26 * UNITS_PER_KM; // ~260 m behind the train's centre
const RAIL_LOOK_AHEAD = 0.30 * UNITS_PER_KM; // aim ~300 m ahead of the centre
const RAIL_DISTANCE = 0.45 * UNITS_PER_KM; //  scale for clip planes and fog
const ROUTE_DISTANCE = 110 * UNITS_PER_KM; //  the mid stop: a train's whole route
const DIAGRAM_MARGIN = 1.05; // breathing room around the region at full zoom-out

/* ------------------------------------------------------------- appearance */

const PALETTE = {
  ballast: new Color("#2e353a"),
  rail: new Color("#97a3aa"),
  clear: new Color("#46525a"),
  caution: new Color("#d9a441"),
  danger: new Color("#d2564b"),
  closed: new Color("#7d3a34"),
  route: new Color("#dce5ea"),
  ground: new Color("#0a0c0e"),   // the ground plane
  sky: new Color("#0e1215"),      // what sits above the horizon
  ink: new Color("#1b2227"),
  platform: new Color("#48545c"),
  sleeper: new Color("#3a332b"),
};

const STATUS_TINT = {
  moving: new Color("#e9eef1"),
  dwelling: new Color("#d9a441"),
  stopped: new Color("#d2564b"),
  scheduled: new Color("#7d8991"),
  arrived: new Color("#3fb27f"),
};

/* ---------------------------------------------------------------- shaders */

const TRACK_VERTEX = /* glsl */ `
  attribute vec3 aGeo;
  attribute vec2 aNormalSchema;
  attribute vec2 aNormalGeo;
  attribute float aSide;
  attribute float aKind;      // 0 ballast, 1 left rail, 2 right rail
  attribute float aCorridor;
  attribute float aEdge;

  uniform vec3  uOrigin;
  uniform float uBallastHalf;
  uniform float uRailHalf;
  uniform float uGauge;
  uniform float uRailLift;
  uniform float uEdgeCount;
  uniform float uMorphFrom;
  uniform float uMorphTo;
  uniform sampler2D uEdgeState;

  varying float vKind;
  varying vec4  vState;
  varying float vDepth;

  ${WAVE_GLSL}

  void main() {
    // Where this point currently sits between the two coordinate systems.
    float m = mix(uMorphFrom, uMorphTo, waveAt(aCorridor));

    vec3 centre = mix(position, aGeo, m);
    vec2 n = normalize(mix(aNormalSchema, aNormalGeo, m));

    float halfWidth = (aKind < 0.5) ? uBallastHalf : uRailHalf;
    float centreOffset = 0.0;
    if (aKind > 0.5 && aKind < 1.5) centreOffset = -uGauge * 0.5;
    if (aKind > 1.5) centreOffset =  uGauge * 0.5;

    float lateral = centreOffset + aSide * halfWidth;
    vec3 local = centre + vec3(n.x * lateral, 0.0, n.y * lateral);
    local.y += (aKind < 0.5) ? 0.0 : uRailLift;

    // Recentring on the focus before anything else is what makes a 1.7 m gauge
    // survive inside a 500 km world in single precision.
    vec3 rendered = local - uOrigin;

    vState = texture2D(uEdgeState, vec2((aEdge + 0.5) / uEdgeCount, 0.5));
    vKind = aKind;

    vec4 mv = modelViewMatrix * vec4(rendered, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TRACK_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec3  uBallast;
  uniform vec3  uRail;
  uniform vec3  uClear;
  uniform vec3  uCaution;
  uniform vec3  uDanger;
  uniform vec3  uClosed;
  uniform vec3  uRoute;
  uniform vec3  uFog;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uAltitude;

  varying float vKind;
  varying vec4  vState;   // r load ratio, g blocked, b on route, a restricted
  varying float vDepth;

  void main() {
    float load = vState.r;
    float blocked = vState.g;
    float onRoute = vState.b;
    float restricted = vState.a;

    // Clear track is the resting state of the whole network, so it stays
    // neutral graphite. Colour is spent only where something is actually
    // happening: approaching capacity, over capacity, or closed. Thresholds
    // match the backend's own congestion classes, so the picture and the event
    // log never disagree about what "busy" means.
    float busy = smoothstep(0.55, 0.75, load);
    float over = smoothstep(0.95, 1.15, load);

    vec3 state = uClear;
    state = mix(state, uCaution, busy);
    state = mix(state, uDanger, over);
    state = mix(state, uClosed, blocked);

    // How loudly the state is allowed to speak.
    float voice = max(max(busy * 0.75, over), max(blocked, restricted * 0.5));

    vec3 base;
    if (vKind < 0.5) {
      base = mix(uBallast, state, voice * (0.55 + 0.35 * uAltitude));
      base = mix(base, uRoute * 0.30, onRoute * 0.55);
    } else {
      base = mix(uRail, state, voice * 0.6);
      base = mix(base, uRoute, onRoute * 0.75);
    }

    float fog = smoothstep(uFogNear, uFogFar, vDepth);
    gl_FragColor = vec4(mix(base, uFog, fog), 1.0);

    // A custom ShaderMaterial does not get three's output encode for free. Without
    // it every authored colour is written linear and displayed as sRGB, which is
    // roughly a 2.2 gamma too dark.
    #include <colorspace_fragment>
  }
`;

const GROUND_VERTEX = /* glsl */ `
  varying vec2 vLocal;
  varying vec3 vView;
  uniform vec3 uOrigin;
  void main() {
    vLocal = position.xy;
    vec3 local = vec3(position.x, -0.0016, position.y);
    vec4 mv = modelViewMatrix * vec4(local - uOrigin, 1.0);
    // The ground is two enormous triangles. Interpolating a scalar depth across
    // them seams visibly along the shared diagonal, so the view-space position
    // is carried instead and the depth is taken per fragment, where the
    // interpolation is perspective-correct.
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const GROUND_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vLocal;
  varying vec3 vView;

  uniform float uMorph;
  uniform vec3  uInk;
  uniform vec3  uPaper;
  uniform float uSpacing;
  uniform float uFade;
  uniform float uFogNear;
  uniform float uFogFar;

  float grid(vec2 p, float spacing, float weight) {
    vec2 q = p / spacing;
    vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-6));
    return (1.0 - min(min(g.x, g.y), 1.0)) * weight;
  }

  void main() {
    // A square drawing grid in the diagram basis; a coarser graticule standing
    // in for meridians once the network is on its true geography. Which grid is
    // underfoot tells the operator which coordinate system they are reading.
    float fine = grid(vLocal, uSpacing, 0.55);
    float coarse = grid(vLocal, uSpacing * 5.0, 0.85);
    float geo = grid(vLocal, uSpacing * 3.2, 0.5) + grid(vLocal, uSpacing * 16.0, 0.9);

    float ink = mix(fine + coarse, geo, uMorph);
    float radius = length(vLocal);
    float vignette = 1.0 - smoothstep(FADE_START, FADE_END, radius);

    // Without this the ground keeps its grid all the way to the edge of the
    // plane, and low down the operator can see the end of the world.
    float fog = smoothstep(uFogNear, uFogFar, -vView.z);
    vec3 colour = mix(uPaper, uInk, clamp(ink, 0.0, 1.0) * uFade * vignette);
    gl_FragColor = vec4(mix(colour, uPaper, fog), 1.0);

    // A custom ShaderMaterial does not get three's output encode for free. Without
    // it every authored colour is written linear and displayed as sRGB, which is
    // roughly a 2.2 gamma too dark.
    #include <colorspace_fragment>
  }
`
  .replace("FADE_START", (WORLD_WIDTH * 0.42).toFixed(1))
  .replace("FADE_END", (WORLD_WIDTH * 0.95).toFixed(1));

const INSTANCE_VERTEX = /* glsl */ `
  attribute vec3 aTint;
  varying vec3 vTint;
  varying float vShade;
  varying float vDepth;

  uniform vec3 uFog;
  uniform float uFogNear;
  uniform float uFogFar;

  void main() {
    vTint = aTint;

    // One hemispheric term, evaluated per vertex. Enough to give a coach body
    // and a platform edge some form without lights or a shading model.
    vec3 worldNormal = normalize(mat3(instanceMatrix) * normal);
    vShade = 0.62 + 0.38 * clamp(dot(worldNormal, normalize(vec3(0.35, 1.0, 0.2))), 0.0, 1.0);

    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const INSTANCE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vTint;
  varying float vShade;
  varying float vDepth;

  uniform vec3 uFog;
  uniform float uFogNear;
  uniform float uFogFar;

  void main() {
    float fog = smoothstep(uFogNear, uFogFar, vDepth);
    gl_FragColor = vec4(mix(vTint * vShade, uFog, fog), 1.0);

    // A custom ShaderMaterial does not get three's output encode for free. Without
    // it every authored colour is written linear and displayed as sRGB, which is
    // roughly a 2.2 gamma too dark.
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ utils */

function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) material.forEach(disposeMaterial);
  else material.dispose();
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Round up to the next 1, 2 or 5 times a power of ten. */
function niceStep(value) {
  const safe = Math.max(1e-6, value);
  const decade = Math.pow(10, Math.floor(Math.log10(safe)));
  const scaled = safe / decade;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * decade;
}

function smoothstep01(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ scene */

export class CorridorScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.reducedMotion = Boolean(options.reducedMotion);
    this.onFrame = options.onFrame || null;
    this.onContextLost = options.onContextLost || null;
    this.maxPixelRatio = options.maxPixelRatio ?? 2;
    this.contextLost = false;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: options.antialias !== false,
      alpha: false,
      powerPreference: "high-performance",
    });
    // A sky marginally lighter than the ground gives a real horizon without
    // painting one: the two planes simply separate in tone.
    this.renderer.setClearColor(PALETTE.sky.getHex(), 1);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(46, 1, 0.01, 4000);

    /* Animation state lives in plain fields. Nothing here touches React. */
    this.altitude = 1;
    this.targetAltitude = 1;
    this.morphFrom = 0;
    this.morphTo = 0;
    this.waveProgress = 1;
    this.waveOrigin = 0.5;
    this.heading = 0;
    this.targetHeading = 0;
    this.focus = new Vector3();
    this.targetFocus = new Vector3();
    this.origin = new Vector3();
    this.orbit = 0;

    // Free look. Once the operator drags, the camera stops following its
    // subject and holds where it was put; selecting a train takes it back.
    this.detached = false;
    this.manualFocus = new Vector3();
    this._pitch = 1.4;

    this.stations = [];
    this.edges = [];
    this.edgeIndex = new Map();
    this.bases = { geographic: {}, schematic: {}, order: [] };
    this.corridor = {};
    this.alignments = { schematic: {}, geographic: {} };
    this.sectionKm = new Map();

    this.trains = [];
    this.motions = new Map();
    this.selectedTrainId = null;
    this.routeEdges = new Set();
    this.paused = true;
    this.tickInterval = 1;

    this._obj = new Object3D();
    this._lastTime = 0;
    this._running = false;
    this._furnitureKey = "";
    this._sleeperLocals = [];
    this._extent = null;
    this._cameraDistance = 1;

    // A GPU can take the context away at any time: a driver reset, the machine
    // sleeping, or simply too many WebGL tabs. Without this the canvas goes
    // black for good and the next frame throws inside the renderer.
    this._onContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.stop();
      this.onContextLost?.();
    };
    this._onContextRestored = () => {
      this.contextLost = false;
    };
    canvas.addEventListener("webglcontextlost", this._onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this._onContextRestored, false);

    this._buildGround();
    this._buildInstances();
  }

  /* ------------------------------------------------------------- lifecycle */

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = 0;
    this.renderer.setAnimationLoop((time) => this._tick(time));
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }

  dispose() {
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this._onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this._onContextRestored);
    this.scene.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      disposeMaterial(child.material);
    });
    this.edgeStateTexture?.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }

  resize(width, height) {
    if (width <= 0 || height <= 0) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxPixelRatio));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewport = { width, height };
  }

  /* ---------------------------------------------------------- construction */

  _buildGround() {
    const geometry = new PlaneGeometry(WORLD_WIDTH * 2.6, WORLD_WIDTH * 2.6, 1, 1);
    this.groundMaterial = new ShaderMaterial({
      vertexShader: GROUND_VERTEX,
      fragmentShader: GROUND_FRAGMENT,
      uniforms: {
        uOrigin: { value: new Vector3() },
        uMorph: { value: 0 },
        uInk: { value: PALETTE.ink.clone() },
        uPaper: { value: PALETTE.ground.clone() },
        uSpacing: { value: WORLD_WIDTH / 52 },
        uFade: { value: 1 },
        uFogNear: { value: 400 },
        uFogFar: { value: 1600 },
      },
      // The shader lays the plane down by swapping its Y and Z, which reverses
      // the winding: on FrontSide the ground is back-face culled from above and
      // never draws at all.
      side: DoubleSide,
    });
    this.ground = new Mesh(geometry, this.groundMaterial);
    this.ground.frustumCulled = false;
    this.ground.renderOrder = -10;
    this.scene.add(this.ground);
  }

  _instanced(geometry, capacity, renderOrder = 0) {
    const material = new ShaderMaterial({
      vertexShader: INSTANCE_VERTEX,
      fragmentShader: INSTANCE_FRAGMENT,
      side: DoubleSide,
      uniforms: {
        uFog: { value: PALETTE.sky.clone() },
        uFogNear: { value: 400 },
        uFogFar: { value: 1600 },
      },
    });
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    const tint = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    geometry.setAttribute("aTint", tint);
    mesh.userData.tint = tint;
    this.scene.add(mesh);
    return mesh;
  }

  _buildInstances() {
    const slab = () => {
      const g = new PlaneGeometry(1, 1);
      g.rotateX(-Math.PI / 2);
      return g;
    };

    this.stationMesh = this._instanced(slab(), 128, 1);
    this.sleeperMesh = this._instanced(slab(), 1400, 0);

    // A train has a body. A flat ribbon disappears edge-on the moment the
    // camera drops to rail level, which is exactly where it matters most.
    const body = new BoxGeometry(1, 1, 1);
    body.translate(0, 0.5, 0);
    this.trainMesh = this._instanced(body, 128, 4);

    const mast = new CylinderGeometry(1, 1, 1, 6, 1, false);
    mast.translate(0, 0.5, 0);
    this.signalMesh = this._instanced(mast, 96, 3);
  }

  setNetwork(stations, edges) {
    if (!stations?.length || !edges?.length) return;

    this.stations = stations;
    this.edges = edges;
    this.edgeIndex = new Map(edges.map((edge, index) => [edge.id, index]));
    this.sectionKm = new Map(edges.map((edge) => [edge.id, Number(edge.distance_km) || 1]));

    this.bases = buildBases(stations);
    this.corridor = corridorCoordinates(this.bases.geographic, this.bases.order);
    this.alignments = {
      schematic: buildAlignment(stations, edges, this.bases.schematic),
      geographic: buildAlignment(stations, edges, this.bases.geographic),
    };

    this._measureExtent();
    this._buildTrackGeometry();
    this._buildEdgeStateTexture();

    const centre = this._networkCentre();
    this.focus.copy(centre);
    this.targetFocus.copy(centre);
    this.origin.copy(centre);
  }

  /** Half-extent of the region on each axis, taking the wider of the two bases. */
  _measureExtent() {
    let halfX = 1;
    let halfZ = 1;
    for (const basis of [this.bases.schematic, this.bases.geographic]) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const id of this.bases.order) {
        const p = basis[id];
        if (!p) continue;
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      if (Number.isFinite(minX)) {
        halfX = Math.max(halfX, (maxX - minX) / 2);
        halfZ = Math.max(halfZ, (maxZ - minZ) / 2);
      }
    }
    this._extent = { halfX, halfZ };
  }

  /**
   * How far back the camera has to be for the whole region to fit.
   *
   * Derived from the region's real extent and the current viewport rather than
   * hard-coded, so the corridor is never clipped: not on a wide screen, not on
   * a narrow one, and not after a section is added to the graph at runtime.
   */
  _diagramDistance() {
    const extent = this._extent || { halfX: WORLD_WIDTH / 2, halfZ: WORLD_WIDTH / 6 };
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const aspect = this.camera.aspect || 1;
    const vertical = extent.halfZ / Math.tan(halfFov);
    const horizontal = extent.halfX / (Math.tan(halfFov) * aspect);
    return Math.max(vertical, horizontal) * DIAGRAM_MARGIN;
  }

  _networkCentre() {
    const ids = this.bases.order;
    const centre = new Vector3();
    if (!ids.length) return centre;
    for (const id of ids) {
      const p = this._stationLocal(id);
      centre.x += p.x;
      centre.z += p.z;
    }
    centre.x /= ids.length;
    centre.z /= ids.length;
    return centre;
  }

  _buildTrackGeometry() {
    const { schematic, geographic } = this.alignments;
    const edges = this.edges.filter((edge) => schematic[edge.id] && geographic[edge.id]);
    if (!edges.length) return;

    const samples = schematic[edges[0].id].points.length;
    const perSample = 6; // ballast L/R + two rails, each L/R
    const vertexCount = edges.length * samples * perSample;

    const position = new Float32Array(vertexCount * 3);
    const geo = new Float32Array(vertexCount * 3);
    const normalSchema = new Float32Array(vertexCount * 2);
    const normalGeo = new Float32Array(vertexCount * 2);
    const side = new Float32Array(vertexCount);
    const kind = new Float32Array(vertexCount);
    const corridor = new Float32Array(vertexCount);
    const edgeAttr = new Float32Array(vertexCount);
    const indices = new Uint32Array(edges.length * (samples - 1) * 3 * 6);

    const normalOf = (points, i) => {
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(points.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz) || 1;
      return { x: -dz / length, z: dx / length };
    };

    let v = 0;
    let idx = 0;

    for (const edge of edges) {
      const s = schematic[edge.id];
      const g = geographic[edge.id];
      const edgeIdx = this.edgeIndex.get(edge.id) ?? 0;
      const cFrom = this.corridor[edge.from] ?? 0.5;
      const cTo = this.corridor[edge.to] ?? 0.5;
      const base = v;

      for (let i = 0; i < samples; i += 1) {
        const sp = s.points[i];
        const gp = g.points[i];
        const sn = normalOf(s.points, i);
        const gn = normalOf(g.points, i);
        const c = cFrom + (cTo - cFrom) * (i / (samples - 1));

        for (let k = 0; k < 3; k += 1) {
          for (let sgn = -1; sgn <= 1; sgn += 2) {
            position[v * 3] = sp.x;
            position[v * 3 + 2] = sp.z;
            geo[v * 3] = gp.x;
            geo[v * 3 + 2] = gp.z;
            normalSchema[v * 2] = sn.x;
            normalSchema[v * 2 + 1] = sn.z;
            normalGeo[v * 2] = gn.x;
            normalGeo[v * 2 + 1] = gn.z;
            side[v] = sgn;
            kind[v] = k;
            corridor[v] = c;
            edgeAttr[v] = edgeIdx;
            v += 1;
          }
        }
      }

      for (let i = 0; i < samples - 1; i += 1) {
        for (let k = 0; k < 3; k += 1) {
          const a = base + i * perSample + k * 2;
          const b = a + 1;
          const c = base + (i + 1) * perSample + k * 2;
          const d = c + 1;
          indices[idx++] = a;
          indices[idx++] = c;
          indices[idx++] = b;
          indices[idx++] = b;
          indices[idx++] = c;
          indices[idx++] = d;
        }
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(position, 3));
    geometry.setAttribute("aGeo", new BufferAttribute(geo, 3));
    geometry.setAttribute("aNormalSchema", new BufferAttribute(normalSchema, 2));
    geometry.setAttribute("aNormalGeo", new BufferAttribute(normalGeo, 2));
    geometry.setAttribute("aSide", new BufferAttribute(side, 1));
    geometry.setAttribute("aKind", new BufferAttribute(kind, 1));
    geometry.setAttribute("aCorridor", new BufferAttribute(corridor, 1));
    geometry.setAttribute("aEdge", new BufferAttribute(edgeAttr, 1));
    geometry.setIndex(new BufferAttribute(indices, 1));

    if (this.trackMesh) {
      this.scene.remove(this.trackMesh);
      this.trackMesh.geometry.dispose();
    }

    if (!this.trackMaterial) {
      this.trackMaterial = new ShaderMaterial({
        vertexShader: TRACK_VERTEX,
        fragmentShader: TRACK_FRAGMENT,
        side: DoubleSide,
        uniforms: {
          uOrigin: { value: new Vector3() },
          uBallastHalf: { value: DIAGRAM.ballastHalf },
          uRailHalf: { value: DIAGRAM.railHalf },
          uGauge: { value: 0 },
          uRailLift: { value: 0 },
          uEdgeCount: { value: 1 },
          uEdgeState: { value: null },
          uMorphFrom: { value: 0 },
          uMorphTo: { value: 0 },
          uWaveOrigin: { value: 0.5 },
          uWaveProgress: { value: 1 },
          uBallast: { value: PALETTE.ballast.clone() },
          uRail: { value: PALETTE.rail.clone() },
          uClear: { value: PALETTE.clear.clone() },
          uCaution: { value: PALETTE.caution.clone() },
          uDanger: { value: PALETTE.danger.clone() },
          uClosed: { value: PALETTE.closed.clone() },
          uRoute: { value: PALETTE.route.clone() },
          uFog: { value: PALETTE.ground.clone() },
          uFogNear: { value: 400 },
          uFogFar: { value: 1600 },
          uAltitude: { value: 1 },
        },
      });
    }

    this.trackMesh = new Mesh(geometry, this.trackMaterial);
    this.trackMesh.frustumCulled = false;
    this.scene.add(this.trackMesh);
  }

  _buildEdgeStateTexture() {
    const count = Math.max(1, this.edges.length);
    this.edgeStateTexture?.dispose();
    this.edgeStateData = new Float32Array(count * 4);
    this.edgeStateTexture = new DataTexture(this.edgeStateData, count, 1, RGBAFormat, FloatType);
    this.edgeStateTexture.minFilter = NearestFilter;
    this.edgeStateTexture.magFilter = NearestFilter;
    this.edgeStateTexture.needsUpdate = true;
    this.trackMaterial.uniforms.uEdgeState.value = this.edgeStateTexture;
    this.trackMaterial.uniforms.uEdgeCount.value = count;
  }

  /* --------------------------------------------------------------- updates */

  update(snapshot) {
    if (!snapshot) return;
    const simulation = snapshot.simulation || {};
    this.paused = Boolean(simulation.paused);
    this.tickInterval = Number(simulation.tick_interval_seconds) || 1;

    const edges = snapshot.graph?.edges || [];
    if (this.edgeStateData) {
      for (const edge of edges) {
        const index = this.edgeIndex.get(edge.id);
        if (index === undefined) continue;
        const o = index * 4;
        this.edgeStateData[o] = Number(edge.load_ratio) || 0;
        this.edgeStateData[o + 1] = edge.blocked ? 1 : 0;
        this.edgeStateData[o + 2] = this.routeEdges.has(edge.id) ? 1 : 0;
        this.edgeStateData[o + 3] = edge.speed_limit ? 1 : 0;
      }
      this.edgeStateTexture.needsUpdate = true;
    }

    this.trains = snapshot.trains || [];
    const live = new Set();
    for (const train of this.trains) {
      live.add(train.id);
      const existing = this.motions.get(train.id);
      if (existing) reconcile(existing, train);
      else this.motions.set(train.id, createTrainMotion(train));
    }
    for (const id of [...this.motions.keys()]) {
      if (!live.has(id)) this.motions.delete(id);
    }
  }

  /**
   * Move the view across the ground by a drag in screen pixels.
   * The first drag detaches the camera from whatever it was following.
   */
  pan(dx, dy) {
    if (!this.detached) {
      this.detached = true;
      this.manualFocus.copy(this.targetFocus);
    }
    const delta = panDelta(dx, dy, this.heading, this._pitch, this._pixelSize || 0.001);
    this.manualFocus.x += delta.x;
    this.manualFocus.z += delta.z;
  }

  /** Hand the camera back to its subject. */
  recentre() {
    this.detached = false;
  }

  setSelection(trainId, routeEdgeIds) {
    // Choosing a train is also a request to look at it.
    if (trainId && trainId !== this.selectedTrainId) this.detached = false;
    this.selectedTrainId = trainId || null;
    this.routeEdges = new Set(routeEdgeIds || []);
    if (this.edgeStateData) {
      for (const [id, index] of this.edgeIndex) {
        this.edgeStateData[index * 4 + 2] = this.routeEdges.has(id) ? 1 : 0;
      }
      if (this.edgeStateTexture) this.edgeStateTexture.needsUpdate = true;
    }
    const train = this.trains.find((t) => t.id === trainId);
    if (train) this.waveOrigin = this.corridor[train.current_node || train.source] ?? 0.5;
  }

  setAltitude(altitude) {
    this.targetAltitude = Math.max(0, Math.min(1, altitude));
  }

  /**
   * Move between the diagram basis (0) and true geography (1). Each change
   * restarts the propagation wave from the operator's current focus.
   */
  setBasis(morph) {
    const next = Math.max(0, Math.min(1, morph));
    if (Math.abs(next - this.morphTo) < 0.001) return;
    this.morphFrom = this._currentMorphAt(this.waveOrigin);
    this.morphTo = next;
    this.waveProgress = this.reducedMotion ? 1 : 0;
  }

  setOrbit(delta) {
    this.orbit += delta;
  }

  /* --------------------------------------------------------- local geometry */

  _currentMorphAt(corridor) {
    return lerp(this.morphFrom, this.morphTo, waveAt(corridor, this.waveOrigin, this.waveProgress));
  }

  _stationLocal(id) {
    const s = this.bases.schematic[id];
    const g = this.bases.geographic[id];
    if (!s || !g) return { x: 0, z: 0 };
    const m = this._currentMorphAt(this.corridor[id] ?? 0.5);
    return { x: lerp(s.x, g.x, m), z: lerp(s.z, g.z, m) };
  }

  _trainPlacement(train, motion) {
    if (!train.on_edge || !train.edge_id) {
      // Standing at a station. It still has a direction: the section it is
      // booked to take next, or failing that the one it arrived on. Without
      // this the lineside camera has no heading to align to and ends up
      // pointing at empty ground while a train sits in a platform.
      const node = train.current_node || train.source;
      const p = this._stationLocal(node);
      return { x: p.x, z: p.z, heading: this._headingAtStation(train, node), curvature: 0 };
    }

    const s = this.alignments.schematic[train.edge_id];
    const g = this.alignments.geographic[train.edge_id];
    if (!s || !g) {
      const p = this._stationLocal(train.current_node || train.source);
      return { x: p.x, z: p.z, heading: this.heading, curvature: 0 };
    }

    const edge = this.edges[this.edgeIndex.get(train.edge_id) ?? 0];
    // Sections are bidirectional; a train running against the stored direction
    // reads the same alignment backwards.
    const reversed = Boolean(edge) && train.current_node === edge.to;
    const f = reversed ? 1 - motion.progress : motion.progress;

    const sa = sampleAt(s, f);
    const ga = sampleAt(g, f);

    // The shader gives every track vertex its own corridor coordinate,
    // interpolated from one end of the section to the other, so the morph phase
    // varies *along* a section. A train has to use the phase at its own point
    // on that section, not the phase at the station it left, or it drifts off
    // the rails while the wave is passing through.
    const cFrom = this.corridor[edge?.from] ?? 0.5;
    const cTo = this.corridor[edge?.to] ?? 0.5;
    const m = this._currentMorphAt(corridorAt(cFrom, cTo, f));

    const x = lerp(sa.position.x, ga.position.x, m);
    const z = lerp(sa.position.z, ga.position.z, m);
    let tx = lerp(sa.tangent.x, ga.tangent.x, m);
    let tz = lerp(sa.tangent.z, ga.tangent.z, m);
    if (reversed) {
      tx = -tx;
      tz = -tz;
    }

    return {
      x,
      z,
      heading: Math.atan2(tx, tz),
      curvature: lerp(sa.curvature, ga.curvature, m) * (reversed ? -1 : 1),
    };
  }

  /** The section a standing train will occupy next, if there is one. */
  _nextSectionOf(train) {
    const route = Array.isArray(train.route) ? train.route : [];
    const node = train.current_node || train.source;
    const index = route.indexOf(node);
    const neighbours = [route[index + 1], index > 0 ? route[index - 1] : null];
    for (const other of neighbours) {
      if (!other) continue;
      for (const edge of this.edges) {
        if (
          (edge.from === node && edge.to === other) ||
          (edge.to === node && edge.from === other)
        ) {
          return edge.id;
        }
      }
    }
    return null;
  }

  /** Direction a standing train faces: its next section, else its last one. */
  _headingAtStation(train, node) {
    const route = Array.isArray(train.route) ? train.route : [];
    const index = route.indexOf(node);
    const ahead = index >= 0 ? route[index + 1] : null;
    const behind = index > 0 ? route[index - 1] : null;

    for (const [other, sign] of [
      [ahead, 1],
      [behind, -1],
    ]) {
      if (!other) continue;
      const here = this._stationLocal(node);
      const there = this._stationLocal(other);
      const dx = (there.x - here.x) * sign;
      const dz = (there.z - here.z) * sign;
      if (Math.hypot(dx, dz) > 1e-6) return Math.atan2(dx, dz);
    }
    return this.heading;
  }

  /** Screen position of a local point, for DOM labels. Null when off-screen. */
  project(local) {
    if (!this.viewport) return null;
    const v = new Vector3(local.x - this.origin.x, local.y ?? 0, local.z - this.origin.z);
    v.project(this.camera);
    if (v.z > 1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * this.viewport.width,
      y: (-v.y * 0.5 + 0.5) * this.viewport.height,
      depth: v.z,
    };
  }

  stationScreenPositions() {
    const out = [];
    for (const station of this.stations) {
      const local = this._stationLocal(station.id);
      const screen = this.project(local);
      if (screen) out.push({ id: station.id, station, ...screen });
    }
    return out;
  }

  trainScreenPositions() {
    const out = [];
    for (const train of this.trains) {
      const motion = this.motions.get(train.id);
      if (!motion || train.status === "arrived") continue;
      const placement = this._trainPlacement(train, motion);
      const screen = this.project(placement);
      if (screen) out.push({ id: train.id, train, motion, ...screen });
    }
    return out;
  }

  /* ------------------------------------------------------------ frame loop */

  _tick(time) {
    if (this.contextLost) return;
    const now = time / 1000;
    const dt = this._lastTime ? Math.min(0.1, now - this._lastTime) : 1 / 60;
    this._lastTime = now;

    this._advanceTransitions(dt);
    this._advanceTrains(dt);
    this._updateCamera(dt);
    this._updateUniforms();
    this._placeStations();
    this._placeTrains();
    this._placeFurniture();

    this.renderer.render(this.scene, this.camera);

    if (this.onFrame) this.onFrame(this, dt);
  }

  _advanceTransitions(dt) {
    if (this.waveProgress < 1) {
      // ~1.6 s for the change to cross the corridor: fast enough to feel
      // immediate, slow enough to read as propagation rather than a cut.
      this.waveProgress = Math.min(1, this.waveProgress + dt * 0.62);
      if (this.waveProgress >= 1) this.morphFrom = this.morphTo;
    }

    const lambda = this.reducedMotion ? 1e6 : 3.0;
    this.altitude += (this.targetAltitude - this.altitude) * (1 - Math.exp(-lambda * dt));

    let delta = this.targetHeading + this.orbit - this.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.heading += delta * (1 - Math.exp(-(this.reducedMotion ? 1e6 : 2.2) * dt));
  }

  _advanceTrains(dt) {
    for (const train of this.trains) {
      const motion = this.motions.get(train.id);
      if (!motion) continue;
      integrate(motion, dt, {
        tickIntervalSeconds: this.tickInterval,
        sectionKm: this.sectionKm.get(train.edge_id) || 1,
        paused: this.paused,
        reducedMotion: this.reducedMotion,
      });
    }
  }

  _updateCamera(dt) {
    const selected = this.trains.find((t) => t.id === this.selectedTrainId);
    if (this.detached) {
      // Held wherever the operator left it.
      this.targetFocus.copy(this.manualFocus);
    } else if (selected) {
      const motion = this.motions.get(selected.id);
      const placement = motion ? this._trainPlacement(selected, motion) : null;
      if (placement) {
        this.targetFocus.set(placement.x, 0, placement.z);
        // Below half altitude the camera commits to the train's own direction.
        // Stand behind the train: the camera azimuth is the reverse of the
        // direction of travel, so descending swings the eye around into the
        // train's own frame rather than cutting to it.
        if (this.altitude < 0.55 && selected.on_edge) {
          this.targetHeading = placement.heading + Math.PI;
        }
      }
    } else {
      this.targetFocus.copy(this._networkCentre());
    }

    const a = this.altitude;

    // The descent spans four orders of magnitude, from one section to a whole
    // operating region. A single exponential over that range puts the midpoint
    // at the geometric mean -- around 15 km -- which is neither scale anyone
    // wants. So it is anchored in two halves: the lower half covers a section
    // up to a train's whole route, the upper half covers a route up to the
    // region.
    const diagramDistance = this._diagramDistance();
    const routeDistance = Math.min(diagramDistance * 0.45, ROUTE_DISTANCE);
    const distance =
      a <= 0.5
        ? RAIL_DISTANCE * Math.pow(routeDistance / RAIL_DISTANCE, a / 0.5)
        : routeDistance * Math.pow(diagramDistance / routeDistance, (a - 0.5) / 0.5);

    // The eye has mass and trails its subject. But "how far behind" only means
    // something relative to how far away the camera is: a lag that reads as
    // inertia from the diagram puts the train off-screen at rail level. So the
    // lag is damped in time and then hard-limited to a fraction of the current
    // viewing distance. Inertia stays visible at altitude, and the subject
    // stays framed all the way down, including mid-morph when the ground
    // itself is moving.
    const lambda = lerp(9, 2.4, Math.pow(a, 0.6));
    const k = 1 - Math.exp(-(this.reducedMotion ? 1e6 : lambda) * dt);
    this.focus.x += (this.targetFocus.x - this.focus.x) * k;
    this.focus.z += (this.targetFocus.z - this.focus.z) * k;

    const lagX = this.targetFocus.x - this.focus.x;
    const lagZ = this.targetFocus.z - this.focus.z;
    const lag = Math.hypot(lagX, lagZ);
    const maxLag = distance * 0.18;
    if (lag > maxLag) {
      const pull = (lag - maxLag) / lag;
      this.focus.x += lagX * pull;
      this.focus.z += lagZ * pull;
    }
    this.origin.copy(this.focus);
    // Two camera regimes, blended by altitude.
    //
    //   Plan   -- world-oriented, high and near-vertical, on the +Z side of the
    //             region. (+Z matters: from -Z, lookAt builds a basis whose
    //             screen-right is world -X, which silently mirrors the map and
    //             puts Delhi east of Lucknow.)
    //   Trackside -- train-oriented: alongside the running line, a few metres
    //             up, trailing the train and aimed slightly ahead of it, which
    //             is where the gauge, the sleepers and the speed become legible.
    const rail = 1 - smoothstep01(0.06, 0.5, a);
    const pitch = lerp(0.085, 1.49, Math.pow(a, 0.72));
    this._pitch = pitch;

    const forwardX = Math.sin(this.heading);
    const forwardZ = Math.cos(this.heading);
    // Right-hand perpendicular of the direction of travel, in the ground plane.
    const rightX = forwardZ;
    const rightZ = -forwardX;

    const planX = forwardX * Math.cos(pitch) * distance;
    const planY = Math.sin(pitch) * distance;
    const planZ = forwardZ * Math.cos(pitch) * distance;

    const sideX = rightX * RAIL_SIDE + forwardX * RAIL_FORWARD;
    const sideY = RAIL_HEIGHT;
    const sideZ = rightZ * RAIL_SIDE + forwardZ * RAIL_FORWARD;

    this.camera.position.set(
      lerp(planX, sideX, rail),
      lerp(planY, sideY, rail),
      lerp(planZ, sideZ, rail)
    );

    const lookAhead = RAIL_LOOK_AHEAD * rail;
    this.camera.lookAt(forwardX * lookAhead, GAUGE * 1.6 * rail, forwardZ * lookAhead);
    this.camera.near = distance * 0.004;
    this.camera.far = distance * 26 + 8;
    this.camera.updateProjectionMatrix();
    this._cameraDistance = distance;

    // How many world units one screen pixel covers at the focus. Everything
    // drawn is sized as "its true size, but never thinner than N pixels", which
    // is how a map keeps a road legible when zoomed out without pretending the
    // road is a kilometre wide.
    const height = this.viewport?.height || 600;
    this._pixelSize = (2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)) / height;
  }

  _updateUniforms() {
    const u = this.trackMaterial?.uniforms;
    if (!u) return;
    const a = this.altitude;
    const px = this._pixelSize || 0.001;

    u.uOrigin.value.copy(this.origin);
    u.uWaveOrigin.value = this.waveOrigin;
    u.uWaveProgress.value = this.waveProgress;
    u.uMorphFrom.value = this.morphFrom;
    u.uMorphTo.value = this.morphTo;
    u.uAltitude.value = a;

    // The formation is 4.5 m wide and stays 4.5 m wide. When that is thinner
    // than the minimum legible line it is drawn at the minimum instead, and the
    // two rails close up into a single line, because at that distance the gauge
    // is not information any more -- it is noise.
    const trueBallast = FORMATION * 0.5;
    const minBallast = px * 1.6;
    u.uBallastHalf.value = Math.max(trueBallast, minBallast);

    const closeness = Math.min(1, trueBallast / Math.max(minBallast, 1e-9));
    u.uRailHalf.value = Math.max(RAIL_HEAD, px * 0.55);
    u.uGauge.value = GAUGE * closeness;
    u.uRailLift.value = GAUGE * 0.09 * closeness;
    this._closeness = closeness;

    // Atmosphere, not a curtain. Starting the fade close to the camera erased
    // the ground before its grid could establish any sense of scale.
    const d = this._cameraDistance;
    u.uFogNear.value = d * 3.5;
    u.uFogFar.value = d * 22;

    const g = this.groundMaterial.uniforms;
    g.uOrigin.value.copy(this.origin);
    g.uMorph.value = this._currentMorphAt(0.5);

    // The ground grid is a scale bar, not wallpaper. Its spacing follows the
    // viewing distance in 1-2-5 steps, the way a map's grid does, so there is
    // always ground reference and parallax to judge speed against -- whether
    // the operator is looking at the whole region or at one section.
    this.gridSpacingKm = niceStep(this._cameraDistance / UNITS_PER_KM / 12);
    g.uSpacing.value = this.gridSpacingKm * UNITS_PER_KM;
    g.uFade.value = lerp(0.5, 0.85, Math.pow(a, 0.5));
    g.uFogNear.value = u.uFogNear.value;
    g.uFogFar.value = u.uFogFar.value;

    for (const mesh of [this.stationMesh, this.trainMesh, this.sleeperMesh, this.signalMesh]) {
      const m = mesh?.material?.uniforms;
      if (!m) continue;
      m.uFogNear.value = u.uFogNear.value;
      m.uFogFar.value = u.uFogFar.value;
    }
  }

  _setTint(mesh, index, color) {
    const tint = mesh.userData.tint;
    tint.array[index * 3] = color.r;
    tint.array[index * 3 + 1] = color.g;
    tint.array[index * 3 + 2] = color.b;
  }

  _placeStations() {
    if (!this.stations.length) return;
    const o = this._obj;
    const px = this._pixelSize || 0.001;
    let i = 0;

    for (const station of this.stations) {
      if (i >= this.stationMesh.instanceMatrix.count) break;
      const p = this._stationLocal(station.id);
      // A real platform length, floored so a station never vanishes on the
      // region diagram. Junctions and terminals hold a larger floor because
      // they are what an operator navigates by.
      const real =
        PLATFORM_KM * UNITS_PER_KM * (station.type === "terminal" ? 1 : station.type === "minor" ? 0.45 : 0.75);
      const floorPx = station.type === "terminal" ? 9 : station.type === "junction" ? 7 : 4;
      const length = Math.max(real, px * floorPx);

      o.position.set(p.x - this.origin.x, 0.0006, p.z - this.origin.z);
      o.rotation.set(0, 0, 0);
      o.scale.set(length * 0.4, 1, length);
      o.updateMatrix();
      this.stationMesh.setMatrixAt(i, o.matrix);
      this._setTint(this.stationMesh, i, PALETTE.platform);
      i += 1;
    }

    this.stationMesh.count = i;
    this.stationMesh.instanceMatrix.needsUpdate = true;
    this.stationMesh.userData.tint.needsUpdate = true;
  }

  _placeTrains() {
    const o = this._obj;
    const px = this._pixelSize || 0.001;
    const rake = COACH * RAKE_COACHES;
    let i = 0;

    for (const train of this.trains) {
      const motion = this.motions.get(train.id);
      if (!motion || train.status === "arrived") continue;
      if (i >= this.trainMesh.instanceMatrix.count) break;

      const placement = this._trainPlacement(train, motion);
      const { targetCant, targetPitch } = attitude(motion, placement.curvature, UNITS_PER_KM);
      motion.cant = lerp(motion.cant, targetCant, this.reducedMotion ? 1 : 0.1);
      motion.pitch = lerp(motion.pitch, targetPitch, this.reducedMotion ? 1 : 0.1);

      // A true 336 m rake, floored so the train stays a visible mark on the
      // region diagram rather than a sub-pixel speck.
      const length = Math.max(rake, px * 10);
      const width = Math.max(GAUGE * 1.55, px * 3.2);
      const height = Math.max(0.0037 * UNITS_PER_KM, px * 1.2);

      o.position.set(placement.x - this.origin.x, GAUGE * 0.22 + 0.0006, placement.z - this.origin.z);
      o.rotation.set(motion.pitch, placement.heading, motion.cant);
      o.scale.set(width, height, length);
      o.updateMatrix();
      this.trainMesh.setMatrixAt(i, o.matrix);

      const tint = STATUS_TINT[train.status] || STATUS_TINT.scheduled;
      const selected = train.id === this.selectedTrainId;
      this._setTint(this.trainMesh, i, selected ? tint : tint.clone().multiplyScalar(0.62));
      i += 1;
    }

    this.trainMesh.count = i;
    this.trainMesh.instanceMatrix.needsUpdate = true;
    this.trainMesh.userData.tint.needsUpdate = true;
  }

  /**
   * Sleepers and signals only exist close to the ground, and only around the
   * focus. They are rebuilt when the focused section changes, not per frame.
   */
  _placeFurniture() {
    if (this.altitude > 0.5) {
      this.sleeperMesh.count = 0;
      this.signalMesh.count = 0;
      this._furnitureKey = "";
      return;
    }

    const selected = this.trains.find((t) => t.id === this.selectedTrainId);
    // A standing train still needs track under it: fall back to the section it
    // is booked to take next, so a platform view is not bare formation.
    const edgeId = selected ? selected.edge_id || this._nextSectionOf(selected) : null;
    const key = `${edgeId}|${this.morphTo}|${this.waveProgress >= 1}`;
    if (key !== this._furnitureKey) {
      this._furnitureKey = key;
      this._rebuildFurniture(edgeId);
    }

    const o = this._obj;
    const width = GAUGE * 1.75;
    let i = 0;
    for (const s of this._sleeperLocals) {
      if (i >= this.sleeperMesh.instanceMatrix.count) break;
      o.position.set(s.x - this.origin.x, 0.0002, s.z - this.origin.z);
      o.rotation.set(0, s.heading, 0);
      o.scale.set(width, 1, width * 0.14);
      o.updateMatrix();
      this.sleeperMesh.setMatrixAt(i, o.matrix);
      this._setTint(this.sleeperMesh, i, PALETTE.sleeper);
      i += 1;
    }
    this.sleeperMesh.count = i;
    this.sleeperMesh.instanceMatrix.needsUpdate = true;
    this.sleeperMesh.userData.tint.needsUpdate = true;

    this._placeSignals();
  }

  /**
   * One signal at the entry to each section that meets the focused station,
   * showing that section's real state: clear, caution when it is loaded, danger
   * when it is blocked.
   */
  _placeSignals() {
    const selected = this.trains.find((t) => t.id === this.selectedTrainId);
    if (!selected) {
      this.signalMesh.count = 0;
      return;
    }

    const o = this._obj;
    const node = selected.next_node || selected.current_node;
    const height = GAUGE * 2.6;
    let i = 0;

    for (const edge of this.edges) {
      if (edge.from !== node && edge.to !== node) continue;
      if (i >= this.signalMesh.instanceMatrix.count) break;

      const alignmentS = this.alignments.schematic[edge.id];
      const alignmentG = this.alignments.geographic[edge.id];
      if (!alignmentS || !alignmentG) continue;

      const atFrom = edge.from === node;
      const sa = sampleAt(alignmentS, atFrom ? 0.02 : 0.98);
      const ga = sampleAt(alignmentG, atFrom ? 0.02 : 0.98);
      const m = this._currentMorphAt(this.corridor[node] ?? 0.5);
      const x = lerp(sa.position.x, ga.position.x, m);
      const z = lerp(sa.position.z, ga.position.z, m);
      const heading = Math.atan2(lerp(sa.tangent.x, ga.tangent.x, m), lerp(sa.tangent.z, ga.tangent.z, m));

      // Stand the mast clear of the running line, on the left-hand side.
      const offset = GAUGE * 2.2;
      o.position.set(
        x - this.origin.x + Math.cos(heading) * offset,
        0,
        z - this.origin.z - Math.sin(heading) * offset
      );
      o.rotation.set(0, heading, 0);
      o.scale.set(GAUGE * 0.14, height, GAUGE * 0.14);
      o.updateMatrix();
      this.signalMesh.setMatrixAt(i, o.matrix);

      const load = Number(edge.load_ratio) || 0;
      const aspect = edge.blocked ? PALETTE.danger : load >= 0.95 ? PALETTE.danger : load >= 0.55 ? PALETTE.caution : PALETTE.clear;
      this._setTint(this.signalMesh, i, aspect);
      i += 1;
    }

    this.signalMesh.count = i;
    this.signalMesh.instanceMatrix.needsUpdate = true;
    this.signalMesh.userData.tint.needsUpdate = true;
  }

  _rebuildFurniture(edgeId) {
    const locals = [];
    const s = edgeId ? this.alignments.schematic[edgeId] : null;
    const g = edgeId ? this.alignments.geographic[edgeId] : null;

    if (s && g) {
      const km = this.sectionKm.get(edgeId) || 1;
      const capacity = this.sleeperMesh.instanceMatrix.count;
      // True 600 mm spacing, capped at the instance budget. Only the stretch
      // around the train is ever on screen at this altitude.
      const total = Math.round((km * UNITS_PER_KM) / SLEEPER_SPACING);
      const count = Math.min(capacity, total);
      const edge = this.edges[this.edgeIndex.get(edgeId) ?? 0];
      const cFrom = this.corridor[edge?.from] ?? 0.5;
      const cTo = this.corridor[edge?.to] ?? 0.5;

      for (let i = 0; i < count; i += 1) {
        const f = total > 0 ? (i / total) : 0;
        const m = this._currentMorphAt(corridorAt(cFrom, cTo, f));
        const sa = sampleAt(s, f);
        const ga = sampleAt(g, f);
        locals.push({
          x: lerp(sa.position.x, ga.position.x, m),
          z: lerp(sa.position.z, ga.position.z, m),
          heading: Math.atan2(
            lerp(sa.tangent.x, ga.tangent.x, m),
            lerp(sa.tangent.z, ga.tangent.z, m)
          ),
        });
      }
    }

    this._sleeperLocals = locals;
  }
}
