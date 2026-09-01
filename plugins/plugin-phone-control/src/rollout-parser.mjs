import path from "node:path";
import { asString, clampMessageText, clampText, extractContentText, inferSurface, isCodexInjectedUserMessage, isoTime, safeJsonParse, stableId } from "./utils.mjs";

export function createRolloutContext(filePath) {
  const filename = path.basename(filePath);
  const uuid = filename.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1] || null;
  return {
    filePath,
    sessionId: uuid,
    cwd: null,
    surface: "Unknown",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    permissionMode: null,
    approvalPolicy: null,
    parentThreadId: null,
    threadSource: null,
    agentRole: null,
    activeTool: null,
  };
}

function baseEvent(record, context, kind, salt = "") {
  const payload = record.payload || {};
  const messageMetadata = payload.internal_chat_message_metadata_passthrough || {};
  const at = isoTime(record.timestamp ?? payload.timestamp ?? Date.now());
  return {
    eventId: stableId(context.filePath, at, record.type, payload.type, payload.id, salt),
    source: "rollout",
    provider: "codex",
    sessionId: context.sessionId,
    turnId: asString(payload.turn_id ?? payload.turnId ?? messageMetadata.turn_id ?? messageMetadata.turnId),
    at,
    kind,
    cwd: context.cwd,
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    serviceTier: context.serviceTier,
    permissionMode: context.permissionMode,
    approvalPolicy: context.approvalPolicy,
    surface: context.surface,
    transcriptPath: context.filePath,
    parentThreadId: context.parentThreadId,
    threadSource: context.threadSource,
    agentRole: context.agentRole,
  };
}

function permissionModeFromSettings(settings) {
  if (!settings || typeof settings !== "object") return null;
  const activeId = asString(
    settings.active_permission_profile?.id
      ?? settings.activePermissionProfile?.id
      ?? settings.permission_profile?.id
      ?? settings.permissionProfile?.id,
  )?.toLowerCase() || "";
  const sandbox = asString(
    settings.sandbox_mode
      ?? settings.sandboxMode
      ?? settings.sandbox_policy?.type
      ?? settings.sandboxPolicy?.type,
  )?.toLowerCase() || "";
  const profileType = asString(
    settings.permission_profile?.type
      ?? settings.permissionProfile?.type,
  )?.toLowerCase() || "";
  const value = `${activeId} ${sandbox} ${profileType}`;
  if (value.includes("read-only") || value.includes("readonly")) return "read-only";
  if (value.includes("danger-full-access") || value.includes("dangerfullaccess")) return "danger-full-access";
  if (value.includes("workspace-write") || value.includes("workspacewrite")) return "workspace-write";
  return null;
}

function rolloutAgentRole(source) {
  if (!source || typeof source !== "object") return null;
  const subagent = source.subagent;
  if (!subagent || typeof subagent !== "object") return null;
  return asString(subagent.other ?? subagent.role ?? subagent.type ?? subagent.name);
}

function messagePhase(value) {
  return ["commentary", "final_answer"].includes(value) ? value : null;
}

function messageEvent(record, context, role, text, phase = null) {
  const event = baseEvent(record, context, role === "user" ? "user_prompt" : "assistant_message", role);
  event.message = { role, text: clampMessageText(text) };
  if (role === "assistant") event.phase = messagePhase(phase);
  return event;
}

