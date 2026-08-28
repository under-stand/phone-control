import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { RolloutScanner } from "../src/rollout-scanner.mjs";

export const tests = [
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
