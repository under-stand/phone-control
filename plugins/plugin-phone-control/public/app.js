import {
  cleanTaskText,
  compactId,
  escapeHtml,
  localDateTime,
  projectName,
  readableBytes,
  relativeTime,
  sessionDisplayStatus,
  taskPreview,
  truncate,
} from "./lib/format.js?v=82";
import { assistantReplyGroups, conversationTurns } from "./lib/conversation.js?v=82";
import { commandStateView, compareTaskUrgency, inboxOverview, resultView, taskNeedsAttention } from "./lib/task-view.js?v=82";

function storedCompletionKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem("phone-control-notified-completions") || "[]");
    return Array.isArray(parsed) ? parsed.slice(-100) : [];
  } catch {
    return [];
  }
}

function storedDrafts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem("phone-control-drafts-v1") || "{}");
    return new Map(Object.entries(parsed).filter(([, value]) => typeof value === "string" && value.length <= 4_000).slice(-20));
  } catch {
    return new Map();
  }
}

const TARGET_SESSION_STORAGE_KEY = "phone-control-target-session-v1";

function storedTargetSessionId() {
  try {
    const value = localStorage.getItem(TARGET_SESSION_STORAGE_KEY);
    return value && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}

const state = {
  sessions: new Map(),
  filter: "recent",
  filterBeforeSearch: null,
  searchQuery: "",
  searchResults: new Map(),
  searchReady: false,
  searchError: null,
  searchTimer: null,
  searchController: null,
  searchRequestId: 0,
  stream: null,
  streamGeneration: 0,
  streamFallbackTimer: null,
  streamFallbackDelayMs: 1_000,
  streamWatchdogTimer: null,
  offlineProbeTimer: null,
  lastStreamEventAt: 0,
  connectionGraceTimer: null,
  connected: false,
  lastSyncAt: 0,
  backgroundedAt: 0,
  foregroundResumePromise: null,
  foregroundResumeId: 0,
  manualReconnectPromise: null,
  sessionsRefreshPromise: null,
  sessionsRefreshId: 0,
  sessionsMutationRevision: 0,
  detailRefreshTimer: null,
  detailScrollingUntil: 0,
  detailScrollingSessionId: null,
  currentDeviceId: null,
  drafts: storedDrafts(),
  draftPersistTimer: null,
  statusSessionId: null,
  expandedMessages: new Set(),
  expandedTurnProcesses: new Set(),
  expandedTurnUpdates: new Set(),
  expandedResults: new Set(),
  richTextCache: new Map(),
  historyVisibleTurns: new Map(),
  detailSessions: new Map(),
  detailFetchedAt: new Map(),
  detailRequests: new Map(),
  detailRequestControllers: new Map(),
  modelCatalog: null,
  modelCatalogPromise: null,
  newSessionTierTouched: false,
  composerModelSelections: new Map(),
  runtimeSessionId: null,
  pairing: null,
  pairingExpiryTimer: null,
  expandedGroups: new Set(),
  expandedComposers: new Set(),
  renderScheduled: false,
  listDirty: false,
  detailDirtySessions: new Set(),
  pendingDetailSessionId: null,
  attachments: new Map(),
  pushSubscribed: false,
  soundEnabled: localStorage.getItem("phone-control-sound") === "1",
  notificationDesired: null,
  notificationSyncPromise: null,
  notificationSyncing: false,
  pushStatusSyncPromise: null,
  audioContext: null,
  requestedSessionId: new URL(location.href).searchParams.get("session"),
  notifiedCompletions: new Set(storedCompletionKeys()),
  targetSessionId: storedTargetSessionId(),
};

const elements = {
  connection: document.querySelector("#connection"),
  syncSummary: document.querySelector("#sync-summary"),
  list: document.querySelector("#task-list"),
  empty: document.querySelector("#empty"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyCopy: document.querySelector("#empty-copy"),
  taskSearch: document.querySelector("#task-search"),
  taskSearchInput: document.querySelector("#task-search-input"),
  taskSearchClear: document.querySelector("#task-search-clear"),
  taskSearchSummary: document.querySelector("#task-search-summary"),
  countRecent: document.querySelector("#count-recent"),
  countAttention: document.querySelector("#count-attention"),
  countActive: document.querySelector("#count-active"),
  countHistory: document.querySelector("#count-history"),
  countAll: document.querySelector("#count-all"),
  actionInbox: document.querySelector("#action-inbox"),
  actionInboxOpen: document.querySelector("#action-inbox-open"),
  actionInboxTitle: document.querySelector("#action-inbox-title"),
  actionInboxReason: document.querySelector("#action-inbox-reason"),
  actionInboxCount: document.querySelector("#action-inbox-count"),
  filters: document.querySelector(".filters"),
  notify: document.querySelector("#notify"),
  notifyLabel: document.querySelector("#notify-label"),
  newSessionButton: document.querySelector("#new-session-button"),
  newSessionDialog: document.querySelector("#new-session-dialog"),
  newSessionForm: document.querySelector("#new-session-form"),
  newSessionClose: document.querySelector("#new-session-close"),
  newSessionInput: document.querySelector("#new-session-input"),
  newSessionCwd: document.querySelector("#new-session-cwd"),
  newSessionWorkspaces: document.querySelector("#new-session-workspaces"),
  newSessionCustomWorkspace: document.querySelector("#new-session-custom-workspace"),
  newSessionMachine: document.querySelector("#new-session-machine"),
  newSessionWorkspaceHint: document.querySelector("#new-session-workspace-hint"),
  newSessionModel: document.querySelector("#new-session-model"),
  newSessionEffort: document.querySelector("#new-session-effort"),
  newSessionEfforts: document.querySelector("#new-session-efforts"),
  newSessionEffortHint: document.querySelector("#new-session-effort-hint"),
  newSessionModelDescription: document.querySelector("#new-session-model-description"),
  newSessionFast: document.querySelector("#new-session-fast"),
  newSessionFastRow: document.querySelector("#new-session-fast-row"),
  newSessionFastHint: document.querySelector("#new-session-fast-hint"),
  newSessionPermission: document.querySelector("#new-session-permission"),
  newSessionPermissionHint: document.querySelector("#new-session-permission-hint"),
  newSessionConfigReset: document.querySelector("#new-session-config-reset"),
  newSessionModelHint: document.querySelector("#new-session-model-hint"),
  newSessionRuntime: document.querySelector("#new-session-runtime"),
  newSessionRuntimeSummary: document.querySelector("#new-session-runtime-summary"),
  newSessionSubmit: document.querySelector("#new-session-submit"),
  newSessionSubmitSummary: document.querySelector("#new-session-submit-summary"),
  newSessionError: document.querySelector("#new-session-error"),
  workspaceOptions: document.querySelector("#workspace-options"),
  detail: document.querySelector("#detail"),
  detailHeader: document.querySelector("#detail-header"),
  detailContent: document.querySelector("#detail-content"),
  detailActions: document.querySelector("#detail-actions"),
  detailClose: document.querySelector("#detail-close"),
  pairing: document.querySelector("#pairing"),
  pairingForm: document.querySelector("#pairing-form"),
  pairingToken: document.querySelector("#pairing-token"),
  pairingError: document.querySelector("#pairing-error"),
  statusButton: document.querySelector("#status-button"),
  statusDialog: document.querySelector("#status-dialog"),
  statusClose: document.querySelector("#status-close"),
  statusRefresh: document.querySelector("#status-refresh"),
  statusContent: document.querySelector("#status-content"),
  topMenu: document.querySelector("#top-menu"),
  topMenuTrigger: document.querySelector("#top-menu-trigger"),
  devicesButton: document.querySelector("#devices-button"),
  devicesDialog: document.querySelector("#devices-dialog"),
  devicesClose: document.querySelector("#devices-close"),
  deviceList: document.querySelector("#device-list"),
  runtimeSettingsDialog: document.querySelector("#runtime-settings-dialog"),
  runtimeSettingsContent: document.querySelector("#runtime-settings-content"),
  newPairing: document.querySelector("#new-pairing"),
  pairingLink: document.querySelector("#pairing-link"),
  pairingLinkMeta: document.querySelector("#pairing-link-meta"),
  pairingLinkStatus: document.querySelector("#pairing-link-status"),
  pairingLinkValue: document.querySelector("#pairing-link-value"),
  copyPairing: document.querySelector("#copy-pairing"),
  openPairing: document.querySelector("#open-pairing"),
  toast: document.querySelector("#toast"),
  signalToast: document.querySelector("#signal-toast"),
  signalToastTitle: document.querySelector("#signal-toast-title"),
  signalToastBody: document.querySelector("#signal-toast-body"),
  targetTracker: document.querySelector("#target-tracker"),
  targetOpen: document.querySelector("#target-open"),
  targetClear: document.querySelector("#target-clear"),
  targetContext: document.querySelector("#target-context"),
  targetTitle: document.querySelector("#target-title"),
  targetProgress: document.querySelector("#target-progress"),
  targetState: document.querySelector("#target-state"),
};

const labels = {
  working: "工作中",
  waiting: "等待处理",
  idle: "本轮完成",
  completed: "已结束",
  error: "出错",
  aborted: "已中止",
  disconnected: "连接已中断",
  unknown: "状态未知",
};

const STREAM_STALE_MS = 36_000;
const STREAM_WATCHDOG_MS = 8_000;
const CONNECTION_TRANSIENT_GRACE_MS = 12_000;
const CONNECTION_HTTP_FRESH_MS = 20_000;

function isUserTask(session) {
  return session.taskKind ? session.taskKind === "user" : !session.hiddenFromTasks;
}

function isActiveTask(session) {
  return isUserTask(session) && ["working", "waiting"].includes(session.status) && session.liveness === "recent";
}

function isAttentionTask(session) {
  if (!isUserTask(session)) return false;
  return taskNeedsAttention(session);
}

function isRecentTask(session) {
  const age = Date.now() - new Date(session.updatedAt).getTime();
  return isUserTask(session) && (isActiveTask(session) || (Number.isFinite(age) && age <= 86_400_000));
}

function taskTitle(session) {
  return truncate(session.task?.title, 58) || truncate(session.lastUserMessage?.text, 58) || projectName(session);
}

function taskTopic(session) {
  const topic = truncate(session.task?.topic, 58);
  return cleanTaskText(topic).toLocaleLowerCase("zh-CN") === cleanTaskText(taskTitle(session)).toLocaleLowerCase("zh-CN") ? "" : topic;
}

function taskSummary(session) {
  if (sessionDisplayStatus(session) === "disconnected") return "上次执行未收到结束状态，当前不再视为工作中";
  if (["queued", "blocked", "sending", "accepted", "needs_review"].includes(session.commandState?.state)) {
    return session.commandState.detail || session.commandState.label;
  }
  if (session.task?.progress) return session.task.progress;
  if (session.status === "waiting") {
    const action = session.pendingApproval?.kind === "question" ? "需要你回答" : "需要你处理";
    return taskPreview(session.pendingApproval?.reason || session.statusReason || action, 92) || action;
  }
  if (session.status === "working") {
    const progress = targetProgress(session);
    if (progress && progress !== "Codex 正在执行") return `正在进行：${progress}`;
  }
  const assistant = session.lastMessage?.role === "assistant" ? taskPreview(session.lastMessage.text, 116) : "";
  if (assistant) return ["idle", "completed"].includes(session.status) ? `本轮结果：${assistant}` : assistant;
  return session.status === "working" ? "Codex 正在执行，打开后可查看实时进展。" : taskPreview(session.statusReason, 116) || "等待更多活动";
}

function taskGoal(session) {
  return taskPreview(session.task?.goal || session.lastUserMessage?.text, 156) || taskTitle(session);
}

function normalizedSearchTokens() {
  return cleanTaskText(state.searchQuery).toLocaleLowerCase("zh-CN").split(/\s+/).filter(Boolean).slice(0, 12);
}

function localTaskSearchMatches(session) {
  if (!state.searchQuery) return true;
  const haystack = cleanTaskText([
    session.task?.title,
    session.task?.currentTitle,
    session.task?.topic,
    session.task?.goal,
    session.task?.progress,
    session.task?.result,
    session.cwd,
    session.machineName,
    session.surface,
    session.model,
    labels[sessionDisplayStatus(session)] || session.status,
  ].filter(Boolean).join(" ")).toLocaleLowerCase("zh-CN");
  return normalizedSearchTokens().every((token) => haystack.includes(token));
}

function taskSearchMatch(session) {
  if (!state.searchQuery) return null;
  return state.searchResults.get(session.id)?.match || null;
}

function taskMatchesSearch(session) {
  if (!state.searchQuery) return true;
  return state.searchReady ? state.searchResults.has(session.id) : localTaskSearchMatches(session);
}

function highlightedSearchText(value) {
  const source = String(value || "");
  const tokens = normalizedSearchTokens().filter((token) => token.length >= 1);
  if (!tokens.length) return escapeHtml(source);
  const pattern = tokens
    .sort((left, right) => right.length - left.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return escapeHtml(source);
  const matcher = new RegExp(`(${pattern})`, "giu");
  return source.split(matcher).map((part, index) => index % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)).join("");
}

function targetProgress(session) {
  if (sessionDisplayStatus(session) === "disconnected") return "上次执行连接已中断";
  if (session.task?.progress) return taskPreview(session.task.progress, 42);
  if (session.status === "waiting") {
    const action = session.pendingApproval?.kind === "question" ? "需要你回答" : "需要你处理";
    return taskPreview(session.pendingApproval?.reason || session.statusReason || action, 42) || action;
  }
  if (session.status === "working") {
    const tool = session.currentTool;
    if (tool?.summary && !/^agent activity$/i.test(tool.summary.trim())) return truncate(tool.summary, 42);
    if (tool?.name) return `正在运行 ${truncate(tool.name, 30)}`;
    const reason = /^(?:agent activity|agent responded)$/i.test(session.statusReason?.trim() || "") ? "" : session.statusReason;
    return taskPreview(reason, 42) || "Codex 正在执行";
  }
  if (["idle", "completed"].includes(session.status)) {
    return taskPreview(session.lastMessage?.role === "assistant" ? session.lastMessage.text : "", 42) || "可以查看本轮结果";
  }
  if (session.status === "error") return taskPreview(session.statusReason, 42) || "执行遇到错误";
  if (session.status === "aborted") return "本轮已停止";
  return "等待状态同步";
}

function updateTargetToggle() {
  const button = elements.detailHeader.querySelector("[data-target-session-id]");
  if (!button) return;
  const active = button.dataset.targetSessionId === state.targetSessionId;
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
  button.setAttribute("aria-label", active ? "取消追踪这个会话" : "追踪这个会话");
  button.title = active ? "取消目标追踪" : "固定到手机顶部并只提醒这个会话";
  button.querySelector("b").textContent = active ? "已追踪" : "追踪";
}

function renderTargetTracker() {
  const id = state.targetSessionId;
  elements.targetTracker.hidden = !id;
  if (!id) return;
  const session = state.sessions.get(id);
  elements.targetTracker.classList.remove("is-compact");
  if (!session) {
    elements.targetTracker.dataset.status = "unknown";
    elements.targetContext.textContent = "目标会话 · 暂不可用";
    elements.targetTitle.textContent = compactId(id);
    elements.targetProgress.textContent = "等待下一次同步；你也可以取消追踪";
    elements.targetState.textContent = labels.unknown;
    elements.targetOpen.disabled = true;
    return;
  }
  const displayStatus = sessionDisplayStatus(session);
  elements.targetTracker.dataset.status = displayStatus;
  elements.targetTracker.classList.toggle("is-compact", filterMatches(session));
  elements.targetContext.textContent = `目标会话 · ${projectName(session)}`;
  elements.targetTitle.textContent = taskTitle(session);
  elements.targetProgress.textContent = `${targetProgress(session)} · ${relativeTime(session.updatedAt)}更新`;
  elements.targetState.textContent = labels[displayStatus] || labels.unknown;
  elements.targetOpen.disabled = false;
}

function applyTargetSession(id) {
  state.targetSessionId = id || null;
  try {
    if (state.targetSessionId) localStorage.setItem(TARGET_SESSION_STORAGE_KEY, state.targetSessionId);
    else localStorage.removeItem(TARGET_SESSION_STORAGE_KEY);
  } catch {
    // Target tracking still works for this page when storage is unavailable.
  }
  renderTargetTracker();
  updateTargetToggle();
}

async function setTargetSession(id) {
  const previous = state.targetSessionId;
  applyTargetSession(id);
  try {
    const payload = await request("/api/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id || null }),
    });
    applyTargetSession(payload.sessionId || null);
  } catch (error) {
    applyTargetSession(previous);
    throw error;
  }
}

async function syncTargetSession() {
  const localSessionId = state.targetSessionId;
  try {
    const payload = await request("/api/target", { timeoutMs: 6_000 });
    if (payload.sessionId) {
      applyTargetSession(payload.sessionId);
      return;
    }
    if (localSessionId && state.sessions.has(localSessionId)) {
      await setTargetSession(localSessionId);
      return;
    }
    applyTargetSession(null);
  } catch (error) {
    if (error.message !== "UNAUTHORIZED") renderTargetTracker();
  }
}

function filterMatches(session) {
  let scopeMatches;
  if (state.filter === "attention") scopeMatches = isAttentionTask(session);
  else if (state.filter === "active") scopeMatches = isActiveTask(session);
  else if (state.filter === "history") scopeMatches = isUserTask(session) && !isRecentTask(session);
  else if (state.filter === "all") scopeMatches = isUserTask(session);
  else scopeMatches = isRecentTask(session);
  return scopeMatches && taskMatchesSearch(session);
}

function taskCard(session) {
  const displayStatus = sessionDisplayStatus(session);
  const goal = taskGoal(session);
  const topic = taskTopic(session);
  const progress = taskSummary(session);
  const match = taskSearchMatch(session);
  const showGoal = cleanTaskText(goal).toLocaleLowerCase("zh-CN") !== cleanTaskText(taskTitle(session)).toLocaleLowerCase("zh-CN");
  const machine = session.machineName && session.machineName !== projectName(session) ? ` · ${session.machineName}` : "";
  const waiting = isAttentionTask(session)
    ? `<div class="attention"><span>!</span><div><b>${escapeHtml(session.inbox?.label || (session.pendingApproval?.kind === "question" ? "需要回答" : "需要处理"))}</b><small>${escapeHtml(session.inbox?.reason || session.pendingApproval?.reason || session.statusReason || "打开任务查看")}</small></div></div>`
    : "";
  const command = commandStateView(session.commandState);
  const commandChip = command && !["completed", "canceled", "expired"].includes(command.state)
    ? `<span class="card-command-state" data-tone="${escapeHtml(command.tone)}">${escapeHtml(command.label)}</span>`
    : "";
  const liveness = displayStatus === "disconnected"
    ? `<div class="liveness-note">未收到完成或失败事件 · 最后活动于 ${relativeTime(session.lastSeenAt)}</div>`
    : session.liveness === "unverified"
    ? `<div class="liveness-note">现场状态未验证 · 最后活动于 ${relativeTime(session.lastSeenAt)}</div>`
    : "";
  return `
    <article class="task-card" data-session-id="${escapeHtml(session.id)}" data-status="${escapeHtml(displayStatus)}"${match?.eventId ? ` data-search-event-id="${escapeHtml(match.eventId)}"` : ""} tabindex="0">
      <div class="task-accent"></div>
      <header>
        <div class="task-source"><span>${session.surface === "Desktop" ? "▣" : session.surface === "CLI" ? ">_" : "◇"}</span>${escapeHtml(session.surface)}</div>
        <span class="task-card-meta">${commandChip}<time>${relativeTime(session.updatedAt)}</time></span>
      </header>
      <div class="task-title-row">
        <div><h3>${highlightedSearchText(taskTitle(session))}</h3><p>${escapeHtml(projectName(session))}${escapeHtml(machine)}</p></div>
        <span class="status-badge">${labels[displayStatus] || labels.unknown}</span>
      </div>
      ${topic ? `<p class="task-topic"><span title="长期会话主题">主题</span><b>${highlightedSearchText(topic)}</b></p>` : ""}
      ${showGoal ? `<p class="task-message">${highlightedSearchText(goal)}</p>` : ""}
      <p class="task-progress-line"><span>${displayStatus === "disconnected" ? "状态" : isAttentionTask(session) ? "待你" : ["idle", "completed"].includes(session.status) ? "结果" : "进展"}</span><b>${highlightedSearchText(progress)}</b></p>
      ${match?.snippet ? `<p class="task-match"><span>匹配</span><b>${highlightedSearchText(match.snippet)}</b></p>` : ""}
      ${waiting}${liveness}
      <footer>
        <span>${escapeHtml(controlChannelLabel(session))}</span>
        <b>打开任务 →</b>
      </footer>
    </article>`;
}

function taskGroup(name, sessions, collapsed = false) {
  const cards = `<div class="project-task-list">${sessions.map(taskCard).join("")}</div>`;
  if (!collapsed || sessions.length === 1) return `<section class="project-group"><header class="project-group-header"><h3>${escapeHtml(name)}</h3><span>${sessions.length} 个任务</span></header>${cards}</section>`;
  const groupKey = `${state.filter}:${name}`;
  const open = state.expandedGroups.has(groupKey);
  return `<details class="project-group project-group-collapsed" data-group-key="${escapeHtml(groupKey)}"${open ? " open" : ""}><summary><span>${escapeHtml(name)}</span><small>${sessions.length} 个记录</small></summary>${cards}</details>`;
}

function render() {
  const resultRank = new Map(Array.from(state.searchResults.keys()).map((id, index) => [id, index]));
  const sessions = Array.from(state.sessions.values()).sort((a, b) => {
    if (state.searchQuery && state.searchReady) {
      const left = resultRank.has(a.id) ? resultRank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const right = resultRank.has(b.id) ? resultRank.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
    }
    return compareTaskUrgency(a, b);
  });
  const userTasks = sessions.filter(isUserTask);
  const visible = sessions.filter(filterMatches);
  elements.countRecent.textContent = userTasks.filter(isRecentTask).length;
  elements.countAttention.textContent = userTasks.filter(isAttentionTask).length;
  elements.countActive.textContent = userTasks.filter(isActiveTask).length;
  elements.countHistory.textContent = userTasks.filter((session) => !isRecentTask(session)).length;
  elements.countAll.textContent = userTasks.length;
  const overview = inboxOverview(userTasks);
  elements.actionInbox.hidden = overview.attention === 0;
  if (overview.attention) {
    elements.actionInboxCount.textContent = overview.attention;
    elements.actionInboxTitle.textContent = overview.actionable
      ? `${overview.actionable} 项等待你的操作`
      : `${overview.attention} 项需要查看`;
    elements.actionInboxReason.textContent = overview.top?.inbox?.reason || "打开后按优先级处理";
  }
  updateSyncSummary();
  if (state.searchQuery) {
    elements.list.innerHTML = visible.length ? taskGroup("搜索结果", visible, false) : "";
  } else {
    const groups = new Map();
    for (const session of visible) {
      const name = projectName(session);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(session);
    }
    const collapsed = state.filter === "history" || state.filter === "all";
    elements.list.innerHTML = Array.from(groups, ([name, items]) => taskGroup(name, items, collapsed)).join("");
  }
  elements.empty.hidden = visible.length > 0;
  elements.emptyTitle.textContent = state.searchQuery ? "没有找到匹配任务" : "还没有捕获到任务";
  elements.emptyCopy.textContent = state.searchQuery
    ? "试试任务目标、项目名称、机器、用户指令或 Codex 回复中的关键词。"
    : "启动一个 Codex Desktop 或 CLI 会话；安装后的 Hooks 会自动把状态送到这里。";
  elements.taskSearchClear.hidden = !state.searchQuery;
  elements.taskSearchSummary.hidden = !state.searchQuery;
  if (state.searchQuery) {
    elements.taskSearchSummary.textContent = state.searchError
      ? `完整历史暂时不可用；当前显示 ${visible.length} 个卡片字段匹配`
      : state.searchReady
      ? `找到 ${visible.length} 个任务 · 可检索已保留的用户指令与 Codex 回复`
      : "正在检索本机已保留历史；当前先显示卡片匹配结果";
  }
  renderTargetTracker();
  state.listDirty = false;
}

function scheduleRender({ force = false } = {}) {
  state.listDirty = true;
  if (!force && elements.detail.open) return;
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    if (state.listDirty) render();
  });
}

