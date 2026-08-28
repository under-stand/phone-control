#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPhoneControlServer } from "../src/server.mjs";

if (process.env.GITHUB_ACTIONS === "true") {
  process.on("uncaughtExceptionMonitor", (error) => {
    const details = String(error?.stack || error || "Unknown mobile regression failure")
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    process.stderr.write(`::error file=scripts/mobile-regression.mjs,title=Mobile regression failed::${details}\n`);
  });
}

const playwrightPath = process.env.PHONE_CONTROL_PLAYWRIGHT || null;
const browserPath = process.env.PHONE_CONTROL_BROWSER || null;
const outputDir = path.resolve(process.env.PHONE_CONTROL_AUDIT_DIR || "artifacts/mobile-regression");
const playwright = playwrightPath
  ? await import(pathToFileURL(path.resolve(playwrightPath)))
  : await import("playwright");
const { chromium } = playwright.default || playwright;

async function waitUntil(read, { timeoutMs = 8_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for the mobile regression condition");
}

async function continueRouteUnlessCancelled(route) {
  try {
    await route.continue();
  } catch (error) {
    if (!/Route is already handled|Target page, context or browser has been closed/i.test(error?.message || "")) {
      throw error;
    }
  }
}

class AuditBridge extends EventEmitter {
  constructor() {
    super();
    this.threads = new Map();
    this.interruptions = [];
    this.createdSessions = [];
    this.deletedSessions = [];
    this.connected = false;
  }

  status() {
    return {
      connected: this.connected,
      initialized: this.connected,
      transport: "audit",
      server: { userAgent: "codex-audit" },
      loadedThreads: Array.from(this.threads.keys()),
      subscribedThreads: Array.from(this.threads.keys()),
      threadStates: Object.fromEntries(this.threads),
      unavailableThreads: [],
      retryingSubscriptions: 0,
      pendingQuestions: 0,
    };
  }

  set(threadId, state) {
    this.threads.set(threadId, state);
    this.emit("status", this.status());
  }

  async start() {
    this.connected = true;
    this.emit("status", this.status());
    return true;
  }

  async codexStatus() {
    return {
      available: true,
      checkedAt: new Date().toISOString(),
      server: { userAgent: "codex-audit" },
      account: { type: "chatgpt", email: "a…t@example.com", planType: "pro" },
      configuration: { model: "gpt-5.6", reasoningEffort: "high", serviceTier: "priority", approvalsReviewer: "auto_review", sandboxMode: "workspace-write" },
      usage: { limits: [], resetCreditsAvailable: 0 },
      partial: true,
    };
  }

  async modelCatalog() {
    return {
      available: true,
      checkedAt: new Date().toISOString(),
      machineName: "Audit Mac",
      workspaces: [
        { path: "/workspace/phone-control" },
        { path: "/archive/phone-control" },
        { path: "/workspace/history-project" },
      ],
      models: [{
        id: "gpt-5.6",
        displayName: "GPT-5.6",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
        reasoningEffortDetails: [{ id: "medium", description: "Balanced" }, { id: "high", description: "Deep" }, { id: "xhigh", description: "Extra deep" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
        defaultServiceTier: null,
        inputModalities: ["text", "image"],
        isDefault: true,
      }, {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Codex",
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: ["high", "xhigh"],
        reasoningEffortDetails: [{ id: "high", description: "Deep" }, { id: "xhigh", description: "Extra deep" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
        defaultServiceTier: null,
        inputModalities: ["text", "image"],
        isDefault: false,
      }],
    };
  }

  async interruptTurn({ sessionId, expectedTurnId }, device) {
    const state = this.threads.get(sessionId);
    assert.equal(state?.status, "active");
    assert.equal(state?.activeTurnId, expectedTurnId);
    const operation = {
      id: `audit-interrupt-${this.interruptions.length + 1}`,
      sessionId,
      turnId: expectedTurnId,
      action: "interrupt",
      status: "delivered",
      delivery: "delivered",
      deliveredAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.interruptions.push(operation);
    this.set(sessionId, { ...state, activeFlags: ["interruptRequested"] });
    this.emit("interrupt", operation);
    return operation;
  }

  async createSession({ text, cwd, model, reasoningEffort, serviceTier, clientMessageId }, device) {
    const sessionId = `thread-phone-created-${this.createdSessions.length + 1}`;
    const turnId = `turn-phone-created-${this.createdSessions.length + 1}`;
    const command = {
      id: clientMessageId,
      sessionId,
      turnId,
      expectedTurnId: null,
      action: "create",
      model: model || "gpt-5.6",
      reasoningEffort: reasoningEffort || "high",
      serviceTier: serviceTier || "default",
      status: "delivered",
      delivery: "delivered",
      cwd,
      deliveredAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.createdSessions.push({ ...command, text });
    this.set(sessionId, { status: "active", activeFlags: [], activeTurnId: turnId });
    this.emit("command", command);
    return command;
  }

  async deleteSession({ sessionId }, device) {
    const state = this.threads.get(sessionId);
    assert.notEqual(state?.status, "active", "the mobile UI must not delete an active Codex session");
    const operation = {
      id: `audit-delete-${this.deletedSessions.length + 1}`,
      sessionId,
      action: "delete",
      status: "deleted",
      delivery: "delivered",
      deletedAt: new Date().toISOString(),
      decidedBy: device.id,
    };
    this.deletedSessions.push(operation);
    this.threads.delete(sessionId);
    this.emit("thread/deleted", { threadId: sessionId });
    this.emit("status", this.status());
    return operation;
  }

  async close() {
    this.connected = false;
  }
}

function event(sessionId, index, kind, extras = {}) {
  const baseTime = sessionId === "thread-history" ? Date.now() - 3 * 86_400_000 : Date.now();
  return {
    eventId: `${sessionId}-${index}-${kind}`,
    source: "mobile-audit",
    provider: "codex",
    sessionId,
    turnId: extras.turnId || `turn-${sessionId}`,
    at: new Date(baseTime - (80 - index) * 1_000).toISOString(),
    kind,
    surface: "CLI",
    cwd: `/workspace/${sessionId === "thread-active" ? "phone-control" : "history-project"}`,
    model: "gpt-5.6",
    reasoningEffort: "high",
    permissionMode: "workspace-write",
    ...extras,
  };
}

await mkdir(outputDir, { recursive: true });
const dataDir = path.join(outputDir, `.runtime-${process.pid}`);
const bridge = new AuditBridge();
const runtime = await createPhoneControlServer({
  config: { host: "127.0.0.1", port: 0, token: "mobile-audit-token", dataDir, machineName: "Audit Mac", interactions: { enabled: true }, approvals: { enabled: false } },
  scanRollouts: false,
  appServerBridge: bridge,
  taskTitleGenerator: { suggest: async () => ({ title: "验证手机新建会话", cached: false }) },
});
let browser;
try {
  const started = await runtime.start();
  for (let index = 0; index < 25; index += 1) {
    const paired = runtime.devices.pair({ name: `Revoked audit phone ${index + 1}` });
    runtime.devices.revoke(paired.device.id);
  }
  assert.deepEqual(runtime.devices.counts(), { active: 0, revoked: 20, total: 20 }, "revoked device history must stay bounded before it reaches the mobile UI");
  runtime.store.ingest(event("thread-active", 68, "user_prompt", { source: "rollout", turnId: null, message: { role: "user", text: "<recommended_plugins>\n- GitHub\n</recommended_plugins><environment_context>\n  <cwd>/workspace/phone-control</cwd>\n</environment_context>" } }));
  runtime.store.ingest(event("thread-active", 69, "turn_start", { source: "rollout", turnId: "turn-thread-active" }));
  runtime.store.ingest(event("thread-active", 70, "user_prompt", { source: "hook", turnId: "turn-thread-active", message: { role: "user", text: "把手机端会话体验继续打磨，并检查图片发送。" } }));
  runtime.store.ingest(event("thread-active", 71, "user_prompt", { source: "rollout", turnId: null, message: { role: "user", text: "把手机端会话体验继续打磨，并检查图片发送。" } }));
  runtime.store.ingest(event("thread-active", 71.5, "assistant_message", { source: "rollout", turnId: "turn-thread-active", message: { role: "assistant", text: Array.from({ length: 14 }, (_, index) => `过程回复第 ${index + 1} 行：展开后必须完整显示这一整行，不能在字形中部裁断。`).join("\n") } }));
  const finalAssistantReply = `我正在检查移动端布局、输入稳定性和图片附件链路。
第二行应该保留换行，并让 **关键信息** 更容易阅读。

| 检查项 | 状态 | 手机表现 | 备注 |
| :--- | :---: | ---: | --- |
| 会话布局 | 进行中 | 稳定 | 不撑破页面 |
| 图片附件 | 正常 | 可预览 | 保留草稿 |

- 保留段落和换行
- 宽表格允许横向滚动

3. 保留原始起始序号
7. 非连续序号也不能被改写

官网：[OpenAI Research](https://openai.com/research)
裸链接：https://example.com/docs?q=phone。
自动链接：<https://example.org/mobile>
省略协议：www.example.net/guide
危险协议：[不要打开](javascript:alert(1))
凭证网址：https://user:pass@example.net/private
行内代码：\`https://inside-code.example\`

\`\`\`text
line one
https://inside-fence.example
\`\`\`

<b>这段 HTML 只应显示为文本</b>`;
  runtime.store.ingest(event("thread-active", 72, "assistant_message", { source: "rollout", turnId: null, message: { role: "assistant", text: finalAssistantReply } }));
  bridge.set("thread-active", { status: "active", activeFlags: [], activeTurnId: "turn-thread-active" });

  let historyIndex = 1;
  for (let turn = 1; turn <= 34; turn += 1) {
    const turnId = `turn-thread-history-${turn}`;
    runtime.store.ingest(event("thread-history", historyIndex++, "user_prompt", { turnId, message: { role: "user", text: `历史任务 ${turn}：检查这一轮的实现和结果。` } }));
    runtime.store.ingest(event("thread-history", historyIndex++, "tool_start", { turnId, tool: { name: turn % 2 ? "exec" : "apply_patch", summary: "处理历史任务" } }));
    runtime.store.ingest(event("thread-history", historyIndex++, "assistant_message", { turnId, message: { role: "assistant", text: `历史回复 ${turn}：这里是一段足够长的文字，用于确认手机上按轮次浏览消息，不会被工具活动淹没。`.repeat(3) } }));
    runtime.store.ingest(event("thread-history", historyIndex++, "turn_complete", { turnId }));
  }
  bridge.set("thread-history", { status: "idle", activeFlags: [], activeTurnId: null });
  runtime.store.ingest(event("thread-archive", 1, "user_prompt", { cwd: "/archive/phone-control", turnId: "turn-thread-archive", message: { role: "user", text: "验证同名项目的路径辨识。" } }));
  runtime.store.ingest(event("thread-archive", 2, "assistant_message", { cwd: "/archive/phone-control", turnId: "turn-thread-archive", message: { role: "assistant", text: "同名项目应显示唯一父路径。" } }));
  runtime.store.ingest(event("thread-archive", 3, "turn_complete", { cwd: "/archive/phone-control", turnId: "turn-thread-archive" }));
  runtime.store.ingest(event("hook-timing", 79, "user_prompt", { source: "hook", cwd: "/tmp", turnId: null, message: { role: "user", text: "timing test" } }));

  browser = await chromium.launch({
    ...(browserPath ? { executablePath: path.resolve(browserPath) } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  let sessionListRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/sessions") sessionListRequests += 1;
  });
  await page.addInitScript(() => {
    localStorage.setItem("phone-control-sound", "1");
    window.__phoneControlCopiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { window.__phoneControlCopiedText = String(value); } },
    });
    // Android can briefly expose a stale false value while a VPN route is
    // already usable. The app must rely on real same-origin probes instead.
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false });
    let forcedViewport = null;
    const viewport = new EventTarget();
    for (const [key, read] of Object.entries({
      width: () => forcedViewport?.width ?? innerWidth,
      height: () => forcedViewport?.height ?? innerHeight,
      offsetTop: () => forcedViewport?.offsetTop ?? 0,
      offsetLeft: () => forcedViewport?.offsetLeft ?? 0,
      pageTop: () => forcedViewport?.offsetTop ?? 0,
      pageLeft: () => forcedViewport?.offsetLeft ?? 0,
      scale: () => 1,
    })) Object.defineProperty(viewport, key, { configurable: true, get: read });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    window.__setPhoneControlVisualViewport = (frame) => {
      forcedViewport = frame;
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
    };
    window.addEventListener("resize", () => {
      if (!forcedViewport) viewport.dispatchEvent(new Event("resize"));
    });
  });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    errors.push(`${location.url || "page"}:${location.lineNumber || 0} ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${started.port}/?token=mobile-audit-token`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-session-id="thread-active"]').waitFor();
  assert.equal(await page.locator('[data-session-id="hook-timing"]').count(), 0, "legacy hook timing diagnostics must not appear as recent tasks");
  assert.doesNotMatch(await page.locator('[data-session-id="thread-active"]').innerText(), /:?-{3,}:?/, "task summaries must not leak Markdown table syntax");
  await page.locator('#connection[data-state="online"]').waitFor();
  assert.equal(await page.locator("#connection").evaluate((element) => element.tagName), "BUTTON", "the live connection indicator must be directly actionable");
  const requestsBeforeHealthyLifecycleNoise = sessionListRequests;
  await page.evaluate(() => {
    document.dispatchEvent(new Event("resume"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
  });
  await page.waitForTimeout(300);
  assert.equal(sessionListRequests, requestsBeforeHealthyLifecycleNoise, "healthy lifecycle events must reuse the existing SSE connection instead of starting redundant snapshots");
  assert.equal(await page.locator("#connection").getAttribute("data-state"), "online", "healthy lifecycle noise must not make the connection indicator flicker");
  const requestsBeforeManualReconnect = sessionListRequests;
  await page.evaluate(() => {
    document.querySelector("#connection").click();
    document.querySelector("#connection").click();
  });
  await waitUntil(() => sessionListRequests > requestsBeforeManualReconnect);
  await page.locator('#connection[data-state="online"]:not([aria-busy="true"])').waitFor();
  assert.equal(sessionListRequests, requestsBeforeManualReconnect + 1, "rapid taps must coalesce into one immediate machine probe");
  await page.locator('[data-session-id="thread-active"]').click();
  await page.locator("#detail[open] .conversation-turn").waitFor();
  await page.evaluate(() => {
    window.__reconnectConversationNode = document.querySelector("#detail[open] .conversation-turn");
    window.__detailClosedDuringReconnect = 0;
    const detail = document.querySelector("#detail");
    new MutationObserver(() => {
      if (!detail.open) window.__detailClosedDuringReconnect += 1;
    }).observe(detail, { attributes: true, attributeFilter: ["open"] });
  });
  bridge.connected = false;
  bridge.emit("status", bridge.status());
  await page.waitForTimeout(80);
  bridge.connected = true;
  bridge.emit("status", bridge.status());
  await page.waitForTimeout(850);
  assert.equal(await page.locator("#detail").getAttribute("open"), "", "late reconnect stabilization must keep the opened detail dialog visible");
  assert.equal(await page.evaluate(() => document.querySelector("#detail[open] .conversation-turn") === window.__reconnectConversationNode), true, "control-only reconnect updates must preserve the existing conversation DOM");
  assert.equal(await page.evaluate(() => window.__detailClosedDuringReconnect), 0, "reconnect stabilization must never close and reopen the detail dialog");
  await page.locator("#detail-close").click();
  const onlineRequestBaseline = sessionListRequests;
  await page.waitForTimeout(16_000);
  assert.equal(sessionListRequests, onlineRequestBaseline, "a healthy SSE stream must not trigger periodic full session-list polling");

  const requestsBeforeBackground = sessionListRequests;
  await page.evaluate(() => document.dispatchEvent(new Event("freeze")));
  await page.locator('#connection[data-state="paused"]').waitFor();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.evaluate(() => {
    document.dispatchEvent(new Event("resume"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
  });
  await page.locator('#connection[data-state="online"]').waitFor();
  await page.waitForTimeout(250);
  assert.equal(sessionListRequests, requestsBeforeBackground + 1, "foreground lifecycle bursts must coalesce into one fresh snapshot even when navigator.onLine is false");

  await context.setOffline(true);
  await page.waitForTimeout(2_000);
  assert.equal(await page.locator("#connection").getAttribute("data-state"), "online", "a brief network transition must keep a fresh live state stable instead of flickering through retry labels");
  await context.setOffline(false);
  await page.locator('#connection[data-state="online"]').waitFor();
  assert.equal(await page.locator('[data-filter="diagnostics"]').count(), 0, "the daily mobile UI must not expose diagnostic records");
  await page.screenshot({ path: path.join(outputDir, "01-recent-tasks.png"), fullPage: false });

  const taskSearch = page.locator("#task-search-input");
  assert.equal(await page.locator('[data-session-id="thread-active"] h3').innerText(), "把手机端会话体验继续打磨，并检查图片发送", "a task card must lead with the stable user goal");
  assert.match(await page.locator('[data-session-id="thread-active"] .task-progress-line').innerText(), /进展[\s\S]*(?:检查|执行)/, "a task card must expose current progress separately from its goal");
  await taskSearch.fill("历史回复 12");
  await page.locator("#task-search-summary").filter({ hasText: /找到 1 个任务/ }).waitFor();
  assert.match(await page.locator('[data-filter="all"]').getAttribute("class"), /active/, "search must cover the complete task archive by default");
  const historicalSearchCard = page.locator('[data-session-id="thread-history"]');
  await historicalSearchCard.waitFor();
  assert.match(await historicalSearchCard.locator("h3").innerText(), /历史任务 34/, "a long conversation must lead with its latest self-contained task");
  assert.match(await historicalSearchCard.locator(".task-topic").innerText(), /主题[\s\S]*历史任务 1/, "a long conversation must keep its stable topic as secondary context");
  assert.match(await historicalSearchCard.locator(".task-match").innerText(), /历史回复 12/);
  assert.ok(await historicalSearchCard.getAttribute("data-search-event-id"), "a transcript search result must retain its exact message identity");
  await page.screenshot({ path: path.join(outputDir, "01-task-search.png"), fullPage: false });
  await historicalSearchCard.click();
  const highlightedHistoricalReply = page.locator('#detail[open] .turn-message.search-hit').filter({ hasText: /历史回复 12/ });
  await highlightedHistoricalReply.waitFor();
  assert.equal(await highlightedHistoricalReply.count(), 1, "opening a search result must reveal and highlight the exact matching historical reply");
  await page.locator("#detail-close").click();
  await page.locator("#task-search-clear").click();
  assert.match(await page.locator('[data-filter="recent"]').getAttribute("class"), /active/, "clearing search must restore the previous task scope");
  await page.locator('article[data-session-id="thread-history"]').waitFor({ state: "detached" });

  await page.locator("#new-session-button").click();
  await page.locator("#new-session-dialog[open]").waitFor();
  assert.equal(await page.locator("#new-session-cwd").inputValue(), "/workspace/phone-control", "new sessions should default to the most recent workspace");
  assert.equal(await page.locator("#new-session-runtime").getAttribute("open"), null, "advanced runtime controls should stay collapsed until requested");
  assert.equal(await page.locator('[data-workspace-path$="/phone-control"]').count(), 2, "same-named projects must remain individually selectable");
  assert.match(await page.locator('[data-workspace-path="/workspace/phone-control"] .workspace-row-copy small').innerText(), /workspace/);
  assert.match(await page.locator('[data-workspace-path="/archive/phone-control"] .workspace-row-copy small').innerText(), /archive/);
  assert.equal(await page.locator(".workspace-selected-path code").innerText(), "/workspace/phone-control", "the selected project must disclose its full machine path");
  await page.locator('[data-workspace-path="/archive/phone-control"]').click();
  assert.equal(await page.locator(".workspace-selected-path code").innerText(), "/archive/phone-control");
  await page.locator('[data-workspace-path="/workspace/phone-control"]').click();
  await page.locator("#new-session-runtime > summary").click();
  await page.locator('#new-session-model option[value="gpt-5.6-sol"]').waitFor({ state: "attached" });
  await page.locator("#new-session-model").selectOption("gpt-5.6-sol");
  await page.locator('[data-new-effort-value="xhigh"]').click();
  assert.equal(await page.locator("#new-session-fast").isEnabled(), true, "Fast must be an actionable model capability");
  await page.locator("#new-session-fast-row").click();
  await page.locator("#new-session-fast-row").click();
  await page.locator("#new-session-input").fill("从手机创建一个独立 Codex 会话并验证删除流程");
  await page.setViewportSize({ width: 390, height: 667 });
  const newSessionSubmitBox = await page.locator("#new-session-submit").boundingBox();
  assert.ok(newSessionSubmitBox && newSessionSubmitBox.y >= 0 && newSessionSubmitBox.y + newSessionSubmitBox.height <= 667, "the create-session action must remain visible after runtime settings expand");
  assert.match(await page.locator("#new-session-submit-summary").innerText(), /phone-control.*gpt-5\.6-sol.*超高/);
  await page.screenshot({ path: path.join(outputDir, "02-new-session-form.png"), fullPage: false });
  await page.locator("#new-session-submit").click();
  await page.setViewportSize({ width: 412, height: 915 });
  await page.locator("#new-session-dialog").waitFor({ state: "hidden" });
  await page.locator('article[data-session-id="thread-phone-created-1"]').waitFor();
  await page.locator('#detail[open][data-session-id="thread-phone-created-1"]').waitFor();
  assert.equal(bridge.createdSessions[0].cwd, "/workspace/phone-control");
  assert.match(bridge.createdSessions[0].text, /独立 Codex 会话/);
  assert.equal(bridge.createdSessions[0].model, "gpt-5.6-sol");
  assert.equal(bridge.createdSessions[0].reasoningEffort, "xhigh");
  assert.equal(bridge.createdSessions[0].serviceTier, "priority");
  await page.locator("#detail[open] [data-open-task-title]").click();
  assert.equal(await page.locator("#detail[open] .technical-details").getAttribute("open"), "", "the compact header naming action must reveal task-title controls directly");
  await page.locator('[data-task-title-form="thread-phone-created-1"] .task-title-suggest').waitFor();
  await page.locator('[data-task-title-form="thread-phone-created-1"] .task-title-suggest').click();
  assert.equal(await page.locator('[data-task-title-form="thread-phone-created-1"] [data-task-title-input]').inputValue(), "验证手机新建会话");
  await page.screenshot({ path: path.join(outputDir, "02b-smart-task-title.png"), fullPage: false });
  await page.locator('[data-task-title-form="thread-phone-created-1"] [data-task-title-input]').fill("手机新建会话验收");
  await page.locator('[data-task-title-form="thread-phone-created-1"] .task-title-save').click();
  await page.locator("#detail[open] h2").filter({ hasText: "手机新建会话验收" }).waitFor();
  await page.locator('[data-task-title-form="thread-phone-created-1"] .task-title-reset').click();
  await page.locator("#detail[open] h2").filter({ hasText: /从手机创建一个独立 Codex 会话/ }).waitFor();
  assert.equal(await page.locator('[data-delete-session="thread-phone-created-1"]').isDisabled(), true, "an active session must not be deletable");
  runtime.store.ingest(event("thread-phone-created-1", 1, "turn_complete", { turnId: "turn-phone-created-1" }));
  bridge.set("thread-phone-created-1", { status: "idle", activeFlags: [], activeTurnId: null });
  await page.waitForTimeout(400);
  await page.locator("#detail-close").click();
  await page.locator('article[data-session-id="thread-phone-created-1"]').click();
  await page.locator("#detail[open] .technical-details summary").click();
  const deleteCreated = page.locator('[data-delete-session="thread-phone-created-1"]');
  assert.equal(await deleteCreated.isEnabled(), true);
  page.once("dialog", async (dialog) => {
    assert.match(dialog.message(), /原始记录/);
    assert.match(dialog.message(), /子会话/);
    assert.match(dialog.message(), /不可恢复/);
    await dialog.accept();
  });
  await deleteCreated.click();
  await page.locator('article[data-session-id="thread-phone-created-1"]').waitFor({ state: "detached" });
  assert.equal(bridge.deletedSessions[0].sessionId, "thread-phone-created-1");

  const detailRoute = /\/api\/sessions\/thread-active\?events=72$/;
  await page.route(detailRoute, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await continueRouteUnlessCancelled(route);
  }, { times: 1 });
  const detailPreviewStartedAt = performance.now();
  await page.locator('[data-session-id="thread-active"]').click();
  await page.locator("#detail[open] .detail-heading").waitFor();
  const detailPreviewMs = Math.round(performance.now() - detailPreviewStartedAt);
  assert.ok(detailPreviewMs < 300, `the summary-backed detail preview took ${detailPreviewMs}ms`);
  await page.locator('[data-target-session-id="thread-active"]').click();
  assert.equal(await page.evaluate(() => localStorage.getItem("phone-control-target-session-v1")), "thread-active");
  assert.equal(await page.locator('[data-target-session-id="thread-active"]').getAttribute("aria-pressed"), "true");
  await page.locator("#detail-close").click();
  await page.locator('#target-tracker[data-status="working"]').waitFor();
  assert.match(await page.locator("#target-tracker").getAttribute("class"), /is-compact/, "a tracked task already visible in the current filter should use the compact tracker");
  assert.match(await page.locator("#target-progress").textContent(), /正在|执行/);
  await page.screenshot({ path: path.join(outputDir, "02-target-tracker.png"), fullPage: false });
  await page.locator("#target-open").click();
  await page.locator("#detail[open]").waitFor();
  assert.equal(await page.locator("#detail").evaluate((element) => getComputedStyle(element).height), `${await page.evaluate(() => innerHeight)}px`, "the detail dialog must follow the dynamic visual viewport height");
  await page.locator("#detail[open] .composer-launch").waitFor();
  await page.locator("#detail-close").click();
  let delayedDetailRequested = false;
  let releaseDelayedDetail;
  const delayedDetailGate = new Promise((resolve) => { releaseDelayedDetail = resolve; });
  const keyboardRaceRoute = /\/api\/sessions\/thread-active\?events=(?:72|all)$/;
  await page.route(keyboardRaceRoute, async (route) => {
    delayedDetailRequested = true;
    await delayedDetailGate;
    await continueRouteUnlessCancelled(route);
  }, { times: 1 });
  await page.locator("#target-open").click();
  await page.locator("#detail[open] .composer-launch").waitFor();
  await waitUntil(() => delayedDetailRequested);
  await page.locator("[data-expand-composer]").click();
  const keyboardGuardInput = page.locator("#detail[open] [data-session-input]");
  await keyboardGuardInput.evaluate((element) => { element.dataset.keyboardGuard = "active"; });
  assert.equal(await keyboardGuardInput.evaluate((element) => document.activeElement === element), true, "the composer must focus synchronously from the user's tap");
  releaseDelayedDetail();
  await page.locator("#detail[open] [data-refresh-detail]:visible").waitFor();
  assert.equal(await page.locator('[data-session-input][data-keyboard-guard="active"]').count(), 1, "a late detail response must not replace the focused input node");
  assert.equal(await keyboardGuardInput.evaluate((element) => document.activeElement === element), true, "a late detail response must not dismiss the mobile keyboard");
  const sheetBeforeKeyboard = await page.locator("#detail[open] .detail-sheet").boundingBox();
  assert.ok(sheetBeforeKeyboard);
  await page.evaluate(() => window.__setPhoneControlVisualViewport({ width: 412, height: 360, offsetTop: 12, offsetLeft: 0 }));
  await waitUntil(async () => await page.locator("#detail").evaluate((element) => getComputedStyle(element).height) === "360px");
  const detailWithKeyboard = await page.locator("#detail[open]").boundingBox();
  const sheetWithKeyboard = await page.locator("#detail[open] .detail-sheet").boundingBox();
  const inputWithKeyboard = await keyboardGuardInput.boundingBox();
  const submitWithKeyboard = await page.locator("#detail[open] .command-submit").boundingBox();
  const keyboardEdge = 372;
  assert.ok(sheetBeforeKeyboard.y + sheetBeforeKeyboard.height > keyboardEdge, "the baseline detail sheet should reach beneath the simulated keyboard edge");
  assert.ok(detailWithKeyboard && Math.abs(detailWithKeyboard.y - 12) <= 1 && Math.abs(detailWithKeyboard.height - 360) <= 1, "the detail dialog must follow the visual viewport's top and height");
  assert.ok(sheetWithKeyboard && sheetWithKeyboard.y + sheetWithKeyboard.height <= keyboardEdge + 1, "the detail sheet must rise above an overlaying mobile keyboard");
  assert.ok(inputWithKeyboard && inputWithKeyboard.y + inputWithKeyboard.height <= keyboardEdge + 1, "the continuation input must stay visible above the keyboard");
  assert.ok(submitWithKeyboard && submitWithKeyboard.y + submitWithKeyboard.height <= keyboardEdge + 1, "the continuation submit action must stay fully visible above the keyboard");
  assert.equal(await keyboardGuardInput.evaluate((element) => document.activeElement === element), true, "moving the sheet above the keyboard must preserve input focus");
  await page.screenshot({ path: path.join(outputDir, "03-keyboard-viewport.png"), fullPage: false });
  await page.evaluate(() => window.__setPhoneControlVisualViewport(null));
  await waitUntil(async () => await page.locator("#detail").evaluate((element) => getComputedStyle(element).height) === `${await page.evaluate(() => innerHeight)}px`);
  await page.locator("[data-collapse-composer]").click();
  await page.unroute(keyboardRaceRoute);
  const pendingDetailUpdate = page.locator("#detail[open] [data-refresh-detail]");
  if (await pendingDetailUpdate.isVisible()) {
    await pendingDetailUpdate.click();
    await pendingDetailUpdate.waitFor({ state: "hidden" });
  }
  const richReply = page.locator('#detail[open] .conversation-turn .turn-assistant .timeline-rich').last();
  await richReply.waitFor();
  const copyButtons = page.locator("#detail[open] .conversation-turn .turn-assistant [data-copy-message]");
  assert.equal(await copyButtons.count(), 2, "both process and final Codex replies should provide a copy action");
  await copyButtons.last().click();
  assert.equal(await page.evaluate(() => window.__phoneControlCopiedText), finalAssistantReply, "copy must preserve the complete original Markdown reply");
  assert.equal(await copyButtons.last().innerText(), "已复制", "the copy action should acknowledge success in place");
  assert.equal(await page.locator("#detail[open] .conversation-turn").count(), 1, "Hook and rollout copies of one prompt must stay in one conversation turn");
  assert.equal(await page.locator("#detail[open] .conversation-turn .turn-user").count(), 1, "the duplicate cross-source prompt must render once");
  await page.locator("#detail[open] .turn-updates summary").click();
  const expandedProcessReply = page.locator("#detail[open] .turn-updates .timeline-rich").first();
  const processReplySize = await expandedProcessReply.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  assert.ok(processReplySize.clientHeight + 2 >= processReplySize.scrollHeight, "an opened process reply must show complete lines without clipping its last row");
  assert.equal(await page.locator("#detail[open] .turn-updates .timeline-expand:visible").count(), 0, "an opened process-reply group must not retain a nested text expander");
  assert.match(await page.locator("#detail[open] .turn-header small").innerText(), /gpt-5\.6.*推理 高/, "every visible turn should show its effective model and reasoning effort");
  assert.equal(await page.locator("#detail[open] .turn-process:not([open])").count(), 1, "tool activity should start collapsed inside its conversation turn");
  assert.equal(await richReply.locator("table").count(), 1, "Markdown tables must render as semantic tables");
  assert.equal(await richReply.locator("tbody tr").count(), 2);
  assert.equal(await richReply.locator("ul li").count(), 2);
  assert.equal(await richReply.locator("ol").getAttribute("start"), "3");
  assert.deepEqual(await richReply.locator("ol li").evaluateAll((items) => items.map((item) => item.value)), [3, 7]);
  assert.deepEqual(await richReply.locator("ol .list-marker").allTextContents(), ["3.", "7."]);
  assert.equal(await richReply.locator("pre code").count(), 1);
  assert.ok(await richReply.locator("p br").count() >= 1, "single newlines inside a paragraph must remain visible");
  assert.equal(await richReply.locator("script, b").count(), 0, "raw HTML from a transcript must never become active markup");
  assert.match(await richReply.innerText(), /<b>这段 HTML 只应显示为文本<\/b>/);
  const links = richReply.locator("a.external-link");
  assert.equal(await links.count(), 4, "Markdown, bare, autolink, and www web URLs must become clickable");
  assert.equal(await links.nth(0).getAttribute("href"), "https://openai.com/research");
  assert.equal(await links.nth(1).getAttribute("href"), "https://example.com/docs?q=phone");
  assert.equal(await links.nth(2).getAttribute("href"), "https://example.org/mobile");
  assert.equal(await links.nth(3).getAttribute("href"), "https://www.example.net/guide");
  for (let index = 0; index < await links.count(); index += 1) {
    assert.equal(await links.nth(index).getAttribute("target"), "_blank");
    assert.equal(await links.nth(index).getAttribute("rel"), "noopener noreferrer");
    assert.equal(await links.nth(index).getAttribute("referrerpolicy"), "no-referrer");
  }
  assert.equal(await richReply.locator('a[href^="javascript:"]').count(), 0, "unsafe URL schemes must remain plain text");
  assert.match(await richReply.innerText(), /\[不要打开\]\(javascript:alert\(1\)\)/);
  assert.equal(await richReply.locator('a[href*="user:pass"]').count(), 0, "credential-bearing URLs must remain plain text");
  assert.equal(await richReply.locator("code a").count(), 0, "URLs inside inline and fenced code must remain plain text");
  const tableScroll = await richReply.locator(".timeline-table-wrap").evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(tableScroll.scroll > tableScroll.client, "a wide table must scroll horizontally instead of widening the detail sheet");
  const replyRow = richReply.locator("xpath=..");
  await replyRow.locator("[data-expand-message]").click();
  assert.match(await replyRow.getAttribute("class"), /is-expanded/);
  assert.ok((await richReply.boundingBox()).height > 74, "expanding a rich reply must reveal content beyond the compact preview");
  const turnUpdates = page.locator("#detail[open] .turn-updates");
  const turnProcess = page.locator("#detail[open] .turn-process");
  assert.equal(await turnUpdates.getAttribute("open"), "", "process replies should still be open before a live refresh");
  await turnProcess.locator("summary").click();
  const updatesSummaryBefore = await turnUpdates.locator("summary").innerText();
  runtime.store.ingest(event("thread-active", 72.2, "assistant_message", { source: "rollout", turnId: "turn-thread-active", message: { role: "assistant", text: "实时更新后的最新过程状态。" } }));
  await waitUntil(async () => await turnUpdates.locator("summary").innerText() !== updatesSummaryBefore);
  assert.equal(await turnUpdates.getAttribute("open"), "", "an open process-reply group must survive live status updates");
  assert.equal(await turnProcess.getAttribute("open"), "", "an open run-details group must survive live status updates");
  assert.equal(await page.locator("#detail[open] .session-composer").count(), 0, "the full composer should not consume detail space before use");
  assert.match(await page.locator("#detail[open] .action-dock").getAttribute("class"), /is-compact/);
  assert.equal(await page.locator("#detail[open] .action-dock.is-compact [data-interrupt-session]").count(), 1, "stop should remain available as a compact secondary action");
  assert.equal(await page.locator("#detail[open] .detail-header [data-target-session-id]").count(), 1, "target tracking should remain available in the compact detail header");
  assert.equal(await page.locator("#detail[open] .control-note").count(), 0, "a normal controllable session should not repeat its action in a separate notice");
  assert.ok((await page.locator("#detail[open] .detail-header").boundingBox()).height <= 100, "the compact detail header must preserve conversation space");
  await page.screenshot({ path: path.join(outputDir, "02-active-detail.png"), fullPage: false });
  await page.locator("[data-expand-composer]").click();
  await page.locator("#detail[open] .session-composer").waitFor();
  assert.equal(await page.locator("#detail[open] .turn-model-settings").count(), 0, "an active turn must not offer an unsupported mid-turn model switch");
  await page.unroute(detailRoute);

  await page.locator("[data-image-input]").setInputFiles(path.join(outputDir, "01-recent-tasks.png"));
  await page.locator(".attachment-preview").waitFor();
  const activeSubmitBox = await page.locator("#detail[open] .command-submit").boundingBox();
  const activeSheetBox = await page.locator("#detail[open] .detail-sheet").boundingBox();
  assert.ok(activeSubmitBox && activeSheetBox && activeSubmitBox.y + activeSubmitBox.height <= activeSheetBox.y + activeSheetBox.height + 1, "attachments must not push the active-turn submit action outside the detail sheet");
  assert.equal(await page.locator("#detail[open]").getAttribute("class").then((value) => value.includes("composer-open")), true, "an expanded composer must use the stable split layout");
  await page.screenshot({ path: path.join(outputDir, "03-image-preview.png"), fullPage: false });

  const textarea = page.locator("[data-session-input]");
  await textarea.fill("这段手机草稿不应该被实时刷新打断");
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("phone-control-drafts-v1") || "{}")["thread-active"]), "这段手机草稿不应该被实时刷新打断");
  await page.locator("[data-collapse-composer]").click();
  assert.equal(await page.locator(".session-composer").count(), 0, "the composer should collapse without discarding its draft");
  assert.match(await page.locator(".composer-launch").innerText(), /草稿已保存.*1 张图片待发送/);
  await page.locator("[data-expand-composer]").click();
  await page.locator(".session-composer").waitFor();
  assert.equal(await page.locator("[data-session-input]").inputValue(), "这段手机草稿不应该被实时刷新打断");
  assert.equal(await page.locator(".attachment-preview").count(), 1);
  runtime.store.ingest(event("thread-active", 73, "assistant_message", { message: { role: "assistant", text: "后台又产生了一条状态更新。" } }));
  bridge.connected = false;
  bridge.emit("status", bridge.status());
  await page.waitForTimeout(650);
  const headerHeightWithUpdate = (await page.locator("#detail[open] .detail-header").boundingBox()).height;
  assert.equal(await textarea.inputValue(), "这段手机草稿不应该被实时刷新打断");
  assert.equal(await page.locator("[data-refresh-detail]").isVisible(), true);
  assert.equal(await page.locator(".detail-update-slot").evaluate((element) => element.offsetHeight), 0, "the update notice must not consume conversation layout height");
  assert.ok(headerHeightWithUpdate <= 125, "a pending detail update must not grow the compact header");
  assert.equal(await page.locator(".attachment-preview").count(), 1);
  assert.equal(await page.locator(".session-composer").count(), 1, "a reconnect must not replace the active composer");
  bridge.connected = true;
  bridge.emit("status", bridge.status());
  await page.screenshot({ path: path.join(outputDir, "04-draft-preserved.png"), fullPage: false });

  runtime.store.ingest(event("thread-active", 74, "turn_complete"));
  bridge.set("thread-active", { status: "idle", activeFlags: [], activeTurnId: null });
  await page.locator("#signal-toast:popover-open").waitFor();
  assert.equal(await textarea.inputValue(), "这段手机草稿不应该被实时刷新打断");
  await page.screenshot({ path: path.join(outputDir, "05-completion-signal.png"), fullPage: false });
  await page.locator("#signal-toast").evaluate((element) => element.hidePopover());
  runtime.store.ingest(event("thread-active", 75, "tool_end"));
  runtime.store.ingest(event("thread-active", 76, "turn_complete"));
  await page.evaluate((payload) => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "phone-control-completion", payload } }));
  }, {
    sessionId: "thread-active",
    completionKey: "thread-active:turn-thread-active",
    title: "Codex 本轮已完成",
    body: "重复通道不应再次提醒",
    tag: "duplicate-completion",
    url: "/?session=thread-active",
  });
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#signal-toast:popover-open").count(), 0, "the same completion from SSE, Push, or delayed events must not notify twice");
  assert.equal(runtime.store.get("thread-active").status, "idle", "late same-turn activity must not restore working state");

  await page.locator("#detail-close").click();
  await page.locator('#target-tracker[data-status="idle"]').waitFor();
  assert.equal(await page.locator("#target-state").innerText(), "本轮完成");
  let releaseSlowUnsubscribe;
  const slowUnsubscribe = new Promise((resolve) => { releaseSlowUnsubscribe = resolve; });
  await page.route("**/api/push/unsubscribe", async (route) => {
    await slowUnsubscribe;
    await route.abort();
  });
  await page.locator("#notify").click();
  assert.equal(await page.locator("#notify-label").innerText(), "关闭中", "the reminder control must acknowledge a tap before remote unsubscribe finishes");
  assert.equal(await page.locator("#notify").isEnabled(), true, "background reminder synchronization must not lock the control");
  releaseSlowUnsubscribe();
  await page.locator("#notify-label").filter({ hasText: /^提醒$/ }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("phone-control-sound")), null, "the reminder control must switch sound off");
  assert.equal(await page.evaluate(() => localStorage.getItem("phone-control-push-disable-pending")), "1", "an offline unsubscribe must be queued");
  await page.unroute("**/api/push/unsubscribe");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-session-id="thread-active"]').waitFor();
  await page.locator("#target-tracker:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("phone-control-target-session-v1")), "thread-active", "the chosen target must survive a mobile reload");
  await waitUntil(async () => await page.evaluate(() => localStorage.getItem("phone-control-push-disable-pending")) === null);
  assert.equal(await page.locator("#notify-label").innerText(), "提醒", "reconnect must finish the queued unsubscribe without re-enabling reminders");
  runtime.store.ingest(event("thread-active", 77, "turn_start", { turnId: "turn-thread-active-2" }));
  runtime.store.ingest(event("thread-active", 78, "turn_complete", { turnId: "turn-thread-active-2" }));
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#signal-toast:popover-open").count(), 0, "disabled reminders must remain silent");

  await page.locator('[data-filter="history"]').click();
  assert.equal(await page.locator(".project-group-collapsed").count(), 0, "a project with one history session should not render nested cards");
  await page.screenshot({ path: path.join(outputDir, "06-history-group.png"), fullPage: false });
  await page.locator('[data-session-id="thread-history"]').click();
  assert.equal(await page.locator("#detail[open] .turn-position").first().innerText(), "当前轮次", "the newest conversation turn should be labeled by position instead of a repeated generic title");
  const turnCards = page.locator("#detail[open] .conversation-turn");
  assert.ok(await turnCards.count() >= 2, "the history fixture should expose adjacent conversation turns");
  const turnCardStyles = await turnCards.evaluateAll((elements) => elements.slice(0, 2).map((element) => {
    const style = getComputedStyle(element);
    return {
      borderWidth: Number.parseFloat(style.borderTopWidth),
      borderRadius: Number.parseFloat(style.borderTopLeftRadius),
      background: style.backgroundColor,
      borderColor: style.borderTopColor,
    };
  }));
  assert.ok(turnCardStyles.every((style) => style.borderWidth >= 1 && style.borderRadius >= 14), "each conversation turn should remain a clearly bounded single-level card");
  assert.ok(turnCardStyles.every((style) => !style.background.endsWith(", 0)")), "turn cards should retain a visible surface tint");
  assert.notEqual(turnCardStyles[0].borderColor, turnCardStyles[1].borderColor, "the current turn should keep a distinct product-color emphasis");
  await page.locator("#detail[open] [data-expand-composer]").click();
  assert.equal(await page.locator("#detail[open] .turn-model-settings").count(), 1, "an idle session should offer persistent settings for subsequent turns");
  const continueInputHeight = (await page.locator("#detail[open] [data-session-input]").boundingBox()).height;
  const continueSubmitBox = await page.locator("#detail[open] .command-submit").boundingBox();
  const continueSheetBox = await page.locator("#detail[open] .detail-sheet").boundingBox();
  assert.ok(continueInputHeight >= 48, "the continuation input should remain the primary visual surface");
  assert.ok((await page.locator("#detail[open] .composer-surface").boundingBox()).height <= 135, "the unified command bar should preserve the conversation viewport");
  assert.ok(continueSubmitBox && continueSheetBox && continueSubmitBox.y + continueSubmitBox.height <= continueSheetBox.y + continueSheetBox.height + 1, "the continuation submit action must be visible before opening settings");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(outputDir, "07-continue-composer.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 667 });
  const collapsedActionHeight = (await page.locator("#detail-actions").boundingBox()).height;
  await page.locator("#detail[open] .turn-model-settings").click();
  await page.locator("#runtime-settings-dialog[open] .composer-runtime-sheet").waitFor();
  const expandedActionHeight = (await page.locator("#detail-actions").boundingBox()).height;
  const submitBox = await page.locator("#detail[open] .command-submit").boundingBox();
  const sheetBox = await page.locator("#detail[open] .detail-sheet").boundingBox();
  const runtimeSheetBox = await page.locator("#runtime-settings-dialog[open] .composer-runtime-sheet").boundingBox();
  assert.ok(Math.abs(expandedActionHeight - collapsedActionHeight) <= 4, "opening runtime settings must not steal more conversation space from the command bar");
  assert.ok(runtimeSheetBox && runtimeSheetBox.y > 0 && runtimeSheetBox.y + runtimeSheetBox.height <= 668, "runtime settings should open as a bounded second-level mobile sheet");
  assert.equal(await page.locator("#detail-close").isVisible(), false, "the parent detail close action must not compete with the second-level sheet");
  assert.equal(await page.locator("#runtime-settings-dialog [data-close-runtime]").isVisible(), true);
  await page.screenshot({ path: path.join(outputDir, "08-runtime-settings-open.png"), fullPage: false });
  assert.ok(submitBox && sheetBox && submitBox.y >= sheetBox.y && submitBox.y + submitBox.height <= Math.min(667, sheetBox.y + sheetBox.height) + 1, `the start-next-turn action must stay visible in a short mobile viewport: ${JSON.stringify({ submitBox, sheetBox, expandedActionHeight, runtimeSheetBox })}`);
  assert.equal(await page.locator('#runtime-settings-dialog [data-model-select] option[value="gpt-5.6-sol"]').count(), 1);
  await page.locator('#runtime-settings-dialog [data-model-select]').selectOption("gpt-5.6-sol");
  await page.locator('#runtime-settings-dialog [data-effort-value="xhigh"]').click();
  assert.equal(await page.locator('#runtime-settings-dialog [data-fast-toggle]').isEnabled(), true);
  const fastBox = await page.locator('#runtime-settings-dialog .fast-switch').boundingBox();
  const runtimeAfterSelection = await page.locator("#runtime-settings-dialog .composer-runtime-sheet").boundingBox();
  assert.ok(fastBox && runtimeAfterSelection && fastBox.y >= runtimeAfterSelection.y && fastBox.y + fastBox.height <= runtimeAfterSelection.y + runtimeAfterSelection.height, "runtime controls must remain reachable inside their own sheet");
  await page.locator('#runtime-settings-dialog .fast-switch').click();
  assert.equal(await page.locator('#runtime-settings-dialog [data-fast-toggle]').isChecked(), false);
  const submitAfterSettingsScroll = await page.locator("#detail[open] .command-submit").boundingBox();
  assert.ok(submitAfterSettingsScroll && Math.abs(submitAfterSettingsScroll.y - submitBox.y) <= 1, "scrolling runtime settings must not move the start-new-turn action");
  assert.match(await page.locator("#detail[open] .turn-model-settings").innerText(), /gpt-5\.6-sol.*超高/);
  await page.locator("#runtime-settings-dialog [data-close-runtime]").click();
  await page.locator("#runtime-settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#detail-close").isVisible(), true);
  await page.locator("#detail[open] [data-collapse-composer]").click();
  await page.setViewportSize({ width: 412, height: 915 });
  await page.locator("[data-expand-history]").click();
  const firstHistoryBatch = await page.locator("[data-older-turn]").count();
  assert.ok(firstHistoryBatch > 0 && firstHistoryBatch <= 8, "history must render in bounded turn batches");
  assert.equal(await page.locator("#detail[open] .turn-status").count(), 1, "completed historical turns should not repeat a status pill on every row");
  const firstHistoryText = await page.locator("[data-older-turn]").first().innerText();
  const firstHistoryTail = await page.locator("[data-older-turn]").last().boundingBox();
  const firstHistoryLoad = await page.locator("[data-expand-history]").boundingBox();
  assert.ok(firstHistoryTail && firstHistoryLoad && firstHistoryLoad.y >= firstHistoryTail.y + firstHistoryTail.height - 1, "the next history action must appear after the loaded turns");
  await page.screenshot({ path: path.join(outputDir, "09-history-page-1.png"), fullPage: false });
  const scrollBefore = await page.locator("#detail-content").evaluate((element) => {
    element.scrollTop = Math.max(1, element.scrollHeight - element.clientHeight - 80);
    return element.scrollTop;
  });
  runtime.store.ingest(event("thread-history", 72, "tool_end"));
  await page.waitForTimeout(650);
  const scrollAfter = await page.locator("#detail-content").evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(scrollAfter - scrollBefore) <= 8, `background refresh moved the detail scroll position from ${scrollBefore} to ${scrollAfter}`);
  assert.equal(await page.locator("[data-refresh-detail]").isVisible(), true);
  await page.screenshot({ path: path.join(outputDir, "10-scroll-preserved.png"), fullPage: false });
  const secondHistoryButton = page.locator("[data-expand-history]");
  await secondHistoryButton.scrollIntoViewIfNeeded();
  const scrollBeforeAppend = await page.locator("#detail-content").evaluate((element) => element.scrollTop);
  await secondHistoryButton.click();
  const secondHistoryBatch = await page.locator("[data-older-turn]").count();
  const scrollAfterAppend = await page.locator("#detail-content").evaluate((element) => element.scrollTop);
  assert.ok(secondHistoryBatch > firstHistoryBatch && secondHistoryBatch <= firstHistoryBatch + 8, "each history action must append at most 8 turns");
  assert.equal(await page.locator("[data-older-turn]").first().innerText(), firstHistoryText, "appending older history must retain the previously loaded turns");
  assert.ok(Math.abs(scrollAfterAppend - scrollBeforeAppend) <= 8, `appending history moved the reading position from ${scrollBeforeAppend} to ${scrollAfterAppend}`);
  assert.equal(await page.locator('[data-expand-history][data-needs-full-history="true"]').count(), 1, "the same bottom action must take over when the bounded server history is exhausted");
  await page.screenshot({ path: path.join(outputDir, "11-history-page-2.png"), fullPage: false });
  const beforeFullHistory = secondHistoryBatch;
  await page.locator('[data-expand-history][data-needs-full-history="true"]').click();
  await waitUntil(async () => await page.locator("[data-older-turn]").count() > beforeFullHistory);
  const afterFullHistory = await page.locator("[data-older-turn]").count();
  assert.ok(afterFullHistory <= beforeFullHistory + 8, "fetching full history must still append only one bounded batch");
  assert.equal(await page.locator("[data-older-turn]").first().innerText(), firstHistoryText, "the full-history fetch must not replace already rendered turns");
  assert.equal(await page.locator('[data-expand-history][data-needs-full-history="false"]').count(), 1, "the bottom action must continue with the newly available local turns");
  await page.locator('[data-expand-history][data-needs-full-history="false"]').click();
  await page.locator(".history-end").waitFor();
  assert.equal(await page.locator("[data-older-turn]").count(), 31, "all older turns should remain rendered after the final append");
  await page.locator("[data-collapse-history]").click();
  assert.equal(await page.locator("[data-older-turn]").count(), 0);
  await waitUntil(async () => await page.locator("#detail-content").evaluate((element) => element.scrollTop <= 2));

  await page.locator("#detail-close").click();
  await page.locator("#status-button").click();
  await page.locator("#status-content .status-block").first().waitFor();
  assert.equal(await page.locator(".status-diagnostics[open]").count(), 0, "diagnostic details should not dominate the daily status view");
  await page.screenshot({ path: path.join(outputDir, "12-status.png"), fullPage: false });
  await page.locator("#status-close").click();
  await page.locator("#target-clear").click();
  assert.equal(await page.locator("#target-tracker").isHidden(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem("phone-control-target-session-v1")), null);

  runtime.store.ingest(event("thread-active", 79, "turn_start", { turnId: "turn-thread-active-3" }));
  bridge.set("thread-active", { status: "active", activeFlags: [], activeTurnId: "turn-thread-active-3" });
  await page.locator('[data-filter="recent"]').click();
  await page.locator('[data-session-id="thread-active"]').click();
  const interruptButton = page.locator('[data-interrupt-session="thread-active"]');
  await interruptButton.waitFor();
  assert.match(await interruptButton.innerText(), /停止/);
  page.once("dialog", (dialog) => dialog.accept());
  await interruptButton.click();
  await waitUntil(() => bridge.interruptions.length === 1);
  assert.equal(bridge.interruptions[0].turnId, "turn-thread-active-3", "the stop action must bind the exact visible turn");
  await page.locator(".control-note").filter({ hasText: "正在停止" }).waitFor();
  assert.equal(await page.locator('[data-interrupt-session="thread-active"]').count(), 0, "a delivered stop must not remain tappable");
  runtime.store.ingest(event("thread-active", 80, "aborted", { turnId: "turn-thread-active-3" }));
  bridge.set("thread-active", { status: "idle", activeFlags: [], activeTurnId: null });
  await page.locator("#detail-close").click();
  await page.setViewportSize({ width: 412, height: 915 });
  await page.locator("#devices-button").click();
  await page.locator("#device-list .device-section .device-row").waitFor();
  assert.equal(await page.locator("#pairing-link").isHidden(), true, "an empty pairing-link field must stay hidden until the user generates a link");
  assert.equal(await page.locator("#device-list .device-section .device-row").count(), 1, "the device page should show active devices first");
  assert.equal(await page.locator("#device-list .device-archive").count(), 1);
  assert.match(await page.locator("#device-list .device-archive summary").innerText(), /20/);
  assert.equal(await page.locator("#device-list .device-archive .device-row").first().isVisible(), false, "revoked rows must remain collapsed by default");
  await page.screenshot({ path: path.join(outputDir, "13-devices.png"), fullPage: false });
  await page.locator("#device-list .device-archive summary").click();
  assert.equal(await page.locator("#device-list .device-archive .device-row").count(), 20);
  assert.equal(await page.locator("#device-list .device-archive .device-row").first().isVisible(), true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-purge-revoked]").click();
  await page.locator("#device-list .device-archive").waitFor({ state: "detached" });
  assert.equal(runtime.devices.counts().revoked, 0);
  await page.locator("#devices-close").click();
  const unexpectedErrors = errors.filter((message) => {
    if (message.includes("Refused to apply inline style") && message.includes("page:25")) return false;
    if (message.includes("/api/push/unsubscribe") && message.includes("net::ERR_FAILED")) return false;
    if (message.includes("net::ERR_INTERNET_DISCONNECTED")) return false;
    return true;
  });
  assert.deepEqual(unexpectedErrors, []);
  process.stdout.write(`${JSON.stringify({
    outputDir,
    screenshots: 16,
    errors: unexpectedErrors,
    captureCspWarnings: errors.filter((message) => message.includes("Refused to apply inline style") && message.includes("page:25")).length,
    simulatedOfflineErrors: errors.filter((message) => message.includes("/api/push/unsubscribe") && message.includes("net::ERR_FAILED")).length,
    draftPreserved: true,
    reconnectPreserved: true,
    detailPreviewMs,
    manualReconnect: true,
    reconnectDetailDomPreserved: true,
    notificationToggleImmediate: true,
    noPollingWhileStreamHealthy: true,
    backgroundResumeWithFalseNetworkHint: true,
    offlineRecovery: true,
    imagePreview: true,
    completionExactlyOnceAcrossChannels: true,
    reminderDisabledOfflineAndRetried: true,
    historyTurnPageSize: 8,
    lazyFullHistory: true,
    historyAppendsAtBottom: true,
    historyLoadControlUnified: true,
    historyReturnLatest: true,
    scrollPreserved: true,
    targetTrackerManual: true,
    targetTrackerCompleted: true,
    targetTrackerPersisted: true,
    targetTrackerCleared: true,
    exactTurnInterrupt: true,
    interruptSessionPreserved: true,
    newSessionFromPhone: true,
    permanentSessionDeleteConfirmed: true,
    dynamicViewportDetail: true,
    focusedComposerSurvivesLateDetail: true,
    composerTracksOverlayKeyboard: true,
    composerSubmitAboveOverlayKeyboard: true,
    stickyNewSessionAction: true,
    isolatedRuntimeDialog: true,
    boundedRevokedDevices: true,
    semanticTaskCards: true,
    fullTaskSearch: true,
    exactSearchResultJump: true,
    assistantReplyCopy: true,
    richAssistantMarkdown: true,
    liveExpansionPreserved: true,
    horizontallyScrollableTables: true,
    transcriptHtmlEscaped: true,
  })}\n`);
} finally {
  await browser?.close();
  await runtime.close();
  await rm(dataDir, { recursive: true, force: true });
}
