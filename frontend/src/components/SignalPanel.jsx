import { useMemo } from "react";
import { trainPosition } from "./GraphView.jsx";

const WIDTH = 1080;
const HEIGHT = 620;

export default function SignalPanel({ stations, edges, trains, selectedTrain, onSelectTrain }) {
  const geometry = useMemo(() => buildSignalGeometry(stations), [stations]);

  return (
    <div className="signal-shell">
      <svg className="signal-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Signal diagram">
        <rect x="22" y="22" width={WIDTH - 44} height={HEIGHT - 44} rx="4" className="signal-frame" />
        <g>
          {edges.map((edge) => {
            const from = geometry[edge.from];
            const to = geometry[edge.to];
            if (!from || !to) return null;
            const midX = (from.x + to.x) / 2;
            return (
              <path
                key={edge.id}
                d={`M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`}
                className={`signal-track ${edge.congestion}`}
              />
            );
          })}
        </g>
        <g>
          {stations.map((station) => {
            const point = geometry[station.id];
            if (!point) return null;
            return (
              <g key={station.id} transform={`translate(${point.x}, ${point.y})`} className={`signal-station ${station.type}`}>
                <rect x="-14" y="-7" width="28" height="14" rx="2" />
                <text x="0" y="-14">
                  {station.id}
                </text>
              </g>
            );
          })}
        </g>
        <g>
          {trains.map((train) => {
            const point = trainPosition(train, edges, geometry);
            if (!point) return null;
            const selected = train.id === selectedTrain?.id;
            return (
              <g
                key={train.id}
                transform={`translate(${point.x}, ${point.y})`}
                className={`signal-train ${train.status} ${selected ? "selected" : ""}`}
                onClick={() => onSelectTrain(train.id)}
              >
                <rect x="-12" y="-12" width="24" height="24" rx="3" />
                <text x="16" y="4">
                  {train.id}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function buildSignalGeometry(stations) {
  const top = new Set(["NDLS", "DSA", "GZB", "PKW", "HPU", "GMS", "GJL", "AMRO", "MB", "RMU", "MIL", "BE", "PMR", "TLH", "SPN", "AJI", "HRI", "SAN", "AMG", "LKO"]);
  const bottom = new Set(["KRJ", "ALJN", "HRS", "TDL", "FZD", "SKB", "ETW", "PHD", "CNB", "ON"]);
  const center = new Set(["CH", "AO", "BEM", "KSJ", "FBD", "KJN"]);
  const lanes = {
    top: Array.from(top),
    center: Array.from(center),
    bottom: Array.from(bottom)
  };
  const geometry = {};

  for (const [lane, ids] of Object.entries(lanes)) {
    const y = lane === "top" ? 170 : lane === "center" ? 330 : 470;
    ids.forEach((id, index) => {
      geometry[id] = {
        x: 70 + index * ((WIDTH - 140) / Math.max(1, ids.length - 1)),
        y
      };
    });
  }

  for (const station of stations) {
    if (!geometry[station.id]) {
      geometry[station.id] = { x: WIDTH / 2, y: HEIGHT / 2 };
    }
  }
  return geometry;
}
