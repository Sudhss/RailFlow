import { useMemo, useState } from "react";

/**
 * The geographic network, drawn flat.
 *
 * This is the console's second opinion and its WebGL fallback: the same
 * sections, states and train positions, rendered as SVG so the picture survives
 * a machine with no usable GPU and prints as a diagram.
 *
 * It used to pull all of d3 in to call scaleLinear and extent. Two linear
 * mappings do not need a charting library, so the scales are computed here and
 * the dependency is gone.
 */

const WIDTH = 1080;
const HEIGHT = 600;
const PAD_X = 54;
const PAD_Y = 46;

export default function GraphView({ stations, edges, trains, selectedTrain, onSelectTrain, notice }) {
  const [hovered, setHovered] = useState(null);
  const geometry = useMemo(() => buildGeometry(stations), [stations]);

  const edgeLookup = useMemo(() => {
    const map = new Map();
    for (const edge of edges) {
      map.set(`${edge.from}|${edge.to}`, edge);
      map.set(`${edge.to}|${edge.from}`, edge);
    }
    return map;
  }, [edges]);

  // Precomputed once per render instead of scanning every edge per route leg.
  const routeEdges = useMemo(() => {
    const route = selectedTrain?.route;
    if (!route?.length) return new Set();
    const ids = new Set();
    for (let i = 0; i < route.length - 1; i += 1) {
      const edge = edgeLookup.get(`${route[i]}|${route[i + 1]}`);
      if (edge) ids.add(edge.id);
    }
    return ids;
  }, [selectedTrain?.route, edgeLookup]);

  const travelled = useMemo(() => {
    const history = selectedTrain?.history;
    if (!history?.length) return new Set();
    const ids = new Set();
    for (let i = 0; i < history.length - 1; i += 1) {
      const edge = edgeLookup.get(`${history[i]}|${history[i + 1]}`);
      if (edge) ids.add(edge.id);
    }
    return ids;
  }, [selectedTrain?.history, edgeLookup]);

  if (!stations.length) {
    return (
      <div className="flat-view flat-view--empty" role="status">
        <p className="empty-title">No railway graph loaded</p>
        <p className="empty-body">
          The console has not received a station list from the simulation yet.
        </p>
      </div>
    );
  }

  const hoveredTrain = hovered && trains.find((train) => train.id === hovered);

  return (
    <div className="flat-view">
      {notice && <p className="flat-view-notice">{notice}</p>}
      <svg
        className="flat-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Geographic network: ${stations.length} stations, ${edges.length} sections, ${trains.length} trains`}
      >
        <g className="sections">
          {edges.map((edge) => {
            const from = geometry[edge.from];
            const to = geometry[edge.to];
            if (!from || !to) return null;
            const onRoute = routeEdges.has(edge.id);
            const done = travelled.has(edge.id);
            return (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={`section section--${edge.congestion}${onRoute ? " is-route" : ""}${done ? " is-travelled" : ""}`}
                strokeWidth={onRoute ? 4.5 : edge.capacity > 2 ? 2.8 : 1.9}
              >
                <title>
                  {edge.id}: {edge.distance_km} km, {edge.trains_on_edge}/{edge.capacity} occupied
                  {edge.blocked ? ", closed" : ""}
                  {edge.speed_limit ? `, limited to ${edge.speed_limit} km/h` : ""}
                </title>
              </line>
            );
          })}
        </g>

        <g className="nodes">
          {stations.map((station) => {
            const point = geometry[station.id];
            if (!point) return null;
            const radius = station.type === "terminal" ? 6.5 : station.type === "junction" ? 5 : 3;
            const named = station.type !== "minor";
            return (
              <g key={station.id} transform={`translate(${point.x} ${point.y})`} className={`node node--${station.type}`}>
                <circle r={radius}>
                  <title>
                    {station.name} ({station.id})
                  </title>
                </circle>
                {named && (
                  <text x={radius + 4} y={-radius - 2}>
                    {station.id}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        <g className="marks">
          {trains.map((train) => {
            const point = trainPosition(train, geometry);
            if (!point) return null;
            const selected = selectedTrain?.id === train.id;
            return (
              <g
                key={train.id}
                transform={`translate(${point.x} ${point.y})`}
                className={`mark mark--${train.status}${selected ? " is-selected" : ""}`}
                onMouseEnter={() => setHovered(train.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onSelectTrain(train.id)}
              >
                <circle r={selected ? 6.5 : 4.5} />
                <text x="9" y="4">
                  {train.id}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <ul className="legend">
        <li>
          <i className="swatch swatch--normal" />
          Clear
        </li>
        <li>
          <i className="swatch swatch--busy" />
          Busy
        </li>
        <li>
          <i className="swatch swatch--congested" />
          Over capacity
        </li>
        <li>
          <i className="swatch swatch--closed" />
          Closed
        </li>
        <li>
          <i className="swatch swatch--route" />
          Selected route
        </li>
      </ul>

      {hoveredTrain && (
        <dl className="hover-facts">
          <div>
            <dt>Train</dt>
            <dd className="mono">{hoveredTrain.id}</dd>
          </div>
          <div>
            <dt>Speed</dt>
            <dd className="mono">{Math.round(hoveredTrain.current_speed)} km/h</dd>
          </div>
          <div>
            <dt>Delay</dt>
            <dd className="mono">{hoveredTrain.delay} min</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd className="mono">{hoveredTrain.destination}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

/** A plain linear fit of the diagram coordinates into the viewport. */
export function buildGeometry(stations) {
  if (!stations?.length) return {};

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const station of stations) {
    minX = Math.min(minX, station.x);
    maxX = Math.max(maxX, station.x);
    minY = Math.min(minY, station.y);
    maxY = Math.max(maxY, station.y);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const out = {};
  for (const station of stations) {
    out[station.id] = {
      x: PAD_X + ((station.x - minX) / spanX) * (WIDTH - PAD_X * 2),
      y: PAD_Y + ((station.y - minY) / spanY) * (HEIGHT - PAD_Y * 2),
      station,
    };
  }
  return out;
}

export function trainPosition(train, geometry) {
  if (train.on_edge && train.current_node && train.next_node) {
    const from = geometry[train.current_node];
    const to = geometry[train.next_node];
    if (from && to) {
      const progress = Math.max(0, Math.min(1, train.edge_progress || 0));
      return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
    }
  }
  const station = geometry[train.current_node] || geometry[train.source];
  return station ? { x: station.x, y: station.y } : null;
}
