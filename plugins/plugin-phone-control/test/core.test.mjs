import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { normalizeHookInput } from "../src/hook-normalizer.mjs";
import { createRolloutContext, normalizeRolloutRecord } from "../src/rollout-parser.mjs";
import { SessionStore } from "../src/session-store.mjs";
import { tokenMatches, parseCookies } from "../src/auth.mjs";
import { createFrameParser, encodeWebSocketFrame, MAX_FRAME_BYTES } from "../src/unix-websocket.mjs";

export const tests = [
  {
    name: "accepts messages beyond the old 32 MiB boundary within the bounded envelope",
    run() {
      const payload = Buffer.alloc((32 * 1024 * 1024) + 1, 0x61);
      const encoded = encodeWebSocketFrame(payload);
      assert.ok(encoded.length > payload.length);
      assert.equal(MAX_FRAME_BYTES, 128 * 1024 * 1024);
    },
  },
  {
    name: "rejects an oversized WebSocket frame from its header before buffering the payload",
    run() {
      const readable = new PassThrough();
      const parser = createFrameParser({ destroyed: false, end() {}, write() {} }, readable);
      const header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES + 1), 2);
      assert.throws(() => parser(header), (error) => (
        error.code === "ERR_WS_MESSAGE_TOO_LARGE"
        && error.maxBytes === MAX_FRAME_BYTES
        && /134217729 bytes/.test(error.message)
      ));
    },
  },
  {
    name: "normalizes Codex lifecycle and question hooks",
    run() {
      const event = normalizeHookInput({
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/work/project",
        source: "vscode",
        tool_name: "request_user_input",
        tool_input: { question: "Deploy now?" },
      }, Date.parse("2026-08-23T12:00:00Z"));
      assert.equal(event.kind, "question");
      assert.equal(event.surface, "Desktop");
      assert.equal(event.tool.name, "request_user_input");
      assert.equal(event.tool.summary, "Deploy now?");
    },
  },
  {
    name: "tracks working, waiting, and completed session transitions",
    run() {
      const store = new SessionStore();
      store.ingest({ eventId: "1", sessionId: "s", kind: "turn_start", at: "2026-08-23T12:00:00Z", surface: "CLI" });
      assert.equal(store.get("s").status, "working");
      store.ingest({
        eventId: "2",
        sessionId: "s",
        kind: "permission_request",
        at: "2026-08-23T12:00:01Z",
        tool: { name: "Bash" },
        reason: "Needs network",
        approval: { id: "approval-live", expiresAt: "2026-08-23T12:01:00Z" },
      });
      assert.equal(store.get("s").status, "waiting");
      assert.equal(store.get("s").pendingApproval.tool.name, "Bash");
      store.ingest({ eventId: "3", sessionId: "s", kind: "turn_complete", at: "2026-08-23T12:00:02Z" });
      assert.equal(store.get("s").status, "idle");
      assert.equal(store.get("s").pendingApproval, null);
    },
  },
  {
    name: "exposes minimal turn provenance for cross-stream conversation merging",
    run() {
      const store = new SessionStore();
      store.ingest({
        eventId: "hook-prompt",
        sessionId: "public-event",
        turnId: "turn-public",
        source: "hook",
        kind: "user_prompt",
        at: "2026-08-23T12:00:00Z",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        message: { role: "user", text: "Continue this task" },
      });
      store.ingest({
        eventId: "rollout-prompt",
        sessionId: "public-event",
        source: "rollout",
        kind: "user_prompt",
        at: "2026-08-23T12:00:00.010Z",
        message: { role: "user", text: "Continue this task" },
      });

      const session = store.get("public-event");
      assert.equal(session.events[0].turnId, "turn-public");
      assert.equal(session.events[0].origin, "hook");
      assert.equal(session.events[0].model, "gpt-5.6-sol");
      assert.equal(session.events[0].reasoningEffort, "xhigh");
      assert.equal(session.events[1].origin, "rollout");
      assert.equal("source" in session.events[0], false);
      assert.equal("source" in session.events[1], false);
    },
  },
  {
    name: "keeps a passive Codex permission observation non-actionable",
    run() {
      const store = new SessionStore();
      store.ingest({ eventId: "passive-start", sessionId: "passive", kind: "turn_start", at: "2026-08-23T12:00:00Z" });
      store.ingest({
        eventId: "passive-permission",
        sessionId: "passive",
        kind: "permission_request",
        at: "2026-08-23T12:00:01Z",
        reason: "Codex reviewer is deciding",
      });
      const session = store.get("passive");
      assert.equal(session.status, "working");
      assert.equal(session.pendingApproval, null);
      assert.equal(session.control.canApprove, false);
    },
  },
  {
    name: "keeps a completed turn final when delayed activity arrives",
    run() {
      const store = new SessionStore();
      store.ingest({ eventId: "turn-start", sessionId: "stable", turnId: "turn-1", kind: "turn_start", at: "2026-08-23T12:00:00Z" });
      store.ingest({ eventId: "turn-done", sessionId: "stable", turnId: "turn-1", kind: "turn_complete", at: "2026-08-23T12:00:02Z" });
      store.ingest({ eventId: "late-tool", sessionId: "stable", turnId: "turn-1", kind: "tool_end", at: "2026-08-23T12:00:03Z" });
      store.ingest({ eventId: "stale-tool", sessionId: "stable", turnId: "turn-1", kind: "tool_start", at: "2026-08-23T12:00:01Z" });
      const completed = store.get("stable");
      assert.equal(completed.status, "idle");
      assert.equal(completed.lastCompletedTurnId, "turn-1");
      assert.equal(completed.lastCompletionEventId, "turn-done");

      store.ingest({ eventId: "next-turn", sessionId: "stable", turnId: "turn-2", kind: "turn_start", at: "2026-08-23T12:00:04Z" });
      assert.equal(store.get("stable").status, "working");
      assert.equal(store.get("stable").turnId, "turn-2");
    },
  },
  {
    name: "exposes start, steer, and resume controls only from verified bridge state",
    run() {
      const store = new SessionStore();
      store.ingest({
        eventId: "control-user",
        sessionId: "thread-control",
        turnId: "turn-old",
        kind: "user_prompt",
        at: "2026-08-23T11:59:59Z",
        surface: "Desktop",
        message: { role: "user", text: "Continue this task" },
      });
      store.ingest({
        eventId: "control-1",
        sessionId: "thread-control",
        turnId: "turn-old",
        kind: "turn_complete",
        at: "2026-08-23T12:00:00Z",
        transcriptPath: "/tmp/thread-control.jsonl",
      });
      store.setBridgeState({ connected: true });
      assert.equal(store.get("thread-control").control.action, "resume");

      store.setBridgeState({
        connected: true,
        handoffSupported: true,
        loadedThreads: ["thread-control"],
        subscribedThreads: ["thread-control"],
        threadStates: { "thread-control": { status: "idle", activeFlags: [], activeTurnId: null } },
      });
      assert.equal(store.get("thread-control").control.action, "start");
      assert.equal(store.get("thread-control").control.canHandoff, true);

      store.setBridgeState({
        connected: true,
        loadedThreads: ["thread-control"],
        subscribedThreads: ["thread-control"],
        threadStates: { "thread-control": { status: "active", activeFlags: [], activeTurnId: "turn-active" } },
      });
      assert.equal(store.get("thread-control").control.action, "steer");
      assert.equal(store.get("thread-control").control.expectedTurnId, "turn-active");
      assert.equal(store.get("thread-control").control.canInterrupt, true);
      assert.equal(store.get("thread-control").control.canHandoff, false);

      store.setBridgeState({
        connected: true,
        loadedThreads: ["thread-control"],
        subscribedThreads: ["thread-control"],
        threadStates: { "thread-control": { status: "active", activeFlags: ["waitingOnApproval"], activeTurnId: "turn-active" } },
      });
      assert.equal(store.get("thread-control").control.canSend, false);
      assert.equal(store.get("thread-control").control.canInterrupt, false);

      store.setBridgeState({
        connected: true,
        loadedThreads: ["thread-control"],
        subscribedThreads: ["thread-control"],
        threadStates: { "thread-control": { status: "active", activeFlags: ["interruptRequested"], activeTurnId: "turn-active" } },
      });
      assert.equal(store.get("thread-control").control.canSend, false);
      assert.equal(store.get("thread-control").control.canInterrupt, false);
      assert.match(store.get("thread-control").control.reason, /stop request/i);

      store.setBridgeState({
        connected: true,
        loadedThreads: ["thread-control"],
        unavailableThreadReasons: {
          "thread-control": "Live control was isolated because this thread produced an oversized App Server message",
        },
      });
      assert.equal(store.get("thread-control").control.canSend, false);
      assert.equal(store.get("thread-control").control.mode, "observe");
      assert.match(store.get("thread-control").control.reason, /Live control unavailable/);

      store.setBridgeState({
        connected: true,
        handoffSupported: true,
        handedOffThreads: ["thread-control"],
        unavailableThreadReasons: {
          "thread-control": "This session was handed off to the desktop and is phone read-only",
        },
      });
      assert.equal(store.get("thread-control").control.handedOff, true);
      assert.equal(store.get("thread-control").control.canSend, false);
      assert.equal(store.get("thread-control").control.canHandoff, false);
      assert.equal(store.get("thread-control").control.canReclaim, true);

      const cliStore = new SessionStore();
      cliStore.ingest({
        eventId: "cli-user",
        sessionId: "thread-cli",
        turnId: "turn-cli",
        kind: "user_prompt",
        at: "2026-08-23T12:00:00Z",
        surface: "CLI",
        message: { role: "user", text: "Continue from the terminal" },
      });
      cliStore.ingest({
        eventId: "cli-complete",
        sessionId: "thread-cli",
        turnId: "turn-cli",
        kind: "turn_complete",
        at: "2026-08-23T12:00:01Z",
        transcriptPath: "/tmp/thread-cli.jsonl",
      });
      cliStore.setBridgeState({
        connected: true,
        handoffSupported: true,
        loadedThreads: ["thread-cli"],
        subscribedThreads: ["thread-cli"],
        threadStates: { "thread-cli": { status: "idle", activeFlags: [], activeTurnId: null } },
      });
      assert.equal(cliStore.get("thread-cli").control.canSend, true);
      assert.equal(cliStore.get("thread-cli").control.canHandoff, false);
      assert.equal(cliStore.get("thread-cli").control.canReclaim, false);
    },
  },
  {
    name: "keeps unverified working and waiting runtimes observe-only",
    run() {
      const store = new SessionStore();
      store.ingest({
        eventId: "unsafe-working-user",
        sessionId: "thread-working",
        kind: "user_prompt",
        at: "2026-08-24T11:59:58Z",
        message: { role: "user", text: "Keep working" },
      });
      store.ingest({
        eventId: "unsafe-working",
        sessionId: "thread-working",
        kind: "turn_start",
        at: "2026-08-24T12:00:00Z",
        transcriptPath: "/tmp/thread-working.jsonl",
      });
      store.ingest({
        eventId: "unsafe-waiting-user",
        sessionId: "thread-waiting",
        kind: "user_prompt",
        at: "2026-08-24T11:59:59Z",
        message: { role: "user", text: "Run the protected action" },
      });
      store.ingest({
        eventId: "unsafe-waiting",
        sessionId: "thread-waiting",
        kind: "permission_request",
        at: "2026-08-24T12:00:01Z",
        transcriptPath: "/tmp/thread-waiting.jsonl",
      });
      store.setBridgeState({ connected: true });

      assert.equal(store.get("thread-working").control.canSend, false);
      assert.equal(store.get("thread-working").control.mode, "observe");
      assert.match(store.get("thread-working").control.reason, /another Codex runtime/);
      assert.equal(store.get("thread-working").staleAt, "2026-08-24T12:10:00.000Z");
      assert.equal(store.get("thread-waiting").control.canSend, false);
      assert.notEqual(store.get("thread-waiting").control.action, "resume");
    },
  },
  {
    name: "clears expired restored waiting state before exposing controls",
    run() {
      const store = new SessionStore({ staleAfterMs: 60_000 });
      store.ingest({
        eventId: "expired-wait",
        sessionId: "thread-expired-wait",
        kind: "permission_request",
        at: "2026-08-24T12:00:00Z",
        transcriptPath: "/tmp/thread-expired-wait.jsonl",
        approval: { id: "approval-old", expiresAt: "2026-08-24T12:00:30Z" },
      }, { persist: false, announce: false });

      store.reconcileRestoredSessions(Date.parse("2026-08-24T12:02:00Z"));
      store.setBridgeState({ connected: true });
      const restored = store.get("thread-expired-wait");
      assert.equal(restored.status, "unknown");
      assert.equal(restored.pendingApproval, null);
      assert.equal(restored.control.mode, "observe");
      assert.equal(restored.control.canApprove, false);
      assert.equal(restored.control.canSend, false);
    },
  },
  {
    name: "parses rollout metadata, tools, and completion events",
    run() {
      const context = createRolloutContext("/tmp/rollout-2026-08-23-session.jsonl");
      const metadata = normalizeRolloutRecord({ type: "session_meta", timestamp: "2026-08-23T12:00:00Z", payload: { id: "thread-1", cwd: "/repo", source: "cli" } }, context)[0];
      normalizeRolloutRecord({ type: "turn_context", timestamp: "2026-08-23T12:00:00.500Z", payload: { model: "gpt-5.6-sol", effort: "xhigh", service_tier: "priority" } }, context);
      const tool = normalizeRolloutRecord({ type: "response_item", timestamp: "2026-08-23T12:00:01Z", payload: { type: "function_call", name: "Bash", call_id: "call-1", arguments: "{\"command\":\"npm test\"}" } }, context)[0];
      const formattedReply = "All tests pass\n\n| Suite | Result |\n| --- | --- |\n| Mobile | Pass |";
      const done = normalizeRolloutRecord({ type: "event_msg", timestamp: "2026-08-23T12:00:02Z", payload: { type: "task_complete", last_agent_message: formattedReply } }, context);
      assert.equal(metadata.kind, "session_metadata");
      assert.equal(tool.kind, "tool_start");
      assert.equal(tool.tool.summary, "npm test");
      assert.equal(tool.surface, "CLI");
      assert.equal(tool.model, "gpt-5.6-sol");
      assert.equal(tool.reasoningEffort, "xhigh");
      assert.equal(tool.serviceTier, "priority");
      assert.deepEqual(done.map((event) => event.kind), ["assistant_message", "turn_complete"]);
      assert.equal(done[0].message.text, formattedReply);
      assert.equal(done[0].phase, "final_answer");
      assert.equal(done[0].model, "gpt-5.6-sol");
      assert.equal(done[0].reasoningEffort, "xhigh");
      assert.equal(done[0].serviceTier, "priority");
    },
  },
  {
    name: "preserves assistant commentary and final answer phases from rollout records",
    run() {
      const context = createRolloutContext("/tmp/rollout-message-phases.jsonl");
      normalizeRolloutRecord({ type: "session_meta", timestamp: "2026-08-23T12:00:00Z", payload: { id: "thread-phases", source: "desktop" } }, context);
      const commentary = normalizeRolloutRecord({
        type: "response_item",
        timestamp: "2026-08-23T12:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Working" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-phases" },
        },
      }, context)[0];
      const final = normalizeRolloutRecord({
        type: "response_item",
        timestamp: "2026-08-23T12:00:02Z",
        payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done" }] },
      }, context)[0];
      assert.equal(commentary.phase, "commentary");
      assert.equal(commentary.turnId, "turn-phases");
      assert.equal(final.phase, "final_answer");
    },
  },
  {
    name: "applies sticky model, effort, Fast, and cwd from rollout thread settings",
    run() {
      const context = createRolloutContext("/tmp/rollout-settings.jsonl");
      normalizeRolloutRecord({ type: "session_meta", timestamp: "2026-08-23T12:00:00Z", payload: { id: "thread-settings", cwd: "/old", source: "cli" } }, context);
      const settings = normalizeRolloutRecord({
        type: "event_msg",
        timestamp: "2026-08-23T12:00:01Z",
        payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-terra", reasoning_effort: "ultra", service_tier: "priority", cwd: "/new" } },
      }, context);
      const event = normalizeRolloutRecord({ type: "event_msg", timestamp: "2026-08-23T12:00:02Z", payload: { type: "agent_message", message: "Settings applied" } }, context)[0];
      assert.deepEqual(settings, []);
      assert.equal(event.model, "gpt-5.6-terra");
      assert.equal(event.reasoningEffort, "ultra");
      assert.equal(event.serviceTier, "priority");
      assert.equal(event.cwd, "/new");
    },
  },
  {
    name: "keeps long final replies beyond the former mobile truncation limit",
    run() {
      const context = createRolloutContext("/tmp/rollout-long-reply.jsonl");
      normalizeRolloutRecord({ type: "session_meta", timestamp: "2026-08-23T12:00:00Z", payload: { id: "thread-long", cwd: "/repo", source: "cli" } }, context);
      const longReply = `完整回复开始\n\n${"这是需要在手机端保留的详细内容。".repeat(400)}\n\n完整回复结束`;
      assert.ok(longReply.length > 2_000);
      const done = normalizeRolloutRecord({ type: "event_msg", timestamp: "2026-08-23T12:00:02Z", payload: { type: "task_complete", last_agent_message: longReply } }, context);
      assert.equal(done[0].message.text, longReply);
      assert.match(done[0].message.text, /完整回复结束$/);
    },
  },
  {
    name: "keeps visible rollout prompts but rejects Codex-injected user context",
    run() {
      const context = createRolloutContext("/tmp/rollout-user-context.jsonl");
      normalizeRolloutRecord({ type: "session_meta", timestamp: "2026-08-23T12:00:00Z", payload: { id: "thread-context", cwd: "/repo", source: "cli" } }, context);
      const visible = normalizeRolloutRecord({ type: "event_msg", timestamp: "2026-08-23T12:00:01Z", payload: { type: "user_message", message: "Please inspect the build" } }, context);
      const environment = normalizeRolloutRecord({ type: "response_item", timestamp: "2026-08-23T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>" }] } }, context);
      const combinedRuntime = normalizeRolloutRecord({ type: "response_item", timestamp: "2026-08-23T12:00:01.500Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>\n- GitHub\n</recommended_plugins><environment_context>\n  <cwd>/repo</cwd>\n</environment_context>" }] } }, context);
      const reviewer = normalizeRolloutRecord({ type: "response_item", timestamp: "2026-08-23T12:00:02Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "The following is the Codex agent history added since your last approval assessment. Continue the same review conversation." }] } }, context);
      const imageTransport = normalizeRolloutRecord({ type: "response_item", timestamp: "2026-08-23T12:00:03Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<image name=[Image #1] path=\"/tmp/private.webp\">\n</image>\n[Image #1] What is wrong?" }] } }, context);

      assert.deepEqual(visible.map((event) => event.message.text), ["Please inspect the build"]);
      assert.deepEqual(environment, []);
      assert.deepEqual(combinedRuntime, []);
      assert.deepEqual(reviewer, []);
      assert.deepEqual(imageTransport, []);
    },
  },
  {
    name: "enriches restored turn provenance when rollout replay supplies model metadata",
    run() {
      const store = new SessionStore();
      store.ingest({
        eventId: "legacy-turn-event",
        source: "rollout",
        sessionId: "thread-provenance",
        kind: "assistant_message",
        at: "2026-08-24T12:00:00.000Z",
        message: { role: "assistant", text: "Done" },
      });
      store.ingest({
        eventId: "legacy-turn-event",
        source: "rollout",
        sessionId: "thread-provenance",
        turnId: "turn-provenance",
        kind: "assistant_message",
        at: "2026-08-24T12:00:00.000Z",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        phase: "final_answer",
        message: { role: "assistant", text: "Done" },
      });
      const session = store.get("thread-provenance");
      assert.equal(session.model, "gpt-5.6-sol");
      assert.equal(session.reasoningEffort, "xhigh");
      assert.equal(session.events[0].model, "gpt-5.6-sol");
      assert.equal(session.events[0].reasoningEffort, "xhigh");
      assert.equal(session.events[0].phase, "final_answer");
      assert.equal(session.events[0].turnId, "turn-provenance");
    },
  },
  {
    name: "enriches a restored flattened message when rollout replay recovers its formatting",
    run() {
      const store = new SessionStore();
      store.ingest({
        eventId: "formatted-message",
        source: "rollout",
        sessionId: "thread-formatted",
        kind: "assistant_message",
        at: "2026-08-24T12:00:00.000Z",
        message: { role: "assistant", text: "Summary - first - second" },
      });
      store.ingest({
        eventId: "formatted-message",
        source: "rollout",
        sessionId: "thread-formatted",
        kind: "assistant_message",
        at: "2026-08-24T12:00:00.000Z",
        message: { role: "assistant", text: "Summary\n\n- first\n- second" },
      });
      const detail = store.get("thread-formatted");
      assert.equal(detail.events.length, 1);
      assert.equal(detail.events[0].message.text, "Summary\n\n- first\n- second");
    },
  },
  {
    name: "restores a legacy truncated reply when rollout replay finds its full text",
    run() {
      const store = new SessionStore();
      const fullReply = `完整回复开始\n\n${"这是过去被截断、现在应当恢复的正文。".repeat(180)}\n\n完整回复结束`;
      const legacyReply = `${fullReply.slice(0, 1_999)}…`;
      assert.equal(legacyReply.length, 2_000);
      store.ingest({
        eventId: "legacy-truncated-message",
        source: "rollout",
        sessionId: "thread-legacy-reply",
        kind: "assistant_message",
        at: "2026-08-24T12:00:00.000Z",
        message: { role: "assistant", text: legacyReply },
      });
      store.ingest({
        eventId: "legacy-truncated-message",
        source: "rollout",
        sessionId: "thread-legacy-reply",
        kind: "assistant_message",
        at: "2026-08-24T12:00:00.000Z",
        message: { role: "assistant", text: fullReply },
      });
      const detail = store.get("thread-legacy-reply");
      assert.equal(detail.events.length, 1);
      assert.equal(detail.events[0].message.text, fullReply);
      assert.match(detail.events[0].message.text, /完整回复结束$/);
    },
  },
  {
    name: "deduplicates equivalent rollout messages without suppressing another source",
    run() {
      const store = new SessionStore();
      const first = {
        eventId: "rollout-message-event",
        source: "rollout",
        sessionId: "thread-message-dedupe",
        kind: "assistant_message",
        at: "2026-08-24T12:00:00.000Z",
        message: { role: "assistant", text: "The task is complete" },
      };
      store.ingest(first);
      store.ingest({ ...first, eventId: "rollout-response-item", at: "2026-08-24T12:00:00.500Z" });
      store.ingest({ ...first, eventId: "hook-message", source: "hook", at: "2026-08-24T12:00:00.600Z" });
      const detail = store.get("thread-message-dedupe");
      assert.equal(detail.events.length, 2);
      assert.deepEqual(detail.events.map((event) => event.eventId), ["rollout-message-event", "hook-message"]);
    },
  },
  {
    name: "deduplicates a delayed task_complete reply without crossing a turn boundary",
    run() {
      const store = new SessionStore();
      const first = {
        eventId: "response-item-message",
        source: "rollout",
        sessionId: "thread-delayed-message-dedupe",
        kind: "assistant_message",
        at: "2026-08-24T12:00:00.000Z",
        message: { role: "assistant", text: "The task is complete" },
      };
      store.ingest(first);
      store.ingest({ eventId: "tool-finished", source: "rollout", sessionId: first.sessionId, kind: "tool_end", at: "2026-08-24T12:00:05.000Z" });
      store.ingest({ ...first, eventId: "task-complete-copy", turnId: "turn-one", at: "2026-08-24T12:00:12.000Z" });

      let detail = store.get(first.sessionId);
      assert.deepEqual(detail.events.filter((event) => event.kind === "assistant_message").map((event) => event.eventId), ["response-item-message"]);
      assert.equal(detail.events.find((event) => event.eventId === "response-item-message").turnId, "turn-one");

      store.ingest({ eventId: "turn-one-done", source: "rollout", sessionId: first.sessionId, kind: "turn_complete", turnId: "turn-one", at: "2026-08-24T12:00:13.000Z" });
      store.ingest({ eventId: "turn-two-start", source: "rollout", sessionId: first.sessionId, kind: "turn_start", turnId: "turn-two", at: "2026-08-24T12:00:14.000Z" });
      store.ingest({ ...first, eventId: "same-text-next-turn", turnId: "turn-two", at: "2026-08-24T12:00:15.000Z" });
      detail = store.get(first.sessionId);
      assert.deepEqual(detail.events.filter((event) => event.kind === "assistant_message").map((event) => event.eventId), ["response-item-message", "same-text-next-turn"]);
    },
  },
  {
    name: "classifies subagents and tests without exposing generic phone input",
    run() {
      const store = new SessionStore();
      const context = createRolloutContext("/tmp/rollout-child.jsonl");
      const metadata = normalizeRolloutRecord({
        type: "session_meta",
        timestamp: "2026-08-23T12:00:00Z",
        payload: {
          id: "child-thread",
          session_id: "parent-thread",
          cwd: "/repo",
          model: "codex-auto-review",
          source: { subagent: { other: "guardian" } },
          thread_source: "subagent",
        },
      }, context)[0];
      store.ingest(metadata);
      store.ingest({ eventId: "child-done", sessionId: "child-thread", kind: "turn_complete", at: "2026-08-23T12:01:00Z", transcriptPath: "/tmp/rollout-child.jsonl" });
      store.ingest({ eventId: "smoke", sessionId: "phone-control-smoke-1", kind: "turn_complete", at: "2026-08-23T12:02:00Z", cwd: "/tmp/smoke-test", transcriptPath: "/tmp/smoke.jsonl" });
      store.ingest({ eventId: "real-smoke-user", sessionId: "real-codex-thread-id", kind: "user_prompt", at: "2026-08-23T12:03:00Z", cwd: "/repo", message: { role: "user", text: "A synthetic prompt" } });
      store.ingest({ eventId: "real-smoke-end", source: "phone-control-smoke", sessionId: "real-codex-thread-id", kind: "session_end", at: "2026-08-23T12:04:00Z", cwd: "/repo" });
      store.ingest({ eventId: "legacy-hook-timing", source: "hook", sessionId: "hook-timing", kind: "user_prompt", at: "2026-08-23T12:05:00Z", cwd: "/tmp", message: { role: "user", text: "timing test" } });
      store.setBridgeState({ connected: true });

      const child = store.get("child-thread");
      assert.equal(child.taskKind, "internal");
      assert.equal(child.parentThreadId, "parent-thread");
      assert.equal(child.hiddenFromTasks, true);
      assert.equal(child.control.canSend, false);
      assert.equal(store.get("phone-control-smoke-1").taskKind, "test");
      assert.equal(store.get("real-codex-thread-id").taskKind, "test");
      assert.equal(store.get("real-codex-thread-id").hiddenFromTasks, true);
      assert.equal(store.get("hook-timing").taskKind, "test");
      assert.equal(store.get("hook-timing").hiddenFromTasks, true);
      assert.equal("testEvidence" in store.get("real-codex-thread-id"), false);
    },
  },
  {
    name: "moves lifecycle-only Session End records out of the user task list",
    run() {
      const store = new SessionStore();
      store.ingest({ eventId: "empty-start", sessionId: "empty-lifecycle", kind: "session_start", at: "2026-08-23T12:00:00Z", cwd: "/repo", surface: "CLI" });
      store.ingest({ eventId: "empty-end", sessionId: "empty-lifecycle", kind: "session_end", at: "2026-08-23T12:00:01Z", cwd: "/repo", surface: "CLI" });
      store.ingest({ eventId: "real-user", sessionId: "real-session", kind: "user_prompt", at: "2026-08-23T12:00:02Z", cwd: "/repo", message: { role: "user", text: "Keep this session" } });
      store.ingest({ eventId: "real-end", sessionId: "real-session", kind: "session_end", at: "2026-08-23T12:00:03Z", cwd: "/repo" });
      assert.equal(store.get("empty-lifecycle").taskKind, "diagnostic");
      assert.equal(store.get("empty-lifecycle").hiddenFromTasks, true);
      assert.equal(store.get("real-session").taskKind, "user");
      assert.equal(store.get("real-session").hiddenFromTasks, false);
    },
  },
  {
    name: "hides promptless active sessions but keeps promptless approvals actionable",
    run() {
      const store = new SessionStore();
      store.ingest({
        eventId: "empty-active",
        sessionId: "empty-active-session",
        kind: "session_start",
        at: "2026-08-23T12:00:00Z",
        cwd: "/repo",
        surface: "CLI",
      });
      store.ingest({
        eventId: "actionable-approval",
        sessionId: "actionable-without-prompt",
        turnId: "turn-actionable",
        kind: "permission_request",
        at: "2026-08-23T12:00:01Z",
        tool: { name: "Bash", summary: "npm publish" },
        approval: { id: "approval-actionable", expiresAt: "2026-08-23T12:01:00Z" },
      });

      assert.equal(store.get("empty-active-session").status, "working");
      assert.equal(store.get("empty-active-session").taskKind, "diagnostic");
      assert.equal(store.get("empty-active-session").hiddenFromTasks, true);
      assert.equal(store.get("actionable-without-prompt").taskKind, "user");
      assert.equal(store.get("actionable-without-prompt").hiddenFromTasks, false);
    },
  },
  {
    name: "rollout metadata enriches a session without changing its last activity",
    run() {
      const store = new SessionStore();
      store.ingest({ eventId: "later", sessionId: "thread-meta", kind: "turn_complete", at: "2026-08-23T12:05:00Z", transcriptPath: "/tmp/thread-meta.jsonl" });
      store.ingest({ eventId: "metadata", sessionId: "thread-meta", kind: "session_metadata", at: "2026-08-23T12:00:00Z", cwd: "/repo" });
      assert.equal(store.get("thread-meta").updatedAt, "2026-08-23T12:05:00.000Z");
      assert.equal(store.get("thread-meta").cwd, "/repo");
    },
  },
  {
    name: "retains conversation messages ahead of noisy tool history",
    run() {
      const store = new SessionStore();
      store.ingest({
        eventId: "history-message",
        sessionId: "thread-history",
        kind: "user_prompt",
        at: "2026-08-23T12:00:00Z",
        transcriptPath: "/tmp/thread-history.jsonl",
        message: { role: "user", text: "Keep this important message" },
      });
      for (let index = 0; index < 300; index += 1) {
        store.ingest({ eventId: `tool-start-${index}`, sessionId: "thread-history", kind: "tool_start", at: `2026-08-23T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`, tool: { name: "exec" } });
        store.ingest({ eventId: `tool-end-${index}`, sessionId: "thread-history", kind: "tool_end", at: `2026-08-23T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`, tool: { name: "exec" } });
      }
      const history = store.get("thread-history");
      assert.equal(history.events.length, 240);
      assert.equal(history.events.some((event) => event.eventId === "history-message"), true);
      const message = history.events.find((event) => event.eventId === "history-message");
      assert.deepEqual(Object.keys(message).sort(), ["at", "eventId", "kind", "message"]);
      assert.equal(message.source, undefined);
      assert.equal(history.historyTruncated, true);
      assert.equal(history.hasTranscript, true);
      assert.equal(history.transcriptPath, undefined);
    },
  },
  {
    name: "compares tokens safely and parses cookies",
    run() {
      assert.equal(tokenMatches("secret", "secret"), true);
      assert.equal(tokenMatches("short", "a-long-secret"), false);
      assert.equal(parseCookies("a=1; phone_control_token=hello%20world").phone_control_token, "hello world");
    },
  },
];
