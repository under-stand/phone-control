import assert from "node:assert/strict";
import { createRolloutContext, normalizeRolloutRecord } from "../src/rollout-parser.mjs";
import { SessionStore } from "../src/session-store.mjs";

function fixture() {
  const context = createRolloutContext("/tmp/rollout-turn-identity.jsonl");
  const store = new SessionStore();
  let tick = 0;
  const ingest = (type, payload) => {
    const events = normalizeRolloutRecord({ type, payload, timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, tick++)).toISOString() }, context);
    for (const event of events) store.ingest(event);
    return events;
  };
  ingest("session_meta", { id: "thread-identity", source: "cli" });
  return { context, store, ingest };
}

export const tests = [
  {
    name: "uses the CLI lifecycle turn instead of internal message metadata for continuation",
    run() {
      const { store, ingest } = fixture();
      ingest("event_msg", { type: "task_started", turn_id: "turn-cli" });
      ingest("event_msg", { type: "user_message", message: "Check the build" });
      ingest("response_item", { type: "function_call", name: "exec", call_id: "call-1", internal_chat_message_metadata_passthrough: { turn_id: "model-request" } });
      ingest("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Build checked" }], internal_chat_message_metadata_passthrough: { turn_id: "model-request" } });
      ingest("event_msg", { type: "task_complete", turn_id: "turn-cli", last_agent_message: "Build checked" });
      store.setBridgeState({ connected: true });
      const session = store.get("thread-identity");
      assert.equal(session.status, "idle");
      assert.equal(session.turnId, "turn-cli");
      assert.equal(session.control.action, "resume");
      assert.equal(session.control.canSend, true);
      assert.ok(session.events.every(event => event.turnId === "turn-cli"));
    },
  },
  {
    name: "does not promote an internal message id when rollout lifecycle context is missing",
    run() {
      const { ingest } = fixture();
      const [message] = ingest("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Partial history" }], internal_chat_message_metadata_passthrough: { turn_id: "model-request" } });
      assert.equal(message.turnId, null);
      ingest("turn_context", { turn_id: "turn-current" });
      const [current] = ingest("response_item", { type: "function_call", name: "exec", call_id: "call-current" });
      assert.equal(current.turnId, "turn-current");
    },
  },
  {
    name: "restores completion despite legacy message ids without allowing other turns to complete the task",
    run() {
      const store = new SessionStore();
      const ingest = (kind, turnId, tick) => store.ingest({ eventId: `legacy-${tick}`, sessionId: "legacy", source: "rollout", surface: "CLI", transcriptPath: "/tmp/legacy.jsonl", kind, turnId, at: new Date(Date.UTC(2026, 8, 1, 0, 0, tick)).toISOString(), ...(kind === "user_prompt" ? { message: { role: "user", text: "Continue" } } : {}) });
      ingest("turn_start", "turn-real", 0);
      ingest("user_prompt", "turn-real", 1);
      ingest("assistant_message", "model-request", 2);
      ingest("tool_start", "model-request", 3);
      ingest("turn_complete", "turn-other", 4);
      assert.equal(store.get("legacy").status, "working");
      assert.equal(store.get("legacy").turnId, "turn-real");
      ingest("turn_complete", "turn-real", 5);
      assert.equal(store.get("legacy").status, "idle");
      ingest("tool_end", "model-request", 6);
      assert.equal(store.get("legacy").status, "idle");
      ingest("turn_start", "turn-next", 7);
      ingest("turn_complete", "turn-real", 8);
      assert.equal(store.get("legacy").status, "working");
      assert.equal(store.get("legacy").turnId, "turn-next");
    },
  },
];
