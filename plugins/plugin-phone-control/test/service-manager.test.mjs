import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSystemdUnit, buildTmuxLauncher, parseServiceMetadata } from "../src/service-manager.mjs";
import { findTmuxSessionId } from "../src/tmux-utils.mjs";
import { nodeRuntimeStatus, serviceDefinitionStatus } from "../src/service-diagnostics.mjs";

const options = {
  root: "/opt/phone control",
  dataDir: "/var/lib/phone control",
  host: "127.0.0.1",
  port: 8787,
  runtime: "/opt/node 22/bin/node",
};

export const tests = [
  {
    name: "resolves exact tmux IDs so the main and relay sessions cannot alias",
    async run() {
      const sessions = "$3\tphone-control-relay\n$7\tphone-control\n";
      assert.equal(findTmuxSessionId(sessions, "phone-control"), "$7");
      assert.equal(findTmuxSessionId(sessions, "phone-control-relay"), "$3");
      assert.equal(findTmuxSessionId(sessions, "phone"), null);
    },
  },
  {
    name: "builds service definitions with explicit runtime and stable plugin metadata",
    async run() {
      for (const definition of [buildSystemdUnit(options), buildTmuxLauncher(options)]) {
        assert.deepEqual(parseServiceMetadata(definition), {
          runtime: options.runtime,
          entry: "/opt/phone control/bin/phone-control.mjs",
        });
        assert.match(definition, /127\.0\.0\.1/);
        assert.match(definition, /8787/);
      }
    },
  },
  {
    name: "reports unsupported Node and stale service roots without mutating the service",
    async run() {
      assert.equal(nodeRuntimeStatus("v16.20.2").supported, false);
      assert.equal(nodeRuntimeStatus("v22.18.0").supported, true);
      const stale = serviceDefinitionStatus({
        service: { definition: { runtime: "/old/node", entry: "/workspace/bin/phone-control.mjs" } },
        expectedRoot: "/home/me/plugins/plugin-phone-control",
        currentRuntime: "/new/node",
      });
      assert.equal(stale.known, true);
      assert.equal(stale.runtimeMatches, false);
      assert.equal(stale.rootMatches, false);
    },
  },
  {
    name: "treats symlinked service and runtime paths as the same verified files",
    async run() {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "phone-control-service-paths-"));
      try {
        const realRoot = path.join(temporary, "real-plugin");
        const linkedRoot = path.join(temporary, "linked-plugin");
        const runtime = path.join(realRoot, "bin", "node");
        await mkdir(path.join(realRoot, "bin"), { recursive: true });
        await symlink(realRoot, linkedRoot);
        await symlink(process.execPath, runtime);
        await symlink(process.execPath, path.join(realRoot, "bin", "phone-control.mjs"));
        const status = serviceDefinitionStatus({
          service: { definition: { runtime, entry: path.join(linkedRoot, "bin", "phone-control.mjs") } },
          expectedRoot: realRoot,
          currentRuntime: process.execPath,
        });
        assert.equal(status.runtimeMatches, true);
        assert.equal(status.rootMatches, true);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  },
];