export function normalizeRolloutRecord(record, context) {
  if (!record || typeof record !== "object") return [];
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};

  if (record.type === "session_meta") {
    context.sessionId = asString(payload.id ?? payload.session_id) || context.sessionId;
    context.cwd = asString(payload.cwd) || context.cwd;
    context.surface = inferSurface(payload.source ?? payload.originator) || context.surface;
    context.model = asString(payload.model) || context.model;
    const explicitParent = asString(payload.parent_thread_id ?? payload.parentThreadId);
    const legacyParent = payload.id && payload.session_id && payload.id !== payload.session_id
      ? asString(payload.session_id)
      : null;
    context.parentThreadId = explicitParent || legacyParent;
    context.threadSource = asString(payload.thread_source ?? payload.threadSource)
      || (payload.source && typeof payload.source === "object" && payload.source.subagent ? "subagent" : null);
    context.agentRole = rolloutAgentRole(payload.source);
    return [baseEvent(record, context, "session_metadata", "metadata")];
  }
  if (record.type === "turn_context") {
    context.cwd = asString(payload.cwd) || context.cwd;
    context.model = asString(payload.model) || context.model;
    context.reasoningEffort = asString(
      payload.effort
      ?? payload.reasoning_effort
      ?? payload.model_reasoning_effort
      ?? payload.collaboration_mode?.settings?.reasoning_effort,
    ) || context.reasoningEffort;
    context.serviceTier = asString(payload.service_tier ?? payload.serviceTier) || context.serviceTier;
    context.permissionMode = permissionModeFromSettings(payload) || context.permissionMode;
    context.approvalPolicy = asString(payload.approval_policy ?? payload.approvalPolicy) || context.approvalPolicy;
    return [];
  }
  if (!context.sessionId) return [];

  if (record.type === "event_msg" && payload.type === "thread_settings_applied") {
    const settings = payload.thread_settings || payload.threadSettings || {};
    context.cwd = asString(settings.cwd) || context.cwd;
    context.model = asString(settings.model) || context.model;
    context.reasoningEffort = asString(settings.reasoning_effort ?? settings.reasoningEffort) || context.reasoningEffort;
    context.serviceTier = asString(settings.service_tier ?? settings.serviceTier) || context.serviceTier;
    context.permissionMode = permissionModeFromSettings(settings) || context.permissionMode;
    context.approvalPolicy = asString(settings.approval_policy ?? settings.approvalPolicy) || context.approvalPolicy;
    return [];
  }

  if (record.type === "event_msg") {
    switch (payload.type) {
      case "task_started": return [baseEvent(record, context, "turn_start")];
      case "task_complete": {
        const events = [];
        const finalText = clampMessageText(payload.last_agent_message ?? payload.message);
        if (finalText) events.push(messageEvent(record, context, "assistant", finalText, "final_answer"));
        events.push(baseEvent(record, context, "turn_complete", "complete"));
        return events;
      }
      case "user_message": {
        const text = clampMessageText(payload.message);
        return text && !isCodexInjectedUserMessage(text) ? [messageEvent(record, context, "user", text)] : [];
      }
      case "agent_message": {
        const text = clampMessageText(payload.message);
        return text ? [messageEvent(record, context, "assistant", text, payload.phase)] : [];
      }
      case "turn_aborted": return [baseEvent(record, context, "aborted")];
      case "error": {
        const event = baseEvent(record, context, "error");
        event.message = { role: "system", text: clampText(payload.message ?? payload.error, 1_000) || "Codex error" };
        return [event];
      }
      default: return [];
    }
  }

  if (record.type !== "response_item") return [];
  const itemType = payload.type;
  if (itemType === "message") {
    const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : null;
    const text = extractContentText(payload.content);
    if (role === "user" && isCodexInjectedUserMessage(text)) return [];
    return role && text ? [messageEvent(record, context, role, text, payload.phase)] : [];
  }
  if (["function_call", "custom_tool_call", "tool_call"].includes(itemType)) {
    const name = asString(payload.name) || "tool";
    let args = payload.arguments ?? payload.input ?? {};
    if (typeof args === "string") args = safeJsonParse(args, { input: args });
    const summary = clampText(args?.command ?? args?.path ?? args?.prompt ?? args?.question ?? args?.input, 240);
    context.activeTool = { name, summary };
    const event = baseEvent(record, context, name === "request_user_input" ? "question" : "tool_start", payload.call_id ?? name);
    event.tool = context.activeTool;
    return [event];
  }
  if (["function_call_output", "custom_tool_call_output", "tool_call_output"].includes(itemType)) {
    const event = baseEvent(record, context, "tool_end", payload.call_id ?? payload.id ?? "output");
    event.tool = context.activeTool || { name: "tool", summary: null };
    context.activeTool = null;
    return [event];
  }
  return [];
}
