import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CommandReplay } from "../src/command-replay.mjs";
import { SessionInputService } from "../src/session-input-service.mjs";

const input = { sessionId: "thread-a", clientMessageId: "message-0001", text: "Synthetic instruction" };
const device = { id: "device-a" };
const result = { id: input.clientMessageId, sessionId: input.sessionId, turnId: "turn-a", status: "delivered" };
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "command-replay-"));
  const filePath = path.join(directory, "journal.json");
  const replay = new CommandReplay({ filePath });
  try { await run({ replay, filePath }); }
  finally { await replay.flush(); await rm(directory, { recursive: true, force: true }); }
}
export const tests = [
  { name: "coalesces concurrent direct requests and returns the persisted receipt after restart", run: () => fixture(async ({ replay, filePath }) => {
    let calls = 0;
    const run = async () => {
      calls++;
      const records = JSON.parse(await readFile(filePath, "utf8"));
      assert.equal(records[0].status, "sending");
      return result;
    };
    const receipts = await Promise.all([replay.execute(input, device, "direct", run), replay.execute(input, device, "direct", run)]);
    assert.deepEqual(receipts, [result, result]);
    const restarted = new CommandReplay({ filePath });
    assert.deepEqual(await restarted.execute(input, device, "direct", run), result);
    assert.equal(calls, 1);
    assert.ok(!(await readFile(filePath, "utf8")).includes(input.text), "journal retains a digest, not the prompt");
    for (const changed of [{ text: "Different" }, { sessionId: "thread-b" }, { permissionProfile: "danger-full-access" }, { imageIds: ["image-a"] }]) {
      await assert.rejects(replay.execute({ ...input, ...changed }, device, "direct", run), (error) => error.code === "command_id_conflict");
    }
    await assert.rejects(replay.execute(input, { id: "device-b" }, "direct", run), /conflicts/);
  }) },
  { name: "does not replay uncertain direct input across restart, but permits proven pre-send retries", run: () => fixture(async ({ replay, filePath }) => {
    let calls = 0;
    await assert.rejects(replay.execute(input, device, "direct", async () => { calls++; throw new Error("Lost reply"); }), /Lost reply/);
    const restarted = new CommandReplay({ filePath });
    await assert.rejects(restarted.execute(input, device, "direct", async () => { calls++; return result; }), (error) => error.delivery === "unknown");
    assert.equal(restarted.uncertain({ sessionId: input.sessionId, deviceId: device.id }).length, 1);
    assert.equal(restarted.uncertain({ deviceId: "other" }).length, 0);
    assert.equal(calls, 1);
    const other = { ...input, clientMessageId: "message-0002" };
    await assert.rejects(replay.execute(other, device, "direct", async () => { throw Object.assign(new Error("Disconnected"), { delivery: "not_delivered" }); }));
    assert.deepEqual(await replay.execute(other, device, "direct", async () => result), result);
  }) },
  { name: "HTTP input retries return the same result even after control and turn state changed", run: () => fixture(async ({ filePath }) => {
    let sends = 0, prompts = 0, consumes = 0;
    const session = { control: { canSend: true, expectedTurnId: null } };
    const service = new SessionInputService({ filePath, store: { get: () => session },
      images: { consume: async () => { consumes++; return []; }, discardRecords: async () => {} },
      executionContext: () => ({}), rememberPrompt: () => { prompts++; },
      bridge: { sendInput: async () => { sends++; session.control = { canSend: false, expectedTurnId: "different" }; return result; } },
    });
    assert.deepEqual(await service.send(input.sessionId, input, device), result);
    assert.deepEqual(await service.send(input.sessionId, input, device), result);
    assert.deepEqual({ sends, prompts, consumes }, { sends: 1, prompts: 1, consumes: 1 });
    await service.replay.flush();
  }) },
];
