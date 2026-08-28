import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import path, { dirname } from "node:path";
import { clampText } from "./utils.mjs";
import { resolveCodexHome } from "./paths.mjs";
import { connectUnixWebSocket } from "./unix-websocket.mjs";

// Match the official remote App Server client's bounded message envelope. The
// bridge still avoids large history responses by using metadata-only resume.
const MAX_LINE_BYTES = 128 * 1024 * 1024;
const MAX_AUDIT_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const LOADED_THREAD_REFRESH_MS = 2_000;
const SUBSCRIPTION_RETRY_MIN_MS = 1_000;
const PERMANENT_SUBSCRIPTION_FAILURE_ATTEMPTS = 3;
const CODEX_STATUS_CACHE_MS = 30_000;
const MODEL_CATALOG_CACHE_MS = 5 * 60_000;
const MAX_PHONE_INPUT_CHARS = 4_000;
const MAX_COMMAND_RECORDS = 512;
const CLIENT_VERSION = "0.6.0";
const RESUME_INITIAL_TURNS_PAGE = Object.freeze({
  limit: 1,
  sortDirection: "desc",
  itemsView: "notLoaded",
});
const OPT_OUT_NOTIFICATION_METHODS = Object.freeze([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "turn/diff/updated",
  "turn/plan/updated",
  "thread/tokenUsage/updated",
]);

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function isPermanentSubscriptionError(error) {
  const message = String(error?.message || "");
  return error?.code === "ERR_RESUME_HISTORY_INCLUDED"
    || /no rollout(?: was)? found|rollout (?:does not exist|not found)|thread (?:does not exist|not found)|unknown thread/i.test(message);
}

function isImmediatePermanentSubscriptionError(error) {
  return error?.code === "ERR_RESUME_HISTORY_INCLUDED";
}

function isOversizedTransportError(error) {
  return error?.code === "ERR_WS_MESSAGE_TOO_LARGE"
    || /oversized JSON line|WebSocket (?:frame|message|payload) is too large/i.test(String(error?.message || ""));
}

function metadataResumeParams(threadId) {
  return {
    threadId,
    excludeTurns: true,
    initialTurnsPage: { ...RESUME_INITIAL_TURNS_PAGE },
  };
}

function validateMetadataResume(result, threadId) {
  if (result?.thread?.id !== threadId) {
    throw new Error(`App-server resumed an unexpected thread for ${threadId}`);
  }
  if (Array.isArray(result.thread.turns) && result.thread.turns.length) {
    throw Object.assign(new Error(
      "App-server did not honor metadata-only resume; live control was isolated to prevent loading full history",
    ), { code: "ERR_RESUME_HISTORY_INCLUDED" });
  }
  return result.thread;
}

function maskEmail(value) {
  const email = clampText(value, 320);
  const separator = email.indexOf("@");
  if (separator <= 0 || separator === email.length - 1) return null;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : `${local.slice(0, 1)}…${local.slice(-1)}`;
  return `${visible}@${domain}`;
}

function normalizePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, Math.round(number * 10) / 10));
}

function normalizeRateWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = normalizePercent(window.usedPercent);
  const windowMinutes = Number.isFinite(Number(window.windowDurationMins))
    ? Math.max(0, Math.round(Number(window.windowDurationMins)))
    : null;
  const resetSeconds = Number(window.resetsAt);
  return {
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10),
    windowMinutes,
    resetsAt: Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1_000).toISOString() : null,
  };
}

function normalizeRateLimit(limit) {
  if (!limit || typeof limit !== "object") return null;
  return {
    id: clampText(limit.limitId, 120) || "codex",
    name: clampText(limit.limitName, 160) || "Codex",
    primary: normalizeRateWindow(limit.primary),
    secondary: normalizeRateWindow(limit.secondary),
    spendControlReached: Boolean(limit.spendControlReached),
    rateLimitReachedType: clampText(limit.rateLimitReachedType, 120) || null,
  };
}

function publicCodexStatus({ accountResult, rateLimitsResult, configResult, serverInfo, checkedAt }) {
  const account = accountResult?.account && typeof accountResult.account === "object"
    ? {
      type: clampText(accountResult.account.type, 80) || "unknown",
      email: maskEmail(accountResult.account.email),
      planType: clampText(accountResult.account.planType, 80) || null,
    }
    : null;
  const config = configResult?.config && typeof configResult.config === "object" ? configResult.config : null;
  const rawLimits = rateLimitsResult?.rateLimitsByLimitId && typeof rateLimitsResult.rateLimitsByLimitId === "object"
    ? Object.values(rateLimitsResult.rateLimitsByLimitId)
    : rateLimitsResult?.rateLimits
      ? [rateLimitsResult.rateLimits]
      : [];
  const limits = rawLimits.map(normalizeRateLimit).filter(Boolean);
  return {
    available: true,
    checkedAt,
    server: serverInfo ? { ...serverInfo } : null,
    account,
    configuration: config ? {
      model: clampText(config.model, 160) || null,
      reasoningEffort: clampText(config.model_reasoning_effort, 80) || null,
      serviceTier: clampText(config.service_tier, 80) || null,
      approvalPolicy: clampText(config.approval_policy, 80) || null,
      approvalsReviewer: clampText(config.approvals_reviewer, 80) || null,
      sandboxMode: clampText(config.sandbox_mode, 80) || null,
    } : null,
    usage: {
      limits,
      resetCreditsAvailable: Number.isFinite(Number(rateLimitsResult?.rateLimitResetCredits?.availableCount))
        ? Math.max(0, Math.round(Number(rateLimitsResult.rateLimitResetCredits.availableCount)))
        : 0,
    },
    partial: !account || !config || !limits.length,
  };
}

function normalizeModelEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = clampText(entry.id ?? entry.model, 160);
  if (!id) return null;
  const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
      .map((item) => clampText(item?.reasoningEffort ?? item, 40))
      .filter(Boolean)
    : [];
  const reasoningEffortDetails = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts.map((item) => ({
      id: clampText(item?.reasoningEffort ?? item, 40),
      description: clampText(item?.description, 240) || null,
    })).filter((item) => item.id)
    : [];
  const serviceTiers = Array.isArray(entry.serviceTiers)
    ? entry.serviceTiers.map((tier) => ({
      id: clampText(tier?.id ?? tier, 80),
      name: clampText(tier?.name, 120) || clampText(tier?.id ?? tier, 80),
      description: clampText(tier?.description, 240) || null,
    })).filter((tier) => tier.id)
    : [];
  return {
    id,
    displayName: clampText(entry.displayName, 160) || id,
    description: clampText(entry.description, 320) || null,
    defaultReasoningEffort: clampText(entry.defaultReasoningEffort, 40) || null,
    supportedReasoningEfforts: Array.from(new Set(supportedReasoningEfforts)),
    reasoningEffortDetails,
    serviceTiers,
    defaultServiceTier: clampText(entry.defaultServiceTier, 80) || null,
    inputModalities: Array.isArray(entry.inputModalities)
      ? entry.inputModalities.map((item) => clampText(item, 40)).filter(Boolean)
      : ["text", "image"],
    isDefault: Boolean(entry.isDefault),
  };
}

function approvalConfiguration(configResult) {
  const config = configResult?.config && typeof configResult.config === "object" ? configResult.config : null;
  if (!config) return null;
  return {
    approvalPolicy: clampText(config.approval_policy, 80) || null,
    approvalsReviewer: clampText(config.approvals_reviewer, 80) || null,
    checkedAt: new Date().toISOString(),
  };
}