function updateFilterButtons() {
  for (const item of elements.filters.querySelectorAll("button[data-filter]")) {
    const active = item.dataset.filter === state.filter;
    item.classList.toggle("active", active);
    item.setAttribute("aria-current", active ? "true" : "false");
  }
}

function setTaskFilter(filter) {
  state.filter = ["recent", "attention", "active", "history", "all"].includes(filter) ? filter : "recent";
  updateFilterButtons();
  scheduleRender({ force: true });
}

function cancelTaskSearchRequest() {
  clearTimeout(state.searchTimer);
  state.searchTimer = null;
  state.searchController?.abort();
  state.searchController = null;
  state.searchRequestId += 1;
}

async function runTaskSearch() {
  const query = state.searchQuery;
  if (!query) return;
  const requestId = ++state.searchRequestId;
  const controller = new AbortController();
  state.searchController?.abort();
  state.searchController = controller;
  state.searchError = null;
  try {
    const params = new URLSearchParams({ q: query, limit: "100" });
    const payload = await request(`/api/tasks/search?${params}`, { signal: controller.signal, timeoutMs: 8_000 });
    if (requestId !== state.searchRequestId || query !== state.searchQuery) return;
    state.searchResults = new Map((payload.results || []).map((result) => [result.id, result]));
    state.searchReady = true;
  } catch (error) {
    if (requestId !== state.searchRequestId || query !== state.searchQuery) return;
    state.searchReady = false;
    state.searchError = error.message;
  } finally {
    if (requestId === state.searchRequestId) state.searchController = null;
    scheduleRender({ force: true });
  }
}

function queueTaskSearch(delayMs = 180) {
  clearTimeout(state.searchTimer);
  state.searchTimer = null;
  state.searchController?.abort();
  state.searchController = null;
  state.searchRequestId += 1;
  state.searchResults = new Map();
  state.searchReady = false;
  state.searchError = null;
  if (!state.searchQuery) return;
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    void runTaskSearch();
  }, delayMs);
}

function applyTaskSearch(value) {
  const query = String(value || "").trim().slice(0, 160);
  const starting = Boolean(query) && !state.searchQuery;
  const clearing = !query && Boolean(state.searchQuery);
  if (starting) {
    state.filterBeforeSearch = state.filter;
    setTaskFilter("all");
  }
  state.searchQuery = query;
  if (clearing) {
    cancelTaskSearchRequest();
    state.searchResults = new Map();
    state.searchReady = false;
    state.searchError = null;
    const restore = state.filterBeforeSearch || "recent";
    state.filterBeforeSearch = null;
    setTaskFilter(restore);
    return;
  }
  queueTaskSearch();
  scheduleRender({ force: true });
}

function persistDraftsNow() {
  try {
    sessionStorage.setItem("phone-control-drafts-v1", JSON.stringify(Object.fromEntries(Array.from(state.drafts).slice(-20))));
  } catch {
    // Draft persistence is best-effort; live typing must remain available.
  }
}

function persistDraftsSoon() {
  clearTimeout(state.draftPersistTimer);
  state.draftPersistTimer = setTimeout(() => {
    state.draftPersistTimer = null;
    persistDraftsNow();
  }, 120);
}

function updateConnection(value, label) {
  const compactLabels = {
    online: "已连接",
    synced: "已同步",
    connecting: "连接中",
    paused: "后台暂停",
    offline: "已断开",
  };
  const compactLabel = compactLabels[value] || label;
  elements.connection.dataset.state = value;
  elements.connection.querySelector("b").textContent = compactLabel;
  const online = value === "online";
  const context = label && label !== compactLabel ? `；${label}` : "";
  elements.connection.setAttribute("aria-label", online ? "实时连接正常；点按立即检查机器" : `${compactLabel}${context}；点按立即连接机器`);
  elements.connection.title = online ? "实时连接正常；点按立即检查" : `${compactLabel}；点按立即重试连接`;
  updateSyncSummary();
}

function updateSyncSummary() {
  if (!elements.syncSummary) return;
  const tasks = Array.from(state.sessions.values()).filter(isUserTask);
  const working = tasks.filter((session) => session.status === "working" && session.liveness === "recent").length;
  const waiting = tasks.filter((session) => session.status === "waiting" && session.liveness === "recent").length;
  const today = new Date().toISOString().slice(0, 10);
  const done = tasks.filter((session) => ["idle", "completed"].includes(session.status) && session.updatedAt.startsWith(today)).length;
  const freshness = state.lastSyncAt ? `${relativeTime(state.lastSyncAt)}同步` : "正在同步";
  const summary = [];
  if (waiting) summary.push(`${waiting} 项等你处理`);
  if (working) summary.push(`${working} 个执行中`);
  if (done) summary.push(`今日完成 ${done} 个`);
  if (!waiting && !working && !done) summary.push(tasks.length ? "暂无运行任务" : "还没有会话");
  if (!waiting && !done && tasks.length) summary.push(`${tasks.length} 个会话`);
  summary.push(freshness);
  elements.syncSummary.textContent = summary.join(" · ");
}

function showPairing(show = true) {
  elements.pairing.hidden = !show;
  if (show) setTimeout(() => elements.pairingToken.focus(), 50);
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { elements.toast.hidden = true; }, 2_600);
}

async function writeClipboardText(value) {
  const text = String(value || "");
  if (!text) throw new Error("没有可复制的内容");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through for older browsers and non-secure LAN origins.
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.setAttribute("aria-hidden", "true");
  Object.assign(input.style, {
    position: "fixed",
    inset: "0 auto auto -9999px",
    width: "1px",
    height: "1px",
    opacity: "0",
    fontSize: "16px",
  });
  document.body.append(input);
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand?.("copy");
  input.remove();
  if (!copied) throw new Error("浏览器未允许复制");
}

async function copySessionId(button) {
  const value = button.dataset.copySessionId;
  const original = button.textContent;
  button.disabled = true;
  try {
    await writeClipboardText(value);
    button.textContent = "已复制";
    toast("Session 标识已复制");
    setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = original || "复制";
      button.disabled = false;
    }, 1_600);
  } catch (error) {
    button.disabled = false;
    toast(error?.message || "复制失败，请长按 Session 标识复制");
  }
}

