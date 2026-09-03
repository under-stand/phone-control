const DAY_MS = 86_400_000;

function item(bucket, priority, label, reason, changedAt, { actionRequired = false, action = null, tone = "neutral" } = {}) {
  return { bucket, priority, label, reason, changedAt: changedAt || null, actionRequired, action, tone };
}

export function deriveTaskInbox(session, commandState = null, now = Date.now()) {
  const pending = session?.pendingApproval;
  if (pending?.kind === "question") {
    const actionable = Boolean(pending.canRespond && session.control?.canAnswer);
    return item(actionable ? "needs_answer" : "needs_review", actionable ? 100 : 82, actionable ? "需要回答" : "问题需在电脑处理", pending.reason || session.statusReason || "Codex 正在等待回答", pending.at || session.updatedAt, {
      actionRequired: actionable,
      action: actionable ? "answer" : "inspect",
      tone: "attention",
    });
  }
  if (pending?.kind === "permission") {
    const actionable = Boolean(pending.canRespond && session.control?.canApprove);
    return item(actionable ? "needs_approval" : "needs_review", actionable ? 95 : 82, actionable ? "需要审批" : "审批需在电脑处理", pending.reason || session.statusReason || "Codex 正在等待审批", pending.at || session.updatedAt, {
      actionRequired: actionable,
      action: actionable ? "approve" : "inspect",
      tone: "attention",
    });
  }
  if (commandState?.state === "needs_review") {
    return item("needs_review", 90, "确认是否送达", commandState.detail, commandState.changedAt || session?.updatedAt, {
      actionRequired: true,
      action: "review_delivery",
      tone: "attention",
    });
  }
  if (commandState?.state === "failed") {
    const age = now - Date.parse(commandState.changedAt || session?.updatedAt);
    const recent = Number.isFinite(age) && age <= 7 * DAY_MS;
    return item("failed", recent ? 88 : 30, "执行失败", commandState.detail, commandState.changedAt || session?.updatedAt, {
      actionRequired: recent,
      action: "inspect_error",
      tone: "danger",
    });
  }
  if (session?.status === "error") {
    const age = now - Date.parse(session.updatedAt);
    return item("failed", Number.isFinite(age) && age <= 7 * DAY_MS ? 86 : 30, "任务出错", session.statusReason || "打开任务查看错误", session.updatedAt, {
      actionRequired: Number.isFinite(age) && age <= 7 * DAY_MS,
      action: "inspect_error",
      tone: "danger",
    });
  }
  if (["queued", "blocked", "sending", "accepted"].includes(commandState?.state)) {
    return item("queued", 64, commandState.label, commandState.detail, commandState.changedAt || session?.updatedAt, { tone: "progress" });
  }
  if (commandState?.state === "waiting_user") {
    return item("needs_review", 80, commandState.label, commandState.detail, commandState.changedAt || session?.updatedAt, {
      actionRequired: Boolean(commandState.actionRequired),
      action: "inspect",
      tone: "attention",
    });
  }
  if (session?.status === "working" || commandState?.state === "running") {
    return item("running", 50, "执行中", session.statusReason || commandState?.detail || "Codex 正在处理", session.updatedAt, { tone: "progress" });
  }
  if (["idle", "completed"].includes(session?.status) || commandState?.state === "completed") {
    return item("completed", 20, "本轮完成", session.statusReason || "可以查看本轮结果", session.lastCompletionAt || session.completedAt || session.updatedAt, { tone: "success" });
  }
  if (session?.status === "aborted") {
    return item("stopped", 15, "已停止", session.statusReason || "本轮已停止", session.lastCompletionAt || session.updatedAt);
  }
  return item("quiet", 0, "等待状态", session?.statusReason || "暂无需要处理的事项", session?.updatedAt);
}

export function inboxNeedsAttention(inbox) {
  return Boolean(inbox?.actionRequired || ["needs_answer", "needs_approval", "needs_review"].includes(inbox?.bucket));
}