function defaultTransportFactory({ socketPath }) {
  return connectUnixWebSocket(socketPath);
}

function normalizePhoneInput(value, images = []) {
  if (value == null) value = "";
  if (typeof value !== "string") throw httpError("Message text is invalid", 400);
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length > MAX_PHONE_INPUT_CHARS) {
    throw httpError(`Message text must be ${MAX_PHONE_INPUT_CHARS} characters or fewer`, 400);
  }
  if (!Array.isArray(images) || images.length > 4) throw httpError("A message can include up to 4 images", 400);
  const cleanImages = images.map((image) => {
    const imagePath = typeof image?.path === "string" ? image.path.trim() : "";
    if (!imagePath || imagePath.length > 4096) throw httpError("Uploaded image reference is invalid", 400);
    return { type: "localImage", path: imagePath };
  });
  if (!text && !cleanImages.length) throw httpError("Message text or an image is required", 400);
  return {
    text,
    items: [...(text ? [{ type: "text", text }] : []), ...cleanImages],
    imageCount: cleanImages.length,
  };
}

function normalizeClientMessageId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{8,100}$/.test(value)) {
    throw httpError("A valid client message id is required", 400);
  }
  return value;
}

function normalizeWorkingDirectory(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw httpError("Working directory is invalid", 400);
  const cwd = value.trim();
  if (!cwd || cwd.length > 4_096 || /[\r\n\0]/.test(cwd)) {
    throw httpError("Working directory is invalid", 400);
  }
  return cwd;
}

async function validateWorkingDirectory(value) {
  const cwd = normalizeWorkingDirectory(value);
  if (!cwd) return null;
  if (!path.isAbsolute(cwd)) throw httpError("Working directory must be an absolute path on this computer", 400);
  try {
    const details = await stat(cwd);
    if (!details.isDirectory()) throw httpError("Working directory is not a directory", 400);
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError("Working directory does not exist on this computer", 409);
  }
  return cwd;
}

function normalizeModelSelection(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw httpError(`${label} is invalid`, 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\r\n\0]/.test(normalized)) {
    throw httpError(`${label} is invalid`, 400);
  }
  return normalized;
}

function runtimeFromThread(thread, initialTurnsPage = null) {
  if (!thread || typeof thread !== "object") return null;
  const status = thread.status && typeof thread.status.type === "string"
    ? thread.status.type
    : "unknown";
  const activeFlags = status === "active" && Array.isArray(thread.status.activeFlags)
    ? thread.status.activeFlags.filter((flag) => typeof flag === "string")
    : [];
  const pageTurns = Array.isArray(initialTurnsPage?.data) ? initialTurnsPage.data : [];
  const turns = Array.isArray(thread.turns) && thread.turns.length ? thread.turns : pageTurns;
  const activeTurn = [...turns].find((turn) => turn?.status === "inProgress" && typeof turn.id === "string") || null;
  return {
    status,
    activeFlags,
    activeTurnId: status === "active" ? activeTurn?.id || null : null,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeQuestions(params) {
  if (!params || typeof params !== "object") return null;
  const threadId = clampText(params.threadId, 200);
  const turnId = clampText(params.turnId, 200);
  const itemId = clampText(params.itemId, 200);
  if (!threadId || !turnId || !itemId || !Array.isArray(params.questions)) return null;
  const questions = params.questions.slice(0, 3).map((question) => {
    if (!question || typeof question !== "object") return null;
    const id = clampText(question.id, 100);
    const prompt = clampText(question.question, 2_000);
    if (!id || !prompt) return null;
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 8).map((option) => ({
        label: clampText(option?.label, 160),
        description: clampText(option?.description, 500),
      })).filter((option) => option.label)
      : [];
    return {
      id,
      header: clampText(question.header, 120) || "需要回答",
      question: prompt,
      isOther: Boolean(question.isOther),
      isSecret: Boolean(question.isSecret),
      options,
    };
  });
  if (!questions.length || questions.some((question) => !question)) return null;
  const autoResolutionMs = Number.isSafeInteger(params.autoResolutionMs) && params.autoResolutionMs >= 0
    ? params.autoResolutionMs
    : null;
  return { threadId, turnId, itemId, questions, autoResolutionMs };
}

function normalizeAnswers(interaction, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError("Answers must be an object keyed by question id", 400);
  }
  const expected = new Set(interaction.questions.map((question) => question.id));
  for (const id of Object.keys(input)) {
    if (!expected.has(id)) throw httpError("Answer contains an unknown question id", 400);
  }
  const answers = {};
  for (const question of interaction.questions) {
    const raw = input[question.id];
    const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const clean = values.map((value) => clampText(value, 2_000)).filter(Boolean).slice(0, 8);
    if (!clean.length) throw httpError(`Question ${question.id} requires an answer`, 400);
    if (question.options.length && !question.isOther) {
      const labels = new Set(question.options.map((option) => option.label));
      if (clean.some((value) => !labels.has(value))) {
        throw httpError(`Question ${question.id} only accepts one of the displayed options`, 400);
      }
    }
    answers[question.id] = { answers: clean };
  }
  return answers;
}

export class CodexAppServerBridge extends EventEmitter {
  constructor({
    socketPath = path.join(resolveCodexHome(), "app-server-control", "app-server-control.sock"),
    transportFactory = defaultTransportFactory,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    loadedThreadRefreshMs = LOADED_THREAD_REFRESH_MS,
    subscriptionRetryMinMs = SUBSCRIPTION_RETRY_MIN_MS,
    reconnect = true,
    auditLogPath = null,
  } = {}) {
    super();
    this.socketPath = socketPath;
    this.transportFactory = transportFactory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.loadedThreadRefreshMs = loadedThreadRefreshMs;
    this.subscriptionRetryMinMs = subscriptionRetryMinMs;
    this.reconnect = reconnect;
    this.auditLogPath = auditLogPath;
    this.transport = null;
    this.buffer = "";
    this.nextRequestId = 1;
    this.clientRequests = new Map();
    this.interactions = new Map();
    this.loadedThreads = new Set();
    this.subscribedThreads = new Set();
    this.subscribingThreads = new Map();
    this.subscriptionFailures = new Map();
    this.quarantinedThreads = new Map();
    this.threadStates = new Map();
    this.commands = new Map();
    this.interruptRequests = new Map();
    this.connected = false;
    this.initialized = false;
    this.stopped = true;
    this.connecting = null;
    this.reconnectTimer = null;
    this.loadedThreadRefreshTimer = null;
    this.refreshingLoadedThreads = null;
    this.reconnectDelayMs = 1_000;
    this.activeSubscriptionThreadId = null;
    this.resumeQueue = Promise.resolve();
    this.auditQueue = Promise.resolve();
    this.serverInfo = null;
    this.codexStatusCache = null;
    this.codexStatusLoading = null;
    this.modelCatalogCache = null;
    this.modelCatalogLoading = null;
    this.approvalConfigurationCache = null;
  }

