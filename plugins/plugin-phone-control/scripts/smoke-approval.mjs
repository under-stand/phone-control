#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function request({ port, pathname, method = "GET", token = null, cookie = null, body = null }) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method !== "GET" ? { "x-phone-control-client": "1" } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          reject(new Error(`Live service returned invalid JSON from ${pathname}`));
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 400) {
          resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
        } else {
          reject(new Error(parsed?.error || `Live service returned HTTP ${response.statusCode}`));
        }
      });
    });
    req.setTimeout(3_000, () => req.destroy(new Error(`Timed out calling ${pathname}`)));
    req.once("error", reject);
    req.end(payload || undefined);
  });
}

function runPermissionHook(input, config) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "permission-hook.mjs")], {
    env: {
      ...process.env,
      PHONE_CONTROL_DATA_DIR: config.dataDir,
      PHONE_CONTROL_PORT: String(config.port),
      PHONE_CONTROL_TOKEN: config.token,
    },
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
      else reject(new Error(`Permission hook exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
  child.stdin.end(JSON.stringify(input));
  return completed;
}

async function waitForApproval(config, cookie, sessionId, turnId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request({ port: config.port, pathname: "/api/approvals", cookie });
    const approval = response.body.approvals.find((item) => item.sessionId === sessionId && item.turnId === turnId);
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No live approval appeared for ${turnId}`);
}

async function simulateDecision({ config, cookie, sessionId, decision }) {
  const turnId = `smoke-${decision}-${randomUUID()}`;
  await request({
    port: config.port,
    pathname: "/api/internal/hook",
    method: "POST",
    token: config.token,
    body: {
      eventId: randomUUID(),
      source: "phone-control-smoke",
      sessionId,
      turnId,
      kind: "phone_input_sent",
      action: "start",
      at: new Date().toISOString(),
    },
  });
  const hook = runPermissionHook({
    hook_event_name: "PermissionRequest",
    session_id: sessionId,
    turn_id: turnId,
    cwd: "/phone-control/smoke-test",
    source: "cli",
    tool_name: "Bash",
    tool_input: { command: `printf 'simulated-${decision}'` },
    reason: `Phone Control smoke test: ${decision}`,
  }, config);
  const approval = await waitForApproval(config, cookie, sessionId, turnId);
  await request({
    port: config.port,
    pathname: `/api/approvals/${encodeURIComponent(approval.id)}/decision`,
    method: "POST",
    cookie,
    body: { decision },
  });
  const output = JSON.parse((await hook).trim());
  assert.equal(output.hookSpecificOutput?.hookEventName, "PermissionRequest");
  assert.equal(output.hookSpecificOutput?.decision?.behavior, decision);
  return { approvalId: approval.id, behavior: output.hookSpecificOutput.decision.behavior };
}

const config = await loadConfig();
const health = await request({ port: config.port, pathname: "/api/health" });
assert.equal(health.body.version, "0.7.1", "Live Phone Control v0.7.1 is not running");

let cookie = null;
let temporaryDeviceId = null;
const sessionId = `phone-control-smoke-${randomUUID()}`;

try {
  const pairing = await request({
    port: config.port,
    pathname: "/api/internal/pairings",
    method: "POST",
    token: config.token,
    body: { baseUrl: `http://127.0.0.1:${config.port}` },
  });
  const pairPath = new URL(pairing.body.pairing.url).pathname + new URL(pairing.body.pairing.url).search;
  const paired = await request({ port: config.port, pathname: pairPath });
  cookie = paired.headers["set-cookie"]?.[0]?.split(";", 1)[0] || null;
  assert.ok(cookie, "Temporary simulated phone did not receive a device cookie");
  const devices = await request({ port: config.port, pathname: "/api/devices", cookie });
  temporaryDeviceId = devices.body.currentDeviceId;

  process.stdout.write(`Live service: v${health.body.version}, hook approval protocol reachable\n`);
  const denied = await simulateDecision({ config, cookie, sessionId, decision: "deny" });
  process.stdout.write(`DENY: challenge ${denied.approvalId} -> hook returned ${denied.behavior}\n`);
  const allowed = await simulateDecision({ config, cookie, sessionId, decision: "allow" });
  process.stdout.write(`ALLOW: challenge ${allowed.approvalId} -> hook returned ${allowed.behavior}\n`);

  await request({
    port: config.port,
    pathname: "/api/internal/hook",
    method: "POST",
    token: config.token,
    body: {
      eventId: randomUUID(),
      sessionId,
      kind: "session_end",
      source: "phone-control-smoke",
      at: new Date().toISOString(),
    },
  });
  process.stdout.write(`PASS: synthetic PermissionRequest payloads produced the expected single-use hook responses.\n`);
  process.stdout.write(`SCOPE: this validates Phone Control's hook protocol, not a real Codex tool approval; no Codex turn or command was started.\n`);
} finally {
  if (cookie && temporaryDeviceId) {
    await request({
      port: config.port,
      pathname: `/api/devices/${encodeURIComponent(temporaryDeviceId)}/revoke`,
      method: "POST",
      cookie,
    }).catch(() => {});
  }
}
