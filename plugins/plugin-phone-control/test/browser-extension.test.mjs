import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverServiceUrl,
  normalizeServiceUrl,
  serviceUrlCandidates,
} from "../extensions/chrome/service-discovery.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const tests = [
  {
    name: "discovers an automatically selected loopback service port",
    async run() {
      const requested = [];
      const serviceUrl = await discoverServiceUrl({
        configuredServiceUrl: "http://127.0.0.1:8787",
        fetchImpl: async (url) => {
          requested.push(url);
          const healthy = url === "http://127.0.0.1:8788/api/health";
          return {
            ok: healthy,
            json: async () => healthy ? { ok: true, ready: true } : { ok: false, ready: false },
          };
        },
      });
      assert.equal(serviceUrl, "http://127.0.0.1:8788");
      assert.ok(requested.includes("http://127.0.0.1:8787/api/health"));
      assert.ok(requested.includes("http://127.0.0.1:8788/api/health"));
    },
  },
  {
    name: "keeps discovery loopback-only and supports a manual port override",
    async run() {
      assert.equal(normalizeServiceUrl("https://example.com:8788"), null);
      assert.equal(normalizeServiceUrl("http://127.0.0.1:8788/"), "http://127.0.0.1:8788");
      assert.equal(normalizeServiceUrl("http://localhost:9123"), "http://localhost:9123");
      assert.deepEqual(
        serviceUrlCandidates({ configuredServiceUrl: "http://127.0.0.1:9123", scanWindow: 1 }),
        ["http://127.0.0.1:9123", "http://127.0.0.1:8787", "http://127.0.0.1:8788"],
      );
    },
  },
  {
    name: "allows the Chrome bridge to reach any loopback port",
    async run() {
      const manifest = JSON.parse(await readFile(path.join(root, "extensions/chrome/manifest.json"), "utf8"));
      assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:*/*", "http://localhost:*/*"]);
      assert.ok(manifest.permissions.includes("alarms"));
      const background = await readFile(path.join(root, "extensions/chrome/background.js"), "utf8");
      assert.match(background, /discoverServiceUrl/);
      assert.match(background, /set-service-url/);
      assert.match(background, /chrome\.alarms\.onAlarm/);
      assert.match(background, /const tab = await chooseTab\(\)\.catch/);
    },
  },
];
