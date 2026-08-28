import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CompletionPolicy } from "../src/completion-policy.mjs";
import { ImageStore } from "../src/image-store.mjs";
import { PushBroker } from "../src/push-broker.mjs";

const subscription = {
  endpoint: "https://push.example.test/send/device-token",
  expirationTime: null,
  keys: { p256dh: "A_valid-p256dh_key", auth: "A_valid-auth_key" },
};

export const tests = [
  {
    name: "stores private per-device push subscriptions and sends only generic payloads",
    async run() {
      const root = await mkdtemp(path.join(os.tmpdir(), "phone-control-push-test-"));
      const sent = [];
      const active = new Set(["device-1"]);
      const broker = new PushBroker({
        filePath: path.join(root, "push.json"),
        generateKeys: () => ({ publicKey: "public-test-key", privateKey: "private-test-key" }),
        deviceIsActive: (id) => active.has(id),
        sendNotification: async (target, payload, options) => sent.push({ target, payload: JSON.parse(payload), options }),
      });
      try {
        await broker.restore();
        await broker.subscribe("device-1", subscription);
        assert.deepEqual(broker.status("device-1"), { available: true, publicKey: "public-test-key", subscribed: true });
        const policy = new CompletionPolicy();
        policy.seed([{ id: "thread-secret", status: "working", taskKind: "user", updatedAt: "2026-08-24T12:00:00Z" }]);
        const waiting = policy.observe({
          id: "thread-secret",
          status: "waiting",
          taskKind: "user",
          updatedAt: "2026-08-24T12:00:01Z",
          cwd: "/private/project",
          lastUserMessage: { text: "do not leak this prompt" },
        });
        assert.equal(waiting, null, "intermediate waiting states must stay silent");
        const completion = policy.observe({ id: "thread-secret", status: "idle", taskKind: "user", updatedAt: "2026-08-24T12:00:02Z", lastCompletedTurnId: "turn-1" });
        assert.ok(completion);
        await broker.broadcast(completion);
        assert.equal(policy.observe({ id: "thread-secret", status: "completed", taskKind: "user", updatedAt: "2026-08-24T12:00:03Z", lastCompletedTurnId: "turn-1" }), null);
        assert.equal(policy.observe({ id: "thread-secret", status: "working", taskKind: "user", updatedAt: "2026-08-24T12:00:04Z", lastCompletedTurnId: "turn-1" }), null);
        assert.equal(policy.observe({ id: "thread-secret", status: "idle", taskKind: "user", updatedAt: "2026-08-24T12:00:05Z", lastCompletedTurnId: "turn-1" }), null);
        assert.equal(sent.length, 1, "one turn may produce only one final completion push");
        assert.equal(sent[0].payload.title, "Codex 本轮已完成");
        assert.equal(sent[0].payload.url, "/?session=thread-secret");
        assert.doesNotMatch(JSON.stringify(sent[0].payload), /private|do not leak/);
        assert.equal(sent[0].options.vapidDetails.privateKey, "private-test-key");
        const stored = JSON.parse(await readFile(path.join(root, "push.json"), "utf8"));
        assert.equal(stored.subscriptions[0].deviceId, "device-1");
        assert.equal(JSON.stringify(broker.status("device-1")).includes(subscription.endpoint), false);
      } finally {
        await broker.flush();
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "removes expired push endpoints and keeps unsubscribe idempotent",
    async run() {
      const root = await mkdtemp(path.join(os.tmpdir(), "phone-control-push-expired-test-"));
      const broker = new PushBroker({
        filePath: path.join(root, "push.json"),
        generateKeys: () => ({ publicKey: "public-test-key", privateKey: "private-test-key" }),
        deviceIsActive: () => true,
        sendNotification: async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); },
      });
      try {
        await broker.restore();
        await broker.subscribe("device-1", subscription);
        await broker.broadcast({ title: "done", tag: "turn", kind: "complete" });
        assert.equal(broker.status("device-1").subscribed, false);
        assert.equal(await broker.unsubscribe("device-1"), false);
        const stored = JSON.parse(await readFile(path.join(root, "push.json"), "utf8"));
        assert.deepEqual(stored.subscriptions, []);
      } finally {
        await broker.flush();
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "delivers a completion only to the selected device recipients",
    async run() {
      const root = await mkdtemp(path.join(os.tmpdir(), "phone-control-push-target-"));
      const sent = [];
      const broker = new PushBroker({
        filePath: path.join(root, "push.json"),
        generateKeys: () => ({ publicKey: "public-test-key", privateKey: "private-test-key" }),
        deviceIsActive: () => true,
        sendNotification: async (target, payload) => sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) }),
      });
      try {
        await broker.restore();
        await broker.subscribe("device-a", { ...subscription, endpoint: "https://push.example.test/a" });
        await broker.subscribe("device-b", { ...subscription, endpoint: "https://push.example.test/b" });
        await broker.broadcast({ title: "done", tag: "turn-a", kind: "complete" }, { deviceIds: new Set(["device-b"]) });
        assert.deepEqual(sent.map((item) => item.endpoint), ["https://push.example.test/b"]);
      } finally {
        await broker.flush();
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "validates image signatures and binds one-time files to device, session, and turn",
    async run() {
      const root = await mkdtemp(path.join(os.tmpdir(), "phone-control-image-test-"));
      const store = new ImageStore({ directory: path.join(root, "uploads") });
      await store.initialize();
      try {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
        const uploaded = await store.store({ buffer: jpeg, deviceId: "device-1", sessionId: "thread-1", expectedTurnId: "turn-1" });
        await assert.rejects(
          async () => store.consume([uploaded.id], { deviceId: "device-2", sessionId: "thread-1", expectedTurnId: "turn-1" }),
          (error) => error.statusCode === 409,
        );
        const [record] = await store.consume([uploaded.id], { deviceId: "device-1", sessionId: "thread-1", expectedTurnId: "turn-1" });
        await access(record.path);
        assert.equal(record.mime, "image/jpeg");
        await store.discardRecords([record]);
        await assert.rejects(access(record.path));
        await assert.rejects(
          store.store({ buffer: Buffer.from("not an image"), deviceId: "device-1", sessionId: "thread-1" }),
          (error) => error.statusCode === 415,
        );
      } finally {
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "keeps a leased image through service restart and expires it later",
    async run() {
      const root = await mkdtemp(path.join(os.tmpdir(), "phone-control-image-lease-test-"));
      const directory = path.join(root, "uploads");
      const first = new ImageStore({ directory, ttlMs: 500 });
      await first.initialize();
      try {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
        const uploaded = await first.store({ buffer: jpeg, deviceId: "device-1", sessionId: "thread-1" });
        const [record] = await first.consume([uploaded.id], { deviceId: "device-1", sessionId: "thread-1" });
        assert.equal(await first.discard(uploaded.id, "device-1"), false, "a client must not delete a path after Codex has leased it");
        await first.close();
        await access(record.path);

        const restored = new ImageStore({ directory, ttlMs: 500 });
        await restored.initialize();
        await access(record.path);
        await assert.rejects(
          restored.consume([uploaded.id], { deviceId: "device-1", sessionId: "thread-1" }),
          (error) => error.statusCode === 409,
        );
        await delay(550);
        await restored.cleanup();
        await assert.rejects(access(record.path));
        await restored.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
];
