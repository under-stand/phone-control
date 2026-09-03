import { mapPointerToViewport } from "./lib/browser-frame-controls.js?v=80";

const elements = {
  connection: document.querySelector("#browser-connection"),
  empty: document.querySelector("#extension-empty"),
  console: document.querySelector("#browser-console"),
  shell: document.querySelector(".browser-shell"),
  retry: document.querySelector("#retry-extension"),
  tabs: document.querySelector("#browser-tabs"),
  newTab: document.querySelector("#new-browser-tab"),
  closeTab: document.querySelector("#close-browser-tab"),
  back: document.querySelector("#browser-back"),
  forward: document.querySelector("#browser-forward"),
  reload: document.querySelector("#browser-reload"),
  addressForm: document.querySelector("#browser-address-form"),
  address: document.querySelector("#browser-address"),
  capture: document.querySelector("#capture-browser"),
  stream: document.querySelector("#toggle-browser-stream"),
  expand: document.querySelector("#expand-browser"),
  frame: document.querySelector("#browser-frame"),
  image: document.querySelector("#browser-frame-image"),
  placeholder: document.querySelector("#frame-placeholder"),
  busy: document.querySelector("#frame-busy"),
  title: document.querySelector("#frame-title"),
  url: document.querySelector("#frame-url"),
  scrollUp: document.querySelector("#scroll-up"),
  scrollDown: document.querySelector("#scroll-down"),
  text: document.querySelector("#browser-text"),
  sendText: document.querySelector("#browser-send-text"),
  enter: document.querySelector("#browser-enter"),
  error: document.querySelector("#browser-error"),
};

let browser = null;
let leaseToken = null;
let pointerStart = null;
let errorTimer = null;
let frameLoadTimer = null;
let busyTimer = null;
let refreshing = false;
let busy = false;
let initialSyncInFlight = false;
let frameStatusText = "正在取得网页画面";
let browserFullscreen = false;
let refreshTimer = null;
let browserStream = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.method && options.method !== "GET" ? { "x-phone-control-client": "1" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.href = "/";
    throw new Error("请先连接 Phone Control");
  }
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = payload.code || null;
    throw error;
  }
  return payload;
}

function showError(error) {
  clearTimeout(errorTimer);
  elements.error.textContent = error?.message || String(error);
  elements.error.hidden = false;
  errorTimer = setTimeout(() => { elements.error.hidden = true; }, 5_000);
}

function setBusy(value) {
  busy = Boolean(value);
  clearTimeout(busyTimer);
  elements.busy.hidden = true;
  if (busy) {
    busyTimer = setTimeout(() => {
      if (busy) elements.busy.hidden = false;
    }, 180);
  }
  for (const control of elements.console.querySelectorAll("button, select")) control.disabled = busy;
}

function setBrowserFullscreen(value) {
  browserFullscreen = Boolean(value);
  document.body.classList.toggle("browser-fullscreen", browserFullscreen);
  elements.shell.classList.toggle("is-browser-fullscreen", browserFullscreen);
  elements.expand.textContent = browserFullscreen ? "退出全屏" : "横向全屏";
  elements.expand.setAttribute("aria-label", browserFullscreen ? "退出横向全屏" : "横向全屏查看网页");
}

function closeBrowserStream() {
  browserStream?.close();
  browserStream = null;
}

function syncBrowserStream() {
  const shouldStream = Boolean(browser?.connected && browser?.streaming);
  if (!shouldStream) {
    closeBrowserStream();
    return;
  }
  if (browserStream || !("EventSource" in globalThis)) return;
  try {
    browserStream = new EventSource("/api/browser/stream");
    browserStream.addEventListener("frame", (event) => {
      if (!browser?.streaming) return;
      try {
        const payload = JSON.parse(event.data);
        if (!payload.frame?.frameId || !payload.frame.dataUrl) return;
        browser.frame = payload.frame;
        render();
      } catch {
        // Ignore a malformed frame and keep the stream available for the next
        // event instead of taking down the browser control page.
      }
    });
    browserStream.addEventListener("error", () => {
      // EventSource reconnects automatically. The normal status refresh keeps
      // the button state correct if the extension stops streaming meanwhile.
    });
  } catch {
    browserStream = null;
  }
}

