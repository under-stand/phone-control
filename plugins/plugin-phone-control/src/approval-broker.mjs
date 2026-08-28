import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_AUDIT_BYTES = 4 * 1024 * 1024;

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export class ApprovalBroker extends EventEmitter {
  constructor({ enabled = false, timeoutSeconds = 45, auditLogPath = null } = {}) {
    super();
    this.enabled = enabled;
    this.timeoutMs = timeoutSeconds * 1_000;
    this.auditLogPath = auditLogPath;
    this.approvals = new Map();
    this.auditQueue = Promise.resolve();
  }

  create(event) {
    if (!this.enabled) return null;
    const now = Date.now();
    const approval = {
      id: randomUUID(),
      eventId: event.eventId || null,
      sessionId: event.sessionId,
      turnId: event.turnId || null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
      status: "pending",
      tool: event.tool || null,
      reason: event.reason || "Codex requests approval",
      cwd: event.cwd || null,
      details: event.approvalDetails || null,
      decidedAt: null,
      decidedBy: null,
      decision: null,
      timer: null,
    };
    approval.timer = setTimeout(() => this.expire(approval.id), this.timeoutMs);
    approval.timer.unref?.();
    this.approvals.set(approval.id, approval);
    this.audit("created", approval);
    this.emit("changed", this.publicApproval(approval));
    return this.publicApproval(approval);
  }

  list() {
    this.expireOverdue();
    return Array.from(this.approvals.values())
      .filter((approval) => approval.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((approval) => this.publicApproval(approval));
  }

  get(id) {
    this.expireOverdue();
    const approval = this.approvals.get(id);
    return approval ? this.publicApproval(approval) : null;
  }

  decide(id, decision, device) {
    if (!this.enabled) throw httpError("Phone approvals are disabled", 409);
    if (!['allow', 'deny'].includes(decision)) throw httpError("Decision must be allow or deny", 400);
    const approval = this.approvals.get(id);
    if (!approval) throw httpError("Approval not found", 404);
    if (approval.status !== "pending") throw httpError("Approval was already resolved", 409);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      this.expire(id);
      throw httpError("Approval expired", 410);
    }
    clearTimeout(approval.timer);
    approval.timer = null;
    approval.status = decision === "allow" ? "allowed" : "denied";
    approval.decision = decision;
    approval.decidedAt = new Date().toISOString();
    approval.decidedBy = device?.id || null;
    this.audit("decided", approval, { deviceName: device?.name || null });
    const safe = this.publicApproval(approval);
    this.emit("resolved", safe);
    this.emit("changed", safe);
    return safe;
  }

  wait(id, timeoutMs = this.timeoutMs + 1_000) {
    const approval = this.approvals.get(id);
    if (!approval) return Promise.resolve(null);
    if (approval.status !== "pending") return Promise.resolve(this.publicApproval(approval));
    return new Promise((resolve) => {
      const finish = (resolved) => {
        if (resolved.id !== id) return;
        clearTimeout(timer);
        this.off("resolved", finish);
        resolve(resolved);
      };
      const timer = setTimeout(() => {
        this.off("resolved", finish);
        resolve(this.get(id));
      }, timeoutMs);
      timer.unref?.();
      this.on("resolved", finish);
    });
  }

  expire(id) {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== "pending") return;
    clearTimeout(approval.timer);
    approval.timer = null;
    approval.status = "expired";
    approval.decidedAt = new Date().toISOString();
    this.audit("expired", approval);
    const safe = this.publicApproval(approval);
    this.emit("resolved", safe);
    this.emit("changed", safe);
  }

  expireOverdue() {
    const now = Date.now();
    for (const approval of this.approvals.values()) {
      if (approval.status === "pending" && Date.parse(approval.expiresAt) <= now) this.expire(approval.id);
    }
  }

  publicApproval(approval) {
    const { timer, ...safe } = approval;
    return JSON.parse(JSON.stringify(safe));
  }

  audit(action, approval, extra = {}) {
    if (!this.auditLogPath) return;
    const row = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      action,
      approvalId: approval.id,
      eventId: approval.eventId,
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      toolName: approval.tool?.name || null,
      status: approval.status,
      decision: approval.decision,
      decidedBy: approval.decidedBy,
      ...extra,
    };
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
    for (const approval of this.approvals.values()) clearTimeout(approval.timer);
    await this.auditQueue;
  }
}
