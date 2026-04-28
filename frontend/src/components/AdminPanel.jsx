import { AlertCircle, Ban, FileText, RadioTower, SlidersHorizontal, Unlock } from "lucide-react";
import { useMemo, useState } from "react";
import { canUser } from "../api/client.js";

export default function AdminPanel({ user, snapshot, selectedTrain, onAction }) {
  const canDispatch = canUser(user, "dispatcher");
  const edges = snapshot?.graph?.edges || [];
  const incidents = snapshot?.incidents || [];
  const logs = snapshot?.logs_latest || [];
  const decisionLogs = logs.filter((log) =>
    ["reroute", "reroute_queued", "reroute_applied", "network_optimized", "stop", "hold"].includes(log.type)
  );
  const selectedEdgeOptions = useMemo(() => edges.map((edge) => edge.id), [edges]);
  const [edgeId, setEdgeId] = useState("BE-PMR");
  const [speedLimit, setSpeedLimit] = useState(35);
  const [incidentType, setIncidentType] = useState("speed_restriction");
  const [logFilter, setLogFilter] = useState("all");
  const filteredLogs = logs.filter((log) => logFilter === "all" || log.type === logFilter || log.severity === logFilter);
  const filterOptions = useMemo(() => {
    const values = new Set(["all", "warning", "critical"]);
    logs.forEach((log) => values.add(log.type));
    return Array.from(values);
  }, [logs]);

  const agentDecision = snapshot?.last_agent_decision;

  return (
    <div className="admin-stack">
      <section className="system-card">
        <div className="section-title">
          <RadioTower size={16} />
          Intelligence
        </div>
        {agentDecision ? (
          <div className="decision-card">
            <div>
              <strong>{agentDecision.decision}</strong>
              <span>{agentDecision.source}</span>
            </div>
            <p>{agentDecision.train_id} under {agentDecision.reason}</p>
            <div className="decision-metrics">
              <span>Before {agentDecision.delay_before}</span>
              <span>After {agentDecision.delay_after}</span>
            </div>
          </div>
        ) : (
          <p className="muted-copy">No agent decision has been applied yet.</p>
        )}
        {selectedTrain?.last_agent_action && (
          <div className="selected-action">
            <span>Selected train action</span>
            <strong>{selectedTrain.last_agent_action.reason}</strong>
          </div>
        )}
        <div className="decision-timeline">
          {decisionLogs.slice(-5).map((log) => (
            <div key={log.id} className="timeline-row">
              <span>{log.sim_time}</span>
              <strong>{log.type}</strong>
              <em>{log.train_id || log.details?.reason || "system"}</em>
            </div>
          ))}
        </div>
      </section>

      <section className="system-card">
        <div className="section-title">
          <SlidersHorizontal size={16} />
          Track Controls
        </div>
        <div className="track-control-grid">
          <select value={edgeId} onChange={(event) => setEdgeId(event.target.value)} disabled={!canDispatch}>
            {selectedEdgeOptions.map((id) => (
              <option value={id} key={id}>
                {id}
              </option>
            ))}
          </select>
          <button className="tool-button" disabled={!canDispatch} onClick={() => onAction("/track/close", { edge_id: edgeId })}>
            <Ban size={15} />
            Close
          </button>
          <button className="tool-button" disabled={!canDispatch} onClick={() => onAction("/track/reopen", { edge_id: edgeId })}>
            <Unlock size={15} />
            Reopen
          </button>
          <button className="tool-button" disabled={!canDispatch} onClick={() => onAction("/track/remove", { edge_id: edgeId })}>
            <AlertCircle size={15} />
            Remove
          </button>
          <input
            type="number"
            value={speedLimit}
            disabled={!canDispatch}
            onChange={(event) => setSpeedLimit(Number(event.target.value))}
          />
          <button
            className="tool-button"
            disabled={!canDispatch}
            onClick={() => onAction("/track/restrict-speed", { edge_id: edgeId, speed_limit: speedLimit })}
          >
            Set Limit
          </button>
        </div>
      </section>

      <section className="system-card">
        <div className="section-title">
          <AlertCircle size={16} />
          Incidents
        </div>
        <div className="incident-form">
          <select value={incidentType} onChange={(event) => setIncidentType(event.target.value)} disabled={!canDispatch}>
            <option value="speed_restriction">speed_restriction</option>
            <option value="track_closure">track_closure</option>
            <option value="signal_failure">signal_failure</option>
            <option value="maintenance_block">maintenance_block</option>
            <option value="weather_slowdown">weather_slowdown</option>
          </select>
          <button
            className="tool-button"
            disabled={!canDispatch}
            onClick={() =>
              onAction("/incident/add", {
                type: incidentType,
                edge_id: edgeId,
                severity: incidentType === "speed_restriction" ? "warning" : "critical",
                speed_limit: incidentType === "speed_restriction" || incidentType === "weather_slowdown" ? speedLimit : null,
                note: "Dispatcher input"
              })
            }
          >
            Add Incident
          </button>
        </div>
        <div className="incident-list">
          {incidents.slice(-4).map((incident) => (
            <button
              key={incident.id}
              className={`incident-row ${incident.active ? "active" : ""}`}
              disabled={!canDispatch || !incident.active}
              onClick={() => onAction("/incident/resolve", { incident_id: incident.id })}
            >
              <span>{incident.id}</span>
              <strong>{incident.type}</strong>
              <em>{incident.edge_id}</em>
            </button>
          ))}
        </div>
      </section>

      <section className="system-card log-card">
        <div className="section-title">
          <FileText size={16} />
          Structured Logs
          <select className="log-filter" value={logFilter} onChange={(event) => setLogFilter(event.target.value)}>
            {filterOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div className="log-list">
          {filteredLogs.map((log) => (
            <div key={log.id} className={`log-row ${log.severity}`}>
              <div>
                <span>{log.sim_time}</span>
                <strong>{log.type}</strong>
              </div>
              <p>{log.message}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
