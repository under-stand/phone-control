#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.mjs";

function transportFor(url) {
  return url.protocol === "https:" ? https : http;
}

function request({ baseUrl, pathname, method = "GET", token = null, cookie = null, body = null, gzip = false }) {
  const url = new URL(pathname, baseUrl);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const req = transportFor(url).request(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method !== "GET" ? { "x-phone-control-client": "1" } : {}),
        ...(gzip ? { "accept-encoding": "gzip" } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const wire = Buffer.concat(chunks);
        const decoded = response.headers["content-encoding"] === "gzip" ? gunzipSync(wire) : wire;
        let parsed = decoded.toString("utf8");
        if (response.headers["content-type"]?.includes("application/json")) parsed = parsed ? JSON.parse(parsed) : null;
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: parsed,
          wireBytes: wire.length,
          decodedBytes: decoded.length,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`Timed out calling ${url.pathname}`)));
    req.once("error", reject);
    req.end(payload || undefined);
  });
}

const config = await loadConfig();
const localBaseUrl = `http://127.0.0.1:${config.port}`;
assert.ok(config.publicUrl, "PHONE_CONTROL_PUBLIC_URL is required for the public performance smoke test");
const publicBaseUrl = new URL(process.env.PHONE_CONTROL_TEST_PUBLIC_URL || config.publicUrl);
assert.equal(publicBaseUrl.protocol, "https:");

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
  assert.ok(cookie, "Temporary simulated phone did not receive a device cookie");

  const devices = await request({ baseUrl: publicBaseUrl, pathname: "/api/devices", cookie, gzip: true });
  temporaryDeviceId = devices.body.currentDeviceId;

  const page = await request({ baseUrl: publicBaseUrl, pathname: "/", gzip: true });
  const script = await request({ baseUrl: publicBaseUrl, pathname: "/app.js?v=48", gzip: true });
  const styles = await request({ baseUrl: publicBaseUrl, pathname: "/styles.css?v=48", gzip: true });
  const sessions = await request({ baseUrl: publicBaseUrl, pathname: "/api/sessions", cookie, gzip: true });
  const largestSession = [...sessions.body.sessions].sort((left, right) => (right.eventsCount || 0) - (left.eventsCount || 0))[0];
  const initialDetail = await request({
    baseUrl: publicBaseUrl,
    pathname: `/api/sessions/${encodeURIComponent(largestSession.id)}?events=72`,
    cookie,
    gzip: true,
  });
  const detail = await request({
    baseUrl: publicBaseUrl,
    pathname: `/api/sessions/${encodeURIComponent(largestSession.id)}`,
    cookie,
    gzip: true,
  });

  for (const response of [page, script, styles, sessions, initialDetail, detail]) assert.equal(response.statusCode, 200);
  for (const response of [page, script, styles, sessions, initialDetail, detail]) assert.equal(response.headers["content-encoding"], "gzip");
  assert.match(script.headers["cache-control"], /immutable/);
  assert.match(styles.headers["cache-control"], /immutable/);
  assert.ok(script.wireBytes < script.decodedBytes / 2);
  assert.ok(styles.wireBytes < styles.decodedBytes / 2);
  assert.ok(Array.isArray(sessions.body.sessions));
  assert.ok(Array.isArray(initialDetail.body.session.events));
  assert.ok(Array.isArray(detail.body.session.events));

  process.stdout.write(`${JSON.stringify({
    publicUrl: publicBaseUrl.origin,
    page: { ms: page.elapsedMs, wireBytes: page.wireBytes },
    script: { ms: script.elapsedMs, wireBytes: script.wireBytes, decodedBytes: script.decodedBytes },
    styles: { ms: styles.elapsedMs, wireBytes: styles.wireBytes, decodedBytes: styles.decodedBytes },
    sessions: { ms: sessions.elapsedMs, wireBytes: sessions.wireBytes, decodedBytes: sessions.decodedBytes, count: sessions.body.sessions.length },
    initialDetail: { ms: initialDetail.elapsedMs, wireBytes: initialDetail.wireBytes, decodedBytes: initialDetail.decodedBytes, events: initialDetail.body.session.events.length },
    largestDetail: { ms: detail.elapsedMs, wireBytes: detail.wireBytes, decodedBytes: detail.decodedBytes, events: detail.body.session.events.length },
  })}\n`);
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
