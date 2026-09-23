import assert from "node:assert/strict";
import { projectSession } from "../src/session-projection.mjs";

export const tests = [
  { name: "keeps older uncertain delivery actionable after newer completion in every session projection", run() {
    const now = Date.parse("2026-09-22T01:00:00Z");
    const session = { id: "thread-a", status: "completed" };
    const queuedCommands = [
      { id: "older", status: "needs_review", updatedAt: "2026-09-22T00:00:00Z" },
      { id: "newer", status: "delivered", updatedAt: "2026-09-22T00:10:00Z", completedAt: "2026-09-22T00:10:00Z" },
    ];
    const projection = projectSession(session, { queuedCommands, now });
    assert.equal(projection.latestCommand.id, "newer");
    assert.equal(projection.commandState.id, "older");
    assert.equal(projection.inbox.bucket, "needs_review");
    assert.equal(projection.inbox.actionRequired, true);
    assert.deepEqual(projection.attentionCommands.map((entry) => entry.id), ["older"]);
    assert.equal(projection.queuedCommands[0].id, "older");
    queuedCommands[0] = { ...queuedCommands[0], status: "canceled" };
    assert.equal(projectSession(session, { queuedCommands, now }).inbox.bucket, "completed");
  } },
  { name: "keeps active work separate from latest completed and unresolved commands", run() {
    const projection = projectSession({ status: "completed" }, { queuedCommands: [
      { id: "pending", status: "cli_queued", updatedAt: "2026-09-22T00:00:00Z" },
      { id: "done", status: "delivered", completedAt: "2026-09-22T00:01:00Z", updatedAt: "2026-09-22T00:01:00Z" },
    ] });
    assert.equal(projection.latestCommand.id, "done");
    assert.deepEqual(projection.activeCommands.map((entry) => entry.id), ["pending"]);
    assert.equal(projection.inbox.bucket, "queued");
    assert.equal(projection.attentionCommands.length, 0);
  } },
];
