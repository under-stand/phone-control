import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { RolloutScanner } from "../src/rollout-scanner.mjs";

export const tests = [
  {
    name: "drops execution turn context across bounded rollout scan gaps",
    async run() {
      const root = await mkdtemp(path.join(os.tmpdir(), "phone-control-scanner-gap-"));
      const rollout = path.join(root, "rollout-gap.jsonl");
      const line = (type, payload) => JSON.stringify({ timestamp: "2026-08-23T12:00:00Z", type, payload });
      const filler = `${line("ignored", { padding: "x".repeat(1024) })}\n`.repeat(2200);
      const message = (text) => line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: "model-request" } });
      await writeFile(rollout, `${line("session_meta", { id: "thread-gap", source: "cli" })}\n${line("event_msg", { type: "task_started", turn_id: "turn-header" })}\n${filler}${message("Initial tail")}\n`);
      const scanner = new RolloutScanner({ sessionsDir: root });
      const events = [];
      scanner.on("event", event => events.push(event));
      try {
        await scanner.scanOnce();
        assert.equal(events.at(-1).turnId, null);
        await appendFile(rollout, `${line("turn_context", { turn_id: "turn-live" })}\n${message("Live tail")}\n`);
        await scanner.scanOnce();
        assert.equal(events.at(-1).turnId, "turn-live");
        await appendFile(rollout, `${filler}${message("After overflow")}\n`);
        await scanner.scanOnce();
        assert.equal(events.at(-1).turnId, null);
      } finally {
        scanner.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "discovers a rollout and tails only newly appended records",
    async run() {
      const root = await mkdtemp(path.join(os.tmpdir(), "phone-control-scanner-"));
      const sessions = path.join(root, "sessions", "2026", "08", "23");
      const rollout = path.join(sessions, "rollout-2026-08-23-thread.jsonl");
      await mkdir(sessions, { recursive: true });
      await writeFile(rollout, [
        JSON.stringify({ timestamp: "2026-08-23T12:00:00Z", type: "session_meta", payload: { id: "thread-1", cwd: "/repo", source: "vscode" } }),
        JSON.stringify({ timestamp: "2026-08-23T12:00:01Z", type: "event_msg", payload: { type: "task_started" } }),
        "",
      ].join("\n"));

      const scanner = new RolloutScanner({ sessionsDir: path.join(root, "sessions") });
      const events = [];
      scanner.on("event", (event) => events.push(event));
      try {
        await scanner.scanOnce();
        assert.equal(events.length, 2);
        assert.equal(events[0].kind, "session_metadata");
        assert.equal(events[1].kind, "turn_start");
        assert.equal(events[1].surface, "Desktop");

        await appendFile(rollout, `${JSON.stringify({ timestamp: "2026-08-23T12:00:02Z", type: "event_msg", payload: { type: "task_complete" } })}\n`);
        await scanner.scanOnce();
        assert.equal(events.length, 3);
        assert.equal(events[2].kind, "turn_complete");
      } finally {
        scanner.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
  },
];
