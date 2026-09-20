/**
 * Track alignment.
 *
 * Real track does not meet at a vertex. It leaves a station on the station's
 * through-axis and curves into the next one, and the radius it can hold is set
 * by the line speed. This module builds that alignment for every section, in
 * both coordinate bases, and reparameterises each curve by arc length.
 *
 * Arc length matters: a train at edge_progress 0.5 is half way along the
 * *section*, not half way along the curve's parameter. Without the
 * reparameterisation every train visibly accelerates through curves and slows
 * on straights, which is the classic tell of decorative rather than physical
 * motion.
 *
 * Pure math, no renderer types, so it can be tested directly under node --test.
 */

const SAMPLES_PER_SECTION = 24;

function sub(a, b) {
  return { x: a.x - b.x, z: a.z - b.z };
}

function norm(v) {
  const length = Math.hypot(v.x, v.z);
  if (length < 1e-9) return { x: 0, z: 0 };
  return { x: v.x / length, z: v.z / length };
}

function dot(a, b) {
  return a.x * b.x + a.z * b.z;
}

function mix(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * The axis a station is aligned on: the pair of neighbours pointing most
 * directly away from each other. A through station gets the corridor axis, a
 * terminal gets the direction of its single neighbour.
 */
export function throughAxis(stationId, neighbourIds, positions) {
  const here = positions[stationId];
  if (!here) return { x: 1, z: 0 };
  const dirs = neighbourIds
    .map((id) => positions[id])
    .filter(Boolean)
    .map((p) => norm(sub(p, here)));

  if (dirs.length === 0) return { x: 1, z: 0 };
  if (dirs.length === 1) return dirs[0];

  let best = dirs[0];
  let bestDot = Infinity;
  for (let i = 0; i < dirs.length; i += 1) {
    for (let j = i + 1; j < dirs.length; j += 1) {
      const d = dot(dirs[i], dirs[j]);
      if (d < bestDot) {
        bestDot = d;
        best = norm(sub(dirs[i], dirs[j]));
      }
    }
  }
  return best;
}

/** Cubic Bezier point. */
function bezier(p0, c0, c1, p1, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
    z: a * p0.z + b * c0.z + c * c1.z + d * p1.z,
  };
}

/**
 * Sample one section into an arc-length table.
 *
 * `curvature` is how far the tangent is allowed to swing toward the station's
 * through-axis. Fast sections stay closer to straight, matching the larger
 * radii a high line speed requires.
 */
export function sampleSection(from, to, axisFrom, axisTo, curvature) {
  const chord = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  const dir = norm(sub(to, from));

  // Orient each station's axis so it points along the direction of travel.
  const orientedFrom = dot(axisFrom, dir) < 0 ? { x: -axisFrom.x, z: -axisFrom.z } : axisFrom;
  const orientedTo = dot(axisTo, dir) < 0 ? { x: -axisTo.x, z: -axisTo.z } : axisTo;

  const tangentFrom = norm(mix(dir, orientedFrom, curvature));
  const tangentTo = norm(mix(dir, orientedTo, curvature));
  const handle = chord / 3;

  const p0 = from;
  const p1 = to;
  const c0 = { x: from.x + tangentFrom.x * handle, z: from.z + tangentFrom.z * handle };
  const c1 = { x: to.x - tangentTo.x * handle, z: to.z - tangentTo.z * handle };

  const points = [];
  const cumulative = [0];
  for (let i = 0; i <= SAMPLES_PER_SECTION; i += 1) {
    const point = bezier(p0, c0, c1, p1, i / SAMPLES_PER_SECTION);
    points.push(point);
    if (i > 0) {
      const previous = points[i - 1];
      cumulative.push(cumulative[i - 1] + Math.hypot(point.x - previous.x, point.z - previous.z));
    }
  }

  const length = cumulative[cumulative.length - 1] || 1;
  return { points, cumulative, length };
}

/**
 * Position at a fraction of the section measured along the rail, plus the unit
 * tangent and the signed curvature there. Curvature drives cant: a train
 * leaning into a curve is leaning by v^2 / r, not by an eased constant.
 */
export function sampleAt(section, fraction) {
  const { points, cumulative, length } = section;
  const target = Math.max(0, Math.min(1, fraction)) * length;

  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= target) lo = mid;
    else hi = mid;
  }

  const segmentLength = cumulative[hi] - cumulative[lo] || 1;
  const t = (target - cumulative[lo]) / segmentLength;
  const a = points[lo];
  const b = points[hi];
  const position = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  const tangent = norm(sub(b, a));

  // Discrete curvature from the turn between the neighbouring segments.
  const prev = points[Math.max(0, lo - 1)];
  const next = points[Math.min(points.length - 1, hi + 1)];
  const inDir = norm(sub(a, prev));
  const outDir = norm(sub(next, b));
  const cross = inDir.x * outDir.z - inDir.z * outDir.x;
  const turn = Math.asin(Math.max(-1, Math.min(1, cross)));
  const span = Math.hypot(next.x - prev.x, next.z - prev.z) || 1;

  return { position, tangent, curvature: turn / span };
}

/**
 * Build the alignment for every edge, in one coordinate basis.
 * Returns a map of edgeId -> section table.
 */
export function buildAlignment(stations, edges, positions) {
  const neighbours = {};
  for (const station of stations) neighbours[station.id] = [];
  for (const edge of edges) {
    if (neighbours[edge.from]) neighbours[edge.from].push(edge.to);
    if (neighbours[edge.to]) neighbours[edge.to].push(edge.from);
  }

  const axes = {};
  for (const station of stations) {
    axes[station.id] = throughAxis(station.id, neighbours[station.id] || [], positions);
  }

  const sections = {};
  for (const edge of edges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) continue;
    // 60 km/h sections bend noticeably; 120 km/h sections stay nearly straight.
    const speed = Number(edge.avg_speed) || 60;
    const curvature = Math.max(0.12, Math.min(0.62, 1 - (speed - 40) / 110));
    sections[edge.id] = sampleSection(from, to, axes[edge.from], axes[edge.to], curvature);
  }
  return sections;
}
