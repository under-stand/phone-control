// Only lifecycle/input events establish a new execution turn. Response-item
// metadata can identify a model request rather than the Codex execution turn;
// ordinary activity must never replace a turn established by its lifecycle.
const TURN_BOUNDARIES = new Set(["turn_start", "user_prompt", "phone_input_sent"]);

export function isOtherTurnActivity(session, event) {
  const turnId = session.pendingApproval?.turnId || session.turnId;
  if (!turnId || !event.turnId || turnId === event.turnId) return false;
  if (TURN_BOUNDARIES.has(event.kind)) return false;
  // Live interactions are bound and reconciled independently by request id.
  if (event.approval?.id || event.interaction?.id) return false;
  return ["session_metadata", "session_start", "assistant_message", "tool_start", "tool_end", "working", "activity", "subagent_start", "subagent_stop", "permission_request"].includes(event.kind);
}
