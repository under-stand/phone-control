const COMPLETE_STATUSES = new Set(["idle", "completed"]);
const ACTIVE_STATUSES = new Set(["working", "waiting"]);

function isUserSession(session) {
  return Boolean(session?.id && (session.taskKind ? session.taskKind === "user" : !session.hiddenFromTasks));
}

export function completionKey(session) {
  const id = session?.lastCompletedTurnId || session?.lastCompletionEventId;
  return id ? `${session.id}:${id}` : null;
}

function record(session) {
  return {
    status: session.status,
    updatedAt: session.updatedAt || null,
    completionKey: completionKey(session),
  };
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class CompletionPolicy {
  constructor({ maxRemembered = 512 } = {}) {
    this.maxRemembered = maxRemembered;
    this.sessions = new Map();
    this.notified = new Set();
    this.currentSessionId = null;
    this.currentActivityAt = 0;
  }

  seed(sessions = []) {
    this.sessions.clear();
    this.notified.clear();
    const candidates = sessions.filter(isUserSession).sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
    for (const session of candidates) {
      this.sessions.set(session.id, record(session));
      const key = completionKey(session);
      if (key && COMPLETE_STATUSES.has(session.status)) this.remember(key);
    }
    const current = candidates.find((session) => ACTIVE_STATUSES.has(session.status)) || candidates[0] || null;
    this.currentSessionId = current?.id || null;
    this.currentActivityAt = timestamp(current?.updatedAt);
  }

  observe(session) {
    if (!isUserSession(session)) return null;
    const previous = this.sessions.get(session.id);
    const next = record(session);
    this.sessions.set(session.id, next);

    const activityAt = timestamp(session.updatedAt);
    const becameActive = ACTIVE_STATUSES.has(session.status) && (!previous || !ACTIVE_STATUSES.has(previous.status));
    if (ACTIVE_STATUSES.has(session.status)
      && (session.id === this.currentSessionId || becameActive || activityAt > this.currentActivityAt)) {
      this.currentSessionId = session.id;
      this.currentActivityAt = activityAt;
    }

    if (!previous || COMPLETE_STATUSES.has(previous.status) || !COMPLETE_STATUSES.has(session.status)) return null;
    if (!next.completionKey || this.notified.has(next.completionKey)) return null;
    this.remember(next.completionKey);
    return {
      version: 1,
      sessionId: session.id,
      completionKey: next.completionKey,
      notifyUntargeted: session.id === this.currentSessionId,
      title: "Codex 本轮已完成",
      body: "打开 Phone Control 查看最后一次输出或继续会话。",
      status: session.status,
      kind: "complete",
      tag: `complete-${next.completionKey}`,
      url: `/?session=${encodeURIComponent(session.id)}`,
    };
  }

  remember(key) {
    this.notified.add(key);
    while (this.notified.size > this.maxRemembered) this.notified.delete(this.notified.values().next().value);
  }
}
