import { randomUUID } from "node:crypto";
import { asString, clampText, inferSurface, isoTime, safeJsonParse } from "./utils.mjs";

function toolDetails(input) {
  const name = asString(input.tool_name ?? input.toolName ?? input.name) || "tool";
  let args = input.tool_input ?? input.toolInput ?? input.input ?? input.arguments ?? {};
  if (typeof args === "string") args = safeJsonParse(args, { input: args });
  const command = Array.isArray(args?.command) ? args.command.join(" ") : args?.command;
  const summary = clampText(
    command ?? args?.path ?? args?.file_path ?? args?.prompt ?? args?.question ?? args?.input,
    240,
  );
  return { name, summary };
}

function approvalDetails(input) {
  let args = input.tool_input ?? input.toolInput ?? input.input ?? input.arguments ?? {};
  if (typeof args === "string") args = safeJsonParse(args, { input: args });
  const rawCommand = Array.isArray(args?.command) ? args.command.join(" ") : args?.command;
  return {
    command: clampText(rawCommand, 2_000),
    path: clampText(args?.path ?? args?.file_path, 1_000),
    sandboxPermissions: Array.isArray(args?.sandbox_permissions)
      ? args.sandbox_permissions.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 20)
      : null,
  };
}

export function normalizeHookInput(input, now = Date.now()) {
  if (!input || typeof input !== "object") return null;
  const eventName = asString(input.hook_event_name ?? input.hookEventName);
  const sessionId = asString(input.session_id ?? input.sessionId);
  if (!eventName || !sessionId) return null;

  const tool = toolDetails(input);
  let kind;
  switch (eventName) {
    case "SessionStart": kind = "session_start"; break;
    case "SessionEnd": kind = "session_end"; break;
    case "UserPromptSubmit": kind = "user_prompt"; break;
    case "PreToolUse": kind = tool.name === "request_user_input" ? "question" : "tool_start"; break;
    case "PostToolUse": kind = "tool_end"; break;
    case "PermissionRequest": kind = "permission_request"; break;
    case "Stop": kind = "turn_complete"; break;
    case "SubagentStart": kind = "subagent_start"; break;
    case "SubagentStop": kind = "subagent_stop"; break;
    case "PreCompact":
    case "PostCompact": kind = "working"; break;
    default: kind = "activity";
  }

  const prompt = clampText(input.prompt ?? input.user_prompt ?? input.message, 1_000);
  const event = {
    eventId: randomUUID(),
    source: "hook",
    provider: "codex",
    sessionId,
    turnId: asString(input.turn_id ?? input.turnId),
    at: isoTime(input.timestamp ?? now),
    kind,
    hookEvent: eventName,
    cwd: asString(input.cwd),
    model: asString(input.model),
    reasoningEffort: asString(input.reasoning_effort ?? input.model_reasoning_effort ?? input.effort),
    surface: inferSurface(input.source ?? input.originator ?? input.client),
    transcriptPath: asString(input.transcript_path ?? input.transcriptPath),
    permissionMode: asString(input.permission_mode ?? input.permissionMode),
  };

  if (["tool_start", "tool_end", "permission_request", "question"].includes(kind)) {
    event.tool = tool;
  }
  if (prompt) event.message = { role: "user", text: prompt };
  if (kind === "permission_request") {
    event.reason = clampText(input.reason ?? tool.summary ?? `Approval requested for ${tool.name}`, 300);
    event.approvalDetails = approvalDetails(input);
  }
  return event;
}
