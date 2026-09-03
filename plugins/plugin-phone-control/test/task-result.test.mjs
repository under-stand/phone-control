import assert from "node:assert/strict";
import { deriveTaskResult, deriveTaskResults, summarizeTaskResult } from "../src/task-result.mjs";

export const tests = [
  {
    name: "builds a bounded structured result from the latest completed turn",
    run() {
      const result = deriveTaskResult({
        lastAssistantMessage: null,
        events: [
          { kind: "user_prompt", turnId: "turn-1", at: "2026-09-04T00:00:00Z", message: { role: "user", text: "Implement it" } },
          { kind: "tool_start", turnId: "turn-1", at: "2026-09-04T00:00:01Z", tool: { name: "apply_patch", summary: "./src/task-result.mjs" } },
          { kind: "tool_start", turnId: "turn-1", at: "2026-09-04T00:00:02Z", tool: { name: "exec_command", summary: "npm test" } },
          { kind: "assistant_message", turnId: "turn-1", phase: "final_answer", at: "2026-09-04T00:00:03Z", message: { role: "assistant", text: "Implemented the result card.\n\n### Verification\n\n- Mobile layout\n- Result formatting" } },
          { kind: "turn_complete", turnId: "turn-1", at: "2026-09-04T00:00:04Z" },
        ],
      });
      assert.equal(result.status, "completed");
      assert.equal(result.turnId, "turn-1");
      assert.equal(result.conclusion, "Implemented the result card.\n\n### Verification\n\n- Mobile layout\n- Result formatting");
      assert.deepEqual(result.files, ["./src/task-result.mjs"]);
      assert.deepEqual(result.tests.items, ["npm test"]);
      assert.equal(result.tests.status, "observed");
      assert.equal(result.commands[0].summary, "npm test");
      const summary = summarizeTaskResult(result);
      assert.equal(summary.tests.count, 1);
      assert.equal("commands" in summary, false);
    },
  },
  {
    name: "builds separate supplemental metadata for every completed turn",
    run() {
      const results = deriveTaskResults({ events: [
        { kind: "user_prompt", turnId: "old", at: "2026-09-03T00:00:00Z", message: { role: "user", text: "Implement the first change" } },
        { kind: "tool_start", turnId: "old", at: "2026-09-03T00:00:01Z", tool: { name: "apply_patch", summary: "./src/first.mjs" } },
        { kind: "turn_complete", turnId: "old", at: "2026-09-03T00:00:02Z" },
        { kind: "user_prompt", turnId: "new", at: "2026-09-04T00:00:00Z", message: { role: "user", text: "Verify the second change" } },
        { kind: "tool_start", turnId: "new", at: "2026-09-04T00:00:01Z", tool: { name: "exec_command", summary: "npm test" } },
        { kind: "turn_complete", turnId: "new", at: "2026-09-04T00:00:02Z" },
      ] });
      assert.deepEqual(results.map((result) => result.turnId), ["old", "new"]);
      assert.deepEqual(results[0].files, ["./src/first.mjs"]);
      assert.deepEqual(results[1].tests.items, ["npm test"]);
      assert.deepEqual(results[0].commands, []);
      assert.equal(results[1].commands[0].summary, "npm test");
    },
  },
  {
    name: "uses only the most recent finished turn and records stopped outcomes",
    run() {
      const result = deriveTaskResult({
        events: [
          { kind: "assistant_message", turnId: "old", at: "2026-09-03T00:00:00Z", message: { role: "assistant", text: "Old answer" } },
          { kind: "turn_complete", turnId: "old", at: "2026-09-03T00:00:01Z" },
          { kind: "user_prompt", turnId: "new", at: "2026-09-04T00:00:00Z", message: { role: "user", text: "Stop now" } },
          { kind: "aborted", turnId: "new", at: "2026-09-04T00:00:01Z" },
        ],
      });
      assert.equal(result.status, "stopped");
      assert.equal(result.conclusion, null);
      assert.deepEqual(result.warnings, ["本轮由用户或 Codex 中止"]);
    },
  },
  {
    name: "does not fabricate a result for a still-running turn",
    run() {
      assert.equal(deriveTaskResult({ events: [{ kind: "turn_start", at: "2026-09-04T00:00:00Z" }] }), null);
    },
  },
  {
    name: "does not misclassify a command URL as a changed file",
    run() {
      const result = deriveTaskResult({ events: [
        { kind: "turn_start", turnId: "url-turn", at: "2026-09-04T00:00:00Z" },
        { kind: "tool_start", turnId: "url-turn", at: "2026-09-04T00:00:01Z", tool: { name: "exec_command", summary: "curl https://example.com/path/file.json" } },
        { kind: "turn_complete", turnId: "url-turn", at: "2026-09-04T00:00:02Z" },
      ] });
      assert.deepEqual(result.files, []);
    },
  },
];
