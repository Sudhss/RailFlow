/**
 * RailFlow API client.
 *
 * The backend runs locally and keeps sessions in memory, so a restart silently
 * invalidates every token. Everything here is built around that: errors are
 * normalised into something a dispatcher can act on, and an expired session is
 * reported as such rather than surfacing as a generic failure on a console that
 * still looks signed in.
 */

const DEFAULT_HOST = "127.0.0.1:8000";

/**
 * The API host. Overridable at build time with VITE_API_HOST so the console can
 * point at a backend on another machine without editing source.
 */
const API_HOST = import.meta.env?.VITE_API_HOST || DEFAULT_HOST;
const SECURE = typeof window !== "undefined" && window.location?.protocol === "https:";

export const API_BASE = `${SECURE ? "https" : "http"}://${API_HOST}`;
const WS_BASE = `${SECURE ? "wss" : "ws"}://${API_HOST}/ws`;

const SESSION_KEY = "railflow_session";

/** Raised when the backend rejects our token. Callers sign the operator out. */
export class AuthExpiredError extends Error {
  constructor(message = "Session expired.") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Anything can end up in localStorage. Only trust a well-formed session.
    if (!parsed || typeof parsed.token !== "string" || !parsed.token) return null;
    if (!parsed.user || typeof parsed.user.role !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // A full or unavailable store is not fatal; the session stays in memory.
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function websocketUrl(token) {
  return `${WS_BASE}?token=${encodeURIComponent(token || "")}`;
}

/**
 * FastAPI returns `detail` as a string for our own errors and as a list of
 * field objects for schema violations. Flatten both into one readable line.
 */
function readDetail(payload, fallback) {
  const detail = payload?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;

  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        const field = Array.isArray(item?.loc) ? item.loc[item.loc.length - 1] : null;
        const message = typeof item?.msg === "string" ? item.msg : null;
        if (field && message) return `${field}: ${message}`;
        return message || null;
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }

  return fallback;
}

export async function apiRequest(path, options = {}) {
  const session = getStoredSession();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(
      "Cannot reach the RailFlow backend. Check that it is running on " + API_BASE + ".",
      0
    );
  }

  if (response.status === 401) {
    throw new AuthExpiredError("Session is no longer valid. Sign in again.");
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(
      readDetail(payload, response.statusText || "The request failed."),
      response.status
    );
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

export async function login(username, password) {
  return apiRequest("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

/** Confirm a stored token is still live. Used on boot, before trusting it. */
export async function verifySession() {
  return apiRequest("/auth/me");
}

const ROLE_LEVELS = { viewer: 1, dispatcher: 2, admin: 3 };

export function canUser(user, requiredRole) {
  const have = ROLE_LEVELS[user?.role] ?? 0;
  const need = ROLE_LEVELS[requiredRole] ?? Infinity;
  return have >= need;
}
