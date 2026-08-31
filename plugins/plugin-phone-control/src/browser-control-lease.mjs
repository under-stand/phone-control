import { randomBytes, timingSafeEqual } from "node:crypto";
import { BrowserActionError } from "./browser-action.mjs";

const DEFAULT_TTL_MS = 60_000;

function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class BrowserControlLeaseStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.lease = null;
  }

  active() {
    if (this.lease && this.lease.expiresAt <= this.now()) this.lease = null;
    return this.lease;
  }

  acquire(deviceId) {
    const current = this.active();
    if (current && current.deviceId !== deviceId) {
      throw new BrowserActionError("Another device currently controls this browser", 409, "lease_conflict");
    }
    if (current) {
      current.expiresAt = this.now() + this.ttlMs;
      return this.publicLease(current, deviceId);
    }
    const now = this.now();
    this.lease = {
      deviceId,
      token: randomBytes(24).toString("base64url"),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: now + this.ttlMs,
    };
    return this.publicLease(this.lease, deviceId);
  }

  validate(deviceId, token) {
    const current = this.active();
    if (!current || current.deviceId !== deviceId || !tokenMatches(token, current.token)) {
      throw new BrowserActionError("Browser control is missing or expired", 409, "lease_required");
    }
    current.expiresAt = this.now() + this.ttlMs;
    return this.publicLease(current, deviceId);
  }

  release(deviceId, token = null) {
    const current = this.active();
    if (!current) return false;
    if (current.deviceId !== deviceId || (token != null && !tokenMatches(token, current.token))) {
      throw new BrowserActionError("Browser control belongs to another device", 409, "lease_conflict");
    }
    this.lease = null;
    return true;
  }

  clearDevice(deviceId) {
    if (this.active()?.deviceId !== deviceId) return false;
    this.lease = null;
    return true;
  }

  clear() {
    this.lease = null;
  }

  status(deviceId = null) {
    const current = this.active();
    if (!current) return { held: false, owner: null, expiresAt: null };
    return this.publicLease(current, deviceId, false);
  }

  publicLease(lease, deviceId, includeToken = true) {
    return {
      held: true,
      owner: lease.deviceId === deviceId ? "self" : "other",
      acquiredAt: lease.acquiredAt,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      token: includeToken && lease.deviceId === deviceId ? lease.token : undefined,
    };
  }
}
