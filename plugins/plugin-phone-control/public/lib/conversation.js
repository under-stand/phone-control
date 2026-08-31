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

