import { useState } from "react";

export default function LoginView({ onLogin, notice }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onLogin(username, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-block login-brand">
          <div className="brand-mark">RF</div>
          <div>
            <h1>RailFlow</h1>
            <p>Railway traffic control simulation</p>
          </div>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            Operator
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label>
            Access Key
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button className="primary-button" disabled={busy}>
            {busy ? "Authenticating" : "Enter Console"}
          </button>
        </form>
        <div className="login-roles">
          <span>admin/admin</span>
          <span>dispatcher/dispatcher</span>
          <span>viewer/viewer</span>
        </div>
        {(error || notice) && <p className="login-error">{error || notice}</p>}
      </section>
    </main>
  );
}