async function toggleBrowserFullscreen() {
  const entering = !browserFullscreen;
  setBrowserFullscreen(entering);
  if (entering) {
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // The CSS fullscreen layout remains available on browsers that do not
      // expose the Fullscreen API (notably some iOS browsers).
    }
    try {
      await globalThis.screen?.orientation?.lock?.("landscape-primary");
    } catch {
      // Orientation locking is optional; the user can still rotate manually.
    }
    return;
  }
  try {
    if (document.fullscreenElement) await document.exitFullscreen?.();
  } catch {
    // CSS fallback is already restored even if the browser rejects the exit.
  }
  try {
    globalThis.screen?.orientation?.unlock?.();
  } catch {
    // Ignore unsupported orientation APIs.
  }
}

function refreshSoon(delay = 550) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (!document.hidden) void refresh();
  }, delay);
}

function setFrameStatus(message) {
  frameStatusText = message;
  const text = elements.placeholder.querySelector("p");
  if (text) text.textContent = message;
}

function activeTab() {
  return browser?.tabs?.find((tab) => String(tab.id) === String(browser.activeTabId)) || null;
}

function render() {
  const connected = Boolean(browser?.connected);
  elements.connection.dataset.state = connected ? "online" : "offline";
  elements.connection.querySelector("b").textContent = connected ? "浏览器在线" : "扩展离线";
  elements.empty.hidden = connected;
  elements.console.hidden = !connected;
  if (!connected) {
    elements.image.hidden = true;
    syncBrowserStream();
    return;
  }

  const selected = String(browser.activeTabId ?? "");
  const streaming = Boolean(browser.streaming);
  elements.stream.textContent = streaming ? "停止实时" : "实时画面";
  elements.stream.dataset.active = streaming ? "true" : "false";
  elements.stream.setAttribute("aria-label", streaming ? "停止实时画面" : "开启实时画面");
  const options = (browser.tabs || []).map((tab) => {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = `${tab.active ? "● " : ""}${tab.title || tab.url || "未命名标签页"}`;
    option.disabled = tab.supported === false;
    option.selected = option.value === selected;
    return option;
  });
  elements.tabs.replaceChildren(...options);
  elements.closeTab.disabled = busy || (browser.tabs || []).length <= 1;
  const tab = activeTab();
  const frame = browser.frame;
  elements.title.textContent = frame?.title || tab?.title || "准备画面";
  elements.url.textContent = frame?.url || tab?.url || "选择一个普通网页";
  if (document.activeElement !== elements.address) {
    elements.address.value = tab?.url && /^https?:/.test(tab.url) ? tab.url : "";
  }
  if (frame) updateFrame(frame);
  else {
    elements.image.hidden = true;
    elements.placeholder.hidden = false;
    setFrameStatus(frameStatusText);
  }
  syncBrowserStream();
}

function updateFrame(frame) {
  const current = elements.image.dataset.frameId;
  if (current === frame.frameId && !elements.image.hidden && !frame.dataUrl) return;
  clearTimeout(frameLoadTimer);
  elements.placeholder.hidden = !elements.image.hidden && Boolean(frame.dataUrl);
  setFrameStatus("正在加载网页画面");
  elements.image.onload = () => {
    clearTimeout(frameLoadTimer);
    elements.image.hidden = false;
    elements.placeholder.hidden = true;
    frameStatusText = "正在取得网页画面";
  };
  elements.image.onerror = () => {
    clearTimeout(frameLoadTimer);
    elements.image.hidden = true;
    elements.placeholder.hidden = false;
    setFrameStatus("画面加载较慢，请点“刷新画面”重试");
    showError(new Error("网页画面已过期，请点“刷新画面”重试"));
  };
  elements.image.dataset.frameId = frame.frameId;
  elements.image.src = frame.dataUrl || `/api/browser/frame?frameId=${encodeURIComponent(frame.frameId)}&t=${Date.now()}`;
  frameLoadTimer = setTimeout(() => {
    elements.image.hidden = true;
    elements.placeholder.hidden = false;
    setFrameStatus("画面加载较慢，请点“刷新画面”重试");
  }, 8_000);
}