async function request(path, options = {}) {
  const { timeoutMs = 8_000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        ...(fetchOptions.method && fetchOptions.method !== "GET" ? { "x-phone-control-client": "1" } : {}),
        ...(fetchOptions.headers || {}),
      },
    });
    if (response.status === 401) {
      showPairing(true);
      throw new Error("UNAUTHORIZED");
    }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    return response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("服务暂时未响应，正在恢复连接");
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function modelEffortLabel(value) {
  const labels = { none: "无", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大", ultra: "自动协作" };
  return labels[value] || value || "默认";
}

function modelById(id) {
  return (state.modelCatalog?.models || []).find((model) => model.id === id) || null;
}

function defaultModelSummary() {
  const configuration = state.modelCatalog?.configuration || {};
  return [configuration.model, configuration.reasoningEffort ? `推理 ${modelEffortLabel(configuration.reasoningEffort)}` : null]
    .filter(Boolean)
    .join(" · ") || "本机 Codex 配置";
}

function effectiveModelId(selected = "", session = null) {
  return selected || session?.model || state.modelCatalog?.configuration?.model || state.modelCatalog?.models?.find((model) => model.isDefault)?.id || "";
}

function effortDetail(model, effort) {
  return model?.reasoningEffortDetails?.find((item) => item.id === effort)?.description || "";
}

function fastTier(model) {
  return model?.serviceTiers?.find((tier) => tier.id === "priority" || tier.name?.toLowerCase() === "fast") || null;
}

function isFastServiceTier(value) {
  return value === "priority" || value === "fast";
}

function effortPills(modelId, selected = "", { inherit = false, inheritedEffort = "" } = {}) {
  const model = modelById(modelId);
  if (!model) return `<span class="choice-unavailable">模型目录暂不可用</span>`;
  const buttons = [];
  if (inherit) {
    buttons.push(`<button type="button" data-effort-value="" class="${selected ? "" : "active"}" aria-pressed="${selected ? "false" : "true"}">沿用${inheritedEffort ? ` · ${escapeHtml(modelEffortLabel(inheritedEffort))}` : ""}</button>`);
  } else {
    buttons.push(`<button type="button" data-new-effort-value="" class="${selected ? "" : "active"}" aria-pressed="${selected ? "false" : "true"}">默认 · ${escapeHtml(modelEffortLabel(model.defaultReasoningEffort))}</button>`);
  }
  for (const effort of model.supportedReasoningEfforts || []) {
    const attribute = inherit ? "data-effort-value" : "data-new-effort-value";
    buttons.push(`<button type="button" ${attribute}="${escapeHtml(effort)}" class="${effort === selected ? "active" : ""}" aria-pressed="${effort === selected ? "true" : "false"}">${escapeHtml(modelEffortLabel(effort))}</button>`);
  }
  return buttons.join("");
}

function workspaceCandidates(preferred = "") {
  const paths = [];
  if (preferred) paths.push(preferred);
  for (const workspace of state.modelCatalog?.workspaces || []) if (workspace.path) paths.push(workspace.path);
  for (const session of Array.from(state.sessions.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    if (isUserTask(session) && session.cwd) paths.push(session.cwd);
  }
  return paths.filter((cwd, index) => paths.indexOf(cwd) === index).slice(0, 8);
}

function workspaceDisplayMeta(cwd, allPaths) {
  const raw = String(cwd || "").trim() || "/";
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.at(-1) || normalized;
  const siblings = allPaths
    .map((path) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "") || "/")
    .filter((path) => (path.split("/").filter(Boolean).at(-1) || path) === name);
  let qualifier = parts.at(-2) || "/";
  if (siblings.length > 1) {
    const parents = parts.slice(0, -1);
    for (let depth = 1; depth <= Math.max(1, parents.length); depth += 1) {
      const candidate = parents.slice(-depth).join("/") || "/";
      const unique = siblings.filter((path) => {
        const siblingParts = path.split("/").filter(Boolean).slice(0, -1);
        return (siblingParts.slice(-depth).join("/") || "/") === candidate;
      }).length === 1;
      qualifier = candidate;
      if (unique) break;
    }
  }
  return { cwd: raw, name, qualifier };
}

function renderNewSessionWorkspaces(preferred = elements.newSessionCwd.value) {
  const workspaces = workspaceCandidates(preferred);
  const current = elements.newSessionCwd.value || preferred || workspaces[0] || "";
  if (!elements.newSessionCwd.value && current) elements.newSessionCwd.value = current;
  elements.workspaceOptions.innerHTML = workspaces.map((cwd) => `<option value="${escapeHtml(cwd)}">${escapeHtml(projectName({ cwd }))}</option>`).join("");
  const visible = workspaces.slice(0, 5);
  const rows = visible.map((cwd, index) => {
    const meta = workspaceDisplayMeta(cwd, workspaces);
    const active = cwd === current;
    const source = index === 0 && cwd === preferred ? "当前会话" : "最近使用";
    return `<button type="button" data-workspace-path="${escapeHtml(cwd)}" class="${active ? "active" : ""}" role="radio" aria-checked="${active ? "true" : "false"}" aria-label="${escapeHtml(`${meta.name}，${meta.qualifier}，${source}`)}">
      <span class="workspace-row-icon"><img src="/icons/folder-simple.svg" alt=""></span>
      <span class="workspace-row-copy"><b>${escapeHtml(meta.name)}</b><small>${escapeHtml(meta.qualifier)} · ${source}</small></span>
      <span class="workspace-row-check" aria-hidden="true"><img src="/icons/check.svg" alt=""></span>
    </button>`;
  }).join("");
  const selected = current ? workspaceDisplayMeta(current, workspaces) : null;
  const selectedPath = selected ? `<p class="workspace-selected-path"><span>已选路径</span><code>${escapeHtml(selected.cwd)}</code></p>` : "";
  elements.newSessionWorkspaces.innerHTML = rows ? `${rows}${selectedPath}` : `<span class="choice-unavailable">还没有最近项目，请输入路径</span>`;
  const isListed = workspaces.includes(current);
  elements.newSessionCustomWorkspace.open = Boolean(current && !isListed);
  const machine = state.modelCatalog?.machineName || "当前电脑";
  elements.newSessionMachine.textContent = machine;
  elements.newSessionWorkspaceHint.textContent = `只显示 ${machine} 上最近使用的项目；切换到另一台电脑的入口后，会读取那台电脑自己的路径。`;
  updateNewSessionSubmitSummary();
}

function updateNewSessionSubmitSummary() {
  const cwd = elements.newSessionCwd.value.trim();
  const project = cwd ? projectName({ cwd }) : "选择项目";
  const runtime = elements.newSessionRuntimeSummary.textContent || "本机默认";
  elements.newSessionSubmitSummary.textContent = `${project} · ${runtime}`;
}

function modelOptions(selected = "", inheritLabel = "沿用当前设置") {
  const options = [`<option value="">${escapeHtml(inheritLabel)}</option>`];
  for (const model of state.modelCatalog?.models || []) {
    options.push(`<option value="${escapeHtml(model.id)}"${model.id === selected ? " selected" : ""}>${escapeHtml(model.displayName || model.id)}${model.isDefault ? " · 推荐" : ""}</option>`);
  }
  return options.join("");
}

const permissionProfiles = Object.freeze({
  "read-only": { label: "只读", hint: "不允许写文件，也不会为写入操作弹出审批。" },
  "workspace-write": { label: "工作区内自动执行", hint: "可修改当前项目；工作区外与网络访问会被沙箱阻止。" },
  "workspace-write-network": { label: "工作区写入 + 网络", hint: "可修改当前项目并访问网络，适合 git push；不会访问工作区外文件。发送前会提示风险。" },
  "on-request": { label: "超出工作区时询问", hint: "项目内可正常工作；额外命令或文件权限会发送到手机审批。" },
  "danger-full-access": { label: "完全访问电脑", hint: "关闭沙箱并自动执行。风险很高，发送前会提示风险。" },
});

function needsPermissionReminder(profile) {
  return profile === "workspace-write-network" || profile === "danger-full-access";
}

function inheritedPermissionProfile(session) {
  const mode = String(session?.permissionMode || "").trim().toLowerCase();
  if (mode === "read-only" || mode === "readonly") return "read-only";
  if (mode === "workspace-write-network" || mode === "workspacewritenetwork") return "workspace-write-network";
  if (mode === "workspace-write" || mode === "workspacewrite") {
    return /on.?request/.test(String(session?.approvalPolicy || "").trim().toLowerCase()) ? "on-request" : "workspace-write";
  }
  if (mode === "danger-full-access" || mode === "dangerfullaccess") return "danger-full-access";
  return "";
}

function permissionProfileLabel(value, fallback = "沿用当前权限") {
  return permissionProfiles[value]?.label || fallback;
}

function permissionOptions(selected = "", inheritLabel = "沿用当前权限") {
  return [
    `<option value=""${selected ? "" : " selected"}>${escapeHtml(inheritLabel)}</option>`,
    ...Object.entries(permissionProfiles).map(([value, profile]) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(profile.label)}</option>`),
  ].join("");
}

function populateNewSessionModels() {
  const selected = elements.newSessionModel.value;
  elements.newSessionModel.innerHTML = modelOptions(selected, `跟随 Codex 默认 · ${defaultModelSummary()}`);
  elements.newSessionModel.value = modelById(selected) ? selected : "";
  const modelId = effectiveModelId(elements.newSessionModel.value);
  const model = modelById(modelId);
  const selectedEffort = model?.supportedReasoningEfforts?.includes(elements.newSessionEffort.value) ? elements.newSessionEffort.value : "";
  elements.newSessionEffort.value = selectedEffort;
  elements.newSessionEfforts.innerHTML = effortPills(modelId, selectedEffort);
  elements.newSessionEffortHint.textContent = selectedEffort
    ? effortDetail(model, selectedEffort) || `当前选择：${modelEffortLabel(selectedEffort)}`
    : `模型默认：${modelEffortLabel(model?.defaultReasoningEffort)}`;
  elements.newSessionModelDescription.textContent = model?.description || (model ? model.displayName : "模型目录暂不可用，将沿用 Codex 默认设置");
  const tier = fastTier(model);
  const inheritedTier = state.modelCatalog?.configuration?.serviceTier || model?.defaultServiceTier || "default";
  if (!state.newSessionTierTouched) elements.newSessionFast.checked = isFastServiceTier(inheritedTier);
  if (!tier) elements.newSessionFast.checked = false;
  elements.newSessionFast.disabled = !tier;
  elements.newSessionFastRow.classList.toggle("is-disabled", !tier);
  elements.newSessionFastHint.textContent = tier?.description || (tier ? "使用更高服务优先级" : "当前模型或账号未提供 Fast");
  const permissionProfile = elements.newSessionPermission.value;
  elements.newSessionPermissionHint.textContent = permissionProfiles[permissionProfile]?.hint || "未覆盖本机的审批与沙箱设置。";
  elements.newSessionModelHint.textContent = state.modelCatalog?.available
    ? `不调整时使用 ${defaultModelSummary()}；所选运行配置会延续到后续轮次。`
    : "模型目录暂不可用；仍可单独选择这个会话的权限。";
  const runtimeSummary = [
    elements.newSessionModel.value || state.modelCatalog?.configuration?.model || "本机默认",
    selectedEffort ? modelEffortLabel(selectedEffort) : null,
    elements.newSessionFast.checked && tier ? "Fast" : null,
    permissionProfile ? permissionProfileLabel(permissionProfile) : null,
  ].filter(Boolean).join(" · ");
  elements.newSessionRuntimeSummary.textContent = runtimeSummary;
  renderNewSessionWorkspaces();
}

function populateComposerModels() {
  for (const form of elements.detailActions.querySelectorAll("form[data-session-command]")) {
    const sessionId = form.dataset.sessionCommand;
    const session = state.detailSessions.get(sessionId) || state.sessions.get(sessionId);
    const selection = state.composerModelSelections.get(sessionId) || { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" };
    const current = [session?.model || "当前模型", session?.reasoningEffort ? `推理 ${modelEffortLabel(session.reasoningEffort)}` : null].filter(Boolean).join(" · ");
    const modelSelect = form.querySelector("[data-model-select]");
    if (!modelSelect) {
      updateComposerSettingsSummary(form, session, selection);
      continue;
    }
    modelSelect.innerHTML = modelOptions(selection.model, `沿用 ${current}`);
    modelSelect.value = modelById(selection.model) ? selection.model : "";
    const modelId = effectiveModelId(selection.model, session);
    const model = modelById(modelId);
    const description = form.querySelector(".model-choice > small");
    if (description) description.textContent = model?.description || "选择后会从下一轮开始持续生效";
    const pills = form.querySelector(".effort-pills");
    if (pills) pills.innerHTML = effortPills(modelId, selection.reasoningEffort, { inherit: true, inheritedEffort: session?.reasoningEffort });
    const fast = form.querySelector("[data-fast-toggle]");
    const tier = fastTier(model);
    if (fast) {
      const effectiveTier = selection.serviceTier || session?.serviceTier || state.modelCatalog?.configuration?.serviceTier || model?.defaultServiceTier || "default";
      fast.disabled = !tier;
      fast.checked = Boolean(tier && isFastServiceTier(effectiveTier));
      fast.closest(".fast-switch")?.classList.toggle("is-disabled", !tier);
      const hint = fast.closest(".fast-switch")?.querySelector("small");
      if (hint) hint.textContent = tier?.description || "当前模型或账号未提供 Fast";
    }
    updateComposerSettingsSummary(form, session, selection);
  }
  if (elements.runtimeSettingsDialog.open && state.runtimeSessionId) renderRuntimeSettingsDialog(state.runtimeSessionId);
}

function updateComposerSettingsSummary(form, session, selection) {
  const summary = form?.querySelector("[data-runtime-summary]");
  if (!summary || !session) return;
  const effectiveTier = selection.serviceTier || session.serviceTier || state.modelCatalog?.configuration?.serviceTier || "default";
  const hasOverrides = Boolean(selection.model || selection.reasoningEffort || selection.serviceTier || selection.cwd || selection.permissionProfile);
  const value = hasOverrides
    ? [selection.model || `沿用 ${session.model || "当前模型"}`, selection.reasoningEffort ? `推理 ${modelEffortLabel(selection.reasoningEffort)}` : null, isFastServiceTier(effectiveTier) ? "Fast" : null, selection.permissionProfile ? permissionProfileLabel(selection.permissionProfile) : null].filter(Boolean).join(" · ")
    : [session.model || "当前模型", session.reasoningEffort ? `推理 ${modelEffortLabel(session.reasoningEffort)}` : null, isFastServiceTier(session.serviceTier) ? "Fast" : null, permissionSummary(session, state.modelCatalog?.configuration)].filter(Boolean).join(" · ");
  summary.textContent = value;
}

async function loadModelCatalog({ force = false } = {}) {
  if (state.modelCatalogPromise && !force) return state.modelCatalogPromise;
  if (state.modelCatalog && !force) return state.modelCatalog;
  const loading = request(`/api/models${force ? "?refresh=1" : ""}`, { timeoutMs: 8_000 })
    .then((payload) => {
      state.modelCatalog = payload;
      populateNewSessionModels();
      populateComposerModels();
      return payload;
    })
    .catch((error) => {
      state.modelCatalog = { available: false, models: [], configuration: null };
      populateNewSessionModels();
      populateComposerModels();
      throw error;
    })
    .finally(() => {
      if (state.modelCatalogPromise === loading) state.modelCatalogPromise = null;
    });
  state.modelCatalogPromise = loading;
  return loading;
}

function replaceSessions(sessions) {
  state.sessions = new Map(sessions.map((session) => [session.id, session]));
  state.sessionsMutationRevision += 1;
  if (state.searchQuery) queueTaskSearch(350);
  scheduleRender();
}

function forgetSession(id) {
  if (!id) return;
  clearTimeout(state.detailRefreshTimer);
  state.detailRefreshTimer = null;
  for (const [key, controller] of state.detailRequestControllers) {
    if (!key.startsWith(`${id}:`)) continue;
    controller.abort();
    state.detailRequestControllers.delete(key);
  }
  state.sessions.delete(id);
  state.searchResults.delete(id);
  state.sessionsMutationRevision += 1;
  state.detailSessions.delete(id);
  state.detailFetchedAt.delete(id);
  state.historyVisibleTurns.delete(id);
  state.expandedComposers.delete(id);
  state.detailDirtySessions.delete(id);
  state.composerModelSelections.delete(id);
  state.drafts.delete(id);
  persistDraftsSoon();
  clearAttachments(id);
  hideSignal(id);
  if (state.targetSessionId === id) applyTargetSession(null);
  if (elements.detail.dataset.sessionId === id) {
    elements.detail.dataset.sessionId = "";
    if (elements.detail.open) elements.detail.close();
  }
}

async function refreshSessions({ notifyError = false, force = false } = {}) {
  if (state.sessionsRefreshPromise && !force) return state.sessionsRefreshPromise;
  const refreshId = ++state.sessionsRefreshId;
  const mutationRevision = state.sessionsMutationRevision;
  const promise = (async () => {
    try {
      const payload = await request("/api/sessions", { timeoutMs: 6_000 });
      if (refreshId !== state.sessionsRefreshId) return false;
      // A stream snapshot or incremental event that arrived after this request
      // started is newer than its response. Do not let the slower full-list
      // request temporarily remove and then re-add cards under the user's tap.
      if (mutationRevision === state.sessionsMutationRevision) replaceSessions(payload.sessions || []);
      state.lastSyncAt = Date.now();
      return true;
    } catch (error) {
      if (error.message !== "UNAUTHORIZED" && notifyError) toast(error.message);
      return false;
    } finally {
      if (refreshId === state.sessionsRefreshId) state.sessionsRefreshPromise = null;
    }
  })();
  state.sessionsRefreshPromise = promise;
  return state.sessionsRefreshPromise;
}

function unlockSignalSound() {
  if (!state.audioContext) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) state.audioContext = new AudioContext();
  }
  return state.audioContext?.resume?.();
}

function playSignalSound(kind = "complete") {
  if (!state.soundEnabled || !state.audioContext || state.audioContext.state !== "running") return;
  const frequencies = kind === "attention" ? [660, 660] : kind === "error" ? [330, 250] : [523, 784];
  const start = state.audioContext.currentTime;
  frequencies.forEach((frequency, index) => {
    const oscillator = state.audioContext.createOscillator();
    const gain = state.audioContext.createGain();
    const at = start + index * 0.12;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.055, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
    oscillator.connect(gain).connect(state.audioContext.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.11);
  });
}

function hideSignal(sessionId = null) {
  if (sessionId && elements.signalToast.dataset.sessionId !== sessionId) return;
  clearTimeout(showSignal.timer);
  showSignal.timer = null;
  if (elements.signalToast.matches?.(":popover-open")) elements.signalToast.hidePopover();
  elements.signalToast.classList.remove("fallback-open");
  delete elements.signalToast.dataset.sessionId;
}

function showSignal(session) {
  hideSignal();
  elements.signalToast.dataset.sessionId = session.id;
  elements.signalToast.querySelector(".signal-toast-mark").textContent = "✓";
  elements.signalToastTitle.textContent = "Codex 本轮已完成";
  elements.signalToastBody.textContent = `${projectName(session)} · 点按查看`;
  if (typeof elements.signalToast.showPopover === "function") {
    if (elements.signalToast.matches(":popover-open")) elements.signalToast.hidePopover();
    elements.signalToast.showPopover();
  } else {
    elements.signalToast.classList.add("fallback-open");
  }
  showSignal.timer = setTimeout(() => hideSignal(session.id), 6_000);
  playSignalSound("complete");
}

function currentNotificationSessionId() {
  const openSessionId = elements.detail.open ? elements.detail.dataset.sessionId : null;
  if (openSessionId && isUserTask(state.sessions.get(openSessionId))) return openSessionId;
  return Array.from(state.sessions.values())
    .filter(isUserTask)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id || null;
}

function rememberCompletion(key) {
  state.notifiedCompletions.add(key);
  const keys = Array.from(state.notifiedCompletions).slice(-100);
  state.notifiedCompletions = new Set(keys);
  localStorage.setItem("phone-control-notified-completions", JSON.stringify(keys));
}

function handleCompletion(payload) {
  const session = state.sessions.get(payload?.sessionId);
  const key = payload?.completionKey;
  if (!session || !isUserTask(session) || session.id !== currentNotificationSessionId()) return;
  if (!key || state.notifiedCompletions.has(key)) return;
  rememberCompletion(key);
  if (!state.soundEnabled && !state.pushSubscribed) return;

  if (document.visibilityState === "visible") {
    showSignal(session);
    return;
  }
  if (!state.pushSubscribed && "Notification" in window && Notification.permission === "granted") {
    const options = { body: payload.body, icon: "/icon.svg", tag: payload.tag, renotify: false, data: { url: payload.url } };
    navigator.serviceWorker?.ready
      .then((registration) => registration.showNotification(payload.title, options))
      .catch(() => new Notification(payload.title, options));
  }
}

function clearConnectionTimers() {
  clearTimeout(state.connectionGraceTimer);
  state.connectionGraceTimer = null;
  clearTimeout(state.streamFallbackTimer);
  state.streamFallbackTimer = null;
  clearInterval(state.streamWatchdogTimer);
  state.streamWatchdogTimer = null;
  clearTimeout(state.offlineProbeTimer);
  state.offlineProbeTimer = null;
}

function streamEventAge() {
  return state.lastStreamEventAt ? Date.now() - state.lastStreamEventAt : Number.POSITIVE_INFINITY;
}

function hasHealthyStream(maxAgeMs = STREAM_STALE_MS) {
  return Boolean(state.connected && state.stream && streamEventAge() <= maxAgeMs);
}

function showConnectionRecovery() {
  if (streamEventAge() <= CONNECTION_TRANSIENT_GRACE_MS && elements.connection.dataset.state === "online") return;
  if (state.lastSyncAt && Date.now() - state.lastSyncAt <= CONNECTION_HTTP_FRESH_MS) {
    updateConnection("synced", "已同步");
  } else {
    updateConnection("connecting", "实时恢复中");
  }
}

function markStreamAlive() {
  const now = Date.now();
  state.lastStreamEventAt = now;
  state.lastSyncAt = now;
  updateSyncSummary();
}

function startStreamWatchdog(generation) {
  clearInterval(state.streamWatchdogTimer);
  state.streamWatchdogTimer = setInterval(() => {
    if (generation !== state.streamGeneration || document.visibilityState === "hidden" || !state.stream) return;
    if (Date.now() - state.lastStreamEventAt <= STREAM_STALE_MS) return;
    state.stream.close();
    state.stream = null;
    state.connected = false;
    showConnectionRecovery();
    void resumeForeground();
  }, STREAM_WATCHDOG_MS);
}

function scheduleFallbackRefresh(delayMs = state.streamFallbackDelayMs) {
  if (state.streamFallbackTimer || state.connected || document.visibilityState === "hidden") return;
  state.streamFallbackTimer = setTimeout(async () => {
    state.streamFallbackTimer = null;
    if (state.connected) return;
    const synced = await refreshSessions();
    if (state.connected) return;
    if (synced) {
      if (streamEventAge() > CONNECTION_TRANSIENT_GRACE_MS) updateConnection("synced", "已同步");
      state.streamFallbackDelayMs = 5_000;
    } else {
      if (streamEventAge() > CONNECTION_TRANSIENT_GRACE_MS) updateConnection("connecting", "继续重试");
      state.streamFallbackDelayMs = Math.min(Math.max(5_000, state.streamFallbackDelayMs * 2), 30_000);
    }
    scheduleFallbackRefresh();
  }, delayMs);
}

function handleStreamError(generation) {
  if (generation !== state.streamGeneration) return;
  state.connected = false;
  clearTimeout(state.connectionGraceTimer);
  if (document.visibilityState !== "hidden") showConnectionRecovery();
  const graceDelay = Math.max(1_200, CONNECTION_TRANSIENT_GRACE_MS - streamEventAge());
  state.connectionGraceTimer = setTimeout(() => {
    if (generation !== state.streamGeneration || state.connected || document.visibilityState === "hidden") return;
    showConnectionRecovery();
  }, graceDelay);
  scheduleFallbackRefresh(250);
}

function connectStream() {
  state.stream?.close();
  clearConnectionTimers();
  state.connected = false;
  const generation = ++state.streamGeneration;
  let snapshotSettled = false;
  let settleSnapshot;
  const snapshotReady = new Promise((resolve) => { settleSnapshot = resolve; });
  const finishSnapshot = (ready) => {
    if (snapshotSettled) return;
    snapshotSettled = true;
    settleSnapshot(ready);
  };
  const connection = { generation, snapshotReady };
  state.lastStreamEventAt = Date.now();
  if (!state.lastSyncAt || Date.now() - state.lastSyncAt > 10_000) updateConnection("connecting", state.backgroundedAt ? "恢复现场" : "连接中");
  const stream = new EventSource("/api/events");
  state.stream = stream;
  startStreamWatchdog(generation);
  stream.addEventListener("open", () => {
    if (generation !== state.streamGeneration) return;
    clearConnectionTimers();
    state.streamFallbackDelayMs = 1_000;
    markStreamAlive();
    startStreamWatchdog(generation);
    if (!["online", "synced"].includes(elements.connection.dataset.state)) updateConnection("connecting", "同步会话");
  });
  stream.addEventListener("snapshot", (event) => {
    if (generation !== state.streamGeneration) return;
    markStreamAlive();
    const payload = JSON.parse(event.data);
    replaceSessions(payload.sessions || []);
    state.connected = true;
    updateConnection("online", "实时连接");
    finishSnapshot(true);
  });
  stream.addEventListener("ping", () => {
    if (generation !== state.streamGeneration) return;
    markStreamAlive();
  });
  stream.addEventListener("session", (event) => {
    if (generation !== state.streamGeneration) return;
    markStreamAlive();
    const session = JSON.parse(event.data);
    const previous = state.sessions.get(session.id);
    state.sessions.set(session.id, session);
    state.sessionsMutationRevision += 1;
    if (state.searchQuery) queueTaskSearch(650);
    state.detailFetchedAt.delete(session.id);
    scheduleRender();
    if (elements.detail.open && elements.detail.dataset.sessionId === session.id) {
      const urgent = previous?.status !== session.status
        && ["waiting", "idle", "completed", "error", "aborted"].includes(session.status);
      queueDetailRefresh(session.id, { urgent });
    }
  });
  stream.addEventListener("outbox", (event) => {
    if (generation !== state.streamGeneration) return;
    markStreamAlive();
    const queued = JSON.parse(event.data);
    const session = state.sessions.get(queued?.sessionId);
    if (!session || !queued?.id) return;
    const current = Array.isArray(session.queuedCommands) ? session.queuedCommands.filter((entry) => entry.id !== queued.id) : [];
    if (!["delivered", "failed", "needs_review", "canceled", "expired"].includes(queued.status)) current.push(queued);
    current.sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
    const updated = { ...session, queuedCommands: current };
    state.sessions.set(session.id, updated);
    if (state.detailSessions.has(session.id)) state.detailSessions.set(session.id, { ...state.detailSessions.get(session.id), queuedCommands: current });
    state.sessionsMutationRevision += 1;
    scheduleRender();
    if (elements.detail.open && elements.detail.dataset.sessionId === session.id) rerenderCachedDetail(session.id);
  });
  stream.addEventListener("session_removed", (event) => {
    if (generation !== state.streamGeneration) return;
    markStreamAlive();
    const { id } = JSON.parse(event.data);
    if (!id) return;
    forgetSession(id);
    scheduleRender();
  });
  stream.addEventListener("completion", (event) => {
    if (generation !== state.streamGeneration) return;
    markStreamAlive();
    handleCompletion(JSON.parse(event.data));
  });
  stream.addEventListener("error", () => {
    finishSnapshot(false);
    handleStreamError(generation);
  });
  return connection;
}

function pauseForBackground() {
  state.backgroundedAt = Date.now();
  state.foregroundResumeId += 1;
  state.foregroundResumePromise = null;
  state.sessionsRefreshId += 1;
  state.sessionsRefreshPromise = null;
  persistDraftsNow();
  state.stream?.close();
  state.stream = null;
  state.connected = false;
  state.streamGeneration += 1;
  clearConnectionTimers();
  updateConnection("paused", "后台暂停");
}

function firstSuccessful(promises, timeoutMs) {
  return new Promise((resolve) => {
    let remaining = promises.length;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      if (value) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
        return;
      }
      remaining -= 1;
      if (!remaining) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    for (const promise of promises) Promise.resolve(promise).then(finish, () => finish(false));
  });
}

function resumeForeground({ notifyError = false, force = false } = {}) {
  if (document.visibilityState === "hidden") return Promise.resolve(false);
  if (!force && !state.backgroundedAt && hasHealthyStream()) return Promise.resolve(true);
  if (state.foregroundResumePromise && !force) return state.foregroundResumePromise;
  if (force) {
    state.foregroundResumeId += 1;
    state.foregroundResumePromise = null;
    state.sessionsRefreshId += 1;
    state.sessionsRefreshPromise = null;
  }
  const resumeId = ++state.foregroundResumeId;
  const promise = (async () => {
    // A mobile browser may report navigator.onLine=false while its VPN route is
    // already usable. Always perform real same-origin probes, and use both a
    // fresh snapshot request and SSE so either channel can restore the UI.
    const connection = connectStream();
    const fetched = refreshSessions({ notifyError, force: true });
    const ready = await firstSuccessful([connection.snapshotReady, fetched], 6_500);
    if (resumeId !== state.foregroundResumeId || document.visibilityState === "hidden") return false;
    if (ready && !state.connected) updateConnection("synced", "已同步");
    if (!ready) {
      updateConnection("connecting", "继续重试");
      scheduleFallbackRefresh(500);
    }
    state.backgroundedAt = 0;
    return ready;
  })();
  state.foregroundResumePromise = promise.finally(() => {
    if (resumeId === state.foregroundResumeId) state.foregroundResumePromise = null;
  });
  return state.foregroundResumePromise;
}

function reconnectNow() {
  if (state.manualReconnectPromise) return state.manualReconnectPromise;
  if (document.visibilityState === "hidden") {
    toast("回到页面前台后即可立即联通");
    return Promise.resolve(false);
  }
  const startedAt = Date.now();
  elements.connection.disabled = true;
  elements.connection.setAttribute("aria-busy", "true");
  updateConnection("connecting", "立即联通");
  const attempt = (async () => {
    const ready = await resumeForeground({ force: true });
    const remainingFeedbackMs = 280 - (Date.now() - startedAt);
    if (remainingFeedbackMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingFeedbackMs));
    if (ready) {
      if (!state.connected) updateConnection("synced", "机器已联通");
      toast(state.connected ? "实时连接正常" : "机器已联通，实时通道恢复中");
      return true;
    }
    updateConnection("connecting", "点按重试");
    scheduleFallbackRefresh(500);
    toast("暂时未联通，后台会继续重试");
    return false;
  })();
  state.manualReconnectPromise = attempt.finally(() => {
    elements.connection.disabled = false;
    elements.connection.removeAttribute("aria-busy");
    state.manualReconnectPromise = null;
  });
  return state.manualReconnectPromise;
}

function detailInteractionActive(sessionId) {
  const active = document.activeElement;
  return state.detailDirtySessions.has(sessionId)
    || (state.detailScrollingSessionId === sessionId && Date.now() < state.detailScrollingUntil)
    || Boolean(active && (elements.detailActions.contains(active) || elements.detailContent.contains(active)) && active.matches("textarea, input, select, [contenteditable]"));
}

function markDetailUpdatePending(sessionId) {
  state.pendingDetailSessionId = sessionId;
  const button = elements.detail.querySelector("[data-refresh-detail]");
  if (button) button.hidden = false;
}

function clearDetailUpdatePending(sessionId) {
  if (state.pendingDetailSessionId === sessionId) state.pendingDetailSessionId = null;
  const button = elements.detail.querySelector("[data-refresh-detail]");
  if (button) button.hidden = true;
}

function queueDetailRefresh(sessionId, { urgent = false } = {}) {
  clearTimeout(state.detailRefreshTimer);
  if (detailInteractionActive(sessionId)) {
    markDetailUpdatePending(sessionId);
    return;
  }
  state.detailRefreshTimer = setTimeout(() => {
    if (detailInteractionActive(sessionId)) {
      markDetailUpdatePending(sessionId);
      return;
    }
    void showDetails(sessionId, { open: false, preserveView: true });
  }, urgent ? 80 : 650);
}

async function bootstrap() {
  if (await resumeForeground({ notifyError: true })) {
    void syncTargetSession();
    void syncPushStatus({ repair: true });
    if (state.requestedSessionId && state.sessions.has(state.requestedSessionId)) {
      const id = state.requestedSessionId;
      state.requestedSessionId = null;
      history.replaceState(null, "", "/");
      void showDetails(id);
    }
  } else if (elements.pairing.hidden) {
    if (!state.connected) updateConnection("connecting", "继续重试");
  }
}

function activityItems(events = []) {
  const labels = {
    user_prompt: "你发出了新指令",
    assistant_message: "Codex 回复",
    permission_request: "Codex 等待你的审批",
    question: "Codex 等待你的回答",
    approval_resolved: "手机审批已送达",
    question_answered: "手机回答已送达",
    question_unavailable: "回答通道已失效",
    phone_input_sent: "手机指令已送达",
    phone_interrupt_sent: "手机已请求停止",
    turn_start: "Codex 开始执行",
    turn_complete: "本轮执行完成",
    session_end: "会话已结束",
    error: "执行出错",
    aborted: "执行已中止",
  };
  const items = [];
  let tools = null;
  const flushTools = () => {
    if (!tools) return;
    items.push({ id: `tool-summary-${tools.at}`, kind: "tool_summary", at: tools.at, title: `运行了 ${tools.count} 个工具`, message: [...tools.names].slice(0, 4).join("、") });
    tools = null;
  };
  for (const event of events) {
    if (event.kind === "tool_start") {
      if (!tools) tools = { count: 0, names: new Set(), at: event.at };
      tools.count += 1;
      if (event.tool?.name) tools.names.add(event.tool.name);
      tools.at = event.at;
      continue;
    }
    if (["tool_end", "working", "activity", "subagent_start", "subagent_stop"].includes(event.kind)) continue;
    flushTools();
    const title = labels[event.kind];
    if (!title) continue;
    const message = event.message?.text ? String(event.message.text).trim() : "";
    const previous = items.at(-1);
    if (previous?.kind === event.kind && previous.message === message) {
      previous.at = event.at;
      continue;
    }
    items.push({ id: event.eventId || `${event.kind}-${event.at}`, kind: event.kind, at: event.at, title, message });
  }
  flushTools();
  return items.reverse();
}

function strongMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
}

function safeWebHref(value) {
  let candidate = String(value || "").trim();
  if (/^www\./i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function trimBareUrl(value) {
  let url = String(value);
  let suffix = "";
  let changed = true;
  while (url && changed) {
    changed = false;
    while (/[.,!?;:，。！？；：、]$/.test(url)) {
      suffix = `${url.at(-1)}${suffix}`;
      url = url.slice(0, -1);
      changed = true;
    }
    for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      if (!url.endsWith(closing)) continue;
      const openings = url.split(opening).length - 1;
      const closings = url.split(closing).length - 1;
      if (closings <= openings) continue;
      suffix = `${closing}${suffix}`;
      url = url.slice(0, -1);
      changed = true;
    }
  }
  return { url, suffix };
}

function webLink(label, href) {
  const safeHref = safeWebHref(href);
  if (!safeHref) return null;
  return `<a class="external-link" href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${strongMarkdown(label)}</a>`;
}

function linkedMarkdown(value) {
  const source = String(value);
  const token = /<((?:https?:\/\/)[^\s<>]+)>|\[([^\]\n]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)|\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
  const output = [];
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    output.push(strongMarkdown(source.slice(cursor, match.index)));
    if (match[1]) {
      output.push(webLink(match[1], match[1]) || strongMarkdown(match[0]));
    } else if (match[2]) {
      output.push(webLink(match[2], match[3]) || strongMarkdown(match[0]));
    } else {
      const { url, suffix } = trimBareUrl(match[4]);
      output.push(webLink(url, url) || strongMarkdown(url));
      output.push(strongMarkdown(suffix));
    }
    cursor = match.index + match[0].length;
  }
  output.push(strongMarkdown(source.slice(cursor)));
  return output.join("");
}

function inlineMarkdown(value) {
  return String(value).split(/(`[^`\n]+`)/g).map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    }
    return linkedMarkdown(part);
  }).join("");
}

