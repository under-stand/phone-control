import assert from "node:assert/strict";
import { SessionStore } from "../src/session-store.mjs";

export const tests = [
  {
    name: "exposes a compact result in task lists and a detailed result in session details",
    run() {
      const store = new SessionStore();
      store.ingest({ eventId: "result-user", sessionId: "result-session", turnId: "result-turn", kind: "user_prompt", at: "2026-09-04T00:00:00Z", message: { role: "user", text: "Run the release checks" } });
      store.ingest({ eventId: "result-tool", sessionId: "result-session", turnId: "result-turn", kind: "tool_start", at: "2026-09-04T00:00:01Z", tool: { name: "exec_command", summary: "npm run verify:release" } });
      store.ingest({ eventId: "result-answer", sessionId: "result-session", turnId: "result-turn", kind: "assistant_message", phase: "final_answer", at: "2026-09-04T00:00:02Z", message: { role: "assistant", text: "Release checks completed." } });
      store.ingest({ eventId: "result-done", sessionId: "result-session", turnId: "result-turn", kind: "turn_complete", at: "2026-09-04T00:00:03Z" });

      const summary = store.getSummary("result-session");
      const detail = store.get("result-session");
      assert.equal(summary.result.conclusion, "Release checks completed.");
      assert.equal(summary.result.tests.count, 1);
      assert.equal("commands" in summary.result, false);
      assert.equal(detail.result.commands[0].summary, "npm run verify:release");
      assert.deepEqual(detail.result.tests.items, ["npm run verify:release"]);
    },
  },
  {
    name: "retains supplemental metadata after the rolling event window evicts older turns",
    run() {
      const store = new SessionStore();
      for (let index = 0; index < 250; index += 1) {
        const turnId = `long-turn-${index}`;
        const at = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
        store.ingest({
          eventId: `long-prompt-${index}`,
          sessionId: "long-session",
          turnId,
          kind: "user_prompt",
          at,
          message: { role: "user", text: `完成第 ${index} 轮` },
        });
        store.ingest({
          eventId: `long-tool-${index}`,
          sessionId: "long-session",
          turnId,
          kind: "tool_start",
          at: new Date(Date.parse(at) + 1_000).toISOString(),
          tool: { name: "apply_patch", summary: `./src/turn-${index}.mjs` },
        });
        store.ingest({
          eventId: `long-done-${index}`,
          sessionId: "long-session",
          turnId,
          kind: "turn_complete",
          at: new Date(Date.parse(at) + 2_000).toISOString(),
        });
      }
      const session = store.get("long-session");
      assert.equal(session.events.length <= 240, true);
      assert.equal(session.results.length, 250);
      assert.equal(session.results[0].turnId, "long-turn-0");
      assert.deepEqual(session.results[0].files, ["./src/turn-0.mjs"]);
      assert.equal(session.results.at(-1).turnId, "long-turn-249");
    },
  },
];
