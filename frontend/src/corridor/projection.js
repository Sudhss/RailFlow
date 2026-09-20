/**
 * RailFlow carries every station in two coordinate systems at once:
 *
 *   lat / lng  the real position of the station on the ground
 *   x / y      the hand-drawn control-room diagram position
 *
 * Both are authored in backend/data/railway_graph.json. The corridor view keeps
 * both alive simultaneously and moves between them, so each one gets projected
 * into the same world box here and nothing is invented along the way.
 *
 * World space: X runs east, Z runs south, Y is up. One world unit is roughly
 * one kilometre at corridor scale, which keeps the rail-level numbers (1.676 m
 * gauge, 26 m coach) in a sane range once scaled.
 */

export const WORLD_WIDTH = 420;

/** Web Mercator, in radians-ish units. Valid for the corridor's latitudes. */
export function mercator(lat, lng) {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const phi = (clampedLat * Math.PI) / 180;
  return {
    mx: (lng * Math.PI) / 180,
    my: Math.log(Math.tan(Math.PI / 4 + phi / 2)),
  };
}

function extent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, span: 1 };
  const span = max - min || 1;
  return { min, max, span };
}

/**
 * Fit a set of 2D points into a centred world box of WORLD_WIDTH across,
 * preserving the aspect ratio of the source so neither basis is distorted.
 */
function fitToWorld(points) {
  const ex = extent(points.map((p) => p.u));
  const ey = extent(points.map((p) => p.v));
  const scale = WORLD_WIDTH / Math.max(ex.span, ey.span * 1.6);
  return points.map((p) => ({
    id: p.id,
    x: (p.u - (ex.min + ex.span / 2)) * scale,
    z: (p.v - (ey.min + ey.span / 2)) * scale,
  }));
}

/**
 * Build both bases for a station list.
 * Returns { geographic: {id: {x,z}}, schematic: {id: {x,z}} }.
 */
export function buildBases(stations) {
  if (!stations || stations.length === 0) {
    return { geographic: {}, schematic: {}, order: [] };
  }

  const geoPoints = stations.map((station) => {
    const { mx, my } = mercator(Number(station.lat), Number(station.lng));
    // Mercator y grows north; world Z grows south, hence the negation.
    return { id: station.id, u: mx, v: -my };
  });

  // The diagram's y axis already points down the screen, which matches world Z.
  const schemaPoints = stations.map((station) => ({
    id: station.id,
    u: Number(station.x),
    v: Number(station.y),
  }));

  const geographic = {};
  for (const p of fitToWorld(geoPoints)) geographic[p.id] = { x: p.x, z: p.z };

  const schematic = {};
  for (const p of fitToWorld(schemaPoints)) schematic[p.id] = { x: p.x, z: p.z };

  return { geographic, schematic, order: stations.map((s) => s.id) };
}

/**
 * Corridor coordinate: 0 at the western-most station, 1 at the eastern-most,
 * measured on the true geography. Used as the phase offset for the layout wave
 * so a change sweeps along the corridor instead of cross-fading everywhere at
 * once -- the way a state change actually travels through a rail network.
 */
export function corridorCoordinates(geographic, order) {
  const xs = order.map((id) => geographic[id]?.x ?? 0);
  const { min, span } = extent(xs);
  const result = {};
  for (const id of order) {
    result[id] = ((geographic[id]?.x ?? 0) - min) / span;
  }
  return result;
}

/**
 * Ground-plane movement for a drag of (dx, dy) screen pixels.
 *
 * Drag-to-pan means the ground follows the cursor: grab a station, move the
 * mouse, and that station stays under the pointer. So the focus travels
 * *against* the drag.
 *
 * `heading` is the azimuth from the focus out to the camera, which makes the
 * direction from camera into the scene -(sin h, cos h) and screen-right
 * (cos h, -sin h) on the ground.
 *
 * The vertical component is divided by sin(pitch): a nearly flat camera sees
 * the ground heavily foreshortened, so one pixel of vertical drag covers far
 * more ground than one pixel of horizontal drag. Without this, panning feels
 * sluggish at low altitude and the ground slips under the cursor.
 */
export function panDelta(dx, dy, heading, pitch, pixelSize) {
  const rightX = Math.cos(heading);
  const rightZ = -Math.sin(heading);
  const forwardX = -Math.sin(heading);
  const forwardZ = -Math.cos(heading);

  const foreshorten = Math.max(0.25, Math.sin(pitch));
  const alongScreenY = (dy / foreshorten) * pixelSize;
  const alongScreenX = dx * pixelSize;

  return {
    x: -rightX * alongScreenX + forwardX * alongScreenY,
    z: -rightZ * alongScreenX + forwardZ * alongScreenY,
  };
}
