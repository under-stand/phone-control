import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";
import { createPhoneControlServer } from "../src/server.mjs";

class TestAppServerBridge extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.interaction = null;
    this.threads = new Map();
    this.commands = new Map();
    this.interruptions = new Map();
    this.deletions = new Map();
    this.handoffs = new Map();
    this.reclaims = new Map();
    this.handedOffThreads = new Map();
  }

  status() {
    return {
      connected: this.connected,
      initialized: this.connected,
      transport: "test",
      handoffSupported: true,
      loadedThreads: Array.from(this.threads.keys()),
      subscribedThreads: Array.from(this.threads.keys()),
      threadStates: Object.fromEntries(this.threads),
      handedOffThreads: Array.from(this.handedOffThreads.keys()),
      unavailableThreadReasons: Object.fromEntries(this.handedOffThreads),
      pendingQuestions: this.interaction?.status === "pending" ? 1 : 0,
    };
  }

  async codexStatus() {
    return {
      available: this.connected,
      checkedAt: "2026-08-24T08:00:00.000Z",
      server: { userAgent: "codex-test", platformFamily: "unix", platformOs: "linux" },
      account: { type: "chatgpt", email: "t…r@example.com", planType: "pro" },
      configuration: {
        model: "gpt-test",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: null,
        approvalsReviewer: "auto_review",
        sandboxMode: "workspace-write",
      },
      usage: {
        limits: [{
          id: "codex",
          name: "Codex",
          primary: { usedPercent: 20, remainingPercent: 80, windowMinutes: 10080, resetsAt: "2026-08-27T08:00:00.000Z" },
          secondary: null,
          spendControlReached: false,
          rateLimitReachedType: null,
        }],
        resetCreditsAvailable: 0,
      },
      partial: false,
    };
  }

  async modelCatalog() {
    return {
      available: this.connected,
      checkedAt: "2026-08-24T08:00:00.000Z",
      models: [{
        id: "gpt-test",
        displayName: "GPT Test",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
        reasoningEffortDetails: [{ id: "medium", description: "Balanced" }, { id: "high", description: "Deep" }, { id: "xhigh", description: "Deeper" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
        defaultServiceTier: null,
        inputModalities: ["text", "image"],
        isDefault: true,
      }],
    };
  }

  approvalConfiguration() {
    return {
      approvalPolicy: null,
      approvalsReviewer: "auto_review",
      checkedAt: "2026-08-24T08:00:00.000Z",
    };
  }

  async start() {
    this.connected = true;
    this.emit("status", this.status());
    return true;
  }

  ask(interaction) {
    this.interaction = { ...interaction, status: "pending", delivery: "waiting", canRespond: true };
    this.threads.set(interaction.sessionId, {
      status: "active",
      activeFlags: ["waitingOnUserInput"],
      activeTurnId: interaction.turnId,
    });
    this.emit("question", this.interaction);
    this.emit("status", this.status());
  }

  load(threadId, state = { status: "idle", activeFlags: [], activeTurnId: null }) {
    this.threads.set(threadId, state);
    this.emit("status", this.status());
  }

  listCommands({ sessionId = null, deviceId = null } = {}) {
    return Array.from(this.commands.values()).filter((command) => (
      (!sessionId || command.sessionId === sessionId)
      && (!deviceId || !command.decidedBy || command.decidedBy === deviceId)
    ));
  }

  async answer(id, body, device) {
    if (id !== this.interaction?.id) throw Object.assign(new Error("Question not found"), { statusCode: 404 });
    if (body.sessionId !== this.interaction.sessionId || body.turnId !== this.interaction.turnId) {
      throw Object.assign(new Error("Question binding no longer matches this session and turn"), { statusCode: 409 });
    }
    this.interaction = {
      ...this.interaction,
      status: "answered",
      delivery: "delivered",
      canRespond: false,
      decidedAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.threads.set(this.interaction.sessionId, {
      status: "active",
      activeFlags: [],
      activeTurnId: this.interaction.turnId,
    });
    this.emit("status", this.status());
    this.emit("answered", this.interaction);
    return this.interaction;
  }

  async sendInput(body, device) {
    if (this.commands.has(body.clientMessageId)) throw Object.assign(new Error("This phone message was already submitted"), { statusCode: 409 });
    const state = this.threads.get(body.sessionId);
    if (!state) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    if (state.status === "active" && body.expectedTurnId !== state.activeTurnId) {
      throw Object.assign(new Error("The active Codex turn changed"), { statusCode: 409 });
    }
    const action = state.status === "active" ? "steer" : "start";
    const turnId = action === "steer" ? state.activeTurnId : `turn-phone-${this.commands.size + 1}`;
    const command = {
      id: body.clientMessageId,
      sessionId: body.sessionId,
      expectedTurnId: body.expectedTurnId,
      action,
      turnId,
      model: body.model || null,
      reasoningEffort: body.reasoningEffort || null,
      serviceTier: body.serviceTier || null,
      permissionProfile: body.permissionProfile || null,
      cwd: body.cwd || null,
      delivery: "delivered",
      status: "delivered",
      deliveredAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    for (const image of body.images || []) await access(image.path);
    this.commands.set(command.id, { ...command, text: body.text, images: body.images || [] });
    this.threads.set(body.sessionId, { status: "active", activeFlags: [], activeTurnId: turnId });
    this.emit("status", this.status());
    this.emit("command", command);
    return command;
  }

  async createSession(body, device) {
    if (this.commands.has(body.clientMessageId)) throw Object.assign(new Error("This phone message was already submitted"), { statusCode: 409 });
    const sessionId = `thread-created-${this.commands.size + 1}`;
    const turnId = `turn-created-${this.commands.size + 1}`;
    const command = {
      id: body.clientMessageId,
      sessionId,
      turnId,
      expectedTurnId: null,
      action: "create",
      model: body.model || null,
      reasoningEffort: body.reasoningEffort || null,
      serviceTier: body.serviceTier || null,
      delivery: "delivered",
      status: "delivered",
      cwd: body.cwd,
      deliveredAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.commands.set(command.id, { ...command, text: body.text, context: body.context || null, branchOf: body.branchOf || null });
    this.threads.set(sessionId, { status: "active", activeFlags: [], activeTurnId: turnId });
    this.emit("command", command);
    this.emit("status", this.status());
    return command;
  }

  async deleteSession(body, device) {
    const state = this.threads.get(body.sessionId);
    if (state?.status === "active") throw Object.assign(new Error("Stop the active Codex turn before deleting this session"), { statusCode: 409 });
    const operation = {
      id: `delete-${this.deletions.size + 1}`,
      sessionId: body.sessionId,
      action: "delete",
      delivery: "delivered",
      status: "deleted",
      deletedAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.deletions.set(body.sessionId, operation);
    this.threads.delete(body.sessionId);
    this.emit("thread/deleted", { threadId: body.sessionId });
    this.emit("status", this.status());
    return operation;
  }

  async releaseForDesktop(body, device) {
    const state = this.threads.get(body.sessionId);
    if (state?.status !== "idle") throw Object.assign(new Error("Finish the current Codex turn before handoff"), { statusCode: 409 });
    const affectedSessionIds = Array.from(this.threads.keys());
    if (affectedSessionIds.length > 1 && !body.confirmSharedRelease) {
      throw Object.assign(new Error("Shared release confirmation is required"), { statusCode: 409 });
    }
    const operation = {
      id: `handoff-${this.handoffs.size + 1}`,
      sessionId: body.sessionId,
      affectedSessionIds,
      action: "handoff",
      delivery: "delivered",
      status: "released",
      releasedAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.handedOffThreads.set(body.sessionId, "This desktop session was handed off and is phone read-only");
    this.handoffs.set(body.sessionId, operation);
    this.threads.clear();
    this.emit("status", this.status());
    return operation;
  }

  async reclaimForPhone(body, device) {
    if (!this.handedOffThreads.has(body.sessionId)) {
      throw Object.assign(new Error("This session has not been handed off to the desktop"), { statusCode: 409 });
    }
    const operation = {
      id: `reclaim-${this.reclaims.size + 1}`,
      sessionId: body.sessionId,
      action: "reclaim",
      delivery: "delivered",
      status: "acquired",
      acquiredAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.handedOffThreads.delete(body.sessionId);
    this.threads.set(body.sessionId, { status: "idle", activeFlags: [], activeTurnId: null });
    this.reclaims.set(body.sessionId, operation);
    this.emit("status", this.status());
    return operation;
  }

  async interruptTurn(body, device) {
    const state = this.threads.get(body.sessionId);
    if (state?.status !== "active" || !state.activeTurnId) {
      throw Object.assign(new Error("This Codex session no longer has an active turn"), { statusCode: 409 });
    }
    if (body.expectedTurnId !== state.activeTurnId) {
      throw Object.assign(new Error("The active Codex turn changed"), { statusCode: 409 });
    }
    if (this.interruptions.has(body.sessionId)) {
      throw Object.assign(new Error("A stop request is already in progress"), { statusCode: 409 });
    }
    const operation = {
      id: `interrupt-${this.interruptions.size + 1}`,
      sessionId: body.sessionId,
      turnId: body.expectedTurnId,
      action: "interrupt",
      delivery: "delivered",
      status: "delivered",
      deliveredAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.interruptions.set(body.sessionId, operation);
    this.threads.set(body.sessionId, { ...state, activeFlags: ["interruptRequested"] });
    this.emit("status", this.status());
    this.emit("interrupt", operation);
    return operation;
  }

  async close() {
    this.connected = false;
  }
}

function request({ port, pathname, method = "GET", headers = {}, body = null }) {
  const raw = Buffer.isBuffer(body);
  const payload = body == null ? null : raw ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        ...(payload ? { ...(!raw ? { "content-type": "application/json" } : {}), "content-length": payload.length } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const wire = Buffer.concat(chunks);
        const decoded = response.headers["content-encoding"] === "gzip" ? gunzipSync(wire) : wire;
        const text = decoded.toString("utf8");
        let body = text;
        if (response.headers["content-type"]?.includes("application/json")) {
          body = text ? JSON.parse(text) : null;
        }
        resolve({ status: response.statusCode, headers: response.headers, body, wireBytes: wire.length, decodedBytes: decoded.length });
      });
    });
    req.once("error", reject);
    req.end(payload);
  });
}

export const tests = [
  {
    name: "serves health and the persisted snapshot while the first rollout scan is still running",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-startup-test-"));
      const scanner = new EventEmitter();
      let releaseScan;
      scanner.start = () => new Promise((resolve) => { releaseScan = resolve; });
      scanner.stop = () => {};
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir },
        rolloutScanner: scanner,
      });
      let startPromise;
      try {
        startPromise = runtime.start();
        for (let attempt = 0; attempt < 50 && !runtime.server.address(); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const address = runtime.server.address();
        assert.ok(address && typeof address === "object", "HTTP should listen before the initial rollout scan completes");
        const health = await request({ port: address.port, pathname: "/api/health" });
        assert.equal(health.status, 200);
        assert.equal(health.body.ready, false);
        releaseScan();
        await startPromise;
        const readyHealth = await request({ port: address.port, pathname: "/api/health" });
        assert.equal(readyHealth.body.ready, true);
      } finally {
        releaseScan?.();
        await startPromise?.catch(() => {});
        if (runtime.server.listening) await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "keeps tracking service readiness independent from App Server control readiness",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-readiness-test-"));
      const bridge = new TestAppServerBridge();
      bridge.start = async () => {
        bridge.connected = false;
        bridge.emit("status", bridge.status());
        return false;
      };
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const health = await request({ port: started.port, pathname: "/api/health" });
        assert.equal(health.status, 200);
        assert.equal(health.body.ok, true);
        assert.equal(health.body.ready, true);
        const paired = await request({
          port: started.port,
          pathname: "/api/auth",
          method: "POST",
          headers: { "x-phone-control-client": "1" },
          body: { token: "test-token", name: "Readiness test" },
        });
        assert.equal(paired.status, 200);
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        const status = await request({ port: started.port, pathname: "/api/status", headers: { cookie } });
        assert.equal(status.status, 200);
        assert.equal(status.body.ready, true);
        assert.equal(status.body.controlReady, false);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "protects session APIs and accepts authenticated local hook events",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-test-"));
      const titleContexts = [];
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir },
        scanRollouts: false,
        taskTitleGenerator: {
          suggest: async (context) => {
            titleContexts.push(context);
            return { title: "Execute requested task", cached: false };
          },
        },
      });
      try {
        const started = await runtime.start();
        const page = await request({ port: started.port, pathname: "/" });
        assert.equal(page.status, 200);
        assert.match(page.headers["content-security-policy"], /default-src 'self'/);
        assert.match(page.body, /app\.js\?v=83/);
        assert.match(page.body, /id="task-title">任务</);
        assert.doesNotMatch(page.body, /id="metrics"|任务概览|会话列表/);

        const compressedAsset = await request({
          port: started.port,
          pathname: "/app.js?v=83",
          headers: { "accept-encoding": "gzip" },
        });
        assert.equal(compressedAsset.status, 200);
        assert.equal(compressedAsset.headers["content-encoding"], "gzip");
        assert.match(compressedAsset.headers["cache-control"], /immutable/);
        assert.ok(compressedAsset.wireBytes < compressedAsset.decodedBytes / 2);
        assert.match(compressedAsset.body, /function connectStream/);

        const pairedLink = await request({ port: started.port, pathname: "/?token=test-token", headers: { "x-forwarded-proto": "https" } });
        assert.equal(pairedLink.status, 302);
        assert.equal(pairedLink.headers.location, "/");
        assert.match(pairedLink.headers["set-cookie"][0], /; Secure/);
        const anonymous = await request({ port: started.port, pathname: "/api/sessions" });
        assert.equal(anonymous.status, 401);

        const hook = await request({
          port: started.port,
          pathname: "/api/internal/hook",
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: {
            eventId: "hook-1",
            sessionId: "session-1",
            kind: "user_prompt",
            at: "2026-08-23T12:00:00Z",
            source: "hook",
            message: { role: "user", text: "Run the task" },
          },
        });
        assert.equal(hook.status, 202);

        runtime.store.ingest({
          eventId: "diagnostic-only",
          sessionId: "diagnostic-session",
          kind: "session_start",
          at: "2026-08-23T12:00:01Z",
          source: "hook",
        });

        const paired = await request({
          port: started.port,
          pathname: "/api/auth",
          method: "POST",
          headers: { "x-phone-control-client": "1" },
          body: { token: "test-token", name: "Test phone" },
        });
        assert.equal(paired.status, 200);
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        const sessions = await request({ port: started.port, pathname: "/api/sessions", headers: { cookie } });
        assert.equal(sessions.status, 200);
        assert.equal(sessions.body.sessions.length, 1);
        assert.equal(sessions.body.sessions[0].id, "session-1");
        assert.equal(sessions.body.sessions[0].status, "working");
        assert.equal(sessions.body.sessions[0].taskKind, "user");
        assert.equal(sessions.body.sessions[0].task.title, "Run the task");
        assert.equal(sessions.body.sessions[0].task.goal, "Run the task");
        assert.equal(sessions.body.sessions[0].events, undefined);
        assert.equal(sessions.body.sessions[0].eventsCount, 1);

        const automatic = await request({
          port: started.port,
          pathname: "/api/sessions/session-1/task-title/auto",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
        });
        assert.equal(automatic.status, 200);
        assert.equal(automatic.body.session.task.title, "Execute requested task");
        assert.equal(automatic.body.session.task.smartTitle, "Execute requested task");
        assert.equal(automatic.body.session.task.customTitle, null);
        assert.equal(automatic.body.session.inbox.bucket, "running");
        await runtime.store.setAutomaticTaskTitle("session-1", null);
        titleContexts.length = 0;

        const searched = await request({ port: started.port, pathname: "/api/tasks/search?q=Run%20task", headers: { cookie } });
        assert.equal(searched.status, 200);
        assert.equal(searched.body.total, 1);
        assert.equal(searched.body.results[0].id, "session-1");
        assert.equal(searched.body.results[0].match.eventId, "hook-1");
        assert.equal((await request({ port: started.port, pathname: `/api/tasks/search?q=${"x".repeat(161)}`, headers: { cookie } })).status, 400);
        assert.equal((await request({ port: started.port, pathname: "/api/tasks/search?q=Run&limit=0", headers: { cookie } })).status, 400);

        const detail = await request({ port: started.port, pathname: "/api/sessions/session-1", headers: { cookie } });
        assert.equal(detail.status, 200);
        assert.equal(detail.body.session.events.length, 1);
        assert.equal(detail.body.session.transcriptPath, undefined);

        const suggestionWithoutOriginProof = await request({
          port: started.port,
          pathname: "/api/sessions/session-1/task-title/suggest",
          method: "POST",
          headers: { cookie },
        });
        assert.equal(suggestionWithoutOriginProof.status, 403);
        const suggested = await request({
          port: started.port,
          pathname: "/api/sessions/session-1/task-title/suggest",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
        });
        assert.equal(suggested.status, 200);
        assert.deepEqual(suggested.body.suggestion, { title: "Execute requested task", cached: false });
        assert.equal(titleContexts.length, 1);
        assert.equal(titleContexts[0].automaticTitle, "Run the task");

        const renameWithoutOriginProof = await request({
          port: started.port,
          pathname: "/api/sessions/session-1/task-title",
          method: "PUT",
          headers: { cookie },
          body: { title: "Pinned task" },
        });
        assert.equal(renameWithoutOriginProof.status, 403);
        const renamed = await request({
          port: started.port,
          pathname: "/api/sessions/session-1/task-title",
          method: "PUT",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { title: "Pinned task" },
        });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.body.session.task.title, "Pinned task");
        assert.equal(renamed.body.session.task.autoTitle, "Run the task");
        assert.equal((await request({ port: started.port, pathname: "/api/sessions", headers: { cookie } })).body.sessions[0].task.customTitle, "Pinned task");
        assert.equal((await request({
          port: started.port,
          pathname: "/api/sessions/session-1/task-title",
          method: "PUT",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { title: "x".repeat(81) },
        })).status, 400);
        const automaticTitle = await request({
          port: started.port,
          pathname: "/api/sessions/session-1/task-title",
          method: "PUT",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { title: null },
        });
        assert.equal(automaticTitle.body.session.task.title, "Run the task");

        for (let index = 0; index < 40; index += 1) {
          runtime.store.ingest({
            eventId: `window-${index}`,
            sessionId: "session-window",
            kind: index % 2 ? "tool_start" : "assistant_message",
            at: new Date(Date.parse("2026-08-24T01:00:00Z") + index * 1_000).toISOString(),
            tool: { name: "exec" },
            message: index % 2 ? null : { role: "assistant", text: `message ${index}` },
          });
        }
        const boundedDetail = await request({ port: started.port, pathname: "/api/sessions/session-window?events=24", headers: { cookie } });
        assert.equal(boundedDetail.status, 200);
        assert.equal(boundedDetail.body.session.events.length, 24);
        assert.equal(boundedDetail.body.session.eventsTotal, 40);
        assert.equal(boundedDetail.body.session.eventsStart, 16);
        assert.equal(boundedDetail.body.session.eventsPartial, true);
        const completeDetail = await request({ port: started.port, pathname: "/api/sessions/session-window?events=all", headers: { cookie } });
        assert.equal(completeDetail.body.session.events.length, 40);
        assert.equal(completeDetail.body.session.eventsPartial, false);
        const invalidWindow = await request({ port: started.port, pathname: "/api/sessions/session-window?events=12", headers: { cookie } });
        assert.equal(invalidWindow.status, 400);

        const devices = await request({ port: started.port, pathname: "/api/devices", headers: { cookie } });
        assert.equal(devices.status, 200);
        assert.equal(devices.body.devices.length, 2);
        assert.equal(devices.body.activeDevices.length, 2);
        assert.deepEqual(devices.body.counts, { active: 2, revoked: 0, total: 2 });
        assert.equal(devices.body.devices.some((device) => device.name === "Test phone"), true);
        assert.equal(devices.body.devices.some((device) => "remoteAddress" in device || "userAgent" in device), false);

        const pushStatus = await request({ port: started.port, pathname: "/api/push", headers: { cookie } });
        assert.equal(pushStatus.status, 200);
        assert.equal(pushStatus.body.available, true);
        assert.equal(pushStatus.body.subscribed, false);
        assert.equal(typeof pushStatus.body.publicKey, "string");
        assert.equal(pushStatus.body.privateKey, undefined);
        const emptyTarget = await request({ port: started.port, pathname: "/api/target", headers: { cookie } });
        assert.equal(emptyTarget.status, 200);
        assert.equal(emptyTarget.body.sessionId, null);
        const targeted = await request({
          port: started.port,
          pathname: "/api/target",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { sessionId: "session-1" },
        });
        assert.equal(targeted.status, 200);
        assert.equal(targeted.body.sessionId, "session-1");
        assert.equal((await request({ port: started.port, pathname: "/api/target", headers: { cookie } })).body.sessionId, "session-1");
        const missingTarget = await request({
          port: started.port,
          pathname: "/api/target",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { sessionId: "missing-session" },
        });
        assert.equal(missingTarget.status, 404);
        const clearedTarget = await request({
          port: started.port,
          pathname: "/api/target",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { sessionId: null },
        });
        assert.equal(clearedTarget.body.sessionId, null);
        const subscribed = await request({
          port: started.port,
          pathname: "/api/push/subscribe",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { subscription: { endpoint: "https://push.example.test/device", keys: { p256dh: "valid_key-1", auth: "valid_key-2" } } },
        });
        assert.equal(subscribed.status, 200);
        assert.equal(subscribed.body.subscribed, true);
        assert.equal(JSON.stringify(subscribed.body).includes("push.example.test"), false);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "uses single-use pairing links and revocable device credentials",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-pairing-test-"));
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, approvals: { enabled: false, timeoutSeconds: 10 } },
        scanRollouts: false,
      });
      try {
        const started = await runtime.start();
        const initial = await request({ port: started.port, pathname: "/?token=test-token" });
        const ownerCookie = initial.headers["set-cookie"][0].split(";", 1)[0];
        const created = await request({
          port: started.port,
          pathname: "/api/pairings",
          method: "POST",
          headers: { cookie: ownerCookie, "x-phone-control-client": "1" },
        });
        assert.equal(created.status, 201);
        const pairingPath = new URL(created.body.pairing.url).pathname + new URL(created.body.pairing.url).search;
        const joined = await request({ port: started.port, pathname: pairingPath, headers: { "user-agent": "Test mobile" } });
        assert.equal(joined.status, 302);
        const joinedCookie = joined.headers["set-cookie"][0].split(";", 1)[0];
        const reused = await request({ port: started.port, pathname: pairingPath });
        assert.equal(reused.status, 410);

        const joinedDevices = await request({ port: started.port, pathname: "/api/devices", headers: { cookie: joinedCookie } });
        assert.equal(joinedDevices.status, 200);
        const joinedId = joinedDevices.body.currentDeviceId;
        const revoked = await request({
          port: started.port,
          pathname: `/api/devices/${encodeURIComponent(joinedId)}/revoke`,
          method: "POST",
          headers: { cookie: ownerCookie, "x-phone-control-client": "1" },
        });
        assert.equal(revoked.status, 200);
        const afterRevoke = await request({ port: started.port, pathname: "/api/devices", headers: { cookie: ownerCookie } });
        assert.equal(afterRevoke.body.activeDevices.length, 1);
        assert.equal(afterRevoke.body.revokedDevices.length, 1);
        const purged = await request({
          port: started.port,
          pathname: "/api/devices/revoked",
          method: "DELETE",
          headers: { cookie: ownerCookie, "x-phone-control-client": "1" },
        });
        assert.equal(purged.status, 200);
        assert.equal(purged.body.removed, 1);
        const denied = await request({ port: started.port, pathname: "/api/sessions", headers: { cookie: joinedCookie } });
        assert.equal(denied.status, 401);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "binds phone approval decisions to one expiring hook challenge",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-approval-test-"));
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, approvals: { enabled: true, timeoutSeconds: 10 } },
        scanRollouts: false,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        runtime.store.ingest({
          eventId: "approval-phone-input",
          source: "phone-control",
          sessionId: "session-approval",
          turnId: "turn-1",
          kind: "phone_input_sent",
          action: "start",
          at: "2026-08-24T00:59:59Z",
        });
        const created = await request({
          port: started.port,
          pathname: "/api/internal/approvals",
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: {
            event: {
              eventId: "permission-1",
              sessionId: "session-approval",
              turnId: "turn-1",
              kind: "permission_request",
              at: "2026-08-24T01:00:00Z",
              tool: { name: "Bash", summary: "git push" },
              reason: "Needs network",
              approvalDetails: { command: "git push" },
            },
          },
        });
        assert.equal(created.status, 201);
        const approvalId = created.body.approval.id;
        const pending = await request({ port: started.port, pathname: "/api/sessions/session-approval", headers: { cookie } });
        assert.equal(pending.body.session.pendingApproval.id, approvalId);
        assert.equal(pending.body.session.control.canApprove, true);

        const decided = await request({
          port: started.port,
          pathname: `/api/approvals/${encodeURIComponent(approvalId)}/decision`,
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { decision: "allow" },
        });
        assert.equal(decided.status, 200);
        assert.equal(decided.body.approval.status, "allowed");
        const waited = await request({
          port: started.port,
          pathname: `/api/internal/approvals/${encodeURIComponent(approvalId)}`,
          headers: { authorization: "Bearer test-token" },
        });
        assert.equal(waited.body.approval.decision, "allow");
        const repeated = await request({
          port: started.port,
          pathname: `/api/approvals/${encodeURIComponent(approvalId)}/decision`,
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { decision: "allow" },
        });
        assert.equal(repeated.status, 409);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "leaves desktop approvals to Codex without creating a duplicate phone challenge",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-desktop-approval-test-"));
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, approvals: { enabled: true, timeoutSeconds: 10 } },
        scanRollouts: false,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        runtime.store.ingest({
          eventId: "desktop-user-prompt",
          sessionId: "desktop-session",
          turnId: "desktop-turn",
          kind: "user_prompt",
          at: new Date().toISOString(),
          message: { role: "user", text: "Run desktop task" },
        });
        const created = await request({
          port: started.port,
          pathname: "/api/internal/approvals",
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: {
            event: {
              eventId: "desktop-permission",
              sessionId: "desktop-session",
              turnId: "desktop-turn",
              kind: "permission_request",
              at: new Date().toISOString(),
              tool: { name: "Bash", summary: "npm test" },
            },
          },
        });
        assert.equal(created.status, 202);
        assert.equal(created.body.enabled, false);
        assert.equal(created.body.reason, "normal_codex_approval");
        const approvals = await request({ port: started.port, pathname: "/api/approvals", headers: { cookie } });
        assert.deepEqual(approvals.body.approvals, []);
        const session = await request({ port: started.port, pathname: "/api/sessions/desktop-session", headers: { cookie } });
        assert.equal(session.body.session.control.canApprove, false);
        assert.equal(session.body.session.pendingApproval, null);
        assert.equal(session.body.session.status, "working");
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "lets the Codex auto reviewer own approvals even for a phone-started turn",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-auto-review-approval-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: {
          host: "127.0.0.1",
          port: 0,
          token: "test-token",
          dataDir,
          approvals: { enabled: true, timeoutSeconds: 10 },
          interactions: { enabled: true },
        },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        runtime.store.ingest({
          eventId: "auto-review-phone-input",
          source: "phone-control",
          sessionId: "auto-review-session",
          turnId: "auto-review-turn",
          kind: "phone_input_sent",
          action: "start",
          at: new Date().toISOString(),
        });
        const created = await request({
          port: started.port,
          pathname: "/api/internal/approvals",
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: {
            event: {
              eventId: "auto-review-permission",
              sessionId: "auto-review-session",
              turnId: "auto-review-turn",
              kind: "permission_request",
              at: new Date().toISOString(),
              tool: { name: "Bash", summary: "read marketplace" },
            },
          },
        });
        assert.equal(created.status, 202);
        assert.equal(created.body.enabled, false);
        assert.equal(created.body.reason, "codex_auto_review");
        const approvals = await request({ port: started.port, pathname: "/api/approvals", headers: { cookie } });
        assert.deepEqual(approvals.body.approvals, []);
        const session = await request({ port: started.port, pathname: "/api/sessions/auto-review-session", headers: { cookie } });
        assert.equal(session.body.session.pendingApproval, null);
        assert.equal(session.body.session.status, "working");
        const status = await request({ port: started.port, pathname: "/api/status", headers: { cookie } });
        assert.equal(status.body.approvalsConfigured, true);
        assert.equal(status.body.approvalsEnabled, false);
        assert.equal(status.body.approvalRoutingReason, "codex_auto_review");
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "delivers a phone answer only for the bound live Codex question",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-answer-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, machineName: "Test machine", interactions: { enabled: true } },
        scanRollouts: false,
        appServerBridge: bridge,
        runtimeInspector: async () => ({
          available: true,
          checkedAt: "2026-08-24T08:00:00.000Z",
          cliVersion: "0.149.1",
          appServerVersion: "0.145.0",
          restartRecommended: true,
          reason: "restart required",
        }),
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        bridge.ask({
          id: "question-1",
          sessionId: "thread-live",
          turnId: "turn-live",
          itemId: "item-live",
          createdAt: "2026-08-24T04:00:00.000Z",
          expiresAt: null,
          questions: [{
            id: "direction",
            header: "下一步",
            question: "继续吗？",
            isOther: false,
            isSecret: false,
            options: [{ label: "继续", description: "继续执行" }],
          }],
        });
        const detail = await request({ port: started.port, pathname: "/api/sessions/thread-live", headers: { cookie } });
        assert.equal(detail.body.session.pendingApproval.kind, "question");
        assert.equal(detail.body.session.pendingApproval.questions[0].id, "direction");
        assert.equal(detail.body.session.control.canAnswer, true);
        const status = await request({ port: started.port, pathname: "/api/status", headers: { cookie } });
        assert.equal(status.status, 200);
        assert.equal(status.body.version, "0.12.2");
        assert.equal(status.body.codexHome, undefined);
        assert.equal(status.body.device, undefined);
        assert.equal(status.body.appServer.threadStates, undefined);
        assert.equal(status.body.appServer.loadedThreads, undefined);
        assert.equal(status.body.appServer.subscribedThreads, undefined);
        assert.equal(status.body.appServer.loadedThreadCount, 1);
        assert.equal(status.body.appServer.subscribedThreadCount, 1);
        assert.equal(status.body.runtime.cliVersion, "0.149.1");
        assert.equal(status.body.runtime.appServerVersion, "0.145.0");
        assert.equal(status.body.runtime.restartRecommended, true);
        assert.equal(status.body.codex.account.email, "t…r@example.com");
        assert.equal(status.body.codex.configuration.model, "gpt-test");
        assert.equal(status.body.codex.usage.limits[0].primary.remainingPercent, 80);

        const stale = await request({
          port: started.port,
          pathname: "/api/questions/question-1/answer",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { sessionId: "thread-live", turnId: "wrong-turn", answers: { direction: ["继续"] } },
        });
        assert.equal(stale.status, 409);
        const delivered = await request({
          port: started.port,
          pathname: "/api/questions/question-1/answer",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { sessionId: "thread-live", turnId: "turn-live", answers: { direction: ["继续"] } },
        });
        assert.equal(delivered.status, 200);
        assert.equal(delivered.body.interaction.delivery, "delivered");
        const continued = await request({ port: started.port, pathname: "/api/sessions/thread-live", headers: { cookie } });
        assert.equal(continued.body.session.status, "working");
        assert.equal(continued.body.session.pendingApproval, null);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "continues a verified Codex session from authenticated phone input",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-input-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, interactions: { enabled: true } },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        await request({
          port: started.port,
          pathname: "/api/internal/hook",
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: {
            eventId: "stored-session",
            sessionId: "thread-control",
            turnId: "turn-old",
            kind: "turn_complete",
            at: "2026-08-24T05:00:00.000Z",
            surface: "Desktop",
            cwd: dataDir,
            permissionMode: "workspace-write",
            approvalPolicy: "onRequest",
            transcriptPath: "/tmp/thread-control.jsonl",
          },
        });
        runtime.store.ingest({
          eventId: "stored-session-user",
          sessionId: "thread-control",
          turnId: "turn-old",
          kind: "user_prompt",
          at: "2026-08-24T04:59:59.000Z",
          message: { role: "user", text: "Continue the stored task" },
        });
        bridge.load("thread-control", { status: "idle", activeFlags: [], activeTurnId: null });

        const detail = await request({ port: started.port, pathname: "/api/sessions/thread-control", headers: { cookie } });
        assert.equal(detail.body.session.control.canSend, true);
        assert.equal(detail.body.session.control.action, "start");
        assert.equal(detail.body.session.control.canHandoff, true);
        assert.equal(detail.body.session.control.expectedTurnId, null);

        const stale = await request({
          port: started.port,
          pathname: "/api/sessions/thread-control/input",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "continue", expectedTurnId: "turn-old", clientMessageId: "phone-server-0001" },
        });
        assert.equal(stale.status, 409);
        const delivered = await request({
          port: started.port,
          pathname: "/api/sessions/thread-control/input",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "continue from my phone", expectedTurnId: null, clientMessageId: "phone-server-0002" },
        });
        assert.equal(delivered.status, 200);
        assert.equal(delivered.body.command.action, "start");
        assert.equal(bridge.commands.get("phone-server-0002").text, "continue from my phone");
        assert.equal(bridge.commands.get("phone-server-0002").cwd, dataDir);
        assert.equal(bridge.commands.get("phone-server-0002").permissionProfile, "on-request");

        const continued = await request({ port: started.port, pathname: "/api/sessions/thread-control", headers: { cookie } });
        assert.equal(continued.body.session.status, "working");
        assert.equal(continued.body.session.task.title, "continue from my phone");
        assert.equal(continued.body.session.control.action, "steer");
        assert.equal(continued.body.session.control.expectedTurnId, delivered.body.command.turnId);

        const staleInterrupt = await request({
          port: started.port,
          pathname: "/api/sessions/thread-control/interrupt",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { expectedTurnId: "turn-stale" },
        });
        assert.equal(staleInterrupt.status, 409);
        assert.equal(bridge.interruptions.size, 0);
        const interrupted = await request({
          port: started.port,
          pathname: "/api/sessions/thread-control/interrupt",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { expectedTurnId: delivered.body.command.turnId },
        });
        assert.equal(interrupted.status, 200);
        assert.equal(interrupted.body.operation.action, "interrupt");
        assert.equal(bridge.interruptions.get("thread-control").turnId, delivered.body.command.turnId);
        const stopping = await request({ port: started.port, pathname: "/api/sessions/thread-control", headers: { cookie } });
        assert.equal(stopping.body.session.control.canInterrupt, false);
        assert.equal(stopping.body.session.control.canSend, false);
        assert.match(stopping.body.session.statusReason, /请求停止/);

        bridge.threads.set("thread-control", { status: "idle", activeFlags: [], activeTurnId: null });
        bridge.emit("status", bridge.status());
        runtime.store.ingest({
          eventId: "phone-controlled-turn-complete",
          sessionId: "thread-control",
          turnId: delivered.body.command.turnId,
          kind: "turn_complete",
          at: new Date().toISOString(),
        });
        const handedOff = await request({
          port: started.port,
          pathname: "/api/sessions/thread-control/handoff",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { confirmSharedRelease: true },
        });
        assert.equal(handedOff.status, 200);
        assert.equal(handedOff.body.operation.status, "released");
        const readOnly = await request({ port: started.port, pathname: "/api/sessions/thread-control", headers: { cookie } });
        assert.equal(readOnly.body.session.control.handedOff, true);
        assert.equal(readOnly.body.session.control.canSend, false);
        assert.equal(readOnly.body.session.control.canReclaim, true);
        const reclaimed = await request({
          port: started.port,
          pathname: "/api/sessions/thread-control/reclaim",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: {},
        });
        assert.equal(reclaimed.status, 200);
        assert.equal(reclaimed.body.operation.status, "acquired");
        const mobileOwned = await request({ port: started.port, pathname: "/api/sessions/thread-control", headers: { cookie } });
        assert.equal(mobileOwned.body.session.control.handedOff, false);
        assert.equal(mobileOwned.body.session.control.canSend, true);
        assert.equal(mobileOwned.body.session.control.action, "start");

        runtime.store.ingest({
          eventId: "cli-only-user",
          sessionId: "thread-cli-only",
          turnId: "turn-cli-only",
          kind: "user_prompt",
          at: "2026-08-24T05:01:00.000Z",
          surface: "CLI",
          message: { role: "user", text: "Continue in CLI" },
        });
        runtime.store.ingest({
          eventId: "cli-only-complete",
          sessionId: "thread-cli-only",
          turnId: "turn-cli-only",
          kind: "turn_complete",
          at: "2026-08-24T05:01:01.000Z",
          transcriptPath: "/tmp/thread-cli-only.jsonl",
        });
        bridge.load("thread-cli-only", { status: "idle", activeFlags: [], activeTurnId: null });
        const cliDetail = await request({ port: started.port, pathname: "/api/sessions/thread-cli-only", headers: { cookie } });
        assert.equal(cliDetail.body.session.control.canSend, true);
        assert.equal(cliDetail.body.session.control.canHandoff, false);
        const cliHandoff = await request({
          port: started.port,
          pathname: "/api/sessions/thread-cli-only/handoff",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { confirmSharedRelease: true },
        });
        assert.equal(cliHandoff.status, 409);
        assert.match(cliHandoff.body.error, /desktop-app sessions/i);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "creates a fresh Codex session and permanently deletes its original record",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-session-lifecycle-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, machineName: "Test machine", interactions: { enabled: true } },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        const models = await request({ port: started.port, pathname: "/api/models", headers: { cookie } });
        assert.equal(models.status, 200);
        assert.equal(models.body.models[0].id, "gpt-test");
        assert.equal(models.body.configuration.model, "gpt-test");
        assert.equal(models.body.machineName, "Test machine");
        assert.equal(models.body.models[0].serviceTiers[0].id, "priority");
        assert.equal(JSON.stringify(models.body).includes("mobile.user"), false);
        const rejectedOrigin = await request({
          port: started.port,
          pathname: "/api/sessions",
          method: "POST",
          headers: { cookie },
          body: { text: "Build the new feature", cwd: "/workspace/project", clientMessageId: "phone-create-0001" },
        });
        assert.equal(rejectedOrigin.status, 403);
        const created = await request({
          port: started.port,
          pathname: "/api/sessions",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "Build the new feature", cwd: "/workspace/project", model: "gpt-test", reasoningEffort: "xhigh", serviceTier: "priority", clientMessageId: "phone-create-0002" },
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.command.action, "create");
        assert.equal(bridge.commands.get("phone-create-0002").text, "Build the new feature");
        assert.equal(bridge.commands.get("phone-create-0002").model, "gpt-test");
        assert.equal(bridge.commands.get("phone-create-0002").reasoningEffort, "xhigh");
        assert.equal(bridge.commands.get("phone-create-0002").serviceTier, "priority");
        const sessionId = created.body.command.sessionId;
        const detail = await request({ port: started.port, pathname: `/api/sessions/${sessionId}`, headers: { cookie } });
        assert.equal(detail.status, 200);
        assert.equal(detail.body.session.status, "working");
        assert.equal(detail.body.session.cwd, "/workspace/project");
        assert.equal(detail.body.session.surface, "Phone");
        assert.equal(detail.body.session.model, "gpt-test");
        assert.equal(detail.body.session.reasoningEffort, "xhigh");
        assert.equal(detail.body.session.task.title, "Build the new feature");
        assert.equal(detail.body.session.lastUserMessage.text, "Build the new feature");
        assert.equal(detail.body.session.events[0].model, "gpt-test");
        assert.equal(detail.body.session.events[0].reasoningEffort, "xhigh");

        const activeDelete = await request({
          port: started.port,
          pathname: `/api/sessions/${sessionId}`,
          method: "DELETE",
          headers: { cookie, "x-phone-control-client": "1" },
        });
        assert.equal(activeDelete.status, 409);

        bridge.threads.set(sessionId, { status: "idle", activeFlags: [], activeTurnId: null });
        bridge.emit("status", bridge.status());
        runtime.store.ingest({
          eventId: "created-session-complete",
          sessionId,
          turnId: created.body.command.turnId,
          kind: "turn_complete",
          at: new Date().toISOString(),
        });
        const targeted = await request({
          port: started.port,
          pathname: "/api/target",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { sessionId },
        });
        assert.equal(targeted.body.sessionId, sessionId);
        const deleted = await request({
          port: started.port,
          pathname: `/api/sessions/${sessionId}`,
          method: "DELETE",
          headers: { cookie, "x-phone-control-client": "1" },
        });
        assert.equal(deleted.status, 200);
        assert.equal(deleted.body.operation.status, "deleted");
        assert.equal(bridge.deletions.has(sessionId), true);
        assert.equal((await request({ port: started.port, pathname: `/api/sessions/${sessionId}`, headers: { cookie } })).status, 404);
        assert.equal((await request({ port: started.port, pathname: "/api/target", headers: { cookie } })).body.sessionId, null);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "queues a phone instruction while disconnected and delivers it after Codex recovers",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-outbox-api-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, interactions: { enabled: true } },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        runtime.store.ingest({
          eventId: "outbox-source-prompt",
          sessionId: "thread-outbox",
          turnId: "turn-old",
          kind: "user_prompt",
          at: new Date(Date.now() - 2_000).toISOString(),
          surface: "CLI",
          message: { role: "user", text: "Prepare a queued continuation" },
        });
        runtime.store.ingest({
          eventId: "outbox-source-complete",
          sessionId: "thread-outbox",
          turnId: "turn-old",
          kind: "turn_complete",
          at: new Date(Date.now() - 1_000).toISOString(),
          transcriptPath: path.join(dataDir, "thread-outbox.jsonl"),
        });
        bridge.load("thread-outbox", { status: "idle", activeFlags: [], activeTurnId: null });
        bridge.connected = false;
        bridge.emit("status", bridge.status());
        const queued = await request({
          port: started.port,
          pathname: "/api/sessions/thread-outbox/queue",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "继续检查测试结果", clientMessageId: "phone-queued-api-0001" },
        });
        assert.equal(queued.status, 202);
        assert.equal(queued.body.queued.status, "waiting");
        assert.equal(queued.body.queued.waitingFor, "bridge");
        const listed = await request({ port: started.port, pathname: "/api/sessions/thread-outbox/queued-commands", headers: { cookie } });
        assert.equal(listed.body.queued.length, 1);
        bridge.connected = true;
        bridge.emit("status", bridge.status());
        for (let attempt = 0; attempt < 20 && !bridge.commands.has("phone-queued-api-0001"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(bridge.commands.get("phone-queued-api-0001").text, "继续检查测试结果");
        const after = await request({ port: started.port, pathname: "/api/sessions/thread-outbox/queued-commands", headers: { cookie } });
        assert.equal(after.body.queued[0].status, "delivered");
        const projected = await request({ port: started.port, pathname: "/api/sessions/thread-outbox", headers: { cookie } });
        assert.equal(projected.body.session.commandState.state, "running");
        assert.equal(projected.body.session.inbox.bucket, "running");
        const stale = await request({
          port: started.port,
          pathname: "/api/sessions/thread-outbox/queue",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "不要误发到变化的 turn", expectedTurnId: "turn-old", clientMessageId: "phone-queued-api-0002" },
        });
        assert.equal(stale.status, 202);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const current = await request({ port: started.port, pathname: "/api/sessions/thread-outbox/queued-commands", headers: { cookie } });
          if (current.body.queued.find((entry) => entry.id === "phone-queued-api-0002")?.status === "needs_review") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const staleList = await request({ port: started.port, pathname: "/api/sessions/thread-outbox/queued-commands", headers: { cookie } });
        assert.equal(staleList.body.queued.find((entry) => entry.id === "phone-queued-api-0002").status, "needs_review");
        const review = await request({ port: started.port, pathname: "/api/sessions/thread-outbox", headers: { cookie } });
        assert.equal(review.body.session.commandState.state, "needs_review");
        assert.equal(review.body.session.inbox.action, "review_delivery");
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "continues queued phone-owned work with the session workspace and permissions",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-outbox-context-api-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, interactions: { enabled: true } },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        const at = Date.now();
        runtime.store.ingest({
          eventId: "outbox-phone-context-prompt",
          sessionId: "thread-phone-context",
          turnId: "turn-phone-context-old",
          kind: "user_prompt",
          at: new Date(at - 2_000).toISOString(),
          surface: "Phone",
          cwd: dataDir,
          model: "gpt-test",
          reasoningEffort: "high",
          serviceTier: "fast",
          permissionMode: "workspace-write",
          approvalPolicy: "onRequest",
          message: { role: "user", text: "先准备项目文件" },
        });
        runtime.store.ingest({
          eventId: "outbox-phone-context-complete",
          sessionId: "thread-phone-context",
          turnId: "turn-phone-context-old",
          kind: "turn_complete",
          at: new Date(at - 1_000).toISOString(),
          transcriptPath: path.join(dataDir, "thread-phone-context.jsonl"),
        });
        bridge.load("thread-phone-context", { status: "idle", activeFlags: [], activeTurnId: null });
        bridge.connected = false;
        bridge.emit("status", bridge.status());

        const queued = await request({
          port: started.port,
          pathname: "/api/sessions/thread-phone-context/queue",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "断线后继续修改项目文件", clientMessageId: "phone-queued-context-0001" },
        });
        assert.equal(queued.status, 202);
        bridge.connected = true;
        bridge.emit("status", bridge.status());
        for (let attempt = 0; attempt < 40 && !bridge.commands.has("phone-queued-context-0001"); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const command = bridge.commands.get("phone-queued-context-0001");
        assert.equal(command.cwd, dataDir, "queued continuation should stay in the phone session workspace");
        assert.equal(command.permissionProfile, "on-request", "queued continuation should preserve the safe write profile");
        assert.equal(command.model, "gpt-test");
        assert.equal(command.reasoningEffort, "high");
        assert.equal(command.serviceTier, "fast");
        const after = await request({ port: started.port, pathname: "/api/sessions/thread-phone-context/queued-commands", headers: { cookie } });
        assert.equal(after.body.queued[0].status, "delivered");
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "reclaims a released desktop session before delivering queued phone input",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-outbox-reclaim-api-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, interactions: { enabled: true } },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        runtime.store.ingest({
          eventId: "outbox-reclaim-source-prompt",
          sessionId: "thread-desktop-outbox",
          turnId: "turn-desktop-old",
          kind: "user_prompt",
          at: new Date(Date.now() - 2_000).toISOString(),
          surface: "Desktop",
          message: { role: "user", text: "Prepare a desktop continuation" },
        });
        runtime.store.ingest({
          eventId: "outbox-reclaim-source-complete",
          sessionId: "thread-desktop-outbox",
          turnId: "turn-desktop-old",
          kind: "turn_complete",
          at: new Date(Date.now() - 1_000).toISOString(),
          transcriptPath: path.join(dataDir, "thread-desktop-outbox.jsonl"),
        });
        bridge.load("thread-desktop-outbox", { status: "idle", activeFlags: [], activeTurnId: null });
        bridge.handedOffThreads.set("thread-desktop-outbox", "This desktop session was handed off and is phone read-only");
        bridge.threads.clear();
        bridge.emit("status", bridge.status());

        const queued = await request({
          port: started.port,
          pathname: "/api/sessions/thread-desktop-outbox/queue",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "电脑退出后继续修改文件", clientMessageId: "phone-queued-reclaim-0001" },
        });
        assert.equal(queued.status, 202);
        for (let attempt = 0; attempt < 40 && !bridge.commands.has("phone-queued-reclaim-0001"); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(bridge.reclaims.has("thread-desktop-outbox"), true, "a queued instruction should safely reclaim a released desktop session");
        assert.equal(bridge.commands.get("phone-queued-reclaim-0001").text, "电脑退出后继续修改文件");
        const after = await request({ port: started.port, pathname: "/api/sessions/thread-desktop-outbox/queued-commands", headers: { cookie } });
        assert.equal(after.body.queued[0].status, "delivered");
        const detail = await request({ port: started.port, pathname: "/api/sessions/thread-desktop-outbox", headers: { cookie } });
        assert.equal(detail.body.session.control.canSend, true, "the reclaimed session must expose phone write control after desktop exit");
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "branches a session with recent history context",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-branch-api-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, interactions: { enabled: true } },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        runtime.store.ingest({ eventId: "branch-user", sessionId: "thread-branch-source", turnId: "turn-1", kind: "user_prompt", at: new Date(Date.now() - 3_000).toISOString(), message: { role: "user", text: "Build the mobile flow" } });
        runtime.store.ingest({ eventId: "branch-assistant", sessionId: "thread-branch-source", turnId: "turn-1", kind: "assistant_message", at: new Date(Date.now() - 2_000).toISOString(), message: { role: "assistant", text: "The flow is ready for review" } });
        runtime.store.ingest({ eventId: "branch-complete", sessionId: "thread-branch-source", turnId: "turn-1", kind: "turn_complete", at: new Date(Date.now() - 1_000).toISOString() });
        bridge.load("thread-branch-source", { status: "idle", activeFlags: [], activeTurnId: null });
        const branched = await request({
          port: started.port,
          pathname: "/api/sessions/thread-branch-source/branch",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "Now verify it on mobile", clientMessageId: "phone-branch-api-0001" },
        });
        assert.equal(branched.status, 201);
        assert.equal(branched.body.sourceSessionId, "thread-branch-source");
        const created = bridge.commands.get("phone-branch-api-0001");
        assert.equal(created.branchOf, "thread-branch-source");
        assert.match(created.context, /Build the mobile flow/);
        const child = await request({ port: started.port, pathname: `/api/sessions/${branched.body.command.sessionId}`, headers: { cookie } });
        assert.equal(child.body.session.branchOf, "thread-branch-source");
        const source = await request({ port: started.port, pathname: "/api/sessions", headers: { cookie } });
        assert.equal(source.body.sessions.find((session) => session.id === "thread-branch-source").childSessionCount, 1);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "uploads a bound image once and keeps it readable after Codex accepts the path",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-image-api-test-"));
      const bridge = new TestAppServerBridge();
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir, interactions: { enabled: true } },
        scanRollouts: false,
        appServerBridge: bridge,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        await request({
          port: started.port,
          pathname: "/api/internal/hook",
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: { eventId: "image-session", sessionId: "thread-image", kind: "turn_complete", at: new Date().toISOString(), transcriptPath: "/tmp/thread-image.jsonl" },
        });
        runtime.store.ingest({
          eventId: "image-session-user",
          sessionId: "thread-image",
          kind: "user_prompt",
          at: new Date(Date.now() - 1_000).toISOString(),
          message: { role: "user", text: "Inspect an image" },
        });
        bridge.load("thread-image", { status: "idle", activeFlags: [], activeTurnId: null });
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
        const uploaded = await request({
          port: started.port,
          pathname: "/api/sessions/thread-image/images",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1", "content-type": "image/png" },
          body: png,
        });
        assert.equal(uploaded.status, 201);
        const delivered = await request({
          port: started.port,
          pathname: "/api/sessions/thread-image/input",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "", imageIds: [uploaded.body.image.id], expectedTurnId: null, clientMessageId: "phone-image-api-0001" },
        });
        assert.equal(delivered.status, 200);
        const record = bridge.commands.get("phone-image-api-0001");
        assert.equal(record.images.length, 1);
        assert.match(record.images[0].path.replaceAll("\\", "/"), /uploads\/phone-[a-f0-9-]+\.png$/);
        await access(record.images[0].path);
        const reused = await request({
          port: started.port,
          pathname: "/api/sessions/thread-image/input",
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { text: "retry", imageIds: [uploaded.body.image.id], expectedTurnId: delivered.body.command.turnId, clientMessageId: "phone-image-api-0002" },
        });
        assert.equal(reused.status, 409);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
];
