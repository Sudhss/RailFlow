import * as d3 from "d3";
import { useMemo, useState } from "react";

const WIDTH = 1080;
const HEIGHT = 620;
const PAD_X = 50;
const PAD_Y = 48;

export default function GraphView({ stations, edges, trains, selectedTrain, onSelectTrain }) {
  const [hoveredTrain, setHoveredTrain] = useState(null);
  const geometry = useMemo(() => buildGeometry(stations), [stations]);
  const selectedRouteEdges = useMemo(() => routeEdgeIds(selectedTrain, edges), [selectedTrain, edges]);

  return (
    <div className="graph-shell">
      <svg className="network-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Geographic railway graph">
        <defs>
          <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
            <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(220, 227, 214, 0.055)" strokeWidth="1" />
          </pattern>
          <filter id="trainGlow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="url(#grid)" />
        <g className="edge-layer">
          {edges.map((edge) => {
            const from = geometry[edge.from];
            const to = geometry[edge.to];
            if (!from || !to) return null;
            const active = selectedRouteEdges.has(edge.id);
            return (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={`track-line ${edge.congestion} ${active ? "optimal" : ""}`}
                strokeWidth={active ? 5 : edge.capacity > 2 ? 3.2 : 2.1}
              />
            );
          })}
        </g>
        <g className="station-layer">
          {stations.map((station) => {
            const point = geometry[station.id];
            if (!point) return null;
            return (
              <g key={station.id} className={`station-node ${station.type}`} transform={`translate(${point.x}, ${point.y})`}>
                <circle r={station.type === "terminal" ? 8 : station.type === "junction" ? 6 : 4} />
                <text x="9" y="-7">
                  {station.id}
                </text>
              </g>
            );
          })}
        </g>
        <g className="train-layer">
          {trains.map((train) => {
            const position = trainPosition(train, edges, geometry);
            if (!position) return null;
            const selected = selectedTrain?.id === train.id;
            return (
              <g
                key={train.id}
                className={`train-dot ${train.status} ${selected ? "selected" : ""}`}
                transform={`translate(${position.x}, ${position.y})`}
                onMouseEnter={() => setHoveredTrain(train)}
                onMouseLeave={() => setHoveredTrain(null)}
                onClick={() => onSelectTrain(train.id)}
              >
                <circle r={selected ? 8 : 6} filter="url(#trainGlow)" />
                <text x="10" y="4">
                  {train.id}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="map-legend">
        <span><i className="legend normal" />Normal</span>
        <span><i className="legend busy" />Busy</span>
        <span><i className="legend congested" />Congested</span>
        <span><i className="legend closed" />Closed</span>
        <span><i className="legend optimal" />Selected route</span>
      </div>
      {hoveredTrain && (
        <div className="hover-card">
          <strong>{hoveredTrain.id}</strong>
          <span>{hoveredTrain.type} to {hoveredTrain.destination}</span>
          <span>{Math.round(hoveredTrain.current_speed)} km/h</span>
          <span>{hoveredTrain.delay} min delay</span>
        </div>
      )}
    </div>
  );
}

export function buildGeometry(stations) {
  if (!stations.length) return {};
  const xScale = d3
    .scaleLinear()
    .domain(d3.extent(stations, (station) => station.x))
    .range([PAD_X, WIDTH - PAD_X]);
  const yScale = d3
    .scaleLinear()
    .domain(d3.extent(stations, (station) => station.y))
    .range([PAD_Y, HEIGHT - PAD_Y]);
  return Object.fromEntries(
    stations.map((station) => [
      station.id,
      {
        x: xScale(station.x),
        y: yScale(station.y),
        station
      }
    ])
  );
}

export function trainPosition(train, edges, geometry) {
  if (train.on_edge && train.current_node && train.next_node) {
    const from = geometry[train.current_node];
    const to = geometry[train.next_node];
    if (!from || !to) return null;
    const progress = Math.max(0, Math.min(1, train.edge_progress || 0));
    return {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress
    };
  }
  const station = geometry[train.current_node || train.source];
  if (station) return { x: station.x, y: station.y };
  const edge = edges.find((item) => item.id === train.edge_id);
  if (!edge) return null;
  return geometry[edge.from] || null;
}

function routeEdgeIds(train, edges) {
  const route = train?.display_route || train?.route;
  if (!route) return new Set();
  const ids = new Set();
  for (let index = 0; index < route.length - 1; index += 1) {
    const from = route[index];
    const to = route[index + 1];
    const edge = edges.find((item) => (item.from === from && item.to === to) || (item.from === to && item.to === from));
    if (edge) ids.add(edge.id);
  }
  return ids;
}
