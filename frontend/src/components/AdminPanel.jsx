import { useEffect, useMemo, useState } from "react";
import { canUser } from "../api/client.js";

/**
 * Infrastructure control and the event record.
 *
 * Section closures, speed restrictions, incidents, the controller's last
 * decision and the structured log. Every option offered here comes from the
 * snapshot, so the panel can never present a section or incident type the API
 * would reject.
 */

const DECISION_TYPES = new Set([
  "reroute",
  "reroute_queued",
  "reroute_applied",
  "network_optimized",
  "hold_released",
  "stop",
  "hold",
]);

const SEVERITIES = ["info", "warning", "critical"];

export default function AdminPanel({ user, snapshot, selectedTrain, onAction }) {
  const canDispatch = canUser(user, "dispatcher");
  const edges = useMemo(() => snapshot?.graph?.edges || [], [snapshot]);
  const incidents = snapshot?.incidents || [];
  const logs = snapshot?.logs_latest || [];
  const simulation = snapshot?.simulation;
  const decision = snapshot?.last_agent_decision;

  const incidentTypes = simulation?.incident_types?.length
    ? simulation.incident_types
    : ["speed_restriction", "track_closure", "signal_failure", "maintenance_block", "weather_slowdown"];
  const speedTypes = new Set(simulation?.speed_incident_types || ["speed_restriction", "weather_slowdown"]);

  const [edgeId, setEdgeId] = useState("");
  const [speedLimit, setSpeedLimit] = useState(35);
  const [incidentType, setIncidentType] = useState(incidentTypes[0]);
  const [logFilter, setLogFilter] = useState("all");

  // The selected section must exist. It can be removed from under us.
  useEffect(() => {
    if (!edges.length) return;
    if (!edges.some((edge) => edge.id === edgeId)) setEdgeId(edges[0].id);
  }, [edges, edgeId]);

  useEffect(() => {
    if (!incidentTypes.includes(incidentType)) setIncidentType(incidentTypes[0]);
  }, [incidentTypes, incidentType]);

  const selectedEdge = edges.find((edge) => edge.id === edgeId) || null;
  const activeIncidents = incidents.filter((incident) => incident.active);

  // A fixed filter list: deriving it from the visible log made options appear
  // and disappear as entries rolled past, which could blank the control.
  const filtered = useMemo(() => {
    if (logFilter === "all") return logs;
    if (logFilter === "decisions") return logs.filter((log) => DECISION_TYPES.has(log.type));
    return logs.filter((log) => log.severity === logFilter);
  }, [logs, logFilter]);

  function needsSpeed(type) {
    return speedTypes.has(type);
  }

  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head">
          <h2>Controller</h2>
          <span className={`tag tag--${simulation?.agent_source === "ppo" ? "ppo" : "heuristic"}`}>
            {simulation?.agent_source === "ppo" ? "PPO model" : "Heuristic"}
          </span>
        </header>

        {decision ? (
          <div className="decision">
            <p className="decision-head">
              <span className="mono">{decision.train_id}</span>
              <strong>{decision.decision}</strong>
            </p>
            <p className="decision-why">{humanReason(decision.reason)}</p>
            <dl className="decision-figures">
              <div>
                <dt>Projected before</dt>
                <dd className="mono">{decision.delay_before} min</dd>
              </div>
              <div>
                <dt>Projected after</dt>
                <dd className="mono">{decision.delay_after} min</dd>
              </div>
            </dl>
            {decision.new_route && (
              <p className="decision-route mono">{decision.new_route.join(" › ")}</p>
            )}
          </div>
        ) : (
          <div className="empty empty--inline">
            <p className="empty-title">No decision yet</p>
            <p className="empty-body">
              The controller only acts when a train is threatened by congestion, a closure or
              accumulated delay. With the corridor clear it stays out of the way.
            </p>
          </div>
        )}

        {simulation?.agent_model_error && (
          <p className="panel-note">
            {simulation.agent_model_error} Routing decisions are being made by the heuristic
            controller, which is the supported default.
          </p>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Infrastructure</h2>
        </header>

        <div className="control-block">
          <div className="field">
            <label htmlFor="section">Section</label>
            <select
              id="section"
              value={edgeId}
              disabled={!canDispatch || !edges.length}
              onChange={(event) => setEdgeId(event.target.value)}
            >
              {edges.map((edge) => (
                <option key={edge.id} value={edge.id}>
                  {edge.id}
                </option>
              ))}
            </select>
          </div>

          {selectedEdge && (
            <dl className="section-facts">
              <div>
                <dt>Length</dt>
                <dd className="mono">{selectedEdge.distance_km} km</dd>
              </div>
              <div>
                <dt>Line speed</dt>
                <dd className="mono">
                  {selectedEdge.speed_limit
                    ? `${selectedEdge.speed_limit} / ${selectedEdge.avg_speed}`
                    : selectedEdge.avg_speed}{" "}
                  km/h
                </dd>
              </div>
              <div>
                <dt>Occupancy</dt>
                <dd className="mono">
                  {selectedEdge.trains_on_edge} / {selectedEdge.capacity}
                </dd>
              </div>
              <div>
                <dt>State</dt>
                <dd className={`state state--${selectedEdge.congestion}`}>{selectedEdge.congestion}</dd>
              </div>
            </dl>
          )}

          <div className="button-row">
            <button
              type="button"
              className="button"
              disabled={!canDispatch || !selectedEdge || selectedEdge.blocked}
              onClick={() => onAction("/track/close", { edge_id: edgeId })}
            >
              Close
            </button>
            <button
              type="button"
              className="button"
              disabled={!canDispatch || !selectedEdge || !selectedEdge.blocked}
              onClick={() => onAction("/track/reopen", { edge_id: edgeId })}
            >
              Reopen
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={!canDispatch || !selectedEdge}
              onClick={() => onAction("/track/remove", { edge_id: edgeId })}
              title="Remove the section from the running graph. An occupied section is closed instead."
            >
              Remove
            </button>
          </div>

          <div className="inline-field">
            <div className="field field--narrow">
              <label htmlFor="limit">Limit km/h</label>
              <input
                id="limit"
                type="number"
                min="1"
                max="350"
                value={speedLimit}
                disabled={!canDispatch}
                onChange={(event) => setSpeedLimit(Number(event.target.value))}
              />
            </div>
            <button
              type="button"
              className="button"
              disabled={!canDispatch || !selectedEdge}
              onClick={() => onAction("/track/restrict-speed", { edge_id: edgeId, speed_limit: speedLimit })}
            >
              Restrict
            </button>
            <button
              type="button"
              className="button"
              disabled={!canDispatch || !selectedEdge?.speed_limit}
              onClick={() => onAction("/track/restrict-speed", { edge_id: edgeId, speed_limit: null })}
            >
              Clear
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Incidents</h2>
          {activeIncidents.length > 0 && <span className="tag tag--warn">{activeIncidents.length} active</span>}
        </header>

        <div className="control-block">
          <div className="inline-field">
            <div className="field">
              <label htmlFor="incident-type">Type</label>
              <select
                id="incident-type"
                value={incidentType}
                disabled={!canDispatch}
                onChange={(event) => setIncidentType(event.target.value)}
              >
                {incidentTypes.map((type) => (
                  <option key={type} value={type}>
                    {type.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="button"
              disabled={!canDispatch || !selectedEdge}
              onClick={() =>
                onAction("/incident/add", {
                  type: incidentType,
                  edge_id: edgeId,
                  severity: needsSpeed(incidentType) ? SEVERITIES[1] : SEVERITIES[2],
                  speed_limit: needsSpeed(incidentType) ? speedLimit : null,
                  note: `Raised by ${user?.username || "dispatcher"}`,
                })
              }
            >
              Raise on {edgeId || "—"}
            </button>
          </div>
          {needsSpeed(incidentType) && (
            <p className="control-hint">
              Uses the limit above (<span className="mono">{speedLimit} km/h</span>) for the affected
              section.
            </p>
          )}
        </div>

        {incidents.length === 0 ? (
          <div className="empty empty--inline">
            <p className="empty-title">No incidents recorded</p>
            <p className="empty-body">
              Closures, signal failures and speed restrictions appear here as they are raised, and
              stay listed once resolved so the run can be reviewed.
            </p>
          </div>
        ) : (
          <ul className="incident-list">
            {[...incidents].reverse().slice(0, 6).map((incident) => (
              <li key={incident.id} className={incident.active ? "is-active" : ""}>
                <div>
                  <span className="incident-type">{incident.type.replace(/_/g, " ")}</span>
                  <span className="mono incident-edge">{incident.edge_id}</span>
                  {incident.speed_limit && <span className="mono">{incident.speed_limit} km/h</span>}
                </div>
                {incident.active ? (
                  <button
                    type="button"
                    className="link-button"
                    disabled={!canDispatch}
                    onClick={() => onAction("/incident/resolve", { incident_id: incident.id })}
                  >
                    Resolve
                  </button>
                ) : (
                  <span className="incident-done">resolved</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel panel--log">
        <header className="panel-head">
          <h2>Event record</h2>
          <div className="segmented segmented--small" role="group" aria-label="Filter events">
            {[
              ["all", "All"],
              ["decisions", "Decisions"],
              ["warning", "Warning"],
              ["critical", "Critical"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={logFilter === value ? "is-current" : ""}
                aria-pressed={logFilter === value}
                onClick={() => setLogFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <ol className="log">
          {filtered.length === 0 ? (
            <li className="log-empty">
              {logs.length === 0
                ? "The record starts when the simulation does."
                : "No entries of this kind in the last 30 events."}
            </li>
          ) : (
            [...filtered].reverse().map((log) => (
              <li key={log.id} className={`log-row log-row--${log.severity}`}>
                <span className="mono log-time">{log.sim_time}</span>
                <span className="log-body">
                  {log.message}
                  {log.train_id && <span className="mono log-ref">{log.train_id}</span>}
                  {log.edge_id && <span className="mono log-ref">{log.edge_id}</span>}
                </span>
              </li>
            ))
          )}
        </ol>
      </section>

      {selectedTrain?.last_agent_action && (
        <p className="panel-note">
          Last controller action on <span className="mono">{selectedTrain.id}</span>:{" "}
          {selectedTrain.last_agent_action.decision} &mdash;{" "}
          {humanReason(selectedTrain.last_agent_action.reason)}
        </p>
      )}
    </div>
  );
}

function humanReason(reason) {
  const map = {
    high_congestion: "the booked path was over capacity",
    delay_threshold: "accumulated delay passed the intervention threshold",
    route_unavailable: "no route to the destination was available",
    capacity_relief: "a lower-priority train was held to clear a section",
    dispatcher_requested_reroute: "a dispatcher asked for a new route",
    dispatcher_selected_route: "a dispatcher set the route by hand",
    track_reopened: "a section reopened and a faster path became available",
    incident_resolved: "an incident cleared and a faster path became available",
    speed_restriction_cleared: "a speed restriction was lifted",
    hold_released: "the cause of the hold cleared",
  };
  return map[reason] || String(reason || "").replace(/_/g, " ");
}
