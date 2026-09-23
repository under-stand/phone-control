// A decision belongs to one request, independently of detail selection or DOM
// lifetime. A cached session snapshot cannot acknowledge or retry a write.
export class ApprovalDecisions {
  constructor() {
    this.requests = new Map();
  }

  get(id) {
    return this.requests.get(String(id));
  }

  begin(id, { sessionId, turnId, decision }) {
    const previous = this.get(id);
    if (previous && previous.state !== "pending") return false;
    this.set(id, { state: "sending", sessionId, turnId, decision });
    return true;
  }

  set(id, value) {
    this.requests.set(String(id), { ...this.get(id), ...value });
  }

  reconcile(id, approval) {
    const previous = this.get(id);
    if (!previous || previous.state === "sending" || !approval) return;
    if (String(approval.id) !== String(id) || approval.sessionId !== previous.sessionId
      || (approval.turnId || null) !== (previous.turnId || null)) return;
    if (approval.status === "pending") {
      // Only a definite rejection can be retried after a direct broker read.
      // A timed-out POST may still arrive after this GET: never replay it.
      if (previous.state === "rejected" && approval.canRespond !== false) {
        this.set(id, { state: "pending", error: null });
      }
    } else if (["allowed", "denied"].includes(approval.status)) {
      this.set(id, { state: "resolved", decision: approval.decision });
    } else if (["expired", "unavailable", "delivery_unknown"].includes(approval.status)) {
      this.set(id, { state: "unavailable", error: approval.unavailableReason || "这次审批已不可操作，请查看 Codex 当前状态" });
    }
  }
}
