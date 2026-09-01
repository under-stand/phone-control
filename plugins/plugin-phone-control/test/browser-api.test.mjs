import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createPhoneControlServer } from "../src/server.mjs";

const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const EXTENSION_HEADERS = {
  origin: EXTENSION_ORIGIN,
  "x-phone-control-browser-extension": "1",
};

function request({ port, pathname, method = "GET", headers = {}, body = null }) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          raw,
          body: response.headers["content-type"]?.includes("application/json") && text ? JSON.parse(text) : text,
        });
      });
    });
    req.once("error", reject);
    req.end(payload);
  });
}

export const tests = [{
  name: "bridges an idempotent authenticated phone action to a loopback Chrome extension",
  async run() {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-browser-api-"));
    const runtime = await createPhoneControlServer({
      config: { host: "127.0.0.1", port: 0, token: "test-token", dataDir },
      scanRollouts: false,
    });
    try {
      const started = await runtime.start();
      const untrusted = await request({
        port: started.port,
        pathname: "/api/internal/browser/hello",
        method: "POST",
        body: { clientId: "chrome-test" },
      });
      assert.equal(untrusted.status, 403);

      const preflight = await request({
        port: started.port,
        pathname: "/api/internal/browser/hello",
        method: "OPTIONS",
        headers: { origin: EXTENSION_ORIGIN },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers["access-control-allow-origin"], EXTENSION_ORIGIN);

      const hello = await request({
        port: started.port,
        pathname: "/api/internal/browser/hello",
        method: "POST",
        headers: EXTENSION_HEADERS,
        body: { clientId: "chrome-test", version: "0.1.0" },
      });
      assert.equal(hello.status, 200);
      assert.equal(hello.body.connected, true);

      const pairing = await request({ port: started.port, pathname: "/?token=test-token" });
      const cookie = pairing.headers["set-cookie"][0].split(";")[0];
      const browserPage = await request({ port: started.port, pathname: "/browser.html", headers: { cookie } });
      assert.equal(browserPage.status, 200);
      assert.match(browserPage.body, /browser\.js\?v=73/);
      assert.equal(browserPage.headers["cache-control"], "no-cache");
        const browserAsset = await request({ port: started.port, pathname: "/browser.js?v=73", headers: { cookie } });
      assert.equal(browserAsset.status, 200);
      assert.match(browserAsset.headers["cache-control"], /immutable/);
      const browser = await request({ port: started.port, pathname: "/api/browser", headers: { cookie } });
      assert.equal(browser.status, 200);
      assert.equal(browser.body.connected, true);

      const control = await request({
        port: started.port,
        pathname: "/api/browser/control",
        method: "POST",
        headers: { cookie, "x-phone-control-client": "1" },
      });
      assert.equal(control.status, 200);
      const lease = control.body.control.token;
      const actionBody = { type: "listTabs", clientActionId: "phone-action-1" };
      const actionPromise = request({
        port: started.port,
        pathname: "/api/browser/actions",
        method: "POST",
        headers: {
          cookie,
          "x-phone-control-client": "1",
          "x-phone-control-browser-lease": lease,
        },
        body: actionBody,
      });
      const delivery = await request({
        port: started.port,
        pathname: "/api/internal/browser/commands?clientId=chrome-test&wait=10",
        headers: EXTENSION_HEADERS,
      });
      assert.equal(delivery.body.command.action.type, "listTabs");
      const completion = await request({
        port: started.port,
        pathname: "/api/internal/browser/results",
        method: "POST",
        headers: EXTENSION_HEADERS,
        body: {
          clientId: "chrome-test",
          commandId: delivery.body.command.id,
          ok: true,
          result: { ok: true },
          snapshot: {
            tabs: [{ id: "7", title: "Example", url: "https://example.com/", supported: true }],
            activeTabId: "7",
            frame: {
              frameId: "frame-7",
              pageGeneration: 1,
              tabId: "7",
              url: "https://example.com/",
              title: "Example",
              width: 800,
              height: 600,
              dataUrl: "data:image/jpeg;base64,AA==",
            },
          },
        },
      });
      assert.equal(completion.status, 202);
      const action = await actionPromise;
      assert.equal(action.status, 200);
      assert.equal(action.body.browser.tabs[0].title, "Example");

      const retry = await request({
        port: started.port,
        pathname: "/api/browser/actions",
        method: "POST",
        headers: {
          cookie,
          "x-phone-control-client": "1",
          "x-phone-control-browser-lease": lease,
        },
        body: actionBody,
      });
      assert.equal(retry.status, 200);
      const noReplay = await request({
        port: started.port,
        pathname: "/api/internal/browser/commands?clientId=chrome-test&wait=1",
        headers: EXTENSION_HEADERS,
      });
      assert.equal(noReplay.body.command, null);

      const conflict = await request({
        port: started.port,
        pathname: "/api/browser/actions",
        method: "POST",
        headers: {
          cookie,
          "x-phone-control-client": "1",
          "x-phone-control-browser-lease": lease,
        },
        body: { type: "reload", clientActionId: "phone-action-1" },
      });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, "action_id_conflict");

      const frame = await request({
        port: started.port,
        pathname: "/api/browser/frame?frameId=frame-7",
        headers: { cookie },
      });
      assert.equal(frame.status, 200);
      assert.equal(frame.headers["content-type"], "image/jpeg");
      assert.equal(frame.raw.length, 1);
      const staleFrame = await request({
        port: started.port,
        pathname: "/api/browser/frame?frameId=frame-old",
        headers: { cookie },
      });
      assert.equal(staleFrame.status, 409);
      assert.equal(staleFrame.body.code, "stale_frame");

      const secondPairing = await request({ port: started.port, pathname: "/?token=test-token" });
      const secondCookie = secondPairing.headers["set-cookie"][0].split(";")[0];
      const blockedControl = await request({
        port: started.port,
        pathname: "/api/browser/control",
        method: "POST",
        headers: { cookie: secondCookie, "x-phone-control-client": "1" },
      });
      assert.equal(blockedControl.status, 409);
      assert.equal(blockedControl.body.code, "lease_conflict");
      const logout = await request({
        port: started.port,
        pathname: "/api/logout",
        method: "POST",
        headers: { cookie, "x-phone-control-client": "1" },
      });
      assert.equal(logout.status, 200);
      assert.equal(runtime.browserReplay.entries.size, 0);
      const secondControl = await request({
        port: started.port,
        pathname: "/api/browser/control",
        method: "POST",
        headers: { cookie: secondCookie, "x-phone-control-client": "1" },
      });
      assert.equal(secondControl.status, 200);
      const devices = await request({ port: started.port, pathname: "/api/devices", headers: { cookie: secondCookie } });
      const revoke = await request({
        port: started.port,
        pathname: `/api/devices/${encodeURIComponent(devices.body.currentDeviceId)}/revoke`,
        method: "POST",
        headers: { cookie: secondCookie, "x-phone-control-client": "1" },
      });
      assert.equal(revoke.status, 200);
      assert.equal(runtime.browserLeases.status().held, false);
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
}];
