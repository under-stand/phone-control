import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliSessionQueue } from "../src/cli-session-queue.mjs";
import { deriveCommandState } from "../src/command-state.mjs";
import { CliMessageAttempts } from "../public/lib/cli-continuation.js";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-queue-test-"));
  const pending = [], turns = [], calls = [];
  const bridge = {
    status: () => ({ connected: true, initialized: true, server: { userAgent: "codex/0.154.0" } }),
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/queue/add") {
        const persisted = JSON.parse(await readFile(path.join(root, "journal.json"), "utf8"));
        assert.equal(persisted.find((entry) => entry.clientUserMessageId === params.clientUserMessageId).status, "sending");
        const queuedSubmission = { id: `submission-${calls.length}`, ...params };
        pending.push(queuedSubmission);
        return { queuedSubmission };
      }
      if (method === "thread/queue/list") return { data: pending.filter((item) => item.threadId === params.threadId) };
      if (method === "thread/turns/list") return { data: turns };
      if (method === "thread/queue/delete") {
        const index = pending.findIndex((item) => item.id === params.queuedSubmissionId && item.threadId === params.threadId);
        if (index !== -1) pending.splice(index, 1);
        return { deleted: index !== -1 };
      }
      assert.fail(`Forbidden writer operation: ${method}`);
    },
  };
  const filePath = path.join(root, "journal.json");
  const queue = new CliSessionQueue({ bridge, filePath });
  const input = { sessionId: "thread-cli", deviceId: "phone-a", clientMessageId: "client-0001", text: "Continue the original task" };
  const consume = (status = "inProgress") => {
    const submission = pending.shift();
    turns.unshift({ id: "turn-from-cli", status, items: [{ type: "userMessage", clientId: submission.clientUserMessageId }] });
  };
  try { await run({ queue, bridge, filePath, input, pending, turns, calls, consume }); }
  finally { await queue.flush(); await rm(root, { recursive: true, force: true }); }
}

