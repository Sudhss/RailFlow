import { Plus, Route, Square, StepForward } from "lucide-react";
import { useMemo, useState } from "react";
import { canUser } from "../api/client.js";
import StatusPill from "./StatusPill.jsx";

export default function Dashboard({ user, trains, stations, selectedTrainId, onSelectTrain, onAction }) {
  const canDispatch = canUser(user, "dispatcher");
  const stationOptions = useMemo(() => stations.map((station) => station.id), [stations]);
  const selectedTrain = useMemo(
    () => trains.find((train) => train.id === selectedTrainId) || trains[0] || null,
    [trains, selectedTrainId]
  );
  const [form, setForm] = useState({
    id: "RF-900",
    name: "Control Extra",
    type: "express",
    source: "NDLS",
    destination: "LKO",
    scheduled_departure_tick: 0,
    max_speed: 105
  });
  const [manualRoute, setManualRoute] = useState("");

  function updateForm(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addTrain(event) {
    event.preventDefault();
    onAction("/train/add", {
      ...form,
      scheduled_departure_tick: Number(form.scheduled_departure_tick),
      max_speed: Number(form.max_speed)
    });
  }

  function submitManualRoute(event) {
    event.preventDefault();
    if (!selectedTrainId) return;
    const route = manualRoute
      .split(/[,\s]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
    onAction("/train/manual-route", { train_id: selectedTrainId, route });
  }

  return (
    <div className="system-card train-card">
      <div className="section-title">
        <StepForward size={16} />
        Train Board
      </div>
      <form className="add-train-form" onSubmit={addTrain}>
        <input disabled={!canDispatch} value={form.id} onChange={(event) => updateForm("id", event.target.value)} />
        <select disabled={!canDispatch} value={form.type} onChange={(event) => updateForm("type", event.target.value)}>
          <option value="superfast">superfast</option>
          <option value="express">express</option>
          <option value="passenger">passenger</option>
          <option value="freight">freight</option>
          <option value="maintenance">maintenance</option>
        </select>
        <select disabled={!canDispatch} value={form.source} onChange={(event) => updateForm("source", event.target.value)}>
          {stationOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <select
          disabled={!canDispatch}
          value={form.destination}
          onChange={(event) => updateForm("destination", event.target.value)}
        >
          {stationOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <input
          disabled={!canDispatch}
          type="number"
          value={form.scheduled_departure_tick}
          onChange={(event) => updateForm("scheduled_departure_tick", event.target.value)}
          title="Departure tick"
        />
        <input
          disabled={!canDispatch}
          type="number"
          value={form.max_speed}
          onChange={(event) => updateForm("max_speed", event.target.value)}
          title="Max speed"
        />
        <button className="icon-button action" disabled={!canDispatch} title="Add train">
          <Plus size={16} />
        </button>
      </form>
      <div className="train-table-wrap">
        <table className="train-table">
          <thead>
            <tr>
              <th>Train</th>
              <th>Type</th>
              <th>Position</th>
              <th>Speed</th>
              <th>Delay</th>
              <th>Status</th>
              <th>Control</th>
            </tr>
          </thead>
          <tbody>
            {trains.map((train) => (
              <tr
                key={train.id}
                className={train.id === selectedTrainId ? "selected" : ""}
                onClick={() => onSelectTrain(train.id)}
              >
                <td>
                  <strong>{train.id}</strong>
                  <span>{train.destination}</span>
                </td>
                <td>{train.type}</td>
                <td>{train.on_edge ? `${train.current_node}-${train.next_node}` : train.current_node}</td>
                <td>{Math.round(train.current_speed)} km/h</td>
                <td>{train.delay} min</td>
                <td>
                  <StatusPill value={train.status} />
                </td>
                <td>
                  <div className="inline-actions">
                    <button
                      className="icon-button"
                      disabled={!canDispatch}
                      title="Stop train"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAction("/train/stop", { train_id: train.id });
                      }}
                    >
                      <Square size={13} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={!canDispatch}
                      title="Resume train"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAction("/train/resume", { train_id: train.id });
                      }}
                    >
                      <StepForward size={14} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={!canDispatch}
                      title="System reroute"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAction("/train/reroute", { train_id: train.id });
                      }}
                    >
                      <Route size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="manual-route-form" onSubmit={submitManualRoute}>
        <div className="manual-route-head">
          <span>Manual route for {selectedTrain?.id || "selected train"}</span>
          <button
            type="button"
            className="text-button"
            disabled={!canDispatch || !selectedTrain}
            onClick={() => setManualRoute((selectedTrain?.display_route || selectedTrain?.route || []).join(" "))}
          >
            Use current route
          </button>
        </div>
        <input
          disabled={!canDispatch || !selectedTrainId}
          value={manualRoute}
          placeholder="Station IDs separated by spaces, for example NDLS DSA GZB PKW HPU MB BE LKO"
          onChange={(event) => setManualRoute(event.target.value)}
        />
        <button className="tool-button" disabled={!canDispatch || !selectedTrainId}>
          <Route size={15} />
          Manual Route
        </button>
      </form>
    </div>
  );
}
