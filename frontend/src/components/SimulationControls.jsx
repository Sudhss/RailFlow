import { AlertTriangle, Gauge, Pause, Play, RotateCcw, TimerReset } from "lucide-react";
import { useState } from "react";

const SPEEDS = [
  { label: "0.5x", seconds: 2 },
  { label: "1x", seconds: 1 },
  { label: "2x", seconds: 0.5 },
  { label: "4x", seconds: 0.25 }
];

const SCENARIOS = [
  { label: "Mixed Peak", value: "mixed_peak" },
  { label: "Single Express", value: "single_express" },
  { label: "Bareilly Closure", value: "bareilly_closure" },
  { label: "Kanpur Pressure", value: "kanpur_pressure" }
];

export default function SimulationControls({ simulation, canDispatch, canAdmin, onAction }) {
  const paused = simulation?.paused ?? true;
  const halted = simulation?.emergency_halt_active ?? false;
  const [scenario, setScenario] = useState("mixed_peak");
  const currentSeconds = simulation?.tick_interval_seconds || 1;

  return (
    <div className="system-card">
      <div className="section-title">
        <Gauge size={16} />
        Simulation Control
      </div>
      <div className="control-row">
        <button
          className="tool-button"
          disabled={!canDispatch || !paused}
          onClick={() => onAction("/simulation/resume")}
          title="Resume simulation"
        >
          <Play size={15} />
          Resume
        </button>
        <button
          className="tool-button"
          disabled={!canDispatch || paused}
          onClick={() => onAction("/simulation/pause")}
          title="Pause simulation"
        >
          <Pause size={15} />
          Pause
        </button>
      </div>
      <div className="scenario-row">
        <select value={scenario} disabled={!canAdmin} onChange={(event) => setScenario(event.target.value)}>
          {SCENARIOS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <button className="tool-button" disabled={!canAdmin} onClick={() => onAction("/simulation/seed", { scenario })}>
          <TimerReset size={15} />
          Seed
        </button>
        <button className="tool-button" disabled={!canAdmin} onClick={() => onAction("/simulation/reset")}>
          <RotateCcw size={15} />
          Reset
        </button>
      </div>
      <div className="speed-row">
        <span>Tick speed</span>
        <div className="speed-buttons">
          {SPEEDS.map((speed) => (
            <button
              key={speed.label}
              className={Math.abs(currentSeconds - speed.seconds) < 0.05 ? "active" : ""}
              disabled={!canAdmin}
              onClick={() => onAction("/simulation/speed", { seconds: speed.seconds })}
            >
              {speed.label}
            </button>
          ))}
        </div>
      </div>
      <button
        className={`halt-button ${halted ? "active" : ""}`}
        disabled={!canAdmin}
        onClick={() => onAction("/simulation/emergency-halt", { active: !halted })}
      >
        <AlertTriangle size={16} />
        {halted ? "Release Emergency Halt" : "Emergency Halt"}
      </button>
    </div>
  );
}
