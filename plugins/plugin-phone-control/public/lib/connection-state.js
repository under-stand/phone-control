/**
 * Small, explicit connection state machine for the mobile dashboard.
 *
 * The UI has two independent ways to learn about the machine: the SSE stream
 * (live events) and the HTTP session snapshot (a usable, but less fresh,
 * fallback). Keeping their timestamps together prevents a stale stream from
 * being shown as healthy and makes background/foreground recovery predictable.
 */

export const CONNECTION_PHASES = Object.freeze([
  "connecting",
  "online",
  "synced",
  "paused",
  "offline",
]);

const DEFAULT_STATE = Object.freeze({
  phase: "connecting",
  transport: "none",
  attempt: 0,
  lastStreamEventAt: 0,
  lastSyncAt: 0,
  lastTransitionAt: 0,
  lastError: null,
  backgroundedAt: 0,
});

function finiteTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safePhase(value) {
  return CONNECTION_PHASES.includes(value) ? value : "connecting";
}

export function createConnectionState({ now = Date.now() } = {}) {
  return { ...DEFAULT_STATE, lastTransitionAt: now };
}

export function isStreamHealthy(state, { now = Date.now(), maxAgeMs = 36_000 } = {}) {
  const lastStreamEventAt = finiteTimestamp(state?.lastStreamEventAt);
  return Boolean(
    state?.phase === "online"
      && state?.transport === "sse"
      && lastStreamEventAt
      && now - lastStreamEventAt <= maxAgeMs,
  );
}

export function reduceConnectionState(previous, event = {}, { now = Date.now(), httpFreshMs = 20_000 } = {}) {
  const current = { ...DEFAULT_STATE, ...(previous || {}) };
  const next = { ...current, lastTransitionAt: now };
  const type = event.type || "noop";

  switch (type) {
    case "connect_start":
    case "manual_reconnect":
      next.phase = "connecting";
      next.transport = "none";
      next.attempt = current.attempt + 1;
      next.lastStreamEventAt = now;
      next.lastError = null;
      next.backgroundedAt = 0;
      break;
    case "stream_open":
      next.phase = "connecting";
      next.transport = "sse";
      next.lastStreamEventAt = now;
      next.lastError = null;
      break;
    case "stream_snapshot":
      next.phase = "online";
      next.transport = "sse";
      next.lastStreamEventAt = now;
      next.lastSyncAt = now;
      next.lastError = null;
      next.backgroundedAt = 0;
      break;
    case "stream_activity":
      next.lastStreamEventAt = now;
      next.lastSyncAt = now;
      if (current.phase !== "paused" && current.transport === "sse" && current.phase !== "online") {
        next.phase = "connecting";
      }
      break;
    case "http_sync_ok":
      next.lastSyncAt = now;
      if (current.phase !== "paused" && !isStreamHealthy(current, { now, maxAgeMs: httpFreshMs })) {
        next.phase = "synced";
        next.transport = "http";
      }
      next.lastError = null;
      break;
    case "stream_stale":
    case "stream_error": {
      next.transport = "none";
      next.lastError = event.error ? String(event.error).slice(0, 300) : null;
      const syncAge = next.lastSyncAt ? now - next.lastSyncAt : Number.POSITIVE_INFINITY;
      next.phase = syncAge <= httpFreshMs ? "synced" : "connecting";
      break;
    }
    case "http_sync_error":
      next.lastError = event.error ? String(event.error).slice(0, 300) : null;
      if (current.phase !== "paused") next.phase = "connecting";
      break;
    case "background":
      next.phase = "paused";
      next.transport = "none";
      next.backgroundedAt = now;
      break;
    case "foreground":
      if (current.phase === "paused") {
        next.phase = "connecting";
        next.transport = "none";
      }
      next.backgroundedAt = 0;
      break;
    case "view":
      next.phase = safePhase(event.phase);
      if (event.transport) next.transport = String(event.transport);
      break;
    case "noop":
      break;
    default:
      return reduceConnectionState(current, { type: "noop" }, { now, httpFreshMs });
  }

  next.lastStreamEventAt = finiteTimestamp(next.lastStreamEventAt);
  next.lastSyncAt = finiteTimestamp(next.lastSyncAt);
  next.backgroundedAt = finiteTimestamp(next.backgroundedAt);
  next.attempt = Math.max(0, Number(next.attempt) || 0);
  return next;
}
