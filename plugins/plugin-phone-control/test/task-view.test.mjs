import assert from "node:assert/strict";
import { commandStateView, compareTaskUrgency, inboxOverview, resultView, taskNeedsAttention } from "../public/lib/task-view.js";

export const tests = [
  {
    name: "orders the client task list by server-projected inbox priority",
    run() {
      const running = { id: "running", updatedAt: "2026-09-04T00:00:02Z", inbox: { bucket: "running", priority: 50 } };
      const answer = { id: "answer", updatedAt: "2026-09-04T00:00:01Z", inbox: { bucket: "needs_answer", priority: 100, actionRequired: true, reason: "Choose" } };
      const sorted = [running, answer].sort(compareTaskUrgency);
      assert.equal(sorted[0].id, "answer");
      assert.equal(taskNeedsAttention(answer), true);
      assert.deepEqual(inboxOverview([running, answer]), {
        actionable: 1,
        attention: 1,
        running: 1,
        queued: 0,
        top: answer,
      });
    },
  },
  {
    name: "maps command and result states to stable presentation tones",
    run() {
      assert.equal(commandStateView({ state: "needs_review" }).tone, "attention");
      assert.equal(commandStateView({ state: "completed" }).tone, "success");
      assert.equal(resultView({ status: "completed", tests: { status: "observed" } }).testStatus, "已运行验证");
      assert.equal(resultView({ status: "failed", tests: { status: "failed" } }).tone, "danger");
    },
  },
];
