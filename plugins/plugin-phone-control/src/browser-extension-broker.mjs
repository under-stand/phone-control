import { randomBytes } from "node:crypto";
import { BrowserActionError, assertCurrentBrowserFrame } from "./browser-action.mjs";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_ONLINE_TTL_MS = 35_000;
const DEFAULT_POLL_MS = 20_000;
const MAX_PENDING_COMMANDS = 32;
const MAX_FRAME_DATA_URL_LENGTH = 8 * 1024 * 1024;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function shortText(value, fallback = null, max = 512) {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\0\r\n]/g, " ").trim();
  return normalized ? normalized.slice(0, max) : fallback;
}

function publicTab(tab) {
  if (!tab || typeof tab !== "object") return null;
  const id = shortText(String(tab.id ?? ""), null, 128);
  if (!id) return null;
  return {
    id,
    windowId: shortText(String(tab.windowId ?? ""), null, 128),
    title: shortText(tab.title, "Untitled tab", 512),
    url: shortText(tab.url, "about:blank", 8_192),
    active: Boolean(tab.active),
    audible: Boolean(tab.audible),
    supported: tab.supported !== false,
  };
}

export class BrowserExtensionBroker {
  constructor({
    now = () => Date.now(),
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    onlineTtlMs = DEFAULT_ONLINE_TTL_MS,
  } = {}) {
    this.now = now;
    this.commandTimeoutMs = commandTimeoutMs;
    this.onlineTtlMs = onlineTtlMs;
    this.client = null;
    this.pinnedOrigin = null;
    this.queue = [];
    this.pending = new Map();
    this.waitingPoll = null;
    this.frame = null;
    this.tabs = [];
    this.activeTabId = null;
  }

  connect({ clientId, name = "Chrome", version = null, origin = null } = {}) {
    if (typeof clientId !== "string" || !clientId.trim() || clientId.length > 128) {
      throw new BrowserActionError("Invalid browser extension clientId");
    }
    if (typeof origin !== "string" || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      throw new BrowserActionError("Invalid browser extension origin", 403, "extension_identity_mismatch");
    }
    if (this.pinnedOrigin && this.pinnedOrigin !== origin) {
      throw new BrowserActionError("A different Chrome extension is already connected", 403, "extension_identity_mismatch");
    }
    this.pinnedOrigin = origin;

    const changed = this.client?.clientId !== clientId;
    if (changed) {
      this.failPending("Browser extension reconnected");
      this.queue = [];
      this.frame = null;
      this.tabs = [];
      this.activeTabId = null;
    }
    this.client = {
      clientId: clientId.trim(),
      origin,
      name: shortText(name, "Chrome", 80),
      version: shortText(version, null, 40),
      connectedAt: changed || !this.client ? new Date(this.now()).toISOString() : this.client.connectedAt,
      lastSeenAt: this.now(),
    };
    return this.status();
  }

  touch(clientId, origin) {
    if (
      !this.client
      || this.client.clientId !== clientId
      || this.client.origin !== origin
      || this.pinnedOrigin !== origin
    ) {
      throw new BrowserActionError("Browser extension must connect first", 409, "extension_not_connected");
    }
    this.client.lastSeenAt = this.now();
  }

  online() {
    return Boolean(this.client && this.now() - this.client.lastSeenAt <= this.onlineTtlMs);
  }

  status(deviceId = null, lease = null) {
    return {
      connected: this.online(),
      extension: this.client ? {
        name: this.client.name,
        version: this.client.version,
        connectedAt: this.client.connectedAt,
        lastSeenAt: new Date(this.client.lastSeenAt).toISOString(),
      } : null,
      tabs: this.tabs,
      activeTabId: this.activeTabId,
      frame: this.publicFrame(),
      control: lease?.status(deviceId) || { held: false, owner: null, expiresAt: null },
    };
  }

  publicFrame() {
    if (!this.frame) return null;
    const { dataUrl: _dataUrl, ...metadata } = this.frame;
    return metadata;
  }

  updateSnapshot(clientId, origin, snapshot = {}) {
    this.touch(clientId, origin);
    if (Array.isArray(snapshot.tabs)) this.tabs = snapshot.tabs.slice(0, 256).map(publicTab).filter(Boolean);
    if (Object.hasOwn(snapshot, "activeTabId")) {
      this.activeTabId = snapshot.activeTabId == null ? null : shortText(String(snapshot.activeTabId), null, 128);
    }
    if (Object.hasOwn(snapshot, "frame")) {
      if (snapshot.frame == null) this.frame = null;
      else this.acceptFrame(snapshot.frame);
    }
    return this.status();
  }

