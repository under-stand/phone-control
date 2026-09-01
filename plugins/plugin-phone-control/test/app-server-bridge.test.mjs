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
  resumeDelayMs = 0,
} = {}) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const sent = [];
  let buffer = "";
  let createdThreadIndex = 0;
  let activeResumes = 0;
  let maxActiveResumes = 0;
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
      if (message.method === "thread/read" && message.id != null) {
        const runtime = runtimeByThread[message.params.threadId] || {};
        readable.write(`${JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: message.params.threadId,
              status: runtime.readStatus || { type: "notLoaded" },
              turns: message.params.includeTurns === false ? [] : runtime.turns || [],
            },
          },
        })}\n`);
      }
      if (message.method === "thread/resume" && message.id != null) {
        const resumeError = resumeErrors[message.params.threadId];
        const finishResume = () => {
          activeResumes -= 1;
          if (resumeError) {
            readable.write(`${JSON.stringify({
              id: message.id,
              error: { code: -32600, message: resumeError },
            })}\n`);
            return;
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
        };
        activeResumes += 1;
        maxActiveResumes = Math.max(maxActiveResumes, activeResumes);
        if (resumeDelayMs > 0) setTimeout(finishResume, resumeDelayMs);
        else finishResume();
        continue;
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
      if (message.method === "thread/unsubscribe" && message.id != null) {
        readable.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
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
    get maxActiveResumes() { return maxActiveResumes; },
    transportFactory: async () => transport,
    serverSend(message) {
      readable.write(`${JSON.stringify(message)}\n`);
    },
  };
}

function managedTransportSequence(sourceOptions) {
  const sources = sourceOptions.map((options) => transportHarness(options));
  let factoryCalls = 0;
  return {
    sources,
    get factoryCalls() { return factoryCalls; },
    async transportFactory() {
      const source = sources[factoryCalls++];
      if (!source) throw new Error("Unexpected extra managed App Server transport");
      const transport = await source.transportFactory();
      let resolveClosed;
      const closed = new Promise((resolve) => { resolveClosed = resolve; });
      return {
        ...transport,
        kind: "managed-stdio",
        closed,
        close() {
          transport.close();
          resolveClosed({ code: 0, signal: null });
        },
      };
    },
  };
}

function managedHandoffHarness() {
  return managedTransportSequence([
    { loadedThreads: ["thread-live", "thread-idle-2"] },
    { loadedThreads: [] },
  ]);
}

export const tests = [
  {
    name: "passes cross-platform transport settings into the App Server connection",
    async run() {
      const harness = transportHarness({ loadedThreads: [] });
      let options = null;
      const bridge = new CodexAppServerBridge({
        socketPath: "C:\\Users\\Me\\.codex\\app-server.sock",
        codexCommand: "C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd",
        transportMode: "stdio",
        platform: "win32",
        transportFactory: async (received) => {
          options = received;
          return { ...(await harness.transportFactory()), kind: "managed-stdio" };
        },
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        assert.equal(await bridge.start(), true);
        assert.deepEqual(options, {
          socketPath: "C:\\Users\\Me\\.codex\\app-server.sock",
          command: "C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd",
          mode: "stdio",
          platform: "win32",
        });
        assert.equal(bridge.status().transport, "managed-stdio");
      } finally {
        await bridge.close();
      }
    },
  },
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
        assert.equal(initialize.params.clientInfo.version, "0.10.0");
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
          permissionProfile: "on-request",
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
        assert.equal(request.params.approvalPolicy, "onRequest");
        assert.deepEqual(request.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [], networkAccess: false });
        assert.equal(command.model, "gpt-choice");
        assert.equal(command.reasoningEffort, "high");
        assert.equal(command.serviceTier, "priority");
        assert.equal(command.permissionProfile, "on-request");
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
      const cwd = process.cwd();
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
          cwd,
          model: "gpt-choice",
          reasoningEffort: "high",
          serviceTier: "priority",
          clientMessageId: "phone-create-bridge-0001",
        }, { id: "device-1", name: "Test phone" });
        assert.equal(created.action, "create");
        assert.equal(created.sessionId, "thread-created-1");
        assert.equal(created.cwd, cwd);
        const startThread = harness.sent.find((message) => message.method === "thread/start");
        assert.deepEqual(startThread.params, { cwd, model: "gpt-choice", serviceTier: "priority", serviceName: "phone-control" });
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
    name: "creates a branch with bounded reference context before the new phone instruction",
    async run() {
      const harness = transportHarness({ loadedThreads: [] });
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false, loadedThreadRefreshMs: 0 });
      try {
        await bridge.start();
        const command = await bridge.createSession({
          text: "Continue from the phone",
          context: "This is untrusted prior context\\nAssistant: completed setup",
          branchOf: "thread-original",
          clientMessageId: "phone-branch-bridge-0001",
        });
        assert.equal(command.branchOf, "thread-original");
        const turnStart = harness.sent.find((message) => message.method === "turn/start");
        assert.equal(turnStart.params.input[0].text, "This is untrusted prior context\\nAssistant: completed setup");
        assert.equal(turnStart.params.input.at(-1).text, "Continue from the phone");
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "applies a validated permission profile to new threads and turns",
    async run() {
      const workingDirectory = os.tmpdir();
      const harness = transportHarness({ loadedThreads: [] });
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false, loadedThreadRefreshMs: 0 });
      try {
        await bridge.start();
        const command = await bridge.createSession({
          text: "Work inside this project",
          cwd: workingDirectory,
          permissionProfile: "on-request",
          clientMessageId: "phone-permission-profile-0001",
        });
        const threadStart = harness.sent.find((message) => message.method === "thread/start");
        assert.equal(threadStart.params.approvalPolicy, "onRequest");
        assert.equal(threadStart.params.sandbox, "workspaceWrite");
        const turnStart = harness.sent.find((message) => message.method === "turn/start");
        assert.equal(turnStart.params.approvalPolicy, "onRequest");
        assert.deepEqual(turnStart.params.sandboxPolicy, {
          type: "workspaceWrite",
          writableRoots: [workingDirectory],
          networkAccess: false,
        });
        assert.equal(command.permissionProfile, "on-request");
        assert.equal(command.permissionMode, "workspace-write");
        assert.equal(command.approvalPolicy, "onRequest");
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "allows a workspace write profile with network access after an informational warning",
    async run() {
      const workingDirectory = os.tmpdir();
      const harness = transportHarness({ loadedThreads: [] });
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false, loadedThreadRefreshMs: 0 });
      try {
        await bridge.start();
        const command = await bridge.createSession({
          text: "Push the current project",
          cwd: workingDirectory,
          permissionProfile: "workspace-write-network",
          clientMessageId: "phone-network-profile-0001",
        });
        const threadStart = harness.sent.find((message) => message.method === "thread/start");
        assert.equal(threadStart.params.sandbox, "workspaceWrite");
        const turnStart = harness.sent.find((message) => message.method === "turn/start");
        assert.deepEqual(turnStart.params.sandboxPolicy, {
          type: "workspaceWrite",
          writableRoots: [workingDirectory],
          networkAccess: true,
        });
        assert.equal(command.permissionProfile, "workspace-write-network");
        assert.equal(command.permissionMode, "workspace-write-network");
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "allows full access after an informational warning and answers native approvals only for phone-owned turns",
    async run() {
      const workingDirectory = os.tmpdir();
      const harness = transportHarness({ loadedThreads: [] });
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false, loadedThreadRefreshMs: 0 });
      try {
        await bridge.start();
        const fullAccess = await bridge.createSession({
          text: "Unconfirmed full access",
          cwd: workingDirectory,
          permissionProfile: "danger-full-access",
          clientMessageId: "phone-full-access-denied-0001",
        });
        assert.equal(fullAccess.permissionProfile, "danger-full-access");
        const command = await bridge.createSession({
          text: "Ask before escalation",
          cwd: workingDirectory,
          permissionProfile: "on-request",
          clientMessageId: "phone-native-approval-0001",
        }, { id: "device-1", name: "Test phone" });
        const received = once(bridge, "approval");
        harness.serverSend({
          id: 900,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: command.sessionId,
            turnId: command.turnId,
            itemId: "item-command-1",
            reason: "Needs access outside the workspace",
            command: ["powershell", "-File", "install.ps1"],
            cwd: workingDirectory,
          },
        });
        const [approval] = await received;
        assert.equal(approval.sessionId, command.sessionId);
        assert.equal(approval.details.command, "powershell -File install.ps1");
        assert.equal(bridge.listApprovals().length, 1);
        const decided = await bridge.decideApproval(approval.id, {
          decision: "allow",
          sessionId: command.sessionId,
          turnId: command.turnId,
        }, { id: "device-1" });
        assert.equal(decided.status, "allowed");
        assert.deepEqual(harness.sent.find((message) => message.id === 900), { id: 900, result: { decision: "accept" } });
        assert.equal(bridge.listApprovals().length, 0);

        const permissionReceived = once(bridge, "approval");
        harness.serverSend({
          id: 902,
          method: "item/permissions/requestApproval",
          params: {
            threadId: command.sessionId,
            turnId: command.turnId,
            itemId: "item-permissions-1",
            reason: "Needs network access",
            permissions: { network: { enabled: true, domains: ["example.com"] } },
          },
        });
        const [permissionApproval] = await permissionReceived;
        assert.match(permissionApproval.details.permissionRequest, /example\.com/);
        await bridge.decideApproval(permissionApproval.id, {
          decision: "deny",
          sessionId: command.sessionId,
          turnId: command.turnId,
        });
        assert.deepEqual(harness.sent.find((message) => message.id === 902), {
          id: 902,
          result: { permissions: {}, scope: "turn" },
        });

        const expiringReceived = once(bridge, "approval");
        harness.serverSend({
          id: 903,
          method: "item/fileChange/requestApproval",
          params: { threadId: command.sessionId, turnId: command.turnId, itemId: "item-file-expiring", grantRoot: "/private" },
        });
        const [expiringApproval] = await expiringReceived;
        await bridge.expireNativeApproval(expiringApproval.id);
        assert.deepEqual(harness.sent.find((message) => message.id === 903), { id: 903, result: { decision: "decline" } });
        assert.equal(bridge.getApproval(expiringApproval.id).status, "expired");
        assert.equal(bridge.getApproval(expiringApproval.id).delivery, "delivered");

        const staleReceived = once(bridge, "approval");
        harness.serverSend({
          id: 904,
          method: "item/commandExecution/requestApproval",
          params: { threadId: command.sessionId, turnId: command.turnId, itemId: "item-command-stale", command: ["echo", "stale"] },
        });
        const [staleApproval] = await staleReceived;
        const unavailable = once(bridge, "approvalUnavailable");
        harness.serverSend({ method: "turn/completed", params: { threadId: command.sessionId, turn: { id: command.turnId } } });
        const [unavailableApproval] = await unavailable;
        assert.equal(unavailableApproval.id, staleApproval.id);
        assert.match(unavailableApproval.unavailableReason, /turn completed/i);
        assert.equal(bridge.listApprovals().length, 0);

        harness.serverSend({
          id: 901,
          method: "item/fileChange/requestApproval",
          params: { threadId: "thread-desktop", turnId: "turn-desktop", itemId: "item-file-1", grantRoot: "/private" },
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(bridge.listApprovals().length, 0);
        assert.equal(harness.sent.some((message) => message.id === 901), false);
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
    name: "subscribes loaded threads with bounded metadata concurrency",
    async run() {
      const loadedThreads = ["thread-1", "thread-2", "thread-3", "thread-4", "thread-5"];
      const harness = transportHarness({ loadedThreads, resumeDelayMs: 25 });
      const bridge = new CodexAppServerBridge({
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
        subscriptionConcurrency: 2,
      });
      try {
        assert.equal(await bridge.start(), true);
        assert.equal(harness.maxActiveResumes, 2);
        assert.deepEqual(new Set(bridge.status().subscribedThreads), new Set(loadedThreads));
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
        bridge.rememberCommand({
          id: "phone-question-owner",
          sessionId: "thread-live",
          turnId: "turn-live",
          status: "delivered",
        });
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
    name: "does not claim request_user_input from a desktop or CLI turn",
    async run() {
      const harness = transportHarness();
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false });
      const unsupported = [];
      bridge.on("unsupportedRequest", (request) => unsupported.push(request));
      try {
        await bridge.start();
        harness.serverSend({
          id: "desktop-question-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-desktop",
            turnId: "turn-desktop",
            itemId: "item-desktop-question",
            questions: [{ id: "choice", header: "选择", question: "请选择" }],
          },
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(bridge.list().length, 0);
        assert.deepEqual(unsupported, [{ method: "item/tool/requestUserInput" }]);
        assert.equal(harness.sent.some((message) => message.id === "desktop-question-1" && message.result), false);

        bridge.rememberCommand({ id: "phone-question-owner-late", sessionId: "thread-live", turnId: "turn-late", status: "delivered" });
        const questionEvent = once(bridge, "question");
        harness.serverSend({
          id: "phone-question-late",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-live",
            turnId: "turn-late",
            itemId: "item-late-question",
            questions: [{ id: "choice", header: "选择", question: "请选择" }],
          },
        });
        const [interaction] = await questionEvent;
        const unavailableEvent = once(bridge, "unavailable");
        harness.serverSend({ method: "turn/completed", params: { threadId: "thread-live", turn: { id: "turn-late" } } });
        const [unavailable] = await unavailableEvent;
        assert.equal(unavailable.id, interaction.id);
        assert.equal(unavailable.canRespond, false);
        const lateUnsupported = unsupported.length;
        harness.serverSend({
          id: "phone-question-late-2",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-live",
            turnId: "turn-late",
            itemId: "item-late-question-2",
            questions: [{ id: "choice", header: "选择", question: "请选择" }],
          },
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(bridge.list().length, 0);
        assert.equal(unsupported.length, lateUnsupported + 1);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "rejects free-form values when a question only allows displayed options",
    async run() {
      const harness = transportHarness();
      const bridge = new CodexAppServerBridge({ transportFactory: harness.transportFactory, reconnect: false });
      try {
        await bridge.start();
        bridge.rememberCommand({ id: "phone-question-owner-2", sessionId: "thread-live", turnId: "turn-live", status: "delivered" });
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
        bridge.rememberCommand({ id: "phone-question-owner-3", sessionId: "thread-live", turnId: "turn-live", status: "delivered" });
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
  {
    name: "hands a desktop session off and requires an explicit safe phone reclaim",
    async run() {
      const harness = managedHandoffHarness();
      const bridge = new CodexAppServerBridge({
        platform: "win32",
        transportMode: "stdio",
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        assert.equal(await bridge.start(), true);
        assert.equal(bridge.status().handoffSupported, true);
        await assert.rejects(
          bridge.releaseForDesktop({ sessionId: "thread-live" }),
          (error) => error.statusCode === 409 && /confirmation/i.test(error.message),
        );
        const operation = await bridge.releaseForDesktop({ sessionId: "thread-live", confirmSharedRelease: true }, { id: "phone-1", name: "Phone" });
        assert.equal(operation.status, "released");
        assert.equal(operation.bridgeReconnected, true);
        assert.deepEqual(operation.affectedSessionIds, ["thread-live", "thread-idle-2"]);
        assert.equal(harness.factoryCalls, 2);
        assert.deepEqual(bridge.status().loadedThreads, []);
        assert.deepEqual(bridge.status().subscribedThreads, []);
        assert.deepEqual(bridge.status().handedOffThreads, ["thread-live"]);
        await assert.rejects(
          bridge.resumeForControl("thread-live"),
          (error) => error.statusCode === 409 && /handed off/i.test(error.message),
        );
        const reclaimed = await bridge.reclaimForPhone({ sessionId: "thread-live" }, { id: "phone-1", name: "Phone" });
        assert.equal(reclaimed.status, "acquired");
        assert.deepEqual(bridge.status().handedOffThreads, []);
        assert.deepEqual(bridge.status().loadedThreads, ["thread-live"]);
        assert.deepEqual(bridge.status().subscribedThreads, ["thread-live"]);
        assert.equal(bridge.status().threadStates["thread-live"].status, "idle");
        const secondTransportCalls = harness.sources[1].sent;
        const readIndex = secondTransportCalls.findIndex((message) => message.method === "thread/read" && message.params.threadId === "thread-live");
        const resumeIndex = secondTransportCalls.findIndex((message) => message.method === "thread/resume" && message.params.threadId === "thread-live");
        assert.ok(readIndex >= 0 && resumeIndex > readIndex);
        assert.equal(secondTransportCalls[readIndex].params.includeTurns, false);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "keeps a handed-off desktop session read-only when its active writer remains",
    async run() {
      const harness = transportHarness({
        loadedThreads: [],
        runtimeByThread: { "thread-owned": { readStatus: { type: "idle" } } },
        resumeErrors: { "thread-owned": "thread already has an active writer in another application" },
      });
      const bridge = new CodexAppServerBridge({
        platform: "win32",
        transportMode: "stdio",
        transportFactory: async () => ({ ...(await harness.transportFactory()), kind: "managed-stdio" }),
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        assert.equal(await bridge.start(), true);
        bridge.handedOffThreads.set("thread-owned", {
          at: new Date().toISOString(),
          reason: "This desktop session was handed off and is phone read-only",
        });
        await assert.rejects(
          bridge.reclaimForPhone({ sessionId: "thread-owned" }, { id: "phone-1", name: "Phone" }),
          (error) => error.statusCode === 409 && /desktop still owns/i.test(error.message),
        );
        assert.deepEqual(bridge.status().handedOffThreads, ["thread-owned"]);
        assert.deepEqual(bridge.status().loadedThreads, []);
        assert.deepEqual(bridge.status().subscribedThreads, []);
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: "restarts the managed App Server when a reclaimed session races to active",
    async run() {
      const harness = managedTransportSequence([
        {
          loadedThreads: [],
          runtimeByThread: {
            "thread-race": {
              readStatus: { type: "idle" },
              status: { type: "active", activeFlags: [] },
              turns: [{ id: "turn-race", status: "inProgress", items: [] }],
            },
          },
        },
        { loadedThreads: [] },
      ]);
      const bridge = new CodexAppServerBridge({
        platform: "win32",
        transportMode: "stdio",
        transportFactory: harness.transportFactory,
        reconnect: false,
        loadedThreadRefreshMs: 0,
      });
      try {
        assert.equal(await bridge.start(), true);
        bridge.handedOffThreads.set("thread-race", {
          at: new Date().toISOString(),
          reason: "This desktop session was handed off and is phone read-only",
        });
        await assert.rejects(
          bridge.reclaimForPhone({ sessionId: "thread-race" }, { id: "phone-1", name: "Phone" }),
          (error) => error.statusCode === 409 && /became active/i.test(error.message),
        );
        assert.equal(harness.factoryCalls, 2);
        assert.equal(bridge.status().connected, true);
        assert.deepEqual(bridge.status().handedOffThreads, ["thread-race"]);
        assert.deepEqual(bridge.status().loadedThreads, []);
        assert.deepEqual(bridge.status().subscribedThreads, []);
      } finally {
        await bridge.close();
      }
    },
  },
];
