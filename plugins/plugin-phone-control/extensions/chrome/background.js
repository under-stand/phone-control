import {
  DEFAULT_SERVICE_PORT,
  discoverServiceUrl,
  normalizeServiceUrl,
} from "./service-discovery.js";

const DEFAULT_SERVICE_URL = `http://127.0.0.1:${DEFAULT_SERVICE_PORT}`;
const SERVICE_DISCOVERY_RETRY_MS = 3_000;
const DEBUGGER_COMMAND_TIMEOUT_MS = 8_000;
const COMMAND_LOOP_ALARM = "phone-control-command-loop";
const EXTENSION_HEADER = { "x-phone-control-browser-extension": "1" };
const attachedTabs = new Set();
const pageGenerations = new Map();
const captureTimers = new Map();
let running = false;
let selectedTabId = null;
let lastFrame = null;
let captureQueue = Promise.resolve();
let connection = { connected: false, error: null, lastSeenAt: null };
let activeServiceUrl = null;
let discoveryPromise = null;
let lastDiscoveryAt = 0;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = "debugger_timeout";
      reject(error);
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resolveServiceUrl({ configuredServiceUrl = null, force = false } = {}) {
  const fallback = activeServiceUrl || configuredServiceUrl || DEFAULT_SERVICE_URL;
  const now = Date.now();
  if (!force && activeServiceUrl) return activeServiceUrl;
  if (force && activeServiceUrl && now - lastDiscoveryAt < SERVICE_DISCOVERY_RETRY_MS) return activeServiceUrl;
  if (discoveryPromise) return discoveryPromise;

  lastDiscoveryAt = now;
  discoveryPromise = discoverServiceUrl({ configuredServiceUrl })
    .then(async (discovered) => {
      activeServiceUrl = discovered || fallback;
      if (discovered) await chrome.storage.local.set({ serviceUrl: discovered });
      return activeServiceUrl;
    })
    .finally(() => {
      discoveryPromise = null;
    });
  return discoveryPromise;
}

async function settings({ forceServiceDiscovery = false } = {}) {
  const stored = await chrome.storage.local.get(["clientId", "serviceUrl", "selectedTabId"]);
  if (!stored.clientId) {
    stored.clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId: stored.clientId });
  }
  selectedTabId = Number.isInteger(stored.selectedTabId) ? stored.selectedTabId : selectedTabId;
  const configuredServiceUrl = normalizeServiceUrl(stored.serviceUrl);
  return {
    clientId: stored.clientId,
    serviceUrl: await resolveServiceUrl({ configuredServiceUrl, force: forceServiceDiscovery }),
  };
}

async function request(pathname, { method = "GET", body = null, timeoutMs = 25_000 } = {}) {
  const config = await settings();
  try {
    return await requestAgainstService(config.serviceUrl, pathname, { method, body, timeoutMs });
  } catch (error) {
    if (!["service_endpoint_invalid", "service_unreachable"].includes(error?.code)) throw error;
    const rediscovered = await settings({ forceServiceDiscovery: true });
    if (rediscovered.serviceUrl && rediscovered.serviceUrl !== config.serviceUrl) {
      return requestAgainstService(rediscovered.serviceUrl, pathname, { method, body, timeoutMs });
    }
    throw error;
  }
}

