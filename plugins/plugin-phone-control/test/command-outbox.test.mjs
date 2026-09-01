import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { CommandOutbox } from "../src/command-outbox.mjs";

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test("persists queued instructions, enforces device ownership, and cancels them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phone-control-outbox-"));
  const filePath = path.join(directory, "outbox.json");
  try {
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    const outbox = new CommandOutbox({ filePath, now: () => now, ttlMs: 60_000 });
    const created = await outbox.enqueue({ id: "queue-00000001", sessionId: "thread-1", deviceId: "device-a", text: "继续处理" });
    assert.equal(created.created, true);
    assert.equal(outbox.list({ sessionId: "thread-1", deviceId: "device-a" })[0].status, "queued");
    await assert.rejects(
      outbox.enqueue({ id: "queue-00000001", sessionId: "thread-1", deviceId: "device-b", text: "不应覆盖" }),
      (error) => error.statusCode === 409,
    );
    const restored = new CommandOutbox({ filePath, now: () => now, ttlMs: 60_000 });
    await restored.restore();
    assert.equal(restored.get("queue-00000001").text, "继续处理");
    const canceled = await restored.cancel("queue-00000001", "device-a");
    assert.equal(canceled.status, "canceled");
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).entries[0].status, "canceled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expires pending instructions on restore", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phone-control-outbox-"));
  const filePath = path.join(directory, "outbox.json");
  try {
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    const outbox = new CommandOutbox({ filePath, now: () => now, ttlMs: 1_000 });
    await outbox.enqueue({ id: "queue-00000002", sessionId: "thread-2", deviceId: "device-a", text: "稍后发送" });
    now += 2_000;
    const restored = new CommandOutbox({ filePath, now: () => now, ttlMs: 1_000 });
    await restored.restore();
    assert.equal(restored.get("queue-00000002").status, "expired");
    assert.equal(restored.pending().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

export { tests };
