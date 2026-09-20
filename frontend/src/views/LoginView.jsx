import { useState } from "react";
import { AuthExpiredError } from "../api/client.js";

export default function LoginView({ onLogin, notice }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onLogin(username.trim(), password);
    } catch (err) {
      setError(
        err instanceof AuthExpiredError
          ? "Those credentials were not accepted."
          : err.message || "Sign in failed."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <section className="signin-panel">
        <p className="signin-mark">
          Rail<span>Flow</span>
        </p>
        <h1>Traffic control console</h1>
        <p className="signin-region">Delhi &ndash; Lucknow operating region</p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="operator">Operator</label>
            <input
              id="operator"
              value={username}
              autoComplete="username"
              autoFocus
              required
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="key">Access key</label>
            <input
              id="key"
              type="password"
              value={password}
              autoComplete="current-password"
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button type="submit" className="button button--accent button--block" disabled={busy}>
            {busy ? "Authenticating" : "Enter console"}
          </button>
        </form>

        {(error || notice?.message) && (
          <p className="signin-error" role="alert">
            {error || notice.message}
          </p>
        )}

        <div className="signin-accounts">
          <p>Local accounts for this build:</p>
          <ul className="mono">
            <li>admin / admin &mdash; full control</li>
            <li>dispatcher / dispatcher &mdash; trains and infrastructure</li>
            <li>viewer / viewer &mdash; read only</li>
          </ul>
        </div>
      </section>
    </main>
  );
}
