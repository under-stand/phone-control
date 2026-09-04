import assert from "node:assert/strict";
import { createSessionSnapshot, parseSessionSnapshot } from "../public/lib/session-snapshot.js";

export const tests = [
  {
    name: "stores bounded session summaries without conversation events",
    async run() {
      const snapshot = createSessionSnapshot([
        { id: "older", updatedAt: "2026-09-01T00:00:00.000Z", events: [{ message: { text: "secret history" } }], task: { title: "旧任务", result: "x" } },
        { id: "newer", updatedAt: "2026-09-02T00:00:00.000Z", events: [{ message: { text: "secret history" } }], task: { title: "新任务" } },
      ], { savedAt: "2026-09-03T00:00:00.000Z", limit: 1 });
      assert.deepEqual(snapshot.sessions.map((session) => session.id), ["newer"]);
      assert.equal(Object.hasOwn(snapshot.sessions[0], "events"), false);
      assert.equal(snapshot.sessions[0].task.title, "新任务");
    },
  },
  {
    name: "rejects malformed snapshots and marks old snapshots stale",
    async run() {
      assert.equal(parseSessionSnapshot("not-json"), null);
      assert.equal(parseSessionSnapshot({ version: 2, sessions: [] }), null);
      const parsed = parseSessionSnapshot({ version: 1, savedAt: "2026-08-01T00:00:00.000Z", sessions: [{ id: "one", events: [] }] }, {
        now: Date.parse("2026-09-03T00:00:00.000Z"),
        maxAgeMs: 24 * 60 * 60_000,
      });
      assert.equal(parsed.stale, true);
      assert.deepEqual(parsed.sessions.map((session) => session.id), ["one"]);
    },
  },
];
