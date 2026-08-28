import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webPush from "web-push";

const MAX_SUBSCRIPTIONS = 50;

function cleanSubscription(value) {
  if (!value || typeof value !== "object") return null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  const p256dh = typeof value.keys?.p256dh === "string" ? value.keys.p256dh.trim() : "";
  const auth = typeof value.keys?.auth === "string" ? value.keys.auth.trim() : "";
  if (parsed.protocol !== "https:" || endpoint.length > 4096 || !p256dh || !auth || p256dh.length > 512 || auth.length > 256) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return null;
  return {
    endpoint,
    expirationTime: Number.isFinite(value.expirationTime) ? value.expirationTime : null,
    keys: { p256dh, auth },
  };
}

export class PushBroker extends EventEmitter {
  constructor({ filePath, sendNotification = webPush.sendNotification.bind(webPush), generateKeys = webPush.generateVAPIDKeys.bind(webPush), deviceIsActive = () => true } = {}) {
    super();
    this.filePath = filePath;
    this.sendNotification = sendNotification;
    this.generateKeys = generateKeys;
    this.deviceIsActive = deviceIsActive;
    this.keys = null;
    this.subscriptions = new Map();
    this.persistQueue = Promise.resolve();
  }

  async restore() {
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const storedKeys = parsed?.vapid;
    if (typeof storedKeys?.publicKey === "string" && typeof storedKeys?.privateKey === "string") {
      this.keys = { publicKey: storedKeys.publicKey, privateKey: storedKeys.privateKey };
    } else {
      this.keys = this.generateKeys();
    }
    for (const item of parsed?.subscriptions || []) {
      const subscription = cleanSubscription(item?.subscription);
      if (item?.deviceId && subscription && this.deviceIsActive(item.deviceId)) {
        this.subscriptions.set(item.deviceId, { deviceId: item.deviceId, subscription, updatedAt: item.updatedAt || null });
      }
    }
    await this.persist();
  }

  status(deviceId) {
    return {
      available: Boolean(this.keys?.publicKey),
      publicKey: this.keys?.publicKey || null,
      subscribed: this.subscriptions.has(deviceId),
    };
  }

  async subscribe(deviceId, value) {
    if (!this.deviceIsActive(deviceId)) throw Object.assign(new Error("Device is no longer active"), { statusCode: 401 });
    const subscription = cleanSubscription(value);
    if (!subscription) throw Object.assign(new Error("Invalid push subscription"), { statusCode: 400 });
    if (!this.subscriptions.has(deviceId) && this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw Object.assign(new Error("Too many push subscriptions"), { statusCode: 409 });
    }
    this.subscriptions.set(deviceId, { deviceId, subscription, updatedAt: new Date().toISOString() });
    await this.queuePersist();
    return this.status(deviceId);
  }

  async unsubscribe(deviceId) {
    const removed = this.subscriptions.delete(deviceId);
    if (removed) await this.queuePersist();
    return removed;
  }

  async test(deviceId) {
    const record = this.subscriptions.get(deviceId);
    if (!record) throw Object.assign(new Error("Enable notifications on this device first"), { statusCode: 409 });
    const result = await this.deliver(record, {
      version: 1,
      title: "Phone Control 通知已连接",
      body: "关闭页面后，Codex 的待处理和完成状态仍可提醒你。",
      tag: "phone-control-test",
      url: "/",
      kind: "test",
    });
    if (result === "expired") throw Object.assign(new Error("The push subscription expired; enable notifications again"), { statusCode: 410 });
    if (result !== "sent") throw Object.assign(new Error("The browser push service could not be reached"), { statusCode: 502 });
    return { ok: true };
  }

  async broadcast(payload, { deviceIds = null } = {}) {
    const recipients = deviceIds == null ? null : new Set(deviceIds);
    let subscriptionsChanged = false;
    await Promise.all(Array.from(this.subscriptions.values(), async (record) => {
      if (recipients && !recipients.has(record.deviceId)) return;
      if (!this.deviceIsActive(record.deviceId)) {
        this.subscriptions.delete(record.deviceId);
        subscriptionsChanged = true;
        return;
      }
      if (await this.deliver(record, payload) === "expired") subscriptionsChanged = true;
    }));
    if (subscriptionsChanged) await this.queuePersist();
  }

  async deliver(record, payload) {
    try {
      await this.sendNotification(record.subscription, JSON.stringify(payload), {
        TTL: 300,
        urgency: payload.kind === "attention" ? "high" : "normal",
        topic: String(payload.tag || "phone-control").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32),
        ...(process.env.HTTPS_PROXY || process.env.https_proxy ? { proxy: process.env.HTTPS_PROXY || process.env.https_proxy } : {}),
        vapidDetails: {
          subject: "mailto:phone-control@local.invalid",
          publicKey: this.keys.publicKey,
          privateKey: this.keys.privateKey,
        },
      });
      return "sent";
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        this.subscriptions.delete(record.deviceId);
        return "expired";
      }
      this.emit("warning", error);
      return "failed";
    }
  }

  queuePersist() {
    this.persistQueue = this.persistQueue.catch(() => {}).then(() => this.persist());
    return this.persistQueue;
  }

  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const body = {
      version: 1,
      vapid: this.keys,
      subscriptions: Array.from(this.subscriptions.values()),
    };
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  async flush() {
    await this.persistQueue;
  }
}
