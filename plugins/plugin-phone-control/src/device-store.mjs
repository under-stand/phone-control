import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_DEVICES = 50;
const MAX_REVOKED_DEVICES = 20;

function hash(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanName(value) {
  const name = String(value || "Mobile browser").replace(/[\r\n\t]+/g, " ").trim();
  return name.slice(0, 80) || "Mobile browser";
}

function cleanTargetSessionId(value) {
  if (value == null) return null;
  if (typeof value !== "string") throw Object.assign(new Error("Invalid target session"), { statusCode: 400 });
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > 240 || /[\r\n\0]/.test(sessionId)) {
    throw Object.assign(new Error("Invalid target session"), { statusCode: 400 });
  }
  return sessionId;
}

export class DeviceStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.devices = new Map();
    this.persistQueue = Promise.resolve();
  }

  async restore() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      for (const device of parsed.devices || []) {
        if (device?.id && device?.tokenHash) {
          const targetSessionId = typeof device.targetSessionId === "string" && device.targetSessionId.length <= 240
            ? device.targetSessionId
            : null;
          this.devices.set(device.id, { ...device, targetSessionId });
        }
      }
      this.compactRevoked();
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  pair({ name, userAgent, remoteAddress } = {}) {
    const active = Array.from(this.devices.values()).filter((device) => !device.revokedAt);
    if (active.length >= MAX_DEVICES) throw Object.assign(new Error("Too many paired devices"), { statusCode: 409 });
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const device = {
      id,
      name: cleanName(name),
      tokenHash: hash(secret),
      createdAt: now,
      lastSeenAt: now,
      userAgent: String(userAgent || "").slice(0, 240) || null,
      remoteAddress: String(remoteAddress || "").slice(0, 80) || null,
      targetSessionId: null,
      revokedAt: null,
    };
    this.devices.set(id, device);
    this.queuePersist();
    return { credential: `${id}.${secret}`, device: this.publicDevice(device) };
  }

  authenticate(credential) {
    if (typeof credential !== "string") return null;
    const separator = credential.indexOf(".");
    if (separator < 1) return null;
    const id = credential.slice(0, separator);
    const secret = credential.slice(separator + 1);
    const device = this.devices.get(id);
    if (!device || device.revokedAt || !safeEqual(hash(secret), device.tokenHash)) return null;
    const now = Date.now();
    if (!device.lastSeenAt || now - Date.parse(device.lastSeenAt) > 5 * 60_000) {
      device.lastSeenAt = new Date(now).toISOString();
      this.queuePersist();
    }
    return this.publicDevice(device);
  }

  list() {
    return Array.from(this.devices.values())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((device) => this.publicDevice(device));
  }

  revoke(id) {
    const device = this.devices.get(id);
    if (!device || device.revokedAt) return false;
    device.revokedAt = new Date().toISOString();
    this.compactRevoked({ persist: false });
    this.queuePersist();
    return true;
  }

  compactRevoked({ limit = MAX_REVOKED_DEVICES, persist = true } = {}) {
    const revoked = Array.from(this.devices.values())
      .filter((device) => device.revokedAt)
      .sort((left, right) => String(right.revokedAt).localeCompare(String(left.revokedAt)));
    const removable = revoked.slice(Math.max(0, limit));
    for (const device of removable) this.devices.delete(device.id);
    if (removable.length && persist) this.queuePersist();
    return removable.length;
  }

  purgeRevoked() {
    let removed = 0;
    for (const [id, device] of this.devices) {
      if (!device.revokedAt) continue;
      this.devices.delete(id);
      removed += 1;
    }
    if (removed) this.queuePersist();
    return removed;
  }

  counts() {
    let active = 0;
    let revoked = 0;
    for (const device of this.devices.values()) {
      if (device.revokedAt) revoked += 1;
      else active += 1;
    }
    return { active, revoked, total: active + revoked };
  }

  isActive(id) {
    const device = this.devices.get(id);
    return Boolean(device && !device.revokedAt);
  }

  target(id) {
    const device = this.devices.get(id);
    return device && !device.revokedAt ? device.targetSessionId || null : null;
  }

  setTarget(id, value) {
    const device = this.devices.get(id);
    if (!device || device.revokedAt) throw Object.assign(new Error("Device not found"), { statusCode: 404 });
    const targetSessionId = cleanTargetSessionId(value);
    if (device.targetSessionId === targetSessionId) return targetSessionId;
    device.targetSessionId = targetSessionId;
    this.queuePersist();
    return targetSessionId;
  }

  notificationRecipients(sessionId, { includeUntargeted = false } = {}) {
    return Array.from(this.devices.values())
      .filter((device) => !device.revokedAt && (
        device.targetSessionId === sessionId || (includeUntargeted && !device.targetSessionId)
      ))
      .map((device) => device.id);
  }

  clearTargetSession(sessionId) {
    let changed = false;
    for (const device of this.devices.values()) {
      if (device.targetSessionId !== sessionId) continue;
      device.targetSessionId = null;
      changed = true;
    }
    if (changed) this.queuePersist();
    return changed;
  }

  publicDevice(device) {
    const { tokenHash, userAgent, remoteAddress, targetSessionId, ...safe } = device;
    return { ...safe };
  }

  queuePersist() {
    this.persistQueue = this.persistQueue.then(() => this.persist());
  }

  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const body = { version: 2, devices: Array.from(this.devices.values()) };
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  async flush() {
    await this.persistQueue;
  }
}
