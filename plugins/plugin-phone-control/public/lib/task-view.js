const ATTENTION_BUCKETS = new Set(["needs_answer", "needs_approval", "needs_review"]);

export function taskNeedsAttention(session) {
  if (session?.inbox) return Boolean(session.inbox.actionRequired || ATTENTION_BUCKETS.has(session.inbox.bucket));
  return session?.status === "waiting";
}

export function compareTaskUrgency(left, right) {
  const priority = Number(right?.inbox?.priority || 0) - Number(left?.inbox?.priority || 0);
  if (priority) return priority;
  return String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || ""));
}

export function inboxOverview(sessions) {
  const actionable = sessions.filter((session) => session?.inbox?.actionRequired);
  const review = sessions.filter(taskNeedsAttention);
  const running = sessions.filter((session) => session?.inbox?.bucket === "running");
  const queued = sessions.filter((session) => session?.inbox?.bucket === "queued");
  return {
    actionable: actionable.length,
    attention: review.length,
    running: running.length,
    queued: queued.length,
    top: [...review].sort(compareTaskUrgency)[0] || null,
  };
}

export function commandStateView(commandState) {
  if (!commandState) return null;
  const tones = {
    queued: "progress",
    blocked: "progress",
    sending: "progress",
    accepted: "progress",
    running: "progress",
    waiting_user: "attention",
    completed: "success",
    failed: "danger",
    needs_review: "attention",
    canceled: "neutral",
    expired: "neutral",
    unknown: "neutral",
  };
  return { ...commandState, tone: tones[commandState.state] || "neutral" };
}

export function resultView(result) {
  if (!result) return null;
  const testStatus = result.tests?.status === "failed" ? "验证遇到问题"
    : result.tests?.status === "observed" ? "已运行验证"
      : "未捕获验证命令";
  return {
    ...result,
    title: result.status === "failed" ? "本轮未完成" : result.status === "stopped" ? "本轮已停止" : "本轮结果",
    tone: result.status === "failed" ? "danger" : result.status === "stopped" ? "neutral" : "success",
    testStatus,
  };
}
