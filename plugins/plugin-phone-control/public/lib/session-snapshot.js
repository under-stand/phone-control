const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_BYTES = 450_000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clampText(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function compactSummary(session) {
  const copy = clone(session) || {};
  // The list endpoint already returns summaries, but keep this boundary
  // defensive so a future caller cannot put a full conversation in localStorage.
  delete copy.events;
  delete copy.transcriptPath;
  delete copy.taskResults;
  delete copy.firstUserMessage;
  delete copy.taskGoalMessage;
  delete copy.lastAssistantMessage;
  if (copy.lastMessage?.text) copy.lastMessage.text = clampText(copy.lastMessage.text, 4_000);
  if (copy.task) {
    for (const key of ["title", "autoTitle", "smartTitle", "topic", "goal", "progress", "result"]) {
      if (copy.task[key]) copy.task[key] = clampText(copy.task[key], key === "result" ? 1_000 : 500);
    }
  }
  return copy;
}

export function createSessionSnapshot(sessions = [], {
  savedAt = new Date().toISOString(),
  limit = DEFAULT_LIMIT,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const candidates = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && typeof session.id === "string" && session.id)
    .map(compactSummary)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
    .slice(0, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)));
  const snapshot = { version: 1, savedAt, sessions: candidates };
  const byteLimit = Math.max(16_000, Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES));
  while (snapshot.sessions.length > 1 && JSON.stringify(snapshot).length > byteLimit) snapshot.sessions.pop();
  return snapshot;
}

export function parseSessionSnapshot(value, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) return null;
  const savedAtMs = Date.parse(parsed.savedAt);
  const sessions = parsed.sessions
    .filter((session) => session && typeof session.id === "string" && session.id)
    .map(compactSummary);
  return {
    savedAt: Number.isFinite(savedAtMs) ? new Date(savedAtMs).toISOString() : null,
    sessions,
    stale: !Number.isFinite(savedAtMs) || now - savedAtMs > Math.max(0, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS),
  };
}