export const tests = [
  { name: "CLI compaction retains idempotency tombstones after completed display history is archived", run: () => fixture(async ({ queue, bridge, filePath, input, calls }) => {
    queue.maxDetailedRecords = 1;
    const first = await queue.submit(input);
    await queue.cancel(first.id, input.deviceId);
    await queue.submit({ ...input, clientMessageId: "new-message-001" });
    assert.equal(queue.list({ includeTerminal: true }).length, 1);
    const restored = new CliSessionQueue({ bridge, filePath });
    await restored.restore();
    assert.equal((await restored.submit(input)).status, "canceled");
    await assert.rejects(restored.submit({ ...input, text: "Changed" }), (error) => error.code === "command_id_conflict");
    assert.equal(calls.filter((call) => call.method === "thread/queue/add").length, 2);
  }) },
  { name: "a blocked CLI reconciliation does not block another session submission or cancellation", run: () => fixture(async ({ queue, bridge, input, filePath }) => {
    await queue.submit(input);
    const request = bridge.request;
    let release, entered;
    const hold = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    bridge.request = async (method, params) => {
      if (method === "thread/queue/list" && params.threadId === input.sessionId) { entered(); await hold; }
      return request(method, params);
    };
    const reconciliation = queue.reconcile();
    await started;
    try {
      let timer;
      const other = { ...input, sessionId: "other-thread", clientMessageId: "other-command-001" };
      const completed = (async () => {
        const entry = await queue.submit(other);
        assert.equal(entry.status, "cli_queued");
        assert.equal((await queue.cancel(entry.id, other.deviceId)).status, "canceled");
      })();
      try { await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Unrelated session was blocked")), 1000); })]); }
      finally { clearTimeout(timer); }
    } finally { release(); await reconciliation; }
    const disk = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(disk.length, 2);
    assert.equal(disk.find((entry) => entry.sessionId === "other-thread").status, "canceled");
  }) },
  { name: "CLI receipt recovery pages past the recent turn window and backs off failed sessions", run: () => fixture(async ({ queue, bridge, input, pending, calls }) => {
    await queue.submit(input);
    const clientId = pending.shift().clientUserMessageId;
    const request = bridge.request;
    bridge.request = async (method, params) => {
      if (method === "thread/turns/list") return params.cursor
        ? { data: [{ id: "older-turn", status: "completed", items: [{ type: "userMessage", clientId }] }] }
        : { data: [], nextCursor: "older-page" };
      return request(method, params);
    };
    await queue.reconcile();
    assert.equal(queue.list()[0].status, "needs_review");
    await queue.reconcile();
    assert.equal(queue.list({ includeTerminal: true })[0].outcome, "completed");
    await queue.submit({ ...input, clientMessageId: "second-message" });
    let failures = 0;
    bridge.request = async () => { failures++; throw new Error("Offline"); };
    await queue.reconcile();
    await queue.reconcile();
    assert.equal(failures, 1);
    assert.ok(calls.length > 0);
  }) },
  { name: "CLI queue adds once across retries and restores, then follows the exact message receipt", run: () => fixture(async ({ queue, bridge, filePath, input, calls, consume, turns }) => {
    assert.equal((await queue.submit(input)).status, "cli_queued");
    await Promise.all([queue.submit(input), queue.submit(input)]);
    const restored = new CliSessionQueue({ bridge, filePath });
    await restored.restore();
    await restored.submit(input);
    assert.equal(calls.filter((call) => call.method === "thread/queue/add").length, 1);
    const state = deriveCommandState({}, { queuedCommands: queue.list() });
    assert.equal(state.label, "已交给原 CLI 排队");
    consume();
    await queue.reconcile();
    let entry = queue.list({ includeTerminal: true })[0];
    assert.equal(entry.status, "delivered");
    assert.equal(entry.turnId, "turn-from-cli");
    turns[0].status = "completed";
    await queue.reconcile();
    entry = queue.list({ includeTerminal: true })[0];
    assert.equal(entry.outcome, "completed");
    assert.equal(deriveCommandState({}, { queuedCommands: [entry] }).state, "completed");
  }) },
  { name: "CLI queue rejects runtime overrides, wrong devices and message id reuse", run: () => fixture(async ({ queue, input, calls }) => {
    await assert.rejects(queue.submit({ ...input, permissionProfile: "danger-full-access" }), /沿用/);
    await assert.rejects(queue.submit({ ...input, imageIds: ["image"] }), /文字/);
    assert.equal(calls.length, 0);
    const entry = await queue.submit(input);
    await assert.rejects(queue.submit({ ...input, sessionId: "different-thread" }), /另一条/);
    await assert.rejects(queue.submit({ ...input, deviceId: "phone-b" }), /另一条/);
    await assert.rejects(queue.submit({ ...input, text: "Different message" }), /另一条/);
    assert.equal(await queue.cancel(entry.id, "phone-b"), null);
    assert.deepEqual(queue.list({ deviceId: "phone-b" }), []);
    assert.equal((await queue.cancel(entry.id, "phone-a")).status, "canceled");
    await queue.reconcile();
    assert.equal(calls.filter((call) => call.method === "thread/queue/add").length, 1);
  }) },
  { name: "CLI queue reconciles lost add responses without replay and never treats missing queue entries as execution", run: () => fixture(async ({ queue, bridge, input, pending, calls }) => {
    const request = bridge.request;
    bridge.request = async (...args) => {
      const response = await request(...args);
      if (args[0] === "thread/queue/add") throw new Error("Lost response");
      return response;
    };
    assert.equal((await queue.submit(input)).status, "needs_review");
    await queue.submit(input);
    await queue.reconcile();
    assert.equal(queue.list()[0].status, "cli_queued");
    pending.length = 0;
    await queue.reconcile();
    assert.equal(queue.list()[0].status, "needs_review");
    const canceled = await queue.cancel(queue.list()[0].id, input.deviceId);
    assert.equal(canceled.status, "needs_review");
    assert.equal(calls.filter((call) => call.method === "thread/queue/add").length, 1);
  }) },
  { name: "CLI cancellation waits for an in-flight add and only confirms an acknowledged deletion", run: () => fixture(async ({ queue, bridge, input, pending }) => {
    const request = bridge.request;
    let release, entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    bridge.request = async (...args) => {
      const result = await request(...args);
      if (args[0] === "thread/queue/add") { entered(); await blocked; }
      return result;
    };
    const submitted = queue.submit(input);
    await started;
    const canceled = queue.cancel(`cli-${input.clientMessageId}`, input.deviceId);
    release();
    await submitted;
    assert.equal((await canceled).status, "canceled");
    assert.equal(pending.length, 0);
  }) },
  { name: "CLI consumption racing a cancellation reports the actual turn instead of canceled", run: () => fixture(async ({ queue, bridge, input, consume }) => {
    const entry = await queue.submit(input);
    const request = bridge.request;
    bridge.request = async (method, params) => {
      if (method === "thread/queue/delete") { consume(); return { deleted: false }; }
      return request(method, params);
    };
    const canceled = await queue.cancel(entry.id, input.deviceId);
    assert.equal(canceled.status, "delivered");
    assert.equal(canceled.turnId, "turn-from-cli");
  }) },
  { name: "CLI restart during sending preserves uncertainty and does not add again", run: () => fixture(async ({ queue, bridge, filePath, input, calls }) => {
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    bridge.request = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const submitted = queue.submit(input);
    await started;
    const restored = new CliSessionQueue({ bridge, filePath });
    await restored.restore();
    assert.equal((await restored.submit(input)).status, "needs_review");
    assert.equal(calls.length, 0);
    release({ queuedSubmission: { id: "accepted" } });
    await submitted;
  }) },
  { name: "CLI continuation capability excludes phone-owned, non-user and unsupported sessions", run: () => fixture(async ({ queue, bridge, input }) => {
    const session = { surface: "CLI", taskKind: "user", hasTranscript: true, control: { live: false } };
    assert.equal(queue.capability(session).available, true);
    assert.equal(queue.capability({ ...session, surface: "Desktop" }).available, false);
    assert.equal(queue.capability({ ...session, taskKind: "internal" }).available, false);
    assert.equal(queue.capability({ ...session, control: { live: true } }).available, false);
    bridge.request = async () => { throw Object.assign(new Error("Unsupported"), { rpcError: { code: -32601 } }); };
    assert.equal((await queue.submit(input)).status, "failed");
    assert.equal(queue.capability(session).available, false);
  }) },
  { name: "phone CLI attempt identity survives rerender and reload until confirmed", async run() {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
    let counter = 0;
    const createId = () => `test-${++counter}`;
    let attempts = new CliMessageAttempts(storage, createId);
    const id = attempts.id("session-a", "Continue");
    attempts = new CliMessageAttempts(storage, createId);
    assert.equal(attempts.id("session-a", "Continue"), id);
    assert.notEqual(attempts.id("session-b", "Continue"), id);
    attempts.complete("session-a");
    assert.notEqual(attempts.id("session-a", "Continue"), id);
  } },
];
