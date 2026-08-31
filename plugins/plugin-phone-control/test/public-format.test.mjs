import assert from "node:assert/strict";
import { cleanTaskText, compactId, escapeHtml, projectName, relativeTime, sessionDisplayStatus, taskPreview } from "../public/lib/format.js";

export const tests = [
  {
    name: "formats mobile task copy without leaking markup or unstable paths",
    async run() {
      assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
      assert.equal(projectName({ cwd: "/work/alpha" }), "alpha");
      assert.equal(compactId("123456789012345678901"), "12345678…678901");
      assert.equal(cleanTaskText("## Result\n[Open](https://example.test)"), "Result Open");
      assert.equal(taskPreview("第一句。 第二句不会进入摘要。", 30), "第一句。");
      assert.equal(relativeTime("2026-08-26T00:00:00.000Z", Date.parse("2026-08-26T02:00:00.000Z")), "2 小时前");
      const active = { status: "working", liveness: "recent", staleAt: "2026-08-26T02:10:00.000Z" };
      assert.equal(sessionDisplayStatus(active, Date.parse("2026-08-26T02:09:59.000Z")), "working");
      assert.equal(sessionDisplayStatus(active, Date.parse("2026-08-26T02:10:00.000Z")), "disconnected");
      assert.equal(sessionDisplayStatus({ ...active, liveness: "unverified" }, Date.parse("2026-08-26T02:00:00.000Z")), "disconnected");
      assert.equal(sessionDisplayStatus({ ...active, liveness: "unverified", control: { live: true } }, Date.parse("2026-08-26T03:00:00.000Z")), "working");
      assert.equal(sessionDisplayStatus({ ...active, status: "completed" }, Date.parse("2026-08-26T03:00:00.000Z")), "completed");
    },
  },
];
