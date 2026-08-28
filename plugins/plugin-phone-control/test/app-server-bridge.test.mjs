import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { CodexAppServerBridge } from "../src/app-server-bridge.mjs";

function transportHarness({
  loadedThreads = ["thread-live"],
  runtimeByThread = {},
  resumeErrors = {},
  ignoreExcludeTurnsFor = [],
} = {}) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const sent = [];
  let buffer = "";
  let createdThreadIndex = 0;
  writable.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      sent.push(message);
      if (message.method === "initialize" && message.id != null) {
        readable.write(`${JSON.stringify({
          id: message.id,
          result: { codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux", userAgent: "test" },
        })}\n`);
      }
      if (message.method === "thread/loaded/list" && message.id != null) {
        readable.write(`${JSON.stringify({ id: message.id, result: { data: loadedThreads, nextCursor: null } })}\n`);
      }
      if (message.method === "account/read" && message.id != null) {
        readable.write(`${JSON.stringify({
          id: message.id,
          result: { account: { type: "chatgpt", email: "mobile.user@example.com", planType: "pro" }, requiresOpenaiAuth: true },
        })}\n`);
      }
      if (message.method === "account/rateLimits/read" && message.id != null) {
        readable.write(`${JSON.stringify({
          id: message.id,
          result: {
            rateLimits: {
              limitId: "codex",
              limitName: null,
              primary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: 1787816016 },
            },
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                limitName: null,
                primary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: 1787816016 },
              },
            },
            rateLimitResetCredits: { availableCount: 1 },
          },
        })}\n`);
      }
      if (message.method === "config/read" && message.id != null) {
        readable.write(`${JSON.stringify({
          id: message.id,
          result: {
            config: {
              model: "gpt-test",
              model_reasoning_effort: "high",
              service_tier: "fast",
              approvals_reviewer: "auto_review",
              sandbox_mode: "workspace-write",
            },
            origins: {},
          },
        })}\n`);
      }
      if (message.method === "model/list" && message.id != null) {
        readable.write(`${JSON.stringify({
          id: message.id,
          result: {
            data: [{
              id: "gpt-test",
              displayName: "GPT Test",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }, { reasoningEffort: "xhigh", description: "Deeper" }],
              serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
              defaultServiceTier: null,
              inputModalities: ["text", "image"],
              isDefault: true,
              hiddenSensitiveField: "must-not-leak",
            }, {
              id: "gpt-choice",
              displayName: "GPT Choice",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Light" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }],
              serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
              inputModalities: ["text", "image"],
              isDefault: false,
            }],
            nextCursor: null,
          },
        })}\n`);
      }
      if (message.method === "thread/resume" && message.id != null) {
        const resumeError = resumeErrors[message.params.threadId];
        if (resumeError) {
          readable.write(`${JSON.stringify({
            id: message.id,
            error: { code: -32600, message: resumeError },
          })}\n`);
          continue;
        }
        const runtime = runtimeByThread[message.params.threadId] || {};
        const turns = runtime.turns || [];
        const excludeTurns = message.params.excludeTurns && !ignoreExcludeTurnsFor.includes(message.params.threadId);
        const initialTurnsPage = message.params.initialTurnsPage
          ? {
            data: [...turns].reverse().slice(0, message.params.initialTurnsPage.limit || 1)
              .map((turn) => ({ ...turn, items: [] })),
            nextCursor: turns.length > 1 ? "next" : null,
          }
          : null;
        readable.write(`${JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: message.params.threadId,
              status: runtime.status || { type: "idle" },
              turns: excludeTurns ? [] : turns,
            },
            initialTurnsPage,
          },
        })}\n`);
      }
      if (message.method === "thread/start" && message.id != null) {
        createdThreadIndex += 1;
        const threadId = `thread-created-${createdThreadIndex}`;
        loadedThreads.push(threadId);
        runtimeByThread[threadId] = { status: { type: "idle" }, turns: [] };
        readable.write(`${JSON.stringify({
          id: message.id,
          result: { thread: { id: threadId, status: { type: "idle" }, turns: [] } },
        })}\n`);
      }
      if (message.method === "thread/delete" && message.id != null) {
        const threadId = message.params.threadId;
        const index = loadedThreads.indexOf(threadId);
        if (index >= 0) loadedThreads.splice(index, 1);
        delete runtimeByThread[threadId];
        readable.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        readable.write(`${JSON.stringify({ method: "thread/deleted", params: { threadId } })}\n`);
      }
      if (message.method === "turn/start" && message.id != null) {
        const turnId = `turn-started-${sent.filter((item) => item.method === "turn/start").length}`;
        runtimeByThread[message.params.threadId] = {
          status: { type: "active", activeFlags: [] },
          turns: [{ id: turnId, status: "inProgress", items: [] }],
        };
        readable.write(`${JSON.stringify({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } })}\n`);
      }
      if (message.method === "turn/steer" && message.id != null) {
        readable.write(`${JSON.stringify({ id: message.id, result: { turnId: message.params.expectedTurnId } })}\n`);
      }
      if (message.method === "turn/interrupt" && message.id != null) {
        readable.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
    }
  });
  const transport = {
    readable,
    writable,
    close() {
      readable.destroy();
      writable.destroy();
    },
  };
  return {
    sent,
    transportFactory: async () => transport,
    serverSend(message) {
      readable.write(`${JSON.stringify(message)}\n`);
    },
  };
}

