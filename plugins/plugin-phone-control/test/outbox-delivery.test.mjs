import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { CommandOutbox } from "../src/command-outbox.mjs";
import { canAttemptDelivery, deliverOutboxEntry } from "../src/outbox-delivery.mjs";
import { deriveCommandState } from "../src/command-state.mjs";
import { CodexAppServerBridge } from "../src/app-server-bridge.mjs";

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phone-outbox-race-"));
  let time = Date.now();
  const filePath = path.join(directory, "outbox.json");
  const now = () => time;
  const outbox = new CommandOutbox({ filePath, now });
  await outbox.enqueue({ id: "queue-race-001", sessionId: "thread-race", deviceId: "device-race", text: "Continue the task" });
  const entry = outbox.get("queue-race-001");
  const send = (bridge) => deliverOutboxEntry({ outbox, entry, bridge, input: { clientMessageId: entry.id, sessionId: entry.sessionId }, onDelivered() {}, now });
  try { await run({ outbox, entry, send, now, filePath, advance: ms => { time += ms; } }); }
  finally { await outbox.flush(); await rm(directory, { recursive: true, force: true }); }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const tests = [
  {
    name: "backs off proven pre-send failures even when delivery is repeatedly triggered",
    run: () => fixture(async ({ entry, send, advance }) => {
      let calls = 0;
      const bridge = { async sendInput() { calls++; throw Object.assign(new Error("Could not resume: active writer"), { statusCode: 409, delivery: "not_delivered" }); } };
      await send(bridge);
      for (let i = 0; i < 50; i++) await send(bridge);
      assert.equal(calls, 1);
      assert.equal(entry.status, "waiting");
      advance(2_000);
      await send(bridge);
      assert.equal(calls, 2);
      advance(2_000);
      await send(bridge);
      assert.equal(calls, 2);
    }),
  },
  {
    name: "quarantines uncertain transport delivery instead of retrying it",
    run: () => fixture(async ({ entry, send, advance, outbox }) => {
      let calls = 0;
      const bridge = { async sendInput() { calls++; throw Object.assign(new Error("Instruction delivery could not be confirmed"), { statusCode: 503, delivery: "unknown" }); } };
      await send(bridge); advance(60_000); await send(bridge);
      assert.equal(calls, 1);
      assert.equal(entry.status, "needs_review");
      assert.equal(entry.deliveryUnknown, true);
      await outbox.cancel(entry.id, entry.deviceId);
      assert.equal(entry.status, "canceled");
      assert.equal(deriveCommandState({}, { queuedCommands: [outbox.public(entry)] }).label, "已停止重试");
    }),
  },
  ...["rejected", "unknown", "delivered"].map(outcome => ({
    name: `keeps cancellation authoritative across a late ${outcome} send result`,
    run: () => fixture(async ({ outbox, entry, send }) => {
      const entered = deferred(), response = deferred();
      const running = send({ sendInput() { entered.resolve(); return response.promise; } });
      await entered.promise;
      await outbox.cancel(entry.id, entry.deviceId);
      await outbox.update(entry.id, { status: "waiting" });
      assert.equal(entry.status, "canceled");
      if (outcome === "delivered") response.resolve({ id: entry.id, status: "delivered", turnId: "turn-actual" });
      else response.reject(Object.assign(new Error("connection unavailable"), { statusCode: 503, delivery: outcome === "rejected" ? "not_delivered" : "unknown" }));
      await running;
      assert.equal(entry.status, outcome === "delivered" ? "delivered" : "canceled");
      assert.equal(entry.deliveryUnknown, outcome === "unknown");
      assert.equal(canAttemptDelivery(entry), false);
    }),
  })),
  {
    name: "recovers a sending record after restart without replaying the instruction",
    run: () => fixture(async ({ outbox, entry, filePath, now }) => {
      await outbox.update(entry.id, { status: "sending", attempts: 1 });
      const restored = new CommandOutbox({ filePath, now });
      await restored.restore();
      assert.equal(restored.get(entry.id).status, "needs_review");
      assert.equal(restored.pending().length, 0);
      assert.equal(JSON.parse(await readFile(filePath, "utf8")).entries[0].status, "needs_review");
    }),
  },
  {
    name: "serializes simultaneous persistence and prevents canceled commands returning to sending",
    run: () => fixture(async ({ outbox, entry, filePath }) => {
      await Promise.all([outbox.update(entry.id, { status: "sending" }), outbox.cancel(entry.id, entry.deviceId), outbox.update(entry.id, { status: "waiting" })]);
      assert.equal(entry.status, "canceled");
      assert.equal(JSON.parse(await readFile(filePath, "utf8")).entries[0].status, "canceled");
    }),
  },
  {
    name: "checks queue cancellation after asynchronous Codex preparation before any turn is sent",
    async run() {
      const bridge = new CodexAppServerBridge();
      bridge.initialized = true;
      bridge.transport = {};
      bridge.subscribedThreads.add("thread-race");
      bridge.threadStates.set("thread-race", { status: "idle", activeFlags: [] });
      let canceled = false, requests = 0;
      bridge.validateModelSelection = async () => { canceled = true; return {}; };
      bridge.request = async () => { requests++; };
      await assert.rejects(bridge.sendInput({ sessionId: "thread-race", clientMessageId: "queue-race-001", text: "Continue", isCanceled: () => canceled }), error => error.delivery === "not_delivered" && /Canceled/.test(error.message));
      assert.equal(requests, 0);
      assert.equal(bridge.commands.size, 0);
    },
  },
];