  acceptFrame(frame) {
    if (!frame || typeof frame !== "object") throw new BrowserActionError("Invalid browser frame");
    if (
      typeof frame.dataUrl !== "string"
      || frame.dataUrl.length > MAX_FRAME_DATA_URL_LENGTH
      || !/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(frame.dataUrl)
    ) {
      throw new BrowserActionError("Invalid browser frame image");
    }
    const frameId = shortText(frame.frameId, null, 128);
    const tabId = shortText(String(frame.tabId ?? ""), null, 128);
    const url = shortText(frame.url, null, 8_192);
    if (!frameId || !tabId || !url) throw new BrowserActionError("Invalid browser frame metadata");
    if (!Number.isInteger(frame.pageGeneration) || frame.pageGeneration < 0) {
      throw new BrowserActionError("Invalid browser frame pageGeneration");
    }
    if (![frame.width, frame.height].every((value) => Number.isFinite(value) && value > 0 && value <= 100_000)) {
      throw new BrowserActionError("Invalid browser frame dimensions");
    }
    this.frame = {
      frameId,
      pageGeneration: frame.pageGeneration,
      tabId,
      url,
      title: shortText(frame.title, url, 512),
      width: frame.width,
      height: frame.height,
      capturedAt: shortText(frame.capturedAt, null, 80),
      dataUrl: frame.dataUrl,
      receivedAt: new Date(this.now()).toISOString(),
    };
  }

  frameImage() {
    return this.frame;
  }

  async poll(clientId, origin, waitMs = DEFAULT_POLL_MS) {
    this.touch(clientId, origin);
    const command = this.queue.shift();
    if (command) return { command };
    if (this.waitingPoll) this.waitingPoll.resolve({ command: null });
    const waiter = deferred();
    this.waitingPoll = waiter;
    const boundedWait = Math.min(DEFAULT_POLL_MS, Math.max(0, Number(waitMs) || DEFAULT_POLL_MS));
    const timer = setTimeout(() => waiter.resolve({ command: null }), boundedWait);
    timer.unref?.();
    try {
      return await waiter.promise;
    } finally {
      clearTimeout(timer);
      if (this.waitingPoll === waiter) this.waitingPoll = null;
      this.touch(clientId, origin);
    }
  }

  async invoke(action) {
    if (!this.online()) {
      throw new BrowserActionError("Chrome extension is offline", 503, "extension_offline");
    }
    if (this.pending.size >= MAX_PENDING_COMMANDS) {
      throw new BrowserActionError("Too many browser actions are pending", 429, "browser_busy");
    }
    if (["tap", "scroll", "insertText", "key"].includes(action.type)) {
      assertCurrentBrowserFrame(action, this.frame);
    }
    const id = randomBytes(18).toString("base64url");
    const waiting = deferred();
    const timeout = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      this.queue = this.queue.filter((command) => command.id !== id);
      waiting.reject(new BrowserActionError("Chrome extension did not respond", 504, "extension_timeout"));
    }, this.commandTimeoutMs);
    timeout.unref?.();
    this.pending.set(id, { ...waiting, timeout });
    const command = { id, action, sentAt: new Date(this.now()).toISOString() };
    if (this.waitingPoll) {
      const poll = this.waitingPoll;
      this.waitingPoll = null;
      poll.resolve({ command });
    } else {
      this.queue.push(command);
    }
    return waiting.promise;
  }

  complete(clientId, origin, body = {}) {
    this.touch(clientId, origin);
    const pending = this.pending.get(body.commandId);
    if (!pending) return false;
    this.pending.delete(body.commandId);
    clearTimeout(pending.timeout);
    if (body.snapshot) this.updateSnapshot(clientId, origin, body.snapshot);
    if (body.ok === false) {
      pending.reject(new BrowserActionError(
        shortText(body.error, "Chrome extension command failed", 1_000),
        502,
        "extension_command_failed",
      ));
    } else {
      pending.resolve(body.result ?? { ok: true });
    }
    return true;
  }

  failPending(message = "Browser extension stopped") {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new BrowserActionError(message, 503, "extension_offline"));
    }
    this.pending.clear();
    if (this.waitingPoll) this.waitingPoll.resolve({ command: null });
    this.waitingPoll = null;
  }

  close() {
    this.failPending();
    this.queue = [];
    this.client = null;
    this.pinnedOrigin = null;
    this.frame = null;
    this.tabs = [];
    this.activeTabId = null;
  }
}
