#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CodexAppServerBridge } from "../src/app-server-bridge.mjs";
import { loadConfig } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function request({ port, pathname, method = "GET", token = null, cookie = null, body = null, timeoutMs = 5_000 }) {
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

function waitForQuestionOrTurnEnd(bridge, threadId, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      bridge.off("question", onQuestion);
      bridge.off("turn/completed", onCompleted);
      bridge.off("error", onError);
    };
    const onQuestion = (interaction) => {
      if (interaction.sessionId !== threadId) return;
      cleanup();
      resolve(interaction);
    };
    const onCompleted = (params) => {
      if (params.threadId !== threadId) return;
      cleanup();
      reject(new Error(`Smoke turn completed before asking a question (status: ${params.turn?.status || "unknown"})`));
    };
    const onError = (params) => {
      if (params.threadId && params.threadId !== threadId) return;
      cleanup();
      reject(new Error(`Smoke turn error: ${params.error?.message || params.message || "unknown error"}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for request_user_input"));
    }, timeoutMs);
    bridge.on("question", onQuestion);
    bridge.on("turn/completed", onCompleted);
    bridge.on("error", onError);
  });
}

async function waitForPhoneQuestion(config, cookie, threadId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request({ port: config.port, pathname: `/api/sessions/${encodeURIComponent(threadId)}`, cookie });
    const pending = response.statusCode === 200 ? response.body.session?.pendingApproval : null;
    if (pending?.kind === "question" && pending.canRespond && pending.id) return pending;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The live Codex question did not appear in Phone Control");
}

async function waitForPhoneSubscription(config, cookie, threadId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSession = null;
  while (Date.now() < deadline) {
    const response = await request({ port: config.port, pathname: `/api/sessions/${encodeURIComponent(threadId)}`, cookie });
    lastSession = response.body?.session || null;
    if (response.statusCode === 200 && lastSession?.control?.live) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Phone Control did not expose a verified live smoke thread (status=${lastSession?.status || "missing"}, control=${lastSession?.control?.mode || "none"})`);
}

const config = await loadConfig();
const health = await request({ port: config.port, pathname: "/api/health" });
assert.equal(health.statusCode, 200, "Phone Control is not reachable");
assert.equal(health.body.version, "0.7.0", "Live Phone Control v0.7.0 is not running");
assert.equal(config.interactions.enabled, true, "Live phone answers are disabled");

let cookie = null;
let temporaryDeviceId = null;
let threadId = null;
let driverInteraction = null;
let phoneDelivered = false;
const driver = new CodexAppServerBridge({ reconnect: false, auditLogPath: null });

try {
  const pairing = await request({
    port: config.port,
    pathname: "/api/internal/pairings",
    method: "POST",
    token: config.token,
    body: { baseUrl: `http://127.0.0.1:${config.port}` },
  });
  assert.equal(pairing.statusCode, 201);
  const pairPath = new URL(pairing.body.pairing.url).pathname + new URL(pairing.body.pairing.url).search;
  const paired = await request({ port: config.port, pathname: pairPath });
  cookie = paired.headers["set-cookie"]?.[0]?.split(";", 1)[0] || null;
  assert.ok(cookie, "Temporary simulated phone did not receive a device cookie");
  const devices = await request({ port: config.port, pathname: "/api/devices", cookie });
  temporaryDeviceId = devices.body.currentDeviceId;

  assert.equal(await driver.start(), true, "Could not connect to the managed Codex app-server");
  const started = await driver.request("thread/start", {
    cwd: root,
    ephemeral: false,
    approvalPolicy: "never",
    developerInstructions: "This is a protocol smoke test. Follow each turn instruction exactly. Do not modify files.",
  });
  threadId = started.thread.id;
  process.stdout.write(`Smoke Codex thread: ${threadId}\n`);

  const warmupCompleted = waitForEvent(driver, "turn/completed", (params) => params.threadId === threadId);
  await driver.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply exactly READY. Do not call tools." }],
  });
  const warmup = await warmupCompleted;
  assert.equal(warmup.turn.status, "completed", `Smoke warmup turn ended with ${warmup.turn.status}`);
  await waitForPhoneSubscription(config, cookie, threadId);

  const driverQuestionPromise = waitForQuestionOrTurnEnd(driver, threadId);
  await driver.request("turn/start", {
    threadId,
    collaborationMode: {
      mode: "plan",
      settings: {
        model: started.model,
        developer_instructions: "This is a protocol smoke test. You must call request_user_input exactly once now. Do not call any other tool and do not modify files.",
        reasoning_effort: "low",
      },
    },
    input: [{
      type: "text",
      text: "Call request_user_input now. Ask one question with id `proceed`, header `Smoke test`, prompt `Phone Control 收到这个问题了吗？`, and options `继续` and `停止`. After the answer, reply briefly with the selected value.",
    }],
  });
  driverInteraction = await driverQuestionPromise;
  process.stdout.write(`App-server request: ${driverInteraction.itemId}\n`);

  const completedPromise = waitForEvent(driver, "turn/completed", (params) => params.threadId === threadId);
  const pending = await waitForPhoneQuestion(config, cookie, threadId);
  const answers = Object.fromEntries(pending.questions.map((question) => [
    question.id,
    [question.options?.[0]?.label || "smoke-answer"],
  ]));
  const delivered = await request({
    port: config.port,
    pathname: `/api/questions/${encodeURIComponent(pending.id)}/answer`,
    method: "POST",
    cookie,
    body: { sessionId: threadId, turnId: pending.turnId, answers },
  });
  assert.equal(delivered.statusCode, 200, delivered.body?.error || "Phone answer failed");
  assert.equal(delivered.body.interaction.delivery, "delivered");
  phoneDelivered = true;

  const completed = await completedPromise;
  assert.ok(["completed", "failed", "interrupted"].includes(completed.turn.status));
  assert.equal(completed.turn.status, "completed", `Smoke turn ended with ${completed.turn.status}`);
  process.stdout.write("PASS: the live app-server question appeared in Phone Control, the phone API answered it once, and Codex completed the turn.\n");
} finally {
  if (!phoneDelivered && driverInteraction?.status === "pending") {
    const fallback = Object.fromEntries(driverInteraction.questions.map((question) => [
      question.id,
      [question.options?.[0]?.label || "smoke-answer"],
    ]));
    await driver.answer(driverInteraction.id, {
      sessionId: driverInteraction.sessionId,
      turnId: driverInteraction.turnId,
      answers: fallback,
    }).catch(() => {});
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
