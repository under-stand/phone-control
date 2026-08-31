import { createHash } from "node:crypto";
import { BrowserActionError, validateBrowserAction } from "./browser-action.mjs";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

function actionDigest(action) {
  return createHash("sha256").update(JSON.stringify(action)).digest("base64url");
}

/**
 * Coalesces retries without retaining sensitive action bodies such as typed
 * text. Only a digest and the eventual result promise are cached.
 */
export class BrowserActionReplayStore {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
    now = () => Date.now(),
  } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be positive");
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("maxEntries must be a positive integer");
    if (!Number.isFinite(maxResultBytes) || maxResultBytes <= 0) throw new TypeError("maxResultBytes must be positive");
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxResultBytes = maxResultBytes;
    this.now = now;
    this.entries = new Map();
  }

  async execute({ scopeId = "browser", actorId, action, run }) {
    const normalized = validateBrowserAction(action);
    const key = JSON.stringify([scopeId, actorId, normalized.clientActionId]);
    const digest = actionDigest(normalized);
    this.prune();

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.digest !== digest) {
        throw new BrowserActionError(
          "clientActionId was already used for a different action",
          409,
          "action_id_conflict",
        );
      }
      return existing.promise;
    }

    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    const entry = {
      scopeId,
      actorId,
      digest,
      expiresAt: this.now() + this.ttlMs,
      promise: null,
    };
    entry.promise = Promise.resolve()
      .then(() => run(normalized))
      .then((result) => {
        if (Buffer.byteLength(JSON.stringify(result)) > this.maxResultBytes && this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
        return result;
      });
    this.entries.set(key, entry);
    return entry.promise;
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  clearActor(actorId) {
    return this.clearWhere((entry) => entry.actorId === actorId);
  }

  clearWhere(predicate) {
    let cleared = 0;
    for (const [key, entry] of this.entries) {
      if (!predicate(entry)) continue;
      this.entries.delete(key);
      cleared += 1;
    }
    return cleared;
  }

  clearAll() {
    const cleared = this.entries.size;
    this.entries.clear();
    return cleared;
  }
}
