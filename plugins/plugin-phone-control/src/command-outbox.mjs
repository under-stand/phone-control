import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { commandFingerprint, assertCommandIdentity } from "./command-identity.mjs";

const MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_TEXT_LENGTH = 4_000;
const TERMINAL_STATUSES = new Set(["delivered", "failed", "needs_review", "canceled", "expired"]);
const PENDING_STATUSES = new Set(["queued", "waiting", "sending"]);

function shouldExpire(entry, now) {
  return (PENDING_STATUSES.has(entry.status) || entry.status === "needs_review")
    && Date.parse(entry.expiresAt) <= now;
}

function cleanText(value) {
  if (typeof value !== "string") throw Object.assign(new Error("Message text is invalid"), { statusCode: 400 });
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw Object.assign(new Error("A queued instruction must contain 1–4,000 characters"), { statusCode: 400 });
  }
  return text;
}

function cleanId(value, label = "command id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{8,100}$/.test(value)) {
    throw Object.assign(new Error(`A valid ${label} is required`), { statusCode: 400 });
  }
  return value;
}

function cleanSessionId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\r\n\0]/.test(value)) {
    throw Object.assign(new Error("A valid session id is required"), { statusCode: 400 });
  }
  return value.trim();
}

function cleanOptional(value, max = 4_096) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value)) return null;
  return value.trim() || null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeEntry(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  let id;
  let sessionId;
  try {
    id = cleanId(raw.id);
    sessionId = cleanSessionId(raw.sessionId);
  } catch {
    return null;
  }
  const text = typeof raw.text === "string" ? raw.text.slice(0, MAX_TEXT_LENGTH) : "";
  if (!text) return null;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date(now()).toISOString();
  const expiresAt = typeof raw.expiresAt === "string"
    ? raw.expiresAt
    : new Date(Date.parse(createdAt) + DEFAULT_TTL_MS).toISOString();
  const status = PENDING_STATUSES.has(raw.status) || TERMINAL_STATUSES.has(raw.status) ? raw.status : "queued";
  return {
    id,
    sessionId,
    deviceId: cleanOptional(raw.deviceId, 200),
    expectedTurnId: cleanOptional(raw.expectedTurnId, 200),
    text,
    actionHint: raw.actionHint === "steer" ? "steer" : "start",
    cwd: cleanOptional(raw.cwd),
    model: cleanOptional(raw.model, 160),
    reasoningEffort: cleanOptional(raw.reasoningEffort, 80),
    serviceTier: cleanOptional(raw.serviceTier, 80),
    permissionProfile: cleanOptional(raw.permissionProfile, 80),
    confirmDangerFullAccess: raw.confirmDangerFullAccess === true,
    imageIds: [],
    status,
    waitingFor: cleanOptional(raw.waitingFor, 80),
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    lastError: cleanOptional(raw.lastError, 500),
    createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt,
    expiresAt,
    deliveredAt: typeof raw.deliveredAt === "string" ? raw.deliveredAt : null,
    deliveredCommand: raw.deliveredCommand && typeof raw.deliveredCommand === "object" ? raw.deliveredCommand : null,
    deliveryUnknown: raw.deliveryUnknown === true,
    nextAttemptAt: cleanOptional(raw.nextAttemptAt, 80),
  };
}

export class CommandOutbox extends EventEmitter {
  constructor({ filePath, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES } = {}) {
    super();
    this.filePath = filePath;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.persistQueue = Promise.resolve();
  }

