import assert from "node:assert/strict";
import { TaskTitleGenerator } from "../src/task-title-generator.mjs";

const context = {
  sessionId: "thread-1",
  project: "plugin-phone-control",
  topic: "实现手机端控制 Codex",
  automaticTitle: "改进会话标题生成",
  prompts: [
    { index: 1, text: "会话的标题是怎么得到的，感觉不太准啊", taskAnchor: true },
    { index: 2, text: "有点长进，但是感觉还不够", taskAnchor: false },
  ],
};

export const tests = [
  {
    name: "uses an ephemeral isolated Codex run and caches title suggestions",
    async run() {
      const calls = [];
      const generator = new TaskTitleGenerator({
        pluginRoot: "/tmp/plugin-phone-control",
        commandRunner: async (command, args, options) => {
          calls.push({ command, args, options });
          return { stdout: JSON.stringify({ title: "优化会话任务标题" }), stderr: "" };
        },
      });
      assert.deepEqual(await generator.suggest(context), { title: "优化会话任务标题", cached: false });
      assert.deepEqual(await generator.suggest(context), { title: "优化会话任务标题", cached: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, "codex");
      assert.ok(calls[0].args.includes("--ephemeral"));
      assert.ok(calls[0].args.includes("--ignore-user-config"));
      assert.ok(calls[0].args.includes("--ignore-rules"));
      assert.match(calls[0].args.at(-1), /有点长进/);
    },
  },
  {
    name: "rejects generic or malformed smart titles",
    async run() {
      const malformed = new TaskTitleGenerator({ pluginRoot: "/tmp", commandRunner: async () => ({ stdout: "not-json" }) });
      await assert.rejects(() => malformed.suggest(context), /invalid title response/);
      const generic = new TaskTitleGenerator({ pluginRoot: "/tmp", commandRunner: async () => ({ stdout: JSON.stringify({ title: "当前任务" }) }) });
      await assert.rejects(() => generic.suggest(context), /useful task title/);
    },
  },
  {
    name: "deduplicates one title request and bounds cross-session generation concurrency",
    async run() {
      let release;
      const generator = new TaskTitleGenerator({
        pluginRoot: "/tmp",
        commandRunner: () => new Promise((resolve) => {
          release = () => resolve({ stdout: JSON.stringify({ title: "优化会话标题生成" }), stderr: "" });
        }),
      });
      const first = generator.suggest(context);
      const duplicate = generator.suggest(context);
      await assert.rejects(
        () => generator.suggest({ ...context, sessionId: "thread-2" }),
        (error) => error.statusCode === 429,
      );
      release();
      assert.deepEqual(await first, { title: "优化会话标题生成", cached: false });
      assert.deepEqual(await duplicate, { title: "优化会话标题生成", cached: false });
    },
  },
];
