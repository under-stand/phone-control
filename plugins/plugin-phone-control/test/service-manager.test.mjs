import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildTmuxLauncher,
  buildWindowsLauncher,
  buildWindowsCallerGuard,
  buildWindowsProcessCleanup,
  buildWindowsProxyBootstrap,
  buildWindowsTaskAction,
  buildWindowsTaskRegistration,
  launchdServicePath,
  parseServiceMetadata,
} from "../src/service-manager.mjs";
import { findTmuxSessionId } from "../src/tmux-utils.mjs";
import { expectedStablePluginRoot, nodeRuntimeStatus, serviceDefinitionStatus } from "../src/service-diagnostics.mjs";

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
      for (const definition of [buildSystemdUnit(options), buildTmuxLauncher(options), buildWindowsLauncher(options), buildLaunchdPlist(options)]) {
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
    name: "builds a native macOS launch agent with restart and explicit paths",
    async run() {
      const mac = buildLaunchdPlist(options);
      assert.match(mac, /<string>com\.phone-control\.agent<\/string>/);
      assert.match(mac, /<key>KeepAlive<\/key>\s*<true\/>/);
      assert.match(mac, /<key>RunAtLoad<\/key>\s*<true\/>/);
      assert.match(mac, /\/opt\/node 22\/bin\/node/);
      assert.match(mac, /\/opt\/phone control\/bin\/phone-control\.mjs/);
      assert.equal(
        launchdServicePath("/Users/me"),
        "/Users/me/Library/LaunchAgents/com.phone-control.agent.plist",
      );
      const escapedOptions = { ...options, root: "/Applications/Phone & <Control>" };
      const escaped = buildLaunchdPlist(escapedOptions);
      assert.match(escaped, /Phone &amp; &lt;Control&gt;/);
      assert.deepEqual(parseServiceMetadata(escaped), {
        runtime: escapedOptions.runtime,
        entry: "/Applications/Phone & <Control>/bin/phone-control.mjs",
      });
    },
  },
  {
    name: "builds a user-level Windows launcher with restart and log rotation",
    async run() {
      const windows = {
        root: "C:\\Users\\Me\\Phone Control\\repo",
        dataDir: "C:\\Users\\Me\\.phone-control",
        host: "127.0.0.1",
        port: 8787,
        runtime: "C:\\Program Files\\nodejs\\node.exe",
      };
      const launcher = buildWindowsLauncher(windows);
      assert.deepEqual(parseServiceMetadata(launcher), {
        runtime: windows.runtime,
        entry: "C:\\Users\\Me\\Phone Control\\repo/bin/phone-control.mjs",
      });
      assert.match(launcher, /while \(\$true\)/);
      assert.match(launcher, /4194304/);
      assert.match(launcher, /Start-Sleep -Seconds 2/);
      assert.match(launcher, /Internet Settings/);
      assert.match(launcher, /HTTP_PROXY/);
      assert.match(launcher, /HTTPS_PROXY/);
      assert.match(launcher, /NO_PROXY/);
      assert.match(buildWindowsProxyBootstrap(), /ProxyOverride/);
      assert.match(buildWindowsProxyBootstrap(), /socks5/);
      const cleanup = buildWindowsProcessCleanup({
        runtime: windows.runtime,
        entry: "C:\\Users\\Me\\Phone Control\\repo\\bin\\phone-control.mjs",
        dataDir: windows.dataDir,
      });
      assert.match(cleanup, /Get-CimInstance Win32_Process/);
      assert.match(cleanup, /ParentProcessId/);
      assert.match(cleanup, /Stop-Process/);
      assert.match(cleanup, /phone-control\.mjs/);
      const callerGuard = buildWindowsCallerGuard({
        runtime: windows.runtime,
        entry: "C:\\Users\\Me\\Phone Control\\repo\\bin\\phone-control.mjs",
        dataDir: windows.dataDir,
      });
      assert.match(callerGuard, /Get-CimInstance Win32_Process/);
      assert.match(callerGuard, /ParentProcessId/);
      assert.match(callerGuard, /cannot stop or replace its own Windows service/);
      assert.match(callerGuard, /exit 23/);
      assert.equal(
        buildWindowsTaskAction("C:\\Users\\Me\\.phone-control\\run-service.ps1"),
        'powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\\Users\\Me\\.phone-control\\run-service.ps1"',
      );
      const registration = buildWindowsTaskRegistration("C:\\Users\\Me\\.phone-control\\run-service.ps1");
      assert.match(registration, /New-ScheduledTaskTrigger -AtLogOn/);
      assert.match(registration, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
      assert.match(registration, /RunLevel Limited/);
    },
  },
  {
    name: "accepts a stable repository checkout without trusting a versioned Codex cache root",
    async run() {
      assert.equal(
        expectedStablePluginRoot({ currentRoot: "/srv/phone-control/plugins/plugin-phone-control", homeDir: "/home/me" }),
        "/srv/phone-control/plugins/plugin-phone-control",
      );
      assert.equal(
        expectedStablePluginRoot({ currentRoot: "/home/me/.codex/plugins/cache/phone-control/plugin-phone-control/0.6.1", homeDir: "/home/me" }),
        "/home/me/plugins/plugin-phone-control",
      );
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
