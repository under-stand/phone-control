import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runScript(script, input, environment) {
  return runScriptPath(path.join(root, "scripts", script), input, environment);
}

function runScriptPath(scriptPath, input, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stderr).toString("utf8"));
      else reject(new Error(`hook exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function runHook(input, environment) {
  return runScript("hook.mjs", input, environment);
}

export const tests = [
  {
    name: "uses bounded synchronous hooks with a stable plugin-data runtime fallback",
    async run() {
      const hooks = JSON.parse(await readFile(path.join(root, "hooks", "hooks.json"), "utf8"));
      const passiveHandlers = Object.entries(hooks.hooks)
        .filter(([event]) => event !== "PermissionRequest")
        .flatMap(([, groups]) => groups.flatMap((group) => group.hooks));
      assert.ok(passiveHandlers.length > 0);
      assert.equal(passiveHandlers.some((handler) => Object.hasOwn(handler, "async")), false);
      assert.equal(passiveHandlers.every((handler) => handler.command.includes("${PLUGIN_DATA}/hook-runtime/scripts/hook.mjs")), true);
      assert.equal(passiveHandlers.every((handler) => handler.command.includes("${PLUGIN_ROOT}/scripts/hook.mjs")), true);
      assert.equal(passiveHandlers.every((handler) => handler.timeout === 1), true);
      const permission = hooks.hooks.PermissionRequest[0].hooks[0];
      assert.match(permission.command, /\$\{PLUGIN_DATA\}\/hook-runtime\/scripts\/permission-hook\.mjs/);
      assert.match(permission.command, /\$\{PLUGIN_ROOT\}\/scripts\/permission-hook\.mjs/);
    },
  },
  {
    name: "keeps hooks runnable after the versioned plugin cache root disappears",
    async run() {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "phone-control-hook-runtime-"));
      const pluginData = path.join(temporary, "plugin-data");
      const dataDir = path.join(temporary, "sidecar-data");
      const environment = {
        PLUGIN_ROOT: root,
        PLUGIN_DATA: pluginData,
        PHONE_CONTROL_DATA_DIR: dataDir,
        PHONE_CONTROL_PORT: "1",
        PHONE_CONTROL_TOKEN: "runtime-test-token",
      };
      try {
        await runHook({
          hook_event_name: "UserPromptSubmit",
          session_id: "runtime-seed",
          turn_id: "turn-1",
          prompt: "Seed the stable hook runtime",
        }, environment);
        const stableScript = path.join(pluginData, "hook-runtime", "scripts", "hook.mjs");
        assert.match(await readFile(stableScript, "utf8"), /ensureStableHookRuntime/);

        await runScriptPath(stableScript, {
          hook_event_name: "UserPromptSubmit",
          session_id: "runtime-after-upgrade",
          turn_id: "turn-2",
          prompt: "The old plugin root is gone",
        }, { ...environment, PLUGIN_ROOT: path.join(temporary, "missing-cache-root") });
        const events = (await readFile(path.join(dataDir, "hook-spool.jsonl"), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(events.some((event) => event.sessionId === "runtime-after-upgrade" && event.kind === "user_prompt"), true);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  },
  {
    name: "spools a normalized hook event when the sidecar is offline",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-hook-"));
      try {
        const debug = await runHook({
          hook_event_name: "PermissionRequest",
          session_id: "session-offline",
          turn_id: "turn-1",
          cwd: "/repo",
          tool_name: "Bash",
          tool_input: { command: "git push" },
          reason: "Network access",
        }, {
          PHONE_CONTROL_DATA_DIR: dataDir,
          PHONE_CONTROL_PORT: "1",
          PHONE_CONTROL_TOKEN: "offline-test-token",
          PHONE_CONTROL_DEBUG: "1",
        });
        let spool;
        try {
          spool = await readFile(path.join(dataDir, "hook-spool.jsonl"), "utf8");
        } catch (error) {
          throw new Error(`${error.message}; files=${(await readdir(dataDir)).join(",")}${debug ? `\n${debug}` : ""}`);
        }
        const rows = spool.trim().split("\n");
        const event = JSON.parse(rows[0]);
        assert.equal(event.sessionId, "session-offline");
        assert.equal(event.kind, "permission_request");
        assert.equal(event.tool.summary, "git push");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
];
