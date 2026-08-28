#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CodexAppServerBridge } from "../src/app-server-bridge.mjs";
import { loadConfig } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function request({ port, pathname, method = "GET", token = null, cookie = null, body = null, timeoutMs = 10_000 }) {
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
        try { parsed = text ? JSON.parse(text) : null; } catch {
          reject(new Error(`Live service returned invalid JSON from ${pathname}`));
          return;
        }
        resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out calling ${pathname}`)));
    req.once("error", reject);
    req.end(payload || undefined);
  });
}

function waitForEvent(emitter, event, predicate, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(value);
    };
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    emitter.on(event, listener);
  });
}

async function waitForPhoneAction(config, cookie, threadId, action, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await request({ port: config.port, pathname: `/api/sessions/${encodeURIComponent(threadId)}`, cookie });
    if (response.statusCode === 200) {
      last = response.body.session;
      if (last.control?.canSend && last.control.action === action) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Phone Control did not expose ${action} for the smoke thread (last action=${last?.control?.action || "none"}, reason=${last?.control?.reason || "unknown"})`);
}

async function sendPhoneInput(config, cookie, session, text) {
  return request({
    port: config.port,
    pathname: `/api/sessions/${encodeURIComponent(session.id)}/input`,
    method: "POST",
    cookie,
    body: {
      text,
      expectedTurnId: session.control.expectedTurnId || null,
      clientMessageId: randomUUID(),
    },
  });
}

const config = await loadConfig();
const health = await request({ port: config.port, pathname: "/api/health" });
assert.equal(health.statusCode, 200, "Phone Control is not reachable");
assert.equal(health.body.version, "0.8.0", "Live Phone Control v0.8.0 is not running");
assert.equal(config.interactions.enabled, true, "Live phone controls are disabled");

let cookie = null;
let temporaryDeviceId = null;
let threadId = null;
let activeTurnId = null;
const messages = [];
const driver = new CodexAppServerBridge({ reconnect: false, auditLogPath: null });
driver.on("item/completed", (params) => {
  if (params.threadId === threadId && params.item?.type === "agentMessage") messages.push(params.item.text || "");
});

try {
  const pairing = await request({
    port: config.port,
    pathname: "/api/internal/pairings",
    method: "POST",
    token: config.token,
    body: { baseUrl: `http://127.0.0.1:${config.port}` },
  });
  assert.equal(pairing.statusCode, 201);
  const pairUrl = new URL(pairing.body.pairing.url);
  const paired = await request({ port: config.port, pathname: `${pairUrl.pathname}${pairUrl.search}` });
  cookie = paired.headers["set-cookie"]?.[0]?.split(";", 1)[0] || null;
  assert.ok(cookie, "Temporary simulated phone did not receive a device cookie");
  const devices = await request({ port: config.port, pathname: "/api/devices", cookie });
  temporaryDeviceId = devices.body.currentDeviceId;

  assert.equal(await driver.start(), true, "Could not connect to the managed Codex app-server");
  const started = await driver.request("thread/start", {
    cwd: root,
    ephemeral: false,
    approvalPolicy: "never",
    developerInstructions: "This is a safe protocol smoke test. Follow each user instruction exactly. When a prompt begins STEER WINDOW, first use the shell tool to run only `sleep 8`, then follow the latest user instruction. Do not modify files.",
  });
  threadId = started.thread.id;
  process.stdout.write(`Smoke Codex thread: ${threadId}\n`);

  const warmupCompleted = waitForEvent(driver, "turn/completed", (params) => params.threadId === threadId);
  const warmupStarted = await driver.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply exactly READY. Do not call tools." }],
  });
  activeTurnId = warmupStarted.turn.id;
  const warmup = await warmupCompleted;
  assert.equal(warmup.turn.status, "completed");
  activeTurnId = null;

  const idle = await waitForPhoneAction(config, cookie, threadId, "start");
  const phoneStartCompleted = waitForEvent(driver, "turn/completed", (params) => params.threadId === threadId);
  const phoneStart = await sendPhoneInput(config, cookie, idle, "Reply exactly PHONE_START_OK. Do not call tools.");
  assert.equal(phoneStart.statusCode, 200, phoneStart.body?.error || "Phone turn/start failed");
  assert.equal(phoneStart.body.command.action, "start");
  activeTurnId = phoneStart.body.command.turnId;
  const startedCompletion = await phoneStartCompleted;
  assert.equal(startedCompletion.turn.id, activeTurnId);
  assert.equal(startedCompletion.turn.status, "completed");
  activeTurnId = null;
  assert.equal(messages.some((text) => text.includes("PHONE_START_OK")), true, "Codex did not respond to the phone-started turn");

  await waitForPhoneAction(config, cookie, threadId, "start");
  const steerCompleted = waitForEvent(driver, "turn/completed", (params) => params.threadId === threadId);
  const steerStarted = await driver.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "STEER WINDOW: follow the smoke-test developer instruction, then reply ORIGINAL_DONE." }],
  });
  activeTurnId = steerStarted.turn.id;
  const active = await waitForPhoneAction(config, cookie, threadId, "steer", 12_000);
  assert.equal(active.control.expectedTurnId, activeTurnId);
  const phoneSteer = await sendPhoneInput(config, cookie, active, "Change of instruction: after the safe command finishes, reply exactly PHONE_STEER_OK.");
  assert.equal(phoneSteer.statusCode, 200, phoneSteer.body?.error || "Phone turn/steer failed");
  assert.equal(phoneSteer.body.command.action, "steer");
  assert.equal(phoneSteer.body.command.turnId, activeTurnId);
  const steeredCompletion = await steerCompleted;
  assert.equal(steeredCompletion.turn.id, activeTurnId);
  assert.equal(steeredCompletion.turn.status, "completed");
  activeTurnId = null;
  assert.equal(messages.some((text) => text.includes("PHONE_STEER_OK")), true, "Codex did not follow the phone steering instruction");

  process.stdout.write("PASS: the phone API started an idle Codex turn, steered an active turn with exact turn binding, and Codex completed both.\n");
} finally {
  if (threadId && activeTurnId && driver.status().initialized) {
    await driver.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
  }
  if (threadId && driver.status().initialized) {
    await driver.request("thread/archive", { threadId }).catch(() => {});
  }
  await driver.close();
  if (threadId) {
    await request({
      port: config.port,
      pathname: "/api/internal/hook",
      method: "POST",
      token: config.token,
      body: {
        eventId: randomUUID(),
        sessionId: threadId,
        kind: "session_end",
        source: "phone-control-smoke",
        at: new Date().toISOString(),
      },
    }).catch(() => {});
  }
  if (cookie && temporaryDeviceId) {
    await request({
      port: config.port,
      pathname: `/api/devices/${encodeURIComponent(temporaryDeviceId)}/revoke`,
      method: "POST",
      cookie,
    }).catch(() => {});
  }
}
