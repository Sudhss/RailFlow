export default function StatusPill({ value }) {
  return <span className={`status-pill ${String(value || "unknown").toLowerCase()}`}>{value || "unknown"}</span>;
}
