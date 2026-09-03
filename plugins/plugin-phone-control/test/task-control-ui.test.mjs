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
      assert.match(app, /function commandStateMarkup/);
      assert.match(styles, /\.task-result \{/);
      assert.match(styles, /\.command-lifecycle \{/);
      assert.match(worker, /task-view\.js\?v=84/);
    },
  },
];
