import { useEffect, useState } from "react";

/**
 * Simulation control: run state, seed scenarios, clock rate, emergency halt.
 * The rate buttons and scenario list come from the backend snapshot so this
 * panel cannot drift out of step with what the API will actually accept.
 */

const RATES = [
  { label: "0.5x", seconds: 2 },
  { label: "1x", seconds: 1 },
  { label: "2x", seconds: 0.5 },
  { label: "4x", seconds: 0.25 },
];

const SCENARIO_LABELS = {
  mixed_peak: "Mixed peak",
  single_express: "Single express",
  bareilly_closure: "Bareilly closure",
  kanpur_pressure: "Kanpur pressure",
};

export default function SimulationControls({ simulation, canDispatch, canAdmin, onAction, busy }) {
  const paused = simulation?.paused ?? true;
  const halted = simulation?.emergency_halt_active ?? false;
  const currentSeconds = simulation?.tick_interval_seconds || 1;
  const scenarios = simulation?.scenarios?.length ? simulation.scenarios : ["mixed_peak"];

  const [scenario, setScenario] = useState(scenarios[0]);
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    if (!scenarios.includes(scenario)) setScenario(scenarios[0]);
  }, [scenarios, scenario]);

  // An unanswered confirmation should not sit armed indefinitely.
  useEffect(() => {
    if (!confirmingReset) return undefined;
    const timer = window.setTimeout(() => setConfirmingReset(false), 8000);
    return () => window.clearTimeout(timer);
  }, [confirmingReset]);

  return (
    <section className="panel sim-control">
      <header className="panel-head">
        <h2>Simulation control</h2>
        <span className={`run-state run-state--${paused ? "paused" : "running"}`}>
          {paused ? "Paused" : "Running"}
        </span>
      </header>

      <div className="control-block">
        <div className="run-buttons">
          <button
            type="button"
            className="button button--accent"
            disabled={!canDispatch || !paused || busy}
            onClick={() => onAction("/simulation/resume")}
          >
            Resume
          </button>
          <button
            type="button"
            className="button"
            disabled={!canDispatch || paused || busy}
            onClick={() => onAction("/simulation/pause")}
          >
            Pause
          </button>
        </div>

        <div className="rate-row">
          <span className="control-label" id="rate-label">
            Clock rate
          </span>
          <div className="segmented" role="group" aria-labelledby="rate-label">
            {RATES.map((rate) => {
              const active = Math.abs(currentSeconds - rate.seconds) < 0.05;
              return (
                <button
                  key={rate.label}
                  type="button"
                  className={active ? "is-current" : ""}
                  aria-pressed={active}
                  disabled={!canAdmin}
                  onClick={() => onAction("/simulation/speed", { seconds: rate.seconds })}
                >
                  {rate.label}
                </button>
              );
            })}
          </div>
        </div>
        <p className="control-hint">
          One tick is one simulated minute, delivered every{" "}
          <span className="mono">{currentSeconds.toFixed(2)}s</span>.
        </p>
      </div>

      <div className="control-block">
        <div className="field">
          <label htmlFor="scenario">Scenario</label>
          <select
            id="scenario"
            value={scenario}
            disabled={!canAdmin}
            onChange={(event) => setScenario(event.target.value)}
          >
            {scenarios.map((item) => (
              <option key={item} value={item}>
                {SCENARIO_LABELS[item] || item}
              </option>
            ))}
          </select>
        </div>
        <div className="run-buttons">
          <button
            type="button"
            className="button"
            disabled={!canAdmin || busy}
            onClick={() => onAction("/simulation/seed", { scenario })}
          >
            Seed
          </button>
          {confirmingReset ? (
            <button
              type="button"
              className="button button--danger"
              disabled={!canAdmin}
              onClick={async () => {
                setConfirmingReset(false);
                await onAction("/simulation/reset");
              }}
            >
              Confirm reset
            </button>
          ) : (
            <button
              type="button"
              className="button"
              disabled={!canAdmin || busy}
              onClick={() => setConfirmingReset(true)}
            >
              Reset
            </button>
          )}
        </div>
        {confirmingReset && (
          <p className="control-hint control-hint--warn">
            Reset clears every train, incident and log entry and returns the graph to its base
            state.{" "}
            <button type="button" className="link-button" onClick={() => setConfirmingReset(false)}>
              Cancel
            </button>
          </p>
        )}
      </div>

      <button
        type="button"
        className={`halt${halted ? " halt--active" : ""}`}
        disabled={!canAdmin}
        aria-pressed={halted}
        onClick={() => onAction("/simulation/emergency-halt", { active: !halted })}
      >
        <span className="halt-title">{halted ? "Release emergency halt" : "Emergency halt"}</span>
        <span className="halt-sub">
          {halted
            ? "Trains held by the halt resume automatically; dispatcher stops stay held."
            : "Stops every running train. Booked trains keep their departure."}
        </span>
      </button>
    </section>
  );
}
