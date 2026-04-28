const API_BASE = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000/ws";

export function getStoredSession() {
  try {
    return JSON.parse(localStorage.getItem("railflow_session") || "null");
  } catch {
    return null;
  }
}

export function storeSession(session) {
  localStorage.setItem("railflow_session", JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem("railflow_session");
}

export function websocketUrl() {
  return WS_BASE;
}

export async function apiRequest(path, options = {}) {
  const session = getStoredSession();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (session?.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || "Request failed.");
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

export async function login(username, password) {
  return apiRequest("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export function canUser(user, requiredRole) {
  const levels = { viewer: 1, dispatcher: 2, admin: 3 };
  return levels[user?.role] >= levels[requiredRole];
}