function splitMarkdownTableRow(line) {
  let source = String(line).trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|")) source = source.slice(0, -1);
  const cells = [];
  let current = "";
  let escaped = false;
  let inCode = false;
  for (const character of source) {
    if (escaped) {
      current += character === "|" ? "|" : `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "`") {
      inCode = !inCode;
      current += character;
    } else if (character === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function markdownTableAt(lines, index) {
  if (!lines[index]?.includes("|") || index + 1 >= lines.length) return null;
  const headers = splitMarkdownTableRow(lines[index]);
  const delimiters = splitMarkdownTableRow(lines[index + 1]);
  if (headers.length < 2 || delimiters.length !== headers.length) return null;
  if (!delimiters.every((cell) => /^:?-{3,}:?$/.test(cell.replaceAll(" ", "")))) return null;
  const alignments = delimiters.map((cell) => {
    const value = cell.replaceAll(" ", "");
    if (value.startsWith(":") && value.endsWith(":")) return "center";
    if (value.endsWith(":")) return "right";
    return "left";
  });
  const rows = [];
  let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes("|")) {
    const cells = splitMarkdownTableRow(lines[cursor]);
    if (cells.length !== headers.length) break;
    rows.push(cells);
    cursor += 1;
  }
  return { headers, alignments, rows, nextIndex: cursor };
}

function markdownBlockStart(lines, index) {
  const line = lines[index] || "";
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line)
    || Boolean(markdownTableAt(lines, index));
}

function renderMarkdownBlocks(value) {
  const lines = String(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const output = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const fence = lines[index].match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(`<div class="timeline-code">${fence[1] ? `<span>${escapeHtml(fence[1])}</span>` : ""}<pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`);
      continue;
    }

    const table = markdownTableAt(lines, index);
    if (table) {
      const header = table.headers.map((cell, cellIndex) => `<th class="align-${table.alignments[cellIndex]}">${inlineMarkdown(cell)}</th>`).join("");
      const body = table.rows.map((row) => `<tr>${row.map((cell, cellIndex) => `<td class="align-${table.alignments[cellIndex]}">${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("");
      output.push(`<div class="timeline-table-wrap" role="region" aria-label="Codex 回复表格" tabindex="0"><table><thead><tr>${header}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`);
      index = table.nextIndex;
      continue;
    }

    const heading = lines[index].match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      output.push(`<h4>${inlineMarkdown(heading[1])}</h4>`);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(lines[index])) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${quote.map(inlineMarkdown).join("<br>")}</blockquote>`);
      continue;
    }

    const listItem = lines[index].match(/^\s*((?:[-+*])|(?:\d+[.)]))\s+(.+)$/);
    if (listItem) {
      const ordered = /^\d/.test(listItem[1]);
      const start = ordered ? Number.parseInt(listItem[1], 10) : null;
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*((?:[-+*])|(?:\d+[.)]))\s+(.+)$/);
        if (!match || /^\d/.test(match[1]) !== ordered) break;
        const value = ordered ? Number.parseInt(match[1], 10) : null;
        const valueAttribute = ordered && Number.isSafeInteger(value) ? ` value="${value}"` : "";
        const marker = ordered && Number.isSafeInteger(value)
          ? `<span class="list-marker" aria-hidden="true">${value}.</span>`
          : "";
        items.push(`<li${valueAttribute}>${marker}${ordered ? `<span>${inlineMarkdown(match[2])}</span>` : inlineMarkdown(match[2])}</li>`);
        index += 1;
      }
      const startAttribute = ordered && Number.isSafeInteger(start) ? ` start="${start}"` : "";
      output.push(`<${ordered ? "ol class=\"exact-list\"" : "ul"}${startAttribute}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && (!paragraph.length || !markdownBlockStart(lines, index))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    else index += 1;
  }
  return output.join("");
}

function richAssistantMessage(event) {
  const cached = state.richTextCache.get(event.id);
  if (cached?.message === event.message) return cached.html;
  const html = renderMarkdownBlocks(event.message);
  state.richTextCache.delete(event.id);
  state.richTextCache.set(event.id, { message: event.message, html });
  while (state.richTextCache.size > 160) state.richTextCache.delete(state.richTextCache.keys().next().value);
  return html;
}

function timelineMessage(event) {
  if (!event.message) return "";
  const expanded = state.expandedMessages.has(event.id);
  const content = event.kind === "assistant_message"
    ? `<div class="timeline-rich" data-timeline-text>${richAssistantMessage(event)}</div>`
    : `<p data-timeline-text>${escapeHtml(event.message)}</p>`;
  return `<div class="timeline-message${expanded ? " is-expanded" : ""}" data-message-id="${escapeHtml(event.id)}">
    ${content}
    <button class="timeline-expand" type="button" data-expand-message aria-expanded="${expanded}"${expanded ? "" : " hidden"}>
      ${expanded ? "收起 ↑" : "展开全文 ↓"}
    </button>
  </div>`;
}

function timelineItem(event) {
  return `<li data-kind="${escapeHtml(event.kind)}">
    <span></span>
    <div><b>${escapeHtml(event.title)}</b>${timelineMessage(event)}<small>${relativeTime(event.at)}</small></div>
  </li>`;
}

function conversationTurnStatus(turn) {
  let status = "working";
  for (const event of turn.events) {
    if (["permission_request", "question"].includes(event.kind)) status = "waiting";
    else if (event.kind === "turn_complete") status = "idle";
    else if (event.kind === "session_end") status = "completed";
    else if (event.kind === "error") status = "error";
    else if (event.kind === "aborted") status = "aborted";
    else if (["turn_start", "working", "activity", "tool_start"].includes(event.kind)) status = "working";
  }
  return status;
}

function conversationMessage(event, role) {
  const display = { id: event.id, kind: role === "assistant" ? "assistant_message" : "user_prompt", message: event.message };
  const copyButton = role === "assistant" ? `<button class="message-copy" type="button" data-copy-message="${escapeHtml(event.id)}" aria-label="复制这条 Codex 回复">复制</button>` : "";
  return `<section class="turn-message turn-${role}" data-message-event-id="${escapeHtml(event.id)}">
    <header><b>${role === "assistant" ? "Codex" : "你"}</b><span class="turn-message-meta"><time>${relativeTime(event.at)}</time>${copyButton}</span></header>
    ${timelineMessage(display)}
  </section>`;
}

function assistantMessageText(sessionId, messageId) {
  const session = state.detailSessions.get(sessionId);
  if (!session) return null;
  for (const turn of conversationTurns(session.events || [])) {
    const message = turn.assistantMessages.find((item) => item.id === messageId);
    if (message) return message.message;
  }
  return null;
}

function turnExpansionKey(sessionId, turnId) {
  return `${sessionId}:${turnId}`;
}

function turnProcess(turn, sessionId) {
  const items = activityItems(turn.events).filter((item) => !["user_prompt", "assistant_message"].includes(item.kind));
  if (!items.length) return "";
  const key = turnExpansionKey(sessionId, turn.id);
  const open = state.expandedTurnProcesses.has(key);
  return `<details class="turn-process" data-turn-process="${escapeHtml(key)}"${open ? " open" : ""}>
    <summary>运行详情 <span>${items.length} 项</span></summary>
    <ol class="timeline">${items.map((item) => timelineItem(item)).join("")}</ol>
  </details>`;
}

function conversationTurn(turn, { sessionId, session, result = null, resultTurnId = null, label = "对话轮次", older = false, current = false } = {}) {
  const status = conversationTurnStatus(turn);
  const { finalReply, updates } = assistantReplyGroups(turn);
  const model = turn.model || null;
  const effort = turn.reasoningEffort || null;
  const modelMeta = [model, effort ? `推理 ${modelEffortLabel(effort)}` : null, isFastServiceTier(turn.serviceTier) ? "Fast" : null].filter(Boolean).join(" · ");
  const showStatus = current || !["idle", "completed"].includes(status);
  const expansionKey = turnExpansionKey(sessionId, turn.id);
  const updatesOpen = state.expandedTurnUpdates.has(expansionKey);
  const turnResult = resultTurnId && String(resultTurnId) === String(turn.id) && session
    ? taskResultMarkup(session, result)
    : "";
  return `<article class="conversation-turn" data-status="${escapeHtml(status)}"${current ? " data-current-turn" : ""}${older ? " data-older-turn" : ""}>
    <header class="turn-header"><span><b class="turn-position">${escapeHtml(label)}</b><small>${escapeHtml(modelMeta || "模型/推理等级未记录")}</small></span>${showStatus ? `<span class="turn-status">${labels[status] || labels.unknown}</span>` : ""}</header>
    ${turn.userMessages.map((message) => conversationMessage(message, "user")).join("")}
    ${updates.length ? `<details class="turn-updates" data-turn-updates="${escapeHtml(expansionKey)}"${updatesOpen ? " open" : ""}><summary>${updates.length} 条过程回复</summary>${updates.map((message) => conversationMessage(message, "assistant")).join("")}</details>` : ""}
    ${finalReply ? conversationMessage(finalReply, "assistant") : `<p class="turn-pending">Codex 正在处理这一轮，完成后结果会显示在这里。</p>`}
    ${turnResult}
    ${turnProcess(turn, sessionId)}
  </article>`;
}

function conversation(events, session) {
  const sessionId = session.id;
  const turns = conversationTurns(events);
  const result = session.result || null;
  const resultTurnId = result?.turnId
    || turns.find((turn) => ["idle", "completed", "error", "aborted"].includes(conversationTurnStatus(turn)))?.id
    || null;
  const partial = Boolean(state.detailSessions.get(sessionId)?.eventsPartial);
  if (!turns.length && !partial) return `<p class="detail-empty">还没有可显示的对话。</p>`;
  const recentLabels = ["当前轮次", "上一轮", "更早一轮"];
  const current = turns.slice(0, 3).map((turn, index) => conversationTurn(turn, { sessionId, session, result, resultTurnId, label: recentLabels[index], current: index === 0 })).join("");
  const older = turns.slice(3);
  if (!older.length && !partial) return current;
  const visibleCount = Math.min(older.length, state.historyVisibleTurns.get(sessionId) || 0);
  const shown = older.slice(0, visibleCount);
  const remaining = Math.max(0, older.length - shown.length);
  const nextCount = Math.min(8, remaining);
  const needsFullHistory = !remaining && partial;
  const loadLabel = remaining
    ? visibleCount
      ? `继续加载更早 ${nextCount} 轮`
      : `查看更早 ${nextCount} 轮`
    : "继续加载更早记录";
  const loadHint = remaining
    ? visibleCount
      ? `已显示 ${visibleCount} 轮 · 还剩 ${remaining} 轮`
      : partial ? "每次加载 8 轮" : `共 ${older.length} 轮较早对话`
    : "从本机读取后续历史";
  return `${current}
    ${shown.map((turn) => conversationTurn(turn, { sessionId, session, result, resultTurnId, label: "较早轮次", older: true })).join("")}
    <nav class="turn-more${visibleCount ? " has-history" : ""}" aria-label="较早对话轮次">
      ${remaining || needsFullHistory ? `<button class="history-load" type="button" data-expand-history data-needs-full-history="${needsFullHistory}" data-session-id="${escapeHtml(sessionId)}" aria-expanded="${Boolean(visibleCount)}"><b>${loadLabel}</b><small>${loadHint}</small></button>` : `<p class="history-end"><i aria-hidden="true"></i><span>已经到最早一轮</span></p>`}
      ${visibleCount ? `<button class="history-latest" type="button" data-collapse-history data-session-id="${escapeHtml(sessionId)}">回到最新并收起历史 ↑</button>` : ""}
    </nav>`;
}

function updateTimelineExpanders() {
  for (const row of elements.detailContent.querySelectorAll(".timeline-message")) {
    const text = row.querySelector("[data-timeline-text]");
    const button = row.querySelector("[data-expand-message]");
    if (!text || !button) continue;
    button.hidden = !row.classList.contains("is-expanded") && text.scrollHeight <= text.clientHeight + 2;
  }
}

function resizeComposerInput(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 48), 124)}px`;
}

function syncVisualViewport() {
  const viewport = window.visualViewport;
  const height = Math.max(1, Math.round(viewport?.height || window.innerHeight));
  const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
  document.documentElement.style.setProperty("--phone-viewport-top", `${top}px`);
  document.documentElement.style.setProperty("--phone-viewport-height", `${height}px`);
  const active = document.activeElement;
  if (elements.detail.open && active && elements.detailActions.contains(active) && active.matches("textarea, input, select, [contenteditable]")) {
    const composer = active.closest(".composer-surface");
    (composer || active).scrollIntoView({ block: "nearest", inline: "nearest" });
    composer?.querySelector(".command-submit")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function scheduleVisualViewportSync() {
  cancelAnimationFrame(scheduleVisualViewportSync.frame);
  scheduleVisualViewportSync.frame = requestAnimationFrame(syncVisualViewport);
}

function syncDetailLayoutState() {
  elements.detail.classList.toggle("composer-open", Boolean(elements.detailActions.querySelector(".session-composer")));
  elements.detail.classList.toggle("runtime-settings-open", Boolean(elements.runtimeSettingsDialog.open && state.runtimeSessionId === elements.detail.dataset.sessionId));
}

function rerenderCachedDetail(sessionId, { scrollTop = elements.detailContent.scrollTop, behavior = "auto" } = {}) {
  const session = state.detailSessions.get(sessionId);
  if (!session || elements.detail.dataset.sessionId !== sessionId) return;
  const technicalOpen = Boolean(elements.detailContent.querySelector(".technical-details[open]"));
  renderDetails(session);
  if (technicalOpen) elements.detailContent.querySelector(".technical-details")?.setAttribute("open", "");
  requestAnimationFrame(() => { elements.detailContent.scrollTo({ top: scrollTop, behavior }); });
}

function approvalPanel(session) {
  if (session.pendingApproval?.kind !== "permission" || !session.pendingApproval.canRespond) return "";
  return `
    <section class="approval-panel" data-approval-id="${escapeHtml(session.pendingApproval.id)}" data-session-id="${escapeHtml(session.id)}" data-turn-id="${escapeHtml(session.pendingApproval.turnId || session.turnId || "")}">
      <p class="eyebrow">ONE-TIME DECISION</p>
      <h3>Codex 正在等待你的决定</h3>
      <p>${escapeHtml(session.pendingApproval.reason)}</p>
      ${session.pendingApproval.details?.command ? `<pre>${escapeHtml(session.pendingApproval.details.command)}</pre>` : ""}
      ${session.pendingApproval.details?.path ? `<code>${escapeHtml(session.pendingApproval.details.path)}</code>` : ""}
      ${session.pendingApproval.details?.permissionRequest ? `<pre>${escapeHtml(session.pendingApproval.details.permissionRequest)}</pre>` : ""}
      <small>仅绑定本次请求，到期时间 ${escapeHtml(new Date(session.pendingApproval.expiresAt).toLocaleTimeString())}</small>
      <div class="approval-actions">
        <button class="deny" type="button" data-decision="deny">拒绝</button>
        <button class="allow" type="button" data-decision="allow">仅允许这一次</button>
      </div>
    </section>`;
}

function questionField(question, index) {
  const options = (question.options || []).map((option, optionIndex) => `
    <label class="question-option">
      <input type="radio" name="question-${index}" value="${escapeHtml(option.label)}">
      <span><b>${escapeHtml(option.label)}</b>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span>
    </label>`).join("");
  const textControl = question.isSecret
    ? `<input type="password" data-question-text maxlength="2000" autocomplete="off">`
    : `<textarea data-question-text maxlength="2000" rows="${question.options?.length ? 2 : 3}"></textarea>`;
  const freeform = question.options?.length
    ? question.isOther
      ? `<label class="other-answer">其他答案（填写后优先使用）${textControl}</label>`
      : ""
    : `<label class="other-answer">你的回答${textControl}</label>`;
  return `
    <fieldset class="question-field" data-question-id="${escapeHtml(question.id)}">
      <legend><span>${escapeHtml(question.header || `问题 ${index + 1}`)}</span>${escapeHtml(question.question)}</legend>
      ${options ? `<div class="question-options">${options}</div>` : ""}
      ${freeform}
    </fieldset>`;
}

function questionPanel(session) {
  const pending = session.pendingApproval;
  if (pending?.kind !== "question" || !pending.canRespond || !pending.id || !pending.questions?.length) return "";
  const expiry = pending.expiresAt
    ? `<small>Codex 预计在 ${escapeHtml(new Date(pending.expiresAt).toLocaleTimeString())} 自动处理；提交前会再次校验当前 turn。</small>`
    : `<small>答案只会发送给当前显示的 thread、turn 和这一次问题请求。</small>`;
  return `
    <form class="question-panel" data-question-request="${escapeHtml(pending.id)}" data-session-id="${escapeHtml(session.id)}" data-turn-id="${escapeHtml(pending.turnId || session.turnId || "")}">
      <p class="eyebrow">LIVE USER INPUT</p>
      <h3>Codex 正在等待你的回答</h3>
      ${pending.questions.map(questionField).join("")}
      ${expiry}
      <button class="answer-submit" type="submit">发送并让 Codex 继续</button>
      <p class="answer-status" role="status"></p>
    </form>`;
}

function composerModelSettings(session, action) {
  if (action === "steer") return "";
  const selection = state.composerModelSelections.get(session.id) || { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" };
  const current = [session.model || "当前模型", session.reasoningEffort ? `推理 ${modelEffortLabel(session.reasoningEffort)}` : null, isFastServiceTier(session.serviceTier) ? "Fast" : null, permissionSummary(session, state.modelCatalog?.configuration)].filter(Boolean).join(" · ");
  const effectiveTier = selection.serviceTier || session.serviceTier || state.modelCatalog?.configuration?.serviceTier || "default";
  const hasOverrides = Boolean(selection.model || selection.reasoningEffort || selection.serviceTier || selection.cwd || selection.permissionProfile);
  const summary = [selection.model || `沿用 ${session.model || "当前模型"}`, selection.reasoningEffort ? `推理 ${modelEffortLabel(selection.reasoningEffort)}` : null, isFastServiceTier(effectiveTier) ? "Fast" : null, selection.permissionProfile ? permissionProfileLabel(selection.permissionProfile) : null].filter(Boolean).join(" · ");
  return `<button class="turn-model-settings" type="button" data-open-runtime-settings="${escapeHtml(session.id)}" aria-haspopup="dialog" aria-controls="runtime-settings-dialog" aria-label="设置后续轮次的模型、推理与权限"><img src="/icons/sliders-horizontal.svg" alt=""><b data-runtime-summary>${escapeHtml(hasOverrides ? summary : current)}</b></button>`;
}

function runtimeSettingsMarkup(session) {
  const selection = state.composerModelSelections.get(session.id) || { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" };
  const modelId = effectiveModelId(selection.model, session);
  const model = modelById(modelId);
  const current = [session.model || "当前模型", session.reasoningEffort ? `推理 ${modelEffortLabel(session.reasoningEffort)}` : null, isFastServiceTier(session.serviceTier) ? "Fast" : null].filter(Boolean).join(" · ");
  const tier = fastTier(model);
  const effectiveTier = selection.serviceTier || session.serviceTier || state.modelCatalog?.configuration?.serviceTier || model?.defaultServiceTier || "default";
  const hasOverrides = Boolean(selection.model || selection.reasoningEffort || selection.serviceTier || selection.cwd || selection.permissionProfile);
  return `<header>
      <div><small>后续轮次</small><h3 id="runtime-settings-title">模型、推理与权限</h3></div>
      <button type="button" data-close-runtime aria-label="关闭运行配置"><img src="/icons/x.svg" alt=""></button>
    </header>
    <div class="composer-runtime-card">
      <label class="model-choice">模型
        <span class="select-shell"><select data-model-select>${modelOptions(selection.model, `沿用 ${current}`)}</select><img src="/icons/caret-down.svg" alt=""></span>
        <small>${escapeHtml(model?.description || "选择后会从下一轮开始持续生效")}</small>
      </label>
      <div class="effort-choice compact">
        <div><b>推理等级</b><small>${escapeHtml(selection.reasoningEffort ? effortDetail(model, selection.reasoningEffort) || modelEffortLabel(selection.reasoningEffort) : `沿用 ${modelEffortLabel(session.reasoningEffort || model?.defaultReasoningEffort)}`)}</small></div>
        <div class="effort-pills" role="radiogroup" aria-label="后续轮次推理等级">${effortPills(modelId, selection.reasoningEffort, { inherit: true, inheritedEffort: session.reasoningEffort })}</div>
      </div>
      <label class="fast-switch compact${tier ? "" : " is-disabled"}">
        <span><b>Fast</b><small>${escapeHtml(tier?.description || "当前模型或账号未提供 Fast")}</small></span>
        <input data-fast-toggle type="checkbox"${isFastServiceTier(effectiveTier) && tier ? " checked" : ""}${tier ? "" : " disabled"}><i aria-hidden="true"></i>
      </label>
      <label class="model-choice permission-choice">权限
        <span class="select-shell"><select data-permission-select>${permissionOptions(selection.permissionProfile, `沿用 ${permissionSummary(session, state.modelCatalog?.configuration)}`)}</select><img src="/icons/caret-down.svg" alt=""></span>
        <small>${escapeHtml(permissionProfiles[selection.permissionProfile]?.hint || "不覆盖时继续使用这个会话当前的审批与沙箱设置。")}</small>
      </label>
      ${hasOverrides ? `<button class="runtime-reset" type="button" data-reset-runtime>恢复当前会话设置</button>` : ""}
    </div>
    <p>提交下一条指令时生效，并延续到后续轮次。</p>`;
}

function renderRuntimeSettingsDialog(sessionId) {
  const session = state.detailSessions.get(sessionId) || state.sessions.get(sessionId);
  if (!session) return false;
  elements.runtimeSettingsContent.innerHTML = runtimeSettingsMarkup(session);
  return true;
}

function openRuntimeSettings(sessionId) {
  if (!renderRuntimeSettingsDialog(sessionId)) return;
  state.runtimeSessionId = sessionId;
  if (!elements.runtimeSettingsDialog.open) elements.runtimeSettingsDialog.showModal();
  syncDetailLayoutState();
}

function closeRuntimeSettings() {
  if (elements.runtimeSettingsDialog.open) elements.runtimeSettingsDialog.close();
  state.runtimeSessionId = null;
  syncDetailLayoutState();
}

function composerPanel(session) {
  const control = session.control;
  const queueable = isUserTask(session) && !control?.canSend && !control?.canAnswer && !control?.canApprove;
  const action = control?.canSend && control.action ? control.action : queueable ? "queue" : null;
  if (!action) return "";
  const labels = {
    steer: {
      eyebrow: "STEER ACTIVE TURN",
      context: "当前轮次",
      title: "追加指令",
      button: "追加",
      placeholder: "补充要求，或告诉 Codex 调整方向…",
      note: "发送前会再次校验当前 turn。",
    },
    start: {
      eyebrow: "CONTINUE SESSION",
      context: "下一轮",
      title: "继续会话",
      button: "开始下一轮",
      placeholder: "继续这个会话…",
      note: "默认沿用当前模型；展开后可为下一轮调整。",
    },
    resume: {
      eyebrow: "RESUME SESSION",
      context: "恢复后",
      title: "恢复会话",
      button: "恢复并开始",
      placeholder: "恢复并继续这个会话…",
      note: "先恢复本机 thread；可为新一轮调整模型。",
    },
    queue: {
      eyebrow: "QUEUE PHONE INSTRUCTION",
      context: "连接恢复后",
      title: "排队发送",
      button: "排队发送",
      placeholder: "先记下来，连接恢复后发送…",
      note: "会等待 Codex 连接或电脑释放后再尝试；turn 变化时会要求你确认。",
    },
  };
  const copy = labels[action];
  if (!copy) return "";
  const expectedTurnId = action === "queue" && ["working", "waiting"].includes(session.status)
    ? control?.expectedTurnId || session.turnId || ""
    : control?.expectedTurnId || "";
  const draft = state.drafts.get(session.id) || "";
  const attachments = state.attachments.get(session.id) || [];
  if (!state.expandedComposers.has(session.id)) {
    const saved = [draft ? "草稿已保存" : null, attachments.length ? `${attachments.length} 张图片待发送` : null].filter(Boolean).join(" · ");
    return `<section class="composer-launch">
      <button class="composer-launch-action" type="button" data-expand-composer="${escapeHtml(session.id)}">
        <span class="composer-launch-copy"><b>${copy.title}</b><small>${escapeHtml(saved || copy.note)}</small></span>
        <span class="composer-launch-cta"><span>${copy.button}</span><img src="/icons/paper-plane-tilt.svg" alt=""></span>
      </button>
    </section>`;
  }
  return `
    <form class="session-composer" data-session-command="${escapeHtml(session.id)}" data-expected-turn-id="${escapeHtml(expectedTurnId)}" data-control-action="${escapeHtml(action)}">
      <div class="composer-surface">
        <button class="composer-collapse" type="button" data-collapse-composer="${escapeHtml(session.id)}" aria-label="收起输入框"><img src="/icons/x.svg" alt=""></button>
        <textarea data-session-input maxlength="4000" rows="2" placeholder="${copy.placeholder}">${escapeHtml(draft)}</textarea>
        <div class="attachment-strip" data-attachment-strip>${attachmentMarkup(attachments)}</div>
        <div class="composer-submit-dock">
          <label class="attach-button${action === "queue" ? " is-disabled" : ""}" aria-label="${action === "queue" ? "排队发送暂不支持图片" : "添加图片"}" title="${action === "queue" ? "排队发送暂不支持图片" : "添加图片"}"><img src="/icons/image.svg" alt=""><span>图片</span><input data-image-input type="file" accept="image/jpeg,image/png,image/webp" multiple${action === "queue" ? " disabled" : ""}></label>
          ${composerModelSettings(session, action)}
          <span class="composer-input-count${draft.length ? "" : " is-empty"}" data-input-count>${draft.length}/4000</span>
          <button class="command-submit" type="submit" aria-label="${copy.button}" title="${copy.button}"><img src="/icons/paper-plane-tilt.svg" alt=""><span class="sr-only" data-command-label>${copy.button}</span></button>
        </div>
        <p class="command-status" role="status"></p>
      </div>
    </form>`;
}

function interruptPanel(session) {
  const control = session.control;
  if (!control?.canInterrupt || !control.expectedTurnId) return "";
  return `<section class="interrupt-control">
    <button class="interrupt-turn" type="button" data-interrupt-session="${escapeHtml(session.id)}" data-expected-turn-id="${escapeHtml(control.expectedTurnId)}">
      <span class="interrupt-mark" aria-hidden="true"></span>
      <span><b>停止</b><small>中断当前轮次，保留会话和已完成的工作</small></span>
    </button>
  </section>`;
}

function attachmentMarkup(attachments = []) {
  return attachments.map((attachment) => `
    <div class="attachment-preview" data-attachment-id="${escapeHtml(attachment.id)}">
      <img src="${escapeHtml(attachment.previewUrl)}" alt="待发送图片">
      <button type="button" data-remove-attachment="${escapeHtml(attachment.id)}" aria-label="移除图片">×</button>
      <small>${escapeHtml(attachment.label)}</small>
    </div>`).join("");
}

function isExternallyOwned(session) {
  const reason = String(session.control?.reason || "");
  return /another Codex runtime|active writer|observe-only/i.test(reason);
}

function sessionIdMarkup(id) {
  const value = String(id || "Unknown");
  return `<span class="session-id-wrap"><code class="session-id-value" title="完整 Session 标识">${escapeHtml(value)}</code><button class="session-id-copy" type="button" data-copy-session-id="${escapeHtml(value)}" aria-label="复制 Session 标识">复制</button></span>`;
}

function queuedCommandsMarkup(session) {
  const queued = Array.isArray(session.queuedCommands) ? session.queuedCommands : [];
  if (!queued.length) return "";
  const labels = {
    queued: "已排队",
    waiting: "等待条件",
    sending: "正在发送",
    delivered: "已送达",
    failed: "发送失败",
    needs_review: "需要确认",
    canceled: "已取消",
    expired: "已过期",
  };
  return `<section class="queued-commands" aria-label="排队中的手机指令">
    <div class="queued-commands-heading"><b>手机续作队列</b><small>连接恢复或电脑释放后会自动尝试</small></div>
    ${queued.map((entry) => `<article class="queued-command is-${escapeHtml(entry.status)}">
      <div><span class="queued-command-status">${escapeHtml(labels[entry.status] || entry.status)}</span>${entry.waitingFor ? `<small>${escapeHtml(entry.waitingFor === "desktop" ? "等待电脑释放" : entry.waitingFor === "turn" ? "等待当前轮次结束" : entry.waitingFor === "bridge" ? "等待 Codex 连接" : entry.waitingFor === "question" ? "等待问题处理" : entry.waitingFor === "approval" ? "等待审批处理" : "等待会话恢复")}</small>` : ""}</div>
      <p>${escapeHtml(entry.preview || "")}</p>
      ${["queued", "waiting", "sending"].includes(entry.status) ? `<button type="button" data-cancel-queued="${escapeHtml(entry.id)}">取消</button>` : entry.status === "needs_review" ? `<small>${escapeHtml(entry.lastError || "请刷新后决定是否重新发送")}</small>` : entry.lastError ? `<small>${escapeHtml(entry.lastError)}</small>` : ""}
    </article>`).join("")}
  </section>`;
}

function commandStateMarkup(session) {
  const command = commandStateView(session.commandState);
  if (!command) return "";
  return `<section class="command-lifecycle" data-tone="${escapeHtml(command.tone)}" aria-label="最近手机指令状态">
    <span class="command-lifecycle-mark" aria-hidden="true"></span>
    <div><small>最近手机指令</small><b>${escapeHtml(command.label)}</b><p>${escapeHtml(command.detail || "等待状态同步")}</p></div>
  </section>`;
}

function taskResultMarkup(session, rawResult = session.result) {
  const result = resultView(rawResult);
  if (!result?.hasContent) return "";
  const files = Array.isArray(result.files) ? result.files : [];
  const commands = Array.isArray(result.commands) ? result.commands : [];
  const testItems = Array.isArray(result.tests?.items) ? result.tests.items : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  // The final assistant reply is already rendered in its conversation turn.
  // Keep this card strictly for optional run metadata so the detail view does
  // not repeat the same answer twice.
  if (!files.length && !commands.length && !testItems.length && !warnings.length) return "";
  const resultKey = `${session.id}:${result.turnId || "latest"}`;
  const expanded = state.expandedResults.has(resultKey);
  const highlights = [
    files.length ? `${files.length} 个文件` : null,
    testItems.length ? result.testStatus : null,
    commands.length ? `${commands.length} 条命令` : null,
    warnings.length ? `${warnings.length} 条提醒` : null,
  ].filter(Boolean).join(" · ");
  return `<details class="task-result" data-task-result="${escapeHtml(resultKey)}" data-tone="${escapeHtml(result.tone)}"${expanded ? " open" : ""}>
    <summary class="task-result-summary">
      <span class="task-result-mark" aria-hidden="true">${result.status === "completed" ? "✓" : result.status === "failed" ? "!" : "■"}</span>
      <span class="task-result-heading"><small>附带信息</small><b>${escapeHtml(highlights || "查看运行附带信息")}</b></span>
      <span class="task-result-summary-meta">${result.completedAt ? `<time>${relativeTime(result.completedAt)}</time>` : ""}<i class="task-result-chevron" aria-hidden="true"></i></span>
    </summary>
    <div class="task-result-body">
      ${files.length ? `<div class="task-result-section"><b>涉及文件</b><ul class="task-result-files">${files.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul></div>` : ""}
      ${testItems.length ? `<div class="task-result-section"><b>${escapeHtml(result.testStatus)}</b><ul>${testItems.map((test) => `<li>${escapeHtml(test)}</li>`).join("")}</ul><small>这里只表示捕获到验证命令；是否通过以 Codex 最终回复和完整输出为准。</small></div>` : ""}
      ${commands.length ? `<details class="task-result-commands"><summary>运行记录 · ${commands.length}</summary><ul>${commands.map((command) => `<li><span>${escapeHtml(command.tool)}</span><code>${escapeHtml(command.summary)}</code></li>`).join("")}</ul></details>` : ""}
      ${warnings.length ? `<div class="task-result-warnings"><b>注意</b>${warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}</div>` : ""}
    </div>
  </details>`;
}

function controlChannelLabel(session) {
  if (sessionDisplayStatus(session) === "disconnected") return "连接已中断 · 只读";
  if (session.control?.handedOff) return "已移交电脑 · 手机只读";
  if (isExternallyOwned(session)) return "电脑端占用 · 只读";
  if (session.control?.canAnswer) return "现场回答";
  if (session.control?.canApprove) return "单次审批";
  if (session.control?.action === "steer") return "可追加指令";
  if (session.control?.action === "start") return "可继续会话";
  if (session.control?.action === "resume") return "可恢复会话";
  if (session.control?.reason?.startsWith("A stop request was delivered")) return "正在停止";
  if (session.control?.reason?.startsWith("Live control is synchronizing:")) return session.surface === "CLI" ? "CLI 可追踪 · 控制同步中" : "正在同步控制";
  if (session.control?.reason?.startsWith("Live control unavailable:")) return "控制已隔离 · 只读";
  if (!session.control?.live && session.liveness === "recent" && ["working", "waiting"].includes(session.status)) return "正在恢复连接";
  if (isUserTask(session) && !session.control?.canSend && !session.control?.canAnswer && !session.control?.canApprove) return "可排队续作";
  return session.control?.live ? "现场已验证" : "只读";
}

function controlExplanation(session) {
  if (!isUserTask(session)) return "这是内部、测试或诊断记录，只用于排查，不允许从手机继续执行。";
  if (sessionDisplayStatus(session) === "disconnected") return "上次执行没有收到完成或失败事件，Phone Control 已停止把它视为工作中。当前会话保持只读，避免把新指令发送到无法验证的旧 turn。";
  if (session.control?.handedOff) return session.control?.canReclaim
    ? "电脑端结束当前任务并完全关闭这个会话后，可点“手机接管”。Phone Control 会先确认会话已空闲，再恢复手机输入。"
    : "Phone Control 已释放这个桌面应用会话的写入占用；历史仍会同步，手机保持只读，不会自动抢回控制权。";
  if (isExternallyOwned(session)) return "这个会话仍由其他 Codex 客户端占用。请完全退出占用它的 Codex App/CLI 后，再点“手机接管”或恢复会话。";
  if (session.control?.canAnswer) return "这个问题已绑定到当前 Codex turn，回答后 Codex 会继续。";
  if (session.control?.canApprove) return "审批只对页面显示的这一次操作有效，过期后自动失效。";
  if (session.control?.action === "steer") return "手机指令会追加到当前正在执行的 turn；发送前会再次校验。";
  if (session.control?.action === "start") return "这个 thread 当前空闲，可以直接开始下一轮。";
  if (session.control?.action === "resume") return "Phone Control 会先恢复本机 thread，再开始下一轮。";
  if (session.control?.reason?.startsWith("A stop request was delivered")) return "停止请求已送达 Codex，正在等待当前 turn 确认结束。会话仍会保留。";
  if (session.control?.reason?.startsWith("Live control is synchronizing:")) return "任务状态与历史仍在正常追踪；Phone Control 正在重新验证实时控制通道，恢复后会自动开放可用操作。";
  if (session.control?.reason?.startsWith("Live control unavailable:")) return "Phone Control 已隔离这个会话的实时控制，避免异常大消息反复拖断其他会话；历史追踪仍可使用。重启服务后会重新验证。";
  if (session.control?.live) return "现场连接已验证，但当前状态暂不适合发送新指令。";
  if (session.liveness === "recent" && ["working", "waiting"].includes(session.status)) return "App Server 正在恢复连接；草稿会保留，连接验证完成后即可继续发送。";
  if (isUserTask(session) && !session.control?.canSend && !session.control?.canAnswer && !session.control?.canApprove) return "当前无法安全直发，但可以先把指令排入手机续作队列。连接恢复、电脑释放且 turn 状态重新验证后，系统才会发送；如果原 turn 已变化，会停在“需要确认”，不会误发。";
  return "当前只读追踪。Phone Control 没有验证到可安全控制的现场 thread。";
}

const canonicalDetailMarkup = new WeakMap();

function syncMarkup(element, markup, { canonical = false } = {}) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const normalized = template.innerHTML;
  if ((canonical ? canonicalDetailMarkup.get(element) : element.innerHTML) === normalized) return false;
  element.replaceChildren(template.content);
  if (canonical) canonicalDetailMarkup.set(element, normalized);
  return true;
}

function syncDetailContent({ control, conversationMarkup, retention, technical }) {
  let controlSlot = elements.detailContent.querySelector(":scope > [data-detail-control]");
  let conversationSlot = elements.detailContent.querySelector(":scope > [data-detail-conversation]");
  let retentionSlot = elements.detailContent.querySelector(":scope > [data-detail-retention]");
  let technicalSlot = elements.detailContent.querySelector(":scope > [data-detail-technical]");
  if (!controlSlot || !conversationSlot || !retentionSlot || !technicalSlot) {
    syncMarkup(elements.detailContent, `
      <div class="detail-update-slot"><button class="detail-update" type="button" data-refresh-detail hidden><span>有新状态</span>更新</button></div>
      <div data-detail-control></div>
      <div class="conversation" data-detail-conversation aria-label="对话历史"></div>
      <div data-detail-retention></div>
      <div data-detail-technical></div>`);
    controlSlot = elements.detailContent.querySelector(":scope > [data-detail-control]");
    conversationSlot = elements.detailContent.querySelector(":scope > [data-detail-conversation]");
    retentionSlot = elements.detailContent.querySelector(":scope > [data-detail-retention]");
    technicalSlot = elements.detailContent.querySelector(":scope > [data-detail-technical]");
  }
  syncMarkup(controlSlot, control);
  // Timeline expanders change their hidden state after layout. Compare the
  // canonical business markup here so that a control-only refresh does not
  // mistake that presentational DOM change for a new conversation.
  syncMarkup(conversationSlot, conversationMarkup, { canonical: true });
  syncMarkup(retentionSlot, retention);
  syncMarkup(technicalSlot, technical);
}

function renderDetails(session, { loading = false } = {}) {
  const displayStatus = sessionDisplayStatus(session);
  const approval = approvalPanel(session);
  const question = questionPanel(session);
  const composer = composerPanel(session);
  const interrupt = interruptPanel(session);
  const actionMode = question || approval || state.expandedComposers.has(session.id) ? "expanded" : "compact";
  const controlIsImportant = Boolean(
    session.control?.canAnswer
    || session.control?.canApprove
    || session.control?.handedOff
    || session.control?.reason?.startsWith("A stop request was delivered")
    || session.control?.reason?.startsWith("Live control unavailable:")
    || (isUserTask(session) && !session.control?.canSend && !session.control?.canAnswer && !session.control?.canApprove)
    || (!session.control?.live && session.liveness === "recent" && ["working", "waiting"].includes(session.status))
  );
  const showControlNotice = controlIsImportant || (!question && !approval && !composer);
  const deletionBlocked = ["working", "waiting"].includes(session.status);
  const technicalOpen = Boolean(elements.detailContent.querySelector(".technical-details[open]"));
  const detailActionCount = 2 + Number(session.taskKind === "user") + Number(Boolean(session.control?.canHandoff)) + Number(Boolean(session.control?.canReclaim));
  syncMarkup(elements.detailHeader, `
    <div class="detail-heading">
      <div class="detail-title-block">
        <h2>${escapeHtml(taskTitle(session))}</h2>
        <div class="detail-context-line">
          <span class="detail-status" data-status="${escapeHtml(displayStatus)}"><i aria-hidden="true"></i><b>${labels[displayStatus] || labels.unknown}</b></span>
          <span class="detail-project-context">${escapeHtml(projectName(session))} · ${escapeHtml(session.surface)}</span>
          <span class="detail-heading-actions${detailActionCount > 3 ? " is-full-row" : ""}" aria-label="会话快捷操作">
            <button class="target-toggle${state.targetSessionId === session.id ? " active" : ""}" type="button" data-target-session-id="${escapeHtml(session.id)}" aria-label="${state.targetSessionId === session.id ? "取消追踪这个会话" : "追踪这个会话"}" aria-pressed="${state.targetSessionId === session.id}" title="${state.targetSessionId === session.id ? "取消目标追踪" : "固定到手机顶部并只提醒这个会话"}"><img src="/icons/crosshair-simple.svg" alt=""><b>${state.targetSessionId === session.id ? "已追踪" : "追踪"}</b></button>
            <button class="task-title-jump" type="button" data-open-task-title>命名</button>
            ${session.taskKind === "user" ? `<button class="session-branch" type="button" data-branch-session="${escapeHtml(session.id)}" title="带着当前历史开一个可独立继续的新会话">分叉继续</button>` : ""}
            ${session.control?.canHandoff ? `<button class="session-handoff" type="button" data-handoff-session="${escapeHtml(session.id)}" title="释放 Phone Control 的会话占用，让电脑端继续">移交电脑</button>` : ""}
            ${session.control?.canReclaim ? `<button class="session-reclaim" type="button" data-reclaim-session="${escapeHtml(session.id)}" title="确认电脑端已释放后，重新由手机控制">手机接管</button>` : ""}
          </span>
        </div>
      </div>
    </div>
    `);
  syncDetailContent({
    control: `${commandStateMarkup(session)}${showControlNotice ? `<div class="control-note${controlIsImportant ? "" : " is-compact"}"><b>${escapeHtml(controlChannelLabel(session))}</b><p>${escapeHtml(controlExplanation(session))}</p></div>` : ""}${queuedCommandsMarkup(session)}`,
    conversationMarkup: loading ? `<div class="conversation-loading"><i></i><i></i><i></i></div>` : conversation(session.events, session),
    retention: session.historyTruncated ? `<p class="history-retention-note">较早的运行过程已压缩；提问和回复会优先保留。</p>` : "",
    technical: `<details class="technical-details"${technicalOpen ? " open" : ""}>
      <summary>会话设置与信息</summary>
      <form class="task-title-management" data-task-title-form="${escapeHtml(session.id)}">
        <div><b>卡片名称</b><small>${session.task?.customTitle ? `已手动命名 · 自动名称：${escapeHtml(session.task.autoTitle || projectName(session))}` : `自动跟随当前任务 · ${escapeHtml(session.task?.autoTitle || projectName(session))}`}</small></div>
        <label><span class="sr-only">自定义卡片名称</span><input data-task-title-input maxlength="80" value="${escapeHtml(session.task?.customTitle || "")}" placeholder="${escapeHtml(session.task?.autoTitle || "使用自动名称")}" autocomplete="off"></label>
        <div class="task-title-actions"><button class="task-title-suggest" type="button" data-suggest-task-title="${escapeHtml(session.id)}">智能生成</button>${session.task?.customTitle ? `<button class="task-title-reset" type="button" data-reset-task-title="${escapeHtml(session.id)}">恢复自动</button>` : ""}<button class="task-title-save" type="submit">保存</button></div>
        <p role="status" data-task-title-status>智能生成仅在点按时把最近几轮交给 Codex 概括，不写入会话历史。</p>
      </form>
      <dl class="detail-grid">
        <div><dt>模型</dt><dd>${escapeHtml(session.model || "Unknown")}${session.reasoningEffort || isFastServiceTier(session.serviceTier) ? `<small>${[session.reasoningEffort ? `推理 ${modelEffortLabel(session.reasoningEffort)}` : null, isFastServiceTier(session.serviceTier) ? "Fast" : null].filter(Boolean).map(escapeHtml).join(" · ")}</small>` : ""}</dd></div>
        <div><dt>权限</dt><dd>${escapeHtml(session.permissionMode || "Unknown")}</dd></div>
        <div><dt>目录</dt><dd title="${escapeHtml(session.cwd || "Unknown workspace")}">${escapeHtml(projectName(session))}</dd></div>
        <div><dt>Session</dt><dd>${sessionIdMarkup(session.id)}</dd></div>
      </dl>
      <div class="session-management">
        <div><b>永久删除 Codex 会话</b><small>${deletionBlocked ? displayStatus === "disconnected" ? "请先在电脑端确认旧 turn 已停止" : "请先停止或等待当前任务结束" : "删除原始记录、关联元数据及其子会话，不可恢复"}</small></div>
        <button class="session-delete" type="button" data-delete-session="${escapeHtml(session.id)}"${deletionBlocked ? " disabled" : ""}>${deletionBlocked ? displayStatus === "disconnected" ? "状态未验证" : "任务进行中" : "永久删除"}</button>
      </div>
    </details>`,
  });
  syncMarkup(elements.detailActions, loading ? "" : `<div class="action-dock is-${actionMode}${interrupt ? " has-interrupt" : ""}">${question || approval || composer}${interrupt}</div>`);
  syncDetailLayoutState();
  if (!loading) requestAnimationFrame(updateTimelineExpanders);
}

function collectAnswers(form) {
  const answers = {};
  for (const field of form.querySelectorAll(".question-field")) {
    const text = field.querySelector("[data-question-text]")?.value.trim();
    const selected = field.querySelector('input[type="radio"]:checked')?.value;
    const answer = text || selected;
    if (!answer) throw new Error("请回答所有问题后再发送");
    answers[field.dataset.questionId] = [answer];
  }
  return answers;
}

async function answerQuestion(form) {
  const button = form.querySelector(".answer-submit");
  const status = form.querySelector(".answer-status");
  let answers;
  try {
    answers = collectAnswers(form);
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  button.disabled = true;
  button.textContent = "正在送达…";
  status.textContent = "正在校验现场会话绑定";
  try {
    await request(`/api/questions/${encodeURIComponent(form.dataset.questionRequest)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: form.dataset.sessionId,
        turnId: form.dataset.turnId,
        answers,
      }),
    });
    status.textContent = "已送达，Codex 正在继续";
    toast("回答已送达 Codex");
    state.detailDirtySessions.delete(form.dataset.sessionId);
    await refreshSessions();
    await showDetails(form.dataset.sessionId, { open: false });
  } catch (error) {
    button.disabled = false;
    button.textContent = "发送并让 Codex 继续";
    status.textContent = error.message;
  }
}

