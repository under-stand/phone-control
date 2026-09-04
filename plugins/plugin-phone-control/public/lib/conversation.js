function messageFingerprint(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function eventTime(event) {
  return new Date(event?.at || event?.updatedAt).getTime();
}

function eventOrigin(event) {
  return event?.origin || event?.source || "unknown";
}

function turnClosed(turn) {
  return turn?.events.some((event) => ["turn_complete", "session_end", "error", "aborted"].includes(event.kind));
}

export function conversationTurnStatus(turn, { result = null, historical = false } = {}) {
  let status = "working";
  let terminal = false;
  for (const event of turn?.events || []) {
    if (["turn_complete", "session_end", "error", "aborted"].includes(event.kind)) {
      status = event.kind === "turn_complete" ? "idle"
        : event.kind === "session_end" ? "completed"
          : event.kind;
      terminal = true;
      continue;
    }
    // Delayed Hook/rollout activity after a terminal event must not make an
    // earlier card look like it is still running.
    if (terminal) continue;
    if (["permission_request", "question"].includes(event.kind)) status = "waiting";
    else if (["turn_start", "working", "activity", "tool_start"].includes(event.kind)) status = "working";
  }
  // Completed-turn metadata survives the rolling event window. When the
  // terminal event itself has already been evicted, use that metadata to keep
  // an older card from looking active. The result is deliberately consulted
  // only for a matching rendered turn (the caller binds it by turn/event id).
  if (!terminal && result?.status) {
    const resultStatus = { completed: "idle", stopped: "aborted", failed: "error" }[result.status];
    if (resultStatus) status = resultStatus;
  }
  // A session can retain a small tail of activity for an older turn after its
  // completion row has left the rolling window. Only the newest rendered turn
  // may be considered live without explicit waiting/error evidence.
  if (historical && !terminal && status === "working") status = "idle";
  return status;
}

function startsFallbackTurn(event, current) {
  if (!current || !turnClosed(current)) return false;
  return event?.kind === "turn_start"
    || (event?.kind === "phone_input_sent" && event.action === "start");
}

const TERMINAL_KINDS = new Set(["turn_complete", "session_end", "error", "aborted"]);

function sameTimestamp(left, right) {
  if (!left || !right) return false;
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function turnHasCrossSourcePrompt(turn, event, text) {
  const origin = eventOrigin(event);
  return turn.events.some((candidate) => (
    candidate.kind === "user_prompt"
    && messageFingerprint(candidate.message?.text) === text
    && eventOrigin(candidate) !== origin
    && Math.abs(eventTime(candidate) - eventTime(event)) <= 5_000
  ));
}

function addMessage(messages, event) {
  const text = event.message?.text ? String(event.message.text).trim() : "";
  if (!text) return;
  // A phone submission, its UserPromptSubmit hook, and its rollout row can
  // arrive several seconds apart while still representing one prompt in the
  // same turn. Source identity is a stronger signal than timing here. A real
  // repeated prompt from the same source remains visible as a second message.
  const origin = eventOrigin(event);
  const duplicate = messages.some((previous) => (
    messageFingerprint(previous.message) === messageFingerprint(text)
    && (previous.origin !== origin || event.kind === "assistant_message")
  ));
  if (duplicate) return;
  messages.push({
    id: event.eventId || `${event.kind}-${event.at}`,
    kind: event.kind,
    at: event.at,
    message: text,
    origin,
    phase: event.phase || null,
  });
}

export function assistantReplyGroups(turn) {
  const messages = turn?.assistantMessages || [];
  const explicitFinal = [...messages].reverse().find((message) => message.phase === "final_answer") || null;
  const finalReply = explicitFinal || (turnClosed(turn) ? messages.at(-1) || null : null);
  return {
    finalReply,
    updates: finalReply ? messages.filter((message) => message !== finalReply) : [...messages],
  };
}

export function conversationTurns(events = []) {
  const ordered = [...events].sort((left, right) => {
    const delta = new Date(left.at).getTime() - new Date(right.at).getTime();
    return Number.isFinite(delta) ? delta : 0;
  });
  const turns = [];
  const byId = new Map();
  let current = null;
  let fallback = 0;
  for (const event of ordered) {
    let key = event.turnId ? String(event.turnId) : null;
    if (!key && event.kind === "user_prompt") {
      const text = messageFingerprint(event.message?.text);
      // Use every prompt event for turn matching, including a duplicate that
      // was intentionally hidden from userMessages. Otherwise hiding the Hook
      // copy can strand the later rollout copy in a false extra turn.
      const matching = text ? [...turns].reverse().find((turn) => turnHasCrossSourcePrompt(turn, event, text)) : null;
      if (matching) key = matching.id;
      else if (current && !turnClosed(current) && Math.abs(eventTime(current) - eventTime(event)) <= 60_000) key = current.id;
      else {
        fallback += 1;
        key = `prompt-${event.eventId || fallback}`;
      }
    }
    if (!key && startsFallbackTurn(event, current)) {
      fallback += 1;
      key = `turn-${event.eventId || fallback}`;
    }
    if (!key) {
      fallback += 1;
      key = current?.id || `activity-${fallback}`;
    }
    let turn = byId.get(key);
    if (!turn) {
      turn = { id: key, at: event.at, updatedAt: event.at, model: null, reasoningEffort: null, serviceTier: null, events: [], userMessages: [], assistantMessages: [] };
      byId.set(key, turn);
      turns.push(turn);
    }
    current = turn;
    turn.events.push(event);
    turn.model = event.model || turn.model;
    turn.reasoningEffort = event.reasoningEffort || turn.reasoningEffort;
    turn.serviceTier = event.serviceTier || turn.serviceTier;
    turn.updatedAt = event.at || turn.updatedAt;
    if (event.kind === "user_prompt") addMessage(turn.userMessages, event);
    if (event.kind === "assistant_message") addMessage(turn.assistantMessages, event);
  }
  return turns
    .filter((turn) => turn.userMessages.length || turn.assistantMessages.length)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

// Bind result snapshots to rendered turns using the terminal event first,
// then the turn id, timestamp, and finally chronological order. The event
// window is intentionally rolling, and older turns can have synthetic browser
// ids or lose their turn id during cross-source deduplication; relying on a
// single id would make the current session show only its newest card.
export function mapResultsToTurns(turns = [], results = []) {
  const resultByTurn = new Map();
  const byTurnId = new Map(turns.map((turn) => [String(turn.id), turn]));
  const byCompletionEventId = new Map();
  for (const turn of turns) {
    for (const event of turn.events || []) {
      if (TERMINAL_KINDS.has(event.kind) && event.eventId) {
        byCompletionEventId.set(String(event.eventId), turn);
      }
    }
  }
  const assigned = new Set();
  const matched = new Set();
  const unmatched = [];
  for (const result of Array.isArray(results) ? results : []) {
    if (!result || typeof result !== "object") continue;
    const turn = (result.completionEventId && byCompletionEventId.get(String(result.completionEventId)))
      || (result.turnId && byTurnId.get(String(result.turnId)))
      || null;
    if (turn) {
      resultByTurn.set(String(turn.id), result);
      assigned.add(String(turn.id));
      matched.add(result);
    } else {
      unmatched.push(result);
    }
  }

  // A terminal event can survive without its event id in older summaries;
  // completedAt is still emitted by the server and is stable across the
  // public/private event projection.
  for (const result of unmatched) {
    const turn = turns.find((candidate) => !assigned.has(String(candidate.id))
      && (candidate.events || []).some((event) => TERMINAL_KINDS.has(event.kind) && sameTimestamp(event.at, result.completedAt)));
    if (!turn) continue;
    resultByTurn.set(String(turn.id), result);
    assigned.add(String(turn.id));
    matched.add(result);
  }

  // Last-resort pairing keeps legacy payloads useful when both ids and exact
  // timestamps are missing. Results are oldest-first while turns are newest-
  // first, so reverse the turns before pairing.
  const remainingResults = unmatched.filter((result) => !matched.has(result));
  const remainingTurns = [...turns].reverse().filter((turn) => !assigned.has(String(turn.id)) && turnClosed(turn));
  remainingResults.forEach((result, index) => {
    const turn = remainingTurns[index];
    if (!turn) return;
    resultByTurn.set(String(turn.id), result);
    assigned.add(String(turn.id));
  });
  return resultByTurn;
}
