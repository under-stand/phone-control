#!/usr/bin/env node
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright";
import { BrowserExtensionBroker } from "../src/browser-extension-broker.mjs";
import { createPhoneControlServer } from "../src/server.mjs";

const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const FRAME_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5QAAAABJRU5ErkJggg==";

async function installedBrowser() {
  const candidates = [
    process.env.PHONE_CONTROL_BROWSER,
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : null,
    process.platform === "win32" ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : null,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep checking platform defaults before falling back to Playwright's browser.
    }
  }
  return null;
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-browser-mobile-"));
// Browser startup on a hosted Windows runner can take longer than the local
// five-second smoke-test window. Keep the command alive long enough for the
// page to finish loading before the simulated extension responds.
const broker = new BrowserExtensionBroker({ commandTimeoutMs: 30_000 });
broker.connect({ clientId: "chrome-visual", origin: EXTENSION_ORIGIN });
const runtime = await createPhoneControlServer({
  config: { host: "127.0.0.1", port: 0, token: "visual-token", dataDir },
  scanRollouts: false,
  browserExtensionBroker: broker,
});
let chrome = null;

try {
  const started = await runtime.start();
  const responding = (async () => {
    for (let index = 0; index < 4; index += 1) {
      let delivery = await broker.poll("chrome-visual", EXTENSION_ORIGIN, 20_000);
      // A slow browser launch may let the first long poll expire before the
      // page's module script reaches its initial listTabs action. Retry once
      // instead of treating that startup race as a product regression.
      if (!delivery.command) delivery = await broker.poll("chrome-visual", EXTENSION_ORIGIN, 20_000);
      assert.ok(delivery.command, "the mobile browser page did not request its expected command");
      const tabs = [{
        id: "7",
        windowId: "1",
        title: "Example",
        url: "https://example.com/",
        active: true,
        supported: true,
      }];
      const streaming = delivery.command.action.type === "startStream";
      const frame = ["screenshot", "startStream", "stopStream"].includes(delivery.command.action.type) ? {
        frameId: "visual-frame",
        pageGeneration: 1,
        tabId: "7",
        url: "https://example.com/",
        title: "Example",
        width: 800,
        height: 600,
        dataUrl: FRAME_IMAGE,
      } : null;
      broker.complete("chrome-visual", EXTENSION_ORIGIN, {
        commandId: delivery.command.id,
        ok: true,
        result: { ok: true },
        snapshot: { tabs, activeTabId: "7", frame, streaming },
      });
    }
  })();

  const executablePath = await installedBrowser();
  chrome = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await chrome.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${started.localUrl}/?token=visual-token`);
  assert.equal(await page.locator('a[href="/browser.html"]').textContent(), "浏览器");
  await page.goto(`${started.localUrl}/browser.html`);
  await page.locator("#browser-console:not([hidden])").waitFor();
  await page.locator("#browser-frame-image:not([hidden])").waitFor();
  assert.equal(await page.locator("#frame-title").textContent(), "Example");
  assert.equal(await page.locator("#browser-tabs").inputValue(), "7");
  assert.equal(
    await page.locator("#browser-address-form button").evaluate((element) => getComputedStyle(element).backgroundColor),
    "rgb(104, 87, 245)",
  );
  const addressLayout = await page.locator("#browser-address-form").evaluate((element) => ({
    formWidth: element.getBoundingClientRect().width,
    inputWidth: element.querySelector("input")?.getBoundingClientRect().width || 0,
    buttonWidth: element.querySelector("button")?.getBoundingClientRect().width || 0,
  }));
  assert.ok(addressLayout.formWidth > 0 && addressLayout.inputWidth > 0 && addressLayout.buttonWidth >= 58);
  await page.locator("#toggle-browser-stream").click();
  await page.waitForFunction(() => document.querySelector("#toggle-browser-stream")?.textContent === "停止实时");
  broker.updateSnapshot("chrome-visual", EXTENSION_ORIGIN, {
    tabs: [{ id: "7", windowId: "1", title: "Example", url: "https://example.com/", active: true, supported: true }],
    activeTabId: "7",
    streaming: true,
    frame: {
      frameId: "stream-live",
      pageGeneration: 1,
      tabId: "7",
      url: "https://example.com/",
      title: "Example",
      width: 800,
      height: 600,
      dataUrl: FRAME_IMAGE,
    },
  });
  await page.waitForFunction(() => document.querySelector("#browser-frame-image")?.src.startsWith("data:image/"));
  await page.locator("#toggle-browser-stream").click();
  await page.waitForFunction(() => document.querySelector("#toggle-browser-stream")?.textContent === "实时画面");
  assert.equal(await page.locator("#expand-browser").textContent(), "横向全屏");
  await page.locator("#expand-browser").click();
  await page.locator("body.browser-fullscreen").waitFor();
  assert.equal(await page.locator("#expand-browser").textContent(), "退出全屏");
  await page.locator("#expand-browser").click();
  await page.locator("body:not(.browser-fullscreen)").waitFor();
  await responding;
  process.stdout.write("Browser mobile regression passed.\n");
} finally {
  await chrome?.close();
  await runtime.close();
  await rm(dataDir, { recursive: true, force: true });
}
