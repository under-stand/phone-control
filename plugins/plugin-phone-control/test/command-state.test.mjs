import assert from "node:assert/strict";
import { deriveCommandState, isCommandInFlight } from "../src/command-state.mjs";

const baseSession = {
  status: "working",
  statusReason: "Running tool",
  turnId: "turn-1",
  lastCompletedTurnId: null,
  pendingApproval: null,
  control: { expectedTurnId: "turn-1" },
};

export const tests = [
  {
    name: "projects queued command transport states into one lifecycle",
    run() {
      const createdAt = "2026-09-04T00:00:00.000Z";
      assert.equal(deriveCommandState(baseSession, { queuedCommands: [{ id: "queue-1", status: "queued", createdAt }] }).state, "queued");
      assert.equal(deriveCommandState(baseSession, { queuedCommands: [{ id: "queue-1", status: "waiting", waitingFor: "turn", createdAt }] }).state, "blocked");
      assert.equal(deriveCommandState(baseSession, { queuedCommands: [{ id: "queue-1", status: "sending", createdAt }] }).state, "sending");
      assert.equal(isCommandInFlight(deriveCommandState(baseSession, { queuedCommands: [{ id: "queue-1", status: "sending", createdAt }] })), true);
    },
  },
  {
    name: "projects an accepted phone instruction through running, waiting, and completed",
    run() {
      const command = { id: "phone-1", status: "delivered", turnId: "turn-1", sentAt: "2026-09-04T00:00:00.000Z" };
      assert.equal(deriveCommandState(baseSession, { liveCommands: [command] }).state, "running");
      const waiting = deriveCommandState({
        ...baseSession,
        status: "waiting",
        pendingApproval: { kind: "question", reason: "Which option?", canRespond: true },
      }, { liveCommands: [command] });
      assert.equal(waiting.state, "waiting_user");
      assert.equal(waiting.actionRequired, true);
      const completed = deriveCommandState({ ...baseSession, status: "idle", lastCompletedTurnId: "turn-1" }, { liveCommands: [command] });
      assert.equal(completed.state, "completed");
      assert.equal(completed.terminal, true);
    },
  },
  {
    name: "keeps rejected and uncertain deliveries distinguishable",
    run() {
      const rejected = deriveCommandState(baseSession, { liveCommands: [{ id: "phone-r", status: "rejected", sentAt: "2026-09-04T00:00:00Z" }] });
      const uncertain = deriveCommandState(baseSession, { liveCommands: [{ id: "phone-u", status: "delivery_unknown", sentAt: "2026-09-04T00:00:01Z" }] });
      assert.equal(rejected.state, "failed");
      assert.equal(uncertain.state, "needs_review");
      assert.match(uncertain.detail, /无法确认/);
    },
  },
  {
    name: "deduplicates delivered outbox and bridge records by command id",
    run() {
      const state = deriveCommandState(baseSession, {
        queuedCommands: [{
          id: "same-command",
          status: "delivered",
          createdAt: "2026-09-04T00:00:00Z",
          command: { id: "same-command", turnId: "turn-1", status: "delivered" },
        }],
        liveCommands: [{ id: "same-command", turnId: "turn-1", status: "delivered", deliveredAt: "2026-09-04T00:00:01Z" }],
      });
      assert.equal(state.id, "same-command");
      assert.equal(state.state, "running");
    },
  },
];
