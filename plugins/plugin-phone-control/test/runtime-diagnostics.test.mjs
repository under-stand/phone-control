import assert from "node:assert/strict";
import { inspectCodexRuntime, parseCodexVersion } from "../src/runtime-diagnostics.mjs";

export const tests = [
  {
    name: "extracts Codex versions from CLI and App Server identifiers",
    async run() {
      assert.equal(parseCodexVersion("codex-cli 0.149.1"), "0.149.1");
      assert.equal(parseCodexVersion("codex-app-server/0.145.0 linux"), "0.145.0");
      assert.equal(parseCodexVersion("unknown"), null);
    },
  },
  {
    name: "recommends an App Server restart when its Codex version is stale",
    async run() {
      const result = await inspectCodexRuntime({
        appServerUserAgent: "codex-app-server/0.145.0",
        versionReader: async () => "codex-cli 0.149.1",
      });
      assert.equal(result.cliVersion, "0.149.1");
      assert.equal(result.appServerVersion, "0.145.0");
      assert.equal(result.restartRecommended, true);
      assert.match(result.reason, /restart/i);
    },
  },
  {
    name: "does not report a mismatch when runtime versions agree or CLI discovery fails",
    async run() {
      const current = await inspectCodexRuntime({
        appServerUserAgent: "codex-app-server/0.149.1",
        versionReader: async () => "codex-cli 0.149.1",
      });
      assert.equal(current.restartRecommended, false);
      const unavailable = await inspectCodexRuntime({
        appServerUserAgent: "codex-app-server/0.149.1",
        versionReader: async () => { throw new Error("not found"); },
      });
      assert.equal(unavailable.available, false);
      assert.equal(unavailable.restartRecommended, false);
    },
  },
];
