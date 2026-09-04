import { EventEmitter } from "node:events";
import { appendFile, chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clampText, inferSurface, isCodexInjectedUserMessage, isoTime } from "./utils.mjs";
import { buildTaskSearchDocument, buildTaskTitleContext, isMeaningfulTaskPrompt, searchTaskDocuments } from "./task-semantics.mjs";
import { deriveTaskResult, deriveTaskResults, detailTaskResult, mergeTaskResults, summarizeTaskResult } from "./task-result.mjs";

const MAX_SESSION_EVENTS = 240;
const TERMINAL_TASK_EVENT_KINDS = new Set(["turn_complete", "session_end", "error", "aborted"]);
const MAX_SEEN_EVENTS = 8_000;
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const MESSAGE_DUPLICATE_WINDOW_MS = 1_500;
const LEGACY_MESSAGE_TEXT_LENGTH = 2_000;
const PERSIST_BATCH_DELAY_MS = 75;
const PERSIST_BATCH_MAX = 64;
const SAFELY_RESUMABLE_STATUSES = new Set(["idle", "completed", "error", "aborted"]);
const LOW_VALUE_EVENT_KINDS = new Set(["tool_end", "working", "activity", "subagent_start", "subagent_stop"]);
const SAME_TURN_POST_COMPLETION_NOISE = new Set(["working", "activity", "tool_start", "tool_end", "assistant_message", "subagent_start", "subagent_stop", "phone_interrupt_sent"]);
const OUT_OF_ORDER_SENSITIVE_KINDS = new Set([...SAME_TURN_POST_COMPLETION_NOISE, "session_start", "user_prompt", "turn_start"]);
const MESSAGE_EVENT_KINDS = new Set(["user_prompt", "assistant_message"]);

function semanticMessageKey(event) {
  if (event?.source !== "rollout" || !MESSAGE_EVENT_KINDS.has(event.kind) || !event.message?.text) return null;
  return [event.sessionId, event.kind, event.message.role || "", event.message.text].join("\u0000");
}

function separatesAssistantMessages(candidate, event) {
  if (!["user_prompt", "turn_start", "turn_complete", "session_end", "error", "aborted"].includes(candidate.kind)) return false;
  return !(event.turnId && candidate.turnId === event.turnId);
}

function findSemanticMessageDuplicate(events, event) {
  const key = semanticMessageKey(event);
  if (!key) return null;
  const at = Date.parse(event.at);
  if (!Number.isFinite(at)) return null;
  for (let index = events.length - 1; index >= Math.max(0, events.length - 24); index -= 1) {
    const previous = events[index];
    if (event.kind === "assistant_message" && separatesAssistantMessages(previous, event)) break;
    if (previous.source !== "rollout" || previous.kind !== event.kind || previous.message?.role !== event.message.role || previous.message?.text !== event.message.text) continue;
    const previousAt = Date.parse(previous.at);
    if (Number.isFinite(previousAt) && Math.abs(at - previousAt) <= MESSAGE_DUPLICATE_WINDOW_MS) return previous;
    // A current rollout writes the final assistant text first as a response_item
    // and later repeats it in task_complete. The latter has the useful turn id,
    // but can arrive well beyond the short event/response-item dedupe window.
    // Within one unbroken turn, an identical assistant row is still one message.
    if (event.kind === "assistant_message"
      && (!previous.turnId || !event.turnId || previous.turnId === event.turnId)) return previous;
  }
  return null;
}

function enrichDuplicateMessage(session, event) {
  if (!MESSAGE_EVENT_KINDS.has(event.kind) || !event.eventId || !event.message?.text) return false;
  const existing = session?.events.find((candidate) => candidate.eventId === event.eventId && candidate.kind === event.kind);
  if (!existing?.message?.text || existing.message.text === event.message.text) return false;
  const oldShape = existing.message.text.replace(/\s+/g, " ").trim();
  const newShape = event.message.text.replace(/\s+/g, " ").trim();
  const oldBreaks = (existing.message.text.match(/\n/g) || []).length;
  const newBreaks = (event.message.text.match(/\n/g) || []).length;
  const restoresFormatting = oldShape === newShape && newBreaks > oldBreaks;
  const restoresLegacyTruncation = existing.message.text.length === LEGACY_MESSAGE_TEXT_LENGTH
    && existing.message.text.endsWith("…")
    && event.message.text.length > existing.message.text.length
    && event.message.text.startsWith(existing.message.text.slice(0, -1));
  if (!restoresFormatting && !restoresLegacyTruncation) return false;
  existing.message = {
    role: event.message.role || existing.message.role || "system",
    text: event.message.text,
  };
  return true;
}

function enrichDuplicateProvenance(session, event) {
  if (!event?.eventId || (!event.turnId && !event.model && !event.reasoningEffort && !event.serviceTier && !event.phase)) return false;
  const existing = session?.events.find((candidate) => candidate.eventId === event.eventId);
  if (!existing) return false;
  let changed = false;
  if (event.turnId && !existing.turnId) {
    existing.turnId = event.turnId;
    changed = true;
  }
  if (event.model && !existing.model) {
    existing.model = event.model;
    changed = true;
  }
  if (event.reasoningEffort && !existing.reasoningEffort) {
    existing.reasoningEffort = event.reasoningEffort;
    changed = true;
  }
  if (event.serviceTier && !existing.serviceTier) {
    existing.serviceTier = event.serviceTier;
    changed = true;
  }
  if (event.phase && !existing.phase) {
    existing.phase = event.phase;
    changed = true;
  }
  if (event.model && !session.model) {
    session.model = event.model;
    changed = true;
  }
  if (event.reasoningEffort && !session.reasoningEffort) {
    session.reasoningEffort = event.reasoningEffort;
    changed = true;
  }
  if (event.serviceTier && !session.serviceTier) {
    session.serviceTier = event.serviceTier;
    changed = true;
  }
  return changed;
}

