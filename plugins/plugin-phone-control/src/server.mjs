import http from "node:http";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  authCookie,
  cookieCredential,
  isInternalAuthorized,
  isSameOriginWrite,
  secureRequest,
  tokenMatches,
} from "./auth.mjs";
import { ApprovalBroker } from "./approval-broker.mjs";
import { CodexAppServerBridge } from "./app-server-bridge.mjs";
import { CompletionPolicy } from "./completion-policy.mjs";
import { DeviceStore } from "./device-store.mjs";
import { ImageStore, MAX_IMAGE_BYTES } from "./image-store.mjs";
import { dataPaths, resolveCodexHome } from "./paths.mjs";
import { PushBroker } from "./push-broker.mjs";
import { RolloutScanner } from "./rollout-scanner.mjs";
import { inspectCodexRuntime } from "./runtime-diagnostics.mjs";
import { nodeRuntimeStatus } from "./service-diagnostics.mjs";
import { SessionStore } from "./session-store.mjs";
import { TaskTitleGenerator } from "./task-title-generator.mjs";
import { drainSpool } from "./spool.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 1024 * 1024;
const PAIRING_TTL_MS = 10 * 60_000;
const VERSION = "0.6.1";

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function securityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'",
  );
}

function encodedPayload(response, payload) {
  const accepted = String(response.req?.headers?.["accept-encoding"] || "");
  if (payload.length < 1_024 || !/(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/i.test(accepted)) {
    return { payload, headers: {} };
  }
  return {
    payload: gzipSync(payload, { level: 6 }),
    headers: { "content-encoding": "gzip", vary: "accept-encoding" },
  };
}

function json(response, status, body, headers = {}) {
  const encoded = encodedPayload(response, Buffer.from(JSON.stringify(body)));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.payload.length,
    "cache-control": "no-store",
    ...encoded.headers,
    ...headers,
  });
  response.end(encoded.payload);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body is not valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function readBuffer(request, maxBytes) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendSse(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function publicAppServerStatus(status = {}) {
  return {
    connected: Boolean(status.connected),
    initialized: Boolean(status.initialized),
    transport: status.transport || "unavailable",
    server: status.server || null,
    loadedThreadCount: status.loadedThreads?.length || 0,
    subscribedThreadCount: status.subscribedThreads?.length || 0,
    unavailableThreadCount: status.unavailableThreads?.length || 0,
    retryingSubscriptions: status.retryingSubscriptions || 0,
    pendingQuestions: status.pendingQuestions || 0,
  };
}

function publicHostUrls(port) {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

function staticTarget(publicDir, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(publicDir, requested);
  return target === publicDir || target.startsWith(`${publicDir}${path.sep}`) ? target : null;
}

export async function createPhoneControlServer({
  config,
  pluginRoot = DEFAULT_ROOT,
  codexHome = resolveCodexHome(),
  scanRollouts = true,
  appServerBridge,
  runtimeInspector = inspectCodexRuntime,
  rolloutScanner,
  taskTitleGenerator,
} = {}) {
  if (!config?.token) throw new Error("Phone Control requires an access token");
  const paths = dataPaths(config.dataDir);
  const publicDir = path.join(pluginRoot, "public");
  const store = new SessionStore({
    eventLogPath: paths.eventLog,
    taskTitlesPath: paths.taskTitles,
    retentionDays: config.retentionDays,
    maxEventLogBytes: config.maxEventLogBytes,
    machineName: config.machineName,
  });
  await store.restore();
  const titleGenerator = taskTitleGenerator === undefined
    ? new TaskTitleGenerator({ pluginRoot })
    : taskTitleGenerator;
  const rememberPhonePrompt = (command, text) => {
    if (!command?.sessionId || !command?.id || typeof text !== "string" || !text.trim()) return;
    store.ingest({
      eventId: `phone-prompt-${command.id}`,
      source: "phone-control",
      provider: "codex",
      sessionId: command.sessionId,
      turnId: command.turnId || null,
      at: command.deliveredAt || new Date().toISOString(),
      kind: "user_prompt",
      cwd: command.cwd || null,
      surface: command.action === "create" ? "Phone" : null,
      model: command.model || null,
      reasoningEffort: command.reasoningEffort || null,
      serviceTier: command.serviceTier || null,
      message: { role: "user", text },
    }, { persist: false });
  };
  const devices = new DeviceStore({ filePath: paths.devices });
  await devices.restore();
  const push = new PushBroker({
    filePath: paths.push,
    deviceIsActive: (id) => devices.isActive(id),
  });
  push.on("warning", (error) => store.emit("warning", error));
  await push.restore();
  const completionPolicy = new CompletionPolicy();
  const images = new ImageStore({ directory: paths.uploads });
  await images.initialize();
  const approvals = new ApprovalBroker({
    enabled: config.approvals?.enabled,
    timeoutSeconds: config.approvals?.timeoutSeconds,
    auditLogPath: paths.auditLog,
  });
  approvals.on("warning", (error) => store.emit("warning", error));
  approvals.on("resolved", (approval) => {
    store.ingest({
      eventId: `approval-${approval.id}-${approval.status}`,
      source: "phone-control",
      provider: "codex",
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      at: approval.decidedAt || new Date().toISOString(),
      kind: approval.status === "expired" ? "approval_expired" : "approval_resolved",
      decision: approval.decision,
    });
  });

  const bridge = appServerBridge === undefined
    ? config.interactions?.enabled
      ? new CodexAppServerBridge({
        auditLogPath: paths.auditLog,
        socketPath: path.join(codexHome, "app-server-control", "app-server-control.sock"),
      })
      : null
    : appServerBridge;
  if (bridge) {
    bridge.on("warning", (error) => store.emit("warning", error));
    const syncBridgeState = (status = bridge.status()) => store.setBridgeState({
      connected: status.connected && status.initialized,
      loadedThreads: status.loadedThreads,
      subscribedThreads: status.subscribedThreads,
      threadStates: status.threadStates,
      unavailableThreadReasons: status.unavailableThreadReasons,
    });
    bridge.on("status", syncBridgeState);
    bridge.on("loaded", () => syncBridgeState());
    bridge.on("question", (interaction) => {
      store.ingest({
        eventId: `question-${interaction.id}`,
        source: "app-server",
        provider: "codex",
        sessionId: interaction.sessionId,
        turnId: interaction.turnId,
        at: interaction.createdAt,
        kind: "question",
        tool: { name: "request_user_input", summary: interaction.questions[0]?.question || null },
        interaction,
      }, { persist: false });
    });
    bridge.on("answered", (interaction) => {
      store.ingest({
        eventId: `question-${interaction.id}-answered`,
        source: "phone-control",
        provider: "codex",
        sessionId: interaction.sessionId,
        turnId: interaction.turnId,
        at: interaction.decidedAt || new Date().toISOString(),
        kind: "question_answered",
        delivery: interaction.delivery,
      }, { persist: false });
    });
    bridge.on("unavailable", (interaction) => {
      store.ingest({
        eventId: `question-${interaction.id}-unavailable`,
        source: "phone-control",
        provider: "codex",
        sessionId: interaction.sessionId,
        turnId: interaction.turnId,
        at: new Date().toISOString(),
        kind: "question_unavailable",
        delivery: interaction.delivery,
        reason: interaction.unavailableReason || "手机回答通道已失效，请回到原 Codex 客户端处理",
      }, { persist: false });
    });
    bridge.on("command", (command) => {
      store.ingest({
        eventId: `phone-input-${command.id}`,
        source: "phone-control",
        provider: "codex",
        sessionId: command.sessionId,
        turnId: command.turnId,
        at: command.deliveredAt || new Date().toISOString(),
        kind: "phone_input_sent",
        action: command.action,
        cwd: command.cwd || null,
        surface: command.action === "create" ? "Phone" : null,
        model: command.model || null,
        reasoningEffort: command.reasoningEffort || null,
        serviceTier: command.serviceTier || null,
      }, { persist: false });
    });
    bridge.on("interrupt", (operation) => {
      store.ingest({
        eventId: `phone-interrupt-${operation.id}`,
        source: "phone-control",
        provider: "codex",
        sessionId: operation.sessionId,
        turnId: operation.turnId,
        at: operation.deliveredAt || new Date().toISOString(),
        kind: "phone_interrupt_sent",
      }, { persist: false });
    });
    bridge.on("turn/started", (params) => {
      if (!params?.threadId || !params.turn?.id) return;
      store.ingest({
        eventId: `app-server-turn-${params.turn.id}-started`,
        source: "app-server",
        provider: "codex",
        sessionId: params.threadId,
        turnId: params.turn.id,
        at: new Date().toISOString(),
        kind: "turn_start",
      }, { persist: false });
    });
    bridge.on("turn/completed", (params) => {
      if (!params?.threadId || !params.turn?.id) return;
      const kind = params.turn.status === "failed"
        ? "error"
        : params.turn.status === "interrupted"
          ? "aborted"
          : "turn_complete";
      store.ingest({
        eventId: `app-server-turn-${params.turn.id}-${params.turn.status}`,
        source: "app-server",
        provider: "codex",
        sessionId: params.threadId,
        turnId: params.turn.id,
        at: new Date().toISOString(),
        kind,
        message: params.turn.error?.message ? { role: "system", text: params.turn.error.message } : null,
      }, { persist: false });
    });
    bridge.on("thread/deleted", (params) => {
      if (params?.threadId) store.remove(params.threadId);
    });
  }

  const scanner = rolloutScanner || new RolloutScanner({ sessionsDir: path.join(codexHome, "sessions") });
  scanner.on("event", (event) => store.ingest(event));
  scanner.on("warning", (error) => store.emit("warning", error));

  const sseClients = new Set();
  const visibleSessionIds = new Set(store.list({ taskKind: "user" }).map((session) => session.id));
  const visibleSessions = () => store.list({ taskKind: "user" });
  let pushReady = false;
  const publishSession = (session) => {
    if (session.taskKind === "user") {
      visibleSessionIds.add(session.id);
      for (const client of sseClients) sendSse(client.response, "session", session);
    } else if (visibleSessionIds.delete(session.id)) {
      for (const client of sseClients) sendSse(client.response, "session_removed", { id: session.id });
    }
    if (!pushReady) return;
    const completion = completionPolicy.observe(session);
    if (!completion) return;
    const { notifyUntargeted, ...publicCompletion } = completion;
    const recipientIds = new Set(devices.notificationRecipients(session.id, { includeUntargeted: notifyUntargeted }));
    for (const client of sseClients) {
      if (recipientIds.has(client.deviceId)) sendSse(client.response, "completion", publicCompletion);
    }
    void push.broadcast(publicCompletion, { deviceIds: recipientIds }).catch((error) => store.emit("warning", error));
  };
  store.on("session", publishSession);
  store.on("removed", ({ id }) => {
    visibleSessionIds.delete(id);
    devices.clearTargetSession(id);
    for (const client of sseClients) sendSse(client.response, "session_removed", { id });
  });

  const attempts = new Map();
  const pairingCodes = new Map();

  function phoneApprovalRouting() {
    const supportsRouting = typeof bridge?.approvalConfiguration === "function";
    const configuration = supportsRouting ? bridge.approvalConfiguration() : null;
    const reviewer = configuration?.approvalsReviewer || null;
    const codexAutoReviews = reviewer === "auto_review";
    const routingKnown = !supportsRouting || Boolean(configuration);
    return {
      configured: approvals.enabled,
      enabled: approvals.enabled && routingKnown && !codexAutoReviews,
      reviewer,
      reason: !approvals.enabled
        ? "phone_approvals_disabled"
        : !routingKnown
          ? "approval_routing_unavailable"
          : codexAutoReviews
            ? "codex_auto_review"
            : "phone_approvals_available",
    };
  }

  function createPairing({ baseUrl = config.publicUrl } = {}) {
    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    pairingCodes.set(code, { expiresAt });
    const pathname = `/pair?code=${encodeURIComponent(code)}`;
    return { code, expiresAt, pathname, url: baseUrl ? `${baseUrl.replace(/\/$/, "")}${pathname}` : null };
  }

  function consumePairing(code) {
    const pairing = pairingCodes.get(code);
    pairingCodes.delete(code);
    if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) return null;
    return pairing;
  }

  function pairDevice(request, name = null) {
    return devices.pair({
      name: name || request.headers["x-phone-control-device-name"] || "Mobile browser",
      userAgent: request.headers["user-agent"],
      remoteAddress: request.socket.remoteAddress,
    });
  }

  function cookieFor(request, credential, options = {}) {
    return authCookie(credential, {
      ...options,
      secure: secureRequest(request, config.secureCookies),
    });
  }

  function requestBaseUrl(request) {
    if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
    const protocol = secureRequest(request, config.secureCookies) ? "https" : "http";
    return `${protocol}://${request.headers.host || `127.0.0.1:${config.port}`}`;
  }

  const server = http.createServer(async (request, response) => {
    securityHeaders(response);
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    try {
      let device = devices.authenticate(cookieCredential(request));
      if (!device && tokenMatches(cookieCredential(request), config.token)) {
        const migrated = pairDevice(request, "Migrated browser");
        device = migrated.device;
        response.setHeader("set-cookie", cookieFor(request, migrated.credential));
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { ok: true, version: VERSION, authenticated: Boolean(device) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Pairing request failed origin checks" });
          return;
        }
        const remote = request.socket.remoteAddress || "unknown";
        const recent = (attempts.get(remote) || []).filter((time) => Date.now() - time < 60_000);
        if (recent.length >= 8) {
          json(response, 429, { error: "Too many pairing attempts" });
          return;
        }
        recent.push(Date.now());
        attempts.set(remote, recent);
        const body = await readJson(request);
        if (!tokenMatches(body.token, config.token)) {
          json(response, 401, { error: "Invalid access token" });
          return;
        }
        attempts.delete(remote);
        const paired = pairDevice(request, body.name);
        json(response, 200, { ok: true, device: paired.device }, { "set-cookie": cookieFor(request, paired.credential) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/pair") {
        if (!consumePairing(url.searchParams.get("code"))) {
          json(response, 410, { error: "Pairing link expired or was already used" });
          return;
        }
        const paired = pairDevice(request);
        response.writeHead(302, {
          location: "/",
          "set-cookie": cookieFor(request, paired.credential),
          "cache-control": "no-store",
        });
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/" && tokenMatches(url.searchParams.get("token"), config.token)) {
        const paired = pairDevice(request);
        response.writeHead(302, {
          location: "/",
          "set-cookie": cookieFor(request, paired.credential),
          "cache-control": "no-store",
        });
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/internal/hook") {
        if (!isInternalAuthorized(request, config.token)) {
          json(response, 403, { error: "Hook ingestion is local-only" });
          return;
        }
        const event = await readJson(request);
        if (!event?.sessionId || !event?.kind) {
          json(response, 400, { error: "Invalid normalized hook event" });
          return;
        }
        store.ingest(event);
        json(response, 202, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/internal/pairings") {
        if (!isInternalAuthorized(request, config.token)) {
          json(response, 403, { error: "Pairing creation is local-only" });
          return;
        }
        const body = await readJson(request);
        const pairing = createPairing({ baseUrl: body.baseUrl || config.publicUrl });
        json(response, 201, { pairing });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/internal/approvals") {
        if (!isInternalAuthorized(request, config.token)) {
          json(response, 403, { error: "Approval hook ingestion is local-only" });
          return;
        }
        const body = await readJson(request);
        const event = body.event;
        if (!event?.sessionId || event.kind !== "permission_request") {
          json(response, 400, { error: "Invalid permission event" });
          return;
        }
        // A PermissionRequest hook runs alongside Codex's normal approval
        // channel. Only intercept turns that the phone itself started or
        // steered; otherwise a desktop/CLI approval would be duplicated and
        // Codex would wait for both independent paths.
        const phoneControlled = store.isPhoneControlledTurn(event.sessionId, event.turnId);
        const routing = phoneApprovalRouting();
        const approval = phoneControlled && routing.enabled ? approvals.create(event) : null;
        // A desktop/CLI PermissionRequest is intentionally not ingested as a
        // pending interaction. It is not actionable from this phone channel,
        // and showing it would leave a false "needs approval" card even after
        // Codex's normal reviewer has already allowed the operation.
        if (approval) {
          store.ingest({ ...event, approval: { id: approval.id, expiresAt: approval.expiresAt } });
        }
        json(response, approval ? 201 : 202, {
          enabled: Boolean(approval),
          approval,
          reason: approval
            ? "phone_controlled_turn"
            : !routing.enabled
              ? routing.reason
              : "normal_codex_approval",
        });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/internal/approvals/")) {
        if (!isInternalAuthorized(request, config.token)) {
          json(response, 403, { error: "Approval wait is local-only" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/internal/approvals/".length));
        const approval = await approvals.wait(id, (config.approvals?.timeoutSeconds || 45) * 1_000 + 2_000);
        if (!approval) json(response, 404, { error: "Approval not found" });
        else json(response, 200, { approval });
        return;
      }

      if (url.pathname.startsWith("/api/") && !device) {
        json(response, 401, { error: "Pair this device to continue" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/logout") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Missing client confirmation header" });
          return;
        }
        json(response, 200, { ok: true }, { "set-cookie": cookieFor(request, "", { clear: true }) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        const rawAppServerStatus = bridge?.status() || {
          connected: false,
          initialized: false,
          transport: "disabled",
          loadedThreads: [],
          subscribedThreads: [],
          threadStates: {},
          unavailableThreads: [],
          retryingSubscriptions: 0,
          pendingQuestions: 0,
        };
        const codex = bridge?.codexStatus
          ? await bridge.codexStatus({ force: url.searchParams.get("refresh") === "1" })
          : {
            available: false,
            checkedAt: new Date().toISOString(),
            server: null,
            account: null,
            configuration: null,
            usage: { limits: [], resetCreditsAvailable: 0 },
            partial: true,
          };
        const runtime = await runtimeInspector({
          appServerUserAgent: rawAppServerStatus.server?.userAgent || codex.server?.userAgent || null,
        }).catch(() => ({
          available: false,
          checkedAt: new Date().toISOString(),
          cliVersion: null,
          appServerVersion: null,
          restartRecommended: false,
          reason: null,
        }));
        const phoneApprovals = phoneApprovalRouting();
        json(response, 200, {
          version: VERSION,
          mode: phoneApprovals.enabled ? "approve" : "observe",
          sessions: visibleSessions().length,
          rolloutScanner: scanRollouts,
          machineName: config.machineName,
          approvalsEnabled: phoneApprovals.enabled,
          approvalsConfigured: phoneApprovals.configured,
          approvalRoutingReason: phoneApprovals.reason,
          interactionsEnabled: Boolean(bridge),
          codex,
          runtime: { ...runtime, phoneControlNode: nodeRuntimeStatus() },
          appServer: publicAppServerStatus(rawAppServerStatus),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/devices") {
        const listed = devices.list();
        json(response, 200, {
          currentDeviceId: device.id,
          devices: listed,
          activeDevices: listed.filter((candidate) => !candidate.revokedAt),
          revokedDevices: listed.filter((candidate) => candidate.revokedAt),
          counts: devices.counts(),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/models") {
        const [catalog, codex] = await Promise.all([
          bridge?.modelCatalog ? bridge.modelCatalog({ force: url.searchParams.get("refresh") === "1" }) : Promise.resolve({ available: false, checkedAt: new Date().toISOString(), models: [] }),
          bridge?.codexStatus ? bridge.codexStatus() : Promise.resolve({ configuration: null }),
        ]);
        const workspacesByPath = new Map();
        for (const session of visibleSessions().filter((candidate) => candidate.cwd)) {
          const existing = workspacesByPath.get(session.cwd);
          workspacesByPath.set(session.cwd, {
            path: session.cwd,
            lastUsedAt: !existing || session.updatedAt > existing.lastUsedAt ? session.updatedAt : existing.lastUsedAt,
            sessionCount: (existing?.sessionCount || 0) + 1,
          });
        }
        const workspaces = Array.from(workspacesByPath.values())
          .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
          .slice(0, 12);
        json(response, 200, { ...catalog, configuration: codex.configuration || null, machineName: config.machineName, workspaces });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/push") {
        json(response, 200, push.status(device.id));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/target") {
        json(response, 200, { sessionId: devices.target(device.id) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/target") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Target session update failed origin checks" });
          return;
        }
        const body = await readJson(request);
        const sessionId = body.sessionId == null ? null : body.sessionId;
        if (sessionId != null && (typeof sessionId !== "string" || !visibleSessionIds.has(sessionId))) {
          json(response, 404, { error: "Target session not found" });
          return;
        }
        json(response, 200, { sessionId: devices.setTarget(device.id, sessionId) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/push/subscribe") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Push subscription failed origin checks" });
          return;
        }
        const body = await readJson(request);
        json(response, 200, await push.subscribe(device.id, body.subscription));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/push/unsubscribe") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Push removal failed origin checks" });
          return;
        }
        await push.unsubscribe(device.id);
        json(response, 200, { ok: true, subscribed: false });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/push/test") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Push test failed origin checks" });
          return;
        }
        json(response, 200, await push.test(device.id));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/pairings") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Pairing request failed origin checks" });
          return;
        }
        const pairing = createPairing({ baseUrl: requestBaseUrl(request) });
        json(response, 201, { pairing });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/devices/revoked") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Device cleanup failed origin checks" });
          return;
        }
        const removed = devices.purgeRevoked();
        json(response, 200, { ok: true, removed, counts: devices.counts() });
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/devices/") && url.pathname.endsWith("/revoke")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Device revocation failed origin checks" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/devices/".length, -"/revoke".length));
        if (!devices.revoke(id)) {
          json(response, 404, { error: "Device not found" });
          return;
        }
        await push.unsubscribe(id);
        const headers = id === device.id ? { "set-cookie": cookieFor(request, "", { clear: true }) } : {};
        json(response, 200, { ok: true, revokedDeviceId: id }, headers);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/approvals") {
        json(response, 200, { enabled: approvals.enabled, approvals: approvals.list() });
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/approvals/") && url.pathname.endsWith("/decision")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Approval decision failed origin checks" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/approvals/".length, -"/decision".length));
        const body = await readJson(request);
        const approval = approvals.decide(id, body.decision, device);
        json(response, 200, { approval });
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/questions/") && url.pathname.endsWith("/answer")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Question answer failed origin checks" });
          return;
        }
        if (!bridge) {
          json(response, 409, { error: "Interactive Codex bridge is disabled" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/questions/".length, -"/answer".length));
        const body = await readJson(request);
        const interaction = await bridge.answer(id, {
          answers: body.answers,
          sessionId: body.sessionId,
          turnId: body.turnId,
        }, device);
        json(response, 200, { interaction });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Session creation failed origin checks" });
          return;
        }
        if (!bridge || typeof bridge.createSession !== "function") {
          json(response, 409, { error: "Interactive Codex bridge cannot create sessions" });
          return;
        }
        const body = await readJson(request);
        const command = await bridge.createSession({
          text: body.text,
          cwd: body.cwd,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          serviceTier: body.serviceTier,
          clientMessageId: body.clientMessageId,
        }, device);
        rememberPhonePrompt(command, body.text);
        json(response, 201, { command });
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/input")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Session input failed origin checks" });
          return;
        }
        if (!bridge) {
          json(response, 409, { error: "Interactive Codex bridge is disabled" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/input".length));
        const session = store.get(id);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        if (session.pendingApproval || !session.control?.canSend) {
          json(response, 409, { error: session.control?.reason || "This session cannot accept phone input" });
          return;
        }
        const body = await readJson(request);
        const expectedTurnId = body.expectedTurnId == null ? null : body.expectedTurnId;
        if (expectedTurnId !== (session.control.expectedTurnId || null)) {
          json(response, 409, { error: "The Codex turn changed; refresh before sending" });
          return;
        }
        const imageRecords = await images.consume(body.imageIds || [], { deviceId: device.id, sessionId: id, expectedTurnId });
        let command;
        try {
          command = await bridge.sendInput({
            sessionId: id,
            expectedTurnId,
            text: body.text,
            images: imageRecords.map((record) => ({ path: record.path, mime: record.mime })),
            model: body.model,
            reasoningEffort: body.reasoningEffort,
            serviceTier: body.serviceTier,
            cwd: body.cwd,
            clientMessageId: body.clientMessageId,
          }, device);
          rememberPhonePrompt(command, body.text);
        } catch (error) {
          await images.discardRecords(imageRecords);
          throw error;
        }
        json(response, 200, { command });
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/interrupt")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Turn interruption failed origin checks" });
          return;
        }
        if (!bridge || typeof bridge.interruptTurn !== "function") {
          json(response, 409, { error: "Interactive Codex bridge cannot stop turns" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/interrupt".length));
        const session = store.get(id);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        if (session.taskKind !== "user" || !session.control?.canInterrupt) {
          json(response, 409, { error: session.control?.reason || "This session has no verified active turn to stop" });
          return;
        }
        const body = await readJson(request);
        if (body.expectedTurnId !== session.control.expectedTurnId) {
          json(response, 409, { error: "The active Codex turn changed; refresh before stopping" });
          return;
        }
        const operation = await bridge.interruptTurn({
          sessionId: id,
          expectedTurnId: body.expectedTurnId,
        }, device);
        json(response, 200, { operation });
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/task-title/suggest")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Task title generation failed origin checks" });
          return;
        }
        if (!titleGenerator?.suggest) {
          json(response, 503, { error: "Smart task naming is not available" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/task-title/suggest".length));
        const context = store.taskTitleContext(id);
        const suggestion = await titleGenerator.suggest(context);
        json(response, 200, { suggestion });
        return;
      }

      if (request.method === "PUT" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/task-title")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Task rename failed origin checks" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/task-title".length));
        const body = await readJson(request);
        const session = await store.setTaskTitle(id, body.title ?? null);
        json(response, 200, { session });
        return;
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Session deletion failed origin checks" });
          return;
        }
        if (!bridge || typeof bridge.deleteSession !== "function") {
          json(response, 409, { error: "Interactive Codex bridge cannot delete sessions" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        const session = store.get(id);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        if (session.taskKind !== "user") {
          json(response, 409, { error: "Only user sessions can be deleted from the phone" });
          return;
        }
        if (["working", "waiting"].includes(session.status)) {
          json(response, 409, { error: "Stop or finish the current Codex turn before deleting this session" });
          return;
        }
        const operation = await bridge.deleteSession({ sessionId: id }, device);
        store.remove(id);
        json(response, 200, { operation });
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/images")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Image upload failed origin checks" });
          return;
        }
        if (!bridge) {
          json(response, 409, { error: "Interactive Codex bridge is disabled" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/images".length));
        const session = store.get(id);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        if (session.pendingApproval || !session.control?.canSend) {
          json(response, 409, { error: session.control?.reason || "This session cannot accept phone input" });
          return;
        }
        const expectedTurnId = url.searchParams.get("expectedTurnId") || null;
        if (expectedTurnId !== (session.control.expectedTurnId || null)) {
          json(response, 409, { error: "The Codex turn changed; refresh before uploading" });
          return;
        }
        const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(contentType)) {
          json(response, 415, { error: "Only JPEG, PNG, and WebP images are accepted" });
          return;
        }
        const image = await images.store({
          buffer: await readBuffer(request, MAX_IMAGE_BYTES),
          deviceId: device.id,
          sessionId: id,
          expectedTurnId,
        });
        json(response, 201, { image });
        return;
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/images/")) {
        if (!isSameOriginWrite(request)) {
          json(response, 403, { error: "Image removal failed origin checks" });
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/api/images/".length));
        const removed = await images.discard(id, device.id);
        json(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Image not found" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tasks/search") {
        const query = String(url.searchParams.get("q") || "").trim();
        const requestedLimit = Number(url.searchParams.get("limit") || 60);
        if (query.length > 160) {
          json(response, 400, { error: "Search query must be 160 characters or fewer" });
          return;
        }
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
          json(response, 400, { error: "limit must be an integer from 1 to 100" });
          return;
        }
        const results = query ? store.search({ query, limit: requestedLimit, taskKind: "user" }) : [];
        json(response, 200, {
          query,
          results,
          total: results.length,
          generatedAt: new Date().toISOString(),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        json(response, 200, { sessions: visibleSessions(), generatedAt: new Date().toISOString() });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        const requestedEvents = url.searchParams.get("events");
        let eventLimit = null;
        if (requestedEvents && requestedEvents !== "all") {
          const parsed = Number(requestedEvents);
          if (!Number.isInteger(parsed) || parsed < 24 || parsed > 240) {
            json(response, 400, { error: "events must be all or an integer from 24 to 240" });
            return;
          }
          eventLimit = parsed;
        }
        const session = store.get(id, { eventLimit });
        if (!session) json(response, 404, { error: "Session not found" });
        else json(response, 200, { session });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write("retry: 1500\n\n");
        sendSse(response, "snapshot", { sessions: visibleSessions(), generatedAt: new Date().toISOString() });
        const client = { response, deviceId: device.id };
        sseClients.add(client);
        request.once("close", () => sseClients.delete(client));
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "Method not allowed" });
        return;
      }
      const target = staticTarget(publicDir, url.pathname);
      if (!target) {
        json(response, 404, { error: "Not found" });
        return;
      }
      try {
        const body = await readFile(target);
        const encoded = encodedPayload(response, body);
        const versioned = url.searchParams.has("v") && ["/app.js", "/styles.css"].includes(url.pathname);
        const revalidate = ["/", "/sw.js"].includes(url.pathname) || !versioned && ["/app.js", "/styles.css"].includes(url.pathname);
        response.writeHead(200, {
          "content-type": MIME[path.extname(target)] || "application/octet-stream",
          "content-length": encoded.payload.length,
          "cache-control": versioned ? "public, max-age=31536000, immutable" : revalidate ? "no-cache" : "public, max-age=300",
          ...encoded.headers,
        });
        response.end(request.method === "HEAD" ? undefined : encoded.payload);
      } catch (error) {
        if (error.code === "ENOENT") json(response, 404, { error: "Not found" });
        else throw error;
      }
    } catch (error) {
      json(response, error.statusCode || 500, { error: error.statusCode ? error.message : "Internal server error" });
      if (!error.statusCode) store.emit("warning", error);
    }
  });

  let spoolTimer = null;
  let heartbeatTimer = null;
  let compactTimer = null;
  let imageCleanupTimer = null;
  async function start() {
    await drainSpool(paths.hookSpool, async (event) => store.ingest(event));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    spoolTimer = setInterval(
      () => void drainSpool(paths.hookSpool, async (event) => store.ingest(event)),
      2_000,
    );
    spoolTimer.unref?.();
    heartbeatTimer = setInterval(() => {
      const heartbeat = { at: new Date().toISOString() };
      for (const client of sseClients) sendSse(client.response, "ping", heartbeat);
    }, 12_000);
    heartbeatTimer.unref?.();
    compactTimer = setInterval(() => void store.compact(), 6 * 60 * 60_000);
    compactTimer.unref?.();
    // The first rollout scan may inspect hundreds of large transcripts. Keep
    // the health endpoint, cached session snapshot, and static PWA reachable
    // while that background state is reconstructed instead of presenting a
    // connection-refused window after every service restart.
    if (scanRollouts) await scanner.start();
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    if (bridge) await bridge.start();
    completionPolicy.seed(visibleSessions());
    pushReady = true;
    imageCleanupTimer = setInterval(() => void images.cleanup(), 60_000);
    imageCleanupTimer.unref?.();
    return { port, localUrl: `http://127.0.0.1:${port}`, networkUrls: publicHostUrls(port) };
  }

  async function close() {
    scanner.stop();
    if (spoolTimer) clearInterval(spoolTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (compactTimer) clearInterval(compactTimer);
    if (imageCleanupTimer) clearInterval(imageCleanupTimer);
    for (const client of sseClients) client.response.end();
    sseClients.clear();
    await store.flush();
    await store.compact();
    await devices.flush();
    await push.flush();
    await images.close();
    await approvals.close();
    await bridge?.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, store, scanner, devices, push, images, approvals, bridge, titleGenerator, createPairing, start, close };
}