async function acquireControl() {
  if (leaseToken) return leaseToken;
  const payload = await api("/api/browser/control", { method: "POST" });
  leaseToken = payload.control.token;
  return leaseToken;
}

async function action(details, {
  retryLease = true,
  retryNetwork = true,
  retryFrame = true,
  clientActionId = crypto.randomUUID(),
} = {}) {
  await acquireControl();
  try {
    const payload = await api("/api/browser/actions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-phone-control-browser-lease": leaseToken,
      },
      body: JSON.stringify({ clientActionId, ...details }),
    });
    browser = payload.browser;
    render();
    return payload.result;
  } catch (error) {
    if (retryLease && error.status === 409 && error.code === "lease_required") {
      leaseToken = null;
      return action(details, { retryLease: false, retryNetwork, retryFrame, clientActionId });
    }
    if (retryFrame && error.status === 409 && error.code === "stale_frame" && details.frameId) {
      // A background capture can replace the frame between a phone tap and
      // the server's validation. Refresh metadata and retry the same command
      // once with the current frame identity; the first attempt was rejected
      // before it reached Chrome, so this cannot duplicate the action.
      try {
        browser = await api("/api/browser");
        render();
        const frame = browser?.frame;
        if (frame) {
          return action(
            { ...details, frameId: frame.frameId, pageGeneration: frame.pageGeneration },
            { retryLease, retryNetwork, retryFrame: false, clientActionId },
          );
        }
      } catch {
        // Fall through to the original stale-frame error when no fresh frame
        // is available yet.
      }
    }
    if (retryNetwork && !error.status) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return action(details, { retryLease, retryNetwork: false, retryFrame, clientActionId });
    }
    throw error;
  }
}

async function perform(details) {
  setBusy(true);
  try {
    return await action(details);
  } catch (error) {
    showError(error);
    throw error;
  } finally {
    setBusy(false);
    render();
    if (details.type !== "screenshot") refreshSoon();
  }
}

async function refresh({ initialize = false } = {}) {
  if (refreshing || busy) return;
  refreshing = true;
  try {
    browser = await api("/api/browser");
    render();
    if (initialize && browser.connected && !browser.frame) startInitialSync();
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
  }
}

function withDeadline(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("扩展响应较慢"), { code: "initial_sync_timeout" })), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startInitialSync() {
  if (initialSyncInFlight || !browser?.connected || browser.frame) return;
  initialSyncInFlight = true;
  setFrameStatus("正在取得网页画面");
  void (async () => {
    try {
      // Keep the first paint independent from the extension round trip. The
      // status endpoint already contains the latest pushed tab list, while a
      // slow command must not leave the phone page blocked on a spinner.
      try {
        await withDeadline(action({ type: "listTabs" }), 4_000);
      } catch (error) {
        if (error?.code !== "initial_sync_timeout") throw error;
      }
      if (browser?.connected && !browser.frame) {
        try {
          await withDeadline(action({ type: "screenshot" }), 8_000);
        } catch (error) {
          if (error?.code !== "initial_sync_timeout") throw error;
        }
      }
    } catch (error) {
      showError(error);
    } finally {
      initialSyncInFlight = false;
      if (!browser?.frame) setFrameStatus("扩展响应较慢，正在等待最新画面…");
      render();
    }
  })();
}

async function performFrameAction(details) {
  const frame = browser?.frame;
  if (!frame) throw new Error("请先刷新网页画面");
  return perform({ frameId: frame.frameId, pageGeneration: frame.pageGeneration, ...details });
}

