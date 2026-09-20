import { useMemo, useState } from "react";
import { trainPosition } from "./GraphView.jsx";

/**
 * The signal diagram.
 *
 * A schematic in the control-room tradition: routes flattened onto horizontal
 * lines, sections drawn as blocks, and every train shown on the block it is
 * occupying. It answers a different question from the map -- not "where is this
 * train" but "which sections are free".
 *
 * The original version hard-coded three lists of station codes to lay out its
 * lanes, so any station added through the API landed in a heap in the middle of
 * the canvas. Lanes are now derived from the graph: the longest path through
 * the network becomes the main line, and what is left is assigned to further
 * lanes in the order it branches off.
 */

const WIDTH = 1080;
const HEIGHT = 600;
const MARGIN_X = 64;
const LANE_GAP = 96;

export default function SignalPanel({ stations, edges, trains, selectedTrain, onSelectTrain }) {
  const [hovered, setHovered] = useState(null);
  const layout = useMemo(() => buildLanes(stations, edges), [stations, edges]);

  if (!stations.length) {
    return (
      <div className="flat-view flat-view--empty" role="status">
        <p className="empty-title">No railway graph loaded</p>
        <p className="empty-body">The console has not received a section list yet.</p>
      </div>
    );
  }

  const hoveredEdge = hovered && edges.find((edge) => edge.id === hovered);

  return (
    <div className="flat-view">
      <svg
        className="flat-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Signal diagram: ${edges.length} sections across ${layout.laneCount} lanes`}
      >
        <g className="blocks">
          {edges.map((edge) => {
            const from = layout.geometry[edge.from];
            const to = layout.geometry[edge.to];
            if (!from || !to) return null;
            const sameLane = Math.abs(from.y - to.y) < 1;
            const midX = (from.x + to.x) / 2;
            const d = sameLane
              ? `M ${from.x} ${from.y} L ${to.x} ${to.y}`
              : `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
            return (
              <path
                key={edge.id}
                d={d}
                className={`block block--${edge.congestion}`}
                onMouseEnter={() => setHovered(edge.id)}
                onMouseLeave={() => setHovered(null)}
              >
                <title>
                  {edge.id}: {edge.trains_on_edge}/{edge.capacity} occupied
                  {edge.blocked ? ", closed" : ""}
                </title>
              </path>
            );
          })}
        </g>

        <g className="berths">
          {stations.map((station) => {
            const point = layout.geometry[station.id];
            if (!point) return null;
            return (
              <g key={station.id} transform={`translate(${point.x} ${point.y})`} className={`berth berth--${station.type}`}>
                <rect x="-15" y="-7" width="30" height="14" rx="1.5" />
                <text y="-13">{station.id}</text>
              </g>
            );
          })}
        </g>

        <g className="marks">
          {trains.map((train) => {
            const point = trainPosition(train, layout.geometry);
            if (!point) return null;
            const selected = selectedTrain?.id === train.id;
            return (
              <g
                key={train.id}
                transform={`translate(${point.x} ${point.y})`}
                className={`describer mark--${train.status}${selected ? " is-selected" : ""}`}
                onClick={() => onSelectTrain(train.id)}
              >
                <rect x="-22" y="-9" width="44" height="18" rx="1.5" />
                <text y="4">{train.id}</text>
              </g>
            );
          })}
        </g>
      </svg>

      {hoveredEdge && (
        <dl className="hover-facts">
          <div>
            <dt>Section</dt>
            <dd className="mono">{hoveredEdge.id}</dd>
          </div>
          <div>
            <dt>Occupied</dt>
            <dd className="mono">
              {hoveredEdge.trains_on_edge}/{hoveredEdge.capacity}
            </dd>
          </div>
          <div>
            <dt>State</dt>
            <dd className={`state state--${hoveredEdge.congestion}`}>{hoveredEdge.congestion}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

/**
 * Lay stations onto horizontal lanes derived from the graph itself.
 *
 * The main line is the longest simple path found from the westernmost station;
 * each remaining component is placed on the next lane down. Nothing is
 * hard-coded, so stations added at runtime are positioned like any other.
 */
export function buildLanes(stations, edges) {
  const geometry = {};
  if (!stations?.length) return { geometry, laneCount: 0 };

  const neighbours = new Map(stations.map((station) => [station.id, []]));
  for (const edge of edges || []) {
    neighbours.get(edge.from)?.push(edge.to);
    neighbours.get(edge.to)?.push(edge.from);
  }

  const byId = new Map(stations.map((station) => [station.id, station]));
  const remaining = new Set(stations.map((station) => station.id));
  const lanes = [];

  // Walk from the westernmost unplaced station, always stepping to the
  // unvisited neighbour furthest east, which traces a corridor rather than
  // wandering into a branch.
  while (remaining.size) {
    let start = null;
    for (const id of remaining) {
      if (!start || (byId.get(id)?.x ?? 0) < (byId.get(start)?.x ?? 0)) start = id;
    }

    const lane = [];
    let current = start;
    while (current && remaining.has(current)) {
      lane.push(current);
      remaining.delete(current);
      const options = (neighbours.get(current) || []).filter((id) => remaining.has(id));
      current = options.sort((a, b) => (byId.get(a)?.x ?? 0) - (byId.get(b)?.x ?? 0)).pop() || null;
    }
    lanes.push(lane);
  }

  // Keep the longest chain on top: that is the line an operator reads first.
  lanes.sort((a, b) => b.length - a.length);

  const usableHeight = HEIGHT - 120;
  const laneCount = lanes.length;
  const gap = Math.min(LANE_GAP, laneCount > 1 ? usableHeight / (laneCount - 1) : usableHeight);
  const top = (HEIGHT - gap * Math.max(0, laneCount - 1)) / 2;

  lanes.forEach((lane, laneIndex) => {
    const y = top + laneIndex * gap;
    const span = WIDTH - MARGIN_X * 2;
    lane.forEach((id, index) => {
      geometry[id] = {
        x: MARGIN_X + (lane.length === 1 ? span / 2 : (index / (lane.length - 1)) * span),
        y,
        station: byId.get(id),
      };
    });
  });

  return { geometry, laneCount };
}