async function saveTaskTitle(form, { reset = false } = {}) {
  const sessionId = form.dataset.taskTitleForm;
  const input = form.querySelector("[data-task-title-input]");
  const status = form.querySelector("[data-task-title-status]");
  const buttons = form.querySelectorAll("button");
  const title = reset ? null : input.value.trim();
  for (const button of buttons) button.disabled = true;
  status.textContent = reset ? "正在恢复自动名称…" : "正在保存…";
  try {
    const payload = await request(`/api/sessions/${encodeURIComponent(sessionId)}/task-title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title || null }),
    });
    const summary = payload.session;
    state.sessions.set(sessionId, summary);
    state.sessionsMutationRevision += 1;
    const detail = state.detailSessions.get(sessionId);
    if (detail) state.detailSessions.set(sessionId, { ...detail, ...summary, events: detail.events });
    state.detailDirtySessions.delete(sessionId);
    clearDetailUpdatePending(sessionId);
    if (state.searchQuery) queueTaskSearch(0);
    scheduleRender({ force: true });
    rerenderCachedDetail(sessionId);
    toast(summary.task?.customTitle ? "卡片名称已保存" : "已恢复自动任务名称");
  } catch (error) {
    for (const button of buttons) button.disabled = false;
    status.textContent = error.message;
  }
}

async function suggestTaskTitle(form) {
  const sessionId = form.dataset.taskTitleForm;
  const input = form.querySelector("[data-task-title-input]");
  const status = form.querySelector("[data-task-title-status]");
  const buttons = form.querySelectorAll("button");
  for (const button of buttons) button.disabled = true;
  status.textContent = "Codex 正在概括最近任务…";
  try {
    const payload = await request(`/api/sessions/${encodeURIComponent(sessionId)}/task-title/suggest`, {
      method: "POST",
      timeoutMs: 55_000,
    });
    input.value = payload.suggestion.title;
    state.detailDirtySessions.add(sessionId);
    status.textContent = payload.suggestion.cached ? "已恢复上次候选；可编辑后保存" : "已生成候选；可编辑后保存";
    input.focus({ preventScroll: true });
  } catch (error) {
    status.textContent = error.message;
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function clientMessageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `phone-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法处理这张图片")), type, quality));
}

async function decodeImage(file) {
  if ("createImageBitmap" in window) return createImageBitmap(file, { imageOrientation: "from-image" });
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function sanitizeImage(file) {
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) throw new Error("只支持 JPEG、PNG 和 WebP 图片");
  if (file.size > 20 * 1024 * 1024) throw new Error("原图不能超过 20 MB");
  const source = await decodeImage(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height || width * height > 60_000_000) {
    source.close?.();
    throw new Error("图片尺寸过大或无法读取");
  }
  const scale = Math.min(1, 2560 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { alpha: true });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  let blob = await canvasBlob(canvas, "image/webp", 0.92);
  if (blob.size > 6 * 1024 * 1024) blob = await canvasBlob(canvas, "image/webp", 0.8);
  if (blob.size > 6 * 1024 * 1024) throw new Error("压缩后仍超过 6 MB，请裁剪后再试");
  const id = clientMessageId();
  return {
    id,
    blob,
    previewUrl: URL.createObjectURL(blob),
    label: `${canvas.width}×${canvas.height} · ${readableBytes(blob.size)}`,
  };
}

function updateAttachmentStrip(form, sessionId) {
  const strip = form?.querySelector("[data-attachment-strip]");
  if (strip) strip.innerHTML = attachmentMarkup(state.attachments.get(sessionId) || []);
}

async function addImages(input) {
  const form = input.closest("form[data-session-command]");
  const sessionId = form?.dataset.sessionCommand;
  if (!form || !sessionId) return;
  const current = state.attachments.get(sessionId) || [];
  const files = Array.from(input.files || []);
  input.value = "";
  if (current.length + files.length > 4) return toast("一条指令最多添加 4 张图片");
  input.disabled = true;
  const status = form.querySelector(".command-status");
  status.textContent = "正在缩放图片并移除元数据…";
  try {
    const prepared = [];
    for (const file of files) prepared.push(await sanitizeImage(file));
    state.attachments.set(sessionId, [...current, ...prepared]);
    state.detailDirtySessions.add(sessionId);
    updateAttachmentStrip(form, sessionId);
    status.textContent = `已准备 ${current.length + prepared.length} 张图片`;
  } catch (error) {
    status.textContent = error.message;
    toast(error.message);
  } finally {
    input.disabled = false;
  }
}

function removeAttachment(sessionId, attachmentId) {
  const attachments = state.attachments.get(sessionId) || [];
  const removed = attachments.find((item) => item.id === attachmentId);
  if (removed) URL.revokeObjectURL(removed.previewUrl);
  const next = attachments.filter((item) => item.id !== attachmentId);
  if (next.length) state.attachments.set(sessionId, next);
  else state.attachments.delete(sessionId);
  updateAttachmentStrip(elements.detailActions.querySelector("form[data-session-command]"), sessionId);
}

function clearAttachments(sessionId) {
  for (const attachment of state.attachments.get(sessionId) || []) URL.revokeObjectURL(attachment.previewUrl);
  state.attachments.delete(sessionId);
}

async function uploadAttachment(sessionId, expectedTurnId, attachment) {
  const query = expectedTurnId ? `?expectedTurnId=${encodeURIComponent(expectedTurnId)}` : "";
  const payload = await request(`/api/sessions/${encodeURIComponent(sessionId)}/images${query}`, {
    method: "POST",
    headers: { "content-type": attachment.blob.type || "image/webp" },
    body: attachment.blob,
  });
  return payload.image.id;
}

function setCommandButtonLabel(button, label, busy = false) {
  if (!button) return;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.classList.toggle("is-busy", busy);
  const text = button.querySelector("[data-command-label]");
  if (text) text.textContent = label;
}

async function sendSessionInput(form) {
  const sessionId = form.dataset.sessionCommand;
  const textarea = form.querySelector("[data-session-input]");
  const button = form.querySelector(".command-submit");
  const status = form.querySelector(".command-status");
  const queue = form.dataset.controlAction === "queue";
  const text = textarea.value.trim();
  const attachments = state.attachments.get(sessionId) || [];
  const modelSelection = state.composerModelSelections.get(sessionId) || { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" };
  const session = state.detailSessions.get(sessionId) || state.sessions.get(sessionId);
  if (!text && !attachments.length) {
    status.textContent = "请输入指令或添加图片";
    textarea.focus();
    return;
  }
  if (queue && attachments.length) {
    status.textContent = "排队发送目前只支持文字，请连接恢复后再添加图片";
    return;
  }
  const effectivePermissionProfile = modelSelection.permissionProfile || inheritedPermissionProfile(session);
  if (form.dataset.controlAction !== "steer" && needsPermissionReminder(effectivePermissionProfile)) {
    window.alert(effectivePermissionProfile === "danger-full-access"
      ? "提醒：下一轮将沿用当前会话的完全访问电脑权限。\n\n这会关闭沙箱并自动执行命令与文件修改。"
      : "提醒：下一轮将沿用当前会话的工作区网络权限。\n\n当前项目可以执行 git push、安装依赖等网络操作。\n\n手机端不会替换或降低会话权限。");
  }
  button.disabled = true;
  textarea.disabled = true;
  for (const control of form.querySelectorAll("input, select, .attach-button")) control.disabled = true;
  setCommandButtonLabel(button, "正在送达…", true);
  status.textContent = queue ? "正在保存到手机续作队列…" : attachments.length ? `正在安全上传 ${attachments.length} 张图片…` : form.dataset.controlAction === "resume" ? "正在恢复并校验 thread" : "正在校验当前 thread 和 turn";
  const uploadedIds = [];
  try {
    if (!queue) for (const attachment of attachments) {
      uploadedIds.push(await uploadAttachment(sessionId, form.dataset.expectedTurnId || null, attachment));
    }
    const payload = await request(`/api/sessions/${encodeURIComponent(sessionId)}/${queue ? "queue" : "input"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        imageIds: uploadedIds,
        expectedTurnId: form.dataset.expectedTurnId || null,
        model: form.dataset.controlAction === "steer" ? null : modelSelection.model || null,
        reasoningEffort: form.dataset.controlAction === "steer" ? null : modelSelection.reasoningEffort || null,
        serviceTier: form.dataset.controlAction === "steer" ? null : modelSelection.serviceTier || null,
        permissionProfile: form.dataset.controlAction === "steer" ? null : modelSelection.permissionProfile || null,
        confirmDangerFullAccess: needsPermissionReminder(effectivePermissionProfile),
        cwd: form.dataset.controlAction === "steer" ? null : modelSelection.cwd || null,
        clientMessageId: clientMessageId(),
      }),
    });
    state.drafts.delete(sessionId);
    persistDraftsSoon();
    state.expandedComposers.delete(sessionId);
    state.composerModelSelections.delete(sessionId);
    clearAttachments(sessionId);
    state.detailDirtySessions.delete(sessionId);
    textarea.value = "";
    if (queue) {
      status.textContent = "已排队，等待连接或电脑释放";
      toast("指令已加入手机续作队列");
    } else {
      status.textContent = payload.command.action === "steer" ? "已追加到当前 turn" : "新 turn 已开始";
      toast(payload.command.action === "steer" ? "指令已追加到 Codex" : "Codex 已继续执行");
    }
    await refreshSessions();
    await showDetails(sessionId, { open: false });
  } catch (error) {
    await Promise.allSettled(uploadedIds.map((id) => request(`/api/images/${encodeURIComponent(id)}`, { method: "DELETE" })));
    button.disabled = false;
    textarea.disabled = false;
    for (const control of form.querySelectorAll("input, select, .attach-button")) control.disabled = false;
    const modelSelect = form.querySelector("[data-model-select]");
    const effortSelect = form.querySelector("[data-effort-select]");
    if (modelSelect && effortSelect && !modelSelect.value) effortSelect.disabled = true;
    setCommandButtonLabel(button, form.dataset.controlAction === "steer" ? "追加" : form.dataset.controlAction === "resume" ? "恢复并开始" : form.dataset.controlAction === "queue" ? "排队发送" : "开始下一轮");
    status.textContent = error.message;
    toast(error.message);
    await refreshSessions();
    if (elements.detail.open && elements.detail.dataset.sessionId === sessionId) {
      await showDetails(sessionId, { open: false });
    }
  }
}

async function cancelQueuedCommand(button) {
  const id = button.dataset.cancelQueued;
  if (!id) return;
  button.disabled = true;
  try {
    await request(`/api/commands/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("已取消排队指令");
    await refreshSessions();
    const sessionId = elements.detail.dataset.sessionId;
    if (sessionId) await showDetails(sessionId, { open: false, preserveView: true });
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

async function branchSession(button) {
  const sessionId = button.dataset.branchSession;
  if (!sessionId) return;
  const text = window.prompt("基于当前会话创建新分支。请输入新分支的第一条指令：");
  if (!text?.trim()) return;
  button.disabled = true;
  button.textContent = "正在分叉…";
  try {
    const payload = await request(`/api/sessions/${encodeURIComponent(sessionId)}/branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text.trim(), clientMessageId: clientMessageId() }),
    });
    toast("已创建分支会话");
    await refreshSessions();
    if (payload.command?.sessionId) await showDetails(payload.command.sessionId, { open: true });
  } catch (error) {
    button.disabled = false;
    button.textContent = "分叉继续";
    toast(error.message);
  }
}

async function interruptTurn(button) {
  const sessionId = button.dataset.interruptSession;
  const expectedTurnId = button.dataset.expectedTurnId;
  if (!window.confirm("停止当前正在执行的任务？\n\n这一轮会被中断，但会话、历史和已经完成的工作都会保留，之后仍可继续。")) return;
  const title = button.querySelector("b");
  const note = button.querySelector("small");
  button.disabled = true;
  if (title) title.textContent = "正在停止…";
  if (note) note.textContent = "已绑定当前 turn，等待 Codex 确认";
  try {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedTurnId }),
    });
    state.detailDirtySessions.delete(sessionId);
    toast("停止请求已送达 Codex");
    await refreshSessions();
    if (elements.detail.open && elements.detail.dataset.sessionId === sessionId) {
      await showDetails(sessionId, { open: false, preserveView: true });
    }
  } catch (error) {
    button.disabled = false;
    if (title) title.textContent = "停止当前任务";
    if (note) note.textContent = "中断这一轮，保留会话和已完成的工作";
    toast(error.message);
    await refreshSessions();
    if (elements.detail.open && elements.detail.dataset.sessionId === sessionId) {
      state.detailDirtySessions.delete(sessionId);
      await showDetails(sessionId, { open: false, preserveView: true });
    }
  }
}

async function decideApproval(id, decision, sessionId = null, turnId = null) {
  if (decision === "allow" && !window.confirm("只允许当前页面显示的这一次操作？")) return;
  try {
    await request(`/api/approvals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, sessionId, turnId }),
    });
    toast(decision === "allow" ? "已允许本次操作" : "已拒绝本次操作");
    await refreshSessions();
    const sessionId = elements.detail.dataset.sessionId;
    if (sessionId) await showDetails(sessionId, { open: false });
  } catch (error) {
    toast(error.message);
  }
}

function renderDevices(payload) {
  state.currentDeviceId = payload.currentDeviceId;
  const listed = payload.devices || [];
  const active = payload.activeDevices || listed.filter((device) => !device.revokedAt);
  const revoked = payload.revokedDevices || listed.filter((device) => device.revokedAt);
  const row = (device) => `
    <article class="device-row" data-device-id="${escapeHtml(device.id)}">
      <div><b>${escapeHtml(device.name)}${device.id === payload.currentDeviceId ? " · 当前设备" : ""}</b><small>最后访问 ${relativeTime(device.lastSeenAt)}${device.revokedAt ? " · 已撤销" : ""}</small></div>
      ${device.revokedAt ? "" : `<button type="button" data-revoke-device="${escapeHtml(device.id)}">撤销</button>`}
    </article>`;
  elements.deviceList.innerHTML = `
    <section class="device-section">
      <header><b>可访问设备</b><span>${active.length}</span></header>
      <div class="device-rows">${active.map(row).join("") || `<p class="detail-empty">还没有可访问设备。</p>`}</div>
    </section>
    ${revoked.length ? `<details class="device-archive">
      <summary><span><b>已撤销记录</b><small>仅用于识别历史设备，不再具备访问权限</small></span><strong>${revoked.length}</strong></summary>
      <div class="device-archive-actions"><button type="button" data-purge-revoked>清理全部已撤销记录</button></div>
      <div class="device-rows">${revoked.map(row).join("")}</div>
    </details>` : ""}`;
}

function currentStatusSession() {
  const selected = state.statusSessionId ? state.sessions.get(state.statusSessionId) : null;
  if (selected && isUserTask(selected)) return selected;
  const sessions = Array.from(state.sessions.values()).filter(isUserTask).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return sessions.find((session) => ["working", "waiting"].includes(session.status) && session.liveness === "recent") || sessions[0] || null;
}

function rateWindowLabel(window) {
  if (window.windowMinutes === 300) return "5 小时额度";
  if (window.windowMinutes === 10_080) return "每周额度";
  if (window.windowMinutes === 1_440) return "每日额度";
  if (window.windowMinutes) return `${window.windowMinutes} 分钟额度`;
  return "额度窗口";
}

function usageWindow(window) {
  if (!window) return "";
  const remaining = Number.isFinite(window.remainingPercent) ? window.remainingPercent : 0;
  return `
    <div class="usage-window">
      <div><span>${escapeHtml(rateWindowLabel(window))}</span><strong>${escapeHtml(remaining)}% 剩余</strong></div>
      <progress class="usage-progress" max="100" value="${escapeHtml(remaining)}">${escapeHtml(remaining)}%</progress>
      <small>${window.resetsAt ? `重置于 ${escapeHtml(localDateTime(window.resetsAt))}` : "重置时间未知"}</small>
    </div>`;
}

function usageCards(codex) {
  const limits = codex?.usage?.limits || [];
  if (!limits.length) return `<p class="detail-empty">App Server 暂未返回额度信息。</p>`;
  return limits.map((limit) => `
    <article class="usage-card">
      <div class="usage-card-title"><b>${escapeHtml(limit.name || "Codex")}</b>${limit.rateLimitReachedType || limit.spendControlReached ? `<span>已受限</span>` : ""}</div>
      ${usageWindow(limit.primary)}
      ${usageWindow(limit.secondary)}
    </article>`).join("");
}

function permissionSummary(session, configuration) {
  const sandbox = session?.permissionMode || configuration?.sandboxMode;
  const approvalPolicy = session?.approvalPolicy || configuration?.approvalPolicy;
  const reviewer = configuration?.approvalsReviewer;
  const labels = {
    "workspace-write": "工作区写入",
    workspaceWrite: "工作区写入",
    "workspace-write-network": "工作区写入 + 网络",
    "read-only": "只读沙箱",
    readOnly: "只读沙箱",
    "danger-full-access": "完全访问",
    dangerFullAccess: "完全访问",
    "on-request": "需要时询问",
    onRequest: "需要时询问",
    never: "自动执行",
    "unless-trusted": "不可信命令询问",
    unlessTrusted: "不可信命令询问",
    auto_review: "自动审查审批",
    user: "用户审批",
  };
  return [labels[sandbox] || sandbox, labels[approvalPolicy] || approvalPolicy, labels[reviewer] || reviewer].filter(Boolean).join(" · ") || "跟随当前 thread";
}

async function handoffSession(button) {
  const sessionId = button.dataset.handoffSession;
  if (!sessionId) return;
  const warning = "把这个会话移交到电脑端？\n\n会话和历史都会保留，Phone Control 会释放写入占用并把手机端切成只读。由于当前空闲会话共用一个受管 App Server，其他由手机持有的空闲会话也会同时释放。\n\n请确认没有其他手机任务正在执行，然后再继续。";
  if (!window.confirm(warning)) return;
  button.disabled = true;
  button.textContent = "正在移交…";
  try {
    const payload = await request(`/api/sessions/${encodeURIComponent(sessionId)}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmSharedRelease: true }),
      timeoutMs: 15_000,
    });
    state.detailDirtySessions.delete(sessionId);
    const affected = payload.operation?.affectedSessionIds?.length || 1;
    toast(affected > 1 ? `已移交到电脑端，并释放 ${affected} 个空闲手机会话` : "已移交到电脑端；手机已切为只读");
    await refreshSessions({ force: true });
    if (elements.detail.open && elements.detail.dataset.sessionId === sessionId) {
      await showDetails(sessionId, { open: false, preserveView: true });
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = "移交电脑";
    toast(error.message);
    await refreshSessions({ force: true });
    if (elements.detail.open && elements.detail.dataset.sessionId === sessionId) {
      state.detailDirtySessions.delete(sessionId);
      await showDetails(sessionId, { open: false, preserveView: true });
    }
  }
}

async function reclaimSession(button) {
  const sessionId = button.dataset.reclaimSession;
  if (!sessionId) return;
  const warning = "重新由手机接管这个会话？\n\n请先在电脑端等待当前任务结束，并完全关闭该会话。接管成功后不要继续在电脑端打开它，否则会再次发生写入者冲突。";
  if (!window.confirm(warning)) return;
  button.disabled = true;
  button.textContent = "正在接管…";
  try {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/reclaim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      timeoutMs: 15_000,
    });
    state.detailDirtySessions.delete(sessionId);
    toast("手机已重新接管；可以继续输入");
    await refreshSessions({ force: true });
    if (elements.detail.open && elements.detail.dataset.sessionId === sessionId) {
      await showDetails(sessionId, { open: false, preserveView: true });
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = "手机接管";
    toast(error.message);
    await refreshSessions({ force: true });
    if (elements.detail.open && elements.detail.dataset.sessionId === sessionId) {
      state.detailDirtySessions.delete(sessionId);
      await showDetails(sessionId, { open: false, preserveView: true });
    }
  }
}

function renderStatus(payload) {
  const session = currentStatusSession();
  const codex = payload.codex || {};
  const runtime = payload.runtime || {};
  const configuration = codex.configuration || {};
  const appServer = payload.appServer || {};
  const serviceConnected = Boolean(payload.ready);
  const controlConnected = Boolean(payload.controlReady ?? (appServer.connected && appServer.initialized));
  const model = session?.model || configuration.model || "Unknown";
  const modelDetails = [configuration.reasoningEffort ? `推理 ${configuration.reasoningEffort}` : null, configuration.serviceTier].filter(Boolean).join(" · ");
  const account = codex.account
    ? `${codex.account.email || "已登录"}${codex.account.planType ? ` · ${codex.account.planType.toUpperCase()}` : ""}`
    : "账户信息不可用";
  const selected = session ? `
    <section class="status-block">
      <p class="status-block-label">当前会话</p>
      <dl class="status-grid">
        <div><dt>模型</dt><dd>${escapeHtml(model)}${modelDetails ? `<small>${escapeHtml(modelDetails)}</small>` : ""}</dd></div>
        <div><dt>项目</dt><dd>${escapeHtml(projectName(session))}<small>${escapeHtml(session.surface || "Unknown")}</small></dd></div>
        <div><dt>权限</dt><dd>${escapeHtml(permissionSummary(session, configuration))}</dd></div>
        <div><dt>Session</dt><dd>${sessionIdMarkup(session.id)}<small>${escapeHtml(labels[session.status] || labels.unknown)}</small></dd></div>
      </dl>
    </section>` : `
    <section class="status-block"><p class="status-block-label">当前会话</p><p class="detail-empty">还没有可展示的 Codex 会话。</p></section>`;

  elements.statusContent.innerHTML = `
    <section class="status-health" data-state="${serviceConnected ? "online" : "offline"}">
      <span></span>
      <div><b>${serviceConnected ? "Phone Control 已连接" : "Phone Control 正在启动"}</b><small>${serviceConnected ? (controlConnected ? "任务追踪与手机控制均可用" : "任务追踪可用，实时控制正在恢复") : "页面会继续尝试恢复"}</small></div>
    </section>
    ${selected}
    <section class="status-block">
      <p class="status-block-label">账户与额度</p>
      <div class="account-line"><span>账户</span><b>${escapeHtml(account)}</b></div>
      <div class="usage-list">${usageCards(codex)}</div>
      ${codex.usage?.resetCreditsAvailable ? `<p class="status-callout">还有 ${escapeHtml(codex.usage.resetCreditsAvailable)} 次额度重置可用；请在 Codex 中使用 <code>/usage</code> 操作。</p>` : ""}
    </section>
    ${runtime.restartRecommended ? `<p class="status-warning">Codex App Server 仍是升级前版本，请重启 Codex 后再继续使用手机控制。</p>` : ""}
    ${runtime.phoneControlNode && !runtime.phoneControlNode.supported ? `<p class="status-warning">后台正在使用 ${escapeHtml(runtime.phoneControlNode.version)}；建议迁移到 Node ${escapeHtml(runtime.phoneControlNode.minimumMajor)} 或更新版本以继续获得安全更新。</p>` : ""}
    ${appServer.retryingSubscriptions ? `<p class="status-callout">正在恢复 ${escapeHtml(appServer.retryingSubscriptions)} 个会话的实时控制；CLI 状态追踪和历史查看不受影响。</p>` : ""}
    ${appServer.unavailableThreadCount ? `<p class="status-warning">有 ${escapeHtml(appServer.unavailableThreadCount)} 个会话的实时控制已隔离；历史查看不受影响。</p>` : ""}
    <details class="status-diagnostics">
      <summary><span>连接与诊断详情</span><small>版本、订阅和功能开关</small></summary>
      <section class="status-block">
        <p class="status-block-label">Phone Control</p>
        <p class="diagnostic-agent">${escapeHtml(appServer.server?.userAgent || codex.server?.userAgent || appServer.transport || "App Server 信息不可用")}</p>
        <dl class="status-grid service-grid">
          <div><dt>版本</dt><dd>v${escapeHtml(payload.version || "Unknown")}</dd></div>
          <div><dt>服务</dt><dd>${payload.ready ? "已就绪" : "正在启动"}</dd></div>
          <div><dt>实时控制</dt><dd>${controlConnected ? "已连接" : "正在恢复"}<small>不影响 Hooks 与历史追踪</small></dd></div>
          <div><dt>主机</dt><dd>${escapeHtml(payload.machineName || "Unknown")}</dd></div>
          <div><dt>Codex CLI</dt><dd>${escapeHtml(runtime.cliVersion || "Unknown")}</dd></div>
          <div><dt>App Server</dt><dd>${escapeHtml(runtime.appServerVersion || "Unknown")}</dd></div>
          <div><dt>Node</dt><dd>${escapeHtml(runtime.phoneControlNode?.version || "Unknown")}<small>${runtime.phoneControlNode?.supported ? "受支持运行时" : "建议升级"}</small></dd></div>
          <div><dt>会话</dt><dd>${escapeHtml(payload.sessions || 0)}<small>${payload.rolloutScanner ? "rollout 扫描开启" : "仅 Hooks"}</small></dd></div>
          <div><dt>订阅</dt><dd>${escapeHtml(appServer.subscribedThreadCount ?? appServer.subscribedThreads?.length ?? 0)} / ${escapeHtml(appServer.loadedThreadCount ?? appServer.loadedThreads?.length ?? 0)}<small>已订阅 / 已加载</small></dd></div>
          <div><dt>手机审批</dt><dd>${payload.nativeApprovalsEnabled ? "权限模式可用" : payload.approvalsEnabled ? "Hook 审批已开启" : payload.approvalRoutingReason === "codex_auto_review" ? "由 Codex 自动审查" : "已关闭"}</dd></div>
          <div><dt>手机交互</dt><dd>${payload.interactionsEnabled ? "已开启" : "已关闭"}</dd></div>
          <div><dt>离线提醒</dt><dd>${state.pushSubscribed ? "已开启" : state.soundEnabled ? "仅页面声音" : "未开启"}</dd></div>
        </dl>
      </section>
    </details>
    <p class="status-footnote">账户邮箱已遮罩；页面不会返回访问令牌或完整 Codex 配置。更新于 ${escapeHtml(localDateTime(codex.checkedAt || new Date().toISOString()))}</p>`;
}

async function showStatus({ refresh = false } = {}) {
  if (!elements.statusDialog.open) {
    elements.statusContent.innerHTML = `<p class="detail-empty">正在读取状态…</p>`;
    elements.statusDialog.showModal();
  }
  elements.statusRefresh.disabled = true;
  elements.statusRefresh.textContent = "读取中…";
  try {
    const payload = await request(`/api/status${refresh ? "?refresh=1" : ""}`);
    renderStatus(payload);
  } catch (error) {
    if (error.message !== "UNAUTHORIZED") elements.statusContent.innerHTML = `<p class="detail-empty">${escapeHtml(error.message)}</p>`;
  } finally {
    elements.statusRefresh.disabled = false;
    elements.statusRefresh.textContent = "刷新";
  }
}

async function showDevices() {
  try {
    const payload = await request("/api/devices");
    renderDevices(payload);
    updatePairingLinkState();
    elements.devicesDialog.showModal();
  } catch (error) {
    if (error.message !== "UNAUTHORIZED") toast(error.message);
  }
}

function clearPairingExpiryTimer() {
  if (state.pairingExpiryTimer) {
    clearInterval(state.pairingExpiryTimer);
    state.pairingExpiryTimer = null;
  }
}

function pairingCountdown(expiresAt) {
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}分${seconds}秒`;
}

function updatePairingLinkState() {
  const pairing = state.pairing;
  if (!pairing?.url || !pairing.expiresAt) return;
  const countdown = pairingCountdown(pairing.expiresAt);
  const expired = !countdown;
  elements.pairingLinkMeta.textContent = expired
    ? "链接已过期，请重新生成"
    : `还剩 ${countdown} · 只能使用一次`;
  elements.pairingLinkStatus.textContent = expired ? "已过期" : "有效";
  elements.pairingLinkStatus.dataset.state = expired ? "expired" : "active";
  elements.pairingLink.classList.toggle("is-expired", expired);
  elements.openPairing.toggleAttribute("aria-disabled", expired);
  elements.openPairing.tabIndex = expired ? -1 : 0;
  if (expired) {
    clearPairingExpiryTimer();
  } else if (!state.pairingExpiryTimer) {
    state.pairingExpiryTimer = setInterval(updatePairingLinkState, 1_000);
  }
}

async function createPairingLink() {
  elements.newPairing.disabled = true;
  elements.newPairing.textContent = "生成中…";
  clearPairingExpiryTimer();
  try {
    const payload = await request("/api/pairings", { method: "POST" });
    const pairing = payload.pairing;
    if (!pairing?.url || !pairing.expiresAt) throw new Error("服务没有返回有效的配对链接");
    state.pairing = pairing;
    elements.pairingLinkValue.value = pairing.url;
    elements.openPairing.href = pairing.url;
    elements.pairingLink.hidden = false;
    updatePairingLinkState();
    try {
      await writeClipboardText(pairing.url);
      toast("手机控制链接已生成并复制，可粘贴到手机打开");
    } catch {
      toast("手机控制链接已生成，请点击“复制链接”");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    elements.newPairing.disabled = false;
    elements.newPairing.textContent = state.pairing ? "重新生成手机链接" : "生成并复制手机链接";
  }
}

function showNewSession() {
  const currentSession = elements.detail.open
    ? state.detailSessions.get(elements.detail.dataset.sessionId) || state.sessions.get(elements.detail.dataset.sessionId)
    : null;
  const preferred = currentSession?.cwd || workspaceCandidates()[0] || "";
  if (!elements.newSessionCwd.value && preferred) elements.newSessionCwd.value = preferred;
  renderNewSessionWorkspaces(preferred);
  elements.newSessionError.textContent = "";
  populateNewSessionModels();
  elements.newSessionRuntime.open = Boolean(elements.newSessionModel.value || elements.newSessionEffort.value || state.newSessionTierTouched || elements.newSessionPermission.value);
  void loadModelCatalog().catch(() => {});
  elements.newSessionDialog.showModal();
  requestAnimationFrame(() => elements.newSessionInput.focus());
}

async function createNewSession() {
  const text = elements.newSessionInput.value.trim();
  const cwd = elements.newSessionCwd.value.trim();
  const model = elements.newSessionModel.value;
  const reasoningEffort = elements.newSessionEffort.value;
  const permissionProfile = elements.newSessionPermission.value;
  const tier = fastTier(modelById(effectiveModelId(model)));
  const serviceTier = state.newSessionTierTouched && tier ? (elements.newSessionFast.checked ? tier.id : "default") : null;
  if (!text || !cwd) {
    elements.newSessionError.textContent = text ? "请输入工作目录" : "请输入第一条任务指令";
    (text ? elements.newSessionCwd : elements.newSessionInput).focus();
    return;
  }
  if (needsPermissionReminder(permissionProfile)) {
    window.alert(permissionProfile === "danger-full-access"
      ? "提醒：这个会话将使用完全访问电脑权限。\n\n这会关闭沙箱并自动执行命令与文件修改。"
      : "提醒：这个会话将允许当前项目访问网络，可用于 git push、安装依赖等操作。\n\n不会访问工作区外文件。");
  }
  elements.newSessionSubmit.disabled = true;
  elements.newSessionSubmit.textContent = "正在创建…";
  elements.newSessionError.textContent = "正在连接 Codex 并创建独立会话";
  try {
    const payload = await request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, cwd, model: model || null, reasoningEffort: reasoningEffort || null, serviceTier, permissionProfile: permissionProfile || null, confirmDangerFullAccess: needsPermissionReminder(permissionProfile), clientMessageId: clientMessageId() }),
      timeoutMs: 15_000,
    });
    const sessionId = payload.command?.sessionId;
    elements.newSessionInput.value = "";
    state.newSessionTierTouched = false;
    elements.newSessionPermission.value = "";
    elements.newSessionDialog.close();
    toast("新会话已创建，Codex 正在执行");
    await refreshSessions({ force: true });
    if (sessionId && state.sessions.has(sessionId)) await showDetails(sessionId);
  } catch (error) {
    elements.newSessionError.textContent = error.message;
    toast(error.message);
  } finally {
    elements.newSessionSubmit.disabled = false;
    elements.newSessionSubmit.textContent = "创建并开始";
  }
}

async function deleteSession(button) {
  const sessionId = button.dataset.deleteSession;
  const session = state.sessions.get(sessionId) || state.detailSessions.get(sessionId);
  if (!sessionId || !session) return;
  const risk = "永久删除这个 Codex 会话？\n\n会同时删除本机 Codex 原始记录、关联元数据以及它产生的子会话。此操作不可恢复。";
  if (!window.confirm(risk)) return;
  button.disabled = true;
  button.textContent = "正在删除…";
  try {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", timeoutMs: 15_000 });
    forgetSession(sessionId);
    scheduleRender({ force: true });
    toast("Codex 会话及其原始记录已永久删除");
  } catch (error) {
    button.disabled = false;
    button.textContent = "永久删除";
    toast(error.message);
    await refreshSessions({ force: true });
  }
}

const DETAIL_INITIAL_EVENTS = 72;
const DETAIL_CACHE_MS = 15_000;
const DETAIL_CACHE_LIMIT = 10;

function cacheDetail(session) {
  const existing = state.detailSessions.get(session.id);
  const preserved = session.eventsPartial && existing && !existing.eventsPartial
    ? {
      ...session,
      events: existing.events,
      eventsTotal: existing.eventsTotal,
      eventsStart: existing.eventsStart,
      eventsPartial: false,
    }
    : session;
  state.detailSessions.delete(session.id);
  state.detailSessions.set(session.id, preserved);
  state.detailFetchedAt.set(session.id, Date.now());
  while (state.detailSessions.size > DETAIL_CACHE_LIMIT) {
    const oldest = Array.from(state.detailSessions.keys()).find((key) => key !== elements.detail.dataset.sessionId);
    if (!oldest) break;
    state.detailSessions.delete(oldest);
    state.detailFetchedAt.delete(oldest);
  }
  return preserved;
}

function fetchSessionDetail(id, { force = false, full = false } = {}) {
  const cached = state.detailSessions.get(id);
  const fresh = Date.now() - (state.detailFetchedAt.get(id) || 0) < DETAIL_CACHE_MS;
  if (!force && cached && (full ? !cached.eventsPartial : fresh)) return Promise.resolve(cached);
  const key = `${id}:${full ? "all" : "initial"}`;
  if (state.detailRequests.has(key)) return state.detailRequests.get(key);
  const controller = new AbortController();
  state.detailRequestControllers.set(key, controller);
  const requestPromise = request(`/api/sessions/${encodeURIComponent(id)}?events=${full ? "all" : DETAIL_INITIAL_EVENTS}`, { signal: controller.signal })
    .then((payload) => cacheDetail(payload.session))
    .finally(() => {
      state.detailRequests.delete(key);
      state.detailRequestControllers.delete(key);
    });
  state.detailRequests.set(key, requestPromise);
  return requestPromise;
}

function revealTaskSearchMatch(eventId) {
  if (!eventId || !elements.detail.open) return;
  requestAnimationFrame(() => {
    const target = elements.detailContent.querySelector(`[data-message-event-id="${CSS.escape(eventId)}"]`);
    if (!target) return;
    target.classList.remove("search-hit");
    target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    requestAnimationFrame(() => target.classList.add("search-hit"));
    setTimeout(() => target.classList.remove("search-hit"), 2_600);
  });
}

async function showDetails(id, { open = true, preserveView = !open, full = false, focusEventId = null } = {}) {
  const preserving = preserveView && elements.detail.open && elements.detail.dataset.sessionId === id;
  const scrollTop = preserving ? elements.detailContent.scrollTop : 0;
  const technicalOpen = preserving && Boolean(elements.detailContent.querySelector(".technical-details[open]"));
  const cached = state.detailSessions.get(id);
  const summary = state.sessions.get(id);
  const changingSession = elements.detail.dataset.sessionId !== id;
  elements.detail.dataset.sessionId = id;
  if (open && !elements.detail.open) {
    state.detailDirtySessions.delete(id);
    elements.detail.showModal();
  }
  if (!preserving && (changingSession || open)) {
    if (cached) renderDetails(cached);
    else if (summary) renderDetails({ ...summary, events: [] }, { loading: true });
    else {
      elements.detailHeader.innerHTML = "";
      elements.detailActions.innerHTML = "";
      elements.detailContent.innerHTML = `<p class="detail-empty">正在加载会话详情…</p>`;
    }
  }
  try {
    const session = await fetchSessionDetail(id, { force: true, full: full || Boolean(cached && !cached.eventsPartial) });
    if (elements.detail.dataset.sessionId === id) {
      if (detailInteractionActive(id)) {
        markDetailUpdatePending(id);
        return;
      }
      if (focusEventId) state.historyVisibleTurns.set(id, Number.MAX_SAFE_INTEGER);
      renderDetails(session);
      clearDetailUpdatePending(id);
      if (technicalOpen) elements.detailContent.querySelector(".technical-details")?.setAttribute("open", "");
      if (preserving) requestAnimationFrame(() => { elements.detailContent.scrollTop = scrollTop; });
      else if (focusEventId) revealTaskSearchMatch(focusEventId);
    }
  } catch (error) {
    if (error.message !== "UNAUTHORIZED" && elements.detail.dataset.sessionId === id) {
      if (detailInteractionActive(id)) {
        markDetailUpdatePending(id);
        return;
      }
      elements.detailHeader.innerHTML = "";
      elements.detailActions.innerHTML = "";
      elements.detailContent.innerHTML = `<p class="detail-empty">${escapeHtml(error.message)}</p>`;
    }
  }
}

function pushSupported() {
  return Boolean(window.isSecureContext && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window);
}

function applicationServerKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function updateNotifyButton() {
  const active = state.pushSubscribed || state.soundEnabled;
  const desired = state.notificationDesired ?? active;
  elements.notify.classList.toggle("active", active);
  elements.notify.classList.toggle("is-syncing", state.notificationSyncing);
  elements.notify.setAttribute("aria-pressed", String(active));
  elements.notify.setAttribute("aria-busy", String(state.notificationSyncing));
  elements.notify.title = state.pushSubscribed
    ? "离线通知和提示音已开启；点按关闭"
    : state.soundEnabled
      ? "页面提示音已开启；点按关闭"
      : pushSupported()
        ? "开启离线通知和提示音"
        : "开启页面提示音";
  elements.notify.setAttribute("aria-label", elements.notify.title);
  elements.notifyLabel.textContent = state.notificationSyncing
    ? desired ? "开启中" : "关闭中"
    : state.pushSubscribed ? "提醒已开" : state.soundEnabled ? "声音已开" : "提醒";
}

async function performPushStatusSync({ repair = false } = {}) {
  if (localStorage.getItem("phone-control-push-disable-pending") === "1") {
    state.pushSubscribed = false;
    state.soundEnabled = false;
    localStorage.removeItem("phone-control-sound");
    updateNotifyButton();
    try {
      await request("/api/push/unsubscribe", { method: "POST" });
      if (state.notificationDesired != null) return;
      localStorage.removeItem("phone-control-push-disable-pending");
      if (pushSupported()) {
        const registration = await navigator.serviceWorker.ready;
        await (await registration.pushManager.getSubscription())?.unsubscribe().catch(() => false);
      }
    } catch {
      // Keep the pending marker and retry after the next successful bootstrap.
    }
    return;
  }
  if (!pushSupported()) {
    state.pushSubscribed = false;
    updateNotifyButton();
    return;
  }
  try {
    const status = await request("/api/push");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (state.notificationDesired != null) return;
    if (repair && subscription && Notification.permission === "granted" && !status.subscribed) {
      await request("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
      state.pushSubscribed = true;
    } else {
      state.pushSubscribed = Boolean(status.subscribed && subscription);
      if (status.subscribed && !subscription) {
        await request("/api/push/unsubscribe", { method: "POST" });
      }
    }
  } catch {
    state.pushSubscribed = false;
  }
  updateNotifyButton();
}

function syncPushStatus(options = {}) {
  if (state.notificationSyncing && !state.pushStatusSyncPromise) return Promise.resolve();
  if (state.pushStatusSyncPromise) return state.pushStatusSyncPromise;
  const task = performPushStatusSync(options);
  state.pushStatusSyncPromise = task.finally(() => {
    state.pushStatusSyncPromise = null;
  });
  return state.pushStatusSyncPromise;
}

async function enableNotificationsRemote() {
  const soundReady = unlockSignalSound();
  const permissionReady = pushSupported() ? Notification.requestPermission() : null;
  await soundReady;
  if (state.notificationDesired) playSignalSound("complete");
  if (!pushSupported()) {
    if (state.notificationDesired) toast("页面内完成提示和声音已开启");
    return;
  }
  const permission = await permissionReady;
  if (!state.notificationDesired) return;
  if (permission !== "granted") {
    toast("页面声音已开启；系统通知未授权");
    return;
  }
  const [status, registration] = await Promise.all([
    request("/api/push"),
    navigator.serviceWorker.ready,
  ]);
  if (!state.notificationDesired) return;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(status.publicKey),
    });
  }
  if (!state.notificationDesired) return;
  await request("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  if (!state.notificationDesired) return;
  state.pushSubscribed = true;
  updateNotifyButton();
  void request("/api/push/test", { method: "POST" }).catch(() => {});
  toast("离线通知已开启，测试通知已发送");
}

async function disableNotificationsRemote() {
  const serverUnsubscribe = request("/api/push/unsubscribe", { method: "POST" })
    .then(() => true, () => false);
  const browserUnsubscribe = pushSupported() ? (async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      return !subscription || await subscription.unsubscribe();
    } catch {
      return false;
    }
  })() : Promise.resolve(true);
  const [serverUnsubscribed, browserUnsubscribed] = await Promise.all([serverUnsubscribe, browserUnsubscribe]);
  if (serverUnsubscribed) localStorage.removeItem("phone-control-push-disable-pending");
  if (state.notificationDesired !== false) return;
  toast(!serverUnsubscribed
    ? "页面提醒已关闭；恢复连接后会自动停止离线投递"
    : !browserUnsubscribed
      ? "服务器提醒和声音已关闭；浏览器订阅会自动过期"
      : "此设备的通知和提示音已关闭");
}

