const LABELS = {
  moving: "Running",
  dwelling: "Dwell",
  stopped: "Held",
  scheduled: "Booked",
  arrived: "Arrived",
};

const HOLD_REASONS = {
  track_blocked: "track blocked ahead",
  route_unavailable: "no route available",
  agent_hold: "held by the controller",
  agent_capacity_relief: "held to clear capacity",
  emergency_halt: "emergency halt",
  corridor_halt: "corridor halt",
};

/**
 * State is carried by a word first and a colour second, so the board stays
 * readable without relying on colour alone. A held train also says who held it:
 * a dispatcher stop and a system hold are released differently.
 */
export default function StatusPill({ value, held, reason }) {
  const status = String(value || "unknown");
  const label = LABELS[status] || status;
  const cause = held ? HOLD_REASONS[reason] || reason : null;
  const title = status === "stopped" ? (cause ? `Held: ${cause}` : "Held by a dispatcher") : label;

  return (
    <span className={`pill pill--${status}`} title={title}>
      {label}
      {status === "stopped" && <i className={held ? "pill-mark pill-mark--system" : "pill-mark"} aria-hidden="true" />}
      <span className="sr-only">{title}</span>
    </span>
  );
}