function sessionTaskKind(session) {
  const sessionId = String(session.id || "");
  if (session.testEvidence || sessionId.startsWith("phone-control-smoke-") || sessionId.startsWith("hook-") || String(session.cwd || "").endsWith("/smoke-test")) return "test";
  if (session.parentThreadId || session.threadSource === "subagent" || session.agentRole || session.model === "codex-auto-review") return "internal";
  const hasUserIntent = Boolean(session.lastUserMessage)
    || (session.events || []).some((event) => ["user_prompt", "phone_input_sent"].includes(event.kind));
  const hasActionableInteraction = Boolean(session.pendingApproval)
    || Boolean(session.control?.canApprove)
    || Boolean(session.control?.canAnswer);
  if (!hasUserIntent && !hasActionableInteraction) return "diagnostic";
  return "user";
}

function isInjectedRolloutPrompt(event) {
  return event?.source === "rollout"
    && event.kind === "user_prompt"
    && isCodexInjectedUserMessage(event.message?.text);
}

function publicEvent(event) {
  const copy = {
    eventId: event.eventId,
    at: event.at,
    kind: event.kind,
  };
  // Conversation rendering needs just enough provenance to merge the same
  // prompt observed by both the hook and rollout streams. Keep the public
  // shape deliberately narrow instead of exposing the internal source field.
  if (event.turnId) copy.turnId = event.turnId;
  if (event.model) copy.model = event.model;
  if (event.reasoningEffort) copy.reasoningEffort = event.reasoningEffort;
  if (event.serviceTier) copy.serviceTier = event.serviceTier;
  if (event.phase) copy.phase = event.phase;
  if (event.source === "hook" || event.source === "rollout") copy.origin = event.source;
  if (event.tool?.name) copy.tool = { name: event.tool.name };
  if (event.kind === "phone_input_sent" && event.action) copy.action = event.action;
  if (event.message?.text) {
    copy.message = {
      role: event.message.role || "system",
      text: event.message.text,
    };
  }
  return copy;
}

function newSession(event) {
  return {
    id: event.sessionId,
    provider: event.provider || "codex",
    surface: event.surface || "Unknown",
    cwd: event.cwd || null,
    model: event.model || null,
    reasoningEffort: event.reasoningEffort || null,
    serviceTier: event.serviceTier || null,
    status: "unknown",
    statusReason: "Discovered from local Codex state",
    currentTool: null,
    pendingApproval: null,
    lastMessage: null,
    lastUserMessage: null,
    firstUserMessage: null,
    taskGoalMessage: null,
    lastAssistantMessage: null,
    turnId: event.turnId || null,
    transcriptPath: event.transcriptPath || null,
    parentThreadId: event.parentThreadId || null,
    branchOf: event.branchOf || null,
    threadSource: event.threadSource || null,
    agentRole: event.agentRole || null,
    permissionMode: event.permissionMode || null,
    approvalPolicy: event.approvalPolicy || null,
    machineName: event.machineName || null,
    startedAt: event.at,
    updatedAt: event.at,
    completedAt: null,
    lastCompletedTurnId: null,
    lastCompletionEventId: null,
    lastCompletionAt: null,
    // Result cards outlive the rolling event window. They are reconstructed
    // from the append-only event log during restore and never exposed as an
    // internal field in the public session payload.
    taskResults: [],
    testEvidence: String(event.source || "").startsWith("phone-control-smoke"),
    control: {
      mode: "observe",
      canSteer: false,
      canSend: false,
      canInterrupt: false,
      canHandoff: false,
      canReclaim: false,
      handedOff: false,
      canApprove: false,
      canAnswer: false,
      live: false,
      action: null,
      expectedTurnId: null,
      reason: "No verified live app-server endpoint is attached",
    },
    events: [],
    eventsDiscarded: 0,
  };
}

function trimSessionEvents(session) {
  while (session.events.length > MAX_SESSION_EVENTS) {
    // Prefer dropping low-value activity rows. Keep tool_start rows from the
    // active turn until its terminal snapshot is captured; if that turn itself
    // exceeds the cap, evict its oldest tool rows before any user/assistant
    // message so the conversation skeleton remains renderable.
    const activeTurnId = session.turnId || null;
    let index = session.events.findIndex((event) => LOW_VALUE_EVENT_KINDS.has(event.kind));
    if (index < 0) index = session.events.findIndex((event) => event.kind === "tool_start" && (!activeTurnId || event.turnId !== activeTurnId));
    if (index < 0) index = session.events.findIndex((event) => ["turn_complete", "session_end", "error", "aborted"].includes(event.kind) && (!activeTurnId || event.turnId !== activeTurnId));
    if (index < 0) index = session.events.findIndex((event) => event.kind === "tool_start");
    if (index < 0) index = session.events.findIndex((event) => !["user_prompt", "assistant_message", "turn_complete", "session_end", "error", "aborted"].includes(event.kind));
    if (index < 0) index = 0;
    session.events.splice(index, 1);
    session.eventsDiscarded = (session.eventsDiscarded || 0) + 1;
  }
}