function reconcileNotifications() {
  if (state.notificationSyncPromise) return state.notificationSyncPromise;
  state.notificationSyncing = true;
  updateNotifyButton();
  const task = (async () => {
    if (state.pushStatusSyncPromise) await state.pushStatusSyncPromise;
    while (state.notificationDesired != null) {
      const desired = state.notificationDesired;
      try {
        if (desired) await enableNotificationsRemote();
        else await disableNotificationsRemote();
      } catch (error) {
        if (error.message !== "UNAUTHORIZED" && desired === state.notificationDesired) {
          toast(desired ? `页面声音已开启；${error.message}` : error.message);
        }
      }
      if (desired === state.notificationDesired) break;
    }
  })();
  state.notificationSyncPromise = task.finally(() => {
    state.notificationSyncing = false;
    state.notificationDesired = null;
    state.notificationSyncPromise = null;
    updateNotifyButton();
  });
  return state.notificationSyncPromise;
}

function toggleNotifications() {
  const active = state.notificationDesired ?? (state.pushSubscribed || state.soundEnabled);
  const desired = !active;
  state.notificationDesired = desired;
  state.soundEnabled = desired;
  if (desired) {
    localStorage.setItem("phone-control-sound", "1");
    localStorage.removeItem("phone-control-push-disable-pending");
  } else {
    state.pushSubscribed = false;
    localStorage.removeItem("phone-control-sound");
    localStorage.setItem("phone-control-push-disable-pending", "1");
  }
  updateNotifyButton();
  void reconcileNotifications();
}

