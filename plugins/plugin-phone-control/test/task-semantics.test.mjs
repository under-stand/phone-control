import assert from "node:assert/strict";
import { buildTaskTitleContext, deriveTaskSemantics, isMeaningfulTaskPrompt, isTaskAnchorPrompt, searchTaskSessions } from "../src/task-semantics.mjs";

function session(overrides = {}) {
  return {
    id: "task-one",
    cwd: "/workspace/plugin-phone-control",
    machineName: "devbox-03",
    surface: "CLI",
    model: "gpt-5.6-sol",
    status: "working",
    statusReason: "Agent activity",
    startedAt: "2026-08-28T01:00:00.000Z",
    updatedAt: "2026-08-28T01:02:00.000Z",
    events: [],
    ...overrides,
  };
}

export const tests = [
  {
    name: "derives a stable human task identity instead of using the latest follow-up",
    async run() {
      assert.equal(isMeaningfulTaskPrompt("好的，去做吧"), false);
      const task = deriveTaskSemantics(session({
        taskGoalMessage: {
          eventId: "goal",
          at: "2026-08-28T01:00:01.000Z",
          text: "优化手机端连接恢复，并减少会话详情加载时间。还要补齐回归测试。",
        },
        lastUserMessage: { at: "2026-08-28T01:01:00.000Z", text: "继续做吧" },
        currentTool: { name: "exec", summary: "运行移动端回归测试" },
      }));
      assert.equal(task.title, "优化手机端连接恢复，并减少会话详情加载时间");
      assert.match(task.goal, /优化手机端连接恢复/);
      assert.equal(task.progress, "运行移动端回归测试");
      assert.equal(task.source, "user_prompt");
    },
  },
  {
    name: "keeps evaluative feedback attached to the previous actionable task",
    async run() {
      for (const prompt of ["有点长进，但是感觉还不够", "现在看起来已经不错了", "但是这个文件是在这个分支下面的，我的主分支下面没有啊", "容器外面没有吗？"]) {
        assert.equal(isTaskAnchorPrompt(prompt), false, prompt);
      }
      for (const prompt of ["我当前代码有 ZK 注册线程的相关问题吗？会导致 CPU 占用吗？", "另外有没有传入向量查询相似图片 MD5 的功能", "停，别修复了，先还原回去", "我现在手机端刷新不出来，好像连接不上了"]) {
        assert.equal(isTaskAnchorPrompt(prompt), true, prompt);
      }
      const source = session({
        events: [
          { eventId: "task", at: "2026-08-28T02:00:00.000Z", message: { role: "user", text: "会话的标题是怎么得到的，感觉不太准啊" } },
          { eventId: "feedback", at: "2026-08-28T02:01:00.000Z", message: { role: "user", text: "有点长进，但是感觉还不够" } },
        ],
      });
      const task = deriveTaskSemantics(source);
      assert.equal(task.title, "改进会话标题生成");
      assert.equal(task.sourceEventId, "task");
      const context = buildTaskTitleContext(source);
      assert.deepEqual(context.prompts.map((prompt) => prompt.taskAnchor), [true, false]);
      assert.equal(context.automaticTitle, "改进会话标题生成");
    },
  },
  {
    name: "compresses common technical task questions into action titles",
    async run() {
      assert.equal(deriveTaskSemantics(session({ events: [{ at: "2026-08-28T02:00:00.000Z", message: { role: "user", text: "我当前代码有 ZK 注册线程的相关的问题吗？会导致cpu占用吗？" } }] })).title, "排查 ZK 注册线程 CPU 占用");
      assert.equal(deriveTaskSemantics(session({ events: [{ at: "2026-08-28T02:00:00.000Z", message: { role: "user", text: "另外有没有传入向量查询相似图片 MD5 的功能" } }] })).title, "检查传入向量查询相似图片 MD5 功能");
      assert.equal(deriveTaskSemantics(session({ events: [{ at: "2026-08-28T02:00:00.000Z", message: { role: "user", text: "你可以把这个pt拷贝到我们的路径下面，你有权限，去定位一下这个漂移的原因" } }] })).title, "定位漂移原因");
    },
  },
  {
    name: "searches task semantics, project metadata, and visible conversation messages",
    async run() {
      const first = session({
        taskGoalMessage: { eventId: "goal-a", at: "2026-08-28T01:00:01.000Z", text: "优化手机端连接恢复" },
        events: [
          { eventId: "goal-a", turnId: "turn-a", at: "2026-08-28T01:00:01.000Z", message: { role: "user", text: "优化手机端连接恢复" } },
          { eventId: "reply-a", turnId: "turn-a", at: "2026-08-28T01:02:00.000Z", message: { role: "assistant", text: "已经修复 SSE 重试风暴并完成测试" } },
        ],
      });
      const second = session({
        id: "task-two",
        cwd: "/workspace/image-pipeline",
        updatedAt: "2026-08-28T00:00:00.000Z",
        taskGoalMessage: { eventId: "goal-b", at: "2026-08-28T00:00:00.000Z", text: "检查图片编译流程" },
        events: [{ eventId: "goal-b", at: "2026-08-28T00:00:00.000Z", message: { role: "user", text: "检查图片编译流程" } }],
      });

      const replyMatch = searchTaskSessions([second, first], { query: "SSE 重试" });
      assert.deepEqual(replyMatch.map((item) => item.id), ["task-one"]);
      assert.equal(replyMatch[0].match.eventId, "reply-a");
      assert.ok(["progress", "assistant_reply"].includes(replyMatch[0].match.field));
      assert.match(replyMatch[0].match.snippet, /重试风暴/);

      const projectMatch = searchTaskSessions([first, second], { query: "image-pipeline" });
      assert.deepEqual(projectMatch.map((item) => item.id), ["task-two"]);
      assert.equal(projectMatch[0].match.field, "project");
    },
  },
  {
    name: "separates the current task from the stable session topic and ignores contextual replies",
    async run() {
      for (const prompt of ["推一下吧", "分支推一下吧，我去提测了", "这个不是吗？", "修复一下这个问题吧", "可以这样尝试一下看看效果", "按照你的想法去执行吧", "没有就安装一个呗", "这是报错机器加载的模型：/models/demo.pt", "我拷贝到 /tmp/demo.pt 这里了"]) {
        assert.equal(isMeaningfulTaskPrompt(prompt), false, prompt);
      }
      const task = deriveTaskSemantics(session({
        taskGoalMessage: { eventId: "topic", at: "2026-08-28T01:00:00.000Z", text: "实现手机端实时追踪 Codex 会话" },
        events: [
          { eventId: "topic", at: "2026-08-28T01:00:00.000Z", message: { role: "user", text: "实现手机端实时追踪 Codex 会话" } },
          { eventId: "current", at: "2026-08-28T02:00:00.000Z", message: { role: "user", text: "会话的标题是怎么得到的，感觉不太准啊" } },
          { eventId: "context", at: "2026-08-28T02:01:00.000Z", message: { role: "user", text: "可以这样尝试一下看看效果" } },
        ],
        lastUserMessage: { eventId: "context", at: "2026-08-28T02:01:00.000Z", text: "可以这样尝试一下看看效果" },
      }));
      assert.equal(task.title, "改进会话标题生成");
      assert.equal(task.currentTitle, "改进会话标题生成");
      assert.equal(task.topic, "实现手机端实时追踪 Codex 会话");
      assert.equal(task.sourceEventId, "current");
      assert.equal(task.topicEventId, "topic");
    },
  },
  {
    name: "uses a manual title without losing the searchable automatic task identity",
    async run() {
      const task = deriveTaskSemantics(session({
        customTaskTitle: "Phone Control 产品打磨",
        events: [{ eventId: "current", at: "2026-08-28T02:00:00.000Z", message: { role: "user", text: "会话标题生成得不准确" } }],
      }));
      assert.equal(task.title, "Phone Control 产品打磨");
      assert.equal(task.customTitle, "Phone Control 产品打磨");
      assert.equal(task.titleSource, "manual");
      assert.equal(task.currentTitle, "会话标题生成得不准确");
    },
  },
  {
    name: "prefers a persisted smart title over the rule-based prompt title",
    async run() {
      const task = deriveTaskSemantics(session({
        smartTaskTitle: "统一移动端任务命名",
        events: [{ eventId: "prompt", at: "2026-08-28T02:00:00.000Z", message: { role: "user", text: "会话的标题是怎么得到的，感觉不太准啊" } }],
      }));
      assert.equal(task.title, "统一移动端任务命名");
      assert.equal(task.smartTitle, "统一移动端任务命名");
      assert.equal(task.titleSource, "smart");
      assert.equal(task.currentTitle, "改进会话标题生成");
    },
  },
];
