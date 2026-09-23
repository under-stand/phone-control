import { readFile } from "node:fs/promises";
import { AtomicJsonFile } from "./atomic-json-file.mjs";
import { commandFingerprint, assertCommandIdentity } from "./command-identity.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

// Shared request semantics for direct input and thread creation. It records
// intent before any side effect; uncertainty survives service restart.
export class CommandReplay {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.journal = filePath ? new AtomicJsonFile(filePath) : null;
    this.records = new Map();
    this.inflight = new Map();
    this.loading = null;
  }

  restore() {
    if (!this.loading) this.loading = (async () => {
      if (!this.filePath) return;
      let records;
      try { records = JSON.parse(await readFile(this.filePath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (!Array.isArray(records)) throw new Error("Invalid command replay journal");
      for (const record of records) {
        if (!record?.id || !record.fingerprint) throw new Error("Invalid command replay record");
        if (record.status === "sending") record.status = "unknown";
        this.records.set(record.id, record);
      }
    })();
    return this.loading;
  }

  async persist() { await this.journal?.write([...this.records.values()]); }

  async execute(input, device, channel, run) {
    await this.restore();
    const id = input.clientMessageId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{8,100}$/.test(id)) {
      throw Object.assign(new Error("A valid client message id is required"), { statusCode: 400, delivery: "not_delivered" });
    }
    const fingerprint = commandFingerprint(input, { channel, deviceId: device?.id });
    const existing = this.records.get(id);
    if (existing) {
      assertCommandIdentity(existing.fingerprint, fingerprint);
      if (this.inflight.has(id)) return clone(await this.inflight.get(id));
      if (existing.status === "delivered") return clone(existing.result);
      if (existing.status !== "not_delivered") throw Object.assign(new Error("此前是否送达尚不确定，请先查看会话；不会自动重发"), {
        code: "delivery_unknown", statusCode: 409, delivery: "unknown", retryable: false,
      });
    }
    const record = { id, fingerprint, channel, sessionId: input.sessionId || null, deviceId: device?.id || null,
      status: "sending", updatedAt: new Date().toISOString() };
    this.records.set(id, record);
    const operation = (async () => {
      try {
        await this.persist();
      } catch (error) {
        record.status = "not_delivered";
        throw Object.assign(error, { delivery: "not_delivered" });
      }
      try {
        const result = await run();
        Object.assign(record, { status: "delivered", sessionId: result.sessionId, result: clone(result), updatedAt: new Date().toISOString() });
        await this.persist();
        return result;
      } catch (error) {
        if (record.status !== "delivered") record.status = error.delivery === "not_delivered" ? "not_delivered" : "unknown";
        await this.persist();
        throw error;
      }
    })();
    this.inflight.set(id, operation);
    try { return clone(await operation); }
    finally { this.inflight.delete(id); }
  }

  uncertain({ sessionId, deviceId } = {}) {
    return [...this.records.values()].filter((record) => record.status === "unknown"
      && (!sessionId || record.sessionId === sessionId) && (!deviceId || record.deviceId === deviceId))
      .map((record) => ({ id: record.id, sessionId: record.sessionId, status: "delivery_unknown", updatedAt: record.updatedAt }));
  }

  async flush() {
    await Promise.allSettled([...this.inflight.values()]);
    await this.journal?.flush();
  }
}
