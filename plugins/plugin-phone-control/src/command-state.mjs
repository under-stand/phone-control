const TERMINAL_STATES = new Set(["completed", "failed", "needs_review", "canceled", "expired"]);

function timestamp(command) {
  for (const value of [command.updatedAt, command.deliveredAt, command.sentAt, command.createdAt]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function mergeCommands(queuedCommands, liveCommands) {
  const commands = new Map();
  // A queued record owns the retry/review decision. The live bridge still
  // enriches it with a turn id, but must not overwrite needs_review/failed
  // with its earlier delivered state for the same command id.
  for (const command of [...liveCommands, ...queuedCommands]) {
    if (!command?.id) continue;
    const normalized = command.command && typeof command.command === "object"
      ? { ...command.command, ...command }
      : command;
    commands.set(command.id, { ...(commands.get(command.id) || {}), ...normalized });
  }
  return [...commands.values()].sort((left, right) => timestamp(right) - timestamp(left));
}

function isSameTurn(session, command) {
  if (!command.turnId) return false;
  return command.turnId === session.turnId
    || command.turnId === session.control?.expectedTurnId
    || command.turnId === session.lastCompletedTurnId;
}

function stateCopy(command, state, label, detail, extra = {}) {
  return {
    id: command.id,
    state,
    rawStatus: command.status || null,
    action: command.action || command.actionHint || null,
    turnId: command.turnId || null,
    label,
    detail,
    changedAt: command.updatedAt || command.deliveredAt || command.sentAt || command.createdAt || null,
    terminal: TERMINAL_STATES.has(state),
    ...extra,
  };
}

function projectCommand(session, command) {
  const rawStatus = command.status || "unknown";
  if (rawStatus === "queued") {
    return stateCopy(command, "queued", "已排队", "等待连接和会话条件满足后发送");
  }
  if (rawStatus === "waiting") {
    return stateCopy(command, "blocked", "等待发送", command.waitingFor === "turn"
      ? "等待当前轮次结束"
      : command.waitingFor === "desktop"
        ? "等待电脑端释放会话"
        : command.waitingFor === "question"
          ? "等待当前问题处理"
          : command.waitingFor === "approval"
            ? "等待当前审批处理"
            : "等待 Codex 控制连接恢复");
  }
  if (rawStatus === "sending") {
    return stateCopy(command, "sending", "正在发送", "正在等待 Codex 确认接收");
  }
  if (rawStatus === "needs_review" || rawStatus === "delivery_unknown") {
    return stateCopy(command, "needs_review", "需要确认", command.lastError || "无法确认指令是否送达；请先查看会话再决定是否重试");
  }
  if (rawStatus === "failed" || rawStatus === "rejected") {
    return stateCopy(command, "failed", "发送失败", command.lastError || "Codex 没有接受这条指令");
  }
  if (rawStatus === "canceled") {
    return stateCopy(command, "canceled", "已取消", "这条排队指令不会再发送");
  }
  if (rawStatus === "expired") {
    return stateCopy(command, "expired", "已过期", "指令在送达前已过期");
  }
  if (rawStatus === "delivered") {
    const completed = Boolean(command.phoneOwnershipEndedAt)
      || (command.turnId && command.turnId === session.lastCompletedTurnId)
      || (isSameTurn(session, command) && ["idle", "completed", "error", "aborted"].includes(session.status));
    if (completed) {
      const failed = session.status === "error";
      return stateCopy(command, failed ? "failed" : "completed", failed ? "执行失败" : session.status === "aborted" ? "执行已停止" : "本轮完成", failed
        ? session.statusReason || "Codex 执行这条指令时遇到错误"
        : session.status === "aborted" ? "Codex 已停止这次执行" : "Codex 已完成这条手机指令", { outcome: session.status });
    }
    if (session.pendingApproval && (!command.turnId || isSameTurn(session, command))) {
      const question = session.pendingApproval.kind === "question";
      return stateCopy(command, "waiting_user", question ? "等待你回答" : "等待你审批", session.pendingApproval.reason || session.statusReason || "Codex 正在等待你的处理", {
        actionRequired: Boolean(session.pendingApproval.canRespond),
      });
    }
    if (["working", "waiting"].includes(session.status) && (!command.turnId || isSameTurn(session, command))) {
      return stateCopy(command, "running", "Codex 执行中", session.statusReason || "指令已送达，Codex 正在处理");
    }
    return stateCopy(command, "accepted", "Codex 已接收", "指令已可靠送达，正在等待运行状态同步");
  }
  return stateCopy(command, "unknown", "状态待确认", "正在等待更多指令状态");
}

export function deriveCommandState(session, { queuedCommands = [], liveCommands = [] } = {}) {
  const commands = mergeCommands(
    Array.isArray(queuedCommands) ? queuedCommands : [],
    Array.isArray(liveCommands) ? liveCommands : [],
  );
  if (!commands.length) return null;
  return projectCommand(session || {}, commands[0]);
}

export function isCommandInFlight(commandState) {
  return ["queued", "blocked", "sending", "accepted", "running", "waiting_user"].includes(commandState?.state);
}
