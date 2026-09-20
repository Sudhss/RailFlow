import { useEffect, useMemo, useRef, useState } from "react";
import { CorridorScene } from "../corridor/scene.js";

/**
 * The corridor view.
 *
 * A canvas for the railway itself and a DOM layer for everything that has to be
 * readable or reachable: station names, train chips, the descent control. The
 * labels are real buttons rather than painted text, so they stay crisp, land in
 * the tab order and reach a screen reader -- and the canvas stops being the only
 * way to operate the view.
 *
 * Label positions are written straight to the elements from the render loop.
 * Routing them through React state would re-render the console sixty times a
 * second to move a few transforms.
 */

const ALTITUDE_STOPS = [
  { value: 1, label: "Diagram", hint: "Whole region, control-room geometry" },
  { value: 0.55, label: "Territory", hint: "True geography of the corridor" },
  { value: 0, label: "Rail", hint: "Track level, following the selected train" },
];

function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext("webgl2") || canvas.getContext("webgl"))
    );
  } catch {
    return false;
  }
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

export default function CorridorView({ snapshot, selectedTrain, onSelectTrain, onFallback }) {
  const stations = snapshot?.graph?.stations;
  const edges = snapshot?.graph?.edges;
  const trains = snapshot?.trains;
  const canvasRef = useRef(null);
  const shellRef = useRef(null);
  const labelLayerRef = useRef(null);
  const sceneRef = useRef(null);
  const nodesRef = useRef({ stations: new Map(), trains: new Map() });
  const selectRef = useRef(onSelectTrain);
  selectRef.current = onSelectTrain;

  const [webgl] = useState(() => supportsWebGL());
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  const [altitude, setAltitude] = useState(1);
  const [basis, setBasis] = useState(0); // 0 diagram, 1 geography
  const [stats, setStats] = useState({ calls: 0, fps: 0 });

  const routeEdgeIds = useMemo(() => {
    const route = selectedTrain?.route;
    if (!route || route.length < 2 || !edges?.length) return [];
    const bySection = new Map();
    for (const edge of edges) {
      bySection.set(`${edge.from}|${edge.to}`, edge.id);
      bySection.set(`${edge.to}|${edge.from}`, edge.id);
    }
    const ids = [];
    for (let i = 0; i < route.length - 1; i += 1) {
      const id = bySection.get(`${route[i]}|${route[i + 1]}`);
      if (id) ids.push(id);
    }
    return ids;
  }, [selectedTrain?.route, edges]);

  /* ------------------------------------------------------- scene lifecycle */

  useEffect(() => {
    if (!webgl || !canvasRef.current) return undefined;

    let scene;
    try {
      scene = new CorridorScene(canvasRef.current, {
        reducedMotion: prefersReducedMotion(),
        // Beyond 2x the extra pixels cost more than they show.
        maxPixelRatio: window.innerWidth < 900 ? 1.5 : 2,
        antialias: window.innerWidth >= 900,
      });
    } catch (err) {
      onFallback?.(err instanceof Error ? err.message : String(err));
      return undefined;
    }

    sceneRef.current = scene;

    let frames = 0;
    let since = performance.now();
    scene.onFrame = (engine) => {
      positionLabels(engine, nodesRef.current, labelLayerRef.current);
      frames += 1;
      const now = performance.now();
      if (now - since >= 1000) {
        setStats({ calls: engine.renderer.info.render.calls, fps: Math.round((frames * 1000) / (now - since)) });
        frames = 0;
        since = now;
      }
    };

    const shell = shellRef.current;
    const resize = () => {
      if (!shell) return;
      const rect = shell.getBoundingClientRect();
      scene.resize(rect.width, rect.height);
    };
    resize();

    const observer = new ResizeObserver(resize);
    if (shell) observer.observe(shell);

    // Stop rendering when the view cannot be seen. A hidden tab or a scrolled
    // -away canvas should not hold the GPU.
    let onScreen = true;
    const visibility = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        if (onScreen && !document.hidden) scene.start();
        else scene.stop();
      },
      { threshold: 0.01 }
    );
    if (shell) visibility.observe(shell);

    const onVisibility = () => {
      if (document.hidden || !onScreen) scene.stop();
      else scene.start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onMotionChange = (event) => {
      setReduced(event.matches);
      scene.reducedMotion = event.matches;
    };
    motionQuery?.addEventListener?.("change", onMotionChange);

    scene.start();

    return () => {
      motionQuery?.removeEventListener?.("change", onMotionChange);
      document.removeEventListener("visibilitychange", onVisibility);
      visibility.disconnect();
      observer.disconnect();
      scene.onFrame = null;
      scene.dispose();
      sceneRef.current = null;
      for (const map of [nodesRef.current.stations, nodesRef.current.trains]) {
        for (const node of map.values()) node.remove();
        map.clear();
      }
    };
  }, [webgl, onFallback]);

  /* ---------------------------------------------------------- data plumbing */

  // Topology only: rebuilding track geometry is expensive, so it is keyed on
  // the station and section identities rather than on every snapshot.
  const topologyKey = useMemo(() => {
    if (!stations?.length || !edges?.length) return "";
    return `${stations.map((s) => s.id).join(",")}|${edges.map((e) => e.id).join(",")}`;
  }, [stations, edges]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !stations?.length || !edges?.length) return;
    scene.setNetwork(stations, edges);
  }, [topologyKey, stations, edges]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !snapshot) return;
    scene.update(snapshot);
    syncLabelNodes(stations, trains, nodesRef.current, labelLayerRef.current, selectRef);
  }, [snapshot, stations, trains]);

  useEffect(() => {
    sceneRef.current?.setSelection(selectedTrain?.id || null, routeEdgeIds);
  }, [selectedTrain?.id, routeEdgeIds]);

  useEffect(() => {
    sceneRef.current?.setAltitude(altitude);
  }, [altitude]);

  useEffect(() => {
    sceneRef.current?.setBasis(basis);
  }, [basis]);

  /* -------------------------------------------------------------- keyboard */

  function onKeyDown(event) {
    const scene = sceneRef.current;
    if (!scene) return;
    const step = event.shiftKey ? 0.25 : 0.1;

    switch (event.key) {
      case "ArrowUp":
        setAltitude((a) => Math.min(1, a + step));
        break;
      case "ArrowDown":
        setAltitude((a) => Math.max(0, a - step));
        break;
      case "ArrowLeft":
        scene.setOrbit(-0.18);
        break;
      case "ArrowRight":
        scene.setOrbit(0.18);
        break;
      case "g":
      case "G":
        setBasis((b) => (b > 0.5 ? 0 : 1));
        break;
      case "Home":
        setAltitude(1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  if (!webgl) {
    return (
      <div className="corridor-shell corridor-shell--fallback" role="status">
        <p className="fallback-title">The corridor view needs WebGL</p>
        <p className="fallback-body">
          This browser did not provide a WebGL context, so the three-dimensional corridor cannot be
          drawn. Every train position, section state and route is still available on the Geographic
          Network and Signal Diagram tabs, and on the train board.
        </p>
      </div>
    );
  }

  const stop = ALTITUDE_STOPS.reduce((best, item) =>
    Math.abs(item.value - altitude) < Math.abs(best.value - altitude) ? item : best
  );

  return (
    <div className="corridor-shell" ref={shellRef}>
      <canvas
        ref={canvasRef}
        className="corridor-canvas"
        tabIndex={0}
        role="application"
        aria-label="Corridor view. Arrow up and down change altitude, left and right rotate, G switches between the diagram and true geography."
        onKeyDown={onKeyDown}
      />
      <div className="corridor-labels" ref={labelLayerRef} aria-hidden="true" />

      <div className="corridor-hud">
        <div className="descent" role="group" aria-label="Descent">
          <label className="descent-label" htmlFor="corridor-altitude">
            <span className="descent-name">{stop.label}</span>
            <span className="descent-hint">{stop.hint}</span>
          </label>
          <input
            id="corridor-altitude"
            className="descent-slider"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={altitude}
            onChange={(event) => setAltitude(Number(event.target.value))}
            aria-valuetext={stop.label}
          />
          <div className="descent-stops">
            {ALTITUDE_STOPS.map((item) => (
              <button
                key={item.label}
                type="button"
                className={Math.abs(item.value - altitude) < 0.06 ? "is-current" : ""}
                onClick={() => setAltitude(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="basis-switch" role="group" aria-label="Coordinate basis">
          <button
            type="button"
            className={basis < 0.5 ? "is-current" : ""}
            onClick={() => setBasis(0)}
            aria-pressed={basis < 0.5}
          >
            Diagram
          </button>
          <button
            type="button"
            className={basis >= 0.5 ? "is-current" : ""}
            onClick={() => setBasis(1)}
            aria-pressed={basis >= 0.5}
          >
            Geography
          </button>
        </div>
      </div>

      <p className="corridor-stats" aria-hidden="true">
        <span>{stats.fps} fps</span>
        <span>{stats.calls} draw calls</span>
        {reduced && <span>reduced motion</span>}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- label layer */

function syncLabelNodes(stations, trains, nodes, layer, selectRef) {
  if (!layer) return;

  const wanted = new Set();
  for (const station of stations || []) {
    wanted.add(`s:${station.id}`);
    if (!nodes.stations.has(station.id)) {
      const el = document.createElement("span");
      el.className = `corridor-label corridor-label--station is-${station.type}`;
      el.textContent = station.id;
      el.title = station.name;
      layer.appendChild(el);
      nodes.stations.set(station.id, el);
    }
  }

  for (const train of trains || []) {
    wanted.add(`t:${train.id}`);
    if (!nodes.trains.has(train.id)) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "corridor-label corridor-label--train";
      el.addEventListener("click", () => selectRef.current?.(train.id));
      layer.appendChild(el);
      nodes.trains.set(train.id, el);
    }
    const el = nodes.trains.get(train.id);
    el.dataset.status = train.status;
    el.textContent = train.id;
  }

  for (const [id, el] of nodes.stations) {
    if (!wanted.has(`s:${id}`)) {
      el.remove();
      nodes.stations.delete(id);
    }
  }
  for (const [id, el] of nodes.trains) {
    if (!wanted.has(`t:${id}`)) {
      el.remove();
      nodes.trains.delete(id);
    }
  }
}

/**
 * Project and place every label. Runs inside the render loop, so it writes
 * transforms directly and never touches React state.
 */
function positionLabels(scene, nodes, layer) {
  if (!layer) return;

  // At altitude only the junctions and terminals are named; descending brings
  // in the intermediate stations, the way a map reveals detail as you zoom.
  const detail = 1 - scene.altitude;
  for (const projected of scene.stationScreenPositions()) {
    const el = nodes.stations.get(projected.id);
    if (!el) continue;
    const type = projected.station.type;
    const major = type === "terminal" || type === "junction" || type === "major";
    const show = major || detail > 0.35;
    el.style.display = show ? "" : "none";
    if (!show) continue;
    el.style.transform = `translate3d(${projected.x.toFixed(1)}px, ${projected.y.toFixed(1)}px, 0)`;
  }

  for (const projected of scene.trainScreenPositions()) {
    const el = nodes.trains.get(projected.id);
    if (!el) continue;
    el.style.transform = `translate3d(${projected.x.toFixed(1)}px, ${projected.y.toFixed(1)}px, 0)`;
    el.dataset.selected = projected.id === scene.selectedTrainId ? "true" : "false";
    el.style.display = "";
  }

  for (const [id, el] of nodes.trains) {
    const stillThere = scene.motions.has(id);
    if (!stillThere) el.style.display = "none";
  }
}
