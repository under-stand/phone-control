import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseCodexVersion } from "./runtime-diagnostics.mjs";
import { KeyedOperations, forEachConcurrent } from "./keyed-operations.mjs";
import { AtomicJsonFile } from "./atomic-json-file.mjs";
import { commandFingerprint, assertCommandIdentity } from "./command-identity.mjs";

const PENDING = new Set(["sending", "cli_queued", "needs_review"]);
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

// Queue operations never resume a thread or acquire its writer. The original
// CLI consumes Codex's persistent queue with its own runtime configuration.
export class CliSessionQueue extends EventEmitter {
  constructor({ bridge, filePath, now = () => Date.now(), maxDetailedRecords = 2000 }) {
    super();
    this.bridge = bridge;
    this.filePath = filePath;
    this.entries = new Map();
    this.operations = new KeyedOperations();
    this.journal = new AtomicJsonFile(filePath);
    this.now = now;
    this.maxDetailedRecords = maxDetailedRecords;
    this.retryAt = new Map();
    this.receiptCursors = new Map();
    this.refreshing = null;
    this.unsupported = false;
  }

  available() {
    const status = this.bridge?.status?.() || {};
    const version = parseCodexVersion(status.server?.userAgent)?.split(".").map(Number);
    return Boolean(!this.unsupported && typeof this.bridge?.request === "function"
      && status.connected && status.initialized && version
      && (version[0] > 0 || version[1] >= 154));
  }

  capability(session) {
    return {
      available: Boolean(this.available() && session.surface === "CLI" && session.taskKind === "user"
        && session.hasTranscript && !session.control?.live),
      detail: "消息交给原 CLI，沿用它的模型、工作目录和权限。忙时等待后续处理；CLI 已关闭时，需在电脑重新打开原会话。审批仍由原 CLI 处理。",
    };
  }

