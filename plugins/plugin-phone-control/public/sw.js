const CACHE = "phone-control-v66";
const ASSETS = [
  "/",
  "/browser.html",
  "/styles.css?v=66",
  "/app.js?v=66",
  "/browser.css?v=66",
  "/browser.js?v=66",
  "/lib/format.js?v=66",
  "/lib/conversation.js?v=66",
  "/lib/browser-frame-controls.js?v=66",
  "/icon.svg",
  "/manifest.webmanifest",
  "/icons/image.svg",
  "/icons/sliders-horizontal.svg",
  "/icons/paper-plane-tilt.svg",
  "/icons/caret-down.svg",
  "/icons/check.svg",
  "/icons/folder-simple.svg",
  "/icons/x.svg",
  "/icons/crosshair-simple.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetch(event.request, { signal: controller.signal });
        const safeShell = ["/", "/browser.html"].includes(url.pathname) && !url.searchParams.has("token");
        if (response.ok && safeShell) {
          const cache = await caches.open(CACHE);
          await cache.put(url.pathname, response.clone());
        }
        return response;
      } catch (error) {
        const safeShell = ["/", "/browser.html"].includes(url.pathname) && !url.searchParams.has("token");
        const cached = safeShell ? await caches.match(url.pathname) : null;
        if (cached) return cached;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })());
    return;
  }

  const updated = fetch(event.request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(event.request, response.clone());
    }
    return response;
  });
  event.waitUntil(updated.catch(() => {}));
  event.respondWith(caches.match(event.request).then((cached) => cached || updated));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = {}; }
  const title = payload.title || "Codex 状态有更新";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = windows.filter((client) => client.visibilityState === "visible");
    if (visible.length) {
      for (const client of visible) client.postMessage({ type: "phone-control-completion", payload });
      return;
    }
    await self.registration.showNotification(title, {
      body: payload.body || "打开 Phone Control 查看最新状态。",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: payload.tag || "phone-control",
      renotify: false,
      data: { url: payload.url || "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.navigate(target);
      await client.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
