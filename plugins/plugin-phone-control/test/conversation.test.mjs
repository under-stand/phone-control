import assert from "node:assert/strict";
import { assistantReplyGroups, conversationTurns, mapResultsToTurns } from "../public/lib/conversation.js";

function prompt(eventId, at, { origin, turnId = null, text = "修复当前轮次重复问题" } = {}) {
  return {
    eventId,
    at,
    kind: "user_prompt",
    ...(origin ? { origin } : {}),
    ...(turnId ? { turnId } : {}),
    message: { role: "user", text },
  };
}

export const tests = [
  {
    name: "merges delayed phone, Hook, and rollout copies into one visible prompt and turn",
    run() {
      const turns = conversationTurns([
        prompt("phone-copy", "2026-08-28T15:42:35.449Z", { turnId: "turn-live" }),
        prompt("hook-copy", "2026-08-28T15:42:40.533Z", { origin: "hook", turnId: "turn-live" }),
        prompt("rollout-copy", "2026-08-28T15:42:40.551Z", { origin: "rollout" }),
      ]);
      assert.equal(turns.length, 1);
      assert.equal(turns[0].events.length, 3);
      assert.equal(turns[0].userMessages.length, 1);
      assert.equal(turns[0].userMessages[0].id, "phone-copy");
    },
  },
  {
    name: "preserves an intentionally repeated same-source prompt in one active turn",
    run() {
      const turns = conversationTurns([
        prompt("hook-first", "2026-08-28T15:42:40.000Z", { origin: "hook", turnId: "turn-live" }),
        prompt("rollout-first", "2026-08-28T15:42:40.020Z", { origin: "rollout" }),
        prompt("hook-second", "2026-08-28T15:42:45.000Z", { origin: "hook", turnId: "turn-live" }),
        prompt("rollout-second", "2026-08-28T15:42:45.020Z", { origin: "rollout" }),
      ]);
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0].userMessages.map((message) => message.id), ["hook-first", "hook-second"]);
    },
  },
  {
    name: "collapses delayed duplicate assistant history inside one turn",
    run() {
      const turns = conversationTurns([
        { eventId: "turn-start", at: "2026-08-28T15:42:40.000Z", kind: "turn_start", turnId: "turn-live" },
        { eventId: "response-item", at: "2026-08-28T15:42:41.000Z", kind: "assistant_message", origin: "rollout", message: { role: "assistant", text: "The task is complete" } },
        { eventId: "task-complete-copy", at: "2026-08-28T15:42:53.000Z", kind: "assistant_message", origin: "rollout", turnId: "turn-live", message: { role: "assistant", text: "The task is complete" } },
        { eventId: "turn-complete", at: "2026-08-28T15:42:53.001Z", kind: "turn_complete", turnId: "turn-live" },
      ]);
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0].assistantMessages.map((message) => message.id), ["response-item"]);
    },
  },
  {
    name: "keeps the same text in separate completed turns",
    run() {
      const turns = conversationTurns([
        prompt("turn-one-prompt", "2026-08-28T15:42:40.000Z", { origin: "hook", turnId: "turn-one" }),
        { eventId: "turn-one-done", at: "2026-08-28T15:42:41.000Z", kind: "turn_complete", turnId: "turn-one" },
        prompt("turn-two-prompt", "2026-08-28T15:43:40.000Z", { origin: "hook", turnId: "turn-two" }),
      ]);
      assert.equal(turns.length, 2);
      assert.equal(turns.every((turn) => turn.userMessages.length === 1), true);
    },
  },
  {
    name: "keeps an explicit final answer out of process replies even when commentary follows",
    run() {
      const [turn] = conversationTurns([
        prompt("prompt", "2026-08-28T15:42:40.000Z", { turnId: "turn-live" }),
        { eventId: "commentary-before", at: "2026-08-28T15:42:41.000Z", kind: "assistant_message", turnId: "turn-live", phase: "commentary", message: { role: "assistant", text: "处理中" } },
        { eventId: "final", at: "2026-08-28T15:42:42.000Z", kind: "assistant_message", turnId: "turn-live", phase: "final_answer", message: { role: "assistant", text: "最终结果" } },
        { eventId: "commentary-after", at: "2026-08-28T15:42:43.000Z", kind: "assistant_message", turnId: "turn-live", phase: "commentary", message: { role: "assistant", text: "补充同步状态" } },
      ]);
      const groups = assistantReplyGroups(turn);
      assert.equal(groups.finalReply.id, "final");
      assert.deepEqual(groups.updates.map((message) => message.id), ["commentary-before", "commentary-after"]);
    },
  },
  {
    name: "does not present active commentary as a final answer",
    run() {
      const [turn] = conversationTurns([
        prompt("prompt", "2026-08-28T15:42:40.000Z", { turnId: "turn-live" }),
        { eventId: "commentary", at: "2026-08-28T15:42:41.000Z", kind: "assistant_message", turnId: "turn-live", phase: "commentary", message: { role: "assistant", text: "仍在处理" } },
      ]);
      const groups = assistantReplyGroups(turn);
      assert.equal(groups.finalReply, null);
      assert.deepEqual(groups.updates.map((message) => message.id), ["commentary"]);
    },
  },
  {
    name: "binds supplemental results by terminal event when server and rendered turn ids differ",
    run() {
      const turns = conversationTurns([
        prompt("prompt-old", "2026-08-28T15:42:40.000Z", { turnId: "rendered-old", text: "第一轮" }),
        { eventId: "done-old", at: "2026-08-28T15:42:41.000Z", kind: "turn_complete", turnId: "rendered-old" },
        prompt("prompt-new", "2026-08-28T15:43:40.000Z", { turnId: "rendered-new", text: "第二轮" }),
        { eventId: "done-new", at: "2026-08-28T15:43:41.000Z", kind: "turn_complete", turnId: "rendered-new" },
      ]);
      const byTurn = mapResultsToTurns(turns, [
        { turnId: "server-old", completionEventId: "done-old", completedAt: "2026-08-28T15:42:41.000Z", hasContent: true },
        { turnId: "server-new", completionEventId: "done-new", completedAt: "2026-08-28T15:43:41.000Z", hasContent: true },
      ]);
      assert.equal(byTurn.get("rendered-old").turnId, "server-old");
      assert.equal(byTurn.get("rendered-new").turnId, "server-new");
    },
  },
];
