import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const tests = [
  {
    name: "ships the action inbox, command lifecycle, and structured result mobile surfaces",
    async run() {
      const [html, app, styles, worker] = await Promise.all([
        readFile(path.join(root, "public/index.html"), "utf8"),
        readFile(path.join(root, "public/app.js"), "utf8"),
        readFile(path.join(root, "public/styles.css"), "utf8"),
        readFile(path.join(root, "public/sw.js"), "utf8"),
      ]);
      assert.match(html, /id="action-inbox"/);
      assert.match(app, /function taskResultMarkup/);
      assert.match(app, /data-task-result/);
      assert.match(app, /expandedResults/);
      assert.match(app, /turnResult/);
      assert.match(app, /当前指令/);
      assert.match(app, /会话主题/);
      assert.match(app, /function commandStateMarkup/);
      assert.match(styles, /\.task-result \{/);
      assert.match(styles, /\.command-lifecycle \{/);
      assert.match(worker, /task-view\.js\?v=91/);

      // Detail cards render only after a session is opened. Keep this
      // declaration-order check here so a browser-only temporal-dead-zone
      // regression cannot pass the release gate again.
      const turnStart = app.indexOf("function conversationTurn(");
      const turnEnd = app.indexOf("\nfunction conversation(", turnStart);
      assert.ok(turnStart >= 0 && turnEnd > turnStart, "conversationTurn renderer must remain discoverable");
      const turnSource = app.slice(turnStart, turnEnd);
      const statusDeclaration = turnSource.indexOf("const status = conversationTurnStatus");
      const statusVisibility = turnSource.indexOf("const showStatus =");
      assert.ok(statusDeclaration >= 0, "conversationTurn must compute status");
      assert.ok(statusVisibility > statusDeclaration, "conversationTurn must compute status before reading it");
    },
  },
];