function releaseControl() {
  if (!leaseToken) return;
  const token = leaseToken;
  leaseToken = null;
  void fetch("/api/browser/control", {
    method: "DELETE",
    credentials: "same-origin",
    keepalive: true,
    headers: {
      "x-phone-control-client": "1",
      "x-phone-control-browser-lease": token,
    },
  }).catch(() => {});
}

elements.retry.addEventListener("click", () => refresh({ initialize: true }));
elements.connection.addEventListener("click", () => refresh({ initialize: true }));
elements.tabs.addEventListener("change", () => perform({ type: "selectTab", tabId: elements.tabs.value }).catch(() => {}));
elements.newTab.addEventListener("click", () => perform({ type: "newTab" }).catch(() => {}));
elements.closeTab.addEventListener("click", () => {
  if (!browser?.activeTabId || (browser.tabs || []).length <= 1) return;
  perform({ type: "closeTab", tabId: String(browser.activeTabId) }).catch(() => {});
});
elements.back.addEventListener("click", () => perform({ type: "back" }).catch(() => {}));
elements.forward.addEventListener("click", () => perform({ type: "forward" }).catch(() => {}));
elements.reload.addEventListener("click", () => perform({ type: "reload" }).catch(() => {}));
elements.capture.addEventListener("click", () => perform({ type: "screenshot" }).catch(() => {}));
elements.stream.addEventListener("click", () => {
  perform({ type: browser?.streaming ? "stopStream" : "startStream" }).catch(() => {});
});
elements.expand.addEventListener("click", () => toggleBrowserFullscreen().catch(() => {}));
elements.scrollUp.addEventListener("click", () => performFrameAction({ type: "scroll", deltaY: -560 }).catch(showError));
elements.scrollDown.addEventListener("click", () => performFrameAction({ type: "scroll", deltaY: 560 }).catch(showError));

elements.addressForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const raw = elements.address.value.trim();
  if (!raw) return;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  perform({ type: "navigate", url }).catch(() => {});
});

elements.sendText.addEventListener("click", () => {
  const text = elements.text.value;
  if (!text) return;
  performFrameAction({ type: "insertText", text }).then(() => { elements.text.value = ""; }).catch(showError);
});
elements.enter.addEventListener("click", () => performFrameAction({ type: "key", key: "Enter" }).catch(showError));
elements.text.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    elements.sendText.click();
  }
});

elements.frame.addEventListener("pointerdown", (event) => {
  if (elements.image.hidden || !browser?.frame) return;
  pointerStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  elements.frame.setPointerCapture(event.pointerId);
  event.preventDefault();
});

elements.frame.addEventListener("pointerup", (event) => {
  if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
  const start = pointerStart;
  pointerStart = null;
  const deltaX = event.clientX - start.x;
  const deltaY = event.clientY - start.y;
  if (Math.hypot(deltaX, deltaY) > 18) {
    performFrameAction({ type: "scroll", deltaX: -deltaX * 2.2, deltaY: -deltaY * 2.2 }).catch(showError);
    return;
  }
  const frame = browser?.frame;
  if (!frame) {
    showError(new Error("网页画面已经变化，请刷新后重试"));
    return;
  }
  const point = mapPointerToViewport({
    clientX: event.clientX,
    clientY: event.clientY,
    elementRect: elements.frame.getBoundingClientRect(),
    intrinsicWidth: elements.image.naturalWidth,
    intrinsicHeight: elements.image.naturalHeight,
    viewportWidth: frame.width,
    viewportHeight: frame.height,
  });
  if (point) performFrameAction({ type: "tap", ...point }).catch(showError);
});

elements.frame.addEventListener("pointercancel", () => { pointerStart = null; });
window.addEventListener("pagehide", () => {
  closeBrowserStream();
  releaseControl();
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && browserFullscreen) {
    setBrowserFullscreen(false);
    try {
      globalThis.screen?.orientation?.unlock?.();
    } catch {
      // Ignore unsupported orientation APIs.
    }
  }
});

void refresh({ initialize: true });
setInterval(() => { if (!document.hidden) void refresh(); }, 4_000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
