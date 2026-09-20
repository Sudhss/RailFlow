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

// Three named heights on one continuous descent. The labels name a scale of
// railway, not a rendering mode -- whichever coordinate basis is showing, these
// mean the same thing.
const ALTITUDE_STOPS = [
  { value: 1, label: "Region", hint: "The whole Delhi – Lucknow operating region" },
  { value: 0.5, label: "Route", hint: "One train's route end to end" },
  { value: 0, label: "Section", hint: "One train, its section and the line ahead" },
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
  // Callbacks and per-tick data are held in refs, not in effect dependencies.
  // The console re-renders on every snapshot, so anything captured by identity
  // would tear the WebGL scene down and rebuild it once a second -- which
  // exhausts the browser's context budget and eventually loses the context
  // outright.
  const selectRef = useRef(onSelectTrain);
  selectRef.current = onSelectTrain;
  const fallbackRef = useRef(onFallback);
  fallbackRef.current = onFallback;
  const dataRef = useRef({ stations, edges, snapshot });
  dataRef.current = { stations, edges, snapshot };

  const [webgl] = useState(() => supportsWebGL());
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  const [altitude, setAltitude] = useState(1);
  const [basis, setBasis] = useState(0); // 0 diagram, 1 geography
  const [stats, setStats] = useState({ calls: 0, fps: 0, grid: 0 });
  // Bumping this tears the engine down and builds a new one, which is how the
  // view recovers from the GPU taking its context away.
  const [generation, setGeneration] = useState(0);
  const [contextLost, setContextLost] = useState(false);

  const routeKey = selectedTrain?.route?.join(">") || "";

  // Topology only: the station and section identities, not their per-tick
  // array identities.
  const topologyKey = useMemo(() => {
    if (!stations?.length || !edges?.length) return "";
    return `${stations.map((s) => s.id).join(",")}|${edges.map((e) => e.id).join(",")}`;
  }, [stations, edges]);

  /* ------------------------------------------------------- scene lifecycle */

  useEffect(() => {
    if (!webgl || !canvasRef.current) return undefined;

    let scene;
    try {
      scene = new CorridorScene(canvasRef.current, {
        reducedMotion: prefersReducedMotion(),
        onContextLost: () => setContextLost(true),
        // Beyond 2x the extra pixels cost more than they show.
        maxPixelRatio: window.innerWidth < 900 ? 1.5 : 2,
        antialias: window.innerWidth >= 900,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (generation > 0) {
        // This is a rebuild after a context loss and the GPU is not ready yet.
        // That is a temporary condition, not "this browser cannot do WebGL", so
        // it keeps the retry on screen instead of abandoning the view.
        setContextLost(true);
        return undefined;
      }
      fallbackRef.current?.(message);
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
        setStats({
          calls: engine.renderer.info?.render?.calls ?? 0,
          fps: Math.round((frames * 1000) / (now - since)),
          grid: engine.gridSpacingKm || 0,
        });
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
  }, [webgl, generation]);

  /* ---------------------------------------------------------- data plumbing */

  useEffect(() => {
    const scene = sceneRef.current;
    const { stations: current, edges: currentEdges } = dataRef.current;
    if (!scene || !current?.length || !currentEdges?.length) return;
    // Keyed on the topology, never on the snapshot: rebuilding track geometry
    // is the single most expensive thing this view does, and the station and
    // section lists arrive as fresh arrays on every tick.
    scene.setNetwork(current, currentEdges);
    // `generation` is here because a rebuilt engine starts empty.
  }, [topologyKey, generation]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !snapshot) return;
    scene.update(snapshot);
    syncLabelNodes(stations, trains, nodesRef.current, labelLayerRef.current, selectRef);
  }, [snapshot, stations, trains, generation]);

  // Re-apply view state after a rebuild without making the scene effect depend
  // on values that change every tick.

  useEffect(() => {
    const { edges: currentEdges } = dataRef.current;
    const route = routeKey ? routeKey.split(">") : [];
    const ids = [];
    if (route.length > 1 && currentEdges?.length) {
      const bySection = new Map();
      for (const edge of currentEdges) {
        bySection.set(`${edge.from}|${edge.to}`, edge.id);
        bySection.set(`${edge.to}|${edge.from}`, edge.id);
      }
      for (let i = 0; i < route.length - 1; i += 1) {
        const id = bySection.get(`${route[i]}|${route[i + 1]}`);
        if (id) ids.push(id);
      }
    }
    sceneRef.current?.setSelection(selectedTrain?.id || null, ids);
  }, [selectedTrain?.id, routeKey, topologyKey, generation]);

  useEffect(() => {
    sceneRef.current?.setAltitude(altitude);
  }, [altitude, generation]);

  useEffect(() => {
    sceneRef.current?.setBasis(basis);
  }, [basis, generation]);

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
        aria-label="Corridor view. Arrow up and down change altitude between the region diagram and a single section, left and right rotate the view, and G switches between the control-room diagram and true geography."
        onKeyDown={onKeyDown}
      />
      <div className="corridor-labels" ref={labelLayerRef} aria-hidden="true" />

      {contextLost && (
        <div className="corridor-recover" role="alert">
          <p className="fallback-title">The graphics context was lost</p>
          <p className="fallback-body">
            The GPU dropped this view, usually after a driver reset or the machine waking from
            sleep. Nothing in the simulation was affected. The Geographic Network and Signal
            Diagram tabs are unaffected too.
          </p>
          <button
            type="button"
            className="button"
            onClick={() => {
              setContextLost(false);
              // The browser restores a lost context asynchronously; rebuilding
              // in the same tick usually fails and bounces straight back here.
              window.setTimeout(() => setGeneration((n) => n + 1), 350);
            }}
          >
            Rebuild the corridor
          </button>
        </div>
      )}

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
        {stats.grid > 0 && <span>grid {formatKm(stats.grid)}</span>}
        {stats.fps > 0 && <span>{stats.fps} fps</span>}
        {stats.calls > 0 && <span>{stats.calls} draw calls</span>}
        {reduced && <span>reduced motion</span>}
      </p>
    </div>
  );
}

function formatKm(km) {
  if (km >= 1) return `${km >= 10 ? Math.round(km) : km.toFixed(km % 1 ? 1 : 0)} km`;
  return `${Math.round(km * 1000)} m`;
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