export const tests = [
  {
    name: "initializes a quiet bridge and resumes only metadata plus the latest turn identity",
    async run() {
      const harness = transportHarness({
        runtimeByThread: {
          "thread-live": {
            status: { type: "active", activeFlags: [] },
            turns: [{ id: "turn-active", status: "inProgress", items: [{ type: "large-history-placeholder" }] }],
          },
        },
      });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      bridge.reconnectDelayMs = 8_000;
      try {
        assert.equal(await bridge.start(), true);
        const initialize = harness.sent.find((message) => message.method === "initialize");
        assert.equal(initialize.params.clientInfo.version, "0.7.0");
        assert.equal(initialize.params.capabilities.experimentalApi, true);
        assert.ok(initialize.params.capabilities.optOutNotificationMethods.includes("item/agentMessage/delta"));
        assert.ok(initialize.params.capabilities.optOutNotificationMethods.includes("item/completed"));
        assert.ok(!initialize.params.capabilities.optOutNotificationMethods.includes("turn/completed"));
        assert.equal(bridge.approvalConfiguration().approvalsReviewer, "auto_review");

        const resume = harness.sent.find((message) => message.method === "thread/resume");
        assert.deepEqual(resume.params, {
          threadId: "thread-live",
          excludeTurns: true,
          initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
        });
        assert.equal(bridge.status().threadStates["thread-live"].activeTurnId, "turn-active");
        assert.equal(bridge.reconnectDelayMs, 1_000);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "isolates an App Server that ignores metadata-only resume without retrying history",
    async run() {
      const harness = transportHarness({
        runtimeByThread: {
          "thread-live": { status: { type: "idle" }, turns: [{ id: "historical-turn", status: "completed", items: [] }] },
        },
        ignoreExcludeTurnsFor: ["thread-live"],
      });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
        subscriptionRetryMinMs: 0,
      });
      try {
        assert.equal(await bridge.start(), true);
        await bridge.refreshLoadedThreads();
        const resumes = harness.sent.filter((message) => message.method === "thread/resume");
        assert.equal(resumes.length, 1);
        assert.deepEqual(bridge.status().unavailableThreads, ["thread-live"]);
        assert.match(bridge.status().unavailableThreadReasons["thread-live"], /metadata-only resume/);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "quarantines one oversized subscription instead of repeatedly resuming it",
    async run() {
      const harness = transportHarness({ loadedThreads: [] });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        assert.equal(await bridge.start(), true);
        bridge.loadedThreads.add("thread-too-large");
        bridge.activeSubscriptionThreadId = "thread-too-large";
        bridge.handleDisconnect(Object.assign(new Error("WebSocket frame is too large"), {
          code: "ERR_WS_MESSAGE_TOO_LARGE",
        }));
        assert.deepEqual(bridge.status().unavailableThreads, ["thread-too-large"]);
        assert.match(bridge.status().unavailableThreadReasons["thread-too-large"], /oversized/);

        bridge.initialized = true;
        bridge.loadedThreads.add("thread-too-large");
        assert.equal(await bridge.subscribeThread("thread-too-large"), false);
        assert.equal(harness.sent.some((message) => message.method === "thread/resume"), false);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "keeps exponential reconnect backoff until a full subscription pass is healthy",
    async run() {
      const bridge = new CodexAppServerBridge({ reconnect: true });
      bridge.stopped = false;
      bridge.transport = { close() {} };
      bridge.connected = true;
      bridge.initialized = true;
      bridge.reconnectDelayMs = 4_000;
      bridge.handleDisconnect(new Error("connection failed during startup"));
      try {
        assert.equal(bridge.reconnectDelayMs, 8_000);
        assert.ok(bridge.reconnectTimer);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "returns a cached, minimized Codex status without exposing the account email",
    async run() {
      const harness = transportHarness();
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        assert.equal(await bridge.start(), true);
        const first = await bridge.codexStatus();
        const second = await bridge.codexStatus();
        assert.equal(first.available, true);
        assert.equal(first.account.email, "m…r@example.com");
        assert.equal(first.account.planType, "pro");
        assert.equal(first.configuration.model, "gpt-test");
        assert.equal(first.configuration.reasoningEffort, "high");
        assert.equal(first.usage.limits[0].primary.remainingPercent, 87.6);
        assert.equal(first.usage.resetCreditsAvailable, 1);
        assert.doesNotMatch(JSON.stringify(first), /mobile\.user@example\.com/);
        assert.deepEqual(second, first);
        assert.equal(harness.sent.filter((message) => message.method === "account/read").length, 1);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "returns a cached, minimized model catalog and validates reasoning effort",
    async run() {
      const harness = transportHarness();
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false, loadedThreadRefreshMs: 0 });
      try {
        await bridge.start();
        const first = await bridge.modelCatalog();
        const second = await bridge.modelCatalog();
        assert.equal(first.available, true);
        assert.equal(first.models[1].id, "gpt-choice");
        assert.deepEqual(first.models[1].supportedReasoningEfforts, ["low", "medium", "high"]);
        assert.equal(first.models[1].reasoningEffortDetails[1].description, "Balanced");
        assert.deepEqual(first.models[1].serviceTiers, [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]);
        assert.equal(JSON.stringify(first).includes("hiddenSensitiveField"), false);
        assert.deepEqual(second, first);
        assert.equal(harness.sent.filter((message) => message.method === "model/list").length, 1);
        await assert.rejects(
          bridge.validateModelSelection("gpt-choice", "xhigh"),
          (error) => error.statusCode === 409,
        );
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "starts an idle thread once without writing phone message text to audit",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-command-test-"));
      const auditLogPath = path.join(dataDir, "audit.jsonl");
      const harness = transportHarness({
        runtimeByThread: { "thread-live": { status: { type: "idle" }, turns: [] } },
      });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
        auditLogPath,
      });
      try {
        assert.equal(await bridge.start(), true);
        assert.equal(bridge.status().threadStates["thread-live"].status, "idle");
        const command = await bridge.sendInput({
          sessionId: "thread-live",
          expectedTurnId: null,
          clientMessageId: "phone-message-0001",
          text: "private phone instruction",
          model: "gpt-choice",
          reasoningEffort: "high",
          serviceTier: "priority",
        }, { id: "device-1", name: "Test phone" });
        assert.equal(command.action, "start");
        assert.equal(command.delivery, "delivered");
        assert.match(command.turnId, /^turn-started-/);
        const request = harness.sent.find((message) => message.method === "turn/start");
        assert.equal(request.params.input[0].text, "private phone instruction");
        assert.equal(request.params.clientUserMessageId, "phone-message-0001");
        assert.equal(request.params.model, "gpt-choice");
        assert.equal(request.params.effort, "high");
        assert.equal(request.params.serviceTier, "priority");
        assert.equal(command.model, "gpt-choice");
        assert.equal(command.reasoningEffort, "high");
        assert.equal(command.serviceTier, "priority");
        await assert.rejects(
          bridge.sendInput({
            sessionId: "thread-live",
            expectedTurnId: null,
            clientMessageId: "phone-message-0001",
            text: "private phone instruction",
          }),
          (error) => error.statusCode === 409,
        );
      } finally {
        await bridge.close();
      }
      const audit = await readFile(auditLogPath, "utf8");
      assert.match(audit, /phone_input_delivered/);
      assert.doesNotMatch(audit, /private phone instruction/);
      await rm(dataDir, { recursive: true, force: true });
    },
  },
  {
    name: "creates a fresh thread and permanently deletes it only after it is idle",
    async run() {
      const harness = transportHarness({ loadedThreads: [] });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        assert.equal(await bridge.start(), true);
        const created = await bridge.createSession({
          text: "Build the mobile feature",
          cwd: "/tmp",
          model: "gpt-choice",
          reasoningEffort: "high",
          serviceTier: "priority",
          clientMessageId: "phone-create-bridge-0001",
        }, { id: "device-1", name: "Test phone" });
        assert.equal(created.action, "create");
        assert.equal(created.sessionId, "thread-created-1");
        assert.equal(created.cwd, "/tmp");
        const startThread = harness.sent.find((message) => message.method === "thread/start");
        assert.deepEqual(startThread.params, { cwd: "/tmp", model: "gpt-choice", serviceTier: "priority", serviceName: "phone-control" });
        const startTurn = harness.sent.find((message) => message.method === "turn/start");
        assert.equal(startTurn.params.threadId, "thread-created-1");
        assert.equal(startTurn.params.input[0].text, "Build the mobile feature");
        assert.equal(startTurn.params.model, "gpt-choice");
        assert.equal(startTurn.params.effort, "high");
        assert.equal(startTurn.params.serviceTier, "priority");
        assert.equal(created.model, "gpt-choice");
        assert.equal(created.reasoningEffort, "high");
        assert.equal(created.serviceTier, "priority");
        await assert.rejects(
          bridge.deleteSession({ sessionId: created.sessionId }, { id: "device-1" }),
          /Stop the active Codex turn/,
        );
        harness.serverSend({
          method: "turn/completed",
          params: { threadId: created.sessionId, turn: { id: created.turnId, status: "completed" } },
        });
        await new Promise((resolve) => setImmediate(resolve));
        const deleted = await bridge.deleteSession({ sessionId: created.sessionId }, { id: "device-1" });
        assert.equal(deleted.status, "deleted");
        assert.equal(harness.sent.some((message) => message.method === "thread/delete" && message.params.threadId === created.sessionId), true);
        assert.equal(bridge.status().loadedThreads.includes(created.sessionId), false);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "steers only the exact verified active turn",
    async run() {
      const harness = transportHarness({
        runtimeByThread: {
          "thread-live": {
            status: { type: "active", activeFlags: [] },
            turns: [{ id: "turn-active", status: "inProgress", items: [] }],
          },
        },
      });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        await bridge.start();
        await assert.rejects(
          bridge.sendInput({
            sessionId: "thread-live",
            expectedTurnId: "turn-stale",
            clientMessageId: "phone-message-0002",
            text: "stale instruction",
          }),
          (error) => error.statusCode === 409,
        );
        assert.equal(harness.sent.some((message) => message.method === "turn/steer"), false);
        await assert.rejects(
          bridge.sendInput({
            sessionId: "thread-live",
            expectedTurnId: "turn-active",
            clientMessageId: "phone-message-model-steer",
            text: "change model mid-turn",
            model: "gpt-choice",
            reasoningEffort: "high",
          }),
          (error) => error.statusCode === 409 && /starting a new turn/.test(error.message),
        );
        assert.equal(harness.sent.some((message) => message.method === "turn/steer"), false);
        const command = await bridge.sendInput({
          sessionId: "thread-live",
          expectedTurnId: "turn-active",
          clientMessageId: "phone-message-0003",
          text: "focus on the failing test",
        });
        assert.equal(command.action, "steer");
        assert.equal(command.turnId, "turn-active");
        const request = harness.sent.find((message) => message.method === "turn/steer");
        assert.equal(request.params.expectedTurnId, "turn-active");
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "interrupts only the exact verified active turn and suppresses duplicate stop requests",
    async run() {
      const harness = transportHarness({
        runtimeByThread: {
          "thread-live": {
            status: { type: "active", activeFlags: [] },
            turns: [{ id: "turn-active", status: "inProgress", items: [] }],
          },
        },
      });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        await bridge.start();
        await assert.rejects(
          bridge.interruptTurn({ sessionId: "thread-live", expectedTurnId: "turn-stale" }),
          (error) => error.statusCode === 409,
        );
        assert.equal(harness.sent.some((message) => message.method === "turn/interrupt"), false);
        const operation = await bridge.interruptTurn({
          sessionId: "thread-live",
          expectedTurnId: "turn-active",
        }, { id: "device-1", name: "Test phone" });
        assert.equal(operation.action, "interrupt");
        assert.equal(operation.delivery, "delivered");
        const request = harness.sent.find((message) => message.method === "turn/interrupt");
        assert.deepEqual(request.params, { threadId: "thread-live", turnId: "turn-active" });
        assert.ok(bridge.status().threadStates["thread-live"].activeFlags.includes("interruptRequested"));
        await assert.rejects(
          bridge.interruptTurn({ sessionId: "thread-live", expectedTurnId: "turn-active" }),
          (error) => error.statusCode === 409,
        );
        assert.equal(harness.sent.filter((message) => message.method === "turn/interrupt").length, 1);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "sends uploaded images through the documented localImage input without auditing paths",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-image-command-test-"));
      const auditLogPath = path.join(dataDir, "audit.jsonl");
      const harness = transportHarness({ runtimeByThread: { "thread-live": { status: { type: "idle" }, turns: [] } } });
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false, loadedThreadRefreshMs: 0, auditLogPath });
      try {
        await bridge.start();
        const command = await bridge.sendInput({
          sessionId: "thread-live",
          clientMessageId: "phone-image-0001",
          text: "看看这张图",
          images: [{ path: "/private/uploads/phone-image.webp", mime: "image/webp" }],
        });
        assert.equal(command.imageCount, 1);
        const request = harness.sent.find((message) => message.method === "turn/start");
        assert.deepEqual(request.params.input, [
          { type: "text", text: "看看这张图" },
          { type: "localImage", path: "/private/uploads/phone-image.webp" },
        ]);
      } finally {
        await bridge.close();
      }
      const audit = await readFile(auditLogPath, "utf8");
      assert.match(audit, /"imageCount":1/);
      assert.doesNotMatch(audit, /private\/uploads/);
      await rm(dataDir, { recursive: true, force: true });
    },
  },
  {
    name: "resumes a stored idle thread before starting phone input",
    async run() {
      const runtimeByThread = {
        "thread-stored": { status: { type: "idle" }, turns: [{ id: "turn-old", status: "completed", items: [] }] },
      };
      const harness = transportHarness({ loadedThreads: [], runtimeByThread });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        await bridge.start();
        const command = await bridge.sendInput({
          sessionId: "thread-stored",
          expectedTurnId: null,
          clientMessageId: "phone-message-0004",
          text: "continue the stored session",
        });
        assert.equal(command.action, "start");
        const methods = harness.sent.map((message) => message.method);
        assert.ok(methods.indexOf("thread/resume") < methods.indexOf("turn/start"));
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "discovers and subscribes to threads loaded after bridge startup",
    async run() {
      const loadedThreads = [];
      const harness = transportHarness({ loadedThreads });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 10,
      });
      try {
        assert.equal(await bridge.start(), true);
        const subscribed = once(bridge, "subscribed");
        loadedThreads.push("thread-new");
        const [threadId] = await Promise.race([
          subscribed,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for thread subscription")), 1_000)),
        ]);
        assert.equal(threadId, "thread-new");
        assert.equal(bridge.status().subscribedThreads.includes("thread-new"), true);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "allows a creation grace period then stops retrying a permanently missing rollout",
    async run() {
      const harness = transportHarness({
        loadedThreads: ["thread-without-rollout"],
        resumeErrors: { "thread-without-rollout": "no rollout found for thread thread-without-rollout" },
      });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
        subscriptionRetryMinMs: 0,
      });
      const warnings = [];
      bridge.on("warning", (error) => warnings.push(error.message));
      try {
        assert.equal(await bridge.start(), true);
        await bridge.refreshLoadedThreads();
        await bridge.refreshLoadedThreads();
        await bridge.refreshLoadedThreads();
        await bridge.refreshLoadedThreads();
        const resumes = harness.sent.filter((message) => message.method === "thread/resume");
        assert.equal(resumes.length, 3);
        assert.equal(warnings.filter((message) => message.includes("Could not subscribe")).length, 1);
        assert.deepEqual(bridge.status().unavailableThreads, ["thread-without-rollout"]);
        assert.equal(bridge.status().retryingSubscriptions, 0);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "binds one request_user_input response to its live thread and turn",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-question-test-"));
      const auditLogPath = path.join(dataDir, "audit.jsonl");
      const harness = transportHarness();
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        auditLogPath,
      });
      try {
        assert.equal(await bridge.start(), true);
        assert.equal(bridge.status().loadedThreads.includes("thread-live"), true);
        assert.equal(bridge.status().subscribedThreads.includes("thread-live"), true);
        const questionEvent = once(bridge, "question");
        harness.serverSend({
          id: "rpc-question-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-live",
            turnId: "turn-live",
            itemId: "item-1",
            questions: [{
              id: "choice",
              header: "下一步",
              question: "继续部署吗？",
              options: [{ label: "继续", description: "开始部署" }, { label: "停止", description: "保持现状" }],
            }, {
              id: "secret",
              header: "口令",
              question: "请输入一次性口令",
              isSecret: true,
            }],
          },
        });
        const [interaction] = await questionEvent;
        assert.equal(interaction.sessionId, "thread-live");
        assert.equal(interaction.turnId, "turn-live");
        assert.equal(interaction.canRespond, true);
        assert.equal(Object.prototype.hasOwnProperty.call(interaction, "rpcId"), false);

        await assert.rejects(
          bridge.answer(interaction.id, {
            sessionId: "wrong-thread",
            turnId: "turn-live",
            answers: { choice: ["继续"], secret: ["private-value"] },
          }),
          (error) => error.statusCode === 409,
        );
        const delivered = await bridge.answer(interaction.id, {
          sessionId: "thread-live",
          turnId: "turn-live",
          answers: { choice: ["继续"], secret: ["private-value"] },
        }, { id: "device-1", name: "Test phone" });
        assert.equal(delivered.delivery, "delivered");
        const response = harness.sent.find((message) => message.id === "rpc-question-1" && message.result);
        assert.deepEqual(response.result, {
          answers: {
            choice: { answers: ["继续"] },
            secret: { answers: ["private-value"] },
          },
        });
        await assert.rejects(
          bridge.answer(interaction.id, {
            sessionId: "thread-live",
            turnId: "turn-live",
            answers: { choice: ["继续"], secret: ["private-value"] },
          }),
          (error) => error.statusCode === 409,
        );
      } finally {
        await bridge.close();
      }
      const audit = await readFile(auditLogPath, "utf8");
      assert.doesNotMatch(audit, /private-value/);
      assert.match(audit, /answer_delivered/);
      await rm(dataDir, { recursive: true, force: true });
    },
  },
  {
    name: "rejects free-form values when a question only allows displayed options",
    async run() {
      const harness = transportHarness();
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false });
      try {
        await bridge.start();
        const questionEvent = once(bridge, "question");
        harness.serverSend({
          id: 99,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-live",
            turnId: "turn-live",
            itemId: "item-2",
            questions: [{
              id: "choice",
              header: "选择",
              question: "请选择",
              options: [{ label: "A", description: "Option A" }],
            }],
          },
        });
        const [interaction] = await questionEvent;
        await assert.rejects(
          bridge.answer(interaction.id, {
            sessionId: "thread-live",
            turnId: "turn-live",
            answers: { choice: ["B"] },
          }),
          (error) => error.statusCode === 400,
        );
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "disables a phone form when another Codex client resolves the same request",
    async run() {
      const harness = transportHarness();
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false });
      try {
        await bridge.start();
        const questionEvent = once(bridge, "question");
        harness.serverSend({
          id: "shared-request",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-live",
            turnId: "turn-live",
            itemId: "item-shared",
            questions: [{ id: "choice", header: "选择", question: "请选择" }],
          },
        });
        const [interaction] = await questionEvent;
        const unavailableEvent = once(bridge, "unavailable");
        harness.serverSend({
          method: "serverRequest/resolved",
          params: { requestId: "shared-request", threadId: "thread-live" },
        });
        const [unavailable] = await unavailableEvent;
        assert.equal(unavailable.id, interaction.id);
        assert.equal(unavailable.canRespond, false);
        assert.match(unavailable.unavailableReason, /另一台/);
        await assert.rejects(
          bridge.answer(interaction.id, {
            sessionId: "thread-live",
            turnId: "turn-live",
            answers: { choice: ["继续"] },
          }),
          (error) => error.statusCode === 409,
        );
      } finally {
        await bridge.close();
      }
    },
  },
];