  status() {
    const unavailableThreads = [];
    const unavailableThreadReasons = {};
    let retryingSubscriptions = 0;
    for (const [threadId, failure] of this.subscriptionFailures) {
      if (failure.permanent) {
        unavailableThreads.push(threadId);
        unavailableThreadReasons[threadId] = failure.reason;
      }
      else retryingSubscriptions += 1;
    }
    for (const [threadId, quarantine] of this.quarantinedThreads) {
      if (!unavailableThreads.includes(threadId)) unavailableThreads.push(threadId);
      unavailableThreadReasons[threadId] = quarantine.reason;
    }
    return {
      connected: this.connected,
      initialized: this.initialized,
      transport: "managed-unix-websocket",
      loadedThreads: Array.from(this.loadedThreads),
      subscribedThreads: Array.from(this.subscribedThreads),
      threadStates: Object.fromEntries(Array.from(this.threadStates.entries()).map(([threadId, state]) => [threadId, { ...state }])),
      server: this.serverInfo ? { ...this.serverInfo } : null,
      unavailableThreads,
      unavailableThreadReasons,
      retryingSubscriptions,
      pendingQuestions: this.list().length,
    };
  }

  list(sessionId = null) {
    return Array.from(this.interactions.values())
      .filter((interaction) => interaction.status === "pending" && (!sessionId || interaction.sessionId === sessionId))
      .map((interaction) => this.publicInteraction(interaction));
  }

  get(id) {
    const interaction = this.interactions.get(id);
    return interaction ? this.publicInteraction(interaction) : null;
  }

  async start() {
    this.stopped = false;
    return this.connect();
  }

  async connect() {
    if (this.stopped) return false;
    if (this.initialized) return true;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectNow().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connectNow() {
    this.clearTransport();
    let transport;
    try {
      transport = await this.transportFactory({ socketPath: this.socketPath });
      if (!transport?.readable || !transport?.writable) throw new Error("App-server transport is incomplete");
      this.transport = transport;
      this.attachTransport(transport);
      const initialized = await this.request("initialize", {
        clientInfo: { name: "phone-control", title: "Phone Control", version: CLIENT_VERSION },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [...OPT_OUT_NOTIFICATION_METHODS],
        },
      });
      if (!initialized?.codexHome) throw new Error("App-server returned an invalid initialize response");
      this.serverInfo = {
        userAgent: clampText(initialized.userAgent, 160) || null,
        platformFamily: clampText(initialized.platformFamily, 80) || null,
        platformOs: clampText(initialized.platformOs, 80) || null,
      };
      await this.send({ method: "initialized" });
      this.connected = true;
      this.initialized = true;
      this.emitStatus();
      try {
        await this.refreshApprovalConfiguration();
      } catch (error) {
        this.emit("warning", new Error(`Could not read Codex approval routing: ${error.message}`));
      }
      await this.refreshLoadedThreads();
      if (!this.initialized || this.transport !== transport) return false;
      this.reconnectDelayMs = 1_000;
      this.startLoadedThreadRefresh();
      return true;
    } catch (error) {
      if (this.transport || this.connected || this.initialized) {
        this.handleDisconnect(error);
      } else {
        if (!this.stopped) this.emit("warning", error);
        this.scheduleReconnect();
      }
      return false;
    }
  }

  attachTransport(transport) {
    transport.readable.on("data", (chunk) => this.onData(chunk));
    transport.readable.once("error", (error) => this.handleDisconnect(error));
    transport.writable.once("error", (error) => this.handleDisconnect(error));
    transport.stderr?.on("data", (chunk) => {
      const message = clampText(chunk.toString("utf8"), 1_000);
      if (message && !message.startsWith("WARNING: proceeding")) this.emit("warning", new Error(message));
    });
    transport.closed?.then((details) => {
      if (this.transport !== transport) return;
      const message = details?.error?.message || `App-server proxy closed${details?.code == null ? "" : ` with code ${details.code}`}`;
      this.handleDisconnect(new Error(message));
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.handleDisconnect(new Error("App-server sent an oversized JSON line"));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.handleDisconnect(new Error("App-server sent an oversized JSON line"));
        return;
      }
      try {
        this.onMessage(JSON.parse(line));
      } catch (error) {
        this.emit("warning", new Error(`Invalid app-server message: ${error.message}`));
      }
    }
  }

  setThreadState(threadId, next = {}) {
    if (typeof threadId !== "string" || !threadId) return;
    const previous = this.threadStates.get(threadId) || {
      status: "unknown",
      activeFlags: [],
      activeTurnId: null,
    };
    const state = {
      ...previous,
      ...next,
      activeFlags: Array.isArray(next.activeFlags) ? [...next.activeFlags] : previous.activeFlags,
      updatedAt: new Date().toISOString(),
    };
    if (state.status !== "active") {
      state.activeFlags = [];
      state.activeTurnId = null;
    } else if (this.interruptRequests.get(threadId)?.turnId === state.activeTurnId) {
      state.activeFlags = Array.from(new Set([...state.activeFlags, "interruptRequested"]));
    }
    this.threadStates.set(threadId, state);
    this.emit("threadState", { threadId, ...state });
    this.emitStatus();
  }

  applyResumedThread(thread, initialTurnsPage = null) {
    const state = runtimeFromThread(thread, initialTurnsPage);
    if (typeof thread?.id === "string" && state) this.setThreadState(thread.id, state);
    return state;
  }