  async restore() {
    let records;
    try { records = JSON.parse(await readFile(this.filePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!Array.isArray(records)) throw new Error("Invalid CLI queue journal");
    for (const record of records) {
      if (!record?.id || !record.sessionId || !record.clientUserMessageId) throw new Error("Invalid CLI queue entry");
      if (record.status === "sending") {
        record.status = "needs_review";
        record.lastError = "服务重启时发送尚未确认，正在核对原 CLI 队列；不会自动重发。";
      }
      this.entries.set(record.id, record);
    }
  }

  async save(entry, changes = {}) {
    Object.assign(entry, changes, { updatedAt: new Date(this.now()).toISOString() });
    const snapshot = this.public(entry);
    await this.journal.write([...this.entries.values()]);
    this.emit("change", snapshot);
  }

  public(entry) {
    const { text, clientUserMessageId, queuedSubmissionId, fingerprint, ...record } = entry;
    return { ...record, preview: (text || "").slice(0, 180), channel: "cli" };
  }

  list({ sessionId, deviceId, includeTerminal = false } = {}) {
    return [...this.entries.values()].filter((entry) => !entry.archived && (!sessionId || entry.sessionId === sessionId)
      && (!deviceId || entry.deviceId === deviceId) && (includeTerminal || PENDING.has(entry.status)))
      .map((entry) => this.public(entry));
  }

  compactCompleted() {
    const detailed = [...this.entries.values()].filter((entry) => !entry.archived);
    const terminal = detailed.filter((entry) => ["canceled", "failed"].includes(entry.status) || entry.completedAt)
      .sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")));
    let count = detailed.length;
    while (count >= this.maxDetailedRecords && terminal.length) {
      const entry = terminal.shift();
      entry.fingerprint ||= commandFingerprint(entry, { channel: "cli" });
      entry.text = "";
      entry.archived = true;
      count--;
    }
    // Keep the id and fingerprint tombstone: an old HTTP retry must never
    // become a fresh submission merely because its display history aged out.
    return count;
  }

  submit({ sessionId, deviceId, clientMessageId, text, ...overrides }) {
    return this.operations.run(sessionId, async () => {
      if (typeof clientMessageId !== "string" || !/^[A-Za-z0-9_.:-]{8,100}$/.test(clientMessageId)) throw fail("需要有效的消息标识", 400);
      if (typeof text !== "string" || !text.trim() || text.trim().length > 4000) throw fail("请输入 1–4000 字的消息", 400);
      if (["cwd", "model", "reasoningEffort", "serviceTier", "permissionProfile"].some((key) => overrides[key])
        || (overrides.imageIds?.length)) throw fail("发送到原 CLI 仅支持文字，并沿用 CLI 当前设置", 400);
      const id = `cli-${clientMessageId}`;
      const fingerprint = commandFingerprint({ sessionId, deviceId, text }, { channel: "cli" });
      const existing = this.entries.get(id);
      if (existing) {
        assertCommandIdentity(existing.fingerprint || commandFingerprint(existing, { channel: "cli" }), fingerprint);
        return this.public(existing);
      }
      if (!this.available()) throw fail("原 CLI 队列暂不可用，需要连接到 Codex 0.154.0 或更新版本", 503);
      if (this.compactCompleted() >= this.maxDetailedRecords) throw fail("CLI 未完成消息过多，请先处理现有队列", 503);
      const entry = { id, sessionId, deviceId, text: text.trim(), fingerprint, clientUserMessageId: randomUUID(),
        status: "sending", action: "cli", createdAt: new Date().toISOString() };
      this.entries.set(id, entry);
      // Persist before the only add attempt. A lost response never causes a
      // second add, including after a phone refresh or service restart.
      await this.save(entry);
      try {
        const result = await this.bridge.request("thread/queue/add", {
          threadId: sessionId, clientUserMessageId: entry.clientUserMessageId,
          input: [{ type: "text", text: entry.text }],
        });
        if (!result.queuedSubmission?.id) throw new Error("Missing queue receipt");
        await this.save(entry, { status: "cli_queued", queuedSubmissionId: result.queuedSubmission.id, lastError: null });
      } catch (error) {
        const unsupported = (error.rpcError?.code ?? error.code) === -32601;
        if (unsupported) this.unsupported = true;
        await this.save(entry, { status: unsupported ? "failed" : "needs_review",
          lastError: unsupported ? "当前 Codex 不支持原 CLI 队列" : "未确认投递结果，正在核对原 CLI 队列；不会自动重发。" });
      }
      return this.public(entry);
    });
  }

  async queued(sessionId) {
    const items = [];
    let cursor;
    do {
      const page = await this.bridge.request("thread/queue/list", { threadId: sessionId, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error("Invalid queue response");
      items.push(...page.data);
      cursor = page.nextCursor;
      if (items.length > 10000) throw new Error("Queue exceeds inspection limit");
    } while (cursor);
    return items;
  }

  async receipts(sessionId) {
    const receipts = new Map();
    // Always inspect the head for new receipts, plus one older page per pass.
    // This bounds work while eventually recovering receipts beyond 20 turns.
    const olderCursor = this.receiptCursors.get(sessionId);
    for (const cursor of olderCursor ? [null, olderCursor] : [null]) {
      const result = await this.bridge.request("thread/turns/list", { threadId: sessionId, limit: 20, sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error("Invalid turn history response");
      for (const turn of result.data) {
        for (const item of turn.items || []) {
          if (item.type === "userMessage" && item.clientId && !receipts.has(item.clientId)) receipts.set(item.clientId, turn);
        }
      }
      if (cursor || !olderCursor) {
        if (result.nextCursor) this.receiptCursors.set(sessionId, result.nextCursor);
        else this.receiptCursors.delete(sessionId);
      }
    }
    return receipts;
  }

  async markReceived(entry, turn) {
    const completed = ["completed", "interrupted", "failed"].includes(turn.status);
    await this.save(entry, { status: "delivered", turnId: turn.id, lastError: null,
      deliveredAt: entry.deliveredAt || new Date().toISOString(),
      ...(completed ? { completedAt: new Date().toISOString(), outcome: turn.status === "failed" ? "error" : turn.status === "interrupted" ? "aborted" : "completed" } : {}) });
  }

  reconcile() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!this.available()) return;
      const entries = [...this.entries.values()].filter((entry) => PENDING.has(entry.status) || (entry.status === "delivered" && !entry.completedAt));
      await forEachConcurrent([...new Set(entries.map((entry) => entry.sessionId))], 3, async (sessionId) => {
        if ((this.retryAt.get(sessionId)?.at || 0) > this.now()) return;
        await this.operations.run(sessionId, async () => {
          try {
            const current = entries.filter((item) => item.sessionId === sessionId
              && (PENDING.has(item.status) || (item.status === "delivered" && !item.completedAt)));
            if (!current.length) return;
            const queued = await this.queued(sessionId);
            const receipts = await this.receipts(sessionId);
            this.retryAt.delete(sessionId);
            for (const entry of current) {
              const receipt = receipts.get(entry.clientUserMessageId);
              const pending = queued.find((item) => item.clientUserMessageId === entry.clientUserMessageId);
              if (receipt) {
                if (entry.status !== "delivered" || receipt.status !== "inProgress") await this.markReceived(entry, receipt);
              } else if (pending && entry.status !== "delivered") {
                if (entry.status !== "cli_queued" || entry.queuedSubmissionId !== pending.id) await this.save(entry, { status: "cli_queued", queuedSubmissionId: pending.id, lastError: null });
              } else if (entry.status === "cli_queued") {
                await this.save(entry, { status: "needs_review", lastError: "原 CLI 队列中已无此消息，尚未发现对应执行回执；可能刚开始执行或已在电脑取消。不会自动重发。" });
              }
            }
          } catch {
            const failures = (this.retryAt.get(sessionId)?.failures || 0) + 1;
            this.retryAt.set(sessionId, { failures, at: this.now() + Math.min(60000, 3000 * 2 ** Math.min(failures - 1, 5)) });
            // A bad cursor must not permanently block receipt recovery.
            this.receiptCursors.delete(sessionId);
          }
        });
      });
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  cancel(id, deviceId) {
    return this.operations.run(this.entries.get(id)?.sessionId || id, async () => {
      const entry = this.entries.get(id);
      if (!entry || entry.deviceId !== deviceId) return null;
      if (!PENDING.has(entry.status)) return this.public(entry);
      if (!this.available()) throw fail("暂时无法连接原 CLI 队列，请连接恢复后重试取消", 503);
      const queued = await this.queued(entry.sessionId);
      const pending = queued.find((item) => item.clientUserMessageId === entry.clientUserMessageId);
      if (pending) {
        const result = await this.bridge.request("thread/queue/delete", { threadId: entry.sessionId, queuedSubmissionId: pending.id });
        if (result.deleted === true) {
          await this.save(entry, { status: "canceled", lastError: null });
          return this.public(entry);
        }
      }
      const receipt = (await this.receipts(entry.sessionId)).get(entry.clientUserMessageId);
      if (receipt) await this.markReceived(entry, receipt);
      else await this.save(entry, { status: "needs_review", lastError: "未确认取消：消息已离开原 CLI 队列，请查看会话。取消排队不会停止已经开始的执行。" });
      return this.public(entry);
    });
  }

  async flush() {
    await this.refreshing;
    await this.operations.flush();
    await this.journal.flush();
  }
}
