import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const tests = [
  {
    name: "ships an idempotent current-user Windows installer",
    async run() {
      const script = await readFile(path.join(root, "install-windows.ps1"), "utf8");
      assert.match(script, /under-stand\/phone-control\.git/);
      assert.match(script, /MinimumNodeMajor = 22/);
      assert.match(script, /@openai\/codex@latest/);
      assert.match(script, /plugin', 'marketplace', 'add'/);
      assert.match(script, /plugin', 'add'/);
      assert.match(script, /'ci', '--omit=dev'/);
      assert.match(script, /'service', 'install', '--runtime'/);
      assert.match(script, /tailscale serve --bg 8787/);
      assert.match(script, /127\.0\.0\.1:8787\/api\/health/);
      assert.match(script, /fully quit and reopen Codex/);
      assert.doesNotMatch(script, /password\s*=|token\s*=/i);
    },
  },
  {
    name: "ships a double-click Windows wrapper without embedding an install path",
    async run() {
      const wrapper = await readFile(path.join(root, "install-windows.cmd"), "utf8");
      assert.match(wrapper, /ExecutionPolicy Bypass -File "%~dp0install-windows\.ps1"/);
      assert.doesNotMatch(wrapper, /Users\\|Program Files/);
    },
  },
];
