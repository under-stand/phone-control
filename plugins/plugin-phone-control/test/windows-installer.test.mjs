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
      assert.doesNotMatch(script, /under-stand\/plugin-phone-control\.git/);
      assert.match(script, /plugins\\plugin-phone-control/);
      assert.match(script, /Copy-PluginBundle/);
      assert.match(script, /\.codex-plugin\\plugin\.json/);
      assert.match(script, /local Phone Control bundle/);
      assert.match(script, /MinimumNodeMajor = 22/);
      assert.match(script, /USERPROFILE '.phone-control'/);
      assert.match(script, /function Test-Native/);
      assert.match(script, /global:LASTEXITCODE = 0/);
      const nodeProbe = script.match(/function Get-NodeMajor[\s\S]*?\n}/)?.[0] || "";
      assert.doesNotMatch(nodeProbe, /LASTEXITCODE/);
      assert.match(script, /@openai\/codex@latest/);
      assert.match(script, /plugin', 'marketplace', 'add'/);
      assert.match(script, /\$marketplaceRoot/);
      assert.match(script, /plugin', 'add'/);
      assert.match(script, /'app-server', '--help'/);
      assert.match(script, /'ci', '--omit=dev'/);
      assert.match(script, /'service', 'install',[\s\S]*'--runtime'/);
      assert.match(script, /'--codex-command', \$codex/);
      assert.match(script, /'--app-server-transport', 'auto'/);
      assert.match(script, /tailscale serve --bg 8787/);
      assert.match(script, /127\.0\.0\.1:8787\/api\/health/);
      assert.match(script, /health\.ok -and \$health\.ready -eq \$true/);
      assert.match(script, /fully quit and reopen Codex/);
      assert.match(script, /Native Windows uses a managed local Codex App Server/);
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
