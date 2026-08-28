import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPhoneControlServer } from "../src/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function request({ port, pathname, method = "GET", headers = {}, body = null }) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.once("error", reject);
    req.end(payload || undefined);
  });
}

function runPermissionHook(input, environment) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "permission-hook.mjs")], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`permission hook exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
  child.stdin.end(JSON.stringify(input));
  return completed;
}

async function waitForApproval(port, cookie) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request({ port, pathname: "/api/approvals", headers: { cookie } });
    if (response.body.approvals.length) return response.body.approvals[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Permission hook did not create an approval challenge");
}

export const tests = [
  {
    name: "returns the Codex PermissionRequest allow shape after a phone decision",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-permission-hook-"));
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "hook-test-token", dataDir, approvals: { enabled: true, timeoutSeconds: 10 } },
        scanRollouts: false,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=hook-test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        runtime.store.ingest({
          eventId: "hook-phone-input",
          source: "phone-control",
          sessionId: "hook-session",
          turnId: "hook-turn",
          kind: "phone_input_sent",
          action: "start",
          at: new Date().toISOString(),
        });
        const hook = runPermissionHook({
          hook_event_name: "PermissionRequest",
          session_id: "hook-session",
          turn_id: "hook-turn",
          cwd: "/repo",
          tool_name: "Bash",
          tool_input: { command: "npm publish" },
          reason: "Network access",
        }, {
          PHONE_CONTROL_DATA_DIR: dataDir,
          PHONE_CONTROL_PORT: String(started.port),
          PHONE_CONTROL_TOKEN: "hook-test-token",
        });
        const approval = await waitForApproval(started.port, cookie);
        const decision = await request({
          port: started.port,
          pathname: `/api/approvals/${encodeURIComponent(approval.id)}/decision`,
          method: "POST",
          headers: { cookie, "x-phone-control-client": "1" },
          body: { decision: "allow" },
        });
        assert.equal(decision.status, 200);
        const output = JSON.parse((await hook).trim());
        assert.deepEqual(output, {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        });
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "declines desktop approvals immediately without a duplicate phone challenge",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-desktop-hook-"));
      const runtime = await createPhoneControlServer({
        config: { host: "127.0.0.1", port: 0, token: "hook-test-token", dataDir, approvals: { enabled: true, timeoutSeconds: 10 } },
        scanRollouts: false,
      });
      try {
        const started = await runtime.start();
        const paired = await request({ port: started.port, pathname: "/?token=hook-test-token" });
        const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
        const beganAt = Date.now();
        const output = await runPermissionHook({
          hook_event_name: "PermissionRequest",
          session_id: "desktop-hook-session",
          turn_id: "desktop-hook-turn",
          cwd: "/repo",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          reason: "Run local tests",
        }, {
          PHONE_CONTROL_DATA_DIR: dataDir,
          PHONE_CONTROL_PORT: String(started.port),
          PHONE_CONTROL_TOKEN: "hook-test-token",
        });
        assert.equal(output, "");
        assert.ok(Date.now() - beganAt < 1_500, "desktop approval hook should not wait for the phone timeout");
        const approvals = await request({ port: started.port, pathname: "/api/approvals", headers: { cookie } });
        assert.deepEqual(approvals.body.approvals, []);
      } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
];
