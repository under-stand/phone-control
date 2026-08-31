import assert from "node:assert/strict";
import { BrowserActionReplayStore } from "../src/browser-action-replay.mjs";

const reload = (clientActionId = "action-1") => ({ type: "reload", clientActionId });

export const tests = [
  {
    name: "coalesces retried and concurrent browser actions",
    async run() {
      const store = new BrowserActionReplayStore();
      let release;
      let executions = 0;
      const blocked = new Promise((resolve) => { release = resolve; });
      const run = async () => { executions += 1; await blocked; return { ok: true }; };
      const first = store.execute({ actorId: "phone-a", action: reload(), run });
      const retry = store.execute({ actorId: "phone-a", action: reload(), run });
      release();
      assert.deepEqual(await Promise.all([first, retry]), [{ ok: true }, { ok: true }]);
      assert.deepEqual(await store.execute({ actorId: "phone-a", action: reload(), run }), { ok: true });
      assert.equal(executions, 1);
    },
  },
  {
    name: "rejects action id reuse with different content and stores no typed text",
    async run() {
      const store = new BrowserActionReplayStore();
      const action = {
        type: "insertText",
        frameId: "frame",
        pageGeneration: 1,
        text: "private-test-password",
        clientActionId: "action-1",
      };
      await store.execute({ actorId: "phone-a", action, run: async () => ({ ok: true }) });
      assert.equal(JSON.stringify([...store.entries.values()]).includes(action.text), false);
      await assert.rejects(
        store.execute({ actorId: "phone-a", action: reload("action-1"), run: async () => ({ ok: true }) }),
        (error) => error.code === "action_id_conflict" && error.statusCode === 409,
      );
      assert.equal(store.clearActor("phone-a"), 1);
    },
  },
  {
    name: "does not retain oversized browser action results",
    async run() {
      const store = new BrowserActionReplayStore({ maxResultBytes: 10 });
      let executions = 0;
      const run = async () => ({ image: "larger-than-the-cache-limit", executions: ++executions });
      await store.execute({ actorId: "phone-a", action: reload(), run });
      await store.execute({ actorId: "phone-a", action: reload(), run });
      assert.equal(executions, 2);
    },
  },
];