elements.filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  if (state.searchQuery) state.filterBeforeSearch = button.dataset.filter;
  setTaskFilter(button.dataset.filter);
});

elements.actionInboxOpen.addEventListener("click", () => {
  setTaskFilter("attention");
  elements.filters.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

elements.taskSearch.addEventListener("submit", (event) => {
  event.preventDefault();
  applyTaskSearch(elements.taskSearchInput.value);
  clearTimeout(state.searchTimer);
  state.searchTimer = null;
  void runTaskSearch();
  elements.taskSearchInput.blur();
});

elements.taskSearchInput.addEventListener("input", () => applyTaskSearch(elements.taskSearchInput.value));
elements.taskSearchInput.addEventListener("search", () => applyTaskSearch(elements.taskSearchInput.value));
elements.taskSearchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !elements.taskSearchInput.value) return;
  event.preventDefault();
  elements.taskSearchInput.value = "";
  applyTaskSearch("");
});
elements.taskSearchClear.addEventListener("click", () => {
  elements.taskSearchInput.value = "";
  applyTaskSearch("");
  elements.taskSearchInput.focus({ preventScroll: true });
});

elements.list.addEventListener("click", (event) => {
  const card = event.target.closest("[data-session-id]");
  if (card) void showDetails(card.dataset.sessionId, {
    full: Boolean(card.dataset.searchEventId),
    focusEventId: card.dataset.searchEventId || null,
  });
});

elements.list.addEventListener("pointerdown", (event) => {
  const card = event.target.closest("[data-session-id]");
  if (card) void fetchSessionDetail(card.dataset.sessionId).catch(() => {});
}, { passive: true });

elements.list.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-session-id]");
  if (card) void showDetails(card.dataset.sessionId, {
    full: Boolean(card.dataset.searchEventId),
    focusEventId: card.dataset.searchEventId || null,
  });
});

elements.list.addEventListener("toggle", (event) => {
  const group = event.target.closest("[data-group-key]");
  if (!group) return;
  if (group.open) state.expandedGroups.add(group.dataset.groupKey);
  else state.expandedGroups.delete(group.dataset.groupKey);
}, true);

