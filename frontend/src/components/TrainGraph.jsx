import { useEffect, useMemo, useRef, useState } from "react";
import { buildBases, corridorCoordinates } from "../corridor/projection.js";

/**
 * The train graph.
 *
 * A time-distance diagram: time runs left to right, position along the corridor
 * runs top to bottom. It is the oldest and still the most useful railway
 * drawing there is -- the slope of a line is a train's speed, a flat run is a
 * dwell, and two lines that touch are two trains meeting.
 *
 * Every point here is observed. The console records the position it was told on
 * each tick and draws the trace; nothing is modelled, extrapolated or invented.
 * Before enough ticks have arrived the panel says so rather than drawing a line
 * through two points and implying history it does not have.
 */

const HISTORY_TICKS = 260;
const HEIGHT = 132;
const PAD = { top: 10, right: 12, bottom: 16, left: 46 };

const STATUS_CLASS = {
  moving: "is-moving",
  dwelling: "is-dwelling",
  stopped: "is-stopped",
  scheduled: "is-scheduled",
  arrived: "is-arrived",
};

export default function TrainGraph({ trains, edges, stations, simulation, selectedTrain, onSelectTrain }) {
  const historyRef = useRef(new Map());
  const [, forceRender] = useState(0);
  const [cursor, setCursor] = useState(null);
  const [width, setWidth] = useState(920);
  const shellRef = useRef(null);

  // Positions come from the same projection the corridor view uses, so the
  // graph's vertical axis and the 3D layout agree about where a station sits.
  const corridor = useCorridorAxis(stations);

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tick = simulation?.tick ?? 0;
  const edgeById = useMemo(() => new Map((edges || []).map((edge) => [edge.id, edge])), [edges]);

  // Record one sample per train per tick.
  useEffect(() => {
    if (!trains?.length || !corridor.ready) return;
    const history = historyRef.current;
    let changed = false;

    for (const train of trains) {
      const position = corridor.positionOf(train, edgeById);
      if (position === null) continue;
      let series = history.get(train.id);
      if (!series) {
        series = [];
        history.set(train.id, series);
      }
      const last = series[series.length - 1];
      if (!last || last.tick !== tick) {
        series.push({ tick, position, status: train.status, speed: train.current_speed });
        if (series.length > HISTORY_TICKS) series.shift();
        changed = true;
      }
    }

    for (const id of [...history.keys()]) {
      if (!trains.some((train) => train.id === id)) {
        history.delete(id);
        changed = true;
      }
    }

    if (changed) forceRender((n) => n + 1);
  }, [trains, tick, edgeById, corridor]);

  // A reset rewinds the clock; the old trace no longer belongs to this run.
  const previousTick = useRef(tick);
  useEffect(() => {
    if (tick < previousTick.current) historyRef.current.clear();
    previousTick.current = tick;
  }, [tick]);

  const history = historyRef.current;
  const samples = [...history.values()];
  const totalSamples = samples.reduce((sum, series) => sum + series.length, 0);

  const ticks = samples.flatMap((series) => series.map((point) => point.tick));
  const minTick = ticks.length ? Math.min(...ticks) : 0;
  const maxTick = ticks.length ? Math.max(...ticks, tick) : tick;
  const span = Math.max(1, maxTick - minTick);

  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const toX = (t) => PAD.left + ((t - minTick) / span) * plotWidth;
  const toY = (p) => PAD.top + p * plotHeight;

  const cursorTick = cursor === null ? null : minTick + (cursor / plotWidth) * span;

  function onMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width - PAD.left;
    setCursor(Math.max(0, Math.min(plotWidth, x)));
  }

  const readout =
    cursorTick === null
      ? null
      : samples
          .map((series, index) => {
            const id = [...history.keys()][index];
            const point = nearestSample(series, cursorTick);
            return point ? { id, ...point } : null;
          })
          .filter(Boolean)
          .sort((a, b) => a.position - b.position);

  return (
    <section className="train-graph" ref={shellRef} aria-label="Train graph">
      <header className="train-graph-head">
        <h2>Train graph</h2>
        <p>
          Observed positions, west at the top. Slope is speed; a flat run is a dwell; lines that
          meet are trains passing.
        </p>
        {cursorTick !== null && (
          <span className="train-graph-cursor">T+{Math.round(cursorTick)} min</span>
        )}
      </header>

      {totalSamples < 4 ? (
        <p className="train-graph-empty">
          Recording. The graph draws once several ticks of real positions have arrived from the
          simulation &mdash; it plots observed history, so it starts empty on a fresh run.
        </p>
      ) : (
        <svg
          className="train-graph-plot"
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          role="img"
          aria-label={`Time distance graph of ${samples.length} trains over ${span} simulated minutes`}
          onMouseMove={onMove}
          onMouseLeave={() => setCursor(null)}
        >
          {corridor.markers.map((marker) => (
            <g key={marker.id} className="graph-station">
              <line x1={PAD.left} x2={width - PAD.right} y1={toY(marker.position)} y2={toY(marker.position)} />
              <text x={PAD.left - 6} y={toY(marker.position) + 3}>
                {marker.id}
              </text>
            </g>
          ))}

          {[...history.entries()].map(([id, series]) => {
            if (series.length < 2) return null;
            const train = trains.find((item) => item.id === id);
            const selected = selectedTrain?.id === id;
            const d = series
              .map((point, index) => `${index === 0 ? "M" : "L"}${toX(point.tick).toFixed(1)},${toY(point.position).toFixed(1)}`)
              .join(" ");
            return (
              <path
                key={id}
                d={d}
                className={`graph-trace ${STATUS_CLASS[train?.status] || ""} ${selected ? "is-selected" : ""}`}
                onClick={() => onSelectTrain?.(id)}
              >
                <title>{`${id}${train ? ` – ${train.type} to ${train.destination}` : ""}`}</title>
              </path>
            );
          })}

          {cursor !== null && (
            <line className="graph-cursor" x1={PAD.left + cursor} x2={PAD.left + cursor} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
          )}
        </svg>
      )}

      {readout && readout.length > 0 && (
        <ul className="train-graph-readout">
          {readout.slice(0, 6).map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onSelectTrain?.(item.id)}>
                <span className="mono">{item.id}</span>
                <span className="mono">{Math.round(item.speed)} km/h</span>
                <span>{item.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function nearestSample(series, targetTick) {
  if (!series.length) return null;
  let best = series[0];
  let bestGap = Math.abs(series[0].tick - targetTick);
  for (const point of series) {
    const gap = Math.abs(point.tick - targetTick);
    if (gap < bestGap) {
      best = point;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The vertical axis: corridor position, taken from the same Mercator projection
 * the 3D view uses, so a station sits at the same relative place in both.
 */
function useCorridorAxis(stations) {
  const state = useMemo(() => {
    if (!stations?.length) return { ready: false, markers: [], coords: {} };
    const bases = buildBases(stations);
    const coords = corridorCoordinates(bases.geographic, bases.order);
    // Label the places an operator navigates by, thinned so they never collide.
    const markers = stations
      .filter((station) => station.type === "terminal" || station.type === "junction")
      .map((station) => ({ id: station.id, position: coords[station.id] }))
      .sort((a, b) => a.position - b.position)
      .filter((marker, index, list) => index === 0 || marker.position - list[index - 1].position > 0.075);
    return { ready: true, markers, coords };
  }, [stations]);

  return useMemo(
    () => ({
      ...state,
      positionOf(train, edgeById) {
        const coords = state.coords;
        if (!coords) return null;
        if (train.on_edge && train.current_node && train.next_node) {
          const from = coords[train.current_node];
          const to = coords[train.next_node];
          if (from === undefined || to === undefined) return null;
          const progress = Math.max(0, Math.min(1, train.edge_progress || 0));
          return from + (to - from) * progress;
        }
        const node = train.current_node || train.source;
        const value = coords[node];
        return value === undefined ? null : value;
      },
    }),
    [state]
  );
}
