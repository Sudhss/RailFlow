import { useEffect, useMemo, useRef, useState } from "react";
import { canUser } from "../api/client.js";
import StatusPill from "./StatusPill.jsx";

/**
 * The train board.
 *
 * The operator's working list: what is running, where it is, how late it is,
 * and the three controls that matter for each one. Everything the original
 * board offered -- adding a train, stop, resume, system reroute, and a typed
 * manual route -- is preserved.
 */

const FALLBACK_TYPES = ["superfast", "express", "passenger", "freight", "maintenance"];

export default function Dashboard({
  user,
  trains,
  stations,
  simulation,
  selectedTrainId,
  onSelectTrain,
  onAction,
  loading,
}) {
  const canDispatch = canUser(user, "dispatcher");
  const trainTypes = simulation?.train_types?.length ? simulation.train_types : FALLBACK_TYPES;
  const stationIds = useMemo(() => (stations || []).map((station) => station.id), [stations]);

  const [form, setForm] = useState({
    id: "RF-900",
    name: "Control Extra",
    type: "express",
    source: "NDLS",
    destination: "LKO",
    scheduled_departure_tick: 0,
    max_speed: 105,
  });
  const [manualRoute, setManualRoute] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [routeSubmitting, setRouteSubmitting] = useState(false);
  const [filter, setFilter] = useState("all");

  const selectedTrain = useMemo(
    () => trains.find((train) => train.id === selectedTrainId) || null,
    [trains, selectedTrainId]
  );

  // Keep the source and destination pointing at stations that actually exist.
  useEffect(() => {
    if (!stationIds.length) return;
    setForm((current) => {
      const next = { ...current };
      if (!stationIds.includes(next.source)) next.source = stationIds[0];
      if (!stationIds.includes(next.destination)) {
        next.destination = stationIds[stationIds.length - 1];
      }
      return next;
    });
  }, [stationIds]);

  const visible = useMemo(() => {
    if (filter === "all") return trains;
    if (filter === "running") return trains.filter((t) => t.status === "moving" || t.status === "dwelling");
    if (filter === "held") return trains.filter((t) => t.status === "stopped");
    if (filter === "late") return trains.filter((t) => t.delay > 0);
    return trains;
  }, [trains, filter]);

  function updateForm(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function addTrain(event) {
    event.preventDefault();
    if (submitting) return; // A double submit would be rejected as a duplicate id.
    setSubmitting(true);
    try {
      await onAction("/train/add", {
        ...form,
        id: form.id.trim(),
        scheduled_departure_tick: Number(form.scheduled_departure_tick) || 0,
        max_speed: Number(form.max_speed) || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitManualRoute(event) {
    event.preventDefault();
    if (!selectedTrainId || routeSubmitting) return;
    const route = manualRoute
      .split(/[,\s>-]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
    if (!route.length) return;
    setRouteSubmitting(true);
    try {
      await onAction("/train/manual-route", { train_id: selectedTrainId, route });
    } finally {
      setRouteSubmitting(false);
    }
  }

  return (
    <section className="panel train-board">
      <header className="panel-head">
        <h2>Train board</h2>
        <div className="segmented" role="group" aria-label="Filter trains">
          {[
            ["all", "All"],
            ["running", "Running"],
            ["held", "Held"],
            ["late", "Late"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "is-current" : ""}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <form className="add-train" onSubmit={addTrain}>
        <div className="field">
          <label htmlFor="train-id">Number</label>
          <input
            id="train-id"
            disabled={!canDispatch}
            value={form.id}
            maxLength={32}
            onChange={(event) => updateForm("id", event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="train-type">Class</label>
          <select
            id="train-type"
            disabled={!canDispatch}
            value={form.type}
            onChange={(event) => updateForm("type", event.target.value)}
          >
            {trainTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="train-from">From</label>
          <select
            id="train-from"
            disabled={!canDispatch}
            value={form.source}
            onChange={(event) => updateForm("source", event.target.value)}
          >
            {stationIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="train-to">To</label>
          <select
            id="train-to"
            disabled={!canDispatch}
            value={form.destination}
            onChange={(event) => updateForm("destination", event.target.value)}
          >
            {stationIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--narrow">
          <label htmlFor="train-depart">Depart</label>
          <input
            id="train-depart"
            type="number"
            min="0"
            disabled={!canDispatch}
            value={form.scheduled_departure_tick}
            onChange={(event) => updateForm("scheduled_departure_tick", event.target.value)}
          />
        </div>
        <div className="field field--narrow">
          <label htmlFor="train-speed">Max km/h</label>
          <input
            id="train-speed"
            type="number"
            min="1"
            max="250"
            disabled={!canDispatch}
            value={form.max_speed}
            onChange={(event) => updateForm("max_speed", event.target.value)}
          />
        </div>
        <button type="submit" className="button button--accent" disabled={!canDispatch || submitting}>
          {submitting ? "Adding" : "Add train"}
        </button>
      </form>

      <div className="board-scroll">
        {loading ? (
          <p className="panel-note">Reading the train board from the simulation.</p>
        ) : trains.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No trains on the board</p>
            <p className="empty-body">
              Nothing is currently booked through this region, so the network view has nothing to
              follow. Seed a scenario from Simulation Control, or add a train above.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Nothing matches this filter</p>
            <p className="empty-body">
              {trains.length} train{trains.length === 1 ? " is" : "s are"} on the board, but none are
              in this state right now.
            </p>
            <button type="button" className="ghost-button" onClick={() => setFilter("all")}>
              Show all
            </button>
          </div>
        ) : (
          <table className="board">
            <caption className="sr-only">Trains currently on the board</caption>
            <thead>
              <tr>
                <th scope="col">Train</th>
                <th scope="col">Position</th>
                <th scope="col" className="num">
                  Speed
                </th>
                <th scope="col" className="num">
                  Delay
                </th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="sr-only">Control</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((train) => (
                <tr
                  key={train.id}
                  className={train.id === selectedTrainId ? "is-selected" : ""}
                  onClick={() => onSelectTrain(train.id)}
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="train-id"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectTrain(train.id);
                      }}
                    >
                      <span className="mono">{train.id}</span>
                      <span className="train-sub">
                        {train.type} &rarr; {train.destination}
                      </span>
                    </button>
                  </th>
                  <td>
                    <span className="mono">
                      {train.on_edge ? `${train.current_node}–${train.next_node}` : train.current_node}
                    </span>
                    {train.on_edge && (
                      <span className="progress" aria-hidden="true">
                        <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, train.edge_progress))})` }} />
                      </span>
                    )}
                  </td>
                  <td className="num mono">{Math.round(train.current_speed)}</td>
                  <td className={`num mono${train.delay > 15 ? " is-late" : ""}`}>{train.delay}</td>
                  <td>
                    <StatusPill value={train.status} held={train.system_held} reason={train.hold_reason} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        disabled={!canDispatch || train.status === "arrived"}
                        title={`Stop ${train.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onAction("/train/stop", { train_id: train.id });
                        }}
                      >
                        Stop
                      </button>
                      <button
                        type="button"
                        disabled={!canDispatch || train.status !== "stopped"}
                        title={`Resume ${train.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onAction("/train/resume", { train_id: train.id });
                        }}
                      >
                        Resume
                      </button>
                      <button
                        type="button"
                        disabled={!canDispatch || train.status === "arrived"}
                        title={`Ask the controller to reroute ${train.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onAction("/train/reroute", { train_id: train.id });
                        }}
                      >
                        Reroute
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form className="manual-route" onSubmit={submitManualRoute}>
        <div className="manual-route-head">
          <label htmlFor="manual-route">
            Manual route {selectedTrain ? <span className="mono">{selectedTrain.id}</span> : "— select a train"}
          </label>
          <button
            type="button"
            className="link-button"
            disabled={!selectedTrain}
            onClick={() => setManualRoute((selectedTrain?.display_route || selectedTrain?.route || []).join(" "))}
          >
            Load current
          </button>
        </div>
        <div className="manual-route-entry">
          <input
            id="manual-route"
            disabled={!canDispatch || !selectedTrainId}
            value={manualRoute}
            placeholder="NDLS DSA GZB PKW HPU MB BE LKO"
            onChange={(event) => setManualRoute(event.target.value)}
          />
          <button type="submit" className="button" disabled={!canDispatch || !selectedTrainId || routeSubmitting}>
            {routeSubmitting ? "Setting" : "Set route"}
          </button>
        </div>
        <p className="manual-route-hint">
          Station codes in order, starting from the train&rsquo;s current or next station. The route
          is rejected if a section is closed or if it passes through a station twice.
        </p>
      </form>
    </section>
  );
}