elements.detailClose.addEventListener("click", () => elements.detail.close());
elements.detail.addEventListener("close", () => {
  const sessionId = elements.detail.dataset.sessionId;
  elements.detailContent.querySelector(".technical-details")?.removeAttribute("open");
  state.detailDirtySessions.delete(sessionId);
  clearDetailUpdatePending(sessionId);
  if (!state.drafts.get(sessionId) && !state.attachments.get(sessionId)?.length) state.expandedComposers.delete(sessionId);
  if (state.listDirty) scheduleRender({ force: true });
  elements.detail.classList.remove("composer-open", "runtime-settings-open");
  closeRuntimeSettings();
});
let detailBackdropPointerDown = false;
elements.detail.addEventListener("pointerdown", (event) => {
  detailBackdropPointerDown = event.target === elements.detail;
});
elements.detail.addEventListener("click", (event) => {
  if (event.target === elements.detail && detailBackdropPointerDown) elements.detail.close();
  detailBackdropPointerDown = false;
  const copySessionButton = event.target.closest("[data-copy-session-id]");
  if (copySessionButton) {
    void copySessionId(copySessionButton);
    return;
  }
  const openTaskTitle = event.target.closest("[data-open-task-title]");
  if (openTaskTitle) {
    const technical = elements.detailContent.querySelector(".technical-details");
    const form = technical?.querySelector("[data-task-title-form]");
    if (technical && form) {
      technical.open = true;
      form.classList.remove("is-revealed");
      requestAnimationFrame(() => {
        form.classList.add("is-revealed");
        form.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      });
    }
    return;
  }
  const commandForm = event.target.closest("form[data-session-command]");
  const runtimeSessionId = commandForm?.dataset.sessionCommand;
  const openRuntime = event.target.closest("[data-open-runtime-settings]");
  if (openRuntime) {
    openRuntimeSettings(openRuntime.dataset.openRuntimeSettings);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-session]");
  if (deleteButton) {
    void deleteSession(deleteButton);
    return;
  }
  const branchButton = event.target.closest("[data-branch-session]");
  if (branchButton) {
    void branchSession(branchButton);
    return;
  }
  const cancelQueued = event.target.closest("[data-cancel-queued]");
  if (cancelQueued) {
    void cancelQueuedCommand(cancelQueued);
    return;
  }
  const handoffButton = event.target.closest("[data-handoff-session]");
  if (handoffButton) {
    void handoffSession(handoffButton);
    return;
  }
  const reclaimButton = event.target.closest("[data-reclaim-session]");
  if (reclaimButton) {
    void reclaimSession(reclaimButton);
    return;
  }
  const suggestTaskTitleButton = event.target.closest("[data-suggest-task-title]");
  if (suggestTaskTitleButton) {
    const form = suggestTaskTitleButton.closest("form[data-task-title-form]");
    if (form) void suggestTaskTitle(form);
    return;
  }
  const resetTaskTitle = event.target.closest("[data-reset-task-title]");
  if (resetTaskTitle) {
    const form = resetTaskTitle.closest("form[data-task-title-form]");
    if (form) void saveTaskTitle(form, { reset: true });
    return;
  }
  const interruptButton = event.target.closest("[data-interrupt-session]");
  if (interruptButton) {
    void interruptTurn(interruptButton);
    return;
  }
  const targetToggle = event.target.closest("[data-target-session-id]");
  if (targetToggle) {
    const id = targetToggle.dataset.targetSessionId;
    const active = state.targetSessionId === id;
    targetToggle.disabled = true;
    void setTargetSession(active ? null : id)
      .then(() => toast(active ? "已取消目标追踪" : "已追踪此会话；完成提醒将跟随它"))
      .catch((error) => toast(error.message))
      .finally(() => { targetToggle.disabled = false; });
    return;
  }
  const removeImage = event.target.closest("[data-remove-attachment]");
  if (removeImage) {
    removeAttachment(elements.detail.dataset.sessionId, removeImage.dataset.removeAttachment);
    return;
  }
  const detailRefresh = event.target.closest("[data-refresh-detail]");
  if (detailRefresh) {
    const sessionId = elements.detail.dataset.sessionId;
    state.detailDirtySessions.delete(sessionId);
    void showDetails(sessionId, { open: false, preserveView: true });
    return;
  }
  const expandComposer = event.target.closest("[data-expand-composer]");
  if (expandComposer) {
    const sessionId = expandComposer.dataset.expandComposer;
    state.expandedComposers.add(sessionId);
    rerenderCachedDetail(sessionId);
    const textarea = elements.detailActions.querySelector("[data-session-input]");
    resizeComposerInput(textarea);
    textarea?.focus({ preventScroll: true });
    void loadModelCatalog().then(() => {
      if (elements.detail.open && elements.detail.dataset.sessionId === sessionId && !detailInteractionActive(sessionId)) {
        rerenderCachedDetail(sessionId);
      }
    }).catch(() => {});
    requestAnimationFrame(() => {
      resizeComposerInput(textarea);
    });
    return;
  }
  const collapseComposer = event.target.closest("[data-collapse-composer]");
  if (collapseComposer) {
    const sessionId = collapseComposer.dataset.collapseComposer;
    state.expandedComposers.delete(sessionId);
    rerenderCachedDetail(sessionId);
    return;
  }
  const copyMessageButton = event.target.closest("[data-copy-message]");
  if (copyMessageButton) {
    const sessionId = elements.detail.dataset.sessionId;
    const message = assistantMessageText(sessionId, copyMessageButton.dataset.copyMessage);
    copyMessageButton.disabled = true;
    void writeClipboardText(message)
      .then(() => {
        copyMessageButton.dataset.copyState = "copied";
        copyMessageButton.classList.add("is-copied");
        copyMessageButton.textContent = "已复制";
        copyMessageButton.setAttribute("aria-label", "Codex 回复已复制");
        toast("Codex 回复已复制");
        setTimeout(() => {
          if (!copyMessageButton.isConnected || copyMessageButton.dataset.copyState !== "copied") return;
          delete copyMessageButton.dataset.copyState;
          copyMessageButton.classList.remove("is-copied");
          copyMessageButton.textContent = "复制";
          copyMessageButton.setAttribute("aria-label", "复制这条 Codex 回复");
          copyMessageButton.disabled = false;
        }, 1_600);
      })
      .catch((error) => {
        copyMessageButton.disabled = false;
        toast(error?.message || "复制失败，请长按回复文本复制");
      });
    return;
  }
  const messageButton = event.target.closest("[data-expand-message]");
  if (messageButton) {
    const row = messageButton.closest(".timeline-message");
    const messageId = row?.dataset.messageId;
    if (row && messageId) {
      const expanded = !row.classList.contains("is-expanded");
      row.classList.toggle("is-expanded", expanded);
      messageButton.setAttribute("aria-expanded", String(expanded));
      messageButton.textContent = expanded ? "收起 ↑" : "展开全文 ↓";
      if (expanded) state.expandedMessages.add(messageId);
      else state.expandedMessages.delete(messageId);
    }
    return;
  }
  const historyButton = event.target.closest("[data-expand-history]");
  if (historyButton) {
    const sessionId = historyButton.dataset.sessionId;
    const visibleCount = state.historyVisibleTurns.get(sessionId) || 0;
    if (historyButton.dataset.needsFullHistory !== "true") {
      const session = state.detailSessions.get(sessionId);
      const olderCount = Math.max(0, conversationTurns(session?.events || []).length - 3);
      state.historyVisibleTurns.set(sessionId, Math.min(olderCount, visibleCount + 8));
      rerenderCachedDetail(sessionId);
      return;
    }
    historyButton.disabled = true;
    historyButton.innerHTML = "<b>正在读取更早记录…</b><small>已显示的内容会保留</small>";
    void fetchSessionDetail(sessionId, { force: true, full: true })
      .then((session) => {
        const olderCount = Math.max(0, conversationTurns(session.events || []).length - 3);
        state.historyVisibleTurns.set(sessionId, Math.min(olderCount, visibleCount + 8));
        rerenderCachedDetail(sessionId);
      })
      .catch((error) => {
        historyButton.disabled = false;
        historyButton.innerHTML = "<b>重试加载更早记录</b><small>已显示的内容仍在这里</small>";
        toast(error.message);
      });
    return;
  }
  const collapseHistory = event.target.closest("[data-collapse-history]");
  if (collapseHistory) {
    const sessionId = collapseHistory.dataset.sessionId;
    state.historyVisibleTurns.delete(sessionId);
    rerenderCachedDetail(sessionId, {
      scrollTop: 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    return;
  }
  const decision = event.target.closest("button[data-decision]");
  const panel = decision?.closest("[data-approval-id]");
  if (decision && panel) void decideApproval(panel.dataset.approvalId, decision.dataset.decision, panel.dataset.sessionId || null, panel.dataset.turnId || null);
});
elements.detail.addEventListener("toggle", (event) => {
  const details = event.target;
  if (details.matches?.("[data-task-result]")) {
    if (details.open) state.expandedResults.add(details.dataset.taskResult);
    else state.expandedResults.delete(details.dataset.taskResult);
  }
  if (details.matches?.("[data-turn-process]")) {
    if (details.open) state.expandedTurnProcesses.add(details.dataset.turnProcess);
    else state.expandedTurnProcesses.delete(details.dataset.turnProcess);
  }
  if (details.matches?.("[data-turn-updates]")) {
    if (details.open) state.expandedTurnUpdates.add(details.dataset.turnUpdates);
    else state.expandedTurnUpdates.delete(details.dataset.turnUpdates);
  }
}, true);
elements.detail.addEventListener("submit", (event) => {
  const taskTitleForm = event.target.closest("form[data-task-title-form]");
  if (taskTitleForm) {
    event.preventDefault();
    void saveTaskTitle(taskTitleForm);
    return;
  }
  const form = event.target.closest("form[data-question-request]");
  if (form) {
    event.preventDefault();
    void answerQuestion(form);
    return;
  }
  const command = event.target.closest("form[data-session-command]");
  if (command) {
    event.preventDefault();
    void sendSessionInput(command);
  }
});
elements.detail.addEventListener("input", (event) => {
  if (elements.detailActions.contains(event.target) || event.target.matches("[data-task-title-input]")) {
    state.detailDirtySessions.add(elements.detail.dataset.sessionId);
  }
  const textarea = event.target.closest("[data-session-input]");
  const form = textarea?.closest("form[data-session-command]");
  if (!textarea || !form) return;
  if (textarea.value) state.drafts.set(form.dataset.sessionCommand, textarea.value);
  else state.drafts.delete(form.dataset.sessionCommand);
  resizeComposerInput(textarea);
  persistDraftsSoon();
  const count = form.querySelector("[data-input-count]");
  if (count) {
    count.textContent = `${textarea.value.length}/4000`;
    count.classList.toggle("is-empty", !textarea.value.length);
  }
});
elements.detail.addEventListener("change", (event) => {
  if (elements.detailActions.contains(event.target)) {
    state.detailDirtySessions.add(elements.detail.dataset.sessionId);
  }
  const commandForm = event.target.closest("form[data-session-command]");
  const sessionId = commandForm?.dataset.sessionCommand;
  if (sessionId && event.target.matches("[data-model-select]")) {
    const model = event.target.value;
    const selection = state.composerModelSelections.get(sessionId) || { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" };
    selection.model = model;
    selection.reasoningEffort = "";
    selection.serviceTier = "";
    state.composerModelSelections.set(sessionId, selection);
    populateComposerModels();
    return;
  }
  if (sessionId && event.target.matches("[data-fast-toggle]")) {
    const session = state.detailSessions.get(sessionId) || state.sessions.get(sessionId);
    const selection = state.composerModelSelections.get(sessionId) || { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" };
    if (!selection.model) selection.model = effectiveModelId("", session);
    const tier = fastTier(modelById(effectiveModelId(selection.model, session)));
    selection.serviceTier = event.target.checked ? tier?.id || "priority" : "default";
    state.composerModelSelections.set(sessionId, selection);
    updateComposerSettingsSummary(commandForm, session, selection);
    return;
  }
  const imageInput = event.target.closest("[data-image-input]");
  if (imageInput) void addImages(imageInput);
});
elements.detail.addEventListener("focusin", (event) => {
  if ((elements.detailActions.contains(event.target) || elements.detailContent.contains(event.target)) && event.target.matches("textarea, input, select, [contenteditable]")) {
    state.detailDirtySessions.add(elements.detail.dataset.sessionId);
  }
});
elements.detailContent.addEventListener("touchstart", () => {
  state.detailScrollingSessionId = elements.detail.dataset.sessionId;
  state.detailScrollingUntil = Date.now() + 1_500;
}, { passive: true });
elements.detailContent.addEventListener("wheel", () => {
  state.detailScrollingSessionId = elements.detail.dataset.sessionId;
  state.detailScrollingUntil = Date.now() + 1_200;
}, { passive: true });
elements.detailContent.addEventListener("scroll", () => {
  const sessionId = elements.detail.dataset.sessionId;
  if (state.detailScrollingSessionId === sessionId && Date.now() < state.detailScrollingUntil) {
    state.detailScrollingUntil = Date.now() + 1_200;
  }
}, { passive: true });

elements.devicesButton.addEventListener("click", () => {
  if (elements.topMenu) elements.topMenu.open = false;
  void showDevices();
});
elements.newSessionButton.addEventListener("click", showNewSession);
elements.newSessionClose.addEventListener("click", () => elements.newSessionDialog.close());
elements.newSessionDialog.addEventListener("click", (event) => {
  if (event.target === elements.newSessionDialog) elements.newSessionDialog.close();
});
elements.newSessionModel.addEventListener("change", () => {
  elements.newSessionEffort.value = "";
  state.newSessionTierTouched = false;
  populateNewSessionModels();
});
elements.newSessionEfforts.addEventListener("click", (event) => {
  const button = event.target.closest("[data-new-effort-value]");
  if (!button) return;
  elements.newSessionEffort.value = button.dataset.newEffortValue;
  populateNewSessionModels();
});
elements.newSessionFast.addEventListener("change", () => {
  state.newSessionTierTouched = true;
  populateNewSessionModels();
});
elements.newSessionPermission.addEventListener("change", populateNewSessionModels);
elements.newSessionConfigReset.addEventListener("click", () => {
  elements.newSessionModel.value = "";
  elements.newSessionEffort.value = "";
  state.newSessionTierTouched = false;
  elements.newSessionPermission.value = "";
  populateNewSessionModels();
});
elements.newSessionWorkspaces.addEventListener("click", (event) => {
  const button = event.target.closest("[data-workspace-path]");
  if (!button) return;
  elements.newSessionCwd.value = button.dataset.workspacePath;
  elements.newSessionCustomWorkspace.open = false;
  renderNewSessionWorkspaces(button.dataset.workspacePath);
});
elements.newSessionCwd.addEventListener("input", () => {
  const value = elements.newSessionCwd.value.trim();
  for (const button of elements.newSessionWorkspaces.querySelectorAll("[data-workspace-path]")) {
    const active = button.dataset.workspacePath === value;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  }
  const selectedPath = elements.newSessionWorkspaces.querySelector(".workspace-selected-path code");
  if (selectedPath) selectedPath.textContent = value || "尚未选择路径";
  updateNewSessionSubmitSummary();
});
elements.newSessionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createNewSession();
});
elements.statusButton.addEventListener("click", () => {
  state.statusSessionId = null;
  void showStatus();
});
elements.statusClose.addEventListener("click", () => elements.statusDialog.close());
elements.statusRefresh.addEventListener("click", () => void showStatus({ refresh: true }));
elements.statusDialog.addEventListener("click", (event) => {
  if (event.target === elements.statusDialog) elements.statusDialog.close();
  const copySessionButton = event.target.closest("[data-copy-session-id]");
  if (copySessionButton) void copySessionId(copySessionButton);
});
elements.devicesClose.addEventListener("click", () => elements.devicesDialog.close());
elements.devicesDialog.addEventListener("click", (event) => {
  if (event.target === elements.devicesDialog) elements.devicesDialog.close();
  const purge = event.target.closest("button[data-purge-revoked]");
  if (purge) {
    if (!window.confirm("清理所有已撤销设备的历史记录？\n\n这些设备已经无法访问，清理不会影响当前可用设备。")) return;
    purge.disabled = true;
    void request("/api/devices/revoked", { method: "DELETE" })
      .then((payload) => {
        toast(`已清理 ${payload.removed || 0} 条撤销记录`);
        void showDevices();
      })
      .catch((error) => {
        purge.disabled = false;
        toast(error.message);
      });
    return;
  }
  const revoke = event.target.closest("button[data-revoke-device]");
  if (!revoke || !window.confirm("撤销这台设备的访问权限？")) return;
  void request(`/api/devices/${encodeURIComponent(revoke.dataset.revokeDevice)}/revoke`, { method: "POST" })
    .then(() => {
      toast("设备已撤销");
      if (revoke.dataset.revokeDevice === state.currentDeviceId) {
        elements.devicesDialog.close();
        showPairing(true);
      } else void showDevices();
    })
    .catch((error) => toast(error.message));
});

elements.runtimeSettingsDialog.addEventListener("click", (event) => {
  if (event.target === elements.runtimeSettingsDialog || event.target.closest("[data-close-runtime]")) {
    closeRuntimeSettings();
    return;
  }
  const sessionId = state.runtimeSessionId;
  const session = state.detailSessions.get(sessionId) || state.sessions.get(sessionId);
  if (!sessionId || !session) return;
  const effortButton = event.target.closest("[data-effort-value]");
  if (effortButton) {
    const selection = state.composerModelSelections.get(sessionId) || { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" };
    if (effortButton.dataset.effortValue && !selection.model) selection.model = effectiveModelId("", session);
    selection.reasoningEffort = effortButton.dataset.effortValue;
    state.composerModelSelections.set(sessionId, selection);
    state.detailDirtySessions.add(sessionId);
    renderRuntimeSettingsDialog(sessionId);
    updateComposerSettingsSummary(elements.detailActions.querySelector(`form[data-session-command="${CSS.escape(sessionId)}"]`), session, selection);
    return;
  }
  if (event.target.closest("[data-reset-runtime]")) {
    state.composerModelSelections.delete(sessionId);
    state.detailDirtySessions.add(sessionId);
    renderRuntimeSettingsDialog(sessionId);
    updateComposerSettingsSummary(elements.detailActions.querySelector(`form[data-session-command="${CSS.escape(sessionId)}"]`), session, { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" });
  }
});

elements.runtimeSettingsDialog.addEventListener("change", (event) => {
  const sessionId = state.runtimeSessionId;
  const session = state.detailSessions.get(sessionId) || state.sessions.get(sessionId);
  if (!sessionId || !session) return;
  const selection = state.composerModelSelections.get(sessionId) || { model: "", reasoningEffort: "", serviceTier: "", cwd: "", permissionProfile: "" };
  if (event.target.matches("[data-model-select]")) {
    selection.model = event.target.value;
    selection.reasoningEffort = "";
    selection.serviceTier = "";
  } else if (event.target.matches("[data-fast-toggle]")) {
    if (!selection.model) selection.model = effectiveModelId("", session);
    const tier = fastTier(modelById(effectiveModelId(selection.model, session)));
    selection.serviceTier = event.target.checked ? tier?.id || "priority" : "default";
  } else if (event.target.matches("[data-permission-select]")) {
    selection.permissionProfile = event.target.value;
  } else return;
  state.composerModelSelections.set(sessionId, selection);
  state.detailDirtySessions.add(sessionId);
  renderRuntimeSettingsDialog(sessionId);
  updateComposerSettingsSummary(elements.detailActions.querySelector(`form[data-session-command="${CSS.escape(sessionId)}"]`), session, selection);
});

elements.runtimeSettingsDialog.addEventListener("close", () => {
  state.runtimeSessionId = null;
  syncDetailLayoutState();
});

elements.newPairing.addEventListener("click", () => void createPairingLink());

elements.copyPairing.addEventListener("click", async () => {
  try {
    await writeClipboardText(elements.pairingLinkValue.value);
    toast("手机控制链接已复制");
  } catch {
    elements.pairingLinkValue.select();
    toast("请长按复制配对链接");
  }
});

elements.openPairing.addEventListener("click", (event) => {
  if (!state.pairing || !pairingCountdown(state.pairing.expiresAt)) {
    event.preventDefault();
    toast("配对链接已过期，请重新生成");
  }
});

elements.pairingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.pairingError.textContent = "";
  try {
    await request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: elements.pairingToken.value }),
    });
    elements.pairingToken.value = "";
    showPairing(false);
    await bootstrap();
  } catch (error) {
    elements.pairingError.textContent = error.message === "UNAUTHORIZED" ? "访问口令不正确" : error.message;
  }
});

elements.notify.addEventListener("click", toggleNotifications);

elements.signalToast.addEventListener("click", () => {
  const sessionId = elements.signalToast.dataset.sessionId;
  hideSignal(sessionId);
  if (sessionId) void showDetails(sessionId);
});

elements.targetOpen.addEventListener("click", () => {
  if (state.targetSessionId && state.sessions.has(state.targetSessionId)) void showDetails(state.targetSessionId);
});

elements.targetClear.addEventListener("click", () => {
  elements.targetClear.disabled = true;
  void setTargetSession(null)
    .then(() => toast("已取消目标追踪"))
    .catch((error) => toast(error.message))
    .finally(() => { elements.targetClear.disabled = false; });
});

elements.connection.addEventListener("click", () => void reconnectNow());

elements.topMenu?.addEventListener("toggle", () => {
  elements.topMenuTrigger?.setAttribute("aria-expanded", String(elements.topMenu.open));
});
document.addEventListener("click", (event) => {
  if (elements.topMenu?.open && !elements.topMenu.contains(event.target)) elements.topMenu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !elements.topMenu?.open) return;
  elements.topMenu.open = false;
  elements.topMenuTrigger?.focus();
});

if ("serviceWorker" in navigator) {
  let reloadingForWorker = false;
  const hadWorkerController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadWorkerController || reloadingForWorker) return;
    const active = document.activeElement;
    const editing = state.drafts.size > 0
      || state.attachments.size > 0
      || Boolean(active && elements.detailActions.contains(active));
    if (editing) {
      toast("界面已更新；当前输入已保留，完成后刷新即可启用");
      return;
    }
    reloadingForWorker = true;
    location.reload();
  });
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
    .then((registration) => registration.update())
    .catch(() => {});
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "phone-control-completion") handleCompletion(event.data.payload);
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") pauseForBackground();
  else void resumeForeground();
});
document.addEventListener("freeze", pauseForBackground);
document.addEventListener("resume", () => void resumeForeground());
window.addEventListener("pageshow", () => void resumeForeground());
window.addEventListener("resize", scheduleVisualViewportSync, { passive: true });
window.visualViewport?.addEventListener("resize", scheduleVisualViewportSync, { passive: true });
window.visualViewport?.addEventListener("scroll", scheduleVisualViewportSync, { passive: true });
window.addEventListener("online", () => void resumeForeground());
window.addEventListener("offline", () => {
  if (document.visibilityState === "hidden" || hasHealthyStream()) return;
  clearTimeout(state.offlineProbeTimer);
  state.offlineProbeTimer = setTimeout(async () => {
    state.offlineProbeTimer = null;
    if (document.visibilityState === "hidden" || hasHealthyStream()) return;
    const synced = await refreshSessions({ force: true });
    if (hasHealthyStream()) return;
    if (synced) showConnectionRecovery();
    else if (streamEventAge() > CONNECTION_TRANSIENT_GRACE_MS) updateConnection("connecting", "网络恢复中");
  }, 600);
});
window.addEventListener("pagehide", persistDraftsNow);
if (state.soundEnabled) document.addEventListener("pointerdown", () => void unlockSignalSound(), { once: true });
updateNotifyButton();
syncVisualViewport();
bootstrap();
setInterval(() => scheduleRender(), 30_000);
