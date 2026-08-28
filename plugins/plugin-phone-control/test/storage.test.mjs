import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { DeviceStore } from "../src/device-store.mjs";
import { SessionStore } from "../src/session-store.mjs";

export const tests = [
  {
    name: "keeps the first meaningful task goal stable across follow-up turns and exposes searchable semantics",
    async run() {
      const store = new SessionStore({ machineName: "devbox-03" });
      store.ingest({
        eventId: "generic-first",
        source: "hook",
        sessionId: "semantic-session",
        kind: "user_prompt",
        at: "2026-08-28T01:00:00.000Z",
        cwd: "/workspace/phone-control",
        message: { role: "user", text: "好的，去做吧" },
      });
      store.ingest({
        eventId: "real-goal",
        source: "hook",
        sessionId: "semantic-session",
        kind: "user_prompt",
        at: "2026-08-28T01:01:00.000Z",
        message: { role: "user", text: "增加稳定的任务标题和历史检索" },
      });
      store.ingest({
        eventId: "assistant-search-result",
        source: "rollout",
        sessionId: "semantic-session",
        kind: "assistant_message",
        at: "2026-08-28T01:02:00.000Z",
        message: { role: "assistant", text: "已经建立本地全文索引" },
      });
      store.ingest({
        eventId: "later-follow-up",
        source: "hook",
        sessionId: "semantic-session",
        kind: "user_prompt",
        at: "2026-08-28T01:03:00.000Z",
        message: { role: "user", text: "再优化一下颜色" },
      });

      const summary = store.list({ taskKind: "user" })[0];
      assert.equal(summary.task.title, "增加稳定的任务标题和历史检索");
      assert.equal(summary.task.goal, "增加稳定的任务标题和历史检索");
      assert.equal(summary.firstUserMessage, undefined);
      assert.equal(summary.taskGoalMessage, undefined);
      const results = store.search({ query: "全文索引" });
      assert.deepEqual(results.map((item) => item.id), ["semantic-session"]);
      assert.equal(results[0].match.eventId, "assistant-search-result");
    },
  },
  {
    name: "persists manual task titles and restores automatic naming",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-task-title-"));
      const taskTitlesPath = path.join(dataDir, "task-titles.json");
      try {
        const first = new SessionStore({ taskTitlesPath });
        await first.restore();
        first.ingest({
          eventId: "title-prompt",
          sessionId: "title-session",
          kind: "user_prompt",
          at: "2026-08-28T01:00:00.000Z",
          message: { role: "user", text: "改进会话标题生成" },
        });
        const renamed = await first.setTaskTitle("title-session", "手动产品标题");
        assert.equal(renamed.task.title, "手动产品标题");
        assert.equal(renamed.task.autoTitle, "改进会话标题生成");

        const restored = new SessionStore({ taskTitlesPath });
        await restored.restore();
        restored.ingest({
          eventId: "title-prompt-restored",
          sessionId: "title-session",
          kind: "user_prompt",
          at: "2026-08-28T01:00:00.000Z",
          message: { role: "user", text: "改进会话标题生成" },
        });
        assert.equal(restored.list()[0].task.title, "手动产品标题");
        const automatic = await restored.setTaskTitle("title-session", null);
        assert.equal(automatic.task.title, "改进会话标题生成");
        assert.equal(automatic.task.customTitle, null);
        assert.deepEqual(JSON.parse(await readFile(taskTitlesPath, "utf8")).titles, {});
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "bounds revoked device tombstones and can purge them without touching active devices",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-device-cleanup-"));
      const filePath = path.join(dataDir, "devices.json");
      try {
        const devices = new DeviceStore({ filePath });
        await devices.restore();
        const active = devices.pair({ name: "Keep me" });
        for (let index = 0; index < 28; index += 1) {
          const paired = devices.pair({ name: `Old phone ${index}` });
          assert.equal(devices.revoke(paired.device.id), true);
        }
        assert.deepEqual(devices.counts(), { active: 1, revoked: 20, total: 21 });
        await devices.flush();

        const restored = new DeviceStore({ filePath });
        await restored.restore();
        assert.deepEqual(restored.counts(), { active: 1, revoked: 20, total: 21 });
        assert.equal(restored.isActive(active.device.id), true);
        assert.equal(restored.purgeRevoked(), 20);
        assert.deepEqual(restored.counts(), { active: 1, revoked: 0, total: 1 });
        await restored.flush();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "persists a private target session per paired device",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-device-target-"));
      const filePath = path.join(dataDir, "devices.json");
      try {
        const devices = new DeviceStore({ filePath });
        await devices.restore();
        const first = devices.pair({ name: "First phone" });
        const second = devices.pair({ name: "Second phone" });
        devices.setTarget(first.device.id, "thread-a");
        assert.equal(devices.target(first.device.id), "thread-a");
        assert.equal(devices.target(second.device.id), null);
        assert.deepEqual(devices.notificationRecipients("thread-a", { includeUntargeted: true }).sort(), [first.device.id, second.device.id].sort());
        assert.deepEqual(devices.notificationRecipients("thread-b", { includeUntargeted: false }), []);
        assert.equal("targetSessionId" in devices.list()[0], false);
        await devices.flush();

        const restored = new DeviceStore({ filePath });
        await restored.restore();
        assert.equal(restored.target(first.device.id), "thread-a");
        assert.equal(JSON.parse(await readFile(filePath, "utf8")).version, 2);
        assert.equal(restored.clearTargetSession("thread-a"), true);
        assert.equal(restored.target(first.device.id), null);
        await restored.flush();
        const cleared = new DeviceStore({ filePath });
        await cleared.restore();
        assert.equal(cleared.target(first.device.id), null);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "migrates version 1 config without rotating the bootstrap token",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-config-"));
      try {
        await writeFile(path.join(dataDir, "config.json"), `${JSON.stringify({
          version: 1,
          host: "127.0.0.1",
          port: 8787,
          token: "keep-this-token",
        })}\n`, { mode: 0o600 });
        const config = await loadConfig({ environment: { PHONE_CONTROL_DATA_DIR: dataDir } });
        assert.equal(config.version, 4);
        assert.equal(config.token, "keep-this-token");
        assert.equal(config.approvals.enabled, false);
        assert.equal(config.interactions.enabled, true);
        assert.equal(config.interactions.transport, "auto");
        assert.equal(config.codexCommand, "codex");
        const stored = JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8"));
        assert.equal(stored.version, 4);
        assert.equal(stored.retentionDays, 14);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "persists an explicit Codex executable and app-server transport",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-config-transport-"));
      try {
        const config = await loadConfig({
          environment: {
            PHONE_CONTROL_DATA_DIR: dataDir,
            PHONE_CONTROL_CODEX_COMMAND: "C:\\Tools\\Codex\\codex.exe",
            PHONE_CONTROL_APP_SERVER_TRANSPORT: "stdio",
          },
        });
        assert.equal(config.codexCommand, "C:\\Tools\\Codex\\codex.exe");
        assert.equal(config.interactions.transport, "stdio");

        const restored = await loadConfig({ environment: { PHONE_CONTROL_DATA_DIR: dataDir } });
        assert.equal(restored.codexCommand, "C:\\Tools\\Codex\\codex.exe");
        assert.equal(restored.interactions.transport, "stdio");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "compacts expired event rows while restoring recent sessions",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-retention-"));
      const eventLogPath = path.join(dataDir, "events.jsonl");
      try {
        const old = { eventId: "old", sessionId: "old-session", kind: "turn_start", at: "2020-01-01T00:00:00.000Z" };
        const recent = { eventId: "recent", sessionId: "recent-session", kind: "turn_start", at: new Date().toISOString() };
        await writeFile(eventLogPath, `${JSON.stringify(old)}\n${JSON.stringify(recent)}\nnot-json\n`, { mode: 0o600 });
        const store = new SessionStore({ eventLogPath, retentionDays: 14, maxEventLogBytes: 1024 * 1024 });
        await store.restore();
        assert.deepEqual(store.list().map((session) => session.id), ["recent-session"]);
        const compacted = await readFile(eventLogPath, "utf8");
        assert.equal(compacted.includes("old-session"), false);
        assert.equal(compacted.includes("not-json"), false);
        assert.equal(compacted.includes("recent-session"), true);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "persists a deletion tombstone so removed Codex sessions do not return after restart",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-session-delete-"));
      const eventLogPath = path.join(dataDir, "events.jsonl");
      try {
        const store = new SessionStore({ eventLogPath });
        store.ingest({
          eventId: "deleted-session-prompt",
          sessionId: "deleted-session",
          kind: "user_prompt",
          at: new Date().toISOString(),
          message: { role: "user", text: "This session will be deleted" },
        });
        assert.ok(store.get("deleted-session"));
        assert.equal(store.remove("deleted-session"), true);
        assert.equal(store.get("deleted-session"), null);
        store.ingest({
          eventId: "deleted-session-late-event",
          sessionId: "deleted-session",
          kind: "assistant_message",
          at: new Date().toISOString(),
          message: { role: "assistant", text: "Late scanner event" },
        });
        assert.equal(store.get("deleted-session"), null);
        await store.flush();

        const restored = new SessionStore({ eventLogPath });
        await restored.restore();
        assert.equal(restored.get("deleted-session"), null);
        assert.match(await readFile(eventLogPath, "utf8"), /session_deleted/);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "does not restore an expired approval as a live waiting action",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-expired-wait-"));
      const eventLogPath = path.join(dataDir, "events.jsonl");
      try {
        const at = new Date(Date.now() - 120_000).toISOString();
        const expiresAt = new Date(Date.now() - 60_000).toISOString();
        await writeFile(eventLogPath, `${JSON.stringify({
          eventId: "expired-approval",
          sessionId: "expired-session",
          kind: "permission_request",
          at,
          transcriptPath: "/tmp/expired-session.jsonl",
          approval: { id: "approval-expired", expiresAt },
        })}\n`, { mode: 0o600 });
        const store = new SessionStore({ eventLogPath, staleAfterMs: 60_000 });
        await store.restore();
        store.setBridgeState({ connected: true });
        const session = store.get("expired-session");
        assert.equal(session.status, "unknown");
        assert.equal(session.pendingApproval, null);
        assert.equal(session.control.canApprove, false);
        assert.equal(session.control.canSend, false);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "filters persisted Codex-injected user context without rewriting audit history",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-context-migration-"));
      const eventLogPath = path.join(dataDir, "events.jsonl");
      try {
        const at = new Date().toISOString();
        const injected = {
          eventId: "injected-context",
          source: "rollout",
          sessionId: "context-session",
          kind: "user_prompt",
          at,
          message: { role: "user", text: "<recommended_plugins>\n- GitHub\n</recommended_plugins><environment_context>\n  <cwd>/private/repo</cwd>\n</environment_context>" },
        };
        const visible = {
          eventId: "visible-prompt",
          source: "rollout",
          sessionId: "context-session",
          kind: "user_prompt",
          at,
          message: { role: "user", text: "Please inspect the actual task" },
        };
        await writeFile(eventLogPath, `${JSON.stringify(injected)}\n${JSON.stringify(visible)}\n`, { mode: 0o600 });
        const store = new SessionStore({ eventLogPath });
        await store.restore();

        assert.deepEqual(store.get("context-session").events.map((event) => event.message?.text), ["Please inspect the actual task"]);
        const compacted = await readFile(eventLogPath, "utf8");
        assert.equal(compacted.includes("recommended_plugins"), true);
        assert.equal(compacted.includes("Please inspect the actual task"), true);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "batches persistence and compacts equivalent rollout message records",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-message-dedupe-"));
      const eventLogPath = path.join(dataDir, "events.jsonl");
      try {
        const first = {
          eventId: "message-event",
          source: "rollout",
          sessionId: "message-session",
          kind: "user_prompt",
          at: "2026-08-24T12:00:00.000Z",
          message: { role: "user", text: "Run the same task" },
        };
        await writeFile(eventLogPath, `${JSON.stringify(first)}\n${JSON.stringify({ ...first, eventId: "message-item", at: "2026-08-24T12:00:00.400Z" })}\n`, { mode: 0o600 });
        const store = new SessionStore({ eventLogPath });
        await store.restore();
        store.ingest({ eventId: "later", sessionId: "message-session", kind: "turn_complete", at: new Date().toISOString() });
        await store.flush();
        const rows = (await readFile(eventLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(rows.filter((event) => event.kind === "user_prompt").length, 1);
        assert.equal(rows.some((event) => event.eventId === "later"), true);
        assert.equal(store.get("message-session").events.filter((event) => event.kind === "user_prompt").length, 1);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
];