function eventLabel(event) {
  if (event.kind === "tool_start") return `Running ${event.tool?.name || "tool"}`;
  if (event.kind === "permission_request") return event.reason || "Waiting for approval";
  if (event.kind === "question") return "Waiting for your answer";
  if (event.kind === "question_answered") return "Answer delivered from phone";
  if (event.kind === "question_unavailable") return "Phone answer is no longer available";
  if (event.kind === "phone_input_sent") return event.action === "steer" ? "Phone instruction added to the active turn" : "Phone instruction started a new turn";
  if (event.kind === "phone_interrupt_sent") return "Phone requested that Codex stop the active turn";
  if (event.kind === "turn_complete") return "Turn completed";
  if (event.kind === "session_end") return "Session ended";
  if (event.kind === "error") return event.message?.text || "Task failed";
  if (event.kind === "aborted") return "Turn aborted";
  if (event.kind === "user_prompt") return "Processing a new prompt";
  if (event.kind === "assistant_message") return "Agent responded";
  if (event.kind === "subagent_start") return "Subagent started";
  if (event.kind === "subagent_stop") return "Subagent finished";
  return "Agent activity";
}

function applyEvent(session, event) {
  if (String(event.source || "").startsWith("phone-control-smoke")) session.testEvidence = true;
  const eventAt = Date.parse(event.at);
  const sessionAt = Date.parse(session.updatedAt);
  const staleState = event.kind !== "session_metadata"
    && OUT_OF_ORDER_SENSITIVE_KINDS.has(event.kind)
    && Number.isFinite(eventAt)
    && Number.isFinite(sessionAt)
    && eventAt < sessionAt;
  const finalizedSameTurn = Boolean(
    session.lastCompletedTurnId
    && event.turnId
    && session.lastCompletedTurnId === event.turnId
    && SAME_TURN_POST_COMPLETION_NOISE.has(event.kind),
  );
  // Metadata is replayed when an existing rollout is rediscovered. It enriches
  // classification, but must not make an old session look newly started (or
  // move its real last-activity time back to the rollout header timestamp).
  if (event.kind !== "session_metadata" && !staleState
    && (!Number.isFinite(sessionAt) || !Number.isFinite(eventAt) || eventAt >= sessionAt)) {
    session.updatedAt = event.at || isoTime();
  }
  session.cwd = event.cwd || session.cwd;
  session.model = event.model || session.model;
  session.reasoningEffort = event.reasoningEffort || session.reasoningEffort;
  session.serviceTier = event.serviceTier || session.serviceTier;
  if (!staleState) session.turnId = event.turnId || session.turnId;
  session.transcriptPath = event.transcriptPath || session.transcriptPath;
  session.permissionMode = event.permissionMode || session.permissionMode;
  session.approvalPolicy = event.approvalPolicy || session.approvalPolicy;
  if (event.parentThreadId) session.parentThreadId = event.parentThreadId;
  if (event.branchOf) session.branchOf = event.branchOf;
  if (event.threadSource) session.threadSource = event.threadSource;
  if (event.agentRole) session.agentRole = event.agentRole;
  if (event.surface && event.surface !== "Unknown") session.surface = event.surface;
  if (session.surface === "Unknown" && event.origin) session.surface = inferSurface(event.origin);
  if (event.message?.text) {
    const newerThanLastMessage = !session.lastMessage?.at || Date.parse(event.at) >= Date.parse(session.lastMessage.at);
    if (newerThanLastMessage) {
      session.lastMessage = {
        role: event.message.role || "system",
        text: clampText(event.message.text, 1_000),
        at: event.at,
      };
    }
    if (event.message.role === "user") {
      const userMessage = {
        eventId: event.eventId || null,
        turnId: event.turnId || null,
        text: clampText(event.message.text, 500),
        at: event.at,
      };
      if (!session.firstUserMessage || Date.parse(event.at) < Date.parse(session.firstUserMessage.at)) {
        session.firstUserMessage = userMessage;
      }
      if (!session.taskGoalMessage && isMeaningfulTaskPrompt(event.message.text)) {
        session.taskGoalMessage = { ...userMessage, text: clampText(event.message.text, 1_200) };
      }
      if (!session.lastUserMessage?.at || Date.parse(event.at) >= Date.parse(session.lastUserMessage.at)) {
        session.lastUserMessage = userMessage;
      }
    } else if (event.message.role === "assistant") {
      if (!session.lastAssistantMessage?.at || Date.parse(event.at) >= Date.parse(session.lastAssistantMessage.at)) {
        session.lastAssistantMessage = {
          eventId: event.eventId || null,
          turnId: event.turnId || null,
          text: clampText(event.message.text, 1_200),
          at: event.at,
        };
      }
    }
  }
  if (staleState || finalizedSameTurn) return;

  switch (event.kind) {
    case "session_metadata":
      break;
    case "session_start":
    case "user_prompt":
    case "turn_start":
    case "working":
    case "subagent_start":
    case "subagent_stop":
      session.status = "working";
      session.statusReason = eventLabel(event);
      session.pendingApproval = null;
      session.completedAt = null;
      break;
    case "phone_input_sent":
      session.status = "working";
      session.statusReason = event.action === "steer"
        ? "手机指令已追加到当前 turn"
        : "手机指令已送达，Codex 已开始新 turn";
      session.pendingApproval = null;
      session.completedAt = null;
      break;
    case "phone_interrupt_sent":
      session.status = "working";
      session.statusReason = "手机已请求停止当前 turn";
      session.pendingApproval = null;
      session.currentTool = null;
      session.completedAt = null;
      break;
    case "tool_start":
      session.status = "working";
      session.currentTool = event.tool || { name: "tool", summary: null };
      session.statusReason = eventLabel(event);
      session.pendingApproval = null;
      break;
    case "tool_end":
      session.status = "working";
      session.currentTool = null;
      session.statusReason = "Tool finished; agent is continuing";
      break;
    case "permission_request":
      // A PermissionRequest without a live single-use challenge is only an
      // observation of Codex's own approval path. It must not create a false
      // mobile action or move the session into a waiting state. This also
      // makes delayed offline spool delivery harmless after Codex continues.
      if (!event.approval?.id) {
        session.status = "working";
        session.statusReason = "Codex 正在处理本次操作权限";
        session.pendingApproval = null;
        session.control.canApprove = false;
        break;
      }
      // Fall through for a challenge that Phone Control actually owns.
    case "question": {
      session.status = "waiting";
      session.statusReason = eventLabel(event);
      const isQuestion = event.kind === "question";
      session.pendingApproval = {
        id: isQuestion ? event.interaction?.id || null : event.approval?.id || null,
        kind: isQuestion ? "question" : "permission",
        tool: event.tool || null,
        reason: event.reason || event.interaction?.questions?.[0]?.question || eventLabel(event),
        at: event.at,
        expiresAt: isQuestion ? event.interaction?.expiresAt || null : event.approval?.expiresAt || null,
        canRespond: isQuestion ? Boolean(event.interaction?.canRespond) : Boolean(event.approval?.id),
        details: event.approvalDetails || null,
        turnId: event.interaction?.turnId || event.turnId || null,
        itemId: event.interaction?.itemId || null,
        questions: event.interaction?.questions || null,
        delivery: event.interaction?.delivery || null,
      };
      session.control.canApprove = !isQuestion && Boolean(event.approval?.id);
      session.control.canAnswer = isQuestion && Boolean(event.interaction?.canRespond);
      session.control.canSend = false;
      session.control.canSteer = false;
      session.control.action = null;
      session.control.expectedTurnId = null;
      if (session.control.canApprove) {
          session.control.mode = "approve";
          session.control.reason = "A single-use Codex approval challenge is attached";
      } else if (session.control.canAnswer) {
        session.control.mode = "answer";
        session.control.live = true;
        session.control.reason = "This question is bound to a live app-server thread, turn, and request";
      }
      break;
    }
    case "approval_resolved":
      session.status = "working";
      session.statusReason = event.decision === "allow" ? "手机已允许本次操作" : "手机已拒绝本次操作";
      session.pendingApproval = null;
      session.currentTool = null;
      session.control.canApprove = false;
      break;
    case "approval_expired":
      session.status = "waiting";
      session.statusReason = "手机审批已过期，请在电脑上的 Codex 中处理";
      if (session.pendingApproval) {
        session.pendingApproval.id = null;
        session.pendingApproval.canRespond = false;
      }
      session.control.canApprove = false;
      break;
    case "question_answered":
      session.status = "working";
      session.statusReason = "手机回答已送达，Codex 正在继续";
      session.pendingApproval = null;
      session.currentTool = null;
      session.control.canAnswer = false;
      session.control.mode = session.control.live ? "connected" : "observe";
      session.control.reason = session.control.live
        ? "Live app-server thread is verified"
        : "Live app-server connection is unavailable";
      break;
    case "question_unavailable":
      session.status = "waiting";
      session.statusReason = event.reason || "手机回答通道已失效，请回到原 Codex 客户端处理";
      if (session.pendingApproval?.kind === "question") {
        session.pendingApproval.canRespond = false;
        session.pendingApproval.delivery = event.delivery || "not_delivered";
      }
      session.control.canAnswer = false;
      break;
    case "assistant_message":
      if (session.status === "unknown") session.status = "working";
      session.statusReason = eventLabel(event);
      break;
    case "turn_complete":
      session.status = "idle";
      session.statusReason = eventLabel(event);
      session.currentTool = null;
      session.pendingApproval = null;
      session.control.canAnswer = false;
      session.lastCompletedTurnId = event.turnId || session.turnId || null;
      session.lastCompletionEventId = event.eventId || null;
      session.lastCompletionAt = event.at;
      break;
    case "session_end":
      session.status = "completed";
      session.statusReason = eventLabel(event);
      session.currentTool = null;
      session.pendingApproval = null;
      session.control.canAnswer = false;
      session.completedAt = event.at;
      break;
    case "aborted":
      session.status = "aborted";
      session.statusReason = eventLabel(event);
      session.currentTool = null;
      session.pendingApproval = null;
      session.control.canAnswer = false;
      session.lastCompletedTurnId = event.turnId || session.turnId || null;
      session.lastCompletionEventId = event.eventId || null;
      session.lastCompletionAt = event.at;
      break;
    case "error":
      session.status = "error";
      session.statusReason = eventLabel(event);
      session.currentTool = null;
      session.pendingApproval = null;
      session.control.canAnswer = false;
      break;
    default:
      break;
  }
  if (!session.pendingApproval) session.control.canApprove = false;
  if (!session.pendingApproval) session.control.canAnswer = false;
}