  async restore() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return;
      throw error;
    }
    const now = this.now();
    for (const raw of Array.isArray(parsed?.entries) ? parsed.entries : []) {
      const entry = normalizeEntry(raw, now);
      if (entry) this.entries.set(entry.id, entry);
    }
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.status === "sending") {
        entry.status = "needs_review";
        entry.deliveryUnknown = true;
        entry.waitingFor = null;
        entry.lastError = "服务在发送期间重启，无法确认是否送达；已停止自动重试，请先查看会话。";
        entry.updatedAt = new Date(now).toISOString();
        changed = true;
      }
      if (!shouldExpire(entry, now)) continue;
      this.markExpired(entry, now);
      changed = true;
    }
    if (changed) await this.persist();
  }

  markExpired(entry, now = this.now()) {
    const reviewExpired = entry.status === "needs_review";
    entry.status = "expired";
    entry.waitingFor = null;
    entry.lastError = reviewExpired
      ? "The delivery review window expired; no instruction remains pending"
      : "Queued instruction expired before it could be delivered";
    entry.updatedAt = new Date(now).toISOString();
    this.emit("change", clone(entry));
  }

  public(entry, { includeText = false } = {}) {
    if (!entry) return null;
    const copy = {
      id: entry.id,
      sessionId: entry.sessionId,
      deviceId: entry.deviceId,
      expectedTurnId: entry.expectedTurnId,
      actionHint: entry.actionHint,
      status: entry.status,
      waitingFor: entry.waitingFor,
      attempts: entry.attempts,
      lastError: entry.lastError,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      expiresAt: entry.expiresAt,
      deliveredAt: entry.deliveredAt,
      deliveryUnknown: entry.deliveryUnknown === true,
      nextAttemptAt: entry.nextAttemptAt || null,
      preview: entry.text.length > 140 ? `${entry.text.slice(0, 139)}…` : entry.text,
    };
    if (includeText) copy.text = entry.text;
    if (entry.deliveredCommand) copy.command = clone(entry.deliveredCommand);
    return copy;
  }

  list({ sessionId = null, deviceId = null, includeTerminal = true } = {}) {
    const now = this.now();
    let expired = false;
    const result = [];
    for (const entry of this.entries.values()) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      if (deviceId && entry.deviceId !== deviceId) continue;
      if (!includeTerminal && TERMINAL_STATUSES.has(entry.status)) continue;
      if (shouldExpire(entry, now)) {
        this.markExpired(entry, now);
        expired = true;
      }
      result.push(this.public(entry));
    }
    if (expired) void this.queuePersist();
    return result.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  pending({ sessionId = null } = {}) {
    const now = this.now();
    let expired = false;
    const result = [];
    for (const entry of this.entries.values()) {
      if (!PENDING_STATUSES.has(entry.status) || (sessionId && entry.sessionId !== sessionId)) continue;
      if (Date.parse(entry.expiresAt) <= now) {
        this.markExpired(entry, now);
        expired = true;
        continue;
      }
      result.push(entry);
    }
    if (expired) void this.queuePersist();
    return result.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  async enqueue({ id, sessionId, deviceId, expectedTurnId = null, text, actionHint = "start", cwd = null, model = null, reasoningEffort = null, serviceTier = null, permissionProfile = null, confirmDangerFullAccess = false } = {}) {
    const commandId = cleanId(id, "client message id");
    const identity = { sessionId: cleanSessionId(sessionId), deviceId: cleanOptional(deviceId, 200),
      text: cleanText(text), expectedTurnId: cleanOptional(expectedTurnId, 200), actionHint,
      cwd: cleanOptional(cwd), model: cleanOptional(model, 160), reasoningEffort: cleanOptional(reasoningEffort, 80),
      serviceTier: cleanOptional(serviceTier, 80), permissionProfile: cleanOptional(permissionProfile, 80), confirmDangerFullAccess };
    const existing = this.entries.get(commandId);
    if (existing) {
      assertCommandIdentity(commandFingerprint(existing, { channel: "outbox" }), commandFingerprint(identity, { channel: "outbox" }));
      return { entry: clone(existing), created: false };
    }
    if (this.entries.size >= this.maxEntries) {
      const oldestTerminal = Array.from(this.entries.values())
        .filter((entry) => TERMINAL_STATUSES.has(entry.status))
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
      if (oldestTerminal) this.entries.delete(oldestTerminal.id);
      else throw Object.assign(new Error("Too many queued instructions; cancel an old one before adding another"), { statusCode: 429 });
    }
    const cleanSession = cleanSessionId(sessionId);
    const cleanDevice = cleanOptional(deviceId, 200);
    const createdAt = new Date(this.now()).toISOString();
    const entry = {
      id: commandId,
      sessionId: cleanSession,
      deviceId: cleanDevice,
      expectedTurnId: cleanOptional(expectedTurnId, 200),
      text: cleanText(text),
      actionHint: actionHint === "steer" ? "steer" : "start",
      cwd: cleanOptional(cwd),
      model: cleanOptional(model, 160),
      reasoningEffort: cleanOptional(reasoningEffort, 80),
      serviceTier: cleanOptional(serviceTier, 80),
      permissionProfile: cleanOptional(permissionProfile, 80),
      confirmDangerFullAccess: confirmDangerFullAccess === true,
      imageIds: [],
      status: "queued",
      waitingFor: "codex",
      attempts: 0,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      deliveredAt: null,
      deliveredCommand: null,
    };
    this.entries.set(entry.id, entry);
    await this.persist();
    this.emit("change", clone(entry));
    return { entry: clone(entry), created: true };
  }

  async update(id, patch = {}, { settleAttempt = null } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (settleAttempt != null && entry.attempts !== settleAttempt) return null;
    if (TERMINAL_STATUSES.has(entry.status)
      && !(settleAttempt != null && entry.status === "canceled" && ["delivered", "canceled"].includes(patch.status))) return clone(entry);
    Object.assign(entry, patch, { updatedAt: new Date(this.now()).toISOString() });
    await this.persist();
    this.emit("change", clone(entry));
    return clone(entry);
  }

  async cancel(id, deviceId = null) {
    const entry = this.entries.get(id);
    if (!entry || (deviceId && entry.deviceId !== deviceId)) return null;
    if (TERMINAL_STATUSES.has(entry.status) && entry.status !== "needs_review") return clone(entry);
    entry.deliveryUnknown = entry.deliveryUnknown === true || ["sending", "needs_review"].includes(entry.status);
    entry.status = "canceled";
    entry.waitingFor = null;
    entry.lastError = entry.deliveryUnknown
      ? "已停止自动重试；此前是否送达尚不确定，请先查看会话。取消队列不会中断已开始的执行。"
      : "Canceled from phone";
    entry.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    this.emit("change", clone(entry));
    return clone(entry);
  }

  persist() {
    const body = JSON.stringify({ version: 1, entries: Array.from(this.entries.values()) }, null, 2);
    const saving = this.persistQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, `${body}\n`, { mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    });
    this.persistQueue = saving.catch(() => {});
    return saving;
  }

  queuePersist() {
    return this.persist();
  }

  async flush() {
    await this.persistQueue;
  }
}
