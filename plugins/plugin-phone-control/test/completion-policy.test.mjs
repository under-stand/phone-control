import assert from "node:assert/strict";
import { CompletionPolicy, completionKey } from "../src/completion-policy.mjs";

function session(id, status, updatedAt, extra = {}) {
  return { id, status, updatedAt, taskKind: "user", ...extra };
}

export const tests = [
  {
    name: "reports every user completion while marking only the current fallback session",
    run() {
      const policy = new CompletionPolicy();
      policy.seed([
        session("older", "working", "2026-08-24T12:00:00Z"),
        session("current", "working", "2026-08-24T12:00:02Z"),
      ]);
      const older = policy.observe(session("older", "idle", "2026-08-24T12:00:03Z", { lastCompletedTurnId: "old-turn" }));
      assert.equal(older.sessionId, "older");
      assert.equal(older.notifyUntargeted, false);
      const completion = policy.observe(session("current", "idle", "2026-08-24T12:00:04Z", { lastCompletedTurnId: "current-turn" }));
      assert.equal(completion.sessionId, "current");
      assert.equal(completion.completionKey, "current:current-turn");
      assert.equal(completion.notifyUntargeted, true);
    },
  },
  {
    name: "ignores control-only repeats but accepts a real active transition across clock skew",
    run() {
      const policy = new CompletionPolicy();
      policy.seed([
        session("current", "working", "2026-08-24T12:00:05Z"),
        session("background", "working", "2026-08-24T12:00:01Z"),
      ]);
      assert.equal(policy.observe(session("background", "working", "2026-08-24T12:00:01Z")), null);
      assert.equal(policy.observe(session("current", "idle", "2026-08-24T12:00:06Z", { lastCompletedTurnId: "current-turn" })).sessionId, "current");
      assert.equal(policy.observe(session("background", "idle", "2026-08-24T12:00:06Z", { lastCompletedTurnId: "background-old" })).notifyUntargeted, false);
      assert.equal(policy.observe(session("background", "working", "2026-08-24T12:00:02Z")), null);
      assert.equal(policy.observe(session("background", "idle", "2026-08-24T12:00:03Z", { lastCompletedTurnId: "background-new" })).sessionId, "background");
    },
  },
  {
    name: "requires one stable completion identity and suppresses restart history",
    run() {
      const policy = new CompletionPolicy();
      policy.seed([session("thread", "idle", "2026-08-24T12:00:00Z", { lastCompletedTurnId: "turn-1" })]);
      assert.equal(policy.observe(session("thread", "working", "2026-08-24T12:00:01Z", { lastCompletedTurnId: "turn-1" })), null);
      assert.equal(policy.observe(session("thread", "idle", "2026-08-24T12:00:02Z", { lastCompletedTurnId: "turn-1" })), null);
      assert.equal(policy.observe(session("thread", "working", "2026-08-24T12:00:03Z")), null);
      assert.equal(policy.observe(session("thread", "idle", "2026-08-24T12:00:04Z")), null, "completion without a turn/event identity must stay silent");
      assert.equal(completionKey(session("thread", "idle", "2026-08-24T12:00:05Z", { lastCompletionEventId: "event-2" })), "thread:event-2");
    },
  },
  {
    name: "ignores diagnostics, subagents, waiting, errors, and aborted turns",
    run() {
      const policy = new CompletionPolicy();
      policy.seed([session("main", "working", "2026-08-24T12:00:00Z")]);
      assert.equal(policy.observe(session("main", "waiting", "2026-08-24T12:00:01Z")), null);
      assert.equal(policy.observe(session("main", "error", "2026-08-24T12:00:02Z", { lastCompletionEventId: "error" })), null);
      assert.equal(policy.observe(session("main", "aborted", "2026-08-24T12:00:03Z", { lastCompletionEventId: "abort" })), null);
      assert.equal(policy.observe({ id: "diag", status: "idle", updatedAt: "2026-08-24T12:00:04Z", taskKind: "diagnostic", lastCompletedTurnId: "diag-turn" }), null);
      assert.equal(policy.observe({ id: "child", status: "idle", updatedAt: "2026-08-24T12:00:05Z", taskKind: "internal", parentThreadId: "main", lastCompletedTurnId: "child-turn" }), null);
    },
  },
];
