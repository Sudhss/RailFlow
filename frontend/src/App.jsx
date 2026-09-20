import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AuthExpiredError,
  canUser,
  clearSession,
  getStoredSession,
  login as loginRequest,
  storeSession,
  verifySession,
} from "./api/client.js";
import { useRailflowStream } from "./state/useRailflowStream.js";
import LoginView from "./views/LoginView.jsx";
import SimulationControls from "./components/SimulationControls.jsx";
import Dashboard from "./components/Dashboard.jsx";
import GraphView from "./components/GraphView.jsx";
import SignalPanel from "./components/SignalPanel.jsx";
import TrainGraph from "./components/TrainGraph.jsx";
import AdminPanel from "./components/AdminPanel.jsx";

// Three.js is most of the console's JavaScript weight and only the corridor
// view needs it. Splitting it out keeps the first paint -- sign-in, the board,
// the flat views -- off the critical path of a 3D engine.
const CorridorView = lazy(() => import("./components/CorridorView.jsx"));

const VIEWS = [
  { id: "corridor", label: "Corridor" },
  { id: "network", label: "Geographic Network" },
  { id: "signal", label: "Signal Diagram" },
];

const STREAM_TEXT = {
  idle: "Standby",
  connecting: "Acquiring",
  live: "Live",
  stale: "No data",
  offline: "Reconnecting",
};

