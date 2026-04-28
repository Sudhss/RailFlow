import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, LogOut, Network, PanelTop, Shield } from "lucide-react";
import { apiRequest, canUser, clearSession, getStoredSession, login, storeSession, websocketUrl } from "./api/client.js";
import LoginView from "./views/LoginView.jsx";
import SimulationControls from "./components/SimulationControls.jsx";
import Dashboard from "./components/Dashboard.jsx";
import GraphView from "./components/GraphView.jsx";
import SignalPanel from "./components/SignalPanel.jsx";
import AdminPanel from "./components/AdminPanel.jsx";

export default function App() {
  const [session, setSession] = useState(() => getStoredSession());
  const [snapshot, setSnapshot] = useState(null);
  const [selectedTrainId, setSelectedTrainId] = useState(null);
  const [activeView, setActiveView] = useState("network");
  const [notice, setNotice] = useState("");

  const user = session?.user;
  const selectedTrain = useMemo(() => {
    return snapshot?.trains?.find((train) => train.id === selectedTrainId) || snapshot?.trains?.[0] || null;
  }, [snapshot, selectedTrainId]);

  const showNotice = useCallback((message) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  }, []);

  const refreshState = useCallback(async () => {
    if (!session?.token) return;
    const state = await apiRequest("/state");
    setSnapshot(state);
  }, [session?.token]);

  useEffect(() => {
    if (session?.token) {
      refreshState().catch((error) => showNotice(error.message));
    }
  }, [session?.token, refreshState, showNotice]);

  useEffect(() => {
    if (!session?.token) return undefined;
    const socket = new WebSocket(websocketUrl());
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "state_update") {
        setSnapshot(payload);
      }
    };
    socket.onerror = () => showNotice("Live stream disconnected. Retrying on refresh.");
    return () => socket.close();
  }, [session?.token, showNotice]);

  async function handleLogin(username, password) {
    const result = await login(username, password);
    storeSession(result);
    setSession(result);
    showNotice(`Signed in as ${result.user.role}.`);
  }

  async function handleLogout() {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
    } catch {
      // Local logout is still valid if the backend is unreachable.
    }
    clearSession();
    setSession(null);
    setSnapshot(null);
  }

  async function action(path, body = null) {
    try {
      const result = await apiRequest(path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined
      });
      if (result?.simulation && result?.graph) {
        setSnapshot(result);
      } else {
        await refreshState();
      }
    } catch (error) {
      showNotice(error.message);
    }
  }

  if (!session?.token) {
    return <LoginView onLogin={handleLogin} notice={notice} />;
  }

  const stations = snapshot?.graph?.stations || [];
  const edges = snapshot?.graph?.edges || [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">RF</div>
          <div>
            <h1>RailFlow</h1>
            <p>Delhi Lucknow traffic control simulation</p>
          </div>
        </div>
        <div className="topbar-status">
          <span className="clock">{snapshot?.simulation?.sim_time || "--:--"}</span>
          <span className={`stream-dot ${snapshot ? "online" : ""}`} />
          <span>{snapshot ? "Live" : "Connecting"}</span>
          <span className="role-badge">{user?.role}</span>
          <button className="icon-button" onClick={handleLogout} title="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}

      <main className="control-grid">
        <section className="left-rail">
          <SimulationControls
            simulation={snapshot?.simulation}
            canDispatch={canUser(user, "dispatcher")}
            canAdmin={canUser(user, "admin")}
            onAction={action}
          />
          <Dashboard
            user={user}
            trains={snapshot?.trains || []}
            stations={stations}
            selectedTrainId={selectedTrain?.id}
            onSelectTrain={setSelectedTrainId}
            onAction={action}
          />
        </section>

        <section className="main-stage">
          <div className="view-tabs" role="tablist">
            <button className={activeView === "network" ? "active" : ""} onClick={() => setActiveView("network")}>
              <Network size={16} />
              Geographic Network
            </button>
            <button className={activeView === "signal" ? "active" : ""} onClick={() => setActiveView("signal")}>
              <PanelTop size={16} />
              Signal Diagram
            </button>
          </div>
          {activeView === "network" ? (
            <GraphView
              stations={stations}
              edges={edges}
              trains={snapshot?.trains || []}
              selectedTrain={selectedTrain}
              onSelectTrain={setSelectedTrainId}
            />
          ) : (
            <SignalPanel
              stations={stations}
              edges={edges}
              trains={snapshot?.trains || []}
              selectedTrain={selectedTrain}
              onSelectTrain={setSelectedTrainId}
            />
          )}
        </section>

        <section className="right-rail">
          <div className="system-card compact">
            <div className="section-title">
              <Activity size={16} />
              System State
            </div>
            <div className="metric-grid">
              <Metric label="Tick" value={snapshot?.simulation?.tick ?? 0} />
              <Metric label="Trains" value={snapshot?.trains?.length ?? 0} />
              <Metric label="Tracks" value={edges.length} />
              <Metric label="Agent" value={snapshot?.simulation?.agent_source || "heuristic"} />
            </div>
            <div className="agent-strip">
              <Shield size={15} />
              <span>Cooldown {snapshot?.simulation?.reroute_cooldown_ticks || 8} ticks</span>
            </div>
          </div>
          <AdminPanel
            user={user}
            snapshot={snapshot}
            selectedTrain={selectedTrain}
            onAction={action}
          />
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
