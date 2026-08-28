#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { loadConfig } from "../src/config.mjs";

function transportFor(url) {
  return url.protocol === "https:" ? https : http;
}

function request({ baseUrl, pathname, method = "GET", token = null, cookie = null, body = null }) {
  const url = new URL(pathname, baseUrl);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = transportFor(url).request(url, {
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
            reject(new Error(`Service returned invalid JSON from ${url.pathname}`));
            return;
          }
        }
        resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error(`Timed out calling ${url.pathname}`)));
    req.once("error", reject);
    req.end(payload || undefined);
  });
}

function observeStream({ baseUrl, cookie, durationMs = 25_000 }) {
  const url = new URL("/api/events", baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;
    let buffer = "";
    let snapshots = 0;
    let heartbeats = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response?.destroy();
      if (error) reject(error);
      else resolve({ snapshots, heartbeats });
    };
    const timer = setTimeout(() => {
      try {
        assert.ok(snapshots >= 1, "SSE stream did not deliver its initial snapshot");
        assert.ok(heartbeats >= 1, "SSE stream did not remain open for a heartbeat");
        finish();
      } catch (error) {
        finish(error);
      }
    }, durationMs);
    timer.unref?.();

    const req = transportFor(url).request(url, {
      headers: { accept: "text/event-stream", cookie },
    }, (incoming) => {
      response = incoming;
      if (incoming.statusCode !== 200) {
        finish(new Error(`SSE endpoint returned HTTP ${incoming.statusCode}`));
        return;
      }
      if (!incoming.headers["content-type"]?.startsWith("text/event-stream")) {
        finish(new Error("SSE endpoint returned an unexpected content type"));
        return;
      }
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => {
        buffer += chunk.replace(/\r\n/g, "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith(": heartbeat") || block.includes("event: ping")) heartbeats += 1;
          if (block.includes("event: snapshot")) snapshots += 1;
        }
      });
      incoming.once("end", () => finish(new Error("SSE stream ended before the observation window")));
      incoming.once("error", (error) => {
        if (!settled) finish(error);
      });
    });
    req.once("error", (error) => finish(error));
    req.end();
  });
}

const config = await loadConfig();
const localBaseUrl = `http://127.0.0.1:${config.port}`;
assert.ok(config.publicUrl, "PHONE_CONTROL_PUBLIC_URL is required for the public stream smoke test");
const publicBaseUrl = new URL(process.env.PHONE_CONTROL_TEST_PUBLIC_URL || config.publicUrl);
assert.equal(publicBaseUrl.protocol, "https:", "The public stream smoke test requires HTTPS");

let cookie = null;
let temporaryDeviceId = null;
try {
  const pairing = await request({
    baseUrl: localBaseUrl,
    pathname: "/api/internal/pairings",
    method: "POST",
    token: config.token,
    body: { baseUrl: publicBaseUrl.href },
  });
  assert.equal(pairing.statusCode, 201);

  const paired = await request({ baseUrl: publicBaseUrl, pathname: pairing.body.pairing.url });
  cookie = paired.headers["set-cookie"]?.[0]?.split(";", 1)[0] || null;
  assert.ok(cookie, "Temporary simulated phone did not receive a device cookie through the public URL");

  const devices = await request({ baseUrl: publicBaseUrl, pathname: "/api/devices", cookie });
  assert.equal(devices.statusCode, 200);
  temporaryDeviceId = devices.body.currentDeviceId;

  const observed = await observeStream({ baseUrl: publicBaseUrl, cookie });
  process.stdout.write(`PASS: public SSE stayed connected for 25 seconds with ${observed.snapshots} snapshot(s) and ${observed.heartbeats} heartbeat(s).\n`);
} finally {
  if (cookie && temporaryDeviceId) {
    await request({
      baseUrl: publicBaseUrl,
      pathname: `/api/devices/${encodeURIComponent(temporaryDeviceId)}/revoke`,
      method: "POST",
      cookie,
    }).catch(() => {});
  }
}