export default function App() {
  const [session, setSession] = useState(() => getStoredSession());
  const [checkingSession, setCheckingSession] = useState(() => Boolean(getStoredSession()));
  const [selectedTrainId, setSelectedTrainId] = useState(null);
  const [activeView, setActiveView] = useState("corridor");
  const [notice, setNotice] = useState(null);
  const [corridorError, setCorridorError] = useState(null);
  // Why the operator is looking at the sign-in screen. Deliberately not a
  // toast: it must still be on screen when they come back to the tab.
  const [signOutReason, setSignOutReason] = useState(null);
  const noticeTimer = useRef(null);

  const showNotice = useCallback((message, tone = "info") => {
    if (!message) return;
    setNotice({ message, tone });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);

  // The previous console left this timer running past unmount.
  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  const signOut = useCallback((message) => {
    clearSession();
    setSession(null);
    setSelectedTrainId(null);
    setSignOutReason(message || null);
  }, []);

  const handleAuthExpired = useCallback(() => {
    signOut("The backend no longer recognises this session. Sign in again to resume control.");
  }, [signOut]);

  const { snapshot, status, refresh, send } = useRailflowStream(session?.token, {
    onAuthExpired: handleAuthExpired,
  });

  /**
   * Sessions live in the backend's memory, so a restart invalidates a token
   * that localStorage still holds. Verify before showing a console that would
   * otherwise look signed in and do nothing.
   */
  useEffect(() => {
    let cancelled = false;
    if (!session?.token) {
      setCheckingSession(false);
      return undefined;
    }
    setCheckingSession(true);
    verifySession()
      .then((user) => {
        if (cancelled) return;
        setCheckingSession(false);
        if (user?.role && user.role !== session.user?.role) {
          setSession((current) => (current ? { ...current, user } : current));
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setCheckingSession(false);
        if (error instanceof AuthExpiredError) handleAuthExpired();
        else showNotice(error.message, "warning");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token, handleAuthExpired, showNotice]);

  const user = session?.user;
  const trains = useMemo(() => snapshot?.trains || [], [snapshot]);
  const stations = useMemo(() => snapshot?.graph?.stations || [], [snapshot]);
  const edges = useMemo(() => snapshot?.graph?.edges || [], [snapshot]);

  /**
   * Keep the operator's choice. The previous board silently re-pointed the
   * selection at the first train whenever the selected one went away, which
   * meant controls could act on a train nobody had chosen.
   */
  const selectedTrain = useMemo(
    () => trains.find((train) => train.id === selectedTrainId) || null,
    [trains, selectedTrainId]
  );

  useEffect(() => {
    if (!selectedTrainId || !trains.length) return;
    if (!trains.some((train) => train.id === selectedTrainId)) {
      setSelectedTrainId(null);
      showNotice(`${selectedTrainId} is no longer on the board. Selection cleared.`, "info");
    }
  }, [trains, selectedTrainId, showNotice]);

  const action = useCallback(
    async (path, body) => {
      const result = await send(path, body);
      if (!result.ok) showNotice(result.message, "error");
      return result;
    },
    [send, showNotice]
  );

  async function handleLogin(username, password) {
    const result = await loginRequest(username, password);
    storeSession(result);
    setSession(result);
    setSignOutReason(null);
    setCheckingSession(false);
  }

  async function handleLogout() {
    try {
      await send("/auth/logout");
    } catch {
      // Signing out locally is still correct if the backend is unreachable.
    }
    signOut();
  }

  if (!session?.token) {
    return <LoginView onLogin={handleLogin} reason={signOutReason} />;
  }

  const simulation = snapshot?.simulation;
  const waiting = !snapshot;

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-identity">
          <span className="wordmark">
            Rail<span>Flow</span>
          </span>
          <span className="region">{snapshot?.graph?.name || "Delhi – Lucknow operating region"}</span>
        </div>

        <div className="masthead-readout">
          <Readout label="Sim clock" value={simulation?.sim_time || "--:--"} wide />
          <Readout label="Tick" value={simulation ? String(simulation.tick) : "–"} />
          <Readout
            label="Rate"
            value={simulation ? `${(1 / (simulation.tick_interval_seconds || 1)).toFixed(1)}x` : "–"}
          />
          <Readout label="Trains" value={trains.length ? String(trains.length) : "0"} />
        </div>

        <div className="masthead-session">
          <span className={`link link--${status}`} title={`Stream ${status}`}>
            <i aria-hidden="true" />
            {STREAM_TEXT[status] || status}
          </span>
          {simulation?.emergency_halt_active && <span className="halt-flag">Halt active</span>}
          <span className="role">{user?.role}</span>
          <button type="button" className="ghost-button" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      {notice && (
        <div className={`notice notice--${notice.tone}`} role="status">
          <span>{notice.message}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            &times;
          </button>
        </div>
      )}

      <main className="console">
        <section className="column column--left" aria-label="Operations">
          <SimulationControls
            simulation={simulation}
            canDispatch={canUser(user, "dispatcher")}
            canAdmin={canUser(user, "admin")}
            onAction={action}
            busy={waiting}
          />
          <Dashboard
            user={user}
            trains={trains}
            stations={stations}
            simulation={simulation}
            selectedTrainId={selectedTrain?.id || null}
            onSelectTrain={setSelectedTrainId}
            onAction={action}
            loading={checkingSession || waiting}
          />
        </section>

        <section className="column column--stage" aria-label="Network view">
          <div className="stage-tabs" role="tablist" aria-label="Network view">
            {VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                role="tab"
                id={`tab-${view.id}`}
                aria-selected={activeView === view.id}
                aria-controls={`panel-${view.id}`}
                className={activeView === view.id ? "is-current" : ""}
                onClick={() => setActiveView(view.id)}
              >
                {view.label}
              </button>
            ))}
          </div>

          <div
            className="stage-surface"
            role="tabpanel"
            id={`panel-${activeView}`}
            aria-labelledby={`tab-${activeView}`}
          >
            {waiting ? (
              <AcquiringState status={status} onRetry={refresh} />
            ) : activeView === "corridor" ? (
              <Suspense fallback={<BuildingCorridor />}>
                <CorridorView
                  snapshot={snapshot}
                  selectedTrain={selectedTrain}
                  onSelectTrain={setSelectedTrainId}
                  onFallback={(message) => {
                    setCorridorError(message);
                    setActiveView("network");
                    showNotice(
                      "The corridor view could not start. Switched to the Geographic Network.",
                      "warning"
                    );
                  }}
                />
              </Suspense>
            ) : activeView === "network" ? (
              <GraphView
                stations={stations}
                edges={edges}
                trains={trains}
                selectedTrain={selectedTrain}
                onSelectTrain={setSelectedTrainId}
                notice={corridorError}
              />
            ) : (
              <SignalPanel
                stations={stations}
                edges={edges}
                trains={trains}
                selectedTrain={selectedTrain}
                onSelectTrain={setSelectedTrainId}
              />
            )}
          </div>

          <TrainGraph
            trains={trains}
            edges={edges}
            stations={stations}
            simulation={simulation}
            selectedTrain={selectedTrain}
            onSelectTrain={setSelectedTrainId}
          />
        </section>

        <section className="column column--right" aria-label="Control and intelligence">
          <AdminPanel
            user={user}
            snapshot={snapshot}
            selectedTrain={selectedTrain}
            onAction={action}
          />
        </section>
      </main>

      <p className="sr-only" aria-live="polite">
        {selectedTrain
          ? `${selectedTrain.id}, ${selectedTrain.status}, ${Math.round(selectedTrain.current_speed)} kilometres per hour, ${selectedTrain.delay} minutes delay, ${
              selectedTrain.on_edge
                ? `between ${selectedTrain.current_node} and ${selectedTrain.next_node}`
                : `at ${selectedTrain.current_node}`
            }.`
          : "No train selected."}
      </p>
    </div>
  );
}

/** Shown while the corridor engine's chunk is still downloading. */
function BuildingCorridor() {
  return (
    <div className="acquiring" role="status">
      <p className="acquiring-title">Laying the corridor</p>
      <p className="acquiring-body">
        Building track geometry for the region. The flat Geographic Network and Signal Diagram tabs
        are available now.
      </p>
    </div>
  );
}

function Readout({ label, value, wide = false }) {
  return (
    <div className={`readout${wide ? " readout--wide" : ""}`}>
      <span className="readout-label">{label}</span>
      <span className="readout-value">{value}</span>
    </div>
  );
}

/**
 * The stage before the first snapshot. It says which stage of acquisition the
 * console is at rather than showing an anonymous spinner.
 */
function AcquiringState({ status, onRetry }) {
  const steps = [
    { id: "link", label: "Control link", done: status === "live" || status === "stale" },
    { id: "graph", label: "Railway graph", done: false },
    { id: "positions", label: "Train positions", done: false },
  ];

  return (
    <div className="acquiring" role="status">
      <p className="acquiring-title">
        {status === "offline" ? "Control link lost" : "Acquiring corridor state"}
      </p>
      <ol className="acquiring-steps">
        {steps.map((step) => (
          <li key={step.id} data-done={step.done}>
            {step.label}
          </li>
        ))}
      </ol>
      <p className="acquiring-body">
        {status === "offline"
          ? "The console is retrying the connection. If the backend is not running, start it with start.ps1 or python -m uvicorn backend.main:app."
          : "Waiting for the first frame from the simulation."}
      </p>
      <button type="button" className="ghost-button" onClick={() => onRetry?.()}>
        Retry now
      </button>
    </div>
  );
}
