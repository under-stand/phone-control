import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUTH_COOKIE, instanceAuthCookie } from "../src/auth.mjs";
import { createPhoneControlServer } from "../src/server.mjs";

function request({ port, pathname, method = "GET", headers = {}, body = null }) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: response.headers["content-type"]?.includes("application/json") && text ? JSON.parse(text) : text,
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
}

function cookieValue(response) {
  return response.headers["set-cookie"]?.[0]?.split(";", 1)[0] || null;
}

function testConfig(dataDir, token, instanceId) {
  return {
    host: "127.0.0.1",
    port: 0,
    token,
    instanceId,
    dataDir,
    interactions: { enabled: false },
  };
}

export const tests = [
  {
    name: "keeps two same-host instances authenticated through distinct cookies",
    async run() {
      const firstDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-instance-a-"));
      const secondDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-instance-b-"));
      const firstId = "a".repeat(32);
      const secondId = "b".repeat(32);
      const first = await createPhoneControlServer({
        config: testConfig(firstDir, "first-bootstrap-token", firstId),
        scanRollouts: false,
        taskTitleGenerator: null,
      });
      const second = await createPhoneControlServer({
        config: testConfig(secondDir, "second-bootstrap-token", secondId),
        scanRollouts: false,
        taskTitleGenerator: null,
      });
      let firstStarted = false;
      let secondStarted = false;
      try {
        const firstAddress = await first.start();
        firstStarted = true;
        const secondAddress = await second.start();
        secondStarted = true;
        const firstPairing = await request({ port: firstAddress.port, pathname: "/?token=first-bootstrap-token" });
        const secondPairing = await request({ port: secondAddress.port, pathname: "/?token=second-bootstrap-token" });
        const firstCookie = cookieValue(firstPairing);
        const secondCookie = cookieValue(secondPairing);

        assert.match(firstCookie, new RegExp(`^${instanceAuthCookie(firstId)}=`));
        assert.match(secondCookie, new RegExp(`^${instanceAuthCookie(secondId)}=`));
        assert.notEqual(firstCookie.split("=", 1)[0], secondCookie.split("=", 1)[0]);

        const sharedCookieHeader = `${firstCookie}; ${secondCookie}`;
        assert.equal((await request({ port: firstAddress.port, pathname: "/api/devices", headers: { cookie: sharedCookieHeader } })).status, 200);
        assert.equal((await request({ port: secondAddress.port, pathname: "/api/devices", headers: { cookie: sharedCookieHeader } })).status, 200);

        const logout = await request({
          port: firstAddress.port,
          pathname: "/api/logout",
          method: "POST",
          headers: { cookie: sharedCookieHeader, "x-phone-control-client": "1" },
        });
        assert.equal(logout.status, 200);
        assert.equal(logout.headers["set-cookie"].some((value) => value.startsWith(`${instanceAuthCookie(firstId)}=;`)), true);
        assert.equal(logout.headers["set-cookie"].some((value) => value.startsWith(`${AUTH_COOKIE}=;`)), true);
        assert.equal((await request({ port: secondAddress.port, pathname: "/api/devices", headers: { cookie: secondCookie } })).status, 200);
      } finally {
        if (secondStarted) await second.close();
        if (firstStarted) await first.close();
        await rm(firstDir, { recursive: true, force: true });
        await rm(secondDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "migrates a valid legacy device cookie without creating another device",
    async run() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "phone-control-cookie-migration-"));
      const instanceId = "c".repeat(32);
      const runtime = await createPhoneControlServer({
        config: testConfig(dataDir, "migration-bootstrap-token", instanceId),
        scanRollouts: false,
        taskTitleGenerator: null,
      });
      let started = false;
      try {
        const paired = runtime.devices.pair({ name: "Legacy phone" });
        const address = await runtime.start();
        started = true;
        const migrated = await request({
          port: address.port,
          pathname: "/api/devices",
          headers: { cookie: `${AUTH_COOKIE}=${encodeURIComponent(paired.credential)}` },
        });
        assert.equal(migrated.status, 200);
        assert.match(cookieValue(migrated), new RegExp(`^${instanceAuthCookie(instanceId)}=`));
        assert.equal(runtime.devices.counts().active, 1);
      } finally {
        if (started) await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  },
];
