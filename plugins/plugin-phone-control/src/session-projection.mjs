import { deriveCommandProjection } from "./command-state.mjs";
import { deriveTaskInbox } from "./task-inbox.mjs";

const VISIBLE_QUEUE_STATES = new Set(["queued", "waiting", "sending", "cli_queued", "needs_review"]);

// HTTP snapshots and SSE use the same complete projection. Command recency
// and unresolved work are different facts; completing a newer command cannot
// acknowledge an older uncertain delivery.
export function projectSession(session, { queuedCommands = [], liveCommands = [], cliContinuation = null, now = Date.now() } = {}) {
  const commands = deriveCommandProjection(session, { queuedCommands, liveCommands, now });
  return {
    ...session,
    ...commands,
    cliContinuation,
    queuedCommands: queuedCommands.filter((entry) => VISIBLE_QUEUE_STATES.has(entry.status))
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || ""))),
    inbox: deriveTaskInbox(session, commands.commandState, now),
  };
}