async function requestAgainstService(serviceUrl, pathname, { method = "GET", body = null, timeoutMs = 25_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(`${serviceUrl}${pathname}`, {
        method,
        headers: {
          ...EXTENSION_HEADER,
          ...(body == null ? {} : { "content-type": "application/json" }),
        },
        body: body == null ? null : JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.code = "service_unreachable";
      throw failure;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Phone Control returned ${response.status}`);
      if (response.status === 404) error.code = "service_endpoint_invalid";
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function tabUrl(tab) {
  return typeof tab?.url === "string" && tab.url ? tab.url : String(tab?.pendingUrl || "");
}

function supportedTab(tab) {
  const url = tabUrl(tab);
  return /^https?:/i.test(url) || url === "about:blank";
}

function publicTab(tab) {
  const url = tabUrl(tab) || "about:blank";
  return {
    id: String(tab.id),
    windowId: String(tab.windowId),
    title: tab.title || url || "未命名标签页",
    url,
    active: Boolean(tab.active),
    audible: Boolean(tab.audible),
    supported: supportedTab(tab),
  };
}

async function allTabs() {
  return (await chrome.tabs.query({})).filter((tab) => Number.isInteger(tab.id));
}

async function chooseTab() {
  const tabs = await allTabs();
  let tab = tabs.find((candidate) => candidate.id === selectedTabId && supportedTab(candidate));
  if (!tab) tab = tabs.find((candidate) => candidate.active && supportedTab(candidate));
  if (!tab) tab = tabs.find(supportedTab);
  if (!tab) throw new Error("没有可控制的普通网页标签页");
  selectedTabId = tab.id;
  await chrome.storage.local.set({ selectedTabId });
  return tab;
}

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await withTimeout(chrome.debugger.attach({ tabId }, "1.3"), DEBUGGER_COMMAND_TIMEOUT_MS, "Chrome 调试器连接超时");
    attachedTabs.add(tabId);
    await withTimeout(chrome.debugger.sendCommand({ tabId }, "Page.enable"), DEBUGGER_COMMAND_TIMEOUT_MS, "Chrome 页面通道连接超时");
  } catch (error) {
    attachedTabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw new Error(`无法接管这个标签页：${error.message || error}`);
  }
}

async function command(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await withTimeout(
      chrome.debugger.sendCommand({ tabId }, method, params),
      DEBUGGER_COMMAND_TIMEOUT_MS,
      "Chrome 页面响应超时",
    );
  } catch (error) {
    if (error?.code === "debugger_timeout") {
      attachedTabs.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    throw error;
  }
}

async function capture(tab = null) {
  const target = tab || await chooseTab();
  if (!supportedTab(target)) throw new Error("Chrome 内部页面不能被远程控制，请选择普通网页");
  const metrics = await command(target.id, "Page.getLayoutMetrics");
  const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
  const shot = await command(target.id, "Page.captureScreenshot", {
    format: "jpeg",
    // The remote page is primarily text. A slightly smaller JPEG keeps the
    // frame refresh responsive over a phone/Tailscale connection while still
    // leaving controls readable.
    quality: 55,
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  });
  const generation = pageGenerations.get(target.id) || 0;
  lastFrame = {
    frameId: crypto.randomUUID(),
    pageGeneration: generation,
    tabId: String(target.id),
    url: tabUrl(target) || "about:blank",
    title: target.title || tabUrl(target) || "未命名标签页",
    width: Math.max(1, Number(viewport.clientWidth || target.width || 1)),
    height: Math.max(1, Number(viewport.clientHeight || target.height || 1)),
    dataUrl: `data:image/jpeg;base64,${shot.data}`,
    capturedAt: new Date().toISOString(),
  };
  return lastFrame;
}

async function snapshot({ includeFrame = true } = {}) {
  const tabs = await allTabs();
  return {
    tabs: tabs.map(publicTab),
    activeTabId: selectedTabId == null ? null : String(selectedTabId),
    frame: includeFrame ? lastFrame : null,
  };
}

async function publishSnapshot({ includeFrame = true } = {}) {
  const config = await settings();
  await request("/api/internal/browser/snapshot", {
    method: "POST",
    body: { clientId: config.clientId, snapshot: await snapshot({ includeFrame }) },
    timeoutMs: 10_000,
  });
}

function enqueueCapture(tabId, { includeFrame = true } = {}) {
  const task = captureQueue.then(async () => {
    if (tabId !== selectedTabId) return null;
    const tab = await chrome.tabs.get(tabId);
    if (!supportedTab(tab)) return null;
    if (includeFrame) await capture(tab);
    await publishSnapshot({ includeFrame });
    return includeFrame ? lastFrame : null;
  });
  // Keep later captures moving even when a tab closes or a debugger command
  // times out. Callers that need the result still receive the original task.
  captureQueue = task.catch(() => {});
  return task;
}

function scheduleCapture(tabId, { includeFrame = true } = {}) {
  const previous = captureTimers.get(tabId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(async () => {
    captureTimers.delete(tabId);
    void enqueueCapture(tabId, { includeFrame }).catch(() => {
      // The tab may have closed or navigated to a protected Chrome page.
      // The regular heartbeat will report the next healthy snapshot.
    });
  }, 350);
  captureTimers.set(tabId, timer);
}

async function activateTab(tabId) {
  const numericId = Number(tabId);
  const tab = await chrome.tabs.get(numericId);
  if (!supportedTab(tab)) throw new Error("Chrome 内部页面不能被远程控制，请选择普通网页");
  await chrome.tabs.update(numericId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  selectedTabId = numericId;
  lastFrame = null;
  await chrome.storage.local.set({ selectedTabId });
  return chrome.tabs.get(numericId);
}

async function keyEvent(tabId, key) {
  const aliases = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  };
  const definition = aliases[key];
  if (!definition) throw new Error(`不支持的按键：${key}`);
  await command(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...definition });
  await command(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...definition });
}

async function execute(action) {
  let tab = null;
  if (!["listTabs", "selectTab", "newTab", "closeTab"].includes(action.type)) tab = await chooseTab();
  switch (action.type) {
    case "listTabs":
      return { result: { ok: true }, snapshot: await snapshot({ includeFrame: false }) };
    case "selectTab":
      tab = await activateTab(action.tabId);
      break;
    case "newTab":
      tab = await chrome.tabs.create({ url: "about:blank", active: true });
      selectedTabId = tab.id;
      await chrome.storage.local.set({ selectedTabId });
      break;
    case "closeTab": {
      const tabs = await allTabs();
      if (tabs.length <= 1) throw new Error("至少需要保留一个 Chrome 标签页");
      const closing = Number(action.tabId);
      if (attachedTabs.has(closing)) await chrome.debugger.detach({ tabId: closing }).catch(() => {});
      await chrome.tabs.remove(closing);
      attachedTabs.delete(closing);
      if (selectedTabId === closing) selectedTabId = null;
      tab = await chooseTab().catch(() => chrome.tabs.create({ url: "about:blank", active: true }));
      selectedTabId = tab.id;
      await chrome.storage.local.set({ selectedTabId });
      break;
    }
    case "navigate":
      tab = await chrome.tabs.update(tab.id, { url: action.url, active: true });
      break;
    case "back":
      await chrome.tabs.goBack(tab.id);
      break;
    case "forward":
      await chrome.tabs.goForward(tab.id);
      break;
    case "reload":
      await chrome.tabs.reload(tab.id);
      break;
    case "screenshot":
      break;
    case "tap":
      await command(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: action.x, y: action.y });
      await command(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: action.x, y: action.y, button: "left", clickCount: 1 });
      await command(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: action.x, y: action.y, button: "left", clickCount: 1 });
      break;
    case "scroll":
      await command(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: lastFrame?.width ? lastFrame.width / 2 : 1,
        y: lastFrame?.height ? lastFrame.height / 2 : 1,
        deltaX: action.deltaX,
        deltaY: action.deltaY,
      });
      break;
    case "insertText":
      await command(tab.id, "Input.insertText", { text: action.text });
      break;
    case "key":
      await keyEvent(tab.id, action.key);
      break;
    default:
      throw new Error(`不支持的浏览器操作：${action.type}`);
  }
  if (action.type === "screenshot") {
    const frame = await enqueueCapture(tab.id, { includeFrame: true });
    if (!frame) throw new Error("当前标签页已切换，请稍后重试");
    return { result: { ok: true, frameId: frame.frameId }, snapshot: await snapshot() };
  }

  // A command acknowledgement should not wait for a JPEG upload. Keep the
  // current frame for direct interactions so the phone stays usable while a
  // replacement is captured; navigation/tab changes clear it immediately.
  await delay(100);
  tab = await chrome.tabs.get(selectedTabId || tab.id);
  const keepFrame = ["tap", "scroll", "insertText", "key"].includes(action.type) && Boolean(lastFrame);
  if (!keepFrame) lastFrame = null;
  scheduleCapture(tab.id);
  return {
    result: { ok: true, frameId: keepFrame ? lastFrame.frameId : null },
    snapshot: await snapshot({ includeFrame: keepFrame }),
  };
}

async function hello() {
  const config = await settings();
  await request("/api/internal/browser/hello", {
    method: "POST",
    body: {
      clientId: config.clientId,
      name: "Google Chrome",
      version: chrome.runtime.getManifest().version,
    },
    timeoutMs: 5_000,
  });
  connection = { connected: true, error: null, lastSeenAt: new Date().toISOString() };
  await chrome.storage.local.set({ connection });
  // A fresh service worker may not have a persisted selected tab yet. Pick a
  // usable tab immediately so the phone gets a frame without waiting for the
  // first manual browser action.
  const tab = await chooseTab().catch(() => null);
  if (tab) scheduleCapture(tab.id);
}

async function postResult(clientId, commandId, outcome) {
  await request("/api/internal/browser/results", {
    method: "POST",
    body: { clientId, commandId, ...outcome },
    timeoutMs: 10_000,
  });
}

async function runLoop() {
  if (running) return;
  running = true;
  while (running) {
    try {
      const config = await settings();
      if (!connection.connected) await hello();
      const delivery = await request(`/api/internal/browser/commands?clientId=${encodeURIComponent(config.clientId)}&wait=20000`, {
        timeoutMs: 24_000,
      });
      connection = { connected: true, error: null, lastSeenAt: new Date().toISOString() };
      await chrome.storage.local.set({ connection });
      if (!delivery.command) continue;
      try {
        const outcome = await execute(delivery.command.action);
        await postResult(config.clientId, delivery.command.id, { ok: true, ...outcome });
      } catch (error) {
        await postResult(config.clientId, delivery.command.id, {
          ok: false,
          error: error?.message || String(error),
          snapshot: await snapshot().catch(() => null),
        });
      }
    } catch (error) {
      connection = { connected: false, error: error?.message || String(error), lastSeenAt: new Date().toISOString() };
      await chrome.storage.local.set({ connection });
      await delay(1_500);
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    pageGenerations.set(tabId, (pageGenerations.get(tabId) || 0) + 1);
    if (tabId === selectedTabId) {
      lastFrame = null;
      void publishSnapshot({ includeFrame: false }).catch(() => {});
    }
  }
  if (changeInfo.status === "complete" && tabId === selectedTabId) {
    scheduleCapture(tabId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!Number.isInteger(tabId)) return;
  selectedTabId = tabId;
  lastFrame = null;
  void chrome.storage.local.set({ selectedTabId });
  void publishSnapshot({ includeFrame: false }).catch(() => {});
  scheduleCapture(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const timer = captureTimers.get(tabId);
  if (timer) clearTimeout(timer);
  captureTimers.delete(tabId);
  attachedTabs.delete(tabId);
  pageGenerations.delete(tabId);
  if (tabId === selectedTabId) {
    selectedTabId = null;
    lastFrame = null;
    void chooseTab()
      .then((tab) => {
        selectedTabId = tab.id;
        return chrome.storage.local.set({ selectedTabId }).then(() => scheduleCapture(tab.id));
      })
      .catch(() => publishSnapshot({ includeFrame: false }).catch(() => {}));
  }
});

chrome.debugger.onDetach.addListener((source) => {
  attachedTabs.delete(source.tabId);
  if (source.tabId === selectedTabId) {
    lastFrame = null;
    void publishSnapshot({ includeFrame: false }).catch(() => {});
  }
});

chrome.alarms.create(COMMAND_LOOP_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === COMMAND_LOOP_ALARM) void runLoop();
});
chrome.runtime.onStartup.addListener(() => void runLoop());
chrome.runtime.onInstalled.addListener(() => void runLoop());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "status") {
    settings().then(async (config) => sendResponse({
      connection,
      serviceUrl: config.serviceUrl,
      selectedTabId,
      tabs: (await allTabs()).map(publicTab),
    }));
    return true;
  }
  if (message?.type === "reconnect") {
    connection.connected = false;
    hello().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "set-service-url") {
    (async () => {
      const raw = String(message.serviceUrl || "").trim();
      const serviceUrl = raw ? normalizeServiceUrl(raw) : null;
      if (raw && !serviceUrl) throw new Error("请输入 http://127.0.0.1:端口，或留空使用自动发现");
      activeServiceUrl = serviceUrl;
      lastDiscoveryAt = 0;
      if (serviceUrl) await chrome.storage.local.set({ serviceUrl });
      else await chrome.storage.local.remove("serviceUrl");
      connection = { connected: false, error: null, lastSeenAt: null };
      return { ok: true, serviceUrl: serviceUrl || "自动发现" };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

void runLoop();
