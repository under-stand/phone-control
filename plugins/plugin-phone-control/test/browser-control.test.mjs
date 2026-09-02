import assert from "node:assert/strict";
import { validateBrowserAction } from "../src/browser-action.mjs";
import { BrowserControlLeaseStore } from "../src/browser-control-lease.mjs";
import { BrowserExtensionBroker } from "../src/browser-extension-broker.mjs";

const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

export const tests = [
  {
    name: "validates browser actions and rejects unsafe navigation URLs",
    run() {
      assert.deepEqual(validateBrowserAction({
        type: "navigate",
        clientActionId: "a-1",
        url: "https://example.com/path",
      }), {
        type: "navigate",
        clientActionId: "a-1",
        url: "https://example.com/path",
      });
      assert.equal(validateBrowserAction({
        type: "insertText",
        clientActionId: "a-2",
        frameId: "frame-1",
        pageGeneration: 1,
        text: "  保留空格  ",
      }).text, "  保留空格  ");
      assert.deepEqual(validateBrowserAction({ type: "startStream", clientActionId: "a-5" }), {
        type: "startStream",
        clientActionId: "a-5",
      });
      assert.deepEqual(validateBrowserAction({ type: "stopStream", clientActionId: "a-6" }), {
        type: "stopStream",
        clientActionId: "a-6",
      });
      assert.throws(
        () => validateBrowserAction({ type: "navigate", clientActionId: "a-3", url: "file:///etc/passwd" }),
        (error) => error.code === "invalid_action" && error.statusCode === 400,
      );
      assert.throws(
        () => validateBrowserAction({ type: "tap", clientActionId: "a-4", frameId: "frame-1", pageGeneration: 1, x: -1, y: 2 }),
        (error) => error.code === "invalid_action",
      );
    },
  },
  {
    name: "keeps browser control single-writer and renews the owner lease",
    run() {
      let now = 1_000;
      const leases = new BrowserControlLeaseStore({ ttlMs: 100, now: () => now });
      const first = leases.acquire("phone-a");
      assert.equal(first.owner, "self");
      assert.ok(first.token);
      assert.throws(() => leases.acquire("phone-b"), (error) => error.code === "lease_conflict");
      now += 50;
      assert.equal(leases.validate("phone-a", first.token).owner, "self");
      now += 101;
      assert.equal(leases.status("phone-b").held, false);
      assert.equal(leases.acquire("phone-b").owner, "self");
    },
  },
  {
    name: "delivers a browser command through the pinned extension long poll",
    async run() {
      const broker = new BrowserExtensionBroker({ commandTimeoutMs: 1_000 });
      broker.connect({ clientId: "chrome-one", version: "1.0.0", origin: EXTENSION_ORIGIN });
      assert.throws(
        () => broker.connect({ clientId: "chrome-two", origin: `chrome-extension://${"b".repeat(32)}` }),
        (error) => error.code === "extension_identity_mismatch",
      );
      const invoked = broker.invoke({ type: "listTabs", clientActionId: "action-1" });
      const delivery = await broker.poll("chrome-one", EXTENSION_ORIGIN, 10);
      assert.equal(delivery.command.action.type, "listTabs");
      assert.equal(broker.originFor("chrome-one"), EXTENSION_ORIGIN);
      assert.equal(broker.originFor("unknown"), null);
      broker.complete("chrome-one", EXTENSION_ORIGIN, {
        commandId: delivery.command.id,
        ok: true,
        result: { accepted: true },
        snapshot: {
          tabs: [{ id: "9", title: "Example", url: "https://example.com/" }],
          activeTabId: "9",
        },
      });
      assert.deepEqual(await invoked, { accepted: true });
      assert.equal(broker.status().tabs[0].title, "Example");
      broker.close();
    },
  },
  {
    name: "rejects pointer actions based on stale browser screenshots",
    async run() {
      const broker = new BrowserExtensionBroker({ commandTimeoutMs: 1_000 });
      broker.connect({ clientId: "chrome-one", origin: EXTENSION_ORIGIN });
      broker.updateSnapshot("chrome-one", EXTENSION_ORIGIN, {
        frame: {
          frameId: "frame-current",
          pageGeneration: 4,
          tabId: "2",
          url: "https://example.com/",
          width: 1280,
          height: 720,
          dataUrl: "data:image/jpeg;base64,AA==",
        },
      });
      await assert.rejects(
        broker.invoke({
          type: "tap",
          clientActionId: "tap-1",
          frameId: "frame-old",
          pageGeneration: 4,
          x: 20,
          y: 30,
        }),
        (error) => error.code === "stale_frame" && error.statusCode === 409,
      );
      await assert.rejects(
        broker.invoke({
          type: "tap",
          clientActionId: "tap-2",
          frameId: "frame-current",
          pageGeneration: 4,
          x: 1280,
          y: 30,
        }),
        (error) => error.code === "coordinate_out_of_bounds" && error.statusCode === 400,
      );
      broker.close();
    },
  },
  {
    name: "publishes the newest browser frame to realtime subscribers",
    run() {
      const broker = new BrowserExtensionBroker();
      broker.connect({ clientId: "chrome-one", origin: EXTENSION_ORIGIN });
      const frames = [];
      broker.on("frame", (frame) => frames.push(frame));
      broker.updateSnapshot("chrome-one", EXTENSION_ORIGIN, {
        streaming: true,
        frame: {
          frameId: "stream-frame",
          pageGeneration: 1,
          tabId: "2",
          url: "https://example.com/",
          width: 800,
          height: 600,
          dataUrl: "data:image/jpeg;base64,AA==",
        },
      });
      assert.equal(broker.status().streaming, true);
      assert.equal(frames.length, 1);
      assert.equal(frames[0].frameId, "stream-frame");
      assert.equal(frames[0].dataUrl, "data:image/jpeg;base64,AA==");
      broker.close();
    },
  },
];
