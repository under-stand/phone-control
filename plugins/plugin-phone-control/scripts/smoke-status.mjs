#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { loadConfig } from "../src/config.mjs";

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
        let parsed = text;
        if (response.headers["content-type"]?.includes("application/json")) {
          try { parsed = text ? JSON.parse(text) : null; } catch {
            reject(new Error(`Live service returned invalid JSON from ${pathname}`));
            return;
          }
        }
        resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error(`Timed out calling ${pathname}`)));
    req.once("error", reject);
    req.end(payload || undefined);
  });
}

const config = await loadConfig();
let cookie = null;
let temporaryDeviceId = null;

try {
  const health = await request({ port: config.port, pathname: "/api/health" });
  assert.equal(health.statusCode, 200, "Phone Control is not reachable");
  assert.equal(health.body.version, "0.8.0", "Live Phone Control v0.8.0 is not running");

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
  const status = await request({ port: config.port, pathname: "/api/status?refresh=1", cookie });
  const models = await request({ port: config.port, pathname: "/api/models?refresh=1", cookie });
  assert.equal(status.statusCode, 200);
  assert.equal(models.statusCode, 200);
  assert.equal(status.body.codex.available, true, "Codex App Server status is unavailable");
  assert.equal(status.body.appServer.connected, true, "Managed App Server is disconnected");
  assert.ok(status.body.runtime?.cliVersion, "Status did not include the installed Codex CLI version");
  assert.ok(status.body.runtime?.appServerVersion, "Status did not include the resident App Server version");
  assert.equal(status.body.appServer.retryingSubscriptions, 0, "A live thread subscription is still retrying");
  if (status.body.appServer.loadedThreadCount > status.body.appServer.unavailableThreadCount) {
    assert.ok(status.body.appServer.subscribedThreadCount > 0, "No resumable loaded thread is subscribed");
  }
  assert.ok(status.body.codex.configuration?.model, "Status did not include the configured model");
  assert.equal(models.body.available, true, "Codex model catalog is unavailable");
  assert.ok(models.body.models.length > 0, "Codex model catalog is empty");
  assert.equal(models.body.configuration?.model, status.body.codex.configuration.model, "Model picker default disagrees with status");
  assert.ok(models.body.models.every((model) => Array.isArray(model.supportedReasoningEfforts)), "Model picker did not receive supported reasoning efforts");
  assert.ok(models.body.models.every((model) => Array.isArray(model.serviceTiers)), "Model picker did not receive service-tier capabilities");
  assert.equal(models.body.machineName, status.body.machineName, "Workspace picker machine identity disagrees with status");
  assert.ok(Array.isArray(models.body.workspaces), "Workspace picker did not receive recent machine-scoped paths");
  assert.ok(status.body.codex.account?.planType, "Status did not include the account plan");
  if (status.body.codex.configuration?.approvalsReviewer === "auto_review") {
    assert.equal(status.body.approvalsConfigured, true, "Phone approval preference was unexpectedly lost");
    assert.equal(status.body.approvalsEnabled, false, "Phone approvals must not compete with Codex auto review");
    assert.equal(status.body.approvalRoutingReason, "codex_auto_review");
  }
  if (status.body.codex.account.email) assert.match(status.body.codex.account.email, /….*@/);
  assert.ok(status.body.codex.usage.limits.length > 0, "Status did not include a rate-limit window");

  const serialized = JSON.stringify({ status: status.body, models: models.body });
  for (const forbidden of ["accessToken", "refreshToken", "chatgptAuthTokens", "origins", "mcp_servers"]) {
    assert.equal(serialized.includes(forbidden), false, `Status leaked forbidden field ${forbidden}`);
  }

  const page = await request({ port: config.port, pathname: "/" });
  assert.match(page.body, /id="status-button"/);
  assert.match(page.body, /app\.js\?v=48/);

  process.stdout.write(`PASS: v${status.body.version} returned masked ${status.body.codex.account.planType} account status, ${models.body.models.length} selectable model(s), ${status.body.codex.usage.limits.length} usage limit group(s), ${status.body.appServer.subscribedThreadCount}/${status.body.appServer.loadedThreadCount} live thread subscription(s), CLI/App Server ${status.body.runtime.cliVersion}/${status.body.runtime.appServerVersion}${status.body.runtime.restartRecommended ? " (restart recommended)" : ""}, approval routing ${status.body.approvalRoutingReason}, and the mobile status UI.\n`);
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
