import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, AuthExpiredError, websocketUrl } from "../api/client.js";

/**
 * The live link to the simulation.
 *
 * The console is only truthful if its connection state is truthful. The
 * previous implementation opened one socket, never listened for `close`, and
 * drove its "Live" indicator off "have we ever received a frame" -- so a
 * backend restart left a frozen board reporting itself as live.
 *
 * This hook instead:
 *   - tracks the real socket state and reports it,
 *   - reconnects with capped exponential backoff,
 *   - treats a rejected token as a sign-out rather than a retry loop,
 *   - and marks the stream stale if frames stop arriving even while the socket
 *     claims to be open.
 */

const RECONNECT_BASE_MS = 700;
const RECONNECT_MAX_MS = 15000;
/** Frames are expected every tick_interval_seconds; allow generous slack. */
const STALE_AFTER_MS = 12000;

export function useRailflowStream(token, { onAuthExpired } = {}) {
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | connecting | live | stale | offline
  const [error, setError] = useState(null);

  const socketRef = useRef(null);
  const retryRef = useRef(0);
  const timerRef = useRef(null);
  const lastFrameRef = useRef(0);
  const closedRef = useRef(false);
  const authExpiredRef = useRef(onAuthExpired);

  authExpiredRef.current = onAuthExpired;

  /** One-shot REST read, used on boot and after any mutation. */
  const refresh = useCallback(async () => {
    if (!token) return null;
    const state = await apiRequest("/state");
    setSnapshot(state);
    lastFrameRef.current = Date.now();
    return state;
  }, [token]);

  useEffect(() => {
    if (!token) {
      setSnapshot(null);
      setStatus("idle");
      return undefined;
    }

    closedRef.current = false;
    let socket = null;

    const clearTimer = () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (closedRef.current) return;
      const attempt = retryRef.current;
      retryRef.current = Math.min(attempt + 1, 8);
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      clearTimer();
      timerRef.current = window.setTimeout(connect, delay);
    };

    function connect() {
      if (closedRef.current) return;
      setStatus((current) => (current === "live" ? current : "connecting"));

      try {
        socket = new WebSocket(websocketUrl(token));
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        retryRef.current = 0;
        lastFrameRef.current = Date.now();
        setStatus("live");
        setError(null);
      };

      socket.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          // A malformed frame is not worth tearing the stream down for.
          return;
        }
        if (payload?.type !== "state_update") return;
        lastFrameRef.current = Date.now();
        setStatus("live");
        setSnapshot(payload);
      };

      socket.onerror = () => {
        // `close` always follows; recovery is handled there.
      };

      socket.onclose = (event) => {
        socketRef.current = null;
        if (closedRef.current) return;

        // 1008 is the policy close the backend sends for a token it rejects.
        if (event.code === 1008) {
          setStatus("offline");
          setError("Session is no longer valid. Sign in again.");
          authExpiredRef.current?.();
          return;
        }

        setStatus("offline");
        scheduleReconnect();
      };
    }

    connect();

    // A socket can stay open while the server stops producing. Watch the frames
    // themselves, not just the transport.
    const staleTimer = window.setInterval(() => {
      if (closedRef.current) return;
      setStatus((current) => {
        if (current !== "live") return current;
        return Date.now() - lastFrameRef.current > STALE_AFTER_MS ? "stale" : current;
      });
    }, 2000);

    return () => {
      closedRef.current = true;
      clearTimer();
      window.clearInterval(staleTimer);
      const active = socketRef.current;
      socketRef.current = null;
      if (active) {
        active.onopen = null;
        active.onmessage = null;
        active.onerror = null;
        active.onclose = null;
        active.close();
      }
    };
  }, [token]);

  /** Fire a command, then fold the response (or a fresh read) into state. */
  const send = useCallback(
    async (path, body) => {
      try {
        const result = await apiRequest(path, {
          method: "POST",
          body: body ? JSON.stringify(body) : undefined,
        });
        // Only a few endpoints return a whole snapshot; everything else returns
        // the object it changed, so re-read rather than storing a fragment.
        if (result?.simulation && result?.graph) {
          setSnapshot(result);
          lastFrameRef.current = Date.now();
        } else {
          await refresh();
        }
        return { ok: true };
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          authExpiredRef.current?.();
          return { ok: false, message: err.message };
        }
        return { ok: false, message: err.message };
      }
    },
    [refresh]
  );

  return { snapshot, status, error, refresh, send, setSnapshot };
}