  onMessage(message) {
    if (!message || typeof message !== "object") return;
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.clientRequests.get(String(message.id));
      if (!pending) return;
      this.clientRequests.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || "App-server request failed"), { rpcError: message.error }));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "item/tool/requestUserInput" && Object.prototype.hasOwnProperty.call(message, "id")) {
      this.receiveQuestion(message);
      return;
    }
    if (message.method === "serverRequest/resolved") {
      const requestId = String(message.params?.requestId);
      const threadId = message.params?.threadId;
      for (const interaction of this.interactions.values()) {
        if (interaction.status === "pending" && String(interaction.rpcId) === requestId && interaction.sessionId === threadId) {
          this.makeUnavailable(interaction.id, "问题已在另一台已连接的 Codex 客户端处理");
        }
      }
      const state = this.threadStates.get(threadId);
      if (state?.activeFlags?.includes("waitingOnUserInput")) {
        this.setThreadState(threadId, {
          activeFlags: state.activeFlags.filter((flag) => flag !== "waitingOnUserInput"),
        });
      }
    }
    if (message.method === "thread/started") {
      const threadId = message.params?.thread?.id;
      if (typeof threadId === "string") {
        this.loadedThreads.add(threadId);
        this.applyResumedThread(message.params.thread);
        void this.subscribeThread(threadId);
      }
    }
    if (message.method === "turn/started") {
      const threadId = message.params?.threadId;
      const turnId = message.params?.turn?.id;
      if (typeof threadId === "string" && typeof turnId === "string") {
        if (this.interruptRequests.get(threadId)?.turnId !== turnId) this.interruptRequests.delete(threadId);
        this.setThreadState(threadId, { status: "active", activeFlags: [], activeTurnId: turnId });
      }
    }
    if (message.method === "turn/completed") {
      const threadId = message.params?.threadId;
      const turnId = message.params?.turn?.id;
      const state = this.threadStates.get(threadId);
      if (typeof threadId === "string" && (!state?.activeTurnId || !turnId || state.activeTurnId === turnId)) {
        this.interruptRequests.delete(threadId);
        this.setThreadState(threadId, { status: "idle", activeFlags: [], activeTurnId: null });
      }
    }
    if (message.method === "thread/status/changed") {
      const threadId = message.params?.threadId;
      const status = message.params?.status;
      if (status?.type === "notLoaded") {
        this.interruptRequests.delete(threadId);
        this.loadedThreads.delete(threadId);
        this.subscribedThreads.delete(threadId);
        this.subscriptionFailures.delete(threadId);
        this.threadStates.delete(threadId);
        this.emitStatus();
      } else if (typeof threadId === "string" && typeof status?.type === "string") {
        this.setThreadState(threadId, {
          status: status.type,
          activeFlags: status.type === "active" && Array.isArray(status.activeFlags) ? status.activeFlags : [],
        });
      }
    }
    if (message.method === "thread/closed") {
      this.interruptRequests.delete(message.params?.threadId);
      this.loadedThreads.delete(message.params?.threadId);
      this.subscribedThreads.delete(message.params?.threadId);
      this.subscriptionFailures.delete(message.params?.threadId);
      this.threadStates.delete(message.params?.threadId);
      this.emitStatus();
    }
    if (message.method === "thread/archived") {
      this.interruptRequests.delete(message.params?.threadId);
      this.loadedThreads.delete(message.params?.threadId);
      this.subscribedThreads.delete(message.params?.threadId);
      this.subscriptionFailures.delete(message.params?.threadId);
      this.threadStates.delete(message.params?.threadId);
      this.emitStatus();
    }
    if (message.method === "thread/deleted") {
      this.forgetThread(message.params?.threadId);
    }
    if (message.method && !Object.prototype.hasOwnProperty.call(message, "id")) {
      this.emit("notification", message);
      this.emit(message.method, message.params || {});
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      // Do not answer unrelated server requests. The managed app-server may have
      // another controlling client for that turn, and an eager JSON-RPC error here
      // could interfere with its approval or tool flow.
      this.emit("unsupportedRequest", { method: String(message.method) });
    }
  }

  receiveQuestion(message) {
    const normalized = normalizeQuestions(message.params);
    if (!normalized) {
      void this.send({ id: message.id, error: { code: -32602, message: "Invalid request_user_input payload" } });
      return;
    }
    const duplicate = Array.from(this.interactions.values()).find((interaction) => (
      interaction.status === "pending"
      && String(interaction.rpcId) === String(message.id)
      && interaction.sessionId === normalized.threadId
    ));
    if (duplicate) return;
    const now = Date.now();
    const interaction = {
      id: randomUUID(),
      rpcId: message.id,
      sessionId: normalized.threadId,
      turnId: normalized.turnId,
      itemId: normalized.itemId,
      questions: normalized.questions,
      createdAt: new Date(now).toISOString(),
      expiresAt: normalized.autoResolutionMs == null ? null : new Date(now + normalized.autoResolutionMs).toISOString(),
      status: "pending",
      delivery: "waiting",
      decidedAt: null,
      decidedBy: null,
      timer: null,
    };
    if (normalized.autoResolutionMs != null) {
      interaction.timer = setTimeout(() => this.makeUnavailable(interaction.id, "Codex 已自动处理或问题已过期"), normalized.autoResolutionMs);
      interaction.timer.unref?.();
    }
    this.loadedThreads.add(interaction.sessionId);
    const runtime = this.threadStates.get(interaction.sessionId);
    this.setThreadState(interaction.sessionId, {
      status: "active",
      activeTurnId: interaction.turnId,
      activeFlags: Array.from(new Set([...(runtime?.activeFlags || []), "waitingOnUserInput"])),
    });
    this.interactions.set(interaction.id, interaction);
    this.audit("question_received", interaction);
    this.emit("question", this.publicInteraction(interaction));
    this.emitStatus();
  }

  async refreshLoadedThreads() {
    if (this.refreshingLoadedThreads) return this.refreshingLoadedThreads;
    const refreshing = this.refreshLoadedThreadsNow();
    this.refreshingLoadedThreads = refreshing;
    try {
      return await refreshing;
    } finally {
      if (this.refreshingLoadedThreads === refreshing) this.refreshingLoadedThreads = null;
    }
  }

  async refreshLoadedThreadsNow() {
    if (!this.initialized) return [];
    const loaded = [];
    let cursor = null;
    do {
      const result = await this.request("thread/loaded/list", { cursor, limit: 200 });
      if (!result || !Array.isArray(result.data)) throw new Error("App-server returned an invalid loaded-thread list");
      loaded.push(...result.data.filter((id) => typeof id === "string"));
      cursor = result.nextCursor || null;
    } while (cursor);
    this.loadedThreads = new Set(loaded);
    for (const interaction of this.interactions.values()) {
      if (interaction.status === "pending") this.loadedThreads.add(interaction.sessionId);
    }
    for (const threadId of this.subscribedThreads) {
      if (!this.loadedThreads.has(threadId)) this.subscribedThreads.delete(threadId);
    }
    for (const threadId of this.subscriptionFailures.keys()) {
      if (!this.loadedThreads.has(threadId)) this.subscriptionFailures.delete(threadId);
    }
    for (const threadId of this.quarantinedThreads.keys()) {
      if (!this.loadedThreads.has(threadId)) this.quarantinedThreads.delete(threadId);
    }
    for (const threadId of this.threadStates.keys()) {
      if (!this.loadedThreads.has(threadId)) {
        this.threadStates.delete(threadId);
        this.interruptRequests.delete(threadId);
      }
    }
    // Subscribe sequentially so a transport-level size failure can be bound to
    // exactly one thread and quarantined without poisoning every live session.
    for (const threadId of this.loadedThreads) {
      if (!this.initialized) break;
      await this.subscribeThread(threadId);
    }
    this.emit("loaded", Array.from(this.loadedThreads));
    this.emitStatus();
    return loaded;
  }

  startLoadedThreadRefresh() {
    clearInterval(this.loadedThreadRefreshTimer);
    this.loadedThreadRefreshTimer = null;
    if (!Number.isFinite(this.loadedThreadRefreshMs) || this.loadedThreadRefreshMs <= 0) return;
    this.loadedThreadRefreshTimer = setInterval(() => {
      void this.refreshLoadedThreads().catch((error) => {
        if (this.initialized) this.emit("warning", new Error(`Could not refresh loaded Codex threads: ${error.message}`));
      });
    }, this.loadedThreadRefreshMs);
    this.loadedThreadRefreshTimer.unref?.();
  }

  subscribeThread(threadId) {
    if (!this.initialized || !this.loadedThreads.has(threadId)) return Promise.resolve(false);
    if (this.subscribedThreads.has(threadId)) return Promise.resolve(true);
    if (this.subscribingThreads.has(threadId)) return this.subscribingThreads.get(threadId);
    if (this.quarantinedThreads.has(threadId)) return Promise.resolve(false);
    const previousFailure = this.subscriptionFailures.get(threadId);
    if (previousFailure?.permanent) return Promise.resolve(false);
    if (previousFailure?.nextAttemptAt > Date.now()) return Promise.resolve(false);
    const subscribing = this.requestMetadataResume(threadId)
      .then((result) => {
        validateMetadataResume(result, threadId);
        this.subscribedThreads.add(threadId);
        this.subscriptionFailures.delete(threadId);
        this.applyResumedThread(result.thread, result.initialTurnsPage);
        this.emit("subscribed", threadId);
        this.emitStatus();
        return true;
      })
      .catch((error) => {
        const now = Date.now();
        const permanentCandidate = isPermanentSubscriptionError(error);
        const candidateAttempts = permanentCandidate ? (previousFailure?.candidateAttempts || 0) + 1 : 0;
        const permanent = isImmediatePermanentSubscriptionError(error)
          || (permanentCandidate && candidateAttempts >= PERMANENT_SUBSCRIPTION_FAILURE_ATTEMPTS);
        const shouldWarn = !previousFailure || now - previousFailure.lastWarningAt >= 30_000;
        if (shouldWarn) {
          this.emit("warning", new Error(`Could not subscribe to live thread ${threadId}: ${error.message}`));
        }
        this.subscriptionFailures.set(threadId, {
          permanent,
          candidateAttempts,
          reason: clampText(error.message || "Subscription failed", 300),
          nextAttemptAt: permanent ? null : now + Math.max(this.loadedThreadRefreshMs, this.subscriptionRetryMinMs),
          lastWarningAt: shouldWarn ? now : previousFailure.lastWarningAt,
        });
        return false;
      })
      .finally(() => this.subscribingThreads.delete(threadId));
    this.subscribingThreads.set(threadId, subscribing);
    return subscribing;
  }

  request(method, params = {}) {
    if (!this.transport) return Promise.reject(new Error("App-server is not connected"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clientRequests.delete(String(id));
        reject(new Error(`App-server ${method} timed out`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.clientRequests.set(String(id), { resolve, reject, timer, method });
      this.send({ id, method, params }).catch((error) => {
        const pending = this.clientRequests.get(String(id));
        if (!pending) return;
        this.clientRequests.delete(String(id));
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  async requestMetadataResume(threadId) {
    const previous = this.resumeQueue;
    let release;
    this.resumeQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (!this.initialized || !this.transport) throw new Error("App-server is not connected");
      this.activeSubscriptionThreadId = threadId;
      return await this.request("thread/resume", metadataResumeParams(threadId));
    } finally {
      if (this.activeSubscriptionThreadId === threadId) this.activeSubscriptionThreadId = null;
      release();
    }
  }

  async codexStatus({ force = false } = {}) {
    if (!this.initialized || !this.transport) {
      return {
        available: false,
        checkedAt: new Date().toISOString(),
        server: this.serverInfo ? { ...this.serverInfo } : null,
        account: null,
        configuration: null,
        usage: { limits: [], resetCreditsAvailable: 0 },
        partial: true,
      };
    }
    const cachedAt = Date.parse(this.codexStatusCache?.checkedAt);
    if (!force && this.codexStatusCache && Number.isFinite(cachedAt) && Date.now() - cachedAt < CODEX_STATUS_CACHE_MS) {
      return JSON.parse(JSON.stringify(this.codexStatusCache));
    }
    if (this.codexStatusLoading) return this.codexStatusLoading;
    const checkedAt = new Date().toISOString();
    const loading = Promise.allSettled([
      this.request("account/read", { refreshToken: false }),
      this.request("account/rateLimits/read", {}),
      this.request("config/read", { includeLayers: false }),
    ]).then(([account, rateLimits, config]) => {
      if (config.status === "fulfilled") {
        this.approvalConfigurationCache = approvalConfiguration(config.value);
      }
      const snapshot = publicCodexStatus({
        accountResult: account.status === "fulfilled" ? account.value : null,
        rateLimitsResult: rateLimits.status === "fulfilled" ? rateLimits.value : null,
        configResult: config.status === "fulfilled" ? config.value : null,
        serverInfo: this.serverInfo,
        checkedAt,
      });
      this.codexStatusCache = snapshot;
      return JSON.parse(JSON.stringify(snapshot));
    }).finally(() => {
      if (this.codexStatusLoading === loading) this.codexStatusLoading = null;
    });
    this.codexStatusLoading = loading;
    return loading;
  }

  async modelCatalog({ force = false } = {}) {
    if (!this.initialized || !this.transport) {
      return { available: false, checkedAt: new Date().toISOString(), models: [] };
    }
    const cachedAt = Date.parse(this.modelCatalogCache?.checkedAt);
    if (!force && this.modelCatalogCache && Number.isFinite(cachedAt) && Date.now() - cachedAt < MODEL_CATALOG_CACHE_MS) {
      return JSON.parse(JSON.stringify(this.modelCatalogCache));
    }
    if (this.modelCatalogLoading) return this.modelCatalogLoading;
    const checkedAt = new Date().toISOString();
    const loading = this.request("model/list", { limit: 100, includeHidden: false })
      .then((result) => {
        const snapshot = {
          available: true,
          checkedAt,
          models: (Array.isArray(result?.data) ? result.data : []).map(normalizeModelEntry).filter(Boolean),
        };
        this.modelCatalogCache = snapshot;
        return JSON.parse(JSON.stringify(snapshot));
      })
      .catch(() => ({ available: false, checkedAt, models: [] }))
      .finally(() => {
        if (this.modelCatalogLoading === loading) this.modelCatalogLoading = null;
      });
    this.modelCatalogLoading = loading;
    return loading;
  }

  async validateModelSelection(model, reasoningEffort, serviceTier = null, { fallbackModel = null } = {}) {
    const selectedModel = normalizeModelSelection(model, "Model");
    const selectedEffort = normalizeModelSelection(reasoningEffort, "Reasoning effort");
    const selectedTier = normalizeModelSelection(serviceTier, "Service tier");
    if (!selectedModel && !selectedEffort && !selectedTier) return { model: null, reasoningEffort: null, serviceTier: null };
    const catalog = await this.modelCatalog();
    if (!catalog.available) throw httpError("The Codex model catalog is temporarily unavailable", 503);
    const effectiveModel = selectedModel
      || normalizeModelSelection(fallbackModel, "Current model")
      || catalog.models.find((candidate) => candidate.isDefault)?.id;
    const entry = catalog.models.find((candidate) => candidate.id === effectiveModel);
    if (!entry) throw httpError("The selected Codex model is not available", 409);
    if (selectedEffort && !entry.supportedReasoningEfforts.includes(selectedEffort)) {
      throw httpError("The selected reasoning effort is not supported by this model", 409);
    }
    const tierIds = new Set(entry.serviceTiers.map((tier) => tier.id));
    if (selectedTier && selectedTier !== "default" && !tierIds.has(selectedTier)) {
      throw httpError("The selected speed tier is not supported by this model", 409);
    }
    return {
      model: selectedModel ? entry.id : null,
      reasoningEffort: selectedEffort,
      serviceTier: selectedTier,
    };
  }

  approvalConfiguration() {
    return this.approvalConfigurationCache
      ? JSON.parse(JSON.stringify(this.approvalConfigurationCache))
      : null;
  }

  async refreshApprovalConfiguration() {
    if (!this.initialized || !this.transport) return null;
    const result = await this.request("config/read", { includeLayers: false });
    this.approvalConfigurationCache = approvalConfiguration(result);
    return this.approvalConfiguration();
  }

  send(message) {
    const writable = this.transport?.writable;
    if (!writable || writable.destroyed || writable.writableEnded) {
      return Promise.reject(new Error("App-server transport is not writable"));
    }
    const payload = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      writable.write(payload, (error) => error ? reject(error) : resolve());
    });
  }

  forgetThread(threadId) {
    if (typeof threadId !== "string" || !threadId) return;
    this.interruptRequests.delete(threadId);
    this.loadedThreads.delete(threadId);
    this.subscribedThreads.delete(threadId);
    this.subscribingThreads.delete(threadId);
    this.subscriptionFailures.delete(threadId);
    this.quarantinedThreads.delete(threadId);
    this.threadStates.delete(threadId);
    for (const [id, command] of this.commands) {
      if (command.sessionId === threadId) this.commands.delete(id);
    }
    this.emitStatus();
  }

  async resumeForControl(threadId) {
    if (this.subscribedThreads.has(threadId) && this.threadStates.has(threadId)) {
      return this.threadStates.get(threadId);
    }
    if (this.subscriptionFailures.get(threadId)?.permanent) {
      throw httpError("This Codex session has no resumable rollout in the managed app-server", 404);
    }
    if (this.quarantinedThreads.has(threadId)) {
      throw httpError("This Codex session was isolated after an oversized live-control response", 409);
    }
    const inFlight = this.subscribingThreads.get(threadId);
    if (inFlight) await inFlight;
    if (this.subscribedThreads.has(threadId) && this.threadStates.has(threadId)) {
      return this.threadStates.get(threadId);
    }
    let result;
    try {
      result = await this.requestMetadataResume(threadId);
    } catch (error) {
      const missing = /not found|no rollout/i.test(error.message || "");
      throw httpError(missing ? "This Codex session cannot be resumed" : `Codex could not resume this session: ${error.message}`, missing ? 404 : 409);
    }
    try {
      validateMetadataResume(result, threadId);
    } catch (error) {
      throw httpError(error.code === "ERR_RESUME_HISTORY_INCLUDED"
        ? "This App Server cannot resume the session without loading full history"
        : "Codex resumed a different session", 409);
    }
    this.loadedThreads.add(threadId);
    this.subscribedThreads.add(threadId);
    this.subscriptionFailures.delete(threadId);
    const state = this.applyResumedThread(result.thread, result.initialTurnsPage);
    this.emit("subscribed", threadId);
    this.emitStatus();
    return state;
  }

  rememberCommand(command) {
    this.commands.set(command.id, command);
    if (this.commands.size <= MAX_COMMAND_RECORDS) return;
    const oldest = this.commands.keys().next().value;
    this.commands.delete(oldest);
  }

  async createSession({ text, cwd = null, model = null, reasoningEffort = null, serviceTier = null, clientMessageId } = {}, device = null) {
    const input = normalizePhoneInput(text);
    const workingDirectory = await validateWorkingDirectory(cwd);
    const commandId = normalizeClientMessageId(clientMessageId);
    if (this.commands.has(commandId)) throw httpError("This phone message was already submitted", 409);
    if (!this.initialized || !this.transport) throw httpError("Live Codex connection is unavailable", 503);
    const defaults = (await this.codexStatus()).configuration;
    const selection = await this.validateModelSelection(model, reasoningEffort, serviceTier, { fallbackModel: defaults?.model });

    const command = {
      id: commandId,
      sessionId: null,
      expectedTurnId: null,
      action: "create",
      turnId: null,
      status: "sending",
      delivery: "sending",
      messageLength: input.text.length,
      imageCount: 0,
      cwd: workingDirectory,
      model: selection.model || defaults?.model || null,
      reasoningEffort: selection.reasoningEffort || defaults?.reasoningEffort || null,
      serviceTier: selection.serviceTier || defaults?.serviceTier || null,
      sentAt: new Date().toISOString(),
      decidedBy: device?.id || null,
    };
    this.rememberCommand(command);
    this.auditCommand("phone_session_creating", command, { deviceName: device?.name || null });

    let threadId;
    try {
      const started = await this.request("thread/start", {
        ...(workingDirectory ? { cwd: workingDirectory } : {}),
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
        serviceName: "phone-control",
      });
      threadId = typeof started?.thread?.id === "string" ? started.thread.id : null;
      if (!threadId) throw new Error("Codex returned an invalid new thread");
      command.sessionId = threadId;
      this.loadedThreads.add(threadId);
      this.subscribedThreads.add(threadId);
      this.applyResumedThread(started.thread);

      const result = await this.request("turn/start", {
        threadId,
        clientUserMessageId: commandId,
        input: input.items,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.reasoningEffort ? { effort: selection.reasoningEffort } : {}),
        ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
      });
      if (typeof result?.turn?.id !== "string") throw new Error("Codex returned an invalid turn");
      command.turnId = result.turn.id;
      this.setThreadState(threadId, { status: "active", activeFlags: [], activeTurnId: command.turnId });
    } catch (error) {
      command.status = error.rpcError ? "rejected" : "delivery_unknown";
      command.delivery = error.rpcError ? "not_delivered" : "unknown";
      if (threadId && error.rpcError) {
        try {
          await this.request("thread/delete", { threadId });
          this.forgetThread(threadId);
        } catch {
          command.delivery = "unknown";
        }
      }
      this.auditCommand(error.rpcError ? "phone_session_rejected" : "phone_session_delivery_unknown", command, {
        error: clampText(error.message, 300),
        deviceName: device?.name || null,
      });
      if (error.rpcError && command.delivery === "not_delivered") {
        throw httpError(`Codex rejected the new session: ${error.message}`, 409);
      }
      throw httpError("New session delivery could not be confirmed; check the recent list before trying again", 503);
    }

    command.status = "delivered";
    command.delivery = "delivered";
    command.deliveredAt = new Date().toISOString();
    this.auditCommand("phone_session_created", command, { deviceName: device?.name || null });
    const safe = JSON.parse(JSON.stringify(command));
    this.emit("command", safe);
    this.emitStatus();
    return safe;
  }

  async deleteSession({ sessionId } = {}, device = null) {
    const threadId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!threadId || threadId.length > 200) throw httpError("A valid session id is required", 400);
    if (!this.initialized || !this.transport) throw httpError("Live Codex connection is unavailable", 503);
    if (this.list(threadId).length) throw httpError("Resolve the current Codex question before deleting this session", 409);
    const state = this.threadStates.get(threadId);
    if (state?.status === "active") throw httpError("Stop the active Codex turn before deleting this session", 409);

    const operation = {
      id: randomUUID(),
      sessionId: threadId,
      action: "delete",
      status: "sending",
      delivery: "sending",
      requestedAt: new Date().toISOString(),
      decidedBy: device?.id || null,
    };
    this.auditLifecycle("phone_session_delete_sending", operation, { deviceName: device?.name || null });
    try {
      await this.request("thread/delete", { threadId });
    } catch (error) {
      operation.status = error.rpcError ? "rejected" : "delivery_unknown";
      operation.delivery = error.rpcError ? "not_delivered" : "unknown";
      this.auditLifecycle(error.rpcError ? "phone_session_delete_rejected" : "phone_session_delete_unknown", operation, {
        error: clampText(error.message, 300),
        deviceName: device?.name || null,
      });
      if (error.rpcError) throw httpError(`Codex rejected session deletion: ${error.message}`, 409);
      throw httpError("Deletion could not be confirmed; refresh the recent list before trying again", 503);
    }
    operation.status = "deleted";
    operation.delivery = "delivered";
    operation.deletedAt = new Date().toISOString();
    this.forgetThread(threadId);
    this.auditLifecycle("phone_session_deleted", operation, { deviceName: device?.name || null });
    return JSON.parse(JSON.stringify(operation));
  }

  async sendInput({ sessionId, expectedTurnId = null, text, images = [], cwd = null, model = null, reasoningEffort = null, serviceTier = null, clientMessageId } = {}, device = null) {
    const threadId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!threadId || threadId.length > 200) throw httpError("A valid session id is required", 400);
    const input = normalizePhoneInput(text, images);
    const commandId = normalizeClientMessageId(clientMessageId);
    const expected = expectedTurnId == null ? null : typeof expectedTurnId === "string" ? expectedTurnId.trim() : "";
    if (expectedTurnId != null && (!expected || expected.length > 200)) {
      throw httpError("Expected turn id is invalid", 400);
    }
    if (this.commands.has(commandId)) throw httpError("This phone message was already submitted", 409);
    if (!this.initialized || !this.transport) throw httpError("Live Codex connection is unavailable", 503);
    if (this.list(threadId).length) throw httpError("Answer the current Codex question before sending another instruction", 409);

    let state = this.threadStates.get(threadId);
    if (!this.subscribedThreads.has(threadId) || !state) state = await this.resumeForControl(threadId);
    if (!state || !["idle", "active"].includes(state.status)) {
      throw httpError("This Codex session is not ready to accept input", 409);
    }
    if (state.activeFlags?.includes("waitingOnApproval") || state.activeFlags?.includes("waitingOnUserInput")) {
      throw httpError("Resolve the current Codex approval or question before sending another instruction", 409);
    }

    let action;
    let turnId;
    if (state.status === "active") {
      if (!state.activeTurnId) throw httpError("The active Codex turn could not be verified", 409);
      if (expected !== state.activeTurnId) throw httpError("The active Codex turn changed; refresh before sending", 409);
      action = "steer";
      turnId = state.activeTurnId;
    } else {
      if (expected) throw httpError("This Codex session is now idle; refresh before sending", 409);
      action = "start";
      turnId = null;
    }
    if (action === "steer" && (cwd || model || reasoningEffort || serviceTier)) {
      throw httpError("Workspace, model, reasoning effort, and Fast can only change when starting a new turn", 409);
    }
    const workingDirectory = action === "start" ? await validateWorkingDirectory(cwd) : null;
    const selection = action === "start"
      ? await this.validateModelSelection(model, reasoningEffort, serviceTier)
      : { model: null, reasoningEffort: null, serviceTier: null };

    const command = {
      id: commandId,
      sessionId: threadId,
      expectedTurnId: expected,
      action,
      turnId,
      status: "sending",
      delivery: "sending",
      messageLength: input.text.length,
      imageCount: input.imageCount,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      serviceTier: selection.serviceTier,
      cwd: workingDirectory,
      sentAt: new Date().toISOString(),
      decidedBy: device?.id || null,
    };
    this.rememberCommand(command);
    this.auditCommand("phone_input_sending", command, { deviceName: device?.name || null });

    try {
      if (action === "steer") {
        const result = await this.request("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: commandId,
          input: input.items,
        });
        if (result?.turnId !== turnId) throw new Error("Codex accepted input for an unexpected turn");
      } else {
        const result = await this.request("turn/start", {
          threadId,
          clientUserMessageId: commandId,
          input: input.items,
          ...(selection.model ? { model: selection.model } : {}),
          ...(selection.reasoningEffort ? { effort: selection.reasoningEffort } : {}),
          ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
          ...(workingDirectory ? { cwd: workingDirectory } : {}),
        });
        if (typeof result?.turn?.id !== "string") throw new Error("Codex returned an invalid turn");
        turnId = result.turn.id;
        command.turnId = turnId;
        this.setThreadState(threadId, { status: "active", activeFlags: [], activeTurnId: turnId });
      }
    } catch (error) {
      command.status = error.rpcError ? "rejected" : "delivery_unknown";
      command.delivery = error.rpcError ? "not_delivered" : "unknown";
      this.auditCommand(error.rpcError ? "phone_input_rejected" : "phone_input_delivery_unknown", command, {
        error: clampText(error.message, 300),
      });
      if (error.rpcError) throw httpError(`Codex rejected this instruction: ${error.message}`, 409);
      throw httpError("Instruction delivery could not be confirmed; it will not be retried automatically", 503);
    }

    command.status = "delivered";
    command.delivery = "delivered";
    command.deliveredAt = new Date().toISOString();
    this.auditCommand("phone_input_delivered", command, { deviceName: device?.name || null });
    const safe = JSON.parse(JSON.stringify(command));
    this.emit("command", safe);
    this.emitStatus();
    return safe;
  }

  async interruptTurn({ sessionId, expectedTurnId } = {}, device = null) {
    const threadId = typeof sessionId === "string" ? sessionId.trim() : "";
    const expected = typeof expectedTurnId === "string" ? expectedTurnId.trim() : "";
    if (!threadId || threadId.length > 200) throw httpError("A valid session id is required", 400);
    if (!expected || expected.length > 200) throw httpError("Expected turn id is required", 400);
    if (!this.initialized || !this.transport) throw httpError("Live Codex connection is unavailable", 503);
    if (!this.subscribedThreads.has(threadId)) throw httpError("This Codex session is not attached to the live controller", 409);

    const state = this.threadStates.get(threadId);
    if (state?.status !== "active" || !state.activeTurnId) {
      throw httpError("This Codex session no longer has an active turn", 409);
    }
    if (expected !== state.activeTurnId) {
      throw httpError("The active Codex turn changed; refresh before stopping", 409);
    }
    if (state.activeFlags?.some((flag) => ["waitingOnApproval", "waitingOnUserInput"].includes(flag))) {
      throw httpError("Resolve the current Codex approval or question before stopping the turn", 409);
    }
    if (this.interruptRequests.get(threadId)?.turnId === expected) {
      throw httpError("A stop request is already in progress for this turn", 409);
    }

    const operation = {
      id: randomUUID(),
      sessionId: threadId,
      turnId: expected,
      action: "interrupt",
      status: "sending",
      delivery: "sending",
      requestedAt: new Date().toISOString(),
      decidedBy: device?.id || null,
    };
    this.interruptRequests.set(threadId, operation);
    this.auditInterrupt("phone_interrupt_sending", operation, { deviceName: device?.name || null });
    try {
      await this.request("turn/interrupt", { threadId, turnId: expected });
    } catch (error) {
      if (this.interruptRequests.get(threadId)?.id === operation.id) this.interruptRequests.delete(threadId);
      operation.status = error.rpcError ? "rejected" : "delivery_unknown";
      operation.delivery = error.rpcError ? "not_delivered" : "unknown";
      this.auditInterrupt(error.rpcError ? "phone_interrupt_rejected" : "phone_interrupt_delivery_unknown", operation, {
        error: clampText(error.message, 300),
      });
      if (error.rpcError) throw httpError(`Codex rejected this stop request: ${error.message}`, 409);
      throw httpError("Stop delivery could not be confirmed; check the live session before trying again", 503);
    }

    operation.status = "delivered";
    operation.delivery = "delivered";
    operation.deliveredAt = new Date().toISOString();
    const current = this.threadStates.get(threadId);
    if (current?.status === "active" && current.activeTurnId === expected) {
      this.interruptRequests.set(threadId, operation);
      this.setThreadState(threadId, {
        activeFlags: Array.from(new Set([...(current.activeFlags || []), "interruptRequested"])),
      });
    } else if (this.interruptRequests.get(threadId)?.id === operation.id) {
      this.interruptRequests.delete(threadId);
    }
    this.auditInterrupt("phone_interrupt_delivered", operation, { deviceName: device?.name || null });
    const safe = JSON.parse(JSON.stringify(operation));
    this.emit("interrupt", safe);
    this.emitStatus();
    return safe;
  }

  async answer(id, { answers, sessionId, turnId } = {}, device = null) {
    const interaction = this.interactions.get(id);
    if (!interaction) throw httpError("Question not found", 404);
    if (interaction.status !== "pending") throw httpError("Question was already answered or is no longer available", 409);
    if (!this.initialized || !this.transport) throw httpError("Live Codex connection is unavailable", 503);
    if (sessionId !== interaction.sessionId || turnId !== interaction.turnId) {
      throw httpError("Question binding no longer matches this session and turn", 409);
    }
    if (interaction.expiresAt && Date.parse(interaction.expiresAt) <= Date.now()) {
      this.makeUnavailable(id, "Question expired");
      throw httpError("Question expired", 410);
    }
    const normalized = normalizeAnswers(interaction, answers);
    interaction.status = "sending";
    interaction.delivery = "sending";
    try {
      await this.send({ id: interaction.rpcId, result: { answers: normalized } });
    } catch (error) {
      interaction.status = "delivery_unknown";
      interaction.delivery = "unknown";
      clearTimeout(interaction.timer);
      interaction.timer = null;
      this.audit("answer_delivery_unknown", interaction, { error: clampText(error.message, 300) });
      this.emit("unavailable", this.publicInteraction(interaction));
      this.emitStatus();
      throw httpError("Answer delivery could not be confirmed; it will not be retried automatically", 503);
    }
    clearTimeout(interaction.timer);
    interaction.timer = null;
    interaction.status = "answered";
    interaction.delivery = "delivered";
    interaction.decidedAt = new Date().toISOString();
    interaction.decidedBy = device?.id || null;
    this.audit("answer_delivered", interaction, {
      deviceName: device?.name || null,
      answeredQuestionIds: Object.keys(normalized),
    });
    const safe = this.publicInteraction(interaction);
    this.emit("answered", safe);
    this.emitStatus();
    return safe;
  }

  makeUnavailable(id, reason) {
    const interaction = this.interactions.get(id);
    if (!interaction || interaction.status !== "pending") return;
    clearTimeout(interaction.timer);
    interaction.timer = null;
    interaction.status = "unavailable";
    interaction.delivery = "not_delivered";
    interaction.unavailableReason = reason;
    this.audit("question_unavailable", interaction, { reason });
    this.emit("unavailable", this.publicInteraction(interaction));
    this.emitStatus();
  }

  publicInteraction(interaction) {
    const { rpcId, timer, ...safe } = interaction;
    return JSON.parse(JSON.stringify({ ...safe, canRespond: interaction.status === "pending" && this.initialized }));
  }

  handleDisconnect(error) {
    if (!this.transport && !this.connected && !this.initialized) return;
    const oversizedThreadId = isOversizedTransportError(error) ? this.activeSubscriptionThreadId : null;
    if (oversizedThreadId) {
      this.quarantinedThreads.set(oversizedThreadId, {
        reason: "Live control was isolated because this thread produced an oversized App Server message",
        at: new Date().toISOString(),
      });
    }
    this.clearTransport();
    for (const interaction of this.interactions.values()) {
      if (interaction.status === "pending") this.makeUnavailable(interaction.id, "Live Codex connection closed");
    }
    this.loadedThreads.clear();
    this.subscribedThreads.clear();
    this.subscribingThreads.clear();
    this.subscriptionFailures.clear();
    this.threadStates.clear();
    this.interruptRequests.clear();
    this.activeSubscriptionThreadId = null;
    this.emit("loaded", []);
    this.emitStatus();
    if (error && !this.stopped) this.emit("warning", error);
    this.scheduleReconnect();
  }

  clearTransport() {
    clearInterval(this.loadedThreadRefreshTimer);
    this.loadedThreadRefreshTimer = null;
    this.refreshingLoadedThreads = null;
    const transport = this.transport;
    this.transport = null;
    this.buffer = "";
    this.connected = false;
    this.initialized = false;
    this.serverInfo = null;
    this.codexStatusCache = null;
    this.codexStatusLoading = null;
    this.modelCatalogCache = null;
    this.modelCatalogLoading = null;
    this.approvalConfigurationCache = null;
    this.interruptRequests.clear();
    for (const pending of this.clientRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("App-server connection closed"));
    }
    this.clientRequests.clear();
    try { transport?.close?.(); } catch {}
  }

  scheduleReconnect() {
    if (this.stopped || !this.reconnect || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  emitStatus() {
    this.emit("status", this.status());
  }

  audit(action, interaction, extra = {}) {
    if (!this.auditLogPath) return;
    this.writeAuditRow({
      schemaVersion: 1,
      at: new Date().toISOString(),
      action,
      interactionId: interaction.id,
      sessionId: interaction.sessionId,
      turnId: interaction.turnId,
      itemId: interaction.itemId,
      status: interaction.status,
      delivery: interaction.delivery,
      decidedBy: interaction.decidedBy,
      ...extra,
    });
  }

  auditCommand(action, command, extra = {}) {
    if (!this.auditLogPath) return;
    this.writeAuditRow({
      schemaVersion: 1,
      at: new Date().toISOString(),
      action,
      commandId: command.id,
      sessionId: command.sessionId,
      expectedTurnId: command.expectedTurnId,
      turnId: command.turnId,
      commandAction: command.action,
      status: command.status,
      delivery: command.delivery,
      messageLength: command.messageLength,
      imageCount: command.imageCount,
      model: command.model,
      reasoningEffort: command.reasoningEffort,
      serviceTier: command.serviceTier,
      cwd: command.cwd,
      decidedBy: command.decidedBy,
      ...extra,
    });
  }

  auditInterrupt(action, operation, extra = {}) {
    if (!this.auditLogPath) return;
    this.writeAuditRow({
      schemaVersion: 1,
      at: new Date().toISOString(),
      action,
      operationId: operation.id,
      sessionId: operation.sessionId,
      turnId: operation.turnId,
      operationAction: operation.action,
      status: operation.status,
      delivery: operation.delivery,
      decidedBy: operation.decidedBy,
      ...extra,
    });
  }

  auditLifecycle(action, operation, extra = {}) {
    if (!this.auditLogPath) return;
    this.writeAuditRow({
      schemaVersion: 1,
      at: new Date().toISOString(),
      action,
      operationId: operation.id,
      sessionId: operation.sessionId,
      operationAction: operation.action,
      status: operation.status,
      delivery: operation.delivery,
      decidedBy: operation.decidedBy,
      ...extra,
    });
  }

  writeAuditRow(row) {
    this.auditQueue = this.auditQueue.then(async () => {
      await mkdir(dirname(this.auditLogPath), { recursive: true, mode: 0o700 });
      try {
        if ((await stat(this.auditLogPath)).size >= MAX_AUDIT_BYTES) return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await appendFile(this.auditLogPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    }).catch((error) => this.emit("warning", error));
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearTransport();
    for (const interaction of this.interactions.values()) clearTimeout(interaction.timer);
    await this.auditQueue;
  }
}

export { normalizeQuestions, normalizeAnswers };
