const DEFAULT_SERVICE_URL = "http://127.0.0.1:8787";
const EXTENSION_HEADER = { "x-phone-control-browser-extension": "1" };
const attachedTabs = new Set();
const pageGenerations = new Map();
let running = false;
let selectedTabId = null;
let lastFrame = null;
let connection = { connected: false, error: null, lastSeenAt: null };

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function settings() {
  const stored = await chrome.storage.local.get(["clientId", "serviceUrl", "selectedTabId"]);
  if (!stored.clientId) {
    stored.clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId: stored.clientId });
  }
  selectedTabId = Number.isInteger(stored.selectedTabId) ? stored.selectedTabId : selectedTabId;
  return {
    clientId: stored.clientId,
    serviceUrl: String(stored.serviceUrl || DEFAULT_SERVICE_URL).replace(/\/$/, ""),
  };
}

async function request(pathname, { method = "GET", body = null, timeoutMs = 25_000 } = {}) {
  const config = await settings();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.serviceUrl}${pathname}`, {
      method,
      headers: {
        ...EXTENSION_HEADER,
        ...(body == null ? {} : { "content-type": "application/json" }),
      },
      body: body == null ? null : JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Phone Control returned ${response.status}`);
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
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  } catch (error) {
    throw new Error(`无法接管这个标签页：${error.message || error}`);
  }
}

async function command(tabId, method, params = {}) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function capture(tab = null) {
  const target = tab || await chooseTab();
  if (!supportedTab(target)) throw new Error("Chrome 内部页面不能被远程控制，请选择普通网页");
  const metrics = await command(target.id, "Page.getLayoutMetrics");
  const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
  const shot = await command(target.id, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 65,
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
  if (action.type !== "screenshot") await delay(300);
  tab = await chrome.tabs.get(selectedTabId || tab.id);
  const frame = await capture(tab);
  return { result: { ok: true, frameId: frame.frameId }, snapshot: await snapshot() };
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
    if (tabId === selectedTabId) lastFrame = null;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  pageGenerations.delete(tabId);
  if (tabId === selectedTabId) {
    selectedTabId = null;
    lastFrame = null;
  }
});

chrome.debugger.onDetach.addListener((source) => attachedTabs.delete(source.tabId));

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
  return false;
});

void runLoop();