export class SessionStore extends EventEmitter {
  constructor({
    eventLogPath = null,
    taskTitlesPath = null,
    retentionDays = 14,
    maxEventLogBytes = 8 * 1024 * 1024,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    machineName = null,
  } = {}) {
    super();
    this.eventLogPath = eventLogPath;
    this.taskTitlesPath = taskTitlesPath;
    this.sessions = new Map();
    this.seen = new Set();
    this.seenOrder = [];
    this.persistQueue = Promise.resolve();
    this.persistBuffer = [];
    this.persistTimer = null;
    this.eventLogBytes = 0;
    this.deletedSessions = new Set();
    this.taskDocuments = new Map();
    this.taskTitles = new Map();
    this.smartTaskTitles = new Map();
    this.taskTitlePersistQueue = Promise.resolve();
    this.retentionDays = retentionDays;
    this.maxEventLogBytes = maxEventLogBytes;
    this.staleAfterMs = staleAfterMs;
    this.machineName = machineName;
    this.bridgeState = null;
    this.bridgeStateSignature = null;
  }

  async restore() {
    await this.restoreTaskTitles();
    if (!this.eventLogPath) return;
    await this.compactNow();
    let text;
    try {
      text = await readTail(this.eventLogPath, this.maxEventLogBytes);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.ingest(JSON.parse(line), { persist: false, announce: false });
      } catch {
        // Ignore an incomplete final line or old incompatible entries.
      }
    }
    this.reconcileRestoredSessions();
  }

  async restoreTaskTitles() {
    if (!this.taskTitlesPath) return;
    try {
      const parsed = JSON.parse(await readFile(this.taskTitlesPath, "utf8"));
      for (const [sessionId, title] of Object.entries(parsed.titles || {})) {
        if (typeof sessionId !== "string" || typeof title !== "string") continue;
        const cleaned = title.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
        if (cleaned && cleaned.length <= 80) this.taskTitles.set(sessionId, cleaned);
      }
      for (const [sessionId, title] of Object.entries(parsed.automaticTitles || {})) {
        if (typeof sessionId !== "string" || typeof title !== "string") continue;
        const cleaned = title.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
        if (cleaned && cleaned.length <= 80) this.smartTaskTitles.set(sessionId, cleaned);
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  queueTaskTitlesPersist() {
    if (!this.taskTitlesPath) return Promise.resolve();
    this.taskTitlePersistQueue = this.taskTitlePersistQueue.then(async () => {
      await mkdir(dirname(this.taskTitlesPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.taskTitlesPath}.tmp-${process.pid}-${Date.now()}`;
      const body = {
        version: 1,
        titles: Object.fromEntries(this.taskTitles),
        automaticTitles: Object.fromEntries(this.smartTaskTitles),
      };
      await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.taskTitlesPath);
      await chmod(this.taskTitlesPath, 0o600);
    });
    return this.taskTitlePersistQueue;
  }

  async setTaskTitle(id, value) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    if (sessionTaskKind(session) !== "user") throw Object.assign(new Error("Only user sessions can be renamed"), { statusCode: 409 });
    if (value != null && typeof value !== "string") throw Object.assign(new Error("Task title must be text or null"), { statusCode: 400 });
    const title = value == null ? "" : value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (title.length > 80) throw Object.assign(new Error("Task title must be 80 characters or fewer"), { statusCode: 400 });
    if (title) this.taskTitles.set(id, title);
    else this.taskTitles.delete(id);
    this.taskDocuments.delete(id);
    await this.queueTaskTitlesPersist();
    const summary = this.publicSummary(session);
    this.emit("session", summary);
    return summary;
  }

  hasAutomaticTaskTitle(id) {
    return Boolean(this.smartTaskTitles.get(id));
  }

  async setAutomaticTaskTitle(id, value) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    if (sessionTaskKind(session) !== "user") throw Object.assign(new Error("Only user sessions can be named"), { statusCode: 409 });
    if (value != null && typeof value !== "string") throw Object.assign(new Error("Task title must be text or null"), { statusCode: 400 });
    const title = value == null ? "" : value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (title.length > 80) throw Object.assign(new Error("Task title must be 80 characters or fewer"), { statusCode: 400 });
    if (title) this.smartTaskTitles.set(id, title);
    else this.smartTaskTitles.delete(id);
    this.taskDocuments.delete(id);
    await this.queueTaskTitlesPersist();
    const summary = this.publicSummary(session);
    this.emit("session", summary);
    return summary;
  }

  reconcileRestoredSessions(now = Date.now()) {
    for (const session of this.sessions.values()) {
      if (session.status !== "waiting") continue;
      const updatedAt = Date.parse(session.updatedAt);
      const expiresAt = Date.parse(session.pendingApproval?.expiresAt);
      const stale = Number.isFinite(updatedAt) && now - updatedAt > this.staleAfterMs;
      const expired = Number.isFinite(expiresAt) && expiresAt <= now;
      const orphanedPermission = session.pendingApproval?.kind === "permission";
      if (!stale && !expired && !orphanedPermission) continue;

      session.status = "unknown";
      session.statusReason = orphanedPermission
        ? "服务重启后已丢弃旧的手机审批；正在重新验证 Codex 现场状态"
        : "之前的等待请求已过期；需要重新验证 Codex 现场状态";
      session.currentTool = null;
      session.pendingApproval = null;
      session.control = {
        mode: "observe",
        canSteer: false,
        canSend: false,
        canInterrupt: false,
        canHandoff: false,
        canReclaim: false,
        handedOff: false,
        canApprove: false,
        canAnswer: false,
        live: false,
        action: null,
        expectedTurnId: null,
        reason: "The restored waiting state expired and cannot be controlled safely",
      };
    }
  }

  ingest(event, { persist = true, announce = true } = {}) {
    if (!event?.sessionId || !event?.kind) return null;
    if (event.kind === "session_deleted") {
      this.remove(event.sessionId, { persist: false, announce });
      return null;
    }
    if (this.deletedSessions.has(event.sessionId)) return null;
    const normalized = { ...event, at: isoTime(event.at), machineName: event.machineName || this.machineName };
    // Codex stores environment, repository, interruption, image transport,
    // and auto-review envelopes as role=user response items. They are model
    // context, not prompts the person sent, so never let them create a task or
    // conversation turn. Restored rows are filtered in memory; the append-only
    // audit source stays intact until its normal retention window expires.
    if (isInjectedRolloutPrompt(normalized)) return this.sessions.get(normalized.sessionId) || null;
    const session = this.sessions.get(event.sessionId) || newSession(normalized);
    if (normalized.eventId && this.seen.has(normalized.eventId)) {
      const enrichedMessage = enrichDuplicateMessage(session, normalized);
      const enrichedProvenance = enrichDuplicateProvenance(session, normalized);
      if (enrichedMessage || enrichedProvenance) {
        if (TERMINAL_TASK_EVENT_KINDS.has(normalized.kind)) {
          session.taskResults = mergeTaskResults(session.taskResults, deriveTaskResults(session));
        }
        this.taskDocuments.delete(session.id);
        if (persist && this.eventLogPath) this.queuePersist(normalized);
        if (announce) this.emit("session", this.publicSummary(session));
      }
      return session;
    }
    if (normalized.eventId) this.remember(normalized.eventId);

    // Codex rollouts commonly contain the same visible message in both an
    // event_msg and a response_item record. Keep one canonical timeline row so
    // history, storage, and mobile rendering do not grow at roughly 2x speed.
    const semanticDuplicate = findSemanticMessageDuplicate(session.events, normalized);
    if (semanticDuplicate) {
      // Keep the first, richer response_item formatting while inheriting the
      // task_complete turn identity used to group the restored conversation.
      if (!semanticDuplicate.turnId && normalized.turnId) semanticDuplicate.turnId = normalized.turnId;
      if (!semanticDuplicate.phase && normalized.phase) semanticDuplicate.phase = normalized.phase;
      return session;
    }
    applyEvent(session, normalized);
    if (normalized.kind !== "session_metadata") {
      session.events.push({
        eventId: normalized.eventId || null,
        at: normalized.at,
        kind: normalized.kind,
        source: normalized.source || "unknown",
        turnId: normalized.turnId || null,
        model: normalized.model || null,
        reasoningEffort: normalized.reasoningEffort || null,
        serviceTier: normalized.serviceTier || null,
        phase: normalized.phase || null,
        label: eventLabel(normalized),
        tool: normalized.tool || null,
        message: normalized.message || null,
      });
      if (TERMINAL_TASK_EVENT_KINDS.has(normalized.kind)) {
        session.taskResults = mergeTaskResults(session.taskResults, deriveTaskResults(session));
      }
      trimSessionEvents(session);
    }
    this.sessions.set(session.id, session);
    this.taskDocuments.delete(session.id);
    if (this.bridgeState) this.applyBridgeStateToSession(session, this.bridgeState, false);

    if (persist && this.eventLogPath) {
      this.queuePersist(normalized);
    }
    if (announce) this.emit("session", this.publicSummary(session));
    return session;
  }

  remember(eventId) {
    this.seen.add(eventId);
    this.seenOrder.push(eventId);
    if (this.seenOrder.length > MAX_SEEN_EVENTS) {
      const removed = this.seenOrder.splice(0, this.seenOrder.length - MAX_SEEN_EVENTS);
      for (const id of removed) this.seen.delete(id);
    }
  }

  remove(id, { persist = true, announce = true } = {}) {
    if (typeof id !== "string" || !id) return false;
    const firstRemoval = !this.deletedSessions.has(id);
    const session = this.sessions.get(id);
    this.deletedSessions.add(id);
    this.sessions.delete(id);
    this.taskDocuments.delete(id);
    if (this.taskTitles.delete(id)) this.queueTaskTitlesPersist();
    if (this.smartTaskTitles.delete(id)) this.queueTaskTitlesPersist();
    for (const event of session?.events || []) {
      if (event.eventId) this.seen.delete(event.eventId);
    }
    if (firstRemoval && persist && this.eventLogPath) {
      this.queuePersist({
        eventId: `session-deleted-${id}-${Date.now()}`,
        sessionId: id,
        source: "phone-control",
        provider: "codex",
        kind: "session_deleted",
        at: new Date().toISOString(),
      });
    }
    if (firstRemoval && announce) this.emit("removed", { id });
    return Boolean(session) || firstRemoval;
  }

  queuePersist(event) {
    this.persistBuffer.push(event);
    if (this.persistBuffer.length >= PERSIST_BATCH_MAX) {
      this.flushPersistBuffer();
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flushPersistBuffer(), PERSIST_BATCH_DELAY_MS);
    this.persistTimer.unref?.();
  }

  flushPersistBuffer() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (!this.persistBuffer.length) return this.persistQueue;
    const batch = this.persistBuffer.splice(0);
    this.persistQueue = this.persistQueue.then(() => this.persist(batch));
    return this.persistQueue;
  }

  async persist(events) {
    try {
      await mkdir(dirname(this.eventLogPath), { recursive: true, mode: 0o700 });
      const body = events.map((event) => JSON.stringify({ schemaVersion: 1, ...event })).join("\n") + "\n";
      await appendFile(this.eventLogPath, body, { mode: 0o600 });
      this.eventLogBytes += Buffer.byteLength(body);
      const overflowAllowance = Math.min(1024 * 1024, Math.floor(this.maxEventLogBytes / 4));
      if (this.eventLogBytes > this.maxEventLogBytes + overflowAllowance) await this.compactNow();
    } catch (error) {
      this.emit("warning", error);
    }
  }

  async flush() {
    this.flushPersistBuffer();
    await Promise.all([this.persistQueue, this.taskTitlePersistQueue]);
  }

  compact() {
    this.flushPersistBuffer();
    this.persistQueue = this.persistQueue.then(() => this.compactNow());
    return this.persistQueue;
  }

  async compactNow() {
    if (!this.eventLogPath) return;
    let details;
    try {
      details = await stat(this.eventLogPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const text = await readTail(this.eventLogPath, this.maxEventLogBytes);
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    const kept = [];
    const semanticMessages = new Map();
    let changed = details.size > this.maxEventLogBytes;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (Date.parse(event.at) < cutoff) {
          changed = true;
          continue;
        }
        const semanticKey = semanticMessageKey(event);
        const eventAt = Date.parse(event.at);
        const previousAt = semanticKey ? semanticMessages.get(semanticKey) : null;
        if (semanticKey && Number.isFinite(previousAt) && Number.isFinite(eventAt)
          && Math.abs(eventAt - previousAt) <= MESSAGE_DUPLICATE_WINDOW_MS) {
          changed = true;
          continue;
        }
        if (semanticKey && Number.isFinite(eventAt)) semanticMessages.set(semanticKey, eventAt);
        kept.push(JSON.stringify(event));
      } catch {
        changed = true;
      }
    }
    if (!changed) {
      this.eventLogBytes = details.size;
      return;
    }
    await mkdir(dirname(this.eventLogPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.eventLogPath}.tmp-${process.pid}-${Date.now()}`;
    const body = kept.length ? `${kept.join("\n")}\n` : "";
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, this.eventLogPath);
    this.eventLogBytes = Buffer.byteLength(body);
  }

  publicSession(session, { includeEvents = true, eventLimit = null } = {}) {
    // The list endpoint is hit during bootstrap and as the disconnected-stream
    // fallback. Avoid cloning up to 240 detailed events for every session only
    // to delete them again in publicSummary(). On larger histories that wasted
    // work can dominate a mobile refresh.
    const boundedEventLimit = Number.isFinite(eventLimit) ? Math.max(0, Math.floor(eventLimit)) : null;
    const selectedEvents = includeEvents
      ? (boundedEventLimit == null ? session.events : session.events.slice(-boundedEventLimit)).map(publicEvent)
      : [];
    const source = includeEvents
      ? Object.fromEntries(Object.entries({ ...session, events: selectedEvents }).filter(([key]) => key !== "taskResults"))
      : Object.fromEntries(Object.entries(session).filter(([key]) => key !== "events" && key !== "taskResults"));
    const copy = JSON.parse(JSON.stringify(source));
    const updatedAtMs = Date.parse(copy.updatedAt);
    const ageMs = Math.max(0, Date.now() - updatedAtMs);
    const ended = ["idle", "completed", "error", "aborted"].includes(copy.status);
    copy.liveness = ended
      ? "historical"
      : (copy.control?.live || ageMs <= this.staleAfterMs) ? "recent" : "unverified";
    copy.staleAt = ended || !Number.isFinite(updatedAtMs)
      ? null
      : new Date(updatedAtMs + this.staleAfterMs).toISOString();
    copy.lastSeenAt = copy.updatedAt;
    copy.machineName = copy.machineName || this.machineName;
    copy.taskKind = sessionTaskKind(session);
    copy.task = this.taskDocument(session).task;
    const result = deriveTaskResult(session);
    copy.result = includeEvents ? result : summarizeTaskResult(result);
    copy.hiddenFromTasks = copy.taskKind !== "user";
    copy.historyTruncated = Boolean(session.eventsDiscarded);
    copy.hasTranscript = Boolean(session.transcriptPath);
    if (includeEvents) {
      copy.results = deriveTaskResults(session).map(detailTaskResult);
      copy.eventsTotal = session.events.length;
      copy.eventsStart = Math.max(0, session.events.length - selectedEvents.length);
      copy.eventsPartial = selectedEvents.length < session.events.length;
    }
    delete copy.testEvidence;
    delete copy.taskResults;
    delete copy.transcriptPath;
    delete copy.firstUserMessage;
    delete copy.taskGoalMessage;
    delete copy.lastAssistantMessage;
    return copy;
  }

  publicSummary(session) {
    return { ...this.publicSession(session, { includeEvents: false }), eventsCount: session.events.length };
  }

  list({ taskKind = null } = {}) {
    const childCounts = new Map();
    for (const session of this.sessions.values()) {
      const parentId = session.parentThreadId || session.branchOf;
      if (!parentId) continue;
      childCounts.set(parentId, (childCounts.get(parentId) || 0) + 1);
    }
    const summaries = Array.from(this.sessions.values())
      .filter((session) => !taskKind || sessionTaskKind(session) === taskKind)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => this.publicSummary(session));
    return summaries.map((summary) => ({ ...summary, childSessionCount: childCounts.get(summary.id) || 0 }));
  }

  get(id, { eventLimit = null } = {}) {
    const session = this.sessions.get(id);
    return session ? this.publicSession(session, { eventLimit }) : null;
  }

  getSummary(id) {
    const session = this.sessions.get(id);
    return session ? this.publicSummary(session) : null;
  }

  taskDocument(session) {
    let document = this.taskDocuments.get(session.id);
    if (!document) {
      document = buildTaskSearchDocument({
        ...session,
        customTaskTitle: this.taskTitles.get(session.id) || null,
        smartTaskTitle: this.smartTaskTitles.get(session.id) || null,
      });
      this.taskDocuments.set(session.id, document);
    }
    return document;
  }

  taskTitleContext(id) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    if (sessionTaskKind(session) !== "user") throw Object.assign(new Error("Only user sessions can be named"), { statusCode: 409 });
    return buildTaskTitleContext({ ...session, customTaskTitle: this.taskTitles.get(session.id) || null });
  }

  search({ query, limit = 60, taskKind = "user" } = {}) {
    const sessions = Array.from(this.sessions.values())
      .filter((session) => !taskKind || sessionTaskKind(session) === taskKind);
    return searchTaskDocuments(sessions.map((session) => this.taskDocument(session)), { query, limit });
  }

  isPhoneControlledTurn(id, turnId) {
    if (!id || !turnId) return false;
    const session = this.sessions.get(id);
    return Boolean(session?.events.some((event) => (
      event.kind === "phone_input_sent" && event.turnId === turnId
    )));
  }

  applyBridgeStateToSession(session, {
    connected = false,
    loadedThreads = [],
    subscribedThreads = [],
    loadedThreadSet = null,
    subscribedThreadSet = null,
    threadStates = {},
    unavailableThreadReasons = {},
    retryingThreadReasons = {},
    handedOffThreads = [],
    handedOffThreadSet = null,
    handoffSupported = false,
  } = {}, announce = true) {
    const loaded = loadedThreadSet || new Set(loadedThreads);
    const subscribed = subscribedThreadSet || new Set(subscribedThreads);
    const live = Boolean(connected && loaded.has(session.id) && subscribed.has(session.id));
    const runtime = threadStates?.[session.id] || null;
    const unavailableReason = clampText(unavailableThreadReasons?.[session.id], 300) || null;
    const retryingReason = clampText(retryingThreadReasons?.[session.id], 300) || null;
    const handedOff = (handedOffThreadSet || new Set(handedOffThreads)).has(session.id);
    const desktopOwnershipTransfer = session.surface === "Desktop";
    const previous = JSON.stringify(session.control);
    session.control.live = live;
    session.control.canSend = false;
    session.control.canSteer = false;
    session.control.canInterrupt = false;
    session.control.canHandoff = false;
    session.control.canReclaim = false;
    session.control.handedOff = handedOff;
    session.control.action = null;
    session.control.expectedTurnId = null;
    if (sessionTaskKind(session) !== "user" && !session.control.canApprove && !session.control.canAnswer) {
      session.control.live = false;
      session.control.mode = "observe";
      session.control.reason = "内部、测试或诊断会话不能从手机继续执行";
      if (announce && previous !== JSON.stringify(session.control)) this.emit("session", this.publicSummary(session));
      return;
    }
    if (!session.control.canApprove && !session.control.canAnswer && !session.pendingApproval) {
      const waiting = runtime?.activeFlags?.includes("waitingOnApproval") || runtime?.activeFlags?.includes("waitingOnUserInput");
      const interruptRequested = runtime?.activeFlags?.includes("interruptRequested");
      if (unavailableReason) {
        session.control.mode = "observe";
        session.control.canReclaim = Boolean(
          handedOff
          && connected
          && handoffSupported
          && desktopOwnershipTransfer
          && !["working", "waiting"].includes(session.status)
        );
        session.control.reason = `Live control unavailable: ${unavailableReason}`;
      } else if (retryingReason) {
        session.control.mode = "observe";
        session.control.reason = `Live control is synchronizing: ${retryingReason}`;
      } else if (live && runtime?.status === "active" && runtime.activeTurnId && !waiting && !interruptRequested) {
        session.control.mode = "steer";
        session.control.canSend = true;
        session.control.canSteer = true;
        session.control.canInterrupt = true;
        session.control.action = "steer";
        session.control.expectedTurnId = runtime.activeTurnId;
        session.control.reason = "Input is bound to this verified active Codex turn";
      } else if (live && runtime?.status === "idle") {
        session.control.mode = "start";
        session.control.canSend = true;
        session.control.canHandoff = Boolean(handoffSupported && desktopOwnershipTransfer);
        session.control.action = "start";
        session.control.reason = "This verified Codex thread is idle and can start a new turn";
      } else if (!live && connected && session.transcriptPath && SAFELY_RESUMABLE_STATUSES.has(session.status)) {
        session.control.mode = "resume";
        session.control.canSend = true;
        session.control.action = "resume";
        session.control.reason = "This stored Codex thread can be resumed before starting a new turn";
      } else {
        session.control.mode = live ? "connected" : "observe";
        session.control.reason = live
          ? interruptRequested
            ? "A stop request was delivered for this turn; waiting for Codex to confirm it"
            : waiting
            ? "Resolve the current Codex approval or question before sending another instruction"
            : "The live thread is connected, but its current turn cannot be safely controlled"
          : connected
            ? session.transcriptPath && ["working", "waiting"].includes(session.status)
              ? "This session may still be active in another Codex runtime and is observe-only"
              : "This session has no verified safely resumable Codex rollout"
            : "No verified live app-server endpoint is attached";
      }
    }
    if (announce && previous !== JSON.stringify(session.control)) this.emit("session", this.publicSummary(session));
  }

  setBridgeState(state = {}) {
    const next = {
      connected: Boolean(state.connected),
      loadedThreads: Array.isArray(state.loadedThreads) ? [...state.loadedThreads] : [],
      subscribedThreads: Array.isArray(state.subscribedThreads) ? [...state.subscribedThreads] : [],
      threadStates: state.threadStates && typeof state.threadStates === "object" ? JSON.parse(JSON.stringify(state.threadStates)) : {},
      unavailableThreadReasons: state.unavailableThreadReasons && typeof state.unavailableThreadReasons === "object"
        ? JSON.parse(JSON.stringify(state.unavailableThreadReasons))
        : {},
      retryingThreadReasons: state.retryingThreadReasons && typeof state.retryingThreadReasons === "object"
        ? JSON.parse(JSON.stringify(state.retryingThreadReasons))
        : {},
      handedOffThreads: Array.isArray(state.handedOffThreads) ? [...state.handedOffThreads] : [],
      handoffSupported: Boolean(state.handoffSupported),
    };
    const signature = JSON.stringify(next);
    if (signature === this.bridgeStateSignature) return;
    this.bridgeStateSignature = signature;
    this.bridgeState = {
      ...next,
      loadedThreadSet: new Set(next.loadedThreads),
      subscribedThreadSet: new Set(next.subscribedThreads),
      handedOffThreadSet: new Set(next.handedOffThreads),
    };
    for (const session of this.sessions.values()) {
      this.applyBridgeStateToSession(session, this.bridgeState);
    }
  }
}

async function readTail(filePath, maxBytes) {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}
